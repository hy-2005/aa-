const logger = require('../core/logger').createServiceLogger('LLMService');
const router = require('./llm/llm-router');
const { NoApiKeyError, ImageNotSupportedError, normalizeError } = require('./llm/errors');

class LLMService {
  constructor() {
    this.requestCount = 0;
    this.errorCount = 0;
    // Note: not initialized here — orchestrator delegates to router.
    // Legacy callers that check `this.isInitialized` get a derived value.
  }

  // ── Legacy compat ──
  get isInitialized() {
    const a = router.getActive();
    return !!(a && a.isInitialized);
  }

  initializeClient() {
    const a = router.getActive();
    if (a && typeof a.initialize === 'function') {
      return a.initialize();
    }
    return false;
  }

  updateApiKey(apiKey) {
    const a = router.getActive();
    if (a && typeof a.updateApiKey === 'function') {
      return a.updateApiKey(apiKey);
    }
    logger.warn('Cannot updateApiKey: no active adapter');
    return false;
  }

  // ── New unified entry points ──
  async processText(text, opts) {
    return this._delegate('processText', [text, opts]);
  }

  async processTextStream(text, opts, onDelta) {
    return this._delegate('processTextStream', [text, opts, onDelta]);
  }

  async processImage(opts) {
    return this._delegate('processImage', [opts]);
  }

  async processImageStream(opts, onDelta) {
    return this._delegate('processImageStream', [opts, onDelta]);
  }

  async testConnection() {
    const a = router.getActive();
    if (!a) {
      return { success: false, error: 'No provider configured', errorType: 'NO_PROVIDER' };
    }
    return a.testConnection();
  }

  getStats() {
    const a = router.getActive();
    return {
      isInitialized: this.isInitialized,
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      successRate: this.requestCount > 0 ? ((this.requestCount - this.errorCount) / this.requestCount) * 100 : 0,
      activeProvider: router.getActiveProviderId(),
      provider: a ? a.getStats() : null
    };
  }

  // ── Legacy method signatures (kept for backward compat with main.js call sites) ──

  async processTextWithSkill(text, activeSkill, sessionMemory = [], programmingLanguage = null) {
    return this.processText(text, { activeSkill, sessionMemory, programmingLanguage });
  }

  async processTextWithSkillStream(text, activeSkill, sessionMemory = [], programmingLanguage = null, onDelta = null) {
    return this.processTextStream(text, { activeSkill, sessionMemory, programmingLanguage }, onDelta);
  }

  async processImageWithSkill(imageBuffer, mimeType, activeSkill, sessionMemory = [], programmingLanguage = null) {
    return this.processImage({ imageBuffer, mimeType, activeSkill, sessionMemory, programmingLanguage });
  }

  async processImageWithSkillStream(imageBuffer, mimeType, activeSkill, sessionMemory = [], programmingLanguage = null, onDelta = null) {
    return this.processImageStream({ imageBuffer, mimeType, activeSkill, sessionMemory, programmingLanguage }, onDelta);
  }

  async processTranscriptionWithIntelligentResponse(text, activeSkill, sessionMemory = [], programmingLanguage = null) {
    return this.processText(text, { activeSkill, sessionMemory, programmingLanguage });
  }

  async processTranscriptionWithIntelligentResponseStream(text, activeSkill, sessionMemory = [], programmingLanguage = null, onDelta = null) {
    return this.processTextStream(text, { activeSkill, sessionMemory, programmingLanguage }, onDelta);
  }

  // ── Internals ──

  async _delegate(method, args) {
    this.requestCount++;
    const a = router.getActive();
    if (!a) {
      const err = new NoApiKeyError(router.getActiveProviderId() || 'unknown');
      logger.error('No active adapter', { activeProvider: router.getActiveProviderId() });
      throw err;
    }
    try {
      return await a[method](...args);
    } catch (e) {
      this.errorCount++;
      logger.error('LLM call failed', {
        method,
        provider: router.getActiveProviderId(),
        error: e.message
      });
      throw e;
    }
  }
}

logger.info('LLM service orchestrator loaded');

module.exports = new LLMService();