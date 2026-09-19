'use strict';

/**
 * 直接调 Win32 user32 API 把 Electron BrowserWindow 强制钉在 HWND_TOPMOST 层。
 *
 * 背景：Electron 自带的 setAlwaysOnTop(true) 在 Windows 上确实对应
 * HWND_TOPMOST，但实际表现里有几个问题：
 *   1) Electron 把 WS_EX_TOPMOST 当成一个 soft flag 调用 SetWindowPos，
 *      而不是持久写进 GWL_EXSTYLE，某些场景下（特别是浏览器 F11 / HTML5
 *      fullscreen 的 Z 序刷新后）会被悄无声息地覆盖；
 *   2) 浏览器全屏层周期性重新调整自身 Z 序时，单凭 Electron API
 *      顶不动 —— setAlwaysOnTop(true) 在已经置顶的窗口上是 no-op，
 *      不会 re-assert。
 *
 * 这个模块绕过 Electron，直接调 OS：
 *   - SetWindowLongW 把 WS_EX_TOPMOST 永久写进 GWL_EXSTYLE（持久样式，
 *     不被上层 SetWindowPos 覆盖）；
 *   - SetWindowPos(HWND_TOPMOST, ..., SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE)
 *     每 100ms 重新把窗口拽回顶层，不抢焦点、不动位置/大小。
 *
 * 仅 Windows 平台有效；其他平台 ensureTopmost() 是 no-op（返回 false），
 * 调用方应继续用 Electron 自带的 setAlwaysOnTop 兜底。
 */

const IS_WIN = process.platform === 'win32';

let koffi = null;
let user32 = null;
let SetWindowPos = null;
let GetWindowLongW = null;
let SetWindowLongW = null;
let loadAttempted = false;

// ── Win32 常量 ──────────────────────────────────────────────────────────────
const GWL_EXSTYLE = -20;
const WS_EX_TOPMOST = 0x00000008;

const HWND_TOPMOST = -1; // uint64 表示为 0xFFFFFFFFFFFFFFFF

const SWP_NOMOVE = 0x0002;
const SWP_NOSIZE = 0x0001;
const SWP_NOACTIVATE = 0x0010;

// 懒加载：第一次调用 ensureTopmost 时才 load koffi，避免启动时无谓的开销。
function ensureLoaded(logger) {
  if (!IS_WIN) return false;
  if (user32) return true;
  if (loadAttempted) return false;
  loadAttempted = true;
  try {
    koffi = require('koffi');
    user32 = koffi.load('user32.dll');
    SetWindowPos = user32.func(
      'bool SetWindowPos(uint64 hWnd, uint64 hWndInsertAfter, ' +
        'int32 X, int32 Y, int32 cx, int32 cy, uint32 uFlags)'
    );
    GetWindowLongW = user32.func('int32 GetWindowLongW(uint64 hWnd, int32 nIndex)');
    SetWindowLongW = user32.func('int32 SetWindowLongW(uint64 hWnd, int32 nIndex, int32 dwNewLong)');
    return true;
  } catch (err) {
    if (logger && logger.warn) {
      logger.warn('native-window-guard: koffi load failed, falling back to Electron setAlwaysOnTop', {
        error: err.message,
      });
    }
    user32 = null;
    return false;
  }
}

/**
 * 从 Electron BrowserWindow 取真实 HWND。
 * Electron 的 getNativeWindowHandle() 在 64-bit Windows 上返回 8 字节 Buffer，
 * 在 32-bit 上返回 4 字节 Buffer，统一读成 BigInt 再交给 koffi。
 */
function getHwnd(win) {
  try {
    const buf = win.getNativeWindowHandle();
    if (!buf || buf.length === 0) return null;
    return buf.length >= 8
      ? buf.readBigUInt64LE(0)
      : BigInt(buf.readUInt32LE(0));
  } catch (_) {
    return null;
  }
}

/**
 * 把窗口强制钉在 HWND_TOPMOST，返回 true 表示已成功调用 Win32 API。
 *
 * 实现步骤：
 *   1) 读 GWL_EXSTYLE；若不含 WS_EX_TOPMOST 则补上（持久样式，
 *      不被其他 SetWindowPos 调用覆盖）；
 *   2) SetWindowPos(HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)
 *      把窗口拉到 Z 序最顶层，不动位置/大小、不抢焦点。
 *
 * 安全注意：
 *   - GetWindowLongW 返回 0 时跳过 SetWindowLongW，避免 0 | WS_EX_TOPMOST
 *     把窗口的真实样式抹成只剩 TOPMOST（其他所有 ex-style 都会被清零）；
 *   - SetWindowPos 用 SWP_NOACTIVATE，焦点始终留在用户的浏览器/IDE 上，
 *     proctor 软件不会告警 "user left the page"。
 *   - 任何一步抛错都返回 false，由调用方继续走 Electron 兜底。
 */
function ensureTopmost(win, logger) {
  if (!IS_WIN) return false;
  if (!win || win.isDestroyed()) return false;
  if (!ensureLoaded(logger)) return false;
  const hwnd = getHwnd(win);
  if (!hwnd) return false;

  try {
    const ex = GetWindowLongW(hwnd, GWL_EXSTYLE);
    // ex 为 0 要么是窗口无 ex-style（不可能），要么 GetWindowLongW 调用
    // 失败 —— 两种情况都不能盲目 OR，否则会把现有 ex-style 清零。
    if (ex !== 0 && (ex & WS_EX_TOPMOST) === 0) {
      SetWindowLongW(hwnd, GWL_EXSTYLE, ex | WS_EX_TOPMOST);
    }
    SetWindowPos(
      hwnd,
      HWND_TOPMOST,
      0,
      0,
      0,
      0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE
    );
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 当前平台/环境下 native 守护是否可用。调用方可以据此决定要不要
 * 跳过 koffi 调用直接用 Electron API。
 */
function isAvailable() {
  return IS_WIN && ensureLoaded();
}

module.exports = {
  ensureTopmost,
  isAvailable,
};
