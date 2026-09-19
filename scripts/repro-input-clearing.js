/**
 * 复现驱动：「引导页输入 API key 被反复清掉」。
 *
 * 与 repro-onboarding.js 不同，这里不是隔离复现，而是加载真实的 main.js
 * （真实的窗口管理器、3 秒 periodicEnforcement、100ms Z 序守护、5 秒录屏
 * 探测器全部照跑），再把 onboarding 窗口两侧布满探针：
 *
 *   主进程侧：
 *     - did-navigate / will-navigate / did-navigate-in-page —— 抓页面重载
 *     - render-process-gone / unresponsive —— 抓渲染进程死亡
 *     - console-message —— 透传渲染进程日志
 *     - show / hide / focus / blur —— 抓窗口闪烁
 *
 *   渲染进程侧（executeJavaScript 注入）：
 *     - beforeunload / pagehide 监听 —— 页面卸载前最后一句话
 *     - 对每个凭据 input 的 value setter 做 defineProperty 劫持 ——
 *       任何程序性赋值（含清空）都会带调用栈打出来
 *     - input 事件监听 —— 区分"用户输入"与"程序覆写"
 *
 * 驱动方式：sendInputEvent 逐字符敲入（走真实输入管线，与 IME/键盘一致），
 * 之后轮询 30 秒，报告 value 长度变化。
 *
 * 运行：npx electron scripts/repro-input-clearing.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');

const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;
const log = (m) => console.log(`[${ts()}] ${m}`);

// ── 隔离的 first-run 环境：userData 和 cwd 都指向临时目录 ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-repro-'));
app.setPath('userData', path.join(TMP, 'userData'));
process.chdir(TMP);
// electron scripts/xxx.js 会把 appPath 当成 scripts/，loadFile('index.html')
// 就会去 scripts/index.html 找 —— 显式指回仓库根目录。
app.setAppPath(ROOT);
log(`sandbox: ${TMP}`);

// ── 加载真实应用（此后所有窗口/定时器/探测器都是产品代码）──
require(path.join(ROOT, 'main.js'));

// ── 渲染进程探针（每次导航后都要重新注入，因为 reload 会清掉旧探针）──
const WATCHER_JS = `(() => {
  if (window.__watchInstalled) return 'already';
  window.__watchInstalled = true;
  const L = (m) => { try { console.log('[WATCH] ' + m); } catch (_) {} };
  L('watcher installed @ ' + location.href);
  window.addEventListener('beforeunload', () => L('!!! BEFORE-UNLOAD — page unloading (reload?)'));
  window.addEventListener('pagehide', () => L('!!! PAGEHIDE'));
  const ids = ['geminiKey','openaiKey','openaiCompatKey','geminiModel',
               'openaiModel','openaiCompatModel','openaiCompatBaseUrl','azureKey','azureRegion'];
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
    if (!desc || !desc.set) return;
    Object.defineProperty(el, 'value', {
      get() { return desc.get.call(this); },
      set(v) {
        const old = desc.get.call(this);
        desc.set.call(this, v);
        if (String(old) !== String(v)) {
          const shrunk = String(v).length < String(old).length ? ' <<< SHRUNK/CLEARED' : '';
          const stack = (new Error().stack || '').split('\\n').slice(1, 5).map(s => s.trim()).join(' | ');
          L('VALUE-SET ' + id + ' "' + String(old).slice(0, 10) + '"(' + String(old).length +
            ') -> "' + String(v).slice(0, 10) + '"(' + String(v).length + ')' + shrunk + ' :: ' + stack);
        }
      },
      configurable: true,
    });
    el.addEventListener('input', () => L('INPUT-EVENT ' + id + ' len=' + el.value.length));
  });
  return 'installed';
})()`;

function instrumentOnboarding(win) {
  const wc = win.webContents;
  wc.on('did-navigate', (_e, url) => {
    log(`EVENT did-navigate -> ${url}`);
    wc.executeJavaScript(WATCHER_JS).catch(() => {});
  });
  wc.on('did-navigate-in-page', (_e, url) => log(`EVENT did-navigate-in-page -> ${url}`));
  wc.on('will-navigate', (_e, url) => log(`EVENT will-navigate -> ${url}`));
  wc.on('render-process-gone', (_e, d) => log(`!!! render-process-gone ${JSON.stringify(d)}`));
  wc.on('unresponsive', () => log('!!! renderer unresponsive'));
  wc.on('console-message', (_e, level, message) => {
    if (level >= 2 || message.includes('[WATCH]')) log(`CONSOLE ${message.slice(0, 300)}`);
  });
  win.on('show', () => log('WIN show'));
  win.on('hide', () => log('WIN hide'));
  win.on('focus', () => log('WIN focus'));
  win.on('blur', () => log('WIN blur'));
}

// ── 找到 onboarding 窗口（app 启动 800ms 后才弹）──
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
    await new Promise((r) => setTimeout(r, 60));
  }
}

app.whenReady().then(async () => {
  log('app ready, waiting for onboarding window…');
  const win = await waitForOnboarding();
  if (!win) {
    log('FATAL: onboarding window never appeared');
    app.exit(9);
    return;
  }
  log('onboarding window found — instrumenting');
  instrumentOnboarding(win);
  const wc = win.webContents;

  await wc.executeJavaScript(WATCHER_JS).catch(() => {});
  log('watcher injected, driving user interaction…');

  // 1) 欢迎页 → apikey 页
  await wc.executeJavaScript(`document.getElementById('heroCtaBtn').click(); 'clicked'`);
  await new Promise((r) => setTimeout(r, 600));

  // 2) 切到 OpenAI 兼容（openai-compatible）—— 用户报告的出问题路径
  const switchRes = await wc.executeJavaScript(`
    (() => {
      const sel = document.getElementById('activeProvider');
      sel.value = 'openai-compatible';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      const panel = document.querySelector('[data-provider="openai-compatible"]');
      return { provider: sel.value, panelDisplay: panel ? panel.style.display : 'no-panel' };
    })()
  `);
  log(`switched to openai-compatible: ${JSON.stringify(switchRes)}`);
  await new Promise((r) => setTimeout(r, 600));

  // 3) 聚焦 API 密钥输入框
  await wc.executeJavaScript(`
    const el = document.getElementById('openaiCompatKey');
    el.focus();
    ({ focused: document.activeElement === el, disabled: el.disabled })
  `).then((r) => log(`focus state: ${JSON.stringify(r)}`));

  // 4) 像真实用户一样逐字符输入 API key
  log('typing API key into openaiCompatKey…');
  await typeInto(wc, 'sk-test-1234567890abcdefghij');

  // 5) 再填模型与 Base URL（复现完整用户操作序列）
  for (const [id, text] of [
    ['openaiCompatModel', 'deepseek-chat'],
    ['openaiCompatBaseUrl', 'https://api.deepseek.com/v1'],
  ]) {
    await wc.executeJavaScript(
      `document.getElementById('${id}').focus(); 'ok'`
    );
    await typeInto(wc, text);
  }
  log('all three fields typed');

  // 6) 轮询 30 秒：三个字段的 value / 探针存活 / 页面 URL / 当前屏幕
  let lastSnapshot = '';
  for (let s = 0; s < 60; s++) {
    await new Promise((r) => setTimeout(r, 500));
    if (win.isDestroyed()) { log('!!! onboarding window DESTROYED'); break; }
    const probe = await wc.executeJavaScript(`(() => ({
      key: document.getElementById('openaiCompatKey').value.length,
      model: document.getElementById('openaiCompatModel').value.length,
      base: document.getElementById('openaiCompatBaseUrl').value.length,
      watch: !!window.__watchInstalled,
      url: location.href,
      screen: (document.querySelector('.screen.active') || {}).dataset ? document.querySelector('.screen.active').dataset.screen : null,
    }))()`).catch((e) => ({ err: e.message }));
    const snap = JSON.stringify(probe);
    if (snap !== lastSnapshot) {
      log(`poll ${snap}`);
      lastSnapshot = snap;
    }
    if (probe.watch === false) log('!!! WATCHER GONE — page reloaded!');
  }

  log('=== repro window ended ===');
  app.exit(0);
});

// 40 秒保险丝：无论卡在哪都退出
setTimeout(() => { console.log('[fuse] 40s hard exit'); app.exit(1); }, 40000).unref();
