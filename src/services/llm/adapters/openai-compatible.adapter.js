const OpenAI = require('openai');
const logger = require('../../../core/logger').createServiceLogger('OpenAICompatibleAdapter');
const { NoApiKeyError, normalizeError, withTimeout } = require('../errors');
const { promptLoader } = require('../../../../prompt-loader');

const TEST_TIMEOUT_MS = 8000;

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

  // Reasoning models (MiniMax-M3, DeepSeek-R1, …) emit <think>…</think>
  // blocks. Users want the answer, not the scratchpad, so strip closed
  // blocks and drop the tail of a still-open block.
  _stripThinking(text) {
    let out = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '');
    const open = out.indexOf('<think>');
    if (open !== -1) out = out.slice(0, open);
    return out;
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
      const response = this._stripThinking(resp.choices?.[0]?.message?.content || '').trim();
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
      // Emit only post-thinking text: keep the full accumulated text and,
      // after every chunk, emit the diff of the stripped view. Nothing
      // inside a think block ever reaches the UI, even mid-stream.
      let fullText = '';
      let emitted = '';
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content || '';
        if (delta) {
          fullText += delta;
          const stripped = this._stripThinking(fullText);
          if (stripped.length > emitted.length && stripped.startsWith(emitted)) {
            onDelta && onDelta(stripped.slice(emitted.length));
            emitted = stripped;
          }
        }
      }
      return {
        response: emitted.trim(),
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

  // Vision via image_url data URLs. Many compatible providers support this
  // (MiniMax-M3, Qwen-VL, GLM-4V, …). Providers that don't will surface a
  // normal API error, which flows to the UI error path.
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
      const response = this._stripThinking(resp.choices?.[0]?.message?.content || '').trim();
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
      let emitted = '';
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content || '';
        if (delta) {
          fullText += delta;
          const stripped = this._stripThinking(fullText);
          if (stripped.length > emitted.length && stripped.startsWith(emitted)) {
            onDelta && onDelta(stripped.slice(emitted.length));
            emitted = stripped;
          }
        }
      }
      return {
        response: emitted.trim(),
        metadata: {
          skill: activeSkill, programmingLanguage,
          processingTime: Date.now() - start, requestId: this.requestCount,
          usedFallback: false, streamed: true, isImageAnalysis: true, mimeType, provider: this.id
        }
      };
    } catch (e) {
      this.errorCount++;
      logger.warn('OpenAI-compatible image streaming failed, falling back to non-streaming', { error: e.message });
      return this.processImage({ imageBuffer, mimeType, prompt, activeSkill, sessionMemory, programmingLanguage });
    }
  }

  async testConnection() {
    if (!this.isInitialized) return { success: false, error: 'Service not initialized', errorType: 'NO_KEY' };
    try {
      const start = Date.now();
      // Hard timeout: an unreachable baseUrl would otherwise hang the IPC
      // handler for the SDK's default timeout (~10 minutes), surfacing as
      // "Electron not responding" in the UI.
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
      // withTimeout already returned a failure object if it won the race
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

logger.info('OpenAI-compatible adapter module loaded');

module.exports = OpenAICompatibleAdapter;