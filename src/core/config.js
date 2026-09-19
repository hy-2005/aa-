const path = require('path');
const os = require('os');

class ConfigManager {
  constructor() {
    this.env = process.env.NODE_ENV || 'development';
    this.appDataDir = path.join(os.homedir(), '.SunflowerAssistant');
    this.loadConfiguration();
  }

  loadConfiguration() {
    this.config = {
      app: {
        name: '向日葵助手',
        version: '1.0.0',
        processTitle: '向日葵助手',
        dataDir: this.appDataDir,
        isDevelopment: this.env === 'development',
        isProduction: this.env === 'production'
      },
      
      window: {
        defaultWidth: 400,
        defaultHeight: 600,
        minWidth: 300,
        minHeight: 400,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          enableRemoteModule: false,
          preload: path.join(__dirname, '../../preload.js')
        }
      },

      ocr: {
        language: 'eng',
        tempDir: os.tmpdir(),
        cleanupDelay: 5000
      },

      llm: {
        gemini: {
          model: 'gemini-3.1-flash-lite',
          fallbackModels: ['gemini-2.5-flash-lite', 'gemini-3.5-flash'],
          maxRetries: 3,
          timeout: 30000,
          fallbackEnabled: true,
          enableFallbackMethod: true,
          generation: {
            temperature: 0.7,
            topK: 32,
            topP: 0.9,
            maxOutputTokens: 4096,
            thinkingConfig: { thinkingBudget: 0 }
          }
        }
      },

      speech: {
        provider: 'azure',
        azure: {
          language: 'en-US',
          enableDictation: true,
          enableAudioLogging: false,
          outputFormat: 'detailed'
        },
        whisper: {
          model: 'small',
          language: 'auto',
          // segmentMs is the legacy fixed-window size and now acts as the
          // hard upper bound for a single utterance when VAD is enabled.
          segmentMs: 4000,
          // Voice-activity-detection driven segmentation. Instead of cutting
          // audio on a blind timer (which splits sentences mid-word), we flush
          // a segment when the speaker pauses. This makes transcription align
          // with natural utterance boundaries.
          vadEnabled: true,
          // Trailing silence (ms) that ends an utterance and triggers a flush.
          silenceHangoverMs: 700,
          // Minimum accumulated speech (ms) before a pause counts as an
          // utterance — guards against coughs/clicks producing empty flushes.
          minUtteranceMs: 350,
          // Hard cap (ms): force-flush a long monologue even without a pause.
          maxUtteranceMs: 15000,
          // Pre-roll (ms) of audio kept before speech onset so the first
          // syllable isn't clipped when we start capturing.
          preRollMs: 300,
          // Absolute RMS energy floor (normalized 0..1). Energy below this is
          // always treated as silence regardless of the adaptive noise floor.
          vadEnergyFloor: 0.008
        }
      },

      session: {
        maxMemorySize: 1000,
        compressionThreshold: 500,
        clearOnRestart: false
      },

      stealth: {
        hideFromDock: true,
        noAttachConsole: true,
        disguiseProcess: true
      }
    };
  }

  get(keyPath) {
    return keyPath.split('.').reduce((obj, key) => obj?.[key], this.config);
  }

  set(keyPath, value) {
    const keys = keyPath.split('.');
    const lastKey = keys.pop();
    const target = keys.reduce((obj, key) => obj[key] = obj[key] || {}, this.config);
    target[lastKey] = value;
  }

  getApiKey(service) {
    const envKey = `${service.toUpperCase()}_API_KEY`;
    return process.env[envKey];
  }

  getActiveProviderId() {
    // 优先读 router 状态；如果 router 没初始化，回落到环境变量
    try {
      const router = require('../services/llm/llm-router');
      if (router.getActiveProviderId && router.getActiveProviderId()) {
        return router.getActiveProviderId();
      }
    } catch (_) {}
    return process.env.LLM_PROVIDER || 'gemini';
  }

  getProviderField(providerId, fieldKey) {
    const envMap = {
      gemini: { apiKey: 'GEMINI_API_KEY', model: 'GEMINI_MODEL' },
      openai: { apiKey: 'OPENAI_API_KEY', model: 'OPENAI_MODEL' },
      'openai-compatible': { apiKey: 'OPENAI_COMPAT_API_KEY', model: 'OPENAI_COMPAT_MODEL', baseUrl: 'OPENAI_COMPAT_BASE_URL' }
    };
    const envName = envMap[providerId] && envMap[providerId][fieldKey];
    return envName ? process.env[envName] : undefined;
  }

  getAllProviders() {
    const registry = require('../services/llm/provider-registry');
    return registry.listProviders().map(p => ({
      id: p.id,
      label: p.label,
      fields: p.fields.map(f => ({
        ...f,
        value: this.getProviderField(p.id, f.key) || ''
      })),
      supports: p.supports
    }));
  }

  isFeatureEnabled(feature) {
    return this.get(`features.${feature}`) !== false;
  }
}

module.exports = new ConfigManager();
