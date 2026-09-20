import assert from 'node:assert/strict';
import test from 'node:test';
import { AreaGate } from '../src/core.mjs';

// 轴对齐矩形（米）。
const rect = (x, y, w, h) => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];

// 联合审查会场景：连续提交三期木屋与一条共用步道，
// 一次性核对空间冲突、可批面积与每次决定采用的图斑版本。
function buildReviewFixture() {
  const gate = new AreaGate();
  // 宗地许可：生产服务设施占用林地上限 1000 平方米，核验容差 2 平方米。
  gate.registerParcel({ parcelId: 'P-LIN-01', totalQuadrat: 1000, toleranceM2: 2, holder: '村集体' });
  gate.registerProject({ projectId: 'J-木屋', parcelId: 'P-LIN-01', enterprise: '康养公司' });
  gate.registerProject({ projectId: 'J-茶室', parcelId: 'P-LIN-01', enterprise: '康养公司' });
  gate.registerSurvey({ surveyId: 'S-01', parcelId: 'P-LIN-01' });
  gate.addSurveyVersion({ surveyId: 'S-01', versionId: '2026春-0.5m', precisionM: 0.5 });

  const base = {
    parcelId: 'P-LIN-01',
    projectId: 'J-木屋',
    surveyId: 'S-01',
    surveyVersionId: '2026春-0.5m',
  };

  gate.submitPlan({
    ...base,
    planId: '一期',
    phaseNo: 1,
    facilities: [{ facilityId: '木屋-1', ...base, ring: rect(0, 0, 15, 10) }],
  }); // 150
  gate.submitPlan({
    ...base,
    planId: '二期',
    phaseNo: 2,
    facilities: [{ facilityId: '木屋-2', ...base, ring: rect(30, 0, 15, 10) }],
  }); // 150
  gate.submitPlan({
    ...base,
    planId: '三期',
    phaseNo: 3,
    facilities: [{ facilityId: '木屋-3', ...base, ring: rect(60, 0, 15, 10) }],
  }); // 150
  gate.submitPlan({
    ...base,
    planId: '共用步道',
    projectId: 'J-木屋',
    phaseNo: 4,
    sharedWithProjectIds: ['J-茶室'],
    facilities: [{ facilityId: '步道', kind: 'trail', ...base, ring: rect(0, 40, 200, 2) }],
  }); // 400
  return gate;
}

test('联合审查：四案连续提交，串行累计 850/1000，全部可批且版本一致', () => {
  const gate = buildReviewFixture();
  const review = gate.evaluateJointReview('P-LIN-01');

  assert.equal(review.pendingCount, 4);
  assert.equal(review.pendingConflicts.length, 0);
  assert.deepEqual(review.sequence.map((s) => s.decision), ['approvable', 'approvable', 'approvable', 'approvable']);
  // 步道为共用设施，只作为一条方案计入面积一次。
  assert.equal(review.sequence.reduce((sum, s) => sum + s.areaM2, 0), 850);
  assert.equal(review.remainingM2, 1000); // 尚未批准，剩余仍是满额
});

test('联合审查：任一方案图斑与他案重叠即被识别并阻断', () => {
  const gate = buildReviewFixture();
  // 茶室项目临时插入一栋配套用房，压在步道上。
  gate.submitPlan({
    parcelId: 'P-LIN-01',
    projectId: 'J-茶室',
    planId: '茶室配套',
    phaseNo: 1,
    facilities: [{
      facilityId: '茶室-1',
      surveyId: 'S-01',
      surveyVersionId: '2026春-0.5m',
      ring: rect(0, 39, 20, 4), // 与 y=40..42 的步道重叠 20×2=40
    }],
  });
  const review = gate.evaluateJointReview('P-LIN-01');
  assert.equal(review.pendingConflicts.length, 1);
  assert.equal(review.pendingConflicts[0].overlapM2, 40);
  const blocked = review.sequence.find((s) => s.planId === '茶室配套');
  assert.equal(blocked.decision, 'blocked');
  assert.ok(blocked.blockReasons.some((r) => r.code === 'spatial_conflict'));
});

