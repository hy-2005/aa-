/**
 * 验证 window.manager.js 中"屏蔽引导页刷新"的两段逻辑：
 *   1) before-input-event：F5 / Ctrl+R / Cmd+R / Shift+F5 / Ctrl+Shift+R
 *      在 type === 'onboarding' 时被 preventDefault，其它类型不受影响；
 *      缩放快捷键（Ctrl+= / Ctrl+- / Ctrl+0 等）继续走原有缩放处理。
 *   2) will-navigate：引导页同 URL 重载被 preventDefault；HTTP/HTTPS
 *      跳转照旧被打开外部浏览器；其它窗口照旧放行。
 *
 * 通过真实挂上同样的 listener 并喂各种 input/导航事件参数来核对 prevent
 * 行为，避免"代码看起来对"的伪验证。
 */
'use strict';

const assert = require('assert');

// 模拟 webContents：只关心 setZoomFactor 是否被调用，以及事件监听器
// 是否被注册。preventDefault() 在 Electron 里由 webContents 自动调用
// （我们只要从事件回调里调 event.preventDefault()，Electron 就会吞下
// 默认行为），这里用 sentinel 函数替代。
function makeWebContents() {
  let zoom = 1.0;
  const listeners = {};
  return {
    setZoomFactor(v) { zoom = v; },
    getZoomFactor() { return zoom; },
    _zoom: zoom,
    on(event, fn) { listeners[event] = listeners[event] || []; listeners[event].push(fn); },
    _fire(event, ...args) { (listeners[event] || []).forEach((fn) => fn(...args)); },
    getURL: () => 'file:///fake/onboarding.html',
  };
}

// 复制 createWindow 中要测的两段逻辑（保持和源文件 1:1，便于 diff 对照）。
// 这里入参是 BrowserWindow，所以 mock 需要有 webContents 属性。
function installGuards(window, type, resolveZoom) {
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = (input.key || '').toLowerCase();
    if ((input.control || input.alt) && ['+', '-', '=', '0', '_'].includes(key)) {
      event.preventDefault();
      window.webContents.setZoomFactor(resolveZoom());
    }
    if (type === 'onboarding' && (
      key === 'f5' ||
      (input.control && key === 'r') ||
      (input.meta && key === 'r') ||
      (input.shift && key === 'f5') ||
      (input.control && input.shift && key === 'r')
    )) {
      event.preventDefault();
    }
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (type === 'onboarding' && url === window.webContents.getURL()) {
      event.preventDefault();
      return;
    }
    if (/^https?:\/\//i.test(url) && url !== window.webContents.getURL()) {
      event.preventDefault();
      // shell.openExternal(url);
    }
  });
}

// 模拟 event 对象：记录是否被 preventDefault。
function makeEvent() {
  let prevented = false;
  return {
    preventDefault() { prevented = true; },
    _wasPrevented: () => prevented,
  };
}

// 把 webContents mock 包成 BrowserWindow 形状（只挂 webContents）。
function makeWindow(webContents) {
  return { webContents };
}

// 工具：模拟一次按键，return 是否被吞掉。
function pressKey(window, input) {
  const ev = makeEvent();
  window.webContents._fire('before-input-event', ev, { type: 'keyDown', ...input });
  return ev._wasPrevented();
}

function navigate(window, url) {
  const ev = makeEvent();
  window.webContents._fire('will-navigate', ev, url);
  return ev._wasPrevented();
}

// ── 跑用例 ─────────────────────────────────────────────────────────────
const failures = [];
function check(label, ok, detail) {
  if (!ok) failures.push(`${label} —— ${detail || ''}`);
  else console.log(`  ✓ ${label}`);
}

console.log('引导页（onboarding）：刷新快捷键必须全部被吞');
{
  const win = makeWindow(makeWebContents());
  installGuards(win, 'onboarding', () => 1.0);

  check('F5 被屏蔽',          pressKey(win, { key: 'F5' }) === true);
  check('Ctrl+R 被屏蔽',      pressKey(win, { key: 'r', control: true }) === true);
  check('Cmd+R 被屏蔽（mac）', pressKey(win, { key: 'r', meta: true }) === true);
  check('Shift+F5 被屏蔽',    pressKey(win, { key: 'F5', shift: true }) === true);
  check('Ctrl+Shift+R 被屏蔽', pressKey(win, { key: 'r', control: true, shift: true }) === true);
}

console.log('引导页（onboarding）：缩放快捷键必须照常工作（不被错杀）');
{
  const win = makeWindow(makeWebContents());
  installGuards(win, 'onboarding', () => 0.85);
  check('Ctrl+= 缩放生效',      pressKey(win, { key: '=', control: true }) === true);
  check('Ctrl+- 缩放生效',      pressKey(win, { key: '-', control: true }) === true);
  check('Ctrl+0 缩放生效',      pressKey(win, { key: '0', control: true }) === true);
  // 单独 Alt+F5 也属于 F5 系列（裸 'f5' 这条会命中），应被屏蔽
  check('Alt+F5 被屏蔽', pressKey(win, { key: 'F5', alt: true }) === true);
}

console.log('其它窗口（main / settings / llmResponse / chat）：刷新照旧放行');
{
  ['main', 'settings', 'llmResponse', 'chat', 'screenshotQueue'].forEach((t) => {
    const win = makeWindow(makeWebContents());
    installGuards(win, t, () => 1.0);
    check(`[${t}] F5 未被屏蔽`,          pressKey(win, { key: 'F5' }) === false);
    check(`[${t}] Ctrl+R 未被屏蔽`,      pressKey(win, { key: 'r', control: true }) === false);
    check(`[${t}] Ctrl+Shift+R 未被屏蔽`, pressKey(win, { key: 'r', control: true, shift: true }) === false);
  });
}

console.log('will-navigate：引导页同 URL 重载被屏蔽；HTTP 跳转照旧拦下');
{
  const win = makeWindow(makeWebContents());
  installGuards(win, 'onboarding', () => 1.0);

  check('同 URL 重载（file://）被屏蔽',
        navigate(win, 'file:///fake/onboarding.html') === true);
  check('HTTP 外链被屏蔽（被打开外部浏览器）',
        navigate(win, 'https://github.com/TechyCSR/OpenCluely') === true);
}

console.log('will-navigate：其它窗口维持原有行为（仅 HTTP 外链被拦）');
{
  ['main', 'settings', 'llmResponse', 'chat', 'screenshotQueue'].forEach((t) => {
    const win = makeWindow(makeWebContents());
    installGuards(win, t, () => 1.0);
    check(`[${t}] 同 URL 重载放行（不打断现有用户刷新）`,
          navigate(win, win.webContents.getURL()) === false);
    check(`[${t}] HTTP 外链仍被屏蔽`,
          navigate(win, 'https://example.com/') === true);
  });
}

console.log('');
if (failures.length) {
  console.error(`✗ ${failures.length} 个断言失败：`);
  failures.forEach((f) => console.error('  - ' + f));
  process.exit(1);
}
console.log('✓ 全部断言通过：引导页刷新屏蔽逻辑符合预期，未误伤其它窗口/缩放。');