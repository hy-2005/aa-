const { GoogleGenAI } = require('@google/genai');
const logger = require('../../../core/logger').createServiceLogger('GeminiAdapter');
const config = require('../../../core/config');
const { promptLoader } = require('../../../../prompt-loader');
const { NoApiKeyError, normalizeError, withTimeout } = require('../errors');

const TEST_TIMEOUT_MS = 8000;

class GeminiAdapter {
  constructor({ providerId, config: providerConfig }) {
    this.id = providerId || 'gemini';
    this.client = null;
    this.model = (providerConfig && providerConfig.model) || config.get('llm.gemini.model');
    this.apiKey = (providerConfig && providerConfig.apiKey) || '';
    this.isInitialized = false;
    this.requestCount = 0;
    this.errorCount = 0;
  }

  initialize() {
    const apiKey = this.apiKey;
    if (!apiKey) {
      logger.warn('Gemini API key not configured');
      this.isInitialized = false;
      return false;
    }
    try {
      this.client = new GoogleGenAI({ apiKey });
      this.model = this.model || config.get('llm.gemini.model');
      this.isInitialized = true;
      logger.info('Gemini AI client initialized', { model: this.model });
      return true;
    } catch (e) {
      logger.error('Failed to initialize Gemini client', { error: e.message });
      this.isInitialized = false;
      return false;
    }
  }

  updateApiKey(apiKey) {
    this.apiKey = apiKey;
    return this.initialize();
  }

  getGenerationConfig(overrides = {}) {
    const defaults = config.get('llm.gemini.generation') || {};
    const fallback = {
      temperature: 0.7, topK: 40, topP: 0.95, maxOutputTokens: 4096,
      thinkingConfig: { thinkingBudget: 0 }
    };
    const merged = { ...fallback, ...defaults, ...overrides };
    return Object.fromEntries(
      Object.entries(merged).filter(([, v]) => v !== undefined && v !== null)
    );
  }

  applyGenerationDefaults(request, overrides = {}) {
    request.generationConfig = this.getGenerationConfig({ ...(request.generationConfig || {}), ...overrides });
    return request;
  }

  extractTextFromCandidates(response) {
    if (response && typeof response.text === 'string' && response.text.trim().length > 0) {
      return {
        text: response.text.trim(),
        candidate: response.candidates?.[0] || null,
        finishReason: response.candidates?.[0]?.finishReason || null
      };
    }
    const candidates = Array.isArray(response?.candidates)
      ? response.candidates
      : Array.isArray(response) ? response : [];
    if (!candidates.length) throw new Error('No candidates in Gemini response');
    const withText = candidates.find(c =>
      Array.isArray(c?.content?.parts) &&
      c.content.parts.some(p => typeof p.text === 'string' && p.text.trim())
    );
    if (!withText) {
      const reasons = candidates.map(c => c.finishReason || 'unknown').join(', ');
      throw new Error(`No text parts in candidates. Finish reasons: ${reasons}`);
    }
    const text = withText.content.parts
      .filter(p => typeof p.text === 'string' && p.text.trim())
      .map(p => p.text.trim()).join('\n');
    return { text, candidate: withText, finishReason: withText.finishReason || null };
  }

  // ── Public methods (the unified LLM interface) ──

  async processText(text, { activeSkill, sessionMemory = [], programmingLanguage = null } = {}) {
    this._assertReady();
    const start = Date.now();
    this.requestCount++;
    try {
      const geminiRequest = this.buildGeminiRequest(text, activeSkill, sessionMemory, programmingLanguage);
      const preferAlternative = !!config.get('llm.gemini.enableFallbackMethod');
      let response;
      try {
        response = preferAlternative
          ? await this.executeAlternativeRequest(geminiRequest)
          : await this.executeRequest(geminiRequest);
      } catch (e) {
        const secondary = preferAlternative ? this.executeRequest.bind(this) : this.executeAlternativeRequest.bind(this);
        response = await secondary(geminiRequest);
      }
      const finalResponse = programmingLanguage
        ? this.enforceProgrammingLanguage(response, programmingLanguage)
        : response;
      logger.logPerformance('LLM text processing', start, {
        activeSkill, textLength: text.length, responseLength: finalResponse.length
      });
      return {
        response: finalResponse,
        metadata: {
          skill: activeSkill, programmingLanguage,
          processingTime: Date.now() - start, requestId: this.requestCount,
          usedFallback: false, provider: this.id
        }
      };
    } catch (e) {
      this.errorCount++;
      if (config.get('llm.gemini.fallbackEnabled')) {
        return this._generateFallbackResponse(text, activeSkill);
      }
      throw e;
    }
  }

  async processTextStream(text, { activeSkill, sessionMemory = [], programmingLanguage = null } = {}, onDelta = null) {
    this._assertReady();
    const start = Date.now();
    this.requestCount++;
    try {
      const geminiRequest = this.buildGeminiRequest(text, activeSkill, sessionMemory, programmingLanguage);
      const fullText = await this.executeStreamingRequest(geminiRequest, (delta) => {
        if (typeof onDelta === 'function' && delta) onDelta(delta);
      });
      const finalResponse = programmingLanguage
        ? this.enforceProgrammingLanguage(fullText, programmingLanguage)
        : fullText;
      return {
        response: finalResponse,
        metadata: {
          skill: activeSkill, programmingLanguage,
          processingTime: Date.now() - start, requestId: this.requestCount,
          usedFallback: false, streamed: true, provider: this.id
        }
      };
    } catch (e) {
      logger.warn('Streaming text failed, falling back to non-streaming', { error: e.message });
      return this.processText(text, { activeSkill, sessionMemory, programmingLanguage });
    }
  }

  async processImage({ imageBuffer, mimeType, prompt, activeSkill, sessionMemory = [], programmingLanguage = null }) {
    this._assertReady();
    if (!Buffer.isBuffer(imageBuffer)) throw new Error('Invalid image buffer');
    const start = Date.now();
    this.requestCount++;
    try {
      const skillPrompt = promptLoader.getSkillPrompt(activeSkill, programmingLanguage) || '';
      const base64 = imageBuffer.toString('base64');
      const request = {
        contents: [{
          role: 'user',
          parts: [
            { text: prompt || this.formatImageInstruction(activeSkill, programmingLanguage) },
            { inlineData: { data: base64, mimeType } }
          ]
        }]
      };
      this.applyGenerationDefaults(request);
      if (skillPrompt && skillPrompt.trim()) request.systemInstruction = { parts: [{ text: skillPrompt }] };

      const preferAlternative = !!config.get('llm.gemini.enableFallbackMethod');
      let responseText;
      try {
        responseText = preferAlternative
          ? await this.executeAlternativeRequest(request)
          : await this.executeRequest(request);
      } catch (e) {
        const secondary = preferAlternative ? this.executeRequest.bind(this) : this.executeAlternativeRequest.bind(this);
        responseText = await secondary(request);
      }
      const finalResponse = programmingLanguage
        ? this.enforceProgrammingLanguage(responseText, programmingLanguage)
        : responseText;
      return {
        response: finalResponse,
        metadata: {
          skill: activeSkill, programmingLanguage,
          processingTime: Date.now() - start, requestId: this.requestCount,
          usedFallback: false, isImageAnalysis: true, mimeType, provider: this.id
        }
      };
    } catch (e) {
      this.errorCount++;
      if (config.get('llm.gemini.fallbackEnabled')) {
        return this._generateFallbackResponse('[image]', activeSkill);
      }
      throw e;
    }
  }

