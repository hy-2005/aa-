// Quick CDP probe of main window size in default state
const http = require('http');
const WebSocket = require('ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function getTargets() {
  return new Promise((res, rej) => {
    http.get('http://127.0.0.1:9222/json/list', (r) => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });
}
(async () => {
  const targets = await getTargets();
  const main = targets.find(t => t.url.includes('index.html'));
  if (!main) { console.log('main not running'); process.exit(1); }
  const ws = new WebSocket(main.webSocketDebuggerUrl);
  await new Promise(r => ws.on('open', r));
  let id = 0; const p = new Map();
  ws.on('message', raw => { const m = JSON.parse(raw.toString()); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } });
  const ev = expr => new Promise(res => { const i = ++id; p.set(i, res); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } })); });
  await sleep(2500);
  const dom = await ev(`(() => {
    const t = document.querySelector('.command-tab');
    const r = t ? t.getBoundingClientRect() : null;
    return { tabRect: r && { w: Math.round(r.width), h: Math.round(r.height) },
             body: { w: document.body.scrollWidth, h: document.body.scrollHeight },
             inner: { w: window.innerWidth, h: window.innerHeight } };
  })()`);
  console.log('DOM state:', JSON.stringify(dom.result.result.value, null, 2));
  ws.close();
  process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });