const test = require('node:test');
const assert = require('node:assert/strict');

// secure-storage depends on browser globals (isNativeCapacitor, window.Capacitor.Plugins).
// We mock them to test the wrapper logic.

const mockSecureStoragePlugin = {
  get: null,
  set: null,
  remove: null,
};

// Mock global browser APIs before requiring the module
global.isNativeCapacitor = () => true;
global.window = {
  Capacitor: {
    Plugins: {
      SecureStorage: mockSecureStoragePlugin,
    },
  },
};

const secureStorage = require('../public/lib/secure-storage');

test('secureStorageGet returns value from SecureStorage', async () => {
  mockSecureStoragePlugin.get = () => Promise.resolve({ value: 'secret' });

  const result = await secureStorage.secureStorageGet('myKey');
  assert.equal(result, 'secret');
});

test('secureStorageGet returns null when key not found', async () => {
  mockSecureStoragePlugin.get = () => Promise.resolve({ value: null });

  const result = await secureStorage.secureStorageGet('missingKey');
  assert.equal(result, null);
});

test('secureStorageGet returns null on error', async () => {
  mockSecureStoragePlugin.get = () => Promise.reject(new Error('storage error'));

  const result = await secureStorage.secureStorageGet('errorKey');
  assert.equal(result, null);
});

test('secureStorageSet calls SecureStorage.set with key and value', async () => {
  let capturedKey, capturedValue;
  mockSecureStoragePlugin.set = (opts) => {
    capturedKey = opts.key;
    capturedValue = opts.value;
    return Promise.resolve();
  };

  await secureStorage.secureStorageSet('myKey', 'myValue');
  assert.equal(capturedKey, 'myKey');
  assert.equal(capturedValue, 'myValue');
});

test('secureStorageSet returns true on success', async () => {
  mockSecureStoragePlugin.set = () => Promise.resolve();

  const result = await secureStorage.secureStorageSet('myKey', 'myValue');
  assert.equal(result, true);
});

test('secureStorageSet returns false on error', async () => {
  mockSecureStoragePlugin.set = () => Promise.reject(new Error('storage error'));

  const result = await secureStorage.secureStorageSet('myKey', 'myValue');
  assert.equal(result, false);
});

test('secureStorageRemove calls SecureStorage.remove with key', async () => {
  let capturedKey;
  mockSecureStoragePlugin.remove = (opts) => {
    capturedKey = opts.key;
    return Promise.resolve();
  };

  await secureStorage.secureStorageRemove('myKey');
  assert.equal(capturedKey, 'myKey');
});

test('secureStorageGet returns null when not on native platform', async () => {
  global.isNativeCapacitor = () => false;

  // Re-require to pick up the new mock
  delete require.cache[require.resolve('../public/lib/secure-storage')];
  const ss = require('../public/lib/secure-storage');

  const result = await ss.secureStorageGet('myKey');
  assert.equal(result, null);

  // Restore for other tests
  global.isNativeCapacitor = () => true;
});
