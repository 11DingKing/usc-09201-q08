// 林下设施面积闸门核心：不可变事件账本 + 按宗地派生的当前状态 + 面积闸门规则。
// 所有决定都只追加事件，历史批准不会被新图纸改写；当前状态由事件流归约得到。

import { DomainError, intersectionArea, outsideArea, ringArea } from './geometry.mjs';

const TERMINAL_PLAN_STATUSES = new Set(['rejected', 'withdrawn']);

export class InMemoryEventStore {
  constructor() {
    this.events = [];
    this.listeners = new Set();
  }

  append(type, payload) {
    const event = {
      id: this.events.length + 1,
      type,
      at: new Date().toISOString(),
      payload,
    };
    this.events.push(event);
    for (const listener of this.listeners) listener(event);
    return event;
  }

  [Symbol.iterator]() {
    return this.events[Symbol.iterator]();
  }
}

function asNumber(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new DomainError('invalid_number', `${field} 必须为正数`, { field });
  }
  return value;
}

function requireId(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DomainError('invalid_id', `${field} 不能为空`, { field });
  }
  return value;
}

// ---- 状态归约 ----------------------------------------------------------------

export function deriveState(events) {
  const state = {
    parcels: new Map(),
    projects: new Map(),
    surveys: new Map(),
    plans: new Map(),
  };

  for (const event of events) {
    const p = event.payload;
    switch (event.type) {
      case 'ParcelRegistered': {
        state.parcels.set(p.parcelId, {
          parcelId: p.parcelId,
          location: p.location,
          holder: p.holder,
          totalQuadrat: p.totalQuadrat,
          toleranceM2: p.toleranceM2,
          registeredAt: event.at,
        });
        break;
      }
      case 'ProjectRegistered': {
        state.projects.set(p.projectId, {
          projectId: p.projectId,
          parcelId: p.parcelId,
          name: p.name,
          enterprise: p.enterprise,
        });
        break;
      }
      case 'SurveyRegistered': {
        state.surveys.set(p.surveyId, {
          surveyId: p.surveyId,
          parcelId: p.parcelId,
          currentVersionId: null,
          versions: new Map(),
        });
        break;
      }
      case 'SurveyVersionAdded': {
        const survey = state.surveys.get(p.surveyId);
        survey.versions.set(p.versionId, {
          versionId: p.versionId,
          precisionM: p.precisionM,
          note: p.note,
          at: event.at,
        });
        survey.currentVersionId = p.versionId; // 新版本自动成为当前版本
        break;
      }
      case 'PlanSubmitted': {
        state.plans.set(p.planId, {
          planId: p.planId,
          seq: event.id,
          parcelId: p.parcelId,
          projectId: p.projectId,
          phaseNo: p.phaseNo,
          priorVersionId: p.priorVersionId ?? null,
          sharedWithProjectIds: [...(p.sharedWithProjectIds ?? [])],
          facilities: p.facilities.map((f) => ({ ...f, ring: f.ring.map((pt) => [...pt]) })),
          submittedAt: event.at,
          status: 'submitted',
          approvals: [],
          decision: null,
          verification: null,
          rectifications: [],
        });
        break;
      }
      case 'PlanWithdrawn': {
        const plan = state.plans.get(p.planId);
        plan.status = 'withdrawn';
        plan.withdrawnAt = event.at;
        plan.withdrawReason = p.reason;
        break;
      }
      case 'PlanPartialApproval': {
        // 第一名审批人放行：暂存意见，不占面积，等待第二名重新核算。
        const plan = state.plans.get(p.planId);
        plan.approvals = [...p.approvers];
        break;
      }
      case 'PlanApproved': {
        const plan = state.plans.get(p.planId);
        plan.status = 'approved';
        plan.approvals = [...p.approvers];
        plan.decision = {
          outcome: 'approved',
          at: event.at,
          approvers: [...p.approvers],
          adoptedSurveyVersions: new Map(p.facilities.map((f) => [f.facilityId, f.surveyVersionId])),
          facilities: p.facilities.map((f) => ({ ...f, ring: f.ring.map((pt) => [...pt]) })),
          cumulativeBefore: p.cumulativeBefore,
          cumulativeAfter: p.cumulativeAfter,
          remainingBefore: p.remainingBefore,
          remainingAfter: p.remainingAfter,
        };
        break;
      }
      case 'PlanRejected': {
        const plan = state.plans.get(p.planId);
        plan.status = 'rejected';
        plan.decision = {
          outcome: 'rejected',
          at: event.at,
          approvers: [...p.approvers],
          reasons: [...p.reasons],
        };
        break;
      }
      case 'VerificationRecorded': {
        const plan = state.plans.get(p.planId);
        plan.verification = {
          at: event.at,
          inspector: p.inspector,
          passed: p.passed,
          toleranceM2: p.toleranceM2,
          actuals: p.actuals.map((a) => ({ ...a, ring: a.ring.map((pt) => [...pt]) })),
        };
        if (!p.passed) plan.rectificationOpen = true;
        break;
      }
      case 'RectificationSubmitted': {
        const plan = state.plans.get(p.planId);
        plan.rectifications.push({
          at: event.at,
          note: p.note,
          actuals: p.actuals.map((a) => ({ ...a, ring: a.ring.map((pt) => [...pt]) })),
          resolutions: [],
        });
        plan.rectificationOpen = true;
        break;
      }
      case 'RectificationResolved': {
        const plan = state.plans.get(p.planId);
        const item = plan.rectifications[plan.rectifications.length - 1];
        item.resolutions.push({ at: event.at, outcome: p.outcome, reasons: [...p.reasons] });
        if (p.outcome === 'closed') {
          plan.rectificationOpen = false;
          plan.verification = {
            ...plan.verification,
            passed: true,
            closedAt: event.at,
            actuals: p.actuals.map((a) => ({ ...a, ring: a.ring.map((pt) => [...pt]) })),
          };
        }
        break;
      }
      default:
        // 未知事件类型忽略，保证账本前向兼容。
        break;
    }
  }
  return state;
}

