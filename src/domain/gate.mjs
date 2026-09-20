import { GateError } from './errors.mjs';
import { rectanglesOverlap, rectangleArea, roundArea } from './geometry.mjs';

// ---------------------------------------------------------------------------
// 内存状态库（单进程、单事件循环；生产环境应替换为带事务的持久化存储）
// ---------------------------------------------------------------------------

export function createInitialState() {
  return {
    parcels: new Map(), // parcelId -> 宗地许可记录
    projects: new Map(), // projectId -> 项目记录
    surveyVersions: new Map(), // surveyVersionId -> 测绘图斑版本
    plans: new Map(), // planId -> 分期方案
    planIndexByProject: new Map(), // projectId -> [planId]
    approvals: new Map(), // approvalId -> 审批决定
    approvalsByPlan: new Map(), // planId -> [approvalId]（按时间序）
    inspections: new Map(), // inspectionId -> 现场核验
    inspectionsByPlan: new Map(), // planId -> [inspectionId]
    rectifications: new Map(), // rectificationId -> 整改单
    rectificationsByPlan: new Map(), // planId -> [rectificationId]
  };
}

// ---------------------------------------------------------------------------
// 宗地与项目
// ---------------------------------------------------------------------------

export function registerParcel(state, input) {
  const { parcelId, permitNo, allowedArea } = input;
  assertRequired({ parcelId, permitNo, allowedArea });
  if (state.parcels.has(parcelId)) {
    throw new GateError('parcel_exists', `宗地 ${parcelId} 已存在许可记录`);
  }
  if (!(allowedArea > 0)) {
    throw new GateError('invalid_area', '许可面积必须为正数', { allowedArea });
  }
  const parcel = {
    parcelId,
    permitNo,
    allowedArea: roundArea(allowedArea),
    createdAt: nowIso(),
  };
  state.parcels.set(parcelId, parcel);
  return parcel;
}

export function registerProject(state, input) {
  const { projectId, parcelId, name } = input;
  assertRequired({ projectId, parcelId });
  const parcel = getParcel(state, parcelId);
  if (state.projects.has(projectId)) {
    throw new GateError('project_exists', `项目 ${projectId} 已存在`);
  }
  const project = {
    projectId,
    parcelId,
    name: name ?? projectId,
    permitNo: parcel.permitNo,
    createdAt: nowIso(),
  };
  state.projects.set(projectId, project);
  state.planIndexByProject.set(projectId, []);
  return project;
}

// ---------------------------------------------------------------------------
// 测绘图斑版本
// ---------------------------------------------------------------------------

export function submitSurveyVersion(state, input) {
  const { surveyVersionId, projectId, parcelId, polygons, note } = input;
  assertRequired({ surveyVersionId, projectId, parcelId });
  getProject(state, projectId);
  getParcel(state, parcelId);
  if (!Array.isArray(polygons) || polygons.length === 0) {
    throw new GateError('empty_survey', '测绘版本至少包含一个图斑');
  }
  const normalized = polygons.map((polygon, index) => {
    const geometry = polygon.geometry;
    if (!geometry || typeof geometry.x !== 'number' || typeof geometry.y !== 'number' ||
      typeof geometry.width !== 'number' || typeof geometry.height !== 'number' ||
      geometry.width <= 0 || geometry.height <= 0) {
      throw new GateError('invalid_polygon', `图斑 ${index} 几何不合法`);
    }
    return {
      polygonId: polygon.polygonId ?? `${surveyVersionId}-P${index + 1}`,
      geometry,
      area: rectangleArea(geometry),
    };
  });
  // 同一版本内部不得自相重叠（测绘精度自洽）
  for (let i = 0; i < normalized.length; i += 1) {
    for (let j = i + 1; j < normalized.length; j += 1) {
      if (rectanglesOverlap(normalized[i].geometry, normalized[j].geometry)) {
        throw new GateError('survey_self_overlap',
          `测绘版本内部图斑 ${normalized[i].polygonId} 与 ${normalized[j].polygonId} 重叠`);
      }
    }
  }
  const totalArea = roundArea(normalized.reduce((sum, p) => sum + p.area, 0));
  const version = {
    surveyVersionId,
    projectId,
    parcelId,
    note: note ?? '',
    polygons: normalized,
    totalArea,
    superseded: false,
    createdAt: nowIso(),
  };
  state.surveyVersions.set(surveyVersionId, version);
  return view(version);
}

// ---------------------------------------------------------------------------
// 分期方案提交与撤回
// ---------------------------------------------------------------------------

