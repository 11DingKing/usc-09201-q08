import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.mjs';
import { GateError } from '../src/domain/errors.mjs';

const rect = (x, y, width, height) => ({ x, y, width, height });

function app() {
  return createApp();
}

function decide(appInstance, planId, approver, approved = true, role = ['审批']) {
  return appInstance.execute('plan.decide', {
    planId, approver, role: Array.isArray(role) ? role : [role], approved,
  });
}

// 两名不同审批人连续放行后方案才生效
function approveByTwo(appInstance, planId, a = '张审核', b = '李复核') {
  const first = decide(appInstance, planId, a, true);
  assert.equal(first.plan.status, 'submitted', '单人放行后方案仍待决');
  const second = decide(appInstance, planId, b, true);
  assert.equal(second.plan.status, 'approved');
  return second;
}

function setupJointReview() {
  const a = app();
  // 宗地许可：可占用林地 400 ㎡
  a.execute('parcel.register', { parcelId: 'P-001', permitNo: '林许〔2026〕001号', allowedArea: 400 });
  a.execute('project.register', { projectId: 'PRJ-A', parcelId: 'P-001', name: '森林康养木屋' });
  // 测绘版本 SV-1：三间 10m×10m 木屋 + 一条 20m×3m 共用步道
  a.execute('survey.submit', {
    surveyVersionId: 'SV-1', projectId: 'PRJ-A', parcelId: 'P-001',
    polygons: [
      { polygonId: 'C1', geometry: rect(0, 0, 10, 10) },
      { polygonId: 'C2', geometry: rect(20, 0, 10, 10) },
      { polygonId: 'C3', geometry: rect(40, 0, 10, 10) },
      { polygonId: 'T1', geometry: rect(0, 30, 20, 3) },
    ],
  });
  const submitPhase = (planId, phase, polygonId, extra = {}) => a.execute('plan.submit', {
    planId, projectId: 'PRJ-A', parcelId: 'P-001', phase,
    surveyVersionId: 'SV-1',
    facilities: [{ facilityId: `${planId}-F`, polygonId, ...extra }],
  });
  submitPhase('PLAN-1', '一期', 'C1');
  submitPhase('PLAN-2', '二期', 'C2');
  submitPhase('PLAN-3', '三期', 'C3');
  submitPhase('PLAN-TRAIL', '配套', 'T1', { kind: '共用步道', sharedKey: 'trail-main' });
  return a;
}

test('联合审查：三期木屋与共用步道连续提交，逐期核对空间、可批面积与图斑版本', () => {
  const a = setupJointReview();

  for (const planId of ['PLAN-1', 'PLAN-2', 'PLAN-3', 'PLAN-TRAIL']) {
    const evaluation = a.execute('plan.evaluate', { planId });
    assert.ok(evaluation.approvable, `${planId} 应可批`);
    assert.equal(evaluation.surveyVersionId, 'SV-1', '每次决定都注明采用的图斑版本');
    // 四份方案合计 360 ㎡（3×100 + 60），始终不超过 400 ㎡许可
    assert.equal(evaluation.projectedTotal, 360);
    assert.equal(evaluation.remainingAfter, 40);
    assert.deepEqual(evaluation.conflicts, []);
  }

  // 连续双岗审批
  approveByTwo(a, 'PLAN-1');
  approveByTwo(a, 'PLAN-2');
  approveByTwo(a, 'PLAN-3');
  approveByTwo(a, 'PLAN-TRAIL');

  const ledger = a.execute('parcel.ledger', { parcelId: 'P-001' });
  assert.equal(ledger.approvedArea, 360);
  assert.equal(ledger.remainingArea, 40);
  assert.equal(ledger.approvedPlans.length, 4);
});

