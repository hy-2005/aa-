/** Inspect the live onboarding renderer: state + install real-input recorders. */
const http = require('http');
const WebSocket = require('ws');

function getTargets() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9222/json/list', (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

async function main() {
  const targets = await getTargets();
  console.log('targets:', targets.map((t) => (t.url.split('/').pop() || t.type).slice(0, 40)).join(' | '));
  const ob = targets.find((t) => t.url.includes('onboarding'));
  if (!ob) { console.log('NO ONBOARDING TARGET'); process.exit(1); }

  const ws = new WebSocket(ob.webSocketDebuggerUrl);
  let id = 0;
  const p = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); }
  });
  await new Promise((r) => ws.on('open', r));
  const ev = (expr) => new Promise((res) => {
    const i = ++id;
    p.set(i, res);
    ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
  });

  const state = `(() => {
    const pill = document.getElementById('keyStatus');
    return {
      screen: document.querySelector('.screen.active').dataset.screen,
      provider: document.getElementById('activeProvider').value,
      keyLen: (document.getElementById('openaiCompatKey').value || '').length,
      model: document.getElementById('openaiCompatModel').value,
      baseUrl: document.getElementById('openaiCompatBaseUrl').value,
      pill: pill && pill.style.display !== 'none' ? pill.textContent.trim() : null,
      hidden: document.hidden,
      visibility: document.visibilityState,
      hasFocus: document.hasFocus()
    };
  })()`;
  const r1 = await ev(state);
  console.log('wizard state:', JSON.stringify(r1.result.result.value, null, 2));

  const rec = `(() => {
    window.__events = [];
    ['click', 'keydown', 'input', 'mousedown'].forEach((t) =>
      document.addEventListener(t, (e) =>
        window.__events.push(t + ' @ ' + (e.target.id || e.target.tagName)), true));
    return 'input recorders installed — user should click/type now';
  })()`;
  const r2 = await ev(rec);
  console.log(r2.result.result.value);
  ws.close();
  process.exit(0);
}

main().catch((e) => { console.log('ERR', e.message); process.exit(1); });
