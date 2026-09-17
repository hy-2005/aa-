/** Live watcher: polls the onboarding CDP target + tails app log. Writes a timeline. */
const http = require('http');
const fs = require('fs');
const path = require('path');

const TMP = process.env.TEMP || require('os').tmpdir();
const OUT = path.join(TMP, 'user-repro-watch.log');
const APPLOG = path.join(TMP, 'app-user-repro.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getTargets() {
  return new Promise((resolve) => {
    http.get('http://127.0.0.1:9222/json/list', (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', () => resolve(null));
  });
}

function log(line) {
  const ts = new Date().toISOString().slice(11, 23);
  const out = `[${ts}] ${line}\n`;
  fs.appendFileSync(OUT, out);
  console.log(out.trimEnd());
}

async function main() {
  fs.writeFileSync(OUT, `=== watcher started ${new Date().toISOString()} ===\n`);
  let lastLogSize = fs.existsSync(APPLOG) ? fs.statSync(APPLOG).size : 0;
  let targetGoneAt = null;
  let lastLogLineAt = Date.now();

  for (let i = 0; i < 3600; i++) { // up to 30 min
    // 1. Target presence
    const targets = await getTargets();
    if (targets === null) {
      log('CDP endpoint unreachable — app exiting or dead');
      break;
    }
    const ob = targets.filter((t) => t.url.includes('onboarding'));
    if (ob.length === 0 && !targetGoneAt) {
      targetGoneAt = Date.now();
      log('!!! ONBOARDING TARGET DISAPPEARED (renderer dead or window closed)');
      log('remaining targets: ' + targets.map((t) => t.url.split('/').pop()).join(', '));
    }
    if (ob.length > 0 && targetGoneAt) {
      log('onboarding target RE-APPEARED (reloaded?)');
      targetGoneAt = null;
    }

    // 2. New app log lines (filtered to signal)
    if (fs.existsSync(APPLOG)) {
      const st = fs.statSync(APPLOG);
      if (st.size > lastLogSize) {
        const fd = fs.openSync(APPLOG, 'r');
        const buf = Buffer.alloc(st.size - lastLogSize);
        fs.readSync(fd, buf, 0, buf.length, lastLogSize);
        fs.closeSync(fd);
        lastLogSize = st.size;
        const lines = buf.toString('utf8').split(/\r?\n/);
        for (const l of lines) {
          if (/\[SAVE\]|ERROR|process gone|Child process|unresponsive|failed to load|Settings saved|provider config|crash/i.test(l)) {
            log('APP: ' + l.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 160));
            lastLogLineAt = Date.now();
          }
        }
      }
    }

    // 3. After target death, keep watching app log 8 more seconds then stop
    if (targetGoneAt && Date.now() - targetGoneAt > 8000) {
      log('=== 8s after target death — stopping ===');
      break;
    }
    await sleep(500);
  }
  log('=== watcher end ===');
}
main();
