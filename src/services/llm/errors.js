const logger = require('../../core/logger').createServiceLogger('LLMErrors');

class NoApiKeyError extends Error {
  constructor(providerId) {
    super(`No API key configured for provider "${providerId}". Open Settings and add a key.`);
    this.name = 'NoApiKeyError';
    this.provider = providerId;
    this.retryable = false;
  }
}

class ImageNotSupportedError extends Error {
  constructor(providerId) {
    super(`Image analysis is not supported by provider "${providerId}". Switch to Gemini or OpenAI in Settings.`);
    this.name = 'ImageNotSupportedError';
    this.provider = providerId;
    this.retryable = false;
  }
}

class StreamNotSupportedError extends Error {
  constructor(providerId) {
    super(`Streaming is not supported by provider "${providerId}".`);
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
    return `Cannot reach ${providerId} servers. Check your internet connection.`;
  }
  if (type === 'AUTH_ERROR' || raw.includes('api key') || raw.includes('401') || raw.includes('403')) {
    return `Invalid API key for ${providerId}. Double-check the key in Settings.`;
  }
  if (type === 'RATE_LIMIT_ERROR' || raw.includes('429') || raw.includes('quota')) {
    return `Rate limit or quota exceeded for ${providerId}. Wait or check your billing.`;
  }
  if (type === 'MODEL_ERROR' || raw.includes('model') && raw.includes('not found')) {
    return `The configured model for ${providerId} is unavailable. Try a different model in Settings.`;
  }
  if (raw.includes('503') || raw.includes('unavailable') || raw.includes('high demand')) {
    return `${providerId} is experiencing high demand. Please wait and try again.`;
  }
  return (rawError && rawError.message) || 'Connection failed';
}

logger.info('LLM errors module loaded');

module.exports = {
  NoApiKeyError,
  ImageNotSupportedError,
  StreamNotSupportedError,
  normalizeError,
  _friendlyTestError
};