// ---- 闸门应用服务 ------------------------------------------------------------

export class AreaGate {
  constructor(store = new InMemoryEventStore()) {
    this.store = store;
  }

  get state() {
    return deriveState(this.store);
  }

  // 宗地许可：登记许可总面积（平方米）与核验容差（测绘精度变化由此吸收）。
  registerParcel(input) {
    const parcelId = requireId(input?.parcelId, 'parcelId');
    const totalQuadrat = asNumber(input.totalQuadrat, 'totalQuadrat');
    const toleranceM2 = input.toleranceM2 == null ? 0 : asNumber(input.toleranceM2, 'toleranceM2');
    if (this.state.parcels.has(parcelId)) {
      throw new DomainError('parcel_exists', '宗地已登记', { parcelId });
    }
    this.store.append('ParcelRegistered', {
      parcelId,
      location: input.location ?? null,
      holder: input.holder ?? null,
      totalQuadrat,
      toleranceM2,
    });
    return this.state.parcels.get(parcelId);
  }

  registerProject(input) {
    const projectId = requireId(input?.projectId, 'projectId');
    const parcelId = requireId(input.parcelId, 'parcelId');
    if (!this.state.parcels.has(parcelId)) {
      throw new DomainError('parcel_not_found', '宗地不存在', { parcelId });
    }
    if (this.state.projects.has(projectId)) {
      throw new DomainError('project_exists', '项目已登记', { projectId });
    }
    this.store.append('ProjectRegistered', {
      projectId,
      parcelId,
      name: input.name ?? null,
      enterprise: input.enterprise ?? null,
    });
    return this.state.projects.get(projectId);
  }

