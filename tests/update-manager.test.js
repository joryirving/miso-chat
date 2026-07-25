const test = require('node:test');
const assert = require('node:assert/strict');

const { compareVersions, getManifestUrlFromRelease } = require('../lib/update-manager');

test('compareVersions returns -1 when v1 < v2', () => {
  assert.equal(compareVersions('1.0.0', '2.0.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.1.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1);
});

test('compareVersions returns 1 when v1 > v2', () => {
  assert.equal(compareVersions('2.0.0', '1.0.0'), 1);
  assert.equal(compareVersions('1.1.0', '1.0.0'), 1);
  assert.equal(compareVersions('1.0.1', '1.0.0'), 1);
});

test('compareVersions returns 0 when versions are equal', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('2.3.4', '2.3.4'), 0);
});

test('compareVersions handles leading v prefix', () => {
  assert.equal(compareVersions('v1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0', 'v1.0.0'), 0);
  assert.equal(compareVersions('v2.0.0', 'v1.0.0'), 1);
});

test('compareVersions handles missing parts', () => {
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(compareVersions('1', '1.0.0'), 0);
});

test('compareVersions handles non-numeric parts', () => {
  assert.equal(compareVersions('1.0.alpha', '1.0.0'), 0);
});

test('getManifestUrlFromRelease returns null for invalid input', () => {
  assert.equal(getManifestUrlFromRelease(null), null);
  assert.equal(getManifestUrlFromRelease(undefined), null);
  assert.equal(getManifestUrlFromRelease({}), null);
  assert.equal(getManifestUrlFromRelease({ assets: [] }), null);
});

test('getManifestUrlFromRelease returns manifest URL when present', () => {
  const release = {
    assets: [
      { name: 'update-manifest.json', browser_download_url: 'https://example.com/manifest.json' },
      { name: 'other-asset.zip', browser_download_url: 'https://example.com/other.zip' },
    ],
  };
  assert.equal(getManifestUrlFromRelease(release), 'https://example.com/manifest.json');
});

test('getManifestUrlFromRelease returns null when manifest not found', () => {
  const release = {
    assets: [
      { name: 'other-asset.zip', browser_download_url: 'https://example.com/other.zip' },
    ],
  };
  assert.equal(getManifestUrlFromRelease(release), null);
});
