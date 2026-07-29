const test = require('node:test');
const assert = require('node:assert/strict');

// session-key-hydration depends on browser globals (localStorage, secureStorageGet/Set/Remove).
// We mock them to test the logic.

const mockLocalStorage = {
  getItem: null,
  setItem: null,
  removeItem: null,
};

// Mock global browser APIs before requiring the module
global.localStorage = mockLocalStorage;
global.storedSessionKey = null;

const mockSecureStorageGet = null;
const mockSecureStorageSet = null;
const mockSecureStorageRemove = null;

// We need to set up the mocks before requiring the module
global.secureStorageGet = async (key) => {
  if (mockSecureStorageGet) return await mockSecureStorageGet(key);
  return null;
};
global.secureStorageSet = async (key, value) => {
  if (mockSecureStorageSet) return await mockSecureStorageSet(key, value);
  return false;
};
global.secureStorageRemove = async (key) => {
  if (mockSecureStorageRemove) return await mockSecureStorageRemove(key);
  return false;
};

const sessionKeyHydration = require('../public/lib/session-key-hydration');

test('SESSION_STORAGE_KEY is defined', () => {
  assert.equal(sessionKeyHydration.SESSION_STORAGE_KEY, 'miso.selectedSessionKey');
});

test('hydrateStoredSessionKey returns null when no key in storage', async () => {
  mockLocalStorage.getItem = () => null;

  await sessionKeyHydration.hydrateStoredSessionKey();
  assert.equal(global.storedSessionKey, null);
});

test('hydrateStoredSessionKey returns key from localStorage when available', async () => {
  mockLocalStorage.getItem = (key) => {
    if (key === 'miso.selectedSessionKey') return 'stored-session-key';
    return null;
  };

  await sessionKeyHydration.hydrateStoredSessionKey();
  assert.equal(global.storedSessionKey, 'stored-session-key');
});

test('hydrateStoredSessionKey returns key from SecureStorage when available', async () => {
  mockLocalStorage.getItem = () => null;
  global.secureStorageGet = async (key) => {
    if (key === 'miso.selectedSessionKey') return 'native-session-key';
    return null;
  };

  await sessionKeyHydration.hydrateStoredSessionKey();
  assert.equal(global.storedSessionKey, 'native-session-key');
});

test('hydrateStoredSessionKey prefers SecureStorage over localStorage', async () => {
  mockLocalStorage.getItem = (key) => {
    if (key === 'miso.selectedSessionKey') return 'local-key';
    return null;
  };
  global.secureStorageGet = async (key) => {
    if (key === 'miso.selectedSessionKey') return 'native-key';
    return null;
  };

  await sessionKeyHydration.hydrateStoredSessionKey();
  assert.equal(global.storedSessionKey, 'native-key');
});

test('persistStoredSessionKey stores in localStorage', async () => {
  let capturedKey, capturedValue;
  mockLocalStorage.setItem = (key, value) => {
    capturedKey = key;
    capturedValue = value;
  };

  await sessionKeyHydration.persistStoredSessionKey('my-session-key');
  assert.equal(capturedKey, 'miso.selectedSessionKey');
  assert.equal(capturedValue, 'my-session-key');
});

test('persistStoredSessionKey stores in SecureStorage when available', async () => {
  let capturedKey, capturedValue;
  mockLocalStorage.setItem = () => {};
  global.secureStorageSet = async (key, value) => {
    capturedKey = key;
    capturedValue = value;
    return true;
  };

  await sessionKeyHydration.persistStoredSessionKey('my-session-key');
  assert.equal(capturedKey, 'miso.selectedSessionKey');
  assert.equal(capturedValue, 'my-session-key');
});

test('clearAuthLocalState clears the session key', async () => {
  let capturedKey;
  mockLocalStorage.removeItem = (key) => {
    capturedKey = key;
  };

  await sessionKeyHydration.clearAuthLocalState();
  assert.equal(capturedKey, 'miso.selectedSessionKey');
});