export function submitPlan(state, input) {
  const { planId, projectId, parcelId, phase, surveyVersionId, facilities } = input;
  assertRequired({ planId, projectId, parcelId, phase, surveyVersionId });
  const project = getProject(state, projectId);
  if (project.parcelId !== parcelId) {
    throw new GateError('parcel_mismatch', '项目与宗地不匹配');
  }
  if (state.plans.has(planId)) {
    throw new GateError('plan_exists', `方案 ${planId} 已存在`);
  }
  const surveyVersion = getSurveyVersion(state, surveyVersionId);
  if (surveyVersion.projectId !== projectId) {
    throw new GateError('survey_project_mismatch', '测绘版本不属于该项目');
  }
  if (!Array.isArray(facilities) || facilities.length === 0) {
    throw new GateError('empty_plan', '方案至少包含一项设施');
  }
  const items = facilities.map((facility) => {
    const polygon = surveyVersion.polygons.find((p) => p.polygonId === facility.polygonId);
    if (!polygon) {
      throw new GateError('polygon_not_in_version',
        `图斑 ${facility.polygonId} 不在测绘版本 ${surveyVersionId} 中`);
    }
    return {
      facilityId: facility.facilityId,
      kind: facility.kind ?? '设施',
      // 跨项目/跨期共用的同一物理设施给出相同 sharedKey（如共用步道），
      // 累计面积只计一次，且相互之间不判定为空间冲突。
      sharedKey: facility.sharedKey ?? null,
      polygonId: polygon.polygonId,
      geometry: polygon.geometry,
      area: polygon.area, // 面积以采用的测绘版本为准，审批时冻结
    };
  });
  // 同一方案内图斑不得重复引用
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.polygonId)) {
      throw new GateError('duplicate_polygon_in_plan', `图斑 ${item.polygonId} 在方案中重复引用`);
    }
    seen.add(item.polygonId);
  }
  const requestedArea = roundArea(items.reduce((sum, item) => sum + item.area, 0));
  const plan = {
    planId,
    projectId,
    parcelId,
    phase,
    surveyVersionId, // 冻结：本方案审批始终采用该版本，新测绘不覆盖历史
    facilities: items,
    requestedArea,
    status: 'submitted',
    createdAt: nowIso(),
  };
  state.plans.set(planId, plan);
  state.planIndexByProject.get(projectId).push(planId);
  state.approvalsByPlan.set(planId, []);
  state.inspectionsByPlan.set(planId, []);
  state.rectificationsByPlan.set(planId, []);
  return view(plan);
}

export function withdrawPlan(state, input) {
  const { planId, reason } = input;
  assertRequired({ planId });
  const plan = getPlan(state, planId);
  if (plan.status === 'approved') {
    throw new GateError('plan_already_approved', '已批准方案不得撤回（历史批准不可覆盖）');
  }
  if (plan.status === 'withdrawn') {
    throw new GateError('plan_already_withdrawn', '方案已撤回');
  }
  plan.status = 'withdrawn';
  plan.withdrawnAt = nowIso();
  plan.withdrawReason = reason ?? '';
  return view(plan);
}

// ---------------------------------------------------------------------------
// 审批闸门
// ---------------------------------------------------------------------------

