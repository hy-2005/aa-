/** Repro attempt with REAL input: keystrokes + IME composition in the wizard inputs. */
const http = require('http');
const WebSocket = require('ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getTargets() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9222/json/list', (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

async function main() {
  let target = null;
  for (let i = 0; i < 15; i++) {
    const targets = await getTargets().catch(() => []);
    target = targets.find((t) => t.url.includes('onboarding.html') && t.webSocketDebuggerUrl);
    if (target) break;
    await sleep(1000);
  }
  if (!target) { console.log('NO TARGET — renderer dead before attach'); process.exit(2); }

  const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  let msgId = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === 'Runtime.exceptionThrown') {
      console.log('RENDERER EXCEPTION:', JSON.stringify(msg.params.exceptionDetails).slice(0, 300));
    }
  });
  ws.on('close', () => { console.log('!!! CDP CLOSED — RENDERER DIED DURING INPUT !!!'); process.exit(2); });
  ws.on('error', (e) => console.log('ws error', e.message));

  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++msgId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params }));
  });
  await new Promise((r) => ws.on('open', r));
  await send('Runtime.enable');
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const key = (type, text, code, key_, keyCode) =>
    send('Input.dispatchKeyEvent', { type, text: text || undefined, key: key_, code: code || 'KeyA', windowsVirtualKeyCode: keyCode || 65, nativeVirtualKeyCode: keyCode || 65 });

  // Navigate to apikey screen fresh
  const screen = await evalJs(`document.querySelector('.screen.active').dataset.screen`);
  console.log('current screen:', screen);
  if (screen !== 'apikey') {
    // restart-ish: just go back to apikey if possible via back button, else run flow
    await evalJs(`(() => {
      document.getElementById('heroCtaBtn').click();
      const sel = document.getElementById('activeProvider');
      sel.value = 'openai-compatible';
      sel.dispatchEvent(new Event('change'));
      return 'reset';
    })()`);
    await sleep(300);
  }

  // Focus the baseUrl input and clear it
  console.log('TEST: focusing baseUrl input');
  await evalJs(`(() => {
    const el = document.getElementById('openaiCompatBaseUrl');
    el.value = ''; el.focus(); return document.activeElement.id;
  })()`);

  // 1) real ASCII keystrokes, one by one
  console.log('TEST: typing "api.deepseek.com/v1" via real key events');
  const text = 'api.deepseek.com/v1';
  for (const ch of text) {
    await key('keyDown', ch, 'KeyA', ch, 65);
    await key('keyUp', ch, 'KeyA', ch, 65);
    await sleep(15);
  }
  let v = await evalJs(`document.getElementById('openaiCompatBaseUrl').value`);
  console.log('value after keystrokes:', JSON.stringify(v));

  // 2) IME composition flow (what a Chinese IME does)
  console.log('TEST: IME composition events (imeSetComposition + insertText)');
  try {
    await send('Input.imeSetComposition', { text: 'api.deepseek', selectionStart: 12, selectionEnd: 12 });
    await sleep(200);
    await send('Input.imeSetComposition', { text: 'api.deepseek.com', selectionStart: 17, selectionEnd: 17 });
    await sleep(200);
    await send('Input.insertText', { text: 'api.deepseek.com/v1' });
    await sleep(300);
  } catch (e) {
    console.log('IME method err:', e.message);
  }
  v = await evalJs(`document.getElementById('openaiCompatBaseUrl').value`);
  console.log('value after IME:', JSON.stringify(v));

  // 3) survive check
  for (let s = 1; s <= 10; s++) {
    await sleep(1000);
    const alive = await evalJs(`document.querySelector('.screen.active').dataset.screen`);
    if (!alive) { console.log(`renderer dead at ${s}s`); process.exit(2); }
    if (s % 5 === 0) console.log(`alive at ${s}s, screen=${alive}`);
  }
  console.log('VERDICT: survived real-key + IME input');
  process.exit(0);
}
main().catch((e) => { console.log('fatal:', e.message); process.exit(3); });