  // 测绘图斑按“测绘批次 + 版本”管理；新版本产生后旧版本不再可用于新决定，
  // 但已经作出的批准保留各自采用的版本快照。
  registerSurvey(input) {
    const surveyId = requireId(input?.surveyId, 'surveyId');
    const parcelId = requireId(input.parcelId, 'parcelId');
    if (!this.state.parcels.has(parcelId)) {
      throw new DomainError('parcel_not_found', '宗地不存在', { parcelId });
    }
    if (this.state.surveys.has(surveyId)) {
      throw new DomainError('survey_exists', '测绘批次已存在', { surveyId });
    }
    this.store.append('SurveyRegistered', { surveyId, parcelId });
    return this.state.surveys.get(surveyId);
  }

  addSurveyVersion(input) {
    const surveyId = requireId(input?.surveyId, 'surveyId');
    const versionId = requireId(input.versionId, 'versionId');
    const survey = this.state.surveys.get(surveyId);
    if (!survey) throw new DomainError('survey_not_found', '测绘批次不存在', { surveyId });
    if (survey.versions.has(versionId)) {
      throw new DomainError('version_exists', '图斑版本已存在', { surveyId, versionId });
    }
    const precisionM = input.precisionM == null ? null : asNumber(input.precisionM, 'precisionM');
    this.store.append('SurveyVersionAdded', {
      surveyId,
      versionId,
      precisionM,
      note: input.note ?? null,
    });
    return this.state.surveys.get(surveyId);
  }

