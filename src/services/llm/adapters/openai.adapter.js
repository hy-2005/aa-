const OpenAI = require('openai');
const logger = require('../../../core/logger').createServiceLogger('OpenAIAdapter');
const config = require('../../../core/config');
const { promptLoader } = require('../../../../prompt-loader');
const { NoApiKeyError, normalizeError, ImageNotSupportedError, withTimeout } = require('../errors');

const TEST_TIMEOUT_MS = 8000;

class OpenAIAdapter {
  constructor({ providerId, config: providerConfig }) {
    this.id = providerId || 'openai';
    this.apiKey = (providerConfig && providerConfig.apiKey) || '';
    this.model = (providerConfig && providerConfig.model) || 'gpt-4o-mini';
    this.client = null;
    this.isInitialized = false;
    this.requestCount = 0;
    this.errorCount = 0;
  }

  initialize() {
    if (!this.apiKey) {
      logger.warn('OpenAI API key not configured');
      this.isInitialized = false;
      return false;
    }
    try {
      this.client = new OpenAI({ apiKey: this.apiKey });
      this.isInitialized = true;
      logger.info('OpenAI client initialized', { model: this.model });
      return true;
    } catch (e) {
      logger.error('Failed to initialize OpenAI client', { error: e.message });
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

  _buildImageMessages({ imageBuffer, mimeType, prompt, activeSkill, sessionMemory, programmingLanguage }) {
    const messages = [];
    const skillPrompt = promptLoader.getSkillPrompt(activeSkill, programmingLanguage);
    if (skillPrompt && skillPrompt.trim()) {
      messages.push({ role: 'system', content: skillPrompt });
    }
    const base64 = imageBuffer.toString('base64');
    const dataUrl = `data:${mimeType};base64,${base64}`;
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: prompt || `Analyze this image for a ${activeSkill} question.` },
        { type: 'image_url', image_url: { url: dataUrl } }
      ]
    });
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
      logger.warn('OpenAI streaming failed, falling back to non-streaming', { error: e.message });
      return this.processText(text, { activeSkill, sessionMemory, programmingLanguage });
    }
  }

  async processImage({ imageBuffer, mimeType, prompt, activeSkill, sessionMemory = [], programmingLanguage = null }) {
    this._assertReady();
    const start = Date.now();
    this.requestCount++;
    try {
      const messages = this._buildImageMessages({ imageBuffer, mimeType, prompt, activeSkill, sessionMemory, programmingLanguage });
      const resp = await this.client.chat.completions.create({
        model: this.model,
        messages,
        temperature: 0.7,
        max_tokens: 4096
      });
      const response = resp.choices?.[0]?.message?.content || '';
      return {
        response,
        metadata: {
          skill: activeSkill, programmingLanguage,
          processingTime: Date.now() - start, requestId: this.requestCount,
          usedFallback: false, isImageAnalysis: true, mimeType, provider: this.id
        }
      };
    } catch (e) {
      this.errorCount++;
      throw e;
    }
  }

  async processImageStream({ imageBuffer, mimeType, prompt, activeSkill, sessionMemory = [], programmingLanguage = null }, onDelta = null) {
    this._assertReady();
    const start = Date.now();
    this.requestCount++;
    try {
      const messages = this._buildImageMessages({ imageBuffer, mimeType, prompt, activeSkill, sessionMemory, programmingLanguage });
      const stream = await this.client.chat.completions.create({
        model: this.model,
        messages,
        temperature: 0.7,
        max_tokens: 4096,
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
          usedFallback: false, streamed: true, isImageAnalysis: true, mimeType, provider: this.id
        }
      };
    } catch (e) {
      this.errorCount++;
      logger.warn('OpenAI image streaming failed, falling back to non-streaming', { error: e.message });
      return this.processImage({ imageBuffer, mimeType, prompt, activeSkill, sessionMemory, programmingLanguage });
    }
  }

  async testConnection() {
    if (!this.isInitialized) return { success: false, error: 'Service not initialized', errorType: 'NO_KEY' };
    try {
      const start = Date.now();
      // Hard timeout: see OpenAI-compatible adapter for the rationale.
      const resp = await withTimeout(
        this.client.chat.completions.create({
          model: this.model,
          messages: [{ role: 'user', content: 'Test connection. Please respond with "OK".' }],
          max_tokens: 16
        }),
        TEST_TIMEOUT_MS,
        this.id,
        'test'
      );
      if (resp && resp.success === false) return resp;
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

logger.info('OpenAI adapter module loaded');

module.exports = OpenAIAdapter;
