/* eslint-disable no-undef */
/**
 * Onboarding wizard controller.
 *
 * Drives the 5-step flow rendered in onboarding.html and persists
 * everything via the electronAPI bridge exposed by preload.js:
 *
 *   1. Welcome
 *   2. Gemini API key entry + live connection test
 *   3. Speech provider choice (Whisper / Azure / Skip)
 *   4. Whisper detect + (optional) install — only shown when whisper
 *   5. Star-the-repo prompt + summary
 */

(function () {
  'use strict';

  // ── Error surfacing ────────────────────────────────────────────────
  // A JS error inside the wizard otherwise looks like "the app froze"
  // with zero clues. Mirror every uncaught error / rejection into the
  // visible status pill AND the console so failures are diagnosable.
  function surfaceError(msg) {
    console.error('[onboarding]', msg);
    const pill = document.getElementById('keyStatus');
    if (pill) {
      pill.className = 'status-pill error';
      pill.style.display = 'inline-flex';
      const icon = pill.querySelector('i');
      const txt = pill.querySelector('.text');
      if (icon) icon.className = 'fas fa-circle-xmark';
      if (txt) txt.textContent = String(msg).slice(0, 200);
    }
  }
  window.addEventListener('error', (e) => surfaceError(e.message || 'Uncaught error'));
  window.addEventListener('unhandledrejection', (e) => {
    surfaceError('Unhandled: ' + ((e.reason && e.reason.message) || e.reason));
  });

  // ── DOM refs ──────────────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // Quote the executable portion of a command string if it contains spaces.
  // This keeps Windows user profile paths (e.g. C:\Users\CANDAN SINGH\...) intact.
  function quoteCommandIfNeeded(cmd) {
    if (!cmd) return cmd;
    const firstSpace = cmd.indexOf(' ');
    if (firstSpace === -1) return cmd;
    const exe = cmd.slice(0, firstSpace);
    const rest = cmd.slice(firstSpace + 1);
    if (exe.startsWith('"') || rest.startsWith('"')) return cmd;
    return `"${exe}" ${rest}`;
  }

  const screens = $$('.screen');
  const stepperDots = $$('.step-dot');
  const stepBadge = $('#stepBadge');
  const backBtn = $('#backBtn');
  const nextBtn = $('#nextBtn');
  const skipBtn = $('#skipBtn');
  const nav = $('#wizard .nav'); // the centered nav container

  // ── State ─────────────────────────────────────────────────────────
  const state = {
    step: 0,
    activeProvider: 'gemini',  // 'gemini' | 'openai' | 'openai-compatible'
    providers: {
      gemini: { apiKey: '', model: 'gemini-3.1-flash-lite' },
      openai: { apiKey: '', model: 'gpt-4o-mini' },
      'openai-compatible': { apiKey: '', model: '', baseUrl: '' }
    },
    geminiConfigured: false, // legacy: true if active provider has a key already in store
    speechProvider: null, // 'whisper' | 'azure' | 'skip'
    azureKey: '',
    azureRegion: '',
    whisperCmd: null,
    whisperDetected: false,
    skippingWhisper: false,
    modelDownloadChoice: null, // 'now' | 'later'
    modelDownloading: false,
    modelDownloaded: false,
    finished: false,
  };

  // Screens are: welcome → apikey → speech → whisper? → finish
  // The whisper screen is only visited if state.speechProvider === 'whisper'
  const stepScreens = ['welcome', 'apikey', 'speech'];

  // ── Step rendering ────────────────────────────────────────────────
  function totalSteps() {
    return stepScreens.length + (state.speechProvider === 'whisper' ? 1 : 0) + 1;
  }

  function refreshStepper() {
    const total = totalSteps();
    const current = state.step + 1;
    stepBadge.textContent = `Step ${current} of ${total}`;
    stepperDots.forEach((dot, i) => {
      dot.classList.remove('active', 'done');
      if (i < state.step) dot.classList.add('done');
      else if (i === state.step) dot.classList.add('active');
    });
  }

  function showScreen(name) {
    screens.forEach((s) => {
      s.classList.toggle('active', s.dataset.screen === name);
    });
    // Welcome screen uses an inline hero CTA — hide the regular nav row.
    const wizardEl = document.getElementById('wizard');
    if (wizardEl) {
      wizardEl.classList.toggle('welcome-active', name === 'welcome');
    }
    refreshStepper();
    backBtn.style.visibility = state.step === 0 ? 'hidden' : 'visible';
    // Reset next button state unless we're actively downloading a model
    if (name !== 'model-download' || !state.modelDownloading) {
      nextBtn.disabled = false;
      nextBtn.classList.remove('success');
      nextBtn.classList.add('primary');
    }
    // The primary action label changes by step
    if (name === 'welcome') nextBtn.innerHTML = 'Get started <i class="fas fa-arrow-right"></i>';
    else if (name === 'finish') nextBtn.innerHTML = 'Finish <i class="fas fa-check"></i>';
    else if (name === 'whisper') nextBtn.innerHTML = 'Continue <i class="fas fa-arrow-right"></i>';
    else nextBtn.innerHTML = 'Continue <i class="fas fa-arrow-right"></i>';
  }

  function navigate(direction) {
    const order = computeScreenOrder();
    const idx = order.indexOf(currentScreenName());
    const next = direction === 'next' ? idx + 1 : idx - 1;
    if (next < 0 || next >= order.length) return;
    state.step = orderScreenToStep(order[next]);
    showScreen(order[next]);
  }

  function currentScreenName() {
    const active = Array.from(screens).find((s) => s.classList.contains('active'));
    return active ? active.dataset.screen : 'welcome';
  }

  // Order depends on choices — e.g. whisper path inserts the install screen.
  function computeScreenOrder() {
    const out = ['welcome', 'apikey', 'speech'];
    if (state.speechProvider === 'whisper') out.push('whisper');
    if (state.speechProvider === 'whisper') out.push('model-download');
    out.push('finish');
    return out;
  }

  // Map a screen name to its position in the stepper (0..n).
  function orderScreenToStep(name) {
    return computeScreenOrder().indexOf(name);
  }

  // ── Validation gates before "Continue" ───────────────────────────
  function canAdvance() {
    const name = currentScreenName();
    switch (name) {
      case 'welcome':
        return true;
      case 'apikey': {
        const p = state.providers[state.activeProvider];
        if (!p) return false;
        if (state.activeProvider === 'gemini') {
          return !!p.apiKey.trim() || state.geminiConfigured;
        }
        if (state.activeProvider === 'openai') {
          return !!p.apiKey.trim() || state.geminiConfigured;
        }
        if (state.activeProvider === 'openai-compatible') {
          return !!p.apiKey.trim() && !!p.model.trim() && !!p.baseUrl.trim();
        }
        return false;
      }
      case 'speech':
        if (state.speechProvider === 'azure') {
          return !!state.azureKey.trim() && !!state.azureRegion.trim();
        }
        return !!state.speechProvider;
      case 'whisper':
        // Allow advancing whether whisper is detected OR user skipped
        return state.whisperDetected || state.skippingWhisper;
      case 'model-download':
        return !!state.modelDownloadChoice && !state.modelDownloading;
      case 'finish':
        return true;
      default:
        return true;
    }
  }

  // ── Wire up: AI Provider config (apikey screen) ──────────────────
  const providerSelect = $('#activeProvider');
  const providerGroups = $$('.provider-fields');
  const providerHint = $('#providerHint');
  const providerKeyLink = $('#providerKeyLink');
  const keyStatus = $('#keyStatus');

  // Per-provider field refs (looked up at boot so we can read/write them)
  const providerInputs = {
    gemini: { apiKey: $('#geminiKey'), model: $('#geminiModel'), baseUrl: null },
    openai: { apiKey: $('#openaiKey'), model: $('#openaiModel'), baseUrl: null },
    'openai-compatible': {
      apiKey: $('#openaiCompatKey'),
      model: $('#openaiCompatModel'),
      baseUrl: $('#openaiCompatBaseUrl'),
    },
  };

  // "Where to get a key" hint per provider
  const providerHints = {
    gemini: {
      url: 'https://aistudio.google.com/apikey',
      label: 'aistudio.google.com/apikey',
      html:
        'Don\'t have one? Get a free key at ' +
        '<a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">' +
        'aistudio.google.com/apikey</a>. Keys are stored locally — ' +
        'never sent anywhere except Google.',
    },
    openai: {
      url: 'https://platform.openai.com/api-keys',
      label: 'platform.openai.com/api-keys',
      html:
        'Don\'t have one? Create a key at ' +
        '<a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">' +
        'platform.openai.com/api-keys</a>. Keys are stored locally — ' +
        'never sent anywhere except OpenAI.',
    },
    'openai-compatible': {
      url: 'https://platform.deepseek.com',
      label: 'platform.deepseek.com',
      html:
        'Endpoint depends on your provider (e.g. <code>platform.deepseek.com</code> for DeepSeek). ' +
        'Keys are stored locally and only sent to your configured Base URL.',
    },
  };

  function setKeyStatus(state_, text) {
    keyStatus.className = `status-pill ${state_}`;
    keyStatus.style.display = 'inline-flex';
    const icon = keyStatus.querySelector('i');
    const txt = keyStatus.querySelector('.text');
    if (state_ === 'testing') {
      icon.className = 'fas fa-circle-notch fa-spin';
    } else if (state_ === 'success') {
      icon.className = 'fas fa-check-circle';
    } else if (state_ === 'error') {
      icon.className = 'fas fa-circle-xmark';
    } else {
      icon.className = 'fas fa-circle-info';
    }
    txt.textContent = text;
  }

  function refreshProviderVisibility() {
    providerGroups.forEach((g) => {
      g.style.display = g.dataset.provider === state.activeProvider ? '' : 'none';
    });
    if (providerHint && providerKeyLink) {
      const hint = providerHints[state.activeProvider];
      if (hint) {
        providerKeyLink.href = hint.url;
        providerKeyLink.textContent = hint.label;
        providerHint.innerHTML = hint.html;
      }
    }
  }

  // Sync a provider's inputs to/from the in-memory state
  function inputsToState() {
    const inputs = providerInputs[state.activeProvider];
    if (!inputs) return;
    const p = state.providers[state.activeProvider];
    if (inputs.apiKey) p.apiKey = inputs.apiKey.value.trim();
    if (inputs.model) p.model = inputs.model.value.trim();
    if (inputs.baseUrl) p.baseUrl = inputs.baseUrl.value.trim();
  }

  function stateToInputs() {
    Object.keys(providerInputs).forEach((pid) => {
      const inputs = providerInputs[pid];
      const p = state.providers[pid];
      if (!inputs || !p) return;
      if (inputs.apiKey) inputs.apiKey.value = p.apiKey || '';
      if (inputs.model) inputs.model.value = p.model || '';
      if (inputs.baseUrl) inputs.baseUrl.value = p.baseUrl || '';
    });
  }

  // Provider change handler
  providerSelect.addEventListener('change', () => {
    // Sync current provider's inputs back to state before switching
    inputsToState();
    state.activeProvider = providerSelect.value;
    // Clear status pill when switching providers (so old test doesn't linger)
    if (keyStatus) {
      keyStatus.style.display = 'none';
      keyStatus.classList.remove('success');
    }
    refreshProviderVisibility();
  });

  // Per-field input listeners (mirror to state, manage status pill on key entry)
  Object.keys(providerInputs).forEach((pid) => {
    const inputs = providerInputs[pid];
    ['apiKey', 'model', 'baseUrl'].forEach((field) => {
      const el = inputs[field];
      if (!el) return;
      el.addEventListener('input', () => {
        inputsToState();
        // Only flash the status pill on API-key edits of the active provider
        if (field === 'apiKey' && pid === state.activeProvider) {
          if (!el.value.trim()) {
            keyStatus.style.display = 'none';
          } else if (keyStatus.classList.contains('success')) {
            // Keep success state — they had a valid key, may be editing
          } else {
            setKeyStatus('idle', 'Key entered');
          }
        }
      });
    });
  });

  // Wire up each "show / hide" eye toggle by data-toggle attribute
  $$('.toggle-vis').forEach((btn) => {
    btn.addEventListener('click', () => {
      const inputId = btn.getAttribute('data-toggle');
      if (!inputId) return;
      const input = document.getElementById(inputId);
      if (!input) return;
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      btn.innerHTML = showing
        ? '<i class="fas fa-eye"></i>'
        : '<i class="fas fa-eye-slash"></i>';
    });
  });

  // Initial UI sync
  stateToInputs();
  providerSelect.value = state.activeProvider;
  refreshProviderVisibility();

  // ── Wire up: Speech choices ───────────────────────────────────────
  $$('#speechChoices .choice-card').forEach((card) => {
    card.addEventListener('click', () => {
      const value = card.dataset.value;
      state.speechProvider = value;
      $$('#speechChoices .choice-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
      const azurePanel = $('#azurePanel');
      azurePanel.style.display = value === 'azure' ? 'block' : 'none';
      if (value !== 'azure') {
        state.azureKey = '';
        state.azureRegion = '';
      }
    });
  });

  $('#azureKey').addEventListener('input', (e) => { state.azureKey = e.target.value.trim(); });
  $('#azureRegion').addEventListener('input', (e) => { state.azureRegion = e.target.value.trim(); });

  // ── Wire up: Whisper screen ───────────────────────────────────────
  const installLog = $('#installLog');
  const detectCmd = $('#detectCmd');
  const detectStatus = $('#detectStatus');
  const installList = $('#installList');
  const installCardTitle = $('#installCardTitle');

  function appendLog(line) {
    installLog.textContent += (installLog.textContent ? '\n' : '') + line;
    installLog.scrollTop = installLog.scrollHeight;
  }

  function setDetectStatus(state_, text) {
    detectStatus.className = `status-pill ${state_}`;
    const icon = detectStatus.querySelector('i');
    if (state_ === 'success') icon.className = 'fas fa-check-circle';
    else if (state_ === 'error') icon.className = 'fas fa-circle-xmark';
    else if (state_ === 'idle') icon.className = 'fas fa-circle-info';
    else icon.className = 'fas fa-circle-notch fa-spin';
    detectStatus.querySelector('.text').textContent = text;
  }

  async function runWhisperDetect() {
    detectCmd.textContent = 'scanning…';
    setDetectStatus('testing', 'Probing');
    try {
      const r = await window.electronAPI.detectWhisper();
      if (r.found) {
        state.whisperDetected = true;
        state.whisperCmd = r.command;
        detectCmd.textContent = r.command;
        setDetectStatus('success', `Found v${r.version || '?'}`);
        appendLog(`✓ Detected Whisper CLI: ${r.command}`);
      } else {
        detectCmd.textContent = 'not found';
        setDetectStatus('error', 'Not installed');
        appendLog('✗ No Whisper CLI detected on PATH or in known venvs');
      }
    } catch (e) {
      setDetectStatus('error', 'Probe failed');
      appendLog(`! Detection error: ${e.message || e}`);
    }
  }

  async function runWhisperInstall() {
    const btn = document.getElementById('installWhisperBtn');
    installLog.textContent = '';
    setDetectStatus('testing', 'Installing');
    appendLog('Starting install…');

    // Lock the button while installing so the user can't double-click
    // and spawn parallel installs. Change the label to "Installing…"
    // with a spinner so they see real progress.
    if (btn) {
      btn.disabled = true;
      btn.dataset.originalHtml = btn.dataset.originalHtml || btn.innerHTML;
      btn.innerHTML = '<span class="spinner"></span> Installing…';
    }

    // Subscribe to streamed progress lines from the main process.
    // `installWhisper()` only returns once install completes; live
    // output comes through `onInstallProgress` events.
    let progressHandler = null;
    if (window.electronAPI && window.electronAPI.onInstallProgress) {
      progressHandler = (line) => appendLog(line);
      window.electronAPI.onInstallProgress(progressHandler);
    }

    try {
      const r = await window.electronAPI.installWhisper();
      if (r.ok) {
        state.whisperDetected = true;
        state.whisperCmd = r.command;
        detectCmd.textContent = r.command;
        setDetectStatus('success', 'Installed');
        appendLog(`\n✓ ${r.message}`);
        if (btn) {
          // Keep button disabled — install is done. Show a checkmark
          // so the user sees the final state at a glance.
          btn.innerHTML = '<i class="fas fa-check-circle"></i> Installed';
          btn.classList.remove('primary');
          btn.classList.add('success');
        }
      } else {
        setDetectStatus('error', 'Install failed');
        appendLog(`\n✗ ${r.message}`);
        // Restore the button so the user can retry.
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = btn.dataset.originalHtml || '<i class="fas fa-download"></i> Install Whisper now';
        }
      }
    } catch (e) {
      setDetectStatus('error', 'Install error');
      appendLog(`\n! ${e.message || e}`);
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = btn.dataset.originalHtml || '<i class="fas fa-download"></i> Install Whisper now';
      }
    } finally {
      if (progressHandler && window.electronAPI.removeAllListeners) {
        try { window.electronAPI.removeAllListeners('install-progress'); } catch (_) { /* ignore */ }
      }
    }
  }

  // Whisper screen logic
  let whisperInitialized = false;
  function enterWhisperScreen() {
    if (whisperInitialized) return;
    whisperInitialized = true;
    const hints = {
      win32: {
        title: "We'll create a project-local venv and install openai-whisper",
        steps: [
          'Python 3.10+ must be on PATH (download from python.org if missing).',
          'A new <code>.venv-whisper\\</code> folder will be created in the app directory.',
          'Whisper will be installed into that venv (pip download, no admin rights needed).',
          'First transcription downloads the <code>small</code> model (~461 MB).',
        ],
      },
      darwin: {
        title: "We'll create a project-local venv and install openai-whisper",
        steps: [
          'Uses your existing Python 3 (install via Homebrew if missing).',
          'A new <code>.venv-whisper/</code> folder is created in the app data directory.',
          'Whisper installs into that venv — no <code>sudo</code> required.',
          'First transcription downloads the <code>small</code> model (~461 MB).',
        ],
      },
      other: {
        title: "We'll create a project-local venv and install openai-whisper",
        steps: [
          'Uses your system Python 3 (needs <code>python3-venv</code> on Debian/Ubuntu).',
          'A new <code>.venv-whisper/</code> folder is created in the app data directory.',
          'Whisper installs into that venv — avoids the externally-managed-environment error.',
          'First transcription downloads the <code>small</code> model (~461 MB).',
        ],
      },
    };
    const plat = navigator.platform.toLowerCase().includes('win')
      ? 'win32'
      : navigator.platform.toLowerCase().includes('mac')
        ? 'darwin'
        : 'other';
    const h = hints[plat];
    installCardTitle.textContent = h.title;
    installList.innerHTML = h.steps.map((s) => `<li>${s}</li>`).join('');
    runWhisperDetect();
  }

  // ── Wire up: Model Download screen ───────────────────────────────
  const modelDownloadLog = $('#modelDownloadLog');
  const modelDownloadChoices = $('#modelDownloadChoices');

  function appendModelLog(line) {
    modelDownloadLog.textContent += (modelDownloadLog.textContent ? '\n' : '') + line;
    modelDownloadLog.scrollTop = modelDownloadLog.scrollHeight;
  }

  let modelDownloadInitialized = false;
  function enterModelDownloadScreen() {
    if (!modelDownloadInitialized) {
      modelDownloadInitialized = true;

      // Set up choice card click handlers once
      $$('#modelDownloadChoices .choice-card').forEach((card) => {
        card.addEventListener('click', () => {
          const value = card.dataset.value;
          state.modelDownloadChoice = value;
          $$('#modelDownloadChoices .choice-card').forEach((c) => c.classList.remove('selected'));
          card.classList.add('selected');
          
          if (value === 'now') {
            // Start downloading the model immediately
            startModelDownload();
          } else {
            nextBtn.disabled = false;
          }
        });
      });
    }

    // Restore selection state when navigating back
    $$('#modelDownloadChoices .choice-card').forEach((card) => {
      card.classList.toggle('selected', card.dataset.value === state.modelDownloadChoice);
    });

    // Re-enable continue button if a choice has been made and not actively downloading
    if (state.modelDownloadChoice && !state.modelDownloading) {
      nextBtn.disabled = false;
    }
  }

  async function startModelDownload() {
    state.modelDownloading = true;
    nextBtn.disabled = true;
    nextBtn.innerHTML = '<span class="spinner"></span> Downloading…';

    appendModelLog('Starting model download…');

    let progressHandler = null;
    if (window.electronAPI && window.electronAPI.onInstallProgress) {
      progressHandler = (line) => appendModelLog(line);
      window.electronAPI.onInstallProgress(progressHandler);
    }

    try {
      const r = await window.electronAPI.downloadWhisperModel('small');
      state.modelDownloading = false;
      if (r.ok) {
        state.modelDownloaded = true;
        appendModelLog(`\n✓ Model downloaded successfully: ${r.path}`);
        nextBtn.disabled = false;
        nextBtn.classList.remove('primary');
        nextBtn.classList.add('success');
        nextBtn.innerHTML = '<i class="fas fa-check-circle"></i> Continue';
      } else {
        appendModelLog(`\n✗ Download failed: ${r.message}`);
        // Let user continue anyway; they'll download on first use
        nextBtn.disabled = false;
      }
    } catch (e) {
      state.modelDownloading = false;
      appendModelLog(`\n! Error: ${e.message || e}`);
      nextBtn.disabled = false;
    } finally {
      if (progressHandler && window.electronAPI.removeAllListeners) {
        try { window.electronAPI.removeAllListeners('install-progress'); } catch (_) { /* ignore */ }
      }
    }
  }

  // ── Wire up: Finish screen ────────────────────────────────────────
  function populateSummary() {
    const rows = [];
    const activeP = state.providers[state.activeProvider] || {};
    const isOpenAICompat = state.activeProvider === 'openai-compatible';
    const activeConfigured = !!(
      (activeP.apiKey && activeP.apiKey.trim()) &&
      (!isOpenAICompat || (activeP.model && activeP.model.trim() && activeP.baseUrl && activeP.baseUrl.trim()))
    );
    rows.push({
      label: `<i class="fas fa-key"></i> AI Provider (${state.activeProvider})`,
      value: (activeConfigured || state.geminiConfigured) ? 'Configured' : 'Missing',
      cls: (activeConfigured || state.geminiConfigured) ? 'ok' : 'skip',
    });
    if (state.speechProvider === 'whisper') {
      rows.push({
        label: '<i class="fas fa-microphone"></i> Speech',
        value: state.whisperDetected ? `Whisper (${state.whisperCmd || 'cli'})` : 'Whisper (not installed)',
        cls: state.whisperDetected ? 'ok' : 'skip',
      });
    } else if (state.speechProvider === 'azure') {
      rows.push({
        label: '<i class="fas fa-cloud"></i> Speech',
        value: 'Azure',
        cls: 'ok',
      });
    } else {
      rows.push({
        label: '<i class="fas fa-microphone"></i> Speech',
        value: 'Skipped (configure later)',
        cls: 'skip',
      });
    }
    rows.push({
      label: '<i class="fas fa-file-lines"></i> Config saved to',
      value: 'llm-providers.json',
      cls: 'ok',
    });
    $('#summaryList').innerHTML = rows
      .map((r) => `
        <div class="summary-row">
          <div class="label">${r.label}</div>
          <div class="value ${r.cls}">${r.value}</div>
        </div>
      `)
      .join('');
  }

  $('#starBtn').addEventListener('click', () => {
    if (window.electronAPI && window.electronAPI.openExternal) {
      window.electronAPI.openExternal('https://github.com/TechyCSR/OpenCluely');
    } else {
      window.open('https://github.com/TechyCSR/OpenCluely', '_blank');
    }
  });
  $('#skipStarBtn').addEventListener('click', () => {
    // No-op — just visual closure
  });

  // ── Wire up: Hero CTA (welcome screen) ────────────────────────────
  // The big inline "Get Started" button on the welcome screen reuses
  // the existing nav-button handler so all validation, persistence,
  // and navigation logic stays in one place.
  const heroCtaBtn = $('#heroCtaBtn');
  if (heroCtaBtn) {
    heroCtaBtn.addEventListener('click', () => nextBtn.click());
  }

  // ── Wire up: nav buttons ──────────────────────────────────────────
  nextBtn.addEventListener('click', async () => {
    const name = currentScreenName();
    if (!canAdvance()) {
      // Lightly nudge the user
      if (name === 'apikey') {
        const hintByProvider = {
          gemini: 'Enter a Gemini API key',
          openai: 'Enter an OpenAI API key',
          'openai-compatible': 'Enter key, model, and base URL',
        };
        setKeyStatus('error', hintByProvider[state.activeProvider] || 'Enter provider credentials');
      }
      return;
    }

    // Persist settings on apikey (saved progress so a crash doesn't lose the key).
    // If the main process rejected the provider switch (e.g. invalid config),
    // show why and STAY on this screen — otherwise the wizard would "finish",
    // write the first-run sentinel, and reopen on the next launch because the
    // active provider still has no key (the wizard-loop bug).
    if (name === 'apikey' && window.electronAPI) {
      inputsToState();
      console.log('[onboarding] saving provider config', { activeProvider: state.activeProvider });
      // 8s guard: if the main process never replies we must not freeze the
      // wizard silently — surface it so we know the hang is in the main
      // process (check the terminal for the [SAVE] trace).
      const savePromise = window.electronAPI.saveSettings({
        activeProvider: state.activeProvider,
        providers: state.providers,
      }).catch((e) => { surfaceError('saveSettings IPC failed: ' + (e && e.message)); return null; });
      const timeoutGuard = new Promise((resolve) => setTimeout(() => resolve({
        success: false,
        error: 'Save timed out: main process did not respond in 8s (see terminal [SAVE] logs)'
      }), 8000));
      const r = await Promise.race([savePromise, timeoutGuard]);
      console.log('[onboarding] save result', r && { success: r.success, error: r.error });
      if (r && r.success === false && r.error) {
        setKeyStatus('error', r.error);
        return;
      }
    }
    if (name === 'speech' && window.electronAPI) {
      try {
        const payload = {
          speechProvider:
            state.speechProvider === 'skip' ? 'whisper' : state.speechProvider,
        };
        if (state.speechProvider === 'azure') {
          payload.azureKey = state.azureKey;
          payload.azureRegion = state.azureRegion;
        }
        if (state.speechProvider === 'whisper' && state.whisperCmd) {
          payload.whisperCommand = quoteCommandIfNeeded(state.whisperCmd);
        }
        await window.electronAPI.saveSettings(payload);
      } catch (_) { /* surfaced elsewhere */ }
    }

    // Whisper screen: kick off detection on entry
    if (name === 'speech' && state.speechProvider === 'whisper') {
      // (deferred: will run via enterWhisperScreen)
    }

    // Whisper screen "Continue" — if user wants to skip install, mark and proceed
    if (name === 'whisper') {
      // Persist whatever whisper command we found (could be empty if skipped)
      if (window.electronAPI && state.whisperCmd) {
        try {
          await window.electronAPI.saveSettings({ whisperCommand: quoteCommandIfNeeded(state.whisperCmd) });
        } catch (_) { /* ignore */ }
      }
    }

    // Model download screen: persist choice
    if (name === 'model-download') {
      if (window.electronAPI && state.modelDownloadChoice) {
        try {
          await window.electronAPI.saveSettings({ whisperModelDownload: state.modelDownloadChoice });
        } catch (_) { /* ignore */ }
      }
    }

    // Finish: close onboarding
    if (name === 'finish') {
      try {
        await window.electronAPI.completeFirstRun();
      } catch (_) { /* ignore */ }
      try {
        await window.electronAPI.closeOnboarding();
      } catch (_) { /* ignore */ }
      state.finished = true;
      return;
    }

    // Move forward, with whisper-screen insertion handled by order logic
    const order = computeScreenOrder();
    const idx = order.indexOf(name);
    const nextName = order[idx + 1];
    if (!nextName) return;

    // Compute new step index
    state.step = orderScreenToStep(nextName);
    showScreen(nextName);
    if (nextName === 'whisper') enterWhisperScreen();
    if (nextName === 'model-download') enterModelDownloadScreen();
    if (nextName === 'finish') populateSummary();

    // Re-render stepper with new total
    refreshStepper();
  });

  backBtn.addEventListener('click', () => {
    const name = currentScreenName();
    const order = computeScreenOrder();
    const idx = order.indexOf(name);
    const prevName = order[idx - 1];
    if (!prevName) return;
    state.step = orderScreenToStep(prevName);
    showScreen(prevName);
  });

  // Skip button: only shown on the whisper screen, lets user skip install
  // even if the CLI isn't present (they can configure later).
  function refreshSkipVisibility() {
    skipBtn.style.display = currentScreenName() === 'whisper' && !state.whisperDetected
      ? 'inline-flex'
      : 'none';
  }

  // Hook into showScreen to keep skip visibility in sync
  const _origShowScreen = showScreen;
  showScreen = function (name) {
    _origShowScreen(name);
    refreshSkipVisibility();
    refreshStepper();
  };

  skipBtn.addEventListener('click', () => {
    state.skippingWhisper = true;
    // Jump to finish without installing
    const order = computeScreenOrder();
    const finishName = order[order.length - 1];
    state.step = orderScreenToStep(finishName);
    showScreen(finishName);
    populateSummary();
  });

  // ── Manual install button (added dynamically) ─────────────────────
  function addManualInstallButton() {
    if (document.getElementById('installWhisperBtn')) return;
    const btn = document.createElement('button');
    btn.id = 'installWhisperBtn';
    btn.type = 'button';
    btn.className = 'btn primary';
    btn.style.marginTop = '12px';
    btn.innerHTML = '<i class="fas fa-download"></i> Install Whisper now';
    btn.addEventListener('click', runWhisperInstall);
    document.querySelector('[data-screen="whisper"]').appendChild(btn);
  }

  // Show install button after detection runs and finds nothing
  const _origDetect = runWhisperDetect;
  runWhisperDetect = async function () {
    await _origDetect();
    if (!state.whisperDetected) addManualInstallButton();
  };

  // ── Boot ──────────────────────────────────────────────────────────
  showScreen('welcome');

  // Pre-populate provider config from existing JSON store (if any) so users
  // with a partial config don't have to retype.
  if (window.electronAPI && window.electronAPI.getFirstRunStatus) {
    window.electronAPI.getFirstRunStatus().then((s) => {
      if (!s) return;
      // Mirror active provider + any pre-existing keys
      if (s.activeProvider && state.providers[s.activeProvider]) {
        state.activeProvider = s.activeProvider;
        providerSelect.value = state.activeProvider;
      }
      if (s.activeConfigured) {
        state.geminiConfigured = true;
        setKeyStatus('success', 'Already configured — click Continue');
        // Show "configured" placeholder on each API key field
        Object.keys(providerInputs).forEach((pid) => {
          const apiKeyEl = providerInputs[pid] && providerInputs[pid].apiKey;
          if (apiKeyEl) apiKeyEl.placeholder = '•••••••••••••••• (already set)';
        });
      }
      refreshProviderVisibility();
    }).catch(() => {});
  }
})();