test('联合审查：许可边界只允许前三期与步道按序放行，超额方案被串行闸门拦截', () => {
  const gate = buildReviewFixture();
  // 缩小宗地许可：三期木屋 450 + 步道 400 = 850 可批；
  // 再加一栋茶室 200，串行到它时累计 1050 > 1000（许可调为 900 时步道之后已无空间）。
  gate.submitPlan({
    parcelId: 'P-LIN-01',
    projectId: 'J-茶室',
    planId: '茶室',
    phaseNo: 1,
    facilities: [{
      facilityId: '茶室-1',
      surveyId: 'S-01',
      surveyVersionId: '2026春-0.5m',
      ring: rect(0, 60, 10, 10),
    }],
  }); // 100

  // 按提交顺序：三期 450 + 步道 400 = 850，茶室 100 串行后 950，仍可批。
  let review = gate.evaluateJointReview('P-LIN-01');
  assert.deepEqual(review.sequence.map((s) => [s.planId, s.decision]), [
    ['一期', 'approvable'],
    ['二期', 'approvable'],
    ['三期', 'approvable'],
    ['共用步道', 'approvable'],
    ['茶室', 'approvable'],
  ]);

  // 现场先放行前三期（模拟审查会逐项表决），再重算：步道 400 后剩 150，茶室 100 仍可批。
  for (const planId of ['一期', '二期', '三期']) {
    gate.approve(planId, '林业站长');
    gate.approve(planId, '自然资源所长');
  }
  review = gate.evaluateJointReview('P-LIN-01');
  assert.equal(review.cumulativeM2, 450);
  assert.equal(review.remainingM2, 550);

  // 步道获批后剩 150；此时若茶室图纸扩大到 200，将被串行累计拦截。
  gate.withdrawPlan('茶室');
  gate.submitPlan({
    parcelId: 'P-LIN-01',
    projectId: 'J-茶室',
    planId: '茶室-扩大',
    priorVersionId: '茶室',
    phaseNo: 1,
    facilities: [{
      facilityId: '茶室-1',
      surveyId: 'S-01',
      surveyVersionId: '2026春-0.5m',
      ring: rect(0, 60, 20, 10),
    }],
  }); // 200
  gate.approve('共用步道', '林业站长');
  gate.approve('共用步道', '自然资源所长');

  review = gate.evaluateJointReview('P-LIN-01');
  assert.equal(review.cumulativeM2, 850);
  const tea = review.sequence.find((s) => s.planId === '茶室-扩大');
  assert.equal(tea.decision, 'blocked');
  assert.ok(tea.blockReasons.some((r) => r.code === 'over_quota'));
  assert.equal(review.remainingM2, 150);
});

test('联合审查：在途期间测绘换版，受影响方案必须按新版本重报，已批方案保留旧快照', () => {
  const gate = buildReviewFixture();
  // 一期在审查会前抢先获批，采用春测版本。
  gate.approve('一期', '林业站长');
  gate.approve('一期', '自然资源所长');

  // 测绘单位提交高精度新图斑版本。
  gate.addSurveyVersion({ surveyId: 'S-01', versionId: '2026夏-0.1m', precisionM: 0.1 });

  const review = gate.evaluateJointReview('P-LIN-01');
  // 已批的一期按旧版本计入 150 平米，未被新图纸覆盖。
  assert.equal(review.cumulativeM2, 150);
  assert.deepEqual(review.approvedBreakdown[0].adoptedSurveyVersions, [
    { facilityId: '木屋-1', surveyVersionId: '2026春-0.5m' },
  ]);
  // 其余三期一案均因版本陈旧被阻断。
  for (const planId of ['二期', '三期', '共用步道']) {
    const item = review.sequence.find((s) => s.planId === planId);
    assert.equal(item.decision, 'blocked');
    assert.ok(item.blockReasons.some((r) => r.code === 'survey_version_stale'));
  }
});
