// Runs the real Electron app twice against a local API and isolated user data.
// No user credentials, cloud requests, audio probes, or model downloads.
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

async function main() {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bishi-provider-test-'));
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'local-test', object: 'chat.completion', choices: [
        { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }
      ] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  fs.writeFileSync(path.join(testDir, '.env'), 'SPEECH_PROVIDER=azure\nAZURE_SPEECH_KEY=\nAZURE_SPEECH_REGION=\n');
  fs.writeFileSync(path.join(testDir, '.opencluely-firstrun-completed'), 'test');
  fs.writeFileSync(path.join(testDir, 'llm-providers.json'), JSON.stringify({
    schemaVersion: 2, activeProvider: 'openai-compatible', providers: {
      gemini: { apiKey: 'fake-gemini-key', model: 'test-gemini' },
      openai: { apiKey: 'fake-openai-key', model: 'test-openai' },
      'openai-compatible': { apiKey: 'regression-original', model: 'test-model', baseUrl }
    }
  }));
  try {
    // Development .env migration must use the same path startup resolved.
    const legacyDir = path.join(testDir, 'legacy');
    fs.mkdirSync(legacyDir);
    const legacyEnv = path.join(testDir, 'legacy.env');
    fs.writeFileSync(legacyEnv, 'GEMINI_API_KEY=fake-legacy-key\nGEMINI_MODEL=test-legacy\n');
    const log = { info() {}, warn() {}, error() {}, debug() {} };
    require.cache[require.resolve('../src/core/logger')] = { exports: { createServiceLogger: () => log } };
    const store = require('../src/services/llm/providers.store');
    store.init({ userDataDir: legacyDir, envPath: legacyEnv });
    assert.equal(store.load().providers.gemini.apiKey, 'fake-legacy-key');
    store.init({ userDataDir: legacyDir, envPath: legacyEnv });
    assert.equal(store.load().providers.gemini.model, 'test-legacy');
    console.log('PASS: startup .env migration and reload');
    for (const phase of ['save', 'restart']) {
      await new Promise((resolve, reject) => {
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        const child = spawn(require('electron'), [path.join(__dirname, 'tests', 'provider-config.electron.js'), phase, testDir], {
          cwd: path.join(__dirname, '..'), env, windowsHide: true
        });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk; });
        child.stderr.on('data', (chunk) => { output += chunk; });
        const timeout = setTimeout(() => { child.kill(); reject(new Error('Electron regression test timed out: ' + phase)); }, 45000);
        child.on('error', reject);
        child.on('exit', (code) => {
          clearTimeout(timeout);
          if (code !== 0 || !output.includes('CONFIG_PHASE_OK=' + phase)) {
            reject(new Error('Electron phase failed: ' + phase + '\n' + output.slice(-6000)));
          } else {
            console.log('PASS: ' + phase);
            resolve();
          }
        });
      });
    }
    assert(requests.length >= 3, 'Both reload and restart must reach the local API');
    for (const request of requests) {
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.auth, 'Bearer regression-rotated');
      assert(['test-model', 'edited-model'].includes(request.body.model));
    }
    console.log('PASS: saved credentials, UI edits, onboarding, runtime reload, restart, and local API requests');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