  // 分期方案提交。同一项目同一期号只允许一个在途方案；撤回/驳回后可重报新版本。
  submitPlan(input) {
    const planId = requireId(input?.planId, 'planId');
    const parcelId = requireId(input.parcelId, 'parcelId');
    const projectId = requireId(input.projectId, 'projectId');
    const phaseNo = asNumber(input.phaseNo, 'phaseNo');
    const state = this.state;

    const parcel = state.parcels.get(parcelId);
    if (!parcel) throw new DomainError('parcel_not_found', '宗地不存在', { parcelId });
    const project = state.projects.get(projectId);
    if (!project || project.parcelId !== parcelId) {
      throw new DomainError('project_not_found', '项目不存在或不属于该宗地', { projectId, parcelId });
    }
    if (state.plans.has(planId)) {
      throw new DomainError('plan_exists', '方案编号已存在', { planId });
    }

    const sharedWithProjectIds = [...new Set(input.sharedWithProjectIds ?? [])];
    for (const sharedId of sharedWithProjectIds) {
      const shared = state.projects.get(sharedId);
      if (!shared || shared.parcelId !== parcelId) {
        throw new DomainError('shared_project_not_found', '共用项目不存在或不在同一宗地', { sharedId });
      }
    }

    if (input.priorVersionId != null) {
      const prior = state.plans.get(input.priorVersionId);
      if (!prior || prior.projectId !== projectId || prior.phaseNo !== phaseNo) {
        throw new DomainError('prior_version_mismatch', '前版方案不属于同一项目同一期号', {
          priorVersionId: input.priorVersionId,
        });
      }
      if (!TERMINAL_PLAN_STATUSES.has(prior.status)) {
        throw new DomainError('prior_version_active', '前版方案仍在途，不能重报', {
          priorVersionId: input.priorVersionId,
        });
      }
    }

    for (const plan of state.plans.values()) {
      const sameSlot =
        plan.parcelId === parcelId && plan.projectId === projectId && plan.phaseNo === phaseNo;
      if (sameSlot && !TERMINAL_PLAN_STATUSES.has(plan.status)) {
        throw new DomainError('phase_slot_busy', '该期号已有在途方案', {
          projectId,
          phaseNo,
          activePlanId: plan.planId,
        });
      }
    }

    if (!Array.isArray(input.facilities) || input.facilities.length === 0) {
      throw new DomainError('no_facilities', '方案至少包含一处设施');
    }
    const facilityIds = new Set();
    const facilities = input.facilities.map((f) => {
      requireId(f?.facilityId, 'facilityId');
      if (facilityIds.has(f.facilityId)) {
        throw new DomainError('duplicate_facility', '方案内设施编号重复', { facilityId: f.facilityId });
      }
      facilityIds.add(f.facilityId);
      const survey = state.surveys.get(f.surveyId);
      if (!survey || survey.parcelId !== parcelId) {
        throw new DomainError('survey_not_found', '测绘批次不存在或不属于该宗地', { surveyId: f.surveyId });
      }
      const version = survey.versions.get(f.surveyVersionId);
      if (!version) {
        throw new DomainError('version_not_found', '图斑版本不存在', {
          surveyId: f.surveyId,
          surveyVersionId: f.surveyVersionId,
        });
      }
      if (survey.currentVersionId !== f.surveyVersionId) {
        throw new DomainError('survey_version_stale', '只能按当前图斑版本报建', {
          surveyId: f.surveyId,
          currentVersionId: survey.currentVersionId,
          submittedVersionId: f.surveyVersionId,
        });
      }
      if (!Array.isArray(f.ring) || f.ring.length < 3) {
        throw new DomainError('invalid_ring', '图斑环至少需要 3 个控制点', { facilityId: f.facilityId });
      }
      const area = ringArea(f.ring);
      if (!(area > 0)) {
        throw new DomainError('invalid_ring', '图斑面积必须为正', { facilityId: f.facilityId });
      }
      return {
        facilityId: f.facilityId,
        kind: f.kind ?? 'facility',
        surveyId: f.surveyId,
        surveyVersionId: f.surveyVersionId,
        ring: f.ring.map((pt) => [Number(pt[0]), Number(pt[1])]),
        area,
      };
    });

    // 同一方案内设施不得自相重叠。
    for (let i = 0; i < facilities.length; i += 1) {
      for (let j = i + 1; j < facilities.length; j += 1) {
        const overlap = intersectionArea(facilities[i].ring, facilities[j].ring);
        if (overlap > 0) {
          throw new DomainError('spatial_conflict', '方案内图斑相互重叠', {
            a: facilities[i].facilityId,
            b: facilities[j].facilityId,
            overlapM2: overlap,
          });
        }
      }
    }

    this.store.append('PlanSubmitted', {
      planId,
      parcelId,
      projectId,
      phaseNo,
      priorVersionId: input.priorVersionId ?? null,
      sharedWithProjectIds,
      facilities,
    });
    return this.state.plans.get(planId);
  }

  withdrawPlan(planId, reason = null) {
    requireId(planId, 'planId');
    const plan = this.state.plans.get(planId);
    if (!plan) throw new DomainError('plan_not_found', '方案不存在', { planId });
    if (plan.status === 'withdrawn') {
      throw new DomainError('plan_withdrawn', '方案已撤回', { planId });
    }
    if (plan.status === 'rejected') {
      throw new DomainError('plan_rejected', '已驳回方案无需撤回', { planId });
    }
    this.store.append('PlanWithdrawn', { planId, reason });
    return this.state.plans.get(planId);
  }

  // 当前生效（已批准且未撤回）的方案与图斑。
  effectivePlans(state = this.state, parcelId = null) {
    const plans = [];
    for (const plan of state.plans.values()) {
      if (plan.status !== 'approved') continue;
      if (parcelId != null && plan.parcelId !== parcelId) continue;
      plans.push(plan);
    }
    return plans;
  }

