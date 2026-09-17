/**
 * Temporary repro driver for the "select OpenAI Compatible → renderer dies" bug.
 * Loads the real onboarding.html in the real window config (transparent,
 * frameless) with the real preload, drives the exact user interaction, and
 * reports render-process-gone / unresponsive / child-process-gone details.
 *
 * Run: npx electron scripts/repro-onboarding.js
 */
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 560,
    height: 680,
    frame: false,
    titleBarStyle: 'hidden',
    transparent: true,
    skipTaskbar: true,
    resizable: false,
    show: true,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  let verdict = 'survived';
  win.webContents.on('render-process-gone', (_e, details) => {
    verdict = 'RENDERER-GONE';
    console.log('=== RENDER PROCESS GONE ===', JSON.stringify(details));
  });
  win.webContents.on('unresponsive', () => {
    verdict = 'UNRESPONSIVE';
    console.log('=== RENDERER UNRESPONSIVE ===');
  });
  win.on('closed', () => {
    console.log('=== WINDOW CLOSED (was it expected?) ===');
  });
  app.on('child-process-gone', (_e, details) => {
    console.log('=== CHILD PROCESS GONE ===', JSON.stringify(details));
  });

  await win.loadFile(path.join(ROOT, 'onboarding.html'));
  console.log('loaded, driving user interaction...');

  const script = `(() => {
    document.getElementById('heroCtaBtn').click();
    const sel = document.getElementById('activeProvider');
    sel.value = 'openai-compatible';
    sel.dispatchEvent(new Event('change'));
    const set = (id, v) => {
      const el = document.getElementById(id);
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('openaiCompatKey', 'sk-test-1234567890');
    set('openaiCompatModel', 'deepseek-chat');
    set('openaiCompatBaseUrl', 'api.deepseek.com/v1');
    return { provider: sel.value };
  })()`;
  const r = await win.webContents.executeJavaScript(script);
  console.log('driven:', JSON.stringify(r));

  // Watch for a delayed crash ("after a while")
  for (let s = 1; s <= 20; s++) {
    await new Promise((res) => setTimeout(res, 1000));
    if (verdict !== 'survived') {
      console.log(`verdict: ${verdict} at ${s}s`);
      process.exit(2);
    }
    if (win.isDestroyed()) {
      console.log(`window destroyed at ${s}s`);
      process.exit(3);
    }
  }
  console.log('verdict: survived 20s, no crash');
  process.exit(0);
});

app.on('window-all-closed', () => {
  console.log('all windows closed');
  process.exit(4);
});
