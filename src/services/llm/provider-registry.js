const logger = require('../../core/logger').createServiceLogger('ProviderRegistry');

const PROVIDERS = {
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    adapter: 'gemini',
    fields: [
      { key: 'apiKey', label: 'API Key', type: 'password' },
      { key: 'model',  label: 'Model',   type: 'text', default: 'gemini-3.1-flash-lite',
        placeholder: 'gemini-3.1-flash-lite, gemini-2.5-flash-lite, ...' }
    ],
    supports: { text: true, image: true, streaming: true }
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    adapter: 'openai',
    fields: [
      { key: 'apiKey', label: 'API Key', type: 'password' },
      { key: 'model',  label: 'Model',   type: 'text', default: 'gpt-4o-mini',
        placeholder: 'gpt-4o, gpt-4o-mini, o1-mini, o1-preview, ...' }
    ],
    supports: { text: true, image: true, streaming: true }
  },
  'openai-compatible': {
    id: 'openai-compatible',
    label: 'OpenAI Compatible (DeepSeek / Ollama / OpenRouter / Custom)',
    adapter: 'openai-compatible',
    fields: [
      { key: 'apiKey',  label: 'API Key',  type: 'password' },
      { key: 'model',   label: 'Model',    type: 'text', required: true,
        placeholder: 'deepseek-chat, llama3, ...' },
      { key: 'baseUrl', label: 'Base URL', type: 'text', required: true,
        placeholder: 'https://api.deepseek.com/v1' }
    ],
    supports: { text: true, image: false, streaming: true }
  }
};

const VALID_IDS = Object.keys(PROVIDERS);

function getProvider(id) {
  return PROVIDERS[id] || null;
}

function listProviders() {
  return VALID_IDS.map(id => PROVIDERS[id]);
}

function getDefaultProviderId() {
  return 'gemini';
}

function isValidProviderId(id) {
  return VALID_IDS.includes(id);
}

logger.info('Provider registry loaded', { providerCount: VALID_IDS.length });

module.exports = {
  PROVIDERS,
  VALID_IDS,
  getProvider,
  listProviders,
  getDefaultProviderId,
  isValidProviderId
};