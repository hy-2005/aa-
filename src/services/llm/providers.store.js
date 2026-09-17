const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('../../core/logger').createServiceLogger('ProvidersStore');

const SCHEMA_VERSION = 2;
const FILE_NAME = 'llm-providers.json';

let _state = null;
let _filePath = null;

function init({ userDataDir }) {
  _filePath = path.join(userDataDir, FILE_NAME);

  // 1. 如果 JSON 不存在，尝试从 .env 迁移
  if (!fs.existsSync(_filePath)) {
    const envPath = process.env.OPENCLUELY_ENV_PATH || path.join(userDataDir, '.env');
    if (fs.existsSync(envPath)) {
      const migrated = _migrateFromEnv(envPath);
      if (migrated) {
        _saveAtomic(migrated);
        logger.info('Migrated LLM providers from .env to JSON', { filePath: _filePath });
      }
    }
  }

  // 2. 加载 JSON 到内存
  if (fs.existsSync(_filePath)) {
    try {
      const content = fs.readFileSync(_filePath, 'utf8');
      const parsed = _validate(JSON.parse(content));
      _state = parsed;
      logger.info('Loaded LLM providers from JSON', {
        filePath: _filePath,
        activeProvider: parsed.activeProvider
      });
      return _state;
    } catch (e) {
      // 损坏：备份 + 回退空状态
      const bakPath = _filePath + '.bak';
      try { fs.renameSync(_filePath, bakPath); } catch (_) {}
      logger.warn('LLM providers JSON corrupted, backed up and starting fresh', {
        bakPath,
        error: e.message
      });
      _state = _emptyState();
      return _state;
    }
  }

  // 3. 完全空白：空状态
  _state = _emptyState();
  return _state;
}

function load() {
  if (!_state) throw new Error('ProvidersStore not initialized; call init() first');
  return _state;
}

function save(payload) {
  if (!_state) throw new Error('ProvidersStore not initialized; call init() first');
  const validated = _validate({ ..._state, ...payload });
  _saveAtomic(validated);
  _state = validated;
  return validated;
}

function getFilePath() {
  return _filePath;
}

function _emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    activeProvider: 'gemini',
    providers: {
      gemini: { apiKey: '', model: 'gemini-3.1-flash-lite' },
      openai: { apiKey: '', model: 'gpt-4o-mini' },
      'openai-compatible': { apiKey: '', model: '', baseUrl: '' }
    }
  };
}

function _validate(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('Invalid providers payload');
  const activeProvider = obj.activeProvider || 'gemini';
  const providers = obj.providers || {};
  return {
    schemaVersion: SCHEMA_VERSION,
    activeProvider,
    providers: {
      gemini: providers.gemini || { apiKey: '', model: 'gemini-3.1-flash-lite' },
      openai: providers.openai || { apiKey: '', model: 'gpt-4o-mini' },
      'openai-compatible': providers['openai-compatible'] || { apiKey: '', model: '', baseUrl: '' }
    }
  };
}

function _saveAtomic(obj) {
  const tmpPath = _filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmpPath, _filePath);
}

function _migrateFromEnv(envPath) {
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    const env = {};
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (value.startsWith('"') || value.startsWith("'")) {
        const quote = value[0];
        const closeIdx = value.indexOf(quote, 1);
        if (closeIdx !== -1) value = value.slice(1, closeIdx);
      } else {
        const hashIdx = value.indexOf(' #');
        if (hashIdx !== -1) value = value.slice(0, hashIdx).trim();
      }
      env[key] = value;
    }
    const geminiKey = (env.GEMINI_API_KEY || '').trim();
    if (!geminiKey || geminiKey === 'your_gemini_api_key_here') {
      return null;
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      activeProvider: 'gemini',
      providers: {
        gemini: {
          apiKey: geminiKey,
          model: (env.GEMINI_MODEL || '').trim() || 'gemini-3.1-flash-lite'
        },
        openai: { apiKey: '', model: 'gpt-4o-mini' },
        'openai-compatible': { apiKey: '', model: '', baseUrl: '' }
      }
    };
  } catch (e) {
    logger.warn('Failed to migrate providers from .env', { error: e.message });
    return null;
  }
}

logger.info('Providers store module loaded');

module.exports = {
  init,
  load,
  save,
  getFilePath,
  SCHEMA_VERSION
};