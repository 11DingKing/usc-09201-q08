// 林下设施面积闸门 HTTP 接口：所有写操作落入不可变事件账本，
// 审查结果在请求时刻按事件流重新计算。

import http from 'node:http';
import { AreaGate, DomainError } from './core.mjs';

export function createServer({ gate = new AreaGate() } = {}) {
  const json = (response, status, body) => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(body));
  };

  const readBody = async (request) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (chunks.length === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new DomainError('invalid_json', '请求体不是合法 JSON');
    }
  };

  return http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const path = url.pathname;
    try {
      if (request.method === 'GET' && path === '/health') {
        json(response, 200, { status: 'ok' });
        return;
      }

      if (request.method === 'GET' && path === '/events') {
        json(response, 200, { events: [...gate.store] });
        return;
      }

      if (request.method === 'POST' && path === '/parcels') {
        json(response, 201, gate.registerParcel(await readBody(request)));
        return;
      }

      let match = path.match(/^\/parcels\/([^/]+)\/occupancy$/);
      if (request.method === 'GET' && match) {
        const state = gate.state;
        if (!state.parcels.has(match[1])) throw new DomainError('parcel_not_found', '宗地不存在', { parcelId: match[1] });
        json(response, 200, gate.cumulativeOccupancy(state, match[1]));
        return;
      }

      match = path.match(/^\/parcels\/([^/]+)\/joint-review$/);
      if (request.method === 'GET' && match) {
        json(response, 200, gate.evaluateJointReview(match[1]));
        return;
      }

      if (request.method === 'POST' && path === '/projects') {
        json(response, 201, gate.registerProject(await readBody(request)));
        return;
      }

      if (request.method === 'POST' && path === '/surveys') {
        json(response, 201, gate.registerSurvey(await readBody(request)));
        return;
      }

      match = path.match(/^\/surveys\/([^/]+)\/versions$/);
      if (request.method === 'POST' && match) {
        json(response, 201, gate.addSurveyVersion({ ...(await readBody(request)), surveyId: match[1] }));
        return;
      }

      if (request.method === 'POST' && path === '/plans') {
        json(response, 201, gate.submitPlan(await readBody(request)));
        return;
      }

      match = path.match(/^\/plans\/([^/]+)\/withdraw$/);
      if (request.method === 'POST' && match) {
        const body = await readBody(request);
        json(response, 200, gate.withdrawPlan(match[1], body.reason ?? null));
        return;
      }

      match = path.match(/^\/plans\/([^/]+)\/evaluation$/);
      if (request.method === 'GET' && match) {
        json(response, 200, gate.evaluatePlan(match[1]));
        return;
      }

      match = path.match(/^\/plans\/([^/]+)\/approvals$/);
      if (request.method === 'POST' && match) {
        const body = await readBody(request);
        const result = gate.approve(match[1], body.approver);
        json(response, result.outcome === 'rejected' ? 422 : 200, result);
        return;
      }

      match = path.match(/^\/plans\/([^/]+)\/verification$/);
      if (request.method === 'POST' && match) {
        const result = gate.recordVerification(match[1], await readBody(request));
        json(response, 200, result);
        return;
      }

      match = path.match(/^\/plans\/([^/]+)\/rectifications$/);
      if (request.method === 'POST' && match) {
        json(response, 201, gate.submitRectification(match[1], await readBody(request)));
        return;
      }

      match = path.match(/^\/plans\/([^/]+)\/rectification\/resolve$/);
      if (request.method === 'POST' && match) {
        json(response, 200, gate.resolveRectification(match[1]));
        return;
      }

      json(response, 404, { error: 'not_found' });
    } catch (error) {
      if (error instanceof DomainError) {
        json(response, 400, { error: error.code, message: error.message, details: error.details });
        return;
      }
      json(response, 500, { error: 'internal_error', message: error.message });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, '0.0.0.0', () => {
    console.log(`服务已启动：http://0.0.0.0:${port}`);
  });
}
