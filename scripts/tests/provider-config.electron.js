const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, session } = require('electron');
const [phase, testDir] = process.argv.slice(2);
const root = path.join(__dirname, '..', '..');
const file = path.join(testDir, 'llm-providers.json');
const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
app.setPath('userData', testDir);
// Tests do not share log files with the user's running application.
const log = { info() {}, warn() {}, error() {}, debug() {} };
require.cache[require.resolve('../../src/core/logger')] = {
  exports: { createServiceLogger: () => log }
};

async function until(check, label) {
  for (let i = 0; i < 160; i++) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out: ' + label);
}
async function page(name) {
  const win = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(root, 'preload.js'), contextIsolation: true, nodeIntegration: false
  } });
  await win.loadFile(path.join(root, name));
  return win;
}
const evaluate = (win, expression) => win.webContents.executeJavaScript(expression);

async function run() {
  await app.whenReady();
  // The test pages require no remote resources or real cloud endpoints.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: /^https?:/.test(details.url) && !details.url.startsWith('http://127.0.0.1:') });
  });
  const main = await until(() => BrowserWindow.getAllWindows().find((win) =>
    win.webContents.getURL().endsWith('/index.html') && !win.webContents.isLoading()), 'main window');
  BrowserWindow.getAllWindows().forEach((win) => win.hide());
  const current = await evaluate(main, 'window.electronAPI.getSettings()');
  const configured = current.providers['openai-compatible'];
  assert.equal(current.activeProvider, 'openai-compatible');
  assert.equal(configured.apiKey, phase === 'save' ? 'regression-original' : 'regression-rotated');
  const baseUrl = configured.baseUrl;

  if (phase === 'save') {
    const result = await evaluate(main, `window.electronAPI.saveSettings({
      activeProvider: 'openai-compatible', providers: {
        'openai-compatible': { apiKey: 'regression-rotated' }
      }
    })`);
    assert.equal(result.success, true, result.error);
    assert.equal(read().providers['openai-compatible'].apiKey, 'regression-rotated');
    // Both adapters must initialize after speech compatibility globals exist.
    const OpenAIAdapter = require('../../src/services/llm/adapters/openai.adapter');
    assert.equal(new OpenAIAdapter({ config: { apiKey: 'fake-openai-key' } }).initialize(), true);
    assert.equal(global.URL, require('url').URL, 'Native URL must survive speech module loading');
    const badUrl = await evaluate(main, `window.electronAPI.saveSettings({
      activeProvider: 'openai-compatible', providers: { 'openai-compatible': { baseUrl: 'https://[invalid' } }
    })`);
    assert.equal(badUrl.success, false, 'Malformed Base URL must be rejected');
    const restored = await evaluate(main, `window.electronAPI.saveSettings({
      activeProvider: 'openai-compatible', providers: { 'openai-compatible': { baseUrl: ${JSON.stringify(baseUrl)} } }
    })`);
    assert.equal(restored.success, true, restored.error);
  }
  const connection = await evaluate(main, 'window.electronAPI.testGeminiConnection()');
  assert.equal(connection.success, true, connection.error);
  assert.equal(connection.response, 'OK');

  const settings = await page('settings.html');
  await until(() => evaluate(settings, `document.getElementById('openaiCompatKey').value === 'regression-rotated'`), 'settings hydration');
  if (phase === 'save') {
    // A stale/empty hidden field must not be sent by unrelated blur events.
    await evaluate(settings, `(() => {
      document.getElementById('openaiKey').value = '';
      document.getElementById('windowGap').dispatchEvent(new Event('blur'));
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(read().providers.openai.apiKey, 'fake-openai-key');
    // Editing only the model must keep the already saved key and endpoint.
    await evaluate(settings, `(() => {
      document.getElementById('openaiCompatKey').value = '';
      const model = document.getElementById('openaiCompatModel');
      model.value = 'edited-model'; model.dispatchEvent(new Event('change'));
    })()`);
    await until(() => read().providers['openai-compatible'].model === 'edited-model', 'partial model save');
    assert.equal(read().providers['openai-compatible'].apiKey, 'regression-rotated');
    assert.equal(read().providers['openai-compatible'].baseUrl, baseUrl);
    await evaluate(settings, `(() => {
      document.getElementById('openaiCompatKey').value = 'regression-rotated';
      document.getElementById('testLlmConnection').click();
    })()`);
    await until(() => evaluate(settings, `document.getElementById('llmConnectionStatus').textContent.includes('连接成功')`), 'settings connection button');
    // Switching to another configured provider needs no full form snapshot.
    const switched = await evaluate(main, `window.electronAPI.saveSettings({ activeProvider: 'openai' })`);
    assert.equal(switched.success, true, switched.error);
    assert.equal(read().activeProvider, 'openai');
    await evaluate(main, `window.electronAPI.saveSettings({ activeProvider: 'openai-compatible' })`);
  } else {
    assert.equal(await evaluate(settings, `document.getElementById('openaiCompatModel').value`), 'edited-model');
  }

  const wizard = await page('onboarding.html');
  await until(() => evaluate(wizard, `document.getElementById('openaiCompatKey').value === 'regression-rotated'`), 'wizard hydration');
  assert.equal(await evaluate(wizard, `document.getElementById('activeProvider').value`), 'openai-compatible');
  assert.equal(await evaluate(wizard, `document.getElementById('openaiCompatModel').value`), 'edited-model');
  assert.equal(await evaluate(wizard, `document.getElementById('openaiCompatBaseUrl').value`), baseUrl);
  await evaluate(wizard, `document.getElementById('nextBtn').click()`);
  await until(() => evaluate(wizard, `document.querySelector('.screen.active').dataset.screen === 'apikey'`), 'wizard API step');
  await evaluate(wizard, `document.getElementById('nextBtn').click()`);
  await until(() => evaluate(wizard, `document.querySelector('.screen.active').dataset.screen === 'speech'`), 'wizard save and continue');
  assert.equal(read().providers.openai.apiKey, 'fake-openai-key');
  assert.equal(read().providers.gemini.apiKey, 'fake-gemini-key');
  assert.equal(read().providers['openai-compatible'].apiKey, 'regression-rotated');
  console.log('CONFIG_PHASE_OK=' + phase);
  app.exit(0);
}
require('../../main.js');
run().catch((error) => { console.error(error.stack); app.exit(1); });