// 计算一个项目宗地内“已锁定”的累计占用：
// 已批准方案全部计入 + 待决方案各自计入（按方案隔离评估）。
// 共用图斑跨项目只计一次（按 polygonGeometry 指纹去重）。
export function evaluatePlan(state, planId) {
  const plan = getPlan(state, planId);
  if (plan.status !== 'submitted') {
    throw new GateError('plan_not_decisionable', `方案状态为 ${plan.status}，不可审批`, {
      status: plan.status,
    });
  }
  const parcel = getParcel(state, parcelIdOf(state, plan));

  // 1) 空间冲突：与同宗地上已批准 / 其他待决方案的图斑内相交即阻断。
  //    同一 sharedKey 的共用设施是同一物理实体，不算冲突。
  const conflicts = [];
  for (const other of activePlansOnParcel(state, parcel.parcelId)) {
    if (other.planId === plan.planId) continue;
    for (const mine of plan.facilities) {
      for (const theirs of other.facilities) {
        if (mine.sharedKey && mine.sharedKey === theirs.sharedKey) continue;
        if (rectanglesOverlap(mine.geometry, theirs.geometry)) {
          conflicts.push({
            otherPlanId: other.planId,
            otherStatus: other.status,
            polygonId: mine.polygonId,
            otherPolygonId: theirs.polygonId,
          });
        }
      }
    }
  }

  // 2) 累计面积：已批准（不可变）+ 其他待决方案（防两名审批人同时放行）+ 本方案。
  //    共用图斑（相同 sharedKey 或完全相同几何）全局只计一次；
  //    归属优先级：已批准 > 其他待决 > 本方案，避免同一共用设施跨桶重复计。
  const ledger = new Map(); // 指纹 -> { area, bucket }
  for (const other of activePlansOnParcel(state, parcel.parcelId)) {
    const bucket = other.planId === plan.planId ? 'plan'
      : other.status === 'approved' ? 'committed' : 'pending';
    for (const item of other.facilities) {
      const fingerprint = item.sharedKey
        ? `shared:${item.sharedKey}`
        : `geom:${JSON.stringify(item.geometry)}`;
      if (!ledger.has(fingerprint)) {
        ledger.set(fingerprint, { area: item.area, bucket });
      } else if (bucketRank(bucket) < bucketRank(ledger.get(fingerprint).bucket)) {
        ledger.get(fingerprint).bucket = bucket;
      }
    }
  }

  const buckets = { committed: 0, pending: 0, plan: 0 };
  for (const entry of ledger.values()) buckets[entry.bucket] += entry.area;
  const committedArea = roundArea(buckets.committed);
  const pendingArea = roundArea(buckets.pending);
  const planArea = roundArea(buckets.plan);
  const projectedTotal = roundArea(committedArea + pendingArea + planArea);
  const remainingBefore = roundArea(parcel.allowedArea - committedArea);
  const remainingAfter = roundArea(parcel.allowedArea - projectedTotal);
  const withinQuota = projectedTotal <= parcel.allowedArea;

  // 3) 版本冻结检查：审批采用提交时锁定的测绘版本；版本被新图纸取代不影响审批，
  //    但若锁定版本被标记作废则阻断
  const surveyVersion = getSurveyVersion(state, plan.surveyVersionId);
  const versionStale = surveyVersion.superseded;
  const versionInvalid = surveyVersion.invalidated === true;

  const blockers = [];
  if (conflicts.length > 0) blockers.push('spatial_conflict');
  if (!withinQuota) blockers.push('quota_exceeded');
  if (versionInvalid) blockers.push('survey_version_invalidated');

  return {
    parcelId: parcel.parcelId,
    permitNo: parcel.permitNo,
    allowedArea: parcel.allowedArea,
    planId: plan.planId,
    phase: plan.phase,
    surveyVersionId: plan.surveyVersionId,
    surveyVersionStale: versionStale, // 仅提示：审批仍以冻结版本为准
    requestedArea: plan.requestedArea,
    countedArea: planArea,
    committedArea, // 已批准累计（共用去重后）
    pendingArea, // 其他待决方案占用
    projectedTotal,
    remainingBefore,
    remainingAfter,
    conflicts,
    blockers,
    approvable: blockers.length === 0,
    evaluatedAt: nowIso(),
  };
}

// 双岗审批：两名不同审批人各自独立决定；两人都放行且闸门检查仍通过才生效。
// 任一驳回即整体驳回；任一次决定都重新执行闸门检查（防止并发超额）。
export function decidePlan(state, input) {
  const { planId, approver, role, approved, comment } = input;
  assertRequired({ planId, approver, role });
  if (!Array.isArray(role) || role.length === 0) {
    throw new GateError('invalid_role', '审批人角色缺失');
  }
  const plan = getPlan(state, planId);
  if (plan.status !== 'submitted') {
    throw new GateError('plan_not_decisionable', `方案状态为 ${plan.status}，不可审批`);
  }
  const records = state.approvalsByPlan.get(planId);

  if (approved) {
    // 同一人不能重复放行（防止一个人凑两票）
    if (records.some((r) => r.approved && r.approver === approver)) {
      throw new GateError('approver_already_voted', `${approver} 已完成放行`);
    }
    // 放行前必须重新计算闸门：两人同时放行时第二人会看到最新累计
    const evaluation = evaluatePlan(state, planId);
    if (!evaluation.approvable) {
      throw new GateError('gate_blocked', '闸门检查未通过，不得放行', {
        blockers: evaluation.blockers,
        evaluation,
      });
    }
    const approval = {
      approvalId: `AP-${planId}-${records.length + 1}`,
      planId,
      approver,
      role,
      approved: true,
      comment: comment ?? '',
      evaluationSnapshot: evaluation, // 决定采用的图斑版本与空间快照
      decidedAt: nowIso(),
    };
    records.push(approval);
    state.approvals.set(approval.approvalId, approval);

    if (records.filter((r) => r.approved).length >= 2) {
      plan.status = 'approved';
      plan.approvedAt = nowIso();
      plan.approvalIds = records.filter((r) => r.approved).map((r) => r.approvalId);
      // 批准后锁定所采用的测绘版本，任何新图纸不得覆盖
      surveyLock(state, plan.surveyVersionId);
    }
    return { approval: view(approval), plan: view(plan), evaluation };
  }

  const approval = {
    approvalId: `AP-${planId}-${records.length + 1}`,
    planId,
    approver,
    role,
    approved: false,
    comment: comment ?? '',
    decidedAt: nowIso(),
  };
  records.push(approval);
  state.approvals.set(approval.approvalId, approval);
  plan.status = 'rejected';
  plan.rejectedAt = nowIso();
  return { approval: view(approval), plan: view(plan) };
}

