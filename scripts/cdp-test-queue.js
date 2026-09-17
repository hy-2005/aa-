/** Live test: invoke takeScreenshot via main window, inspect llm-response strip + chat switch. */
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

async function attach(urlPart) {
  const targets = await getTargets();
  const t = targets.find((x) => x.url.includes(urlPart));
  if (!t) return null;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.on('open', r));
  let id = 0;
  const p = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      const args = (m.params.args || []).map((a) => a.value ?? a.description).join(' ');
      console.log(`  [${urlPart}] CONSOLE ERROR:`, args.slice(0, 200));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      console.log(`  [${urlPart}] EXCEPTION:`, JSON.stringify(m.params.exceptionDetails.exception || {}).slice(0, 200));
    }
  });
  const ev = (expr) => new Promise((res) => {
    const i = ++id; p.set(i, res);
    ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });
  await ev('Runtime && 1'); // warm
  return { ev, ws };
}

(async () => {
  const main = await attach('index.html');
  if (!main) { console.log('MAIN WINDOW NOT FOUND'); process.exit(1); }
  const resp = await attach('llm-response.html');
  console.log('llm-response attached:', !!resp);

  // 0) does the strip exist in llm-response?
  const stripState = await resp.ev(`(() => {
    const s = document.getElementById('screenshotQueueStrip');
    return { exists: !!s, display: s ? s.style.display : null, thumbs: s ? s.querySelectorAll('img').length : -1,
             api: typeof window.electronAPI, hasListener: !!(window.electronAPI && window.electronAPI.onScreenshotQueued) };
  })()`);
  console.log('BEFORE capture:', JSON.stringify(stripState.result.result.value));

  // 1) trigger capture via IPC from main window
  console.log('invoking take-screenshot via main window...');
  await main.ev(`window.electronAPI.takeScreenshot() && 'invoked'`);
  await sleep(2500);

  const stripAfter = await resp.ev(`(() => {
    const s = document.getElementById('screenshotQueueStrip');
    return { exists: !!s, display: s ? s.style.display : null, thumbs: s ? s.querySelectorAll('img').length : -1,
             title: s ? (document.getElementById('screenshotQueueTitle') || {}).textContent : null };
  })()`);
  console.log('AFTER capture:', JSON.stringify(stripAfter.result.result.value));

  // 2) chat window switch test
  console.log('switching to chat...');
  await main.ev(`window.electronAPI.switchToChat() && 'ok'`);
  await sleep(1500);
  const targets = await getTargets();
  console.log('targets now:', targets.map((t) => (t.url.split('/').pop() || t.type)).join(', '));
  const chat = await attach('chat.html');
  if (chat) {
    const chatState = await chat.ev(`({ visible: document.visibilityState, body: document.body ? document.body.children.length : -1 })`);
    console.log('chat state:', JSON.stringify(chatState.result.result.value));
  } else {
    console.log('CHAT WINDOW NOT FOUND IN TARGETS');
  }
  process.exit(0);
})().catch((e) => { console.log('FATAL:', e.message); process.exit(1); });