  // 宗地累计占用：生效批准的图斑面积之和。跨项目共用设施本身是一条方案，
  // 只登记一次，因此天然只计一次，不会被各项目重复累计。
  cumulativeOccupancy(state = this.state, parcelId) {
    let cumulative = 0;
    const breakdown = [];
    for (const plan of this.effectivePlans(state, parcelId)) {
      const area = plan.decision.facilities.reduce((sum, f) => sum + f.area, 0);
      cumulative += area;
      breakdown.push({
        planId: plan.planId,
        projectId: plan.projectId,
        sharedWithProjectIds: [...plan.sharedWithProjectIds],
        areaM2: area,
        adoptedSurveyVersions: [...plan.decision.adoptedSurveyVersions.entries()].map(
          ([facilityId, surveyVersionId]) => ({ facilityId, surveyVersionId }),
        ),
      });
    }
    const parcel = state.parcels.get(parcelId);
    const totalQuadrat = parcel ? parcel.totalQuadrat : null;
    return {
      parcelId,
      totalQuadrat,
      cumulativeM2: cumulative,
      remainingM2: totalQuadrat == null ? null : totalQuadrat - cumulative,
      breakdown,
    };
  }

  // 单个在途方案的闸门评估：版本时效、空间冲突、可批面积。
  evaluatePlan(planId, state = this.state) {
    const plan = state.plans.get(planId);
    if (!plan) throw new DomainError('plan_not_found', '方案不存在', { planId });
    const parcel = state.parcels.get(plan.parcelId);
    const reasons = [];

    if (plan.status !== 'submitted') {
      reasons.push({ code: 'not_pending', message: '方案不在待审状态', status: plan.status });
    }

    // 图斑版本时效：报建后测绘精度/图纸发生变化，旧版本不得用于决定。
    const staleFacilities = [];
    for (const f of plan.facilities) {
      const survey = state.surveys.get(f.surveyId);
      if (survey.currentVersionId !== f.surveyVersionId) {
        staleFacilities.push({
          facilityId: f.facilityId,
          adoptedVersionId: f.surveyVersionId,
          currentVersionId: survey.currentVersionId,
        });
      }
    }
    if (staleFacilities.length > 0) {
      reasons.push({ code: 'survey_version_stale', message: '图斑版本已更新，须按新版本重报', staleFacilities });
    }

    // 空间冲突：与所有生效批准图斑逐一核对（共用设施同样不得重叠）。
    const conflicts = [];
    for (const approved of this.effectivePlans(state, plan.parcelId)) {
      for (const candidate of plan.facilities) {
        for (const adopted of approved.decision.facilities) {
          const overlap = intersectionArea(candidate.ring, adopted.ring);
          if (overlap > 0) {
            conflicts.push({
              code: 'overlap_approved',
              planId: approved.planId,
              a: candidate.facilityId,
              b: adopted.facilityId,
              overlapM2: overlap,
            });
          }
        }
      }
    }
    if (conflicts.length > 0) {
      reasons.push({ code: 'spatial_conflict', message: '与已批准图斑存在重叠', conflicts });
    }

    // 面积闸门：累计占用（含本方案）不得越过宗地许可边界。
    const candidateArea = plan.facilities.reduce((sum, f) => sum + f.area, 0);
    const current = this.cumulativeOccupancy(state, plan.parcelId);
    const projected = current.cumulativeM2 + candidateArea;
    if (projected > parcel.totalQuadrat) {
      reasons.push({
        code: 'over_quota',
        message: '累计占用将超过宗地许可面积',
        totalQuadratM2: parcel.totalQuadrat,
        cumulativeM2: current.cumulativeM2,
        requestedM2: candidateArea,
        projectedM2: projected,
        remainingM2: current.remainingM2,
      });
    }

    return {
      ok: reasons.length === 0,
      planId,
      candidateAreaM2: candidateArea,
      cumulativeBeforeM2: current.cumulativeM2,
      remainingBeforeM2: current.remainingM2,
      projectedM2: projected,
      reasons,
    };
  }

  // 联合审查：一次性核对宗地上所有在途方案，包括方案彼此之间的空间冲突、
  // 以及按提交顺序逐个放行时的累计面积（共用设施只计一次）。
  evaluateJointReview(parcelId) {
    const state = this.state;
    if (!state.parcels.has(parcelId)) {
      throw new DomainError('parcel_not_found', '宗地不存在', { parcelId });
    }
    const pending = [...state.plans.values()]
      .filter((plan) => plan.parcelId === parcelId && plan.status === 'submitted')
      .sort((a, b) => a.seq - b.seq);

    // 在途方案两两核对图斑冲突。
    const pendingConflicts = [];
    for (let i = 0; i < pending.length; i += 1) {
      for (let j = i + 1; j < pending.length; j += 1) {
        for (const fa of pending[i].facilities) {
          for (const fb of pending[j].facilities) {
            const overlap = intersectionArea(fa.ring, fb.ring);
            if (overlap > 0) {
              pendingConflicts.push({
                code: 'overlap_pending',
                planA: pending[i].planId,
                planB: pending[j].planId,
                a: fa.facilityId,
                b: fb.facilityId,
                overlapM2: overlap,
              });
            }
          }
        }
      }
    }

    // 模拟按提交顺序串行裁决：每放行一期，立即占用剩余空间。
    let cumulative = this.cumulativeOccupancy(state, parcelId).cumulativeM2;
    const total = state.parcels.get(parcelId).totalQuadrat;
    const sequence = pending.map((plan) => {
      const evaluation = this.evaluatePlan(plan.planId, state);
      const area = evaluation.candidateAreaM2;
      const crossPending = pendingConflicts.filter(
        (c) => c.planA === plan.planId || c.planB === plan.planId,
      );
      const ownBlockReasons = evaluation.reasons.filter((r) => r.code !== 'over_quota');
      const quotaBlocked = evaluation.reasons.some((r) => r.code === 'over_quota');
      let serialBlocked = false;
      if (crossPending.length > 0) ownBlockReasons.push({ code: 'spatial_conflict', conflicts: crossPending });

      let decision;
      if (ownBlockReasons.length > 0) {
        decision = 'blocked';
      } else if (cumulative + area > total) {
        serialBlocked = true;
        decision = 'blocked';
      } else {
        decision = 'approvable';
        cumulative += area; // 串行放行：本期占用后剩余空间才给下一期
      }
      return {
        planId: plan.planId,
        projectId: plan.projectId,
        phaseNo: plan.phaseNo,
        sharedWithProjectIds: [...plan.sharedWithProjectIds],
        approvalsReceived: plan.approvals.length,
        areaM2: area,
        decision,
        blockReasons: [
          ...ownBlockReasons,
          ...(quotaBlocked
            ? [{
                code: 'over_quota',
                cumulativeM2: evaluation.cumulativeBeforeM2,
                remainingM2: evaluation.remainingBeforeM2,
                requestedM2: area,
              }]
            : []),
          ...(serialBlocked && !quotaBlocked
            ? [{
                code: 'serial_cumulative_over_quota',
                message: '前序方案放行后，本期累计将超许可边界',
                serialCumulativeM2: cumulative + area,
                remainingM2: total - cumulative,
                requestedM2: area,
              }]
            : []),
        ],
      };
    });

    const summary = this.cumulativeOccupancy(state, parcelId);
    return {
      parcelId,
      totalQuadratM2: total,
      cumulativeM2: summary.cumulativeM2,
      remainingM2: summary.remainingM2,
      approvedBreakdown: summary.breakdown,
      pendingCount: pending.length,
      pendingConflicts,
      sequence,
    };
  }