test('分期累计：只看本期图纸会超额，闸门按累计占用阻断第四期', () => {
  const a = setupJointReview();
  for (const id of ['PLAN-1', 'PLAN-2', 'PLAN-3', 'PLAN-TRAIL']) {
    approveByTwo(a, id);
  }
  // 剩余 40 ㎡，新一期 100 ㎡木屋单看自身图纸合规，但累计 460 > 400
  a.execute('survey.submit', {
    surveyVersionId: 'SV-2', projectId: 'PRJ-A', parcelId: 'P-001',
    polygons: [{ polygonId: 'D1', geometry: rect(60, 0, 10, 10) }],
  });
  a.execute('plan.submit', {
    planId: 'PLAN-4', projectId: 'PRJ-A', parcelId: 'P-001', phase: '四期',
    surveyVersionId: 'SV-2', facilities: [{ facilityId: 'F4', polygonId: 'D1' }],
  });
  const evaluation = a.execute('plan.evaluate', { planId: 'PLAN-4' });
  assert.equal(evaluation.approvable, false);
  assert.deepEqual(evaluation.blockers, ['quota_exceeded']);
  assert.equal(evaluation.projectedTotal, 460);
  assert.equal(evaluation.remainingAfter, -60);

  assert.throws(
    () => decide(a, 'PLAN-4', '张审核', true),
    (error) => error instanceof GateError && error.code === 'gate_blocked',
  );
});

test('图斑重叠：与已批准图斑内相交阻断，边界相接不视为重叠', () => {
  const a = app();
  a.execute('parcel.register', { parcelId: 'P-02', permitNo: 'P-02', allowedArea: 500 });
  a.execute('project.register', { projectId: 'PRJ-B', parcelId: 'P-02' });
  a.execute('survey.submit', {
    surveyVersionId: 'SV-B1', projectId: 'PRJ-B', parcelId: 'P-02',
    polygons: [{ polygonId: 'B1', geometry: rect(0, 0, 10, 10) }],
  });
  a.execute('plan.submit', {
    planId: 'PB-1', projectId: 'PRJ-B', parcelId: 'P-02', phase: '一期',
    surveyVersionId: 'SV-B1', facilities: [{ facilityId: 'FB1', polygonId: 'B1' }],
  });
  approveByTwo(a, 'PB-1');

  // 重叠图斑
  a.execute('survey.submit', {
    surveyVersionId: 'SV-B2', projectId: 'PRJ-B', parcelId: 'P-02',
    polygons: [{ polygonId: 'B2', geometry: rect(5, 5, 10, 10) }],
  });
  a.execute('plan.submit', {
    planId: 'PB-2', projectId: 'PRJ-B', parcelId: 'P-02', phase: '二期',
    surveyVersionId: 'SV-B2',
    facilities: [{ facilityId: 'FB2', polygonId: 'B2' }],
  });
  const overlap = a.execute('plan.evaluate', { planId: 'PB-2' });
  assert.ok(overlap.blockers.includes('spatial_conflict'));
  assert.equal(overlap.conflicts[0].otherPlanId, 'PB-1');
  assert.equal(overlap.conflicts[0].polygonId, 'B2');

  // 删除重叠设施后，重报方案的图斑与 B1 仅边界相接（x=10），不冲突
  a.execute('plan.withdraw', { planId: 'PB-2', reason: '调整图斑' });
  a.execute('survey.submit', {
    surveyVersionId: 'SV-B3', projectId: 'PRJ-B', parcelId: 'P-02',
    polygons: [{ polygonId: 'B3', geometry: rect(10, 0, 10, 10) }],
  });
  a.execute('plan.submit', {
    planId: 'PB-2B', projectId: 'PRJ-B', parcelId: 'P-02', phase: '二期',
    surveyVersionId: 'SV-B3', facilities: [{ facilityId: 'FB3', polygonId: 'B3' }],
  });
  const touching = a.execute('plan.evaluate', { planId: 'PB-2B' });
  assert.deepEqual(touching.conflicts, []);
  assert.ok(touching.approvable);
});

