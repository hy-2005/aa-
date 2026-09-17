const registry = require('./provider-registry');
const logger = require('../../core/logger').createServiceLogger('LLMRouter');

let _store = null;
let _activeAdapter = null;
let _activeProviderId = null;

function init({ providersStore }) {
  _store = providersStore;
  _reloadFromStore();
  logger.info('LLM router initialized', { activeProvider: _activeProviderId });
}

function reload() {
  _reloadFromStore();
  logger.info('LLM router reloaded', { activeProvider: _activeProviderId });
}

function getActive() {
  return _activeAdapter;
}

function getActiveProviderId() {
  return _activeProviderId;
}

function getActiveProviderMeta() {
  if (!_activeProviderId) return null;
  return registry.getProvider(_activeProviderId);
}

function _reloadFromStore() {
  if (!_store) throw new Error('Router not initialized; call init() first');
  const state = _store.load();
  let providerId = state.activeProvider;

  if (!registry.isValidProviderId(providerId)) {
    providerId = registry.getDefaultProviderId();
  }

  const provider = registry.getProvider(providerId);
  if (!provider) {
    logger.error('Unknown provider id, falling back to default', { providerId });
    _activeAdapter = null;
    _activeProviderId = registry.getDefaultProviderId();
    return;
  }

  const config = state.providers[providerId] || {};
  _activeAdapter = _instantiateAdapter(provider.adapter, {
    providerId,
    config
  });
  _activeProviderId = providerId;
}

function _instantiateAdapter(adapterName, opts) {
  if (adapterName === 'gemini') {
    const GeminiAdapter = require('./adapters/gemini.adapter');
    return new GeminiAdapter(opts);
  }
  if (adapterName === 'openai') {
    const OpenAIAdapter = require('./adapters/openai.adapter');
    return new OpenAIAdapter(opts);
  }
  if (adapterName === 'openai-compatible') {
    const OpenAICompatibleAdapter = require('./adapters/openai-compatible.adapter');
    return new OpenAICompatibleAdapter(opts);
  }
  throw new Error(`Unknown adapter: ${adapterName}`);
}

logger.info('LLM router module loaded');

module.exports = {
  init,
  reload,
  getActive,
  getActiveProviderId,
  getActiveProviderMeta
};
