import assert from 'node:assert/strict';
import test from 'node:test';
import { AreaGate, DomainError, deriveState } from '../src/core.mjs';

// 轴对齐矩形（米）：左下角 (x,y)，宽 w、高 h。
const rect = (x, y, w, h) => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];

function setupParcel({ total = 1000, tolerance = 2 } = {}) {
  const gate = new AreaGate();
  gate.registerParcel({ parcelId: 'P1', totalQuadrat: total, toleranceM2: tolerance });
  gate.registerProject({ projectId: 'J1', parcelId: 'P1', name: '木屋项目' });
  gate.registerSurvey({ surveyId: 'S1', parcelId: 'P1' });
  gate.addSurveyVersion({ surveyId: 'S1', versionId: 'v1', precisionM: 0.5 });
  return gate;
}

const submit = (gate, overrides = {}) =>
  gate.submitPlan({
    planId: 'plan-1',
    parcelId: 'P1',
    projectId: 'J1',
    phaseNo: 1,
    facilities: [
      {
        facilityId: 'F1',
        surveyId: 'S1',
        surveyVersionId: 'v1',
        ring: rect(0, 0, 10, 10),
      },
    ],
    ...overrides,
  });

const approveBoth = (gate, planId) => {
  const first = gate.approve(planId, '审批员甲');
  assert.equal(first.outcome, 'awaiting_second_approver');
  return gate.approve(planId, '审批员乙');
};

test('正常分期批准：累计占用与剩余空间在每次承诺前计算', () => {
  const gate = setupParcel({ total: 500 });
  submit(gate, { planId: 'phase-1', facilities: [{ facilityId: 'F1', surveyId: 'S1', surveyVersionId: 'v1', ring: rect(0, 0, 10, 10) }] });
  const result = approveBoth(gate, 'phase-1');
  assert.equal(result.outcome, 'approved');
  assert.equal(result.cumulativeBeforeM2, 0);
  assert.equal(result.cumulativeAfterM2, 100);
  assert.equal(result.remainingAfterM2, 400);

  // 第二期紧接报建，闸门看到的是包含第一期的累计值。
  submit(gate, { planId: 'phase-2', phaseNo: 2, facilities: [{ facilityId: 'F2', surveyId: 'S1', surveyVersionId: 'v1', ring: rect(20, 0, 10, 10) }] });
  const second = approveBoth(gate, 'phase-2');
  assert.equal(second.cumulativeBeforeM2, 100);
  assert.equal(second.cumulativeAfterM2, 200);
  assert.equal(second.remainingAfterM2, 300);
});

test('阻断：分期只看自己图纸会超额，累计闸门拒绝放行', () => {
  const gate = setupParcel({ total: 150 });
  submit(gate, { planId: 'phase-1', facilities: [{ facilityId: 'F1', surveyId: 'S1', surveyVersionId: 'v1', ring: rect(0, 0, 10, 10) }] });
  approveBoth(gate, 'phase-1'); // 已批 100，剩 50

  submit(gate, { planId: 'phase-2', phaseNo: 2, facilities: [{ facilityId: 'F2', surveyId: 'S1', surveyVersionId: 'v1', ring: rect(20, 0, 10, 10) }] });
  const evaluation = gate.evaluatePlan('phase-2');
  assert.equal(evaluation.ok, false);
  assert.deepEqual(evaluation.reasons.map((r) => r.code), ['over_quota']);
  assert.equal(evaluation.reasons[0].projectedM2, 200);

  // 任一名审批人放行都会被阻断，方案转为驳回而非批准。
  const decision = gate.approve('phase-2', '审批员甲');
  assert.equal(decision.outcome, 'rejected');
  assert.equal(gate.state.plans.get('phase-2').status, 'rejected');

  // 被驳回的 100 平米没有计入累计。
  assert.equal(gate.cumulativeOccupancy(gate.state, 'P1').cumulativeM2, 100);
});

