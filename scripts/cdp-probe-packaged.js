/**
 * CDP 探查打包版 exe 的 onboarding 页：「openai-compatible 输入被清掉」。
 *
 * 步骤：
 *   1. 启动 dist/win-unpacked/向日葵助手.exe --remote-debugging-port=9222
 *      （用的是用户真实 userData —— Roaming/向日葵助手，即用户实测时的状态：
 *       .env 存在、llm-providers.json 不存在、无 firstrun sentinel）
 *   2. 通过 CDP 找到 onboarding 页面 target，连 WebSocket
 *   3. Runtime.enable + Page.enable —— 订阅 console / frame 导航 / 异常
 *   4. 注入 WATCHER（beforeunload / value setter 劫持 / input 事件）
 *   5. 驱动：heroCta → 切 openai-compatible → CDP Input.dispatchKeyEvent 逐字符敲 key/model/baseUrl
 *   6. 轮询 30 秒，报告字段长度变化 / 页面重载 / 探针存活
 *
 * 运行：node scripts/cdp-probe-packaged.js
 */
'use strict';

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'dist', 'win-unpacked', '向日葵助手.exe');
const OUT = path.join(ROOT, 'cdp-probe-run.log');

const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;
const lines = [];
const log = (m) => {
  const l = `[${ts()}] ${m}`;
  lines.push(l);
  console.log(l);
};
fs.writeFileSync(OUT, '');

let msgId = 0;
const pending = new Map();

function cdp(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function getTargets() {
  return new Promise((resolve) => {
    http.get('http://127.0.0.1:9222/json/list', (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (_) { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

const WATCHER_JS = `(() => {
  if (window.__watchInstalled) return 'already';
  window.__watchInstalled = true;
  const L = (m) => { try { console.log('[WATCH] ' + m); } catch (_) {} };
  L('watcher installed @ ' + location.href);
  window.addEventListener('beforeunload', () => L('!!! BEFORE-UNLOAD — page unloading (reload?)'));
  window.addEventListener('pagehide', () => L('!!! PAGEHIDE'));
  ['geminiKey','openaiKey','openaiCompatKey','geminiModel',
   'openaiModel','openaiCompatModel','openaiCompatBaseUrl'].forEach((id) => {
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
          L('VALUE-SET ' + id + ' len ' + String(old).length + '->' + String(v).length + shrunk + ' :: ' + stack);
        }
      },
      configurable: true,
    });
    el.addEventListener('input', () => L('INPUT-EVENT ' + id + ' len=' + el.value.length));
  });
  return 'installed';
})()`;

async function main() {
  log(`spawning packaged exe: ${EXE}`);
  const child = spawn(EXE, ['--remote-debugging-port=9222'], {
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => fs.appendFileSync(OUT, d));
  child.stderr.on('data', (d) => fs.appendFileSync(OUT, d));

  // 等 CDP 端口起来 + onboarding target 出现
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const targets = await getTargets();
    if (!targets) continue;
    target = targets.find((t) => t.url.includes('onboarding') && t.webSocketDebuggerUrl);
    if (i % 4 === 0) {
      log(`targets: ${(targets || []).map((t) => t.url.split('/').pop()).join(', ')}`);
    }
  }
  if (!target) {
    log('FATAL: no onboarding CDP target');
    child.kill();
    process.exit(9);
  }
  log(`onboarding target: ${target.url}`);

  const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });

  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      return;
    }
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'log' || m.params.type === 'error')) {
      const text = (m.params.args || []).map((a) => a.value || a.description || '').join(' ');
      if (text.includes('[WATCH]') || m.params.type === 'error') log(`PAGE-CONSOLE ${text.slice(0, 400)}`);
    } else if (m.method === 'Page.frameNavigated' && m.params.frame.parentId === undefined) {
      log(`!!! PAGE NAVIGATED -> ${m.params.frame.url} (reload if same URL)`);
    } else if (m.method === 'Runtime.exceptionThrown') {
      log(`!!! PAGE EXCEPTION ${JSON.stringify(m.params.exceptionDetails || {}).slice(0, 300)}`);
    }
  });

  await cdp(ws, 'Runtime.enable');
  await cdp(ws, 'Page.enable');
  const inj = await cdp(ws, 'Runtime.evaluate', { expression: WATCHER_JS, returnByValue: true });
  log(`watcher: ${JSON.stringify(inj.result && inj.result.value)}`);

  // 驱动：欢迎页 → apikey → 切 openai-compatible → 聚焦 key
  await cdp(ws, 'Runtime.evaluate', { expression: `document.getElementById('heroCtaBtn').click()` });
  await new Promise((r) => setTimeout(r, 500));
  const sw = await cdp(ws, 'Runtime.evaluate', {
    expression: `(() => {
      const sel = document.getElementById('activeProvider');
      sel.value = 'openai-compatible';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      const el = document.getElementById('openaiCompatKey');
      el.focus();
      return { provider: sel.value, focused: document.activeElement === el, disabled: el.disabled };
    })()`,
    returnByValue: true,
  });
  log(`switch+focus: ${JSON.stringify(sw.result && sw.result.value)}`);

  // CDP 级打字（走 Chromium 输入管线）
  const typeCdp = async (text) => {
    for (const ch of text) {
      await cdp(ws, 'Input.dispatchKeyEvent', { type: 'char', text: ch });
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  log('typing key via CDP…');
  await typeCdp('sk-cdp-test-1234567890');
  await cdp(ws, 'Runtime.evaluate', { expression: `document.getElementById('openaiCompatModel').focus()` });
  await typeCdp('deepseek-chat');
  await cdp(ws, 'Runtime.evaluate', { expression: `document.getElementById('openaiCompatBaseUrl').focus()` });
  await typeCdp('https://api.deepseek.com/v1');
  log('all typed; polling 30s…');

  let last = '';
  for (let s = 0; s < 60; s++) {
    await new Promise((r) => setTimeout(r, 500));
    const p = await cdp(ws, 'Runtime.evaluate', {
      expression: `(() => ({
        key: document.getElementById('openaiCompatKey').value.length,
        model: document.getElementById('openaiCompatModel').value.length,
        base: document.getElementById('openaiCompatBaseUrl').value.length,
        watch: !!window.__watchInstalled,
        screen: document.querySelector('.screen.active') ? document.querySelector('.screen.active').dataset.screen : null,
      }))()`,
      returnByValue: true,
    }).catch(() => null);
    const snap = p ? JSON.stringify(p.result && p.result.value) : 'EVAL-FAILED';
    if (snap !== last) { log(`poll ${snap}`); last = snap; }
  }

  log('=== probe done ===');
  try { ws.close(); } catch (_) {}
  child.kill();
  process.exit(0);
}

main().catch((e) => { log('FATAL ' + e.message); process.exit(1); });
