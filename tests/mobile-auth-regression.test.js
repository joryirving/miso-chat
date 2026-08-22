const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const loginHtmlPath = path.join(__dirname, '..', 'public', 'login.html');
const indexHtmlPath = path.join(__dirname, '..', 'public', 'index.html');
const authSessionPath = path.join(__dirname, '..', 'lib', 'auth-session.js');
const androidManifestPath = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'AndroidManifest.xml');

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

test('mobile OIDC start keeps deep-link handoff query intact', () => {
  const loginHtml = read(loginHtmlPath);

  assert.match(loginHtml, /const mobile = params\.get\('mobile'\) === '1';/);
  assert.match(loginHtml, /oidcTarget\.searchParams\.set\('return_to', returnTo\);/);
  assert.match(loginHtml, /if \(mobile\) oidcTarget\.searchParams\.set\('mobile', '1'\);/);
});

test('mobile callback flow still consumes temporary auth token and can recover', () => {
  const indexHtml = read(indexHtmlPath);

  assert.match(indexHtml, /apiUrl\('\/api\/mobile-auth\/consume'\)/);
  assert.match(indexHtml, /mobile_token/);
  assert.match(indexHtml, /recoverFromMobileAuthCallbackFailure/);
});

test('mobile auth token is not carried in any URL query string', () => {
  const authSessionJs = read(authSessionPath);

  // The OIDC callback must not put the token in the /auth/mobile-complete URL.
  assert.doesNotMatch(authSessionJs, /searchParams\.set\('token', token\)/);
  // The token is handed to the deep link via the URL fragment, which is never
  // sent to servers or retained in access logs.
  assert.match(authSessionJs, /fragment\.set\('mobile_token', \$\{JSON\.stringify\(token\)\}\)/);
  assert.match(authSessionJs, /appTarget\.toString\(\) \+ '#' \+ fragment\.toString\(\)/);
  // The webview reads the token from the fragment, not the query string.
  const indexHtml = read(indexHtmlPath);
  assert.match(indexHtml, /parseMobileCallbackHashParams/);
  assert.match(indexHtml, /hashParams\.get\('mobile_token'\)/);
});

test('auth flows persist session before redirect/response to avoid mobile login races', () => {
  const authSessionJs = read(authSessionPath);

  assert.match(authSessionJs, /function persistLoginSession\(req, cb\)/);
  assert.match(authSessionJs, /OIDC login session persist failed/);
  assert.match(authSessionJs, /Mobile auth session persist failed/);
});

test('android manifest keeps misochat deep-link callback intent filter', () => {
  const manifest = read(androidManifestPath);

  assert.match(manifest, /android:scheme="misochat"/);
  assert.match(manifest, /android:host="auth"/);
  assert.match(manifest, /android:pathPrefix="\/callback"/);
});