// ---------------------------------------------------------------------------
// 现场核验与整改闭环
// ---------------------------------------------------------------------------

export function inspectOnSite(state, input) {
  const { inspectionId, planId, inspector, measuredPolygons, result, note } = input;
  assertRequired({ inspectionId, planId, inspector });
  const plan = getPlan(state, planId);
  if (plan.status !== 'approved' && plan.status !== 'rectification') {
    throw new GateError('plan_not_approved', '仅已批准或整改中的方案可现场核验');
  }
  if (!['pass', 'fail'].includes(result)) {
    throw new GateError('invalid_inspection_result', '核验结论必须为 pass 或 fail');
  }
  // 复核现场实测是否超出批准图纸（采用批准时冻结的图斑）
  const deviations = [];
  if (Array.isArray(measuredPolygons)) {
    for (const measured of measuredPolygons) {
      const approved = plan.facilities.find((f) => f.polygonId === measured.polygonId);
      if (!approved) {
        deviations.push({ polygonId: measured.polygonId, type: 'unapproved_facility' });
        continue;
      }
      const measuredArea = rectangleArea(measured.geometry);
      if (rectangleArea(approved.geometry) !== measuredArea ||
        JSON.stringify(approved.geometry) !== JSON.stringify(measured.geometry)) {
        deviations.push({
          polygonId: measured.polygonId,
          type: 'geometry_changed',
          approvedArea: approved.area,
          measuredArea,
        });
      }
    }
  }
  const inspection = {
    inspectionId,
    planId,
    inspector,
    result: deviations.length === 0 ? result : 'fail',
    note: note ?? '',
    measuredPolygons: measuredPolygons ?? [],
    deviations,
    inspectedAt: nowIso(),
  };
  state.inspections.set(inspectionId, inspection);
  state.inspectionsByPlan.get(planId).push(inspectionId);
  if (inspection.result === 'fail') {
    plan.status = 'rectification';
  }
  // 整改中的方案即使单次核验通过，也必须走完整改闭环才能恢复批准效力
  return view(inspection);
}

export function openRectification(state, input) {
  const { rectificationId, planId, issues, dueDate } = input;
  assertRequired({ rectificationId, planId });
  const plan = getPlan(state, planId);
  if (plan.status !== 'rectification') {
    throw new GateError('no_rectification_needed', '方案不在整改状态');
  }
  const rectification = {
    rectificationId,
    planId,
    issues: issues ?? [],
    dueDate: dueDate ?? null,
    status: 'open',
    createdAt: nowIso(),
  };
  state.rectifications.set(rectificationId, rectification);
  state.rectificationsByPlan.get(planId).push(rectificationId);
  return view(rectification);
}

export function closeRectification(state, input) {
  const { rectificationId, resolutionNote } = input;
  assertRequired({ rectificationId });
  const rectification = state.rectifications.get(rectificationId);
  if (!rectification) throw new GateError('rectification_not_found', '整改单不存在');
  if (rectification.status === 'closed') {
    throw new GateError('rectification_closed', '整改单已闭环');
  }
  rectification.status = 'closed';
  rectification.resolutionNote = resolutionNote ?? '';
  rectification.closedAt = nowIso();
  const plan = getPlan(state, rectification.planId);
  plan.status = 'approved'; // 整改通过，恢复批准效力，占用面积维持不变
  return view(rectification);
}

// ---------------------------------------------------------------------------
// 宗地台账与查询
// ---------------------------------------------------------------------------

