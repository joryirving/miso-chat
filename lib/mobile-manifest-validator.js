/**
 * Mobile OTA Manifest Validator
 *
 * Validates update-manifest.json from GitHub releases before serving to clients.
 * Checks: schema, tag/version/channel consistency, asset host/path trust,
 * and required digest/signature verification on each channel.
 */

const { createHash } = require('crypto');
const { URL } = require('url');

// Sync helpers in this module (digest checks live server-side). The browser
// client uses SubtleCrypto directly in public/mobile/update-manager.js.

// ---- Constants ----

const REQUIRED_TOP_LEVEL_FIELDS = ['version', 'tag'];
const REQUIRED_CHANNEL_FIELDS = ['version', 'bundleUrl', 'digest', 'digestAlgorithm'];
const SUPPORTED_DIGEST_ALGORITHMS = ['sha-256', 'sha384', 'sha512'];

// Default trusted release host — matches MOBILE_UPDATE_REPO_OWNER/NAME pattern
function defaultReleaseHost(repoOwner, repoName) {
  return `github.com/${repoOwner}/${repoName}`;
}

// ---- Schema Validation ----

/**
 * Validate that the manifest conforms to the expected schema.
 * Returns { valid: true } or { valid: false, errors: [...] }.
 *
 * Each channel MUST include a supported digestAlgorithm AND a non-empty digest,
 * so a "no digest = best-effort install" cannot silently occur.
 */