test('阻断：与已批准图斑重叠不得放行', () => {
  const gate = setupParcel();
  submit(gate, { planId: 'phase-1', facilities: [{ facilityId: 'F1', surveyId: 'S1', surveyVersionId: 'v1', ring: rect(0, 0, 10, 10) }] });
  approveBoth(gate, 'phase-1');

  // 第二期图纸向东平移 5 米，与第一期重叠 5×10=50 平米。
  submit(gate, { planId: 'phase-2', phaseNo: 2, facilities: [{ facilityId: 'F2', surveyId: 'S1', surveyVersionId: 'v1', ring: rect(5, 0, 10, 10) }] });
  const evaluation = gate.evaluatePlan('phase-2');
  assert.deepEqual(evaluation.reasons.map((r) => r.code), ['spatial_conflict']);
  assert.equal(evaluation.reasons[0].conflicts[0].overlapM2, 50);
  assert.equal(gate.approve('phase-2', '审批员甲').outcome, 'rejected');
});

test('撤回后重报：撤回方案不占面积与期号槽位，重报走新编号并声明前版', () => {
  const gate = setupParcel({ total: 250 });
  submit(gate, { planId: 'plan-a', facilities: [{ facilityId: 'F1', surveyId: 'S1', surveyVersionId: 'v1', ring: rect(0, 0, 10, 10) }] });
  // 首名审批人已放行，企业主动撤回。
  assert.equal(gate.approve('plan-a', '审批员甲').outcome, 'awaiting_second_approver');
  gate.withdrawPlan('plan-a', '企业调整布点');

  const occupancy = gate.cumulativeOccupancy(gate.state, 'P1');
  assert.equal(occupancy.cumulativeM2, 0);

  // 同一期号重报：布点平移，落在剩余空间内。
  submit(gate, {
    planId: 'plan-b',
    priorVersionId: 'plan-a',
    facilities: [{ facilityId: 'F1', surveyId: 'S1', surveyVersionId: 'v1', ring: rect(20, 0, 10, 10) }],
  });
  const result = approveBoth(gate, 'plan-b');
  assert.equal(result.outcome, 'approved');
  assert.equal(result.cumulativeAfterM2, 100);

  // 前版仍在途时不允许重报。
  submit(gate, { planId: 'plan-c', phaseNo: 2, facilities: [{ facilityId: 'F3', surveyId: 'S1', surveyVersionId: 'v1', ring: rect(30, 0, 5, 5) }] });
  assert.throws(
    () => submit(gate, { planId: 'plan-d', phaseNo: 2, facilities: [{ facilityId: 'F4', surveyId: 'S1', surveyVersionId: 'v1', ring: rect(40, 0, 5, 5) }] }),
    (error) => error.code === 'phase_slot_busy',
  );
});

test('阻断：报建后测绘精度/图纸更新，旧图斑版本不得用于决定', () => {
  const gate = setupParcel();
  submit(gate);
  // 方案在途期间测绘单位提交新版本。
  gate.addSurveyVersion({ surveyId: 'S1', versionId: 'v2', precisionM: 0.1 });

  const evaluation = gate.evaluatePlan('plan-1');
  assert.deepEqual(evaluation.reasons.map((r) => r.code), ['survey_version_stale']);
  assert.equal(gate.approve('plan-1', '审批员甲').outcome, 'rejected');

  // 驳回后按当前版本重报即可继续。
  submit(gate, {
    planId: 'plan-1-r',
    priorVersionId: 'plan-1',
    facilities: [{ facilityId: 'F1', surveyId: 'S1', surveyVersionId: 'v2', ring: rect(0, 0, 10, 10) }],
  });
  assert.equal(gate.evaluatePlan('plan-1-r').ok, true);
});

test('历史批准不被新图纸覆盖：旧版本失效不影响已批方案，且决定保留版本快照', () => {
  const gate = setupParcel();
  submit(gate);
  const approved = approveBoth(gate, 'plan-1');
  assert.deepEqual(approved.adoptedSurveyVersions, [{ facilityId: 'F1', surveyVersionId: 'v1' }]);

  gate.addSurveyVersion({ surveyId: 'S1', versionId: 'v2', precisionM: 0.1 });
  // 已批方案仍按 v1 计入，累计面积不变。
  assert.equal(gate.cumulativeOccupancy(gate.state, 'P1').cumulativeM2, 100);
  const decision = gate.state.plans.get('plan-1').decision;
  assert.equal(decision.adoptedSurveyVersions.get('F1'), 'v1');
  assert.equal(decision.facilities[0].surveyVersionId, 'v1');
});