test('方案撤回后重报：撤回方案不占累计，重报方案可获批', () => {
  const a = setupJointReview();
  for (const id of ['PLAN-1', 'PLAN-2', 'PLAN-3', 'PLAN-TRAIL']) approveByTwo(a, id);

  a.execute('survey.submit', {
    surveyVersionId: 'SV-W', projectId: 'PRJ-A', parcelId: 'P-001',
    polygons: [
      { polygonId: 'W1', geometry: rect(60, 0, 10, 10) }, // 100 ㎡，超额
      { polygonId: 'W2', geometry: rect(60, 20, 8, 5) },  // 40 ㎡，恰好等于剩余
    ],
  });
  a.execute('plan.submit', {
    planId: 'PLAN-W', projectId: 'PRJ-A', parcelId: 'P-001', phase: '补报',
    surveyVersionId: 'SV-W', facilities: [{ facilityId: 'FW1', polygonId: 'W1' }],
  });
  assert.equal(a.execute('plan.evaluate', { planId: 'PLAN-W' }).approvable, false);
  a.execute('plan.withdraw', { planId: 'PLAN-W', reason: '企业主动缩小规模' });

  // 撤回后重报 40 ㎡方案
  a.execute('plan.submit', {
    planId: 'PLAN-W2', projectId: 'PRJ-A', parcelId: 'P-001', phase: '补报',
    surveyVersionId: 'SV-W', facilities: [{ facilityId: 'FW2', polygonId: 'W2' }],
  });
  const evaluation = a.execute('plan.evaluate', { planId: 'PLAN-W2' });
  assert.equal(evaluation.projectedTotal, 400);
  assert.equal(evaluation.remainingAfter, 0);
  approveByTwo(a, 'PLAN-W2');
  assert.equal(a.execute('parcel.ledger', { parcelId: 'P-001' }).approvedArea, 400);
});

test('测绘精度变化：历史批准锁定版本，新图纸不得覆盖；作废版本阻断待决方案', () => {
  const a = setupJointReview();
  approveByTwo(a, 'PLAN-1');

  // 已批准采用的 SV-1 被锁定，任何取代/作废尝试都被拒绝
  assert.throws(
    () => a.execute('survey.supersede', { surveyVersionId: 'SV-1' }),
    (e) => e.code === 'survey_locked',
  );
  assert.throws(
    () => a.execute('survey.invalidate', { surveyVersionId: 'SV-1', reason: '精度升级' }),
    (e) => e.code === 'survey_locked',
  );

  // 待决方案：其测绘版本被新图纸取代时给出提示，但仍按冻结版本审批
  const stale = a.execute('plan.evaluate', { planId: 'PLAN-2' });
  assert.equal(stale.surveyVersionStale, false);
  // SV-1 已锁定无法标记，改用独立宗地上的未锁定版本验证作废阻断
  const b = app();
  b.execute('parcel.register', { parcelId: 'P-03', permitNo: 'P-03', allowedArea: 200 });
  b.execute('project.register', { projectId: 'PRJ-C', parcelId: 'P-03' });
  b.execute('survey.submit', {
    surveyVersionId: 'SV-C1', projectId: 'PRJ-C', parcelId: 'P-03',
    polygons: [{ polygonId: 'Q1', geometry: rect(0, 0, 5, 5) }],
  });
  b.execute('plan.submit', {
    planId: 'PC-1', projectId: 'PRJ-C', parcelId: 'P-03', phase: '一期',
    surveyVersionId: 'SV-C1', facilities: [{ facilityId: 'FQ1', polygonId: 'Q1' }],
  });
  b.execute('survey.invalidate', { surveyVersionId: 'SV-C1', reason: '测绘精度复核不合格' });
  const blocked = b.execute('plan.evaluate', { planId: 'PC-1' });
  assert.ok(blocked.blockers.includes('survey_version_invalidated'));
});

test('跨项目共用设施：同一物理步道面积只计一次且互不判为空间冲突', () => {
  const a = setupJointReview();
  for (const id of ['PLAN-1', 'PLAN-2', 'PLAN-3', 'PLAN-TRAIL']) approveByTwo(a, id);
  // 剩余 40 ㎡先用满
  a.execute('survey.submit', {
    surveyVersionId: 'SV-FILL', projectId: 'PRJ-A', parcelId: 'P-001',
    polygons: [{ polygonId: 'G1', geometry: rect(60, 0, 8, 5) }],
  });
  a.execute('plan.submit', {
    planId: 'PLAN-FILL', projectId: 'PRJ-A', parcelId: 'P-001', phase: '补报',
    surveyVersionId: 'SV-FILL', facilities: [{ facilityId: 'FG1', polygonId: 'G1' }],
  });
  approveByTwo(a, 'PLAN-FILL');
  assert.equal(a.execute('parcel.ledger', { parcelId: 'P-001' }).remainingArea, 0);

  // 另一项目在同一宗地上共建同一步道（相同几何 + 相同 sharedKey）
  a.execute('project.register', { projectId: 'PRJ-D', parcelId: 'P-001', name: '林下研学' });
  a.execute('survey.submit', {
    surveyVersionId: 'SV-D1', projectId: 'PRJ-D', parcelId: 'P-001',
    polygons: [{ polygonId: 'TD', geometry: rect(0, 30, 20, 3) }],
  });
  a.execute('plan.submit', {
    planId: 'PD-1', projectId: 'PRJ-D', parcelId: 'P-001', phase: '配套',
    surveyVersionId: 'SV-D1',
    facilities: [{ facilityId: 'FTD', polygonId: 'TD', kind: '共用步道', sharedKey: 'trail-main' }],
  });
  const evaluation = a.execute('plan.evaluate', { planId: 'PD-1' });
  assert.deepEqual(evaluation.conflicts, [], '共用同一物理步道不算图斑重叠');
  assert.equal(evaluation.countedArea, 0, '共用步道面积已在他处计入，本方案不重复计');
  assert.equal(evaluation.projectedTotal, 400);
  assert.ok(evaluation.approvable);
  approveByTwo(a, 'PD-1');
  assert.equal(a.execute('parcel.ledger', { parcelId: 'P-001' }).approvedArea, 400,
    '共用设施不得造成累计面积虚增');
});