function validateSchema(manifest) {
  const errors = [];

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { valid: false, errors: ['Manifest must be a JSON object'] };
  }

  // Top-level required fields
  for (const field of REQUIRED_TOP_LEVEL_FIELDS) {
    if (!(field in manifest) || typeof manifest[field] !== 'string' || manifest[field].length === 0) {
      errors.push(`Missing or invalid top-level field: "${field}"`);
    }
  }

  // Channels must be an object with at least one channel containing required fields
  if (!manifest.channels || typeof manifest.channels !== 'object' || Array.isArray(manifest.channels)) {
    errors.push('Missing or invalid "channels" object');
  } else {
    const channelKeys = Object.keys(manifest.channels);
    if (channelKeys.length === 0) {
      errors.push('"channels" object must contain at least one channel');
    }

    for (const chName of channelKeys) {
      const ch = manifest.channels[chName];
      if (!ch || typeof ch !== 'object') {
        errors.push(`Channel "${chName}" must be an object`);
        continue;
      }
      for (const field of REQUIRED_CHANNEL_FIELDS) {
        if (!(field in ch) || typeof ch[field] !== 'string' || ch[field].length === 0) {
          errors.push(`Channel "${chName}" missing or invalid required field: "${field}"`);
        }
      }
      if (ch && typeof ch === 'object' && ch.digestAlgorithm
          && !SUPPORTED_DIGEST_ALGORITHMS.includes(ch.digestAlgorithm)) {
        errors.push(`Unsupported digest algorithm in channel "${chName}": "${ch.digestAlgorithm}"`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---- Tag/Version Consistency ----

/**
 * Verify that the release tag matches the manifest version/tag.
 */
function validateTagConsistency(manifest, releaseTagName) {
  const errors = [];

  if (!releaseTagName || typeof releaseTagName !== 'string') {
    return { valid: true, errors }; // Cannot verify without release tag
  }

  const normalizedRelease = normalizeVersion(releaseTagName);
  const manifestVersion = normalizeVersion(manifest.version);
  const manifestTag = normalizeVersion(manifest.tag);

  if (manifestVersion && normalizedRelease !== manifestVersion) {
    errors.push(`Release tag "${releaseTagName}" does not match manifest version "${manifest.version}"`);
  }

  if (manifestTag && normalizedRelease !== normalizeVersion(manifestTag)) {
    errors.push(`Release tag "${releaseTagName}" does not match manifest tag "${manifest.tag}"`);
  }

  // Cross-check: all channels should reference versions >= manifest version
  if (manifest.channels) {
    for (const [chName, ch] of Object.entries(manifest.channels)) {
      const chVersion = normalizeVersion(ch.version);
      if (chVersion && compareVersions(chVersion, manifestVersion) < 0) {
        errors.push(`Channel "${chName}" version "${ch.version}" is older than manifest version "${manifest.version}"`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---- Asset Host/Path Validation ----

/**
 * Validate that bundleUrl and apkUrl point to trusted hosts (the release repo).
 */
function validateAssetHosts(manifest, repoOwner, repoName) {
  const errors = [];
  const trustedHost = defaultReleaseHost(repoOwner, repoName);

  function checkUrl(url, fieldName) {
    if (!url || typeof url !== 'string') return;
    try {
      const parsed = new URL(url);
      const expectedHostname = trustedHost.split('/')[0];
      if (parsed.hostname !== expectedHostname) {
        errors.push(`${fieldName} points to untrusted host: ${parsed.hostname}`);
        return;
      }
      // Expected path prefix: /{owner}/{repo}/releases/download/
      const parts = trustedHost.split('/');
      const expectedPathPrefix = '/' + parts[1] + '/' + parts[2] + '/releases/download/';
      if (!parsed.pathname.startsWith(expectedPathPrefix)) {
        errors.push(`${fieldName} path does not match release download pattern`);
      }
    } catch {
      errors.push(`${fieldName} is not a valid URL`);
    }
  }

  // Check top-level bundleUrl if present
  if (manifest.bundleUrl) {
    checkUrl(manifest.bundleUrl, 'bundleUrl');
  }

  // Check each channel's URLs
  if (manifest.channels) {
    for (const [chName, ch] of Object.entries(manifest.channels)) {
      if (ch.bundleUrl) checkUrl(ch.bundleUrl, `channels.${chName}.bundleUrl`);
      if (ch.apkUrl) checkUrl(ch.apkUrl, `channels.${chName}.apkUrl`);
      if (ch.aabUrl) checkUrl(ch.aabUrl, `channels.${chName}.aabUrl`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---- Digest Verification ----

/**
 * Verify the digest of a given payload against the manifest's recorded digest.
 * Returns { valid: true } ONLY when the algorithm is supported, an expected
 * digest was provided, and the computed digest matches.
 *
 * Critically: when the manifest/channel declares no digestAlgorithm (or no
 * digest), this function returns { valid: false } — refusing to silently
 * accept unverified payloads. Callers must treat that as "skip the install".
 */
function verifyDigest(manifestOrChannel, payload, expectedDigest) {
  const errors = [];

  const algorithm = manifestOrChannel && manifestOrChannel.digestAlgorithm;
  if (!algorithm || !SUPPORTED_DIGEST_ALGORITHMS.includes(algorithm)) {
    return {
      valid: false,
      errors: ['No supported digestAlgorithm on manifest/channel; refusing to install unverified payload'],
    };
  }

  if (!expectedDigest || typeof expectedDigest !== 'string') {
    return { valid: false, errors: ['Expected digest not provided for verification'] };
  }

  // Normalize algorithm name (e.g. "sha256" -> "sha256" supported; we
  // canonicalize to one supported by Node's crypto and by SubtleCrypto).
  let algo = algorithm;
  if (algo === 'sha256') algo = 'sha-256';

  const hash = createHash(algo).update(payload).digest('hex');

  // Normalize both digests for comparison (strip "sha256:" prefixes if present)
  const normalizedExpected = expectedDigest.replace(/^[a-z0-9]+:/i, '').toLowerCase();
  const normalizedActual = hash.toLowerCase();

  if (normalizedExpected !== normalizedActual) {
    errors.push(`Digest mismatch: expected ${normalizedExpected}, got ${normalizedActual}`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Convenience: verify a channel's payload against the channel's own
 * digestAlgorithm + digest fields. Same semantics as verifyDigest, just
 * reading the algorithm and digest from the channel object itself.
 */
function verifyChannelDigest(channel, payload) {
  if (!channel || typeof channel !== 'object') {
    return { valid: false, errors: ['Channel is missing'] };
  }
  return verifyDigest(channel, payload, channel.digest);
}

// ---- Version Comparison (mirrors client logic) ----

function normalizeVersion(v) {
  return String(v || '0.0.0').replace(/^v/, '');
}

function compareVersions(v1, v2) {
  const a = normalizeVersion(v1).split('.').map(Number);
  const b = normalizeVersion(v2).split('.').map(Number);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = Number.isFinite(a[i]) ? a[i] : 0;
    const y = Number.isFinite(b[i]) ? b[i] : 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

// ---- Full Validation Pipeline ----

/**
 * Run all validation checks on a manifest.
 * @param {Object} manifest - Parsed update-manifest.json
 * @param {Object} options
 * @param {string} [options.releaseTagName] - GitHub release tag_name for consistency check
 * @param {string} [options.repoOwner] - Repo owner for host validation
 * @param {string} [options.repoName] - Repo name for host validation
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
function validateManifest(manifest, options = {}) {
  const { releaseTagName, repoOwner, repoName } = options;
  const allErrors = [];

  // 1. Schema check (strict — must pass; this now requires digestAlgorithm
  //    AND digest on every channel)
  const schemaResult = validateSchema(manifest);
  if (!schemaResult.valid) {
    allErrors.push(...schemaResult.errors);
    return { valid: false, errors: allErrors, warnings: [] };
  }

  // 2. Tag/version consistency (strict for release-tagged requests)
  if (releaseTagName) {
    const tagResult = validateTagConsistency(manifest, releaseTagName);
    if (!tagResult.valid) {
      allErrors.push(...tagResult.errors);
    }
  }

  // 3. Asset host validation (strict when repo info available)
  if (repoOwner && repoName) {
    const hostResult = validateAssetHosts(manifest, repoOwner, repoName);
    if (!hostResult.valid) {
      allErrors.push(...hostResult.errors);
    }
  }

  return { valid: allErrors.length === 0, errors: allErrors, warnings: [] };
}

module.exports = {
  validateSchema,
  validateTagConsistency,
  validateAssetHosts,
  verifyDigest,
  verifyChannelDigest,
  validateManifest,
  normalizeVersion,
  compareVersions,
  SUPPORTED_DIGEST_ALGORITHMS,
};
