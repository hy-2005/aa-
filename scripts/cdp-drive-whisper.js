/** Drive the wizard further: speech → whisper screen, watching for the crash. */
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
  for (let i = 0; i < 30; i++) {
    const targets = await getTargets().catch(() => []);
    target = targets.find((t) => t.url.includes('onboarding.html') && t.webSocketDebuggerUrl);
    if (target) break;
    await sleep(1000);
  }
  if (!target) { console.log('no target — renderer already dead?'); process.exit(2); }

  const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  let msgId = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === 'Runtime.exceptionThrown') {
      console.log('RENDERER EXCEPTION:', JSON.stringify(msg.params.exceptionDetails).slice(0, 400));
    }
  });
  ws.on('close', () => { console.log('!!! CDP CLOSED — RENDERER DIED !!!'); process.exit(2); });

  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++msgId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params }));
  });
  await new Promise((r) => ws.on('open', r));
  await send('Runtime.enable');
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  console.log('DRIVER2: choose Whisper on speech screen');
  await evalJs(`(() => {
    const card = document.querySelector('#speechChoices .choice-card[data-value="whisper"]');
    card.click(); return 'chosen';
  })()`);
  await sleep(500);
  console.log('DRIVER2: click Continue → enters whisper screen (detection runs)');
  await evalJs(`document.getElementById('nextBtn').click(); 'ok'`);

  for (let s = 1; s <= 45; s++) {
    await sleep(1000);
    const st = await evalJs(`(() => {
      const screen = document.querySelector('.screen.active');
      const detect = document.getElementById('detectStatus');
      const log = document.getElementById('installLog');
      return { screen: screen && screen.dataset.screen,
               detect: detect ? detect.textContent.trim() : null,
               log: log ? log.textContent.slice(0, 200) : null };
    })()`);
    if (s % 5 === 0 || (st && st.detect && !/Probing/.test(st.detect))) {
      console.log(`DRIVER2 ${s}s: screen=${st.screen} detect=${JSON.stringify(st.detect)}`);
    }
    if (st && st.screen === 'model-download') {
      console.log('DRIVER2: reached model-download screen — whisper screen survived');
      process.exit(0);
    }
    if (st === undefined) { console.log(`DRIVER2 ${s}s: evaluate failed — renderer dead`); process.exit(2); }
  }
  console.log('DRIVER2: still on', st && st.screen);
  process.exit(0);
}
main().catch((e) => { console.log('DRIVER2 fatal:', e.message); process.exit(3); });