  // 审批放行：必须两名不同审批人，且每次放行都按当前状态重新计算闸门。
  // 任一次放行时闸门不通过即驳回；两人都通过才形成批准，快照采用的图斑版本。
  approve(planId, approver) {
    requireId(planId, 'planId');
    requireId(approver, 'approver');
    const state = this.state;
    const plan = state.plans.get(planId);
    if (!plan) throw new DomainError('plan_not_found', '方案不存在', { planId });
    if (plan.status !== 'submitted') {
      throw new DomainError('not_pending', '方案不在待审状态', { planId, status: plan.status });
    }
    if (plan.approvals.includes(approver)) {
      throw new DomainError('duplicate_approver', '同一审批人不得重复计入', { planId, approver });
    }

    const evaluation = this.evaluatePlan(planId, state);
    const approvers = [...plan.approvals, approver];
    if (!evaluation.ok) {
      this.store.append('PlanRejected', {
        planId,
        approvers,
        reasons: evaluation.reasons,
      });
      return { outcome: 'rejected', planId, approvers, reasons: evaluation.reasons };
    }

    if (approvers.length < 2) {
      // 第一名审批人通过：暂存其放行意见，等待第二名，期间不占用任何面积。
      this.store.append('PlanPartialApproval', { planId, approver, approvers });
      return { outcome: 'awaiting_second_approver', planId, approvers };
    }

    const parcel = state.parcels.get(plan.parcelId);
    this.store.append('PlanApproved', {
      planId,
      approvers,
      facilities: plan.facilities,
      cumulativeBefore: evaluation.cumulativeBeforeM2,
      cumulativeAfter: evaluation.projectedM2,
      remainingBefore: evaluation.remainingBeforeM2,
      remainingAfter: parcel.totalQuadrat - evaluation.projectedM2,
    });
    return {
      outcome: 'approved',
      planId,
      approvers,
      cumulativeBeforeM2: evaluation.cumulativeBeforeM2,
      cumulativeAfterM2: evaluation.projectedM2,
      remainingAfterM2: parcel.totalQuadrat - evaluation.projectedM2,
      adoptedSurveyVersions: plan.facilities.map((f) => ({
        facilityId: f.facilityId,
        surveyVersionId: f.surveyVersionId,
      })),
    };
  }

  // 现场核验：实测图斑与批准图斑比对面积偏差与越界部分。
  recordVerification(planId, input) {
    requireId(planId, 'planId');
    const state = this.state;
    const plan = state.plans.get(planId);
    if (!plan) throw new DomainError('plan_not_found', '方案不存在', { planId });
    if (plan.status !== 'approved') {
      throw new DomainError('not_approved', '只有已批准方案可以现场核验', { planId });
    }
    const parcel = state.parcels.get(plan.parcelId);
    const tolerance = parcel.toleranceM2;
    const actuals = new Map();
    for (const item of input?.actuals ?? []) {
      const approved = plan.decision.facilities.find((f) => f.facilityId === item.facilityId);
      if (!approved) {
        throw new DomainError('facility_not_found', '核验设施不在批准方案中', { facilityId: item.facilityId });
      }
      if (!Array.isArray(item.ring) || item.ring.length < 3) {
        throw new DomainError('invalid_ring', '实测图斑环至少需要 3 个控制点', { facilityId: item.facilityId });
      }
      const ring = item.ring.map((pt) => [Number(pt[0]), Number(pt[1])]);
      const area = ringArea(ring);
      const beyond = outsideArea(ring, approved.ring);
      actuals.set(item.facilityId, {
        facilityId: item.facilityId,
        ring,
        actualAreaM2: area,
        approvedAreaM2: approved.area,
        areaDeviationM2: area - approved.area,
        outsideM2: beyond,
      });
    }

    // 未提交实测的设施按批准图斑计。
    for (const approved of plan.decision.facilities) {
      if (!actuals.has(approved.facilityId)) {
        actuals.set(approved.facilityId, {
          facilityId: approved.facilityId,
          ring: approved.ring,
          actualAreaM2: approved.area,
          approvedAreaM2: approved.area,
          areaDeviationM2: 0,
          outsideM2: 0,
        });
      }
    }

    const actualList = [...actuals.values()];
    const passed = actualList.every(
      (a) => Math.abs(a.areaDeviationM2) <= tolerance && a.outsideM2 <= tolerance,
    );
    this.store.append('VerificationRecorded', {
      planId,
      inspector: input?.inspector ?? null,
      passed,
      toleranceM2: tolerance,
      actuals: actualList,
    });
    return { outcome: passed ? 'passed' : 'rectification_required', planId, toleranceM2: tolerance, actuals: actualList };
  }