test('双岗审批：同一人不得凑两票；两方案合计超额时任何一个都无法放行', () => {
  const a = app();
  a.execute('parcel.register', { parcelId: 'P-04', permitNo: 'P-04', allowedArea: 150 });
  a.execute('project.register', { projectId: 'PRJ-E', parcelId: 'P-04' });
  a.execute('survey.submit', {
    surveyVersionId: 'SV-E1', projectId: 'PRJ-E', parcelId: 'P-04',
    polygons: [
      { polygonId: 'E1', geometry: rect(0, 0, 10, 10) }, // 100
      { polygonId: 'E2', geometry: rect(20, 0, 10, 10) }, // 100
    ],
  });
  a.execute('plan.submit', {
    planId: 'PE-1', projectId: 'PRJ-E', parcelId: 'P-04', phase: '一期',
    surveyVersionId: 'SV-E1', facilities: [{ facilityId: 'FE1', polygonId: 'E1' }],
  });
  a.execute('plan.submit', {
    planId: 'PE-2', projectId: 'PRJ-E', parcelId: 'P-04', phase: '二期',
    surveyVersionId: 'SV-E1', facilities: [{ facilityId: 'FE2', polygonId: 'E2' }],
  });
  // 两份待决方案合计 200 > 150：闸门同时阻断两者，防止连续放行造成超额
  assert.ok(a.execute('plan.evaluate', { planId: 'PE-1' }).blockers.includes('quota_exceeded'));
  assert.ok(a.execute('plan.evaluate', { planId: 'PE-2' }).blockers.includes('quota_exceeded'));
  // 阻断期间任何放行尝试都被拒绝（即便审批人身份合规）
  assert.throws(
    () => decide(a, 'PE-1', '张审核', true, ['林业岗']),
    (e) => e.code === 'gate_blocked',
  );

  // 驳回二期后，一期立即恢复可批（二期不再计入待决占用）
  decide(a, 'PE-2', '王审批', false, ['资源岗']);
  assert.equal(a.execute('plan.evaluate', { planId: 'PE-1' }).approvable, true);

  // 同一审批人不能投两次放行票
  decide(a, 'PE-1', '张审核', true, ['林业岗']);
  assert.throws(
    () => decide(a, 'PE-1', '张审核', true, ['林业岗']),
    (e) => e.code === 'approver_already_voted',
  );
  decide(a, 'PE-1', '李复核', true, ['资源岗']);
  assert.equal(a.state.plans.get('PE-1').status, 'approved');
  assert.equal(a.state.plans.get('PE-2').status, 'rejected');
});

