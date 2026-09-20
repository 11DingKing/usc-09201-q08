import http from 'node:http';
import { createApp } from './app.mjs';
import { GateError } from './domain/errors.mjs';

export function createServer(app = createApp()) {
  return http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }

    if (request.method === 'POST' && request.url === '/api/commands') {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1_000_000) request.destroy();
      });
      request.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(body || '{}');
        } catch {
          sendJson(response, 400, { error: 'invalid_json' });
          return;
        }
        const { command, payload } = parsed;
        if (!command) {
          sendJson(response, 400, { error: 'missing_command' });
          return;
        }
        try {
          const result = app.execute(command, payload ?? {});
          sendJson(response, 200, { ok: true, command, result });
        } catch (error) {
          if (error instanceof GateError) {
            sendJson(response, 422, {
              ok: false,
              command,
              error: error.code,
              message: error.message,
              details: error.details,
            });
            return;
          }
          sendJson(response, 500, { ok: false, error: 'internal_error' });
        }
      });
      return;
    }

    sendJson(response, 404, { error: 'not_found' });
  });
}

function sendJson(response, status, data) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, '0.0.0.0', () => {
    console.log(`服务已启动：http://0.0.0.0:${port}`);
  });
}