  async processImageStream({ imageBuffer, mimeType, prompt, activeSkill, sessionMemory = [], programmingLanguage = null }, onDelta = null) {
    this._assertReady();
    const start = Date.now();
    this.requestCount++;
    try {
      const skillPrompt = promptLoader.getSkillPrompt(activeSkill, programmingLanguage) || '';
      const base64 = imageBuffer.toString('base64');
      const geminiRequest = {
        contents: [{
          role: 'user',
          parts: [
            { text: prompt || this.formatImageInstruction(activeSkill, programmingLanguage) },
            { inlineData: { data: base64, mimeType } }
          ]
        }]
      };
      this.applyGenerationDefaults(geminiRequest);
      if (skillPrompt && skillPrompt.trim()) geminiRequest.systemInstruction = { parts: [{ text: skillPrompt }] };

      const fullText = await this.executeStreamingRequest(geminiRequest, (delta) => {
        if (typeof onDelta === 'function' && delta) onDelta(delta);
      });
      const finalResponse = programmingLanguage
        ? this.enforceProgrammingLanguage(fullText, programmingLanguage)
        : fullText;
      return {
        response: finalResponse,
        metadata: {
          skill: activeSkill, programmingLanguage,
          processingTime: Date.now() - start, requestId: this.requestCount,
          usedFallback: false, streamed: true, isImageAnalysis: true, mimeType, provider: this.id
        }
      };
    } catch (e) {
      logger.warn('Streaming image failed, falling back to non-streaming', { error: e.message });
      return this.processImage({ imageBuffer, mimeType, prompt, activeSkill, sessionMemory, programmingLanguage });
    }
  }

  // ── Multi-image: all queued captures in ONE request (Ctrl+Shift+D) ──

  async processImagesStream(images, { activeSkill, sessionMemory = [], programmingLanguage = null, prompt = null } = {}, onDelta = null) {
    this._assertReady();
    const start = Date.now();
    this.requestCount++;
    try {
      const skillPrompt = promptLoader.getSkillPrompt(activeSkill, programmingLanguage) || '';
      const textPart = {
        text: prompt || `这里有 ${images.length} 张连续截图，共同组成同一道题。请综合所有截图内容还原完整题目，然后用中文给出完整分析与解答。`
      };
      const imageParts = images.map((img) => ({
        inlineData: { data: img.imageBuffer.toString('base64'), mimeType: img.mimeType || 'image/png' }
      }));
      const geminiRequest = {
        contents: [{ role: 'user', parts: [textPart, ...imageParts] }]
      };
      this.applyGenerationDefaults(geminiRequest);
      if (skillPrompt && skillPrompt.trim()) geminiRequest.systemInstruction = { parts: [{ text: skillPrompt }] };

      const fullText = await this.executeStreamingRequest(geminiRequest, (delta) => {
        if (typeof onDelta === 'function' && delta) onDelta(delta);
      });
      const finalResponse = programmingLanguage
        ? this.enforceProgrammingLanguage(fullText, programmingLanguage)
        : fullText;
      return {
        response: finalResponse,
        metadata: {
          skill: activeSkill, programmingLanguage,
          processingTime: Date.now() - start, requestId: this.requestCount,
          usedFallback: false, streamed: true, isImageAnalysis: true, imageCount: images.length, provider: this.id
        }
      };
    } catch (e) {
      logger.warn('Gemini multi-image streaming failed', { error: e.message });
      throw e;
    }
  }