test('跨项目共用设施只登记一次，面积不重复累计', () => {
  const gate = setupParcel({ total: 500 });
  gate.registerProject({ projectId: 'J2', parcelId: 'P1', name: '相邻木屋项目' });

  // 共用步道作为独立方案报建，声明共用项目。
  submit(gate, {
    planId: 'trail',
    projectId: 'J1',
    sharedWithProjectIds: ['J2'],
    facilities: [{ facilityId: 'T1', kind: 'trail', surveyId: 'S1', surveyVersionId: 'v1', ring: rect(0, 50, 100, 2) }],
  });
  approveBoth(gate, 'trail');

  // J2 再报自己的木屋，布点不与步道冲突。
  submit(gate, {
    planId: 'j2-cabin',
    projectId: 'J2',
    phaseNo: 1,
    facilities: [{ facilityId: 'C1', surveyId: 'S1', surveyVersionId: 'v1', ring: rect(0, 0, 10, 10) }],
  });
  const result = approveBoth(gate, 'j2-cabin');
  assert.equal(result.cumulativeBeforeM2, 200); // 步道 200 只计一次
  assert.equal(result.cumulativeAfterM2, 300);
  const occupancy = gate.cumulativeOccupancy(gate.state, 'P1');
  assert.equal(occupancy.breakdown.length, 2);

  // 另一期若与共用步道重叠，同样被空间闸门阻断。
  submit(gate, {
    planId: 'overlap-trail',
    projectId: 'J2',
    phaseNo: 2,
    facilities: [{ facilityId: 'C2', surveyId: 'S1', surveyVersionId: 'v1', ring: rect(0, 49, 10, 4) }],
  });
  const evaluation = gate.evaluatePlan('overlap-trail');
  assert.equal(evaluation.ok, false);
  assert.equal(evaluation.reasons[0].code, 'spatial_conflict');
});

test('双审批人：同一人重复计入无效；两名不同审批人都通过才形成批准', () => {
  const gate = setupParcel();
  submit(gate);
  gate.approve('plan-1', '审批员甲');
  assert.throws(
    () => gate.approve('plan-1', '审批员甲'),
    (error) => error.code === 'duplicate_approver',
  );
  // 第一人放行期间不占用面积。
  assert.equal(gate.cumulativeOccupancy(gate.state, 'P1').cumulativeM2, 0);
  const result = gate.approve('plan-1', '审批员乙');
  assert.equal(result.outcome, 'approved');
  assert.deepEqual(result.approvers, ['审批员甲', '审批员乙']);
});

test('阻断：第二名审批人放行时面积闸门已变化（期间另一方案获批），仍然阻断', () => {
  const gate = setupParcel({ total: 150 });
  submit(gate, { planId: 'plan-a', facilities: [{ facilityId: 'F1', surveyId: 'S1', surveyVersionId: 'v1', ring: rect(0, 0, 8, 8) }] });
  gate.approve('plan-a', '审批员甲'); // 64 平米，第一名通过

  // 等待第二人期间，另一项目获批 100 平米，剩余空间不再容纳 plan-a。
  gate.registerProject({ projectId: 'J2', parcelId: 'P1' });
  submit(gate, { planId: 'plan-b', projectId: 'J2', phaseNo: 1, facilities: [{ facilityId: 'F2', surveyId: 'S1', surveyVersionId: 'v1', ring: rect(30, 0, 10, 10) }] });
  approveBoth(gate, 'plan-b');

  const decision = gate.approve('plan-a', '审批员乙');
  assert.equal(decision.outcome, 'rejected');
  assert.ok(decision.reasons.some((r) => r.code === 'over_quota'));
  assert.equal(gate.state.plans.get('plan-a').status, 'rejected');
});

