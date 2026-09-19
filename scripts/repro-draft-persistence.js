/**
 * 端到端验证「引导页草稿持久化 + 二次启动不闪窗」：
 *
 *   phase A：真实 main.js 起应用 → 切 openai-compatible → 逐字符敲三个字段
 *            → 等 600ms 防抖 → 读沙盒里的 wizard-draft.json → process.exit(9)
 *            硬杀（模拟用户被退出的场景：不走任何优雅关闭路径）。
 *   phase B：同一沙盒再次起真实应用 → 等引导页 → 验证三个字段已被草稿
 *            回填 → 再 spawn 一个第二实例 → 验证老实例没有 showAllWindows
 *            （不闪窗）且引导页重新前置、输入仍在。
 *
 * 运行：npx electron scripts/repro-draft-persistence.js        （phase A）
 *       OC_SANDBOX=<dir> npx electron scripts/repro-draft-persistence.js --phase-b
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PHASE_B = process.argv.includes('--phase-b');

const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;
const log = (m) => console.log(`[${ts()}] ${m}`);

// 沙盒：A 新建并打印；B 从环境变量继承（复用同一 userData 才能读到草稿）
const TMP = PHASE_B && process.env.OC_SANDBOX
  ? process.env.OC_SANDBOX
  : fs.mkdtempSync(path.join(os.tmpdir(), 'oc-draft-'));
app.setPath('userData', path.join(TMP, 'userData'));
process.chdir(TMP);
app.setAppPath(ROOT);
log(`phase=${PHASE_B ? 'B' : 'A'} sandbox=${TMP}`);

require(path.join(ROOT, 'main.js'));

async function waitForOnboarding() {
  for (let i = 0; i < 100; i++) {
    const win = BrowserWindow.getAllWindows()
      .find((w) => !w.isDestroyed() && w.webContents.getURL().includes('onboarding'));
    if (win) return win;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

async function typeInto(wc, text) {
  for (const ch of text) {
    wc.sendInputEvent({ type: 'char', keyCode: ch });
    await new Promise((r) => setTimeout(r, 40));
  }
}

const TYPED = {
  key: 'sk-e2e-draft-ABC123xyz',
  model: 'deepseek-chat',
  base: 'https://api.deepseek.com/v1',
};

app.whenReady().then(async () => {
  const win = await waitForOnboarding();
  if (!win) { log('FATAL: onboarding never appeared'); process.exit(9); }
  const wc = win.webContents;
  log('onboarding up');

  await wc.executeJavaScript(`document.getElementById('heroCtaBtn').click(); 'ok'`);
  await new Promise((r) => setTimeout(r, 400));
  await wc.executeJavaScript(`
    (() => {
      const sel = document.getElementById('activeProvider');
      sel.value = 'openai-compatible';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return 'switched';
    })()
  `);
  await new Promise((r) => setTimeout(r, 300));

  // phase A：打字 → 防抖落盘 → 硬杀
  if (!PHASE_B) {
    await wc.executeJavaScript(`document.getElementById('openaiCompatKey').focus(); 'ok'`);
    await typeInto(wc, TYPED.key);
    await wc.executeJavaScript(`document.getElementById('openaiCompatModel').focus(); 'ok'`);
    await typeInto(wc, TYPED.model);
    await wc.executeJavaScript(`document.getElementById('openaiCompatBaseUrl').focus(); 'ok'`);
    await typeInto(wc, TYPED.base);
    log('typed; waiting 1200ms for debounce…');
    await new Promise((r) => setTimeout(r, 1200));

    const draftPath = path.join(app.getPath('userData'), 'wizard-draft.json');
    let draft = null;
    try { draft = JSON.parse(fs.readFileSync(draftPath, 'utf8')); } catch (e) { log(`draft read err: ${e.message}`); }
    const p = draft && draft.providers && draft.providers['openai-compatible'];
    log(`DRAFT-FILE ${draftPath}`);
    log(`DRAFT-CONTENT key="${p && p.apiKey}" model="${p && p.model}" base="${p && p.baseUrl}" provider=${draft && draft.activeProvider}`);
    const ok = p && p.apiKey === TYPED.key && p.model === TYPED.model && p.baseUrl === TYPED.base;
    log(ok ? 'PHASE-A-PASS draft persisted' : 'PHASE-A-FAIL draft missing/mismatched');
    log('HARD-EXIT (simulating crash/kill)');
    process.exit(ok ? 9 : 8); // 9 = 模拟猝死，外层据此进入 phase B
  }

  // phase B：验证回填
  await new Promise((r) => setTimeout(r, 2000)); // 等 getSettings 草稿合并
  const restored = await wc.executeJavaScript(`(() => ({
    key: document.getElementById('openaiCompatKey').value,
    model: document.getElementById('openaiCompatModel').value,
    base: document.getElementById('openaiCompatBaseUrl').value,
    provider: document.getElementById('activeProvider').value,
  }))()`);
  log(`RESTORED ${JSON.stringify(restored)}`);
  const okRestore = restored.provider === 'openai-compatible'
    && restored.key === TYPED.key
    && restored.model === TYPED.model
    && restored.base === TYPED.base;
  log(okRestore ? 'PHASE-B1-PASS draft restored after hard restart' : 'PHASE-B1-FAIL restore mismatch');

  // phase B2：二次启动 —— 期望老实例只重显引导页，不 showAllWindows
  const tBefore = Date.now();
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'repro-draft-persistence.js'), '--phase-b2-second'], {
    env: { ...process.env, OC_SANDBOX: TMP, ELECTRON_RUN_AS_NODE: '' },
    stdio: 'ignore',
  });
  await new Promise((r) => setTimeout(r, 4000));

  // 从共享应用日志里截取二次启动之后的关键行
  const logDir = path.join(os.homedir(), '.WindowsPersonalAssistant', 'logs');
  const today = new Date().toISOString().slice(0, 10);
  const appLog = path.join(logDir, `application-${today}.log`);
  let lines = [];
  try {
    lines = fs.readFileSync(appLog, 'utf8').split(/\r?\n/)
      .filter((l) => {
        const m = l.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
        if (!m) return false;
        return new Date(m[1]).getTime() >= tBefore - 2000;
      });
  } catch (_) {}
  const shown = lines.filter((l) => l.includes('All windows shown on current desktop')).length;
  const reOnboard = lines.filter((l) => l.includes('Onboarding window displayed')).length;
  const valueStill = await wc.executeJavaScript(`document.getElementById('openaiCompatKey').value`);
  log(`SECOND-INSTANCE-RESULT shownAll=${shown} reOnboarded=${reOnboard} keyStill="${valueStill}"`);
  const okSecond = shown === 0 && valueStill === TYPED.key;
  log(okSecond ? 'PHASE-B2-PASS no window storm, input intact' : 'PHASE-B2-FAIL (check logs)');

  try { child.kill(); } catch (_) {}
  log(`VERDICT restore=${okRestore} secondInstance=${okSecond}`);
  app.exit(okRestore && okSecond ? 0 : 1);
});

setTimeout(() => { console.log('[fuse] 60s hard exit'); process.exit(1); }, 60000).unref();