  async testConnection() {
    if (!this.isInitialized) return { success: false, error: 'Service not initialized', errorType: 'NO_KEY' };
    try {
      const generationConfig = this.getGenerationConfig({ temperature: 0, maxOutputTokens: 64 });
      const fallbackModels = config.get('llm.gemini.fallbackModels') || [];
      const modelsToTry = [this.model, ...fallbackModels];
      let lastError = null;
      for (const modelName of modelsToTry) {
        try {
          const start = Date.now();
          // Hard timeout: see OpenAI-compatible adapter for the rationale.
          const result = await withTimeout(
            this.client.models.generateContent({
              model: modelName,
              contents: 'Test connection. Please respond with "OK".',
              config: generationConfig
            }),
            TEST_TIMEOUT_MS,
            this.id,
            'test'
          );
          // withTimeout returns a failure object if it won the race
          if (result && result.success === false) return result;
          const { text } = this.extractTextFromCandidates(result);
          return {
            success: true,
            response: text,
            latency: Date.now() - start,
            model: modelName,
            provider: this.id
          };
        } catch (e) {
          lastError = e;
          const isUnavailable = (e.message || '').match(/503|UNAVAILABLE|high demand|quota|rate limit/);
          if (!isUnavailable && modelName === this.model) break;
        }
      }
      throw lastError || new Error('Connection test failed on all models');
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

  // ── Private helpers (preserved from original llm.service.js) ──

  _assertReady() {
    if (!this.isInitialized) {
      throw new NoApiKeyError(this.id);
    }
  }

  _generateFallbackResponse(text, activeSkill) {
    const responses = {
      dsa: 'This appears to be a data structures and algorithms problem. Consider breaking it down and identifying the appropriate algorithm.',
      'system-design': 'For system design, consider scalability, reliability, and trade-offs between approaches.',
      programming: 'This looks like a programming challenge. Focus on requirements, edge cases, and complexity.',
      default: 'I can help analyze this content. Please ensure your API key is properly configured.'
    };
    return {
      response: responses[activeSkill] || responses.default,
      metadata: { skill: activeSkill, processingTime: 0, usedFallback: true, provider: this.id }
    };
  }

  formatImageInstruction(activeSkill, programmingLanguage) {
    const langNote = programmingLanguage ? ` 代码只使用 ${programmingLanguage.toUpperCase()}。` : '';
    return `请分析这张图片中的题目，简要提取问题，并给出最优解法、思路讲解和最终代码。所有说明文字必须使用中文回答。${langNote}`;
  }

  buildGeminiRequest(text, activeSkill, sessionMemory, programmingLanguage) {
    const sessionManager = require('../../../managers/session.manager');
    if (sessionManager && typeof sessionManager.getConversationHistory === 'function') {
      const conversationHistory = sessionManager.getConversationHistory(15);
      const skillContext = sessionManager.getSkillContext(activeSkill, programmingLanguage);
      return this.buildGeminiRequestWithHistory(text, activeSkill, conversationHistory, skillContext, programmingLanguage);
    }
    const requestComponents = promptLoader.getRequestComponents(activeSkill, text, sessionMemory, programmingLanguage);
    const request = { contents: [] };
    this.applyGenerationDefaults(request);
    if (requestComponents.shouldUseModelMemory && requestComponents.skillPrompt) {
      request.systemInstruction = { parts: [{ text: requestComponents.skillPrompt }] };
    }
    request.contents.push({ role: 'user', parts: [{ text: this.formatUserMessage(text, activeSkill) }] });
    return request;
  }

  buildGeminiRequestWithHistory(text, activeSkill, conversationHistory, skillContext, programmingLanguage) {
    const request = { contents: [] };
    this.applyGenerationDefaults(request);
    if (skillContext.skillPrompt) {
      request.systemInstruction = { parts: [{ text: skillContext.skillPrompt }] };
    }
    const conversationContents = conversationHistory
      .filter(e => e.role !== 'system' && e.content && typeof e.content === 'string' && e.content.trim())
      .map(e => ({ role: e.role === 'model' ? 'model' : 'user', parts: [{ text: e.content.trim() }] }));
    request.contents.push(...conversationContents);
    const formatted = this.formatUserMessage(text, activeSkill);
    if (!formatted || !formatted.trim()) throw new Error('Failed to format user message');
    request.contents.push({ role: 'user', parts: [{ text: formatted }] });
    return request;
  }

  buildIntelligentTranscriptionRequest(text, activeSkill, sessionMemory, programmingLanguage) {
    const cleanText = text && typeof text === 'string' ? text.trim() : '';
    if (!cleanText) throw new Error('Empty transcription text');
    const sessionManager = require('../../../managers/session.manager');
    if (sessionManager && typeof sessionManager.getConversationHistory === 'function') {
      const conversationHistory = sessionManager.getConversationHistory(10);
      const skillContext = sessionManager.getSkillContext(activeSkill, programmingLanguage);
      return this.buildIntelligentTranscriptionRequestWithHistory(cleanText, activeSkill, conversationHistory, skillContext, programmingLanguage);
    }
    const request = { contents: [] };
    this.applyGenerationDefaults(request);
    request.systemInstruction = { parts: [{ text: this.getIntelligentTranscriptionPrompt(activeSkill, programmingLanguage) }] };
    request.contents.push({ role: 'user', parts: [{ text: cleanText }] });
    return request;
  }

  buildIntelligentTranscriptionRequestWithHistory(text, activeSkill, conversationHistory, skillContext, programmingLanguage) {
    const request = { contents: [] };
    this.applyGenerationDefaults(request);
    request.systemInstruction = { parts: [{ text: this.getIntelligentTranscriptionPrompt(activeSkill, programmingLanguage) }] };
    const conversationContents = conversationHistory
      .filter(e => e.role !== 'system' && e.content && typeof e.content === 'string' && e.content.trim())
      .slice(-8)
      .map(e => ({ role: e.role === 'model' ? 'model' : 'user', parts: [{ text: e.content.trim() }] }));
    request.contents.push(...conversationContents);
    request.contents.push({ role: 'user', parts: [{ text: text.trim() }] });
    if (!request.contents.length) throw new Error('No valid content');
    return request;
  }

  getIntelligentTranscriptionPrompt(activeSkill, programmingLanguage) {
    let prompt = `# Intelligent Transcription Response System\n\nAssume you are asked a question in ${activeSkill.toUpperCase()} mode. Always respond to the point.`;
    if (programmingLanguage) {
      prompt += `\n\nCODING CONTEXT: Respond ONLY in ${programmingLanguage}. Use triple backticks with language tag.`;
    }
    return prompt;
  }

  formatUserMessage(text, activeSkill) {
    return `Context: ${activeSkill.toUpperCase()} analysis request\n\nText to analyze:\n${text}`;
  }

  async processTranscriptionWithIntelligentResponse(text, activeSkill, sessionMemory = [], programmingLanguage = null) {
    return this.processText(text, { activeSkill, sessionMemory, programmingLanguage });
  }

  async processTranscriptionWithIntelligentResponseStream(text, activeSkill, sessionMemory = [], programmingLanguage = null, onDelta = null) {
    return this.processTextStream(text, { activeSkill, sessionMemory, programmingLanguage }, onDelta);
  }

  enforceProgrammingLanguage(text, programmingLanguage) {
    try {
      if (!text || !programmingLanguage) return text;
      const norm = String(programmingLanguage).toLowerCase();
      const map = { cpp: 'cpp', c: 'c', python: 'python', java: 'java', javascript: 'javascript', js: 'javascript' };
      const tag = map[norm] || norm || 'text';
      return text
        .replace(/```([^\n]*)\n/g, (m, info) => {
          const cur = (info || '').trim();
          return cur.split(/\s+/)[0].toLowerCase() === tag ? m : '```' + tag + '\n';
        })
        .replace(/~~~([^\n]*)\n/g, () => '```' + tag + '\n');
    } catch (_) { return text; }
  }

  async executeRequest(geminiRequest) {
    const maxRetries = config.get('llm.gemini.maxRetries');
    const timeout = config.get('llm.gemini.timeout');
    const fallbackModels = config.get('llm.gemini.fallbackModels') || [];
    const modelsToTry = [this.model, ...fallbackModels];
    let lastError = null;
    for (const modelName of modelsToTry) {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const timeoutPromise = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeout));
          const result = await Promise.race([
            this.client.models.generateContent({
              model: modelName,
              contents: geminiRequest.contents,
              config: geminiRequest.generationConfig,
              systemInstruction: geminiRequest.systemInstruction
            }),
            timeoutPromise
          ]);
          if (!result) throw new Error('Empty response');
          const { text, finishReason } = this.extractTextFromCandidates(result);
          if (finishReason === 'MAX_TOKENS') {
            logger.warn('Gemini response max tokens', { model: modelName });
          }
          return text;
        } catch (e) {
          lastError = e;
          if (attempt < maxRetries) {
            await this.delay(1500 * attempt + Math.random() * 1000);
          }
        }
      }
    }
    throw lastError || new Error('Gemini request failed');
  }

  async executeAlternativeRequest(geminiRequest) {
    const https = require('https');
    const fallbackModels = config.get('llm.gemini.fallbackModels') || [];
    const modelsToTry = [this.model, ...fallbackModels];
    let lastError = null;
    for (const modelName of modelsToTry) {
      try {
        return await this._executeAlternativeRequestForModel(geminiRequest, modelName, this.apiKey);
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError || new Error('Alternative request failed');
  }

  _executeAlternativeRequestForModel(geminiRequest, modelName, apiKey) {
    const https = require('https');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
    const postData = JSON.stringify(geminiRequest);
    const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: config.get('llm.gemini.timeout'),
      agent
    };
    return new Promise((resolve, reject) => {
      const req = https.request(url, options, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          try {
            const response = JSON.parse(data);
            const { text } = this.extractTextFromCandidates(response);
            resolve(text.trim());
          } catch (e) {
            reject(new Error(`Failed to parse: ${e.message}`));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(postData);
      req.end();
    });
  }

  async executeStreamingRequest(geminiRequest, onDelta) {
    const maxRetries = config.get('llm.gemini.maxRetries');
    const fallbackModels = config.get('llm.gemini.fallbackModels') || [];
    const modelsToTry = [this.model, ...fallbackModels];
    let lastError = null;
    for (const modelName of modelsToTry) {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          return await this._streamRequestForModel(geminiRequest, modelName, this.apiKey, onDelta);
        } catch (e) {
          lastError = e;
          if (attempt < maxRetries) await this.delay(1500 * attempt + Math.random() * 1000);
        }
      }
    }
    throw lastError || new Error('Streaming failed');
  }

  _streamRequestForModel(geminiRequest, modelName, apiKey, onDelta) {
    const https = require('https');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:streamGenerateContent?alt=sse`;
    const postData = JSON.stringify(geminiRequest);
    const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: config.get('llm.gemini.timeout'),
      agent
    };
    return new Promise((resolve, reject) => {
      const req = https.request(url, options, (res) => {
        if (res.statusCode !== 200) {
          let errBody = '';
          res.on('data', (c) => { errBody += c; });
          res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${errBody}`)));
          return;
        }
        let fullText = '';
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buffer += chunk;
          let idx;
          while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
              const json = JSON.parse(payload);
              const piece = this._extractChunkText(json);
              if (piece) {
                fullText += piece;
                if (typeof onDelta === 'function') onDelta(piece);
              }
            } catch (_) {}
          }
        });
        res.on('end', () => resolve(fullText.trim()));
        res.on('error', (e) => reject(new Error(`Stream error: ${e.message}`)));
      });
      req.on('error', (e) => reject(new Error(`Stream req failed: ${e.message}`)));
      req.on('timeout', () => { req.destroy(); reject(new Error('Stream timeout')); });
      req.write(postData);
      req.end();
    });
  }

  _extractChunkText(chunk) {
    try {
      const t = chunk && chunk.text;
      if (typeof t === 'string') return t;
    } catch (_) {}
    try {
      const parts = (chunk && chunk.candidates && chunk.candidates[0] &&
        chunk.candidates[0].content && chunk.candidates[0].content.parts) || [];
      return parts.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
    } catch (_) { return ''; }
  }

  delay(ms) { return new Promise(r => setTimeout(r, ms)); }
}

logger.info('Gemini adapter module loaded');

module.exports = GeminiAdapter;
