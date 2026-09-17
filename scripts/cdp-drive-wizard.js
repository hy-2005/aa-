/**
 * CDP driver: attach to the REAL app's onboarding window via the remote
 * debugging port and perform the exact user interaction that reportedly
 * kills it. If the renderer dies, the WebSocket closes — that's our
 * crash detector.
 *
 * Run after: electron . --remote-debugging-port=9222
 */
const http = require('http');
const WebSocket = require('ws');

const PORT = 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getTargets() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}/json/list`, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

async function main() {
  // Wait for the onboarding page target
  let target = null;
  for (let i = 0; i < 30; i++) {
    const targets = await getTargets().catch(() => []);
    target = targets.find((t) => t.url.includes('onboarding.html') && t.webSocketDebuggerUrl);
    if (target) break;
    await sleep(1000);
  }
  if (!target) {
    console.log('DRIVER: onboarding target not found');
    process.exit(1);
  }
  console.log('DRIVER: attached to', target.url);

  const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  let msgId = 0;
  const pending = new Map();

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const args = (msg.params.args || []).map((a) => a.value ?? a.description).join(' ');
      console.log(`RENDERER [${msg.params.type}]: ${args}`);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      console.log('RENDERER EXCEPTION:', JSON.stringify(d).slice(0, 500));
    }
  });
  ws.on('close', () => {
    console.log('DRIVER: !!! CDP CONNECTION CLOSED — RENDERER PROCESS DIED !!!');
    process.exit(2);
  });
  ws.on('error', (e) => console.log('DRIVER: ws error', e.message));

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++msgId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  await new Promise((r) => ws.on('open', r));
  await send('Runtime.enable');
  await send('Console.enable').catch(() => {});

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) {
      console.log('EVAL EXCEPTION:', JSON.stringify(r.result.exceptionDetails).slice(0, 500));
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await sleep(2000);
  console.log('DRIVER: step 1 — click Get Started');
  await evalJs(`document.getElementById('heroCtaBtn').click(); 'ok'`);

  await sleep(1000);
  console.log('DRIVER: step 2 — select openai-compatible');
  await evalJs(`(() => {
    const sel = document.getElementById('activeProvider');
    sel.value = 'openai-compatible';
    sel.dispatchEvent(new Event('change'));
    return sel.value;
  })()`);

  await sleep(500);
  console.log('DRIVER: step 3 — fill fields');
  await evalJs(`(() => {
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', {bubbles:true})); };
    set('openaiCompatKey', 'sk-driver-test-123');
    set('openaiCompatModel', 'deepseek-chat');
    set('openaiCompatBaseUrl', 'api.deepseek.com/v1');
    return 'filled';
  })()`);

  await sleep(500);
  console.log('DRIVER: step 4 — click Continue (real saveSettings IPC)');
  await evalJs(`document.getElementById('nextBtn').click(); 'clicked'`);

  // Watch for 30s: crash (ws close), timeout pill, or clean advance
  for (let s = 1; s <= 30; s++) {
    await sleep(1000);
    const pill = await evalJs(`(() => {
      const p = document.getElementById('keyStatus');
      const screen = document.querySelector('.screen.active');
      return { pill: p && p.style.display !== 'none' ? (p.textContent || '').trim() : null, screen: screen && screen.dataset.screen };
    })()`);
    if (s % 5 === 0 || (pill && pill.pill)) {
      console.log(`DRIVER ${s}s: screen=${pill && pill.screen} pill=${JSON.stringify(pill && pill.pill)}`);
    }
    if (pill && pill.screen && pill.screen !== 'apikey') {
      console.log(`DRIVER: ADVANCED to "${pill.screen}" — save path OK`);
      process.exit(0);
    }
  }
  console.log('DRIVER: still on apikey after 30s — see pill above');
  process.exit(0);
}

main().catch((e) => { console.log('DRIVER fatal:', e.message); process.exit(3); });