export function parcelLedger(state, parcelId) {
  const parcel = getParcel(state, parcelId);
  const approved = [];
  const pending = [];
  const approvedFingerprints = new Map();
  for (const plan of state.plans.values()) {
    if (parcelIdOf(state, plan) !== parcelId) continue;
    if (plan.status === 'approved') {
      approved.push(plan);
      for (const item of plan.facilities) {
        committedFingerprint(approvedFingerprints, item, plan, state);
      }
    } else if (plan.status === 'submitted') {
      pending.push(plan);
    }
  }
  const approvedArea = roundArea(sumMap(approvedFingerprints));
  return {
    parcelId: parcel.parcelId,
    permitNo: parcel.permitNo,
    allowedArea: parcel.allowedArea,
    approvedArea,
    remainingArea: roundArea(parcel.allowedArea - approvedArea),
    approvedPlans: approved.map((p) => ({
      planId: p.planId,
      projectId: p.projectId,
      phase: p.phase,
      surveyVersionId: p.surveyVersionId,
      requestedArea: p.requestedArea,
    })),
    pendingPlans: pending.map((p) => ({
      planId: p.planId,
      projectId: p.projectId,
      phase: p.phase,
      surveyVersionId: p.surveyVersionId,
      requestedArea: p.requestedArea,
    })),
  };
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function committedFingerprint(map, item, plan, state) {
  // 共用设施：多个项目/期次引用同一物理图斑（相同 sharedKey）时只计一次；
  // 未声明 sharedKey 时，完全相同的几何坐标也视为同一物理图斑去重。
  const fingerprint = item.sharedKey
    ? `shared:${item.sharedKey}`
    : `geom:${JSON.stringify(item.geometry)}`;
  if (!map.has(fingerprint)) map.set(fingerprint, item.area);
}

function bucketRank(bucket) {
  return bucket === 'committed' ? 0 : bucket === 'pending' ? 1 : 2;
}

function sumMap(map) {
  let sum = 0;
  for (const value of map.values()) sum += value;
  return sum;
}

function activePlansOnParcel(state, parcelId) {
  const result = [];
  for (const plan of state.plans.values()) {
    if (parcelIdOf(state, plan) !== parcelId) continue;
    if (plan.status === 'approved' || plan.status === 'submitted') result.push(plan);
  }
  return result;
}

function parcelIdOf(state, plan) {
  return state.projects.get(plan.projectId)?.parcelId ?? plan.parcelId;
}

function surveyLock(state, surveyVersionId) {
  const version = state.surveyVersions.get(surveyVersionId);
  version.locked = true;
  version.lockedAt = nowIso();
}

export function markSurveySuperseded(state, surveyVersionId) {
  const version = getSurveyVersion(state, surveyVersionId);
  if (version.locked) {
    throw new GateError('survey_locked', '该版本已被历史批准锁定，不得标记作废或覆盖');
  }
  version.superseded = true;
  version.supersededAt = nowIso();
  return view(version);
}

export function invalidateSurveyVersion(state, surveyVersionId, reason) {
  const version = getSurveyVersion(state, surveyVersionId);
  if (version.locked) {
    throw new GateError('survey_locked', '该版本已被历史批准锁定，不得作废');
  }
  version.invalidated = true;
  version.invalidateReason = reason ?? '';
  version.invalidatedAt = nowIso();
  return view(version);
}

export function getParcel(state, parcelId) {
  const parcel = state.parcels.get(parcelId);
  if (!parcel) throw new GateError('parcel_not_found', `宗地 ${parcelId} 不存在`);
  return parcel;
}

export function getProject(state, projectId) {
  const project = state.projects.get(projectId);
  if (!project) throw new GateError('project_not_found', `项目 ${projectId} 不存在`);
  return project;
}

export function getPlan(state, planId) {
  const plan = state.plans.get(planId);
  if (!plan) throw new GateError('plan_not_found', `方案 ${planId} 不存在`);
  return plan;
}

export function getSurveyVersion(state, surveyVersionId) {
  const version = state.surveyVersions.get(surveyVersionId);
  if (!version) throw new GateError('survey_not_found', `测绘版本 ${surveyVersionId} 不存在`);
  return version;
}

function assertRequired(fields) {
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') {
      throw new GateError('missing_field', `字段 ${key} 为必填项`);
    }
  }
}

function nowIso() {
  return new Date().toISOString();
}

function view(record) {
  return structuredClone(record);
}
