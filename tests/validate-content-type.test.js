const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.AUTH_MODE = 'local';
process.env.LOCAL_USERS = 'admin:password123';
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-at-least-32-chars';

const { app, server } = require('../server');

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      const req = http.request({
        hostname: '127.0.0.1',
        port: address.port,
        path,
        method: options.method || 'GET',
        headers: options.headers || {},
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          listener.close(() => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
        });
      });

      req.on('error', (err) => {
        listener.close(() => reject(err));
      });

      if (options.body) req.write(options.body);
      req.end();
    });

    listener.on('error', reject);
  });
}

test('POST /api/sessions with application/json is accepted', async () => {
  const res = await request('/api/sessions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(JSON.stringify({ name: 'test' }).length),
    },
    body: JSON.stringify({ name: 'test' }),
  });

  // May return 401 (unauthenticated) or other status, but not 415
  assert.notEqual(res.statusCode, 415);
});

test('POST /api/sessions with text/plain is rejected with 415', async () => {
  const res = await request('/api/sessions', {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      'Content-Length': String('hello world'.length),
    },
    body: 'hello world',
  });

  assert.equal(res.statusCode, 415);
});

test('POST /api/sessions with application/json; charset=utf-8 is accepted', async () => {
  const res = await request('/api/sessions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(JSON.stringify({ name: 'test' }).length),
    },
    body: JSON.stringify({ name: 'test' }),
  });

  // May return 401 (unauthenticated) or other status, but not 415
  assert.notEqual(res.statusCode, 415);
});

test('GET /api/sessions is not validated (no body)', async () => {
  const res = await request('/api/sessions');

  // GET requests are not validated — may return 200, 302, or 401
  assert.ok(res.statusCode === 200 || res.statusCode === 302 || res.statusCode === 401);
});

test('DELETE /api/sessions/:id is not validated (no body)', async () => {
  const res = await request('/api/sessions/test-id', {
    method: 'DELETE',
  });

  // DELETE requests are not validated — may return various statuses
  assert.ok(res.statusCode !== 415);
});

test('POST /login with application/x-www-form-urlencoded is accepted', async () => {
  const res = await request('/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': String('username=a&password=b'.length),
    },
    body: 'username=a&password=b',
  });

  // May redirect (302) or return other status, but not 415
  assert.notEqual(res.statusCode, 415);
});

test('POST /login with application/json is rejected with 415', async () => {
  const res = await request('/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(JSON.stringify({ username: 'a' }).length),
    },
    body: JSON.stringify({ username: 'a' }),
  });

  assert.equal(res.statusCode, 415);
});

test('PUT /api/sessions with application/json is accepted', async () => {
  const res = await request('/api/sessions/test-id', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(JSON.stringify({ name: 'updated' }).length),
    },
    body: JSON.stringify({ name: 'updated' }),
  });

  // May return various statuses, but not 415
  assert.notEqual(res.statusCode, 415);
});

test('PATCH /api/sessions with text/plain is rejected with 415', async () => {
  const res = await request('/api/sessions/test-id', {
    method: 'PATCH',
    headers: {
      'Content-Type': 'text/plain',
      'Content-Length': String('some data'.length),
    },
    body: 'some data',
  });

  assert.equal(res.statusCode, 415);
});

test.after(() => {
  server.close();
});
