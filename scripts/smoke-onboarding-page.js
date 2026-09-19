/**
 * 独立冒烟：真实加载 onboarding.html + mock electronAPI，
 * 抓渲染层 boot 错误并核对 openai-compatible 三字段存在。
 * 运行：npx electron scripts/smoke-onboarding-page.js
 */
'use strict';
const path = require('path');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
  win.webContents.on('console-message', (_e, level, msg, line, src) => {
    if (level >= 2) console.log(`PAGE-ERR: ${msg} @ ${src}:${line}`);
  });
  win.webContents.on('render-process-gone', (_e, d) => console.log('GONE', JSON.stringify(d)));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => console.log('FAIL-LOAD', code, desc, url));

  await win.loadFile(path.join(ROOT, 'onboarding.html'));
  console.log('loaded (no electronAPI — onboarding.js boot skipped, checking raw DOM)');
  const raw = await win.webContents.executeJavaScript(`(() => ({
    key: !!document.getElementById('openaiCompatKey'),
    model: !!document.getElementById('openaiCompatModel'),
    base: !!document.getElementById('openaiCompatBaseUrl'),
    providerSel: !!document.getElementById('activeProvider'),
    geminiKey: !!document.getElementById('geminiKey'),
    openaiKey: !!document.getElementById('openaiKey'),
  }))()`);
  console.log('RAW-DOM:', JSON.stringify(raw));

  // 注入 mock 后重载，让 onboarding.js 完整 boot 一次
  await win.webContents.executeJavaScript(`window.electronAPI = {
    getSettings: () => Promise.resolve({ providers: {}, activeProvider: 'openai-compatible', wizardDraft: null }),
    saveSettings: () => Promise.resolve({ success: true }),
    saveWizardDraft: () => Promise.resolve({ success: true }),
    getFirstRunStatus: () => Promise.resolve({}),
    completeFirstRun: () => Promise.resolve(),
    closeOnboarding: () => {},
    detectWhisper: () => Promise.resolve({ found: false }),
    installWhisper: () => Promise.resolve({ ok: false }),
    downloadWhisperModel: () => Promise.resolve({ ok: false }),
    onInstallProgress: () => () => {},
    openExternal: () => {},
  }; 'mocked'`);
  await win.webContents.reload();
  await new Promise((r) => setTimeout(r, 2000));
  try {
    const booted = await win.webContents.executeJavaScript(`(() => ({
      activeScreen: document.querySelector('.screen.active') ? document.querySelector('.screen.active').dataset.screen : null,
      keyVisible: document.querySelector('[data-provider="openai-compatible"]').style.display !== 'none',
      badge: document.getElementById('stepBadge').textContent,
    }))()`);
    console.log('BOOTED:', JSON.stringify(booted));
  } catch (e) {
    console.log('EVAL-ERR:', e.message);
  }
  app.exit(0);
});
