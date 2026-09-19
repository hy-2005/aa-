const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * First-run detection and onboarding helper.
 *
 * Responsibilities:
 *   - Decide whether this is the user's first launch of 向日葵助手
 *   - Auto-create a default `.env` from `env.example` if one is missing
 *   - Report whether a Gemini API key is configured (the only required key)
 *   - Persist a "first-run completed" sentinel so we don't nag on every launch
 *
 * The settings UI is the source of truth for API-key entry. This module
 * only handles the bootstrap so the user has something to edit on first
 * launch.
 */
class FirstRunManager {
  constructor(options = {}) {
    this.cwd = options.cwd || process.cwd();
    this.envPath = options.envPath || path.join(this.cwd, '.env');
    this.sentinelPath = options.sentinelPath || path.join(this.cwd, '.opencluely-firstrun-completed');
    // Canonical path of the providers JSON — passed in from main.js so this
    // module reads the exact file the store singleton uses. (Deriving it
    // from envPath could point at the project dir in dev while the store
    // lives in userData — and calling providersStore.init() with that path
    // would silently re-point the singleton at the wrong directory.)
    this.providersJsonPath = options.providersJsonPath ||
      path.join(path.dirname(this.envPath), 'llm-providers.json');
    this.logger = options.logger || console;
  }

  // Read the providers JSON directly from disk. Deliberately does NOT touch
  // the providers.store singleton — see the constructor comment.
  _readProvidersState() {
    try {
      const raw = fs.readFileSync(this.providersJsonPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !parsed.providers) {
        return { activeProvider: 'gemini', providers: {} };
      }
      return parsed;
    } catch (_) {
      return { activeProvider: 'gemini', providers: {} };
    }
  }

  /**
   * Returns true if this looks like a fresh install — no .env, no
   * sentinel file, or .env exists but has no Gemini key.
   */
  needsOnboarding() {
    if (!fs.existsSync(this.sentinelPath)) return true;
    if (!fs.existsSync(this.providersJsonPath)) return true;
    try {
      const state = this._readProvidersState();
      const active = state.providers[state.activeProvider];
      return !active || !active.apiKey || !String(active.apiKey).trim();
    } catch (_) {
      return true;
    }
  }

  /**
   * Ensures a .env file exists. If not, copies env.example (if available)
   * or writes a minimal template.
   */
  ensureEnv() {
    if (fs.existsSync(this.envPath)) {
      return { created: false, path: this.envPath };
    }

    const template = this._readTemplate();
    const dir = path.dirname(this.envPath);
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.envPath, template, 'utf8');
      try {
        fs.chmodSync(this.envPath, 0o600);
      } catch (_) { /* best effort */ }
      return { created: true, path: this.envPath };
    } catch (e) {
      this.logger.error && this.logger.error('Failed to create .env', { error: e.message });
      return { created: false, path: this.envPath, error: e.message };
    }
  }

  /**
   * Mark the first-run as completed so we don't keep prompting.
   */
  markCompleted() {
    try {
      fs.writeFileSync(this.sentinelPath, new Date().toISOString(), 'utf8');
    } catch (e) {
      this.logger.warn && this.logger.warn('Could not write first-run sentinel', {
        error: e.message
      });
    }
  }

  /**
   * Get a snapshot of the current setup state for UI / logging.
   */
  getStatus() {
    const providerState = this._readProvidersState();
    const active = providerState.providers[providerState.activeProvider] || {};
    return {
      envExists: fs.existsSync(this.envPath),
      sentinelExists: fs.existsSync(this.sentinelPath),
      jsonExists: fs.existsSync(this.providersJsonPath),
      activeProvider: providerState.activeProvider,
      activeConfigured: !!(active.apiKey && String(active.apiKey).trim()),
      azureConfigured: !!(this._readEnv().AZURE_SPEECH_KEY || '').trim() && !!(this._readEnv().AZURE_SPEECH_REGION || '').trim(),
      whisperConfigured: !!(this._readEnv().WHISPER_COMMAND || '').trim(),
      needsOnboarding: this.needsOnboarding()
    };
  }

  _readEnv() {
    try {
      const content = fs.readFileSync(this.envPath, 'utf8');
      const result = {};
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();

        // If the value is quoted, find the matching closing quote and
        // take everything between. Anything after the closing quote is
        // treated as trailing whitespace/comment.
        if (value.startsWith('"') || value.startsWith("'")) {
          const quote = value[0];
          const closeIdx = value.indexOf(quote, 1);
          if (closeIdx !== -1) {
            value = value.slice(1, closeIdx);
          }
        } else {
          // Unquoted: strip trailing inline comment (a " #" sequence).
          const hashIdx = value.indexOf(' #');
          if (hashIdx !== -1) value = value.slice(0, hashIdx).trim();
        }

        result[key] = value;
      }
      return result;
    } catch (_) {
      return {};
    }
  }

  _readTemplate() {
    // Prefer env.example if it ships in the project; otherwise write a
    // minimal template that the user can extend.
    const candidates = [
      path.join(this.cwd, 'env.example'),
      path.join(__dirname, '..', '..', 'env.example'),
    ];
    for (const candidate of candidates) {
      try {
        return fs.readFileSync(candidate, 'utf8');
      } catch (_) { /* try next */ }
    }
    return [
      '# 向日葵助手 configuration',
      '# Add your Google Gemini API key below — the app picks it up immediately.',
      '# Get a key from: https://aistudio.google.com/',
      '',
      'GEMINI_API_KEY=your_gemini_api_key_here',
      '',
      '# Speech provider: "whisper" (local) or "azure" (cloud).',
      '# WHISPER_COMMAND is auto-set to the project-local venv when you',
      '# install Whisper through the onboarding wizard, so no PATH change',
      '# or restart is needed.',
      'SPEECH_PROVIDER=whisper',
      'WHISPER_COMMAND=whisper',
      '# WHISPER_MODEL_DIR is optional. Leave it unset and the app stores model',
      '# weights in a stable app-data folder. Set an absolute path to override.',
      '# WHISPER_MODEL_DIR=',
      'WHISPER_MODEL=small',
      'WHISPER_LANGUAGE=auto',
      'WHISPER_DEVICE=auto',
      'WHISPER_PYTHON=',
      'WHISPER_CAPTURE_MODE=vad',
      'WHISPER_RESPONSE_TARGET=both',
      'WHISPER_MANUAL_MAX_MS=90000',
      'WHISPER_GPU_IDLE_MS=60000',
      'WHISPER_SEGMENT_MS=4000',
      ''
    ].join(os.EOL);
  }
}

module.exports = FirstRunManager;
module.exports.FirstRunManager = FirstRunManager;
