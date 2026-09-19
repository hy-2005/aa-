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
    this.initializationError = null;
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
        baseURL: this.baseUrl,
        // Keys stay in the main process; Azure globals confuse SDK detection.
        dangerouslyAllowBrowser: !!process.versions.node && process.type !== 'renderer',
        // 网络韧性：连接抖动 / 代理切换时由 SDK 自动做指数退避重试；
        // 单请求 120s 超时。此前出现的 "Connection error." 经排查为网络瞬断
        // （同期机器直连 API 实测可达），加固后此类短抖动可自愈。
        timeout: 120000,
        maxRetries: 3
      });
      this.isInitialized = true;
      logger.info('OpenAI-compatible client initialized', {
        baseUrl: this.baseUrl, model: this.model
      });
      return true;
    } catch (e) {
      this.initializationError = e;
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
    if (!this.isInitialized) {
      if (this.initializationError) throw this.initializationError;
      if (this.apiKey) throw new Error('兼容服务配置已读取，但模型客户端未初始化，请检查模型与接口地址。');
      throw new NoApiKeyError(this.id);
    }
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
        { type: 'text', text: prompt || `请分析这张图片中的题目并用中文回答。` },
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

  // If the model burned its entire output budget on thinking, the stripped
  // answer is empty — returning that would render a blank, auto-collapsed
  // response window that looks like a bug. Fail loudly instead.
  _assertNonEmpty(response, fullText) {
    if (response && response.trim()) return response;
    const hadThink = /<think>/i.test(String(fullText || ''));
    throw new Error(hadThink
      ? '模型把输出额度全部用在了思考上，没有产生回答。请再次按 Ctrl+Alt+D 重试。'
      : '模型返回了空回答，请重试。');
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

  // ── Multi-image: all queued captures in ONE request ──

  _buildMultiImageMessages({ images, prompt, activeSkill, sessionMemory, programmingLanguage }) {
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
    const parts = [{
      type: 'text',
      text: prompt || `这里有 ${images.length} 张连续截图，共同组成同一道题。请综合所有截图内容还原完整题目，然后用中文给出完整分析与解答。`
    }];
    for (const img of images) {
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${img.mimeType || 'image/png'};base64,${img.imageBuffer.toString('base64')}` }
      });
    }
    messages.push({ role: 'user', content: parts });
    return messages;
  }

  async processImages(images, { activeSkill, sessionMemory = [], programmingLanguage = null, prompt = null } = {}) {
    this._assertReady();
    const start = Date.now();
    this.requestCount++;
    try {
      const messages = this._buildMultiImageMessages({ images, prompt, activeSkill, sessionMemory, programmingLanguage });
      const resp = await this.client.chat.completions.create({
        model: this.model,
        messages,
        temperature: 0.7,
        max_tokens: 8192
      });
      const raw = resp.choices?.[0]?.message?.content || '';
      const response = this._assertNonEmpty(this._stripThinking(raw).trim(), raw);
      return {
        response,
        metadata: {
          skill: activeSkill, programmingLanguage,
          processingTime: Date.now() - start, requestId: this.requestCount,
          usedFallback: false, isImageAnalysis: true, imageCount: images.length, provider: this.id
        }
      };
    } catch (e) {
      this.errorCount++;
      throw e;
    }
  }

  async processImagesStream(images, { activeSkill, sessionMemory = [], programmingLanguage = null, prompt = null } = {}, onDelta = null) {
    this._assertReady();
    const start = Date.now();
    this.requestCount++;
    try {
      const messages = this._buildMultiImageMessages({ images, prompt, activeSkill, sessionMemory, programmingLanguage });
      const stream = await this.client.chat.completions.create({
        model: this.model,
        messages,
        temperature: 0.7,
        max_tokens: 8192,
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
        response: this._assertNonEmpty(emitted.trim(), fullText),
        metadata: {
          skill: activeSkill, programmingLanguage,
          processingTime: Date.now() - start, requestId: this.requestCount,
          usedFallback: false, streamed: true, isImageAnalysis: true, imageCount: images.length, provider: this.id
        }
      };
    } catch (e) {
      this.errorCount++;
      logger.warn('OpenAI-compatible multi-image streaming failed, falling back to non-streaming', { error: e.message });
      return this.processImages(images, { activeSkill, sessionMemory, programmingLanguage, prompt });
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
        max_tokens: 8192
      });
      const raw = resp.choices?.[0]?.message?.content || '';
      const response = this._assertNonEmpty(this._stripThinking(raw).trim(), raw);
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
        max_tokens: 8192,
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
        response: this._assertNonEmpty(emitted.trim(), fullText),
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
