const logger = require('../../core/logger').createServiceLogger('LLMErrors');

class NoApiKeyError extends Error {
  constructor(providerId) {
    super(`未配置服务商 "${providerId}" 的 API 密钥，请打开设置添加。`);
    this.name = 'NoApiKeyError';
    this.provider = providerId;
    this.retryable = false;
  }
}

class ImageNotSupportedError extends Error {
  constructor(providerId) {
    super(`服务商 "${providerId}" 不支持图片分析，请在设置中切换到 Gemini 或 OpenAI。`);
    this.name = 'ImageNotSupportedError';
    this.provider = providerId;
    this.retryable = false;
  }
}

class StreamNotSupportedError extends Error {
  constructor(providerId) {
    super(`服务商 "${providerId}" 不支持流式输出。`);
    this.name = 'StreamNotSupportedError';
    this.provider = providerId;
    this.retryable = false;
  }
}

function classifyNetworkError(rawMessage) {
  const msg = (rawMessage || '').toLowerCase();
  if (msg.includes('fetch failed') || msg.includes('network error') ||
      msg.includes('enotfound') || msg.includes('econnrefused') ||
      msg.includes('timeout') || msg.includes('etimedout')) {
    return 'NETWORK_ERROR';
  }
  return null;
}

function classifyAuthError(rawMessage, statusCode) {
  const msg = (rawMessage || '').toLowerCase();
  if (statusCode === 401 || statusCode === 403 ||
      msg.includes('unauthorized') || msg.includes('invalid api key') ||
      msg.includes('forbidden') || msg.includes('authentication')) {
    return 'AUTH_ERROR';
  }
  return null;
}

function classifyRateLimitError(rawMessage, statusCode) {
  const msg = (rawMessage || '').toLowerCase();
  if (statusCode === 429 ||
      msg.includes('quota') || msg.includes('rate limit') ||
      msg.includes('too many requests')) {
    return 'RATE_LIMIT_ERROR';
  }
  return null;
}

function classifyModelError(rawMessage, statusCode) {
  const msg = (rawMessage || '').toLowerCase();
  if (statusCode === 404 ||
      msg.includes('model') && (msg.includes('not found') || msg.includes('does not exist'))) {
    return 'MODEL_ERROR';
  }
  return null;
}

function normalizeError(rawError, providerId) {
  const message = (rawError && rawError.message) || String(rawError || '');
  const statusCode = rawError && (rawError.status || rawError.statusCode) || null;

  let type =
    classifyNetworkError(message) ||
    classifyAuthError(message, statusCode) ||
    classifyRateLimitError(message, statusCode) ||
    classifyModelError(message, statusCode);

  if (!type) {
    type = 'UNKNOWN';
  }

  const retryable = type === 'NETWORK_ERROR' || type === 'TIMEOUT_ERROR' || type === 'RATE_LIMIT_ERROR';

  return {
    type,
    provider: providerId,
    userMessage: _friendlyTestError(rawError, providerId, { type }),
    technicalMessage: message,
    retryable,
    statusCode
  };
}

function _friendlyTestError(rawError, providerId, analysis) {
  const type = analysis && analysis.type;
  const raw = (rawError && rawError.message || '').toLowerCase();

  if (type === 'NETWORK_ERROR' || raw.includes('fetch failed') || raw.includes('enotfound')) {
    return `无法连接 ${providerId} 服务器，请检查网络连接。`;
  }
  if (type === 'AUTH_ERROR' || raw.includes('api key') || raw.includes('401') || raw.includes('403')) {
    return `${providerId} 的 API 密钥无效，请在设置中核对密钥。`;
  }
  if (type === 'RATE_LIMIT_ERROR' || raw.includes('429') || raw.includes('quota')) {
    return `${providerId} 限流或配额已用尽，请稍后再试或检查账单。`;
  }
  if (type === 'MODEL_ERROR' || (raw.includes('model') && raw.includes('not found'))) {
    return `${providerId} 配置的模型不可用，请在设置中更换模型。`;
  }
  if (type === 'TIMEOUT_ERROR' || raw.includes('timeout') || raw.includes('timed out')) {
    return `${providerId} 超时未响应，请检查接口地址和网络。`;
  }
  if (raw.includes('503') || raw.includes('unavailable') || raw.includes('high demand')) {
    return `${providerId} 服务繁忙，请稍后再试。`;
  }
  return (rawError && rawError.message) || '连接失败';
}

/**
 * Race a promise against a hard timeout. If the promise doesn't settle within
 * `ms` milliseconds, return a normalized TIMEOUT_ERROR instead of letting the
 * caller wait indefinitely. The underlying promise is left dangling — Node's
 * event loop will GC the rejected result once it finally settles, but the
 * caller (UI/IPC handler) gets a clean, fast response.
 *
 * Why this exists: the OpenAI SDK's default timeout is ~10 minutes for an
 * unreachable host. Without this, a wrong baseUrl or dead proxy hangs the
 * main process IPC handler long enough for Windows to surface the
 * "Electron not responding" dialog and lock the UI.
 */
function withTimeout(promise, ms, providerId, label) {
  let timer;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => {
      resolve({
        success: false,
        error: `${providerId} ${label || '请求'}在 ${ms}ms 后超时，请检查接口地址和网络。`,
        errorType: 'TIMEOUT_ERROR',
        timedOut: true
      });
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

logger.info('LLM errors module loaded');

module.exports = {
  NoApiKeyError,
  ImageNotSupportedError,
  StreamNotSupportedError,
  normalizeError,
  _friendlyTestError,
  withTimeout
};