  submitRectification(planId, input = {}) {
    requireId(planId, 'planId');
    const state = this.state;
    const plan = state.plans.get(planId);
    if (!plan) throw new DomainError('plan_not_found', '方案不存在', { planId });
    if (!plan.verification || plan.verification.passed) {
      throw new DomainError('no_rectification_needed', '没有待整改的核验记录', { planId });
    }
    const latestActuals = this.#normalizeActuals(plan, input.actuals);
    this.store.append('RectificationSubmitted', {
      planId,
      note: input.note ?? null,
      actuals: latestActuals,
    });
    return this.state.plans.get(planId);
  }

  // 整改闭环：复测图斑回到批准范围内，且按实测面积重算宗地闸门，
  // 防止“批小建大”通过整改通道变相突破许可边界。
  resolveRectification(planId) {
    requireId(planId, 'planId');
    const state = this.state;
    const plan = state.plans.get(planId);
    if (!plan) throw new DomainError('plan_not_found', '方案不存在', { planId });
    if (!plan.rectificationOpen || plan.rectifications.length === 0) {
      throw new DomainError('no_open_rectification', '没有在办整改', { planId });
    }
    const parcel = state.parcels.get(plan.parcelId);
    const tolerance = parcel.toleranceM2;
    const rectification = plan.rectifications[plan.rectifications.length - 1];
    const reasons = [];

    for (const actual of rectification.actuals) {
      if (Math.abs(actual.areaDeviationM2) > tolerance) {
        reasons.push({
          code: 'area_deviation',
          facilityId: actual.facilityId,
          deviationM2: actual.areaDeviationM2,
          toleranceM2: tolerance,
        });
      }
      if (actual.outsideM2 > tolerance) {
        reasons.push({
          code: 'outside_approved_plot',
          facilityId: actual.facilityId,
          outsideM2: actual.outsideM2,
          toleranceM2: tolerance,
        });
      }
    }

    const actualPlanArea = rectification.actuals.reduce((sum, a) => sum + a.actualAreaM2, 0);
    const approvedPlanArea = plan.decision.facilities.reduce((sum, f) => sum + f.area, 0);
    const occupancy = this.cumulativeOccupancy(state, plan.parcelId);
    const projectedActual = occupancy.cumulativeM2 - approvedPlanArea + actualPlanArea;
    if (projectedActual > parcel.totalQuadrat) {
      reasons.push({
        code: 'over_quota_actual',
        message: '实测面积计入后宗地累计超许可边界，整改不能闭环',
        projectedM2: projectedActual,
        totalQuadratM2: parcel.totalQuadrat,
      });
    }

    const outcome = reasons.length === 0 ? 'closed' : 'failed';
    this.store.append('RectificationResolved', {
      planId,
      outcome,
      reasons,
      actuals: rectification.actuals,
    });
    return { outcome, planId, reasons };
  }

  #normalizeActuals(plan, inputActuals = []) {
    const byFacility = new Map(inputActuals.map((a) => [a.facilityId, a]));
    return plan.decision.facilities.map((approved) => {
      const item = byFacility.get(approved.facilityId);
      const ring = item
        ? item.ring.map((pt) => [Number(pt[0]), Number(pt[1])])
        : approved.ring.map((pt) => [...pt]);
      const area = ringArea(ring);
      return {
        facilityId: approved.facilityId,
        ring,
        actualAreaM2: area,
        approvedAreaM2: approved.area,
        areaDeviationM2: area - approved.area,
        outsideM2: outsideArea(ring, approved.ring),
      };
    });
  }
}

export { DomainError };
