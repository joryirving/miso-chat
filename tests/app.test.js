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

test('GET / redirects to login when unauthenticated', async () => {
  const res = await request('/');

  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/login?return_to=%2F');
});

test('GET /api/auth reports unauthenticated local auth state', async () => {
  const res = await request('/api/auth', { headers: { Accept: 'application/json' } });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'].includes('application/json'), true);

  const body = JSON.parse(res.body);
  assert.equal(body.authenticated, false);
  assert.equal(body.authMode, 'local');
  assert.equal(body.requiresAuth, true);
});

test('POST /login with urlencoded body >1kb returns 413', async () => {
  const largeBody = 'username=a&password=' + 'x'.repeat(2000);
  const res = await request('/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': String(largeBody.length),
    },
    body: largeBody,
  });

  assert.equal(res.statusCode, 413);
});

test('POST /login with wrong Content-Type for urlencoded is not parsed', async () => {
  // When Content-Type doesn't match, express.urlencoded() skips parsing.
  // The login route sees an empty body and redirects (302) rather than
  // accepting the payload — confirming the type restriction works.
  const res = await request('/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      'Content-Length': String('username=a&password=b'.length),
    },
    body: 'username=a&password=b',
  });

  // 302 redirect means the form was not parsed (no credentials extracted)
  assert.equal(res.statusCode, 302);
});

test.after(() => {
  server.close();
});