test('现场核验与整改闭环：实测偏离批准图纸即失败，整改后恢复批准', () => {
  const a = app();
  a.execute('parcel.register', { parcelId: 'P-05', permitNo: 'P-05', allowedArea: 300 });
  a.execute('project.register', { projectId: 'PRJ-F', parcelId: 'P-05' });
  a.execute('survey.submit', {
    surveyVersionId: 'SV-F1', projectId: 'PRJ-F', parcelId: 'P-05',
    polygons: [{ polygonId: 'F1', geometry: rect(0, 0, 10, 10) }],
  });
  a.execute('plan.submit', {
    planId: 'PF-1', projectId: 'PRJ-F', parcelId: 'P-05', phase: '一期',
    surveyVersionId: 'SV-F1', facilities: [{ facilityId: 'FF1', polygonId: 'F1' }],
  });
  approveByTwo(a, 'PF-1');

  // 实测木屋外扩 1 米
  const failed = a.execute('inspection.record', {
    inspectionId: 'IN-1', planId: 'PF-1', inspector: '林管员小赵', result: 'pass',
    measuredPolygons: [{ polygonId: 'F1', geometry: rect(0, 0, 11, 10) }],
  });
  assert.equal(failed.result, 'fail');
  assert.equal(failed.deviations[0].type, 'geometry_changed');
  assert.equal(a.state.plans.get('PF-1').status, 'rectification');

  // 未批准用地图斑同样判偏离
  const unknown = a.execute('inspection.record', {
    inspectionId: 'IN-1B', planId: 'PF-1', inspector: '林管员小赵', result: 'pass',
    measuredPolygons: [{ polygonId: 'X9', geometry: rect(0, 0, 2, 2) }],
  });
  assert.equal(unknown.deviations[0].type, 'unapproved_facility');

  a.execute('rectification.open', {
    rectificationId: 'R-1', planId: 'PF-1',
    issues: ['木屋基础外扩，拆除超出部分'], dueDate: '2026-10-20',
  });
  a.execute('rectification.close', {
    rectificationId: 'R-1', resolutionNote: '已按批准图纸拆除复绿，复验合格',
  });
  assert.equal(a.state.plans.get('PF-1').status, 'approved');

  // 复验与批准图纸一致：通过，占用面积维持 100 ㎡
  const passed = a.execute('inspection.record', {
    inspectionId: 'IN-2', planId: 'PF-1', inspector: '林管员小赵', result: 'pass',
    measuredPolygons: [{ polygonId: 'F1', geometry: rect(0, 0, 10, 10) }],
  });
  assert.equal(passed.result, 'pass');
  assert.equal(a.execute('parcel.ledger', { parcelId: 'P-05' }).approvedArea, 100);
});

test('历史批准不可撤回、不可被重报覆盖', () => {
  const a = setupJointReview();
  approveByTwo(a, 'PLAN-1');
  assert.throws(
    () => a.execute('plan.withdraw', { planId: 'PLAN-1' }),
    (e) => e.code === 'plan_already_approved',
  );
  // 批准决定保留评估快照，可追溯每次采用的图斑版本
  const approvalIds = a.state.plans.get('PLAN-1').approvalIds;
  for (const id of approvalIds) {
    const record = a.state.approvals.get(id);
    assert.equal(record.evaluationSnapshot.surveyVersionId, 'SV-1');
    assert.equal(record.evaluationSnapshot.allowedArea, 400);
  }
});

test('测绘版本自相重叠与方案引用越界被拒绝', () => {
  const a = app();
  a.execute('parcel.register', { parcelId: 'P-06', permitNo: 'P-06', allowedArea: 300 });
  a.execute('project.register', { projectId: 'PRJ-G', parcelId: 'P-06' });
  assert.throws(
    () => a.execute('survey.submit', {
      surveyVersionId: 'SV-G1', projectId: 'PRJ-G', parcelId: 'P-06',
      polygons: [
        { polygonId: 'G1', geometry: rect(0, 0, 10, 10) },
        { polygonId: 'G2', geometry: rect(9, 0, 10, 10) },
      ],
    }),
    (e) => e.code === 'survey_self_overlap',
  );
  a.execute('survey.submit', {
    surveyVersionId: 'SV-G2', projectId: 'PRJ-G', parcelId: 'P-06',
    polygons: [{ polygonId: 'G1', geometry: rect(0, 0, 10, 10) }],
  });
  assert.throws(
    () => a.execute('plan.submit', {
      planId: 'PG-1', projectId: 'PRJ-G', parcelId: 'P-06', phase: '一期',
      surveyVersionId: 'SV-G2', facilities: [{ facilityId: 'FGX', polygonId: 'NOT-EXIST' }],
    }),
    (e) => e.code === 'polygon_not_in_version',
  );
});
