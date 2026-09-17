const OpenAI = require('openai');
const logger = require('../../../core/logger').createServiceLogger('OpenAICompatibleAdapter');
const { NoApiKeyError, normalizeError, ImageNotSupportedError } = require('../errors');
const { promptLoader } = require('../../../../prompt-loader');

class OpenAICompatibleAdapter {
  constructor({ providerId, config: providerConfig }) {
    this.id = providerId || 'openai-compatible';
    this.apiKey = (providerConfig && providerConfig.apiKey) || '';
    this.model = (providerConfig && providerConfig.model) || '';
    this.baseUrl = (providerConfig && providerConfig.baseUrl) || '';
    this.client = null;
    this.isInitialized = false;
    this.requestCount = 0;
    this.errorCount = 0;
  }

  initialize() {
    if (!this.apiKey) {
      logger.warn('OpenAI-compatible API key not configured');
      this.isInitialized = false;
      return false;
    }
    if (!this.baseUrl) {
      logger.warn('OpenAI-compatible baseUrl not configured');
      this.isInitialized = false;
      return false;
    }
    if (!this.model) {
      logger.warn('OpenAI-compatible model not configured');
      this.isInitialized = false;
      return false;
    }
    try {
      this.client = new OpenAI({
        apiKey: this.apiKey,
        baseURL: this.baseUrl
      });
      this.isInitialized = true;
      logger.info('OpenAI-compatible client initialized', {
        baseUrl: this.baseUrl, model: this.model
      });
      return true;
    } catch (e) {
      logger.error('Failed to initialize OpenAI-compatible client', { error: e.message });
      this.isInitialized = false;
      return false;
    }
  }

  updateApiKey(apiKey) {
    this.apiKey = apiKey;
    return this.initialize();
  }

  _assertReady() {
    if (!this.isInitialized) throw new NoApiKeyError(this.id);
  }

  _buildMessages(text, activeSkill, sessionMemory, programmingLanguage) {
    const messages = [];
    const skillPrompt = promptLoader.getSkillPrompt(activeSkill, programmingLanguage);
    if (skillPrompt && skillPrompt.trim()) {
      messages.push({ role: 'system', content: skillPrompt });
    }
    if (Array.isArray(sessionMemory)) {
      for (const m of sessionMemory) {
        if (m && m.role && m.content && (m.role === 'user' || m.role === 'assistant')) {
          messages.push({ role: m.role, content: m.content });
        }
      }
    }
    messages.push({ role: 'user', content: text });
    return messages;
  }

  async processText(text, { activeSkill, sessionMemory = [], programmingLanguage = null } = {}) {
    this._assertReady();
    const start = Date.now();
    this.requestCount++;
    try {
      const messages = this._buildMessages(text, activeSkill, sessionMemory, programmingLanguage);
      const resp = await this.client.chat.completions.create({
        model: this.model,
        messages,
        temperature: 0.7
      });
      const response = resp.choices?.[0]?.message?.content || '';
      return {
        response,
        metadata: {
          skill: activeSkill, programmingLanguage,
          processingTime: Date.now() - start, requestId: this.requestCount,
          usedFallback: false, provider: this.id
        }
      };
    } catch (e) {
      this.errorCount++;
      throw e;
    }
  }

  async processTextStream(text, { activeSkill, sessionMemory = [], programmingLanguage = null } = {}, onDelta = null) {
    this._assertReady();
    const start = Date.now();
    this.requestCount++;
    try {
      const messages = this._buildMessages(text, activeSkill, sessionMemory, programmingLanguage);
      const stream = await this.client.chat.completions.create({
        model: this.model,
        messages,
        temperature: 0.7,
        stream: true
      });
      let fullText = '';
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content || '';
        if (delta) {
          fullText += delta;
          if (typeof onDelta === 'function') onDelta(delta);
        }
      }
      return {
        response: fullText,
        metadata: {
          skill: activeSkill, programmingLanguage,
          processingTime: Date.now() - start, requestId: this.requestCount,
          usedFallback: false, streamed: true, provider: this.id
        }
      };
    } catch (e) {
      this.errorCount++;
      logger.warn('OpenAI-compatible streaming failed, falling back to non-streaming', { error: e.message });
      return this.processText(text, { activeSkill, sessionMemory, programmingLanguage });
    }
  }

  async processImage(opts) {
    throw new ImageNotSupportedError(this.id);
  }

  async processImageStream(opts, onDelta) {
    throw new ImageNotSupportedError(this.id);
  }

  async testConnection() {
    if (!this.isInitialized) return { success: false, error: 'Service not initialized', errorType: 'NO_KEY' };
    try {
      const start = Date.now();
      const resp = await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: 'user', content: 'Test connection. Please respond with "OK".' }],
        max_tokens: 16
      });
      const text = resp.choices?.[0]?.message?.content || '';
      return { success: true, response: text, latency: Date.now() - start, model: this.model, provider: this.id };
    } catch (e) {
      const norm = normalizeError(e, this.id);
      return { success: false, error: norm.userMessage, errorType: norm.type, errorAnalysis: norm };
    }
  }

  getStats() {
    return {
      isInitialized: this.isInitialized,
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      successRate: this.requestCount > 0 ? ((this.requestCount - this.errorCount) / this.requestCount) * 100 : 0,
      provider: this.id
    };
  }
}

logger.info('OpenAI-compatible adapter module loaded');

module.exports = OpenAICompatibleAdapter;