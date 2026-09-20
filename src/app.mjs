import {
  createInitialState,
  registerParcel,
  registerProject,
  submitSurveyVersion,
  markSurveySuperseded,
  invalidateSurveyVersion,
  submitPlan,
  withdrawPlan,
  evaluatePlan,
  decidePlan,
  inspectOnSite,
  openRectification,
  closeRectification,
  parcelLedger,
} from './domain/gate.mjs';
import { GateError } from './domain/errors.mjs';

export function createApp() {
  const state = createInitialState();

  const commands = {
    'parcel.register': (payload) => registerParcel(state, payload),
    'project.register': (payload) => registerProject(state, payload),
    'survey.submit': (payload) => submitSurveyVersion(state, payload),
    'survey.supersede': (payload) => markSurveySuperseded(state, payload.surveyVersionId),
    'survey.invalidate': (payload) =>
      invalidateSurveyVersion(state, payload.surveyVersionId, payload.reason),
    'plan.submit': (payload) => submitPlan(state, payload),
    'plan.withdraw': (payload) => withdrawPlan(state, payload),
    'plan.evaluate': (payload) => evaluatePlan(state, payload.planId),
    'plan.decide': (payload) => decidePlan(state, payload),
    'inspection.record': (payload) => inspectOnSite(state, payload),
    'rectification.open': (payload) => openRectification(state, payload),
    'rectification.close': (payload) => closeRectification(state, payload),
    'parcel.ledger': (payload) => parcelLedger(state, payload.parcelId),
  };

  function execute(command, payload = {}) {
    const handler = commands[command];
    if (!handler) {
      throw new GateError('unknown_command', `未知命令：${command}`);
    }
    return handler(payload);
  }

  return { state, execute };
}