test('现场核验：容差内通过；超面积或越界进入整改闭环', () => {
  const gate = setupParcel({ total: 500, tolerance: 2 });
  submit(gate, { facilities: [{ facilityId: 'F1', surveyId: 'S1', surveyVersionId: 'v1', ring: rect(0, 0, 10, 10) }] });
  approveBoth(gate, 'plan-1');

  // 实测偏大 1 平米，在 2 平米容差内。
  let verification = gate.recordVerification('plan-1', {
    inspector: '核验员丙',
    actuals: [{ facilityId: 'F1', ring: rect(0, 0, 10.1, 10) }],
  });
  assert.equal(verification.outcome, 'passed');

  // 重新设置一个超界场景：另一个项目批 100 平米后越界建设。
  gate.registerProject({ projectId: 'J2', parcelId: 'P1' });
  submit(gate, { planId: 'plan-2', projectId: 'J2', phaseNo: 1, facilities: [{ facilityId: 'F2', surveyId: 'S1', surveyVersionId: 'v1', ring: rect(30, 0, 10, 10) }] });
  approveBoth(gate, 'plan-2');
  verification = gate.recordVerification('plan-2', {
    actuals: [{ facilityId: 'F2', ring: rect(30, 0, 12, 10) }], // 偏大且向东越界
  });
  assert.equal(verification.outcome, 'rectification_required');
  assert.equal(verification.actuals[0].outsideM2, 20);

  // 第一次整改复测仍越界，不能闭环。
  gate.submitRectification('plan-2', { actuals: [{ facilityId: 'F2', ring: rect(30, 0, 11, 10) }] });
  let resolution = gate.resolveRectification('plan-2');
  assert.equal(resolution.outcome, 'failed');
  assert.ok(resolution.reasons.some((r) => r.code === 'outside_approved_plot'));

  // 复测回到批准图斑，闭环成功。
  gate.submitRectification('plan-2', { note: '拆除越界部分', actuals: [{ facilityId: 'F2', ring: rect(30, 0, 10, 10) }] });
  resolution = gate.resolveRectification('plan-2');
  assert.equal(resolution.outcome, 'closed');
});

test('阻断：整改复测仍使宗地累计超界时不得闭环', () => {
  const gate = setupParcel({ total: 205, tolerance: 0.5 });
  submit(gate, { planId: 'plan-1', facilities: [{ facilityId: 'F1', surveyId: 'S1', surveyVersionId: 'v1', ring: rect(0, 0, 10, 10) }] });
  approveBoth(gate, 'plan-1'); // 批 100
  gate.registerProject({ projectId: 'J2', parcelId: 'P1' });
  submit(gate, { planId: 'plan-2', projectId: 'J2', phaseNo: 1, facilities: [{ facilityId: 'F2', surveyId: 'S1', surveyVersionId: 'v1', ring: rect(30, 0, 10, 10) }] });
  approveBoth(gate, 'plan-2'); // 累计 200，剩 5

  // 实测两栋都略大，但图斑未越界（向东扩建但不与他人冲突），J2 实际 104。
  gate.recordVerification('plan-1', { actuals: [{ facilityId: 'F1', ring: rect(0, 0, 10, 10) }] });
  gate.recordVerification('plan-2', { actuals: [{ facilityId: 'F2', ring: rect(30, 0, 10.4, 10) }] });
  gate.submitRectification('plan-2', { actuals: [{ facilityId: 'F2', ring: rect(30, 0, 10.4, 10) }] });
  const resolution = gate.resolveRectification('plan-2');
  // 偏差超容差且实测累计 204... 实际 100+104=204 <= 205，但偏差 4 > 0.5 容差，仍失败。
  assert.equal(resolution.outcome, 'failed');
  assert.ok(resolution.reasons.some((r) => r.code === 'area_deviation'));

  // 构造实测累计超界：实测 106，总计 206 > 205，整改通道同样阻断。
  gate.submitRectification('plan-2', { actuals: [{ facilityId: 'F2', ring: rect(30, 0, 10.6, 10) }] });
  const blocked = gate.resolveRectification('plan-2');
  assert.equal(blocked.outcome, 'failed');
  assert.ok(blocked.reasons.some((r) => r.code === 'over_quota_actual'));
});

test('事件账本只追加：从事件流重新归约得到相同状态', () => {
  const gate = setupParcel();
  submit(gate);
  approveBoth(gate, 'plan-1');
  const eventCount = gate.store.events.length;
  const rebuilt = deriveState(gate.store);
  assert.equal(rebuilt.plans.get('plan-1').status, 'approved');
  assert.equal(rebuilt.surveys.get('S1').currentVersionId, 'v1');
  // 所有状态变更都有事件，没有就地写入账本之外的数据。
  assert.ok(eventCount >= 5);
  const types = gate.store.events.map((e) => e.type);
  assert.ok(types.includes('PlanApproved'));
  assert.ok(types.includes('PlanPartialApproval'));
});
