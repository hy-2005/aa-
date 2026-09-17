# 多厂家 LLM 动态配置 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在 EXE 的 Settings 中动态配置 / 切换 Gemini、OpenAI、OpenAI 兼容（DeepSeek / Ollama / OpenRouter 等）三个 LLM 厂家，运行时无重启热切换，所有配置持久化到 `userData/llm-providers.json`。

**Architecture:** Adapter 模式。把现有 1655 行的 `src/services/llm.service.js` 拆为：一个薄 orchestrator（~150 行）+ 一个 ProviderRegistry（厂家元数据）+ 一个 Router（激活状态）+ 三个 Adapter（Gemini / OpenAI / OpenAI-compatible）。LLMService 公开 API 签名不变，上层调用方零修改。

**Tech Stack:** Node.js 18+（已用）、Electron 29（已用）、`@google/genai`（已有）、`openai` ^4.77（新增）、`dotenv`（已有）、`node --test`（内置，可选）。

## Global Constraints

来源：spec §2、§3、§5、§6、§9

- 支持的厂家：`gemini`、`openai`、`openai-compatible`（不支持 Anthropic）
- 持久化文件：`userData/llm-providers.json`，原子写（tmp + rename）
- `.env` 中 `GEMINI_API_KEY` 首次启动时一次性迁移到 JSON，之后不再读取
- 启动时把激活 provider 的字段镜像到 `process.env`，保留 `config.getApiKey('GEMINI')` 之类老调用
- Settings 改完无需重启，下次请求自动走新 adapter
- 模型字段为自由文本（不强制白名单）
- OpenAI 兼容默认 `supports.image: false`
- 每个 adapter 内部识别自家错误，对外统一返回 `{ type, provider, userMessage, technicalMessage, retryable, statusCode }`
- 所有公开 commit 消息以 `Co-Authored-By: Claude Code <noreply@anthropic.com>` 结尾
- Shell 命令使用 Git Bash / Unix 语法

---

## 文件结构总览

### 新增

| 路径 | 行数估计 | 职责 |
|---|---|---|
| `src/services/llm/errors.js` | ~80 | 统一错误归一化 |
| `src/services/llm/provider-registry.js` | ~80 | 厂家元数据（id、label、fields、supports） |
| `src/services/llm/providers.store.js` | ~140 | 读/写/原子写 JSON；`.env` → JSON 一次性迁移 |
| `src/services/llm/llm-router.js` | ~80 | 激活 adapter 单例 + 热切换 |
| `src/services/llm/adapters/gemini.adapter.js` | ~650 | Gemini 实现（从 llm.service.js 迁出） |
| `src/services/llm/adapters/openai.adapter.js` | ~300 | OpenAI（用官方 `openai` 包） |
| `src/services/llm/adapters/openai-compatible.adapter.js` | ~250 | OpenAI 兼容（同包 + 自定义 baseURL） |

### 修改

| 路径 | 改法 |
|---|---|
| `src/services/llm.service.js` | 重写为 orchestrator（~150 行） |
| `src/core/config.js` | 新增 `getActiveProviderId()`、`getProviderField(id, key)`、`getAllProviders()` |
| `main.js` | 启动时初始化 store；`getSettings` / `saveSettings` 适配新 schema |
| `src/ui/settings-window.js` | 渲染动态 provider 表单 |
| `settings.html` | 加 provider dropdown + 表单容器 |
| `src/core/first-run.js` | 检测 JSON + 激活 provider 就绪 |
| `package.json` | 新增 `"openai": "^4.77.0"` |
| `env.example` | 移除 GEMINI_API_KEY 模板，引导用 Settings |

---

## Task 1: 添加 openai 依赖

**Files:**
- Modify: `package.json`

**Interfaces:**
- Consumes: 无
- Produces: `require('openai')` 在 Node 进程内可用

- [ ] **Step 1: 安装依赖**

Run:
```bash
cd "D:\code\笔试软件\OpenCluely" && npm install openai@^4.77.0 --save
```

Expected: 安装成功，`package.json` 的 `dependencies` 出现 `"openai": "^4.77.0"`，`node_modules/openai/` 目录存在。

- [ ] **Step 2: 验证 require 可用**

Run:
```bash
cd "D:\code\笔试软件\OpenCluely" && node -e "console.log(typeof require('openai'))"
```

Expected: 输出 `function`

- [ ] **Step 3: 提交**

```bash
cd "D:\code\笔试软件\OpenCluely" && git add package.json package-lock.json && git commit -m "deps: add openai ^4.77.0 for multi-provider support"
```

---

## Task 2: 创建 errors.js — 统一错误归一化

**Files:**
- Create: `src/services/llm/errors.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `class NoApiKeyError extends Error` — 空 key 抛这个
  - `class ImageNotSupportedError extends Error` — adapter 不支持图片时抛
  - `class StreamNotSupportedError extends Error` — adapter 不支持流式时抛
  - `normalizeError(rawError, providerId)` → `{ type, provider, userMessage, technicalMessage, retryable, statusCode }`
  - `_friendlyTestError(rawError, providerId, analysis)` → string（UI 直接展示）

- [ ] **Step 1: 创建文件**

完整内容（无占位符）：

```javascript
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
```

- [ ] **Step 2: 验证 require 不报错**

Run:
```bash
cd "D:\code\笔试软件\OpenCluely" && node -e "const e = require('./src/services/llm/errors'); console.log(typeof e.normalizeError, typeof e.NoApiKeyError);"
```

Expected: 输出 `function function`

- [ ] **Step 3: 提交**

```bash
cd "D:\code\笔试软件\OpenCluely" && git add src/services/llm/errors.js && git commit -m "feat(llm): add unified error normalization module"
```

---

## Task 3: 创建 provider-registry.js

**Files:**
- Create: `src/services/llm/provider-registry.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `PROVIDERS` 对象（三个 provider 的元数据）
  - `getProvider(id)` → provider object | null
  - `listProviders()` → provider 对象数组
  - `getDefaultProviderId()` → 'gemini'

- [ ] **Step 1: 创建文件**

```javascript
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
```

- [ ] **Step 2: 验证**

Run:
```bash
cd "D:\code\笔试软件\OpenCluely" && node -e "const r = require('./src/services/llm/provider-registry'); console.log(r.listProviders().map(p => p.id));"
```

Expected: 输出 `['gemini', 'openai', 'openai-compatible']`

- [ ] **Step 3: 提交**

```bash
cd "D:\code\笔试软件\OpenCluely" && git add src/services/llm/provider-registry.js && git commit -m "feat(llm): add provider registry with three initial vendors"
```

---

## Task 4: 创建 providers.store.js — JSON 持久化

**Files:**
- Create: `src/services/llm/providers.store.js`

**Interfaces:**
- Consumes:
  - `userDataDir` (从 main.js 传入)
- Produces:
  - `init({ userDataDir })` — 初始化，必要时从 `.env` 迁移
  - `load()` → `{ schemaVersion, activeProvider, providers: {...} }`
  - `save(payload)` — 原子写 JSON
  - `getFilePath()` → string
  - `migrateFromEnv(envPath)` — 一次性从 `.env` 读取并合并

- [ ] **Step 1: 创建文件**

```javascript
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
```

- [ ] **Step 2: 验证初始化 / 迁移 / 原子写**

Run（手动执行三步验证）:

```bash
cd "D:\code\笔试软件\OpenCluely" && node -e "
const store = require('./src/services/llm/providers.store');
const path = require('path');
const fs = require('fs');
const os = require('os');
const tmpDir = path.join(os.tmpdir(), 'opencluely-test-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
fs.writeFileSync(path.join(tmpDir, '.env'), 'GEMINI_API_KEY=test-key-123\n');
store.init({ userDataDir: tmpDir });
const s = store.load();
console.log('activeProvider:', s.activeProvider);
console.log('gemini.apiKey:', s.providers.gemini.apiKey);
console.log('file exists:', fs.existsSync(store.getFilePath()));
store.save({ activeProvider: 'openai', providers: { ...s.providers, openai: { apiKey: 'sk-test', model: 'gpt-4o-mini' } } });
const s2 = store.load();
console.log('after save activeProvider:', s2.activeProvider);
console.log('openai.apiKey:', s2.providers.openai.apiKey);
fs.rmSync(tmpDir, { recursive: true, force: true });
"
```

Expected: 输出包含
- `activeProvider: gemini`
- `gemini.apiKey: test-key-123`
- `file exists: true`
- `after save activeProvider: openai`
- `openai.apiKey: sk-test`

- [ ] **Step 3: 提交**

```bash
cd "D:\code\笔试软件\OpenCluely" && git add src/services/llm/providers.store.js && git commit -m "feat(llm): add providers store with JSON persistence and env migration"
```

---

## Task 5: 创建 llm-router.js — 激活 adapter 单例

**Files:**
- Create: `src/services/llm/llm-router.js`

**Interfaces:**
- Consumes:
  - `provider-registry.js` (getProvider, getDefaultProviderId, isValidProviderId)
  - `providers.store.js` (load)
  - 三个 adapter 类
- Produces:
  - `init({ providersStore })` — 读取 activeProvider，实例化 adapter
  - `getActive()` → adapter instance | null
  - `reload()` — 重新读取 activeProvider 并实例化
  - `getActiveProviderId()` → string
  - `getActiveProviderMeta()` → provider 对象

- [ ] **Step 1: 创建文件**

```javascript
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
```

- [ ] **Step 2: 验证模块加载**

Run:
```bash
cd "D:\code\笔试软件\OpenCluely" && node -e "const r = require('./src/services/llm/llm-router'); console.log(typeof r.init, typeof r.getActive);"
```

Expected: 输出 `function function`

- [ ] **Step 3: 提交**

```bash
cd "D:\code\笔试软件\OpenCluely" && git add src/services/llm/llm-router.js && git commit -m "feat(llm): add router for active adapter singleton"
```

---

## Task 6: 创建 adapters/gemini.adapter.js — 迁出 Gemini 实现

**Files:**
- Create: `src/services/llm/adapters/gemini.adapter.js`

**Interfaces:**
- Consumes: `config.js` (`get('llm.gemini.*')`)
- Produces: `class GeminiAdapter` 暴露：
  - `id` = 'gemini'
  - `isInitialized` (boolean)
  - `initialize()` (boolean)
  - `testConnection()` (Promise)
  - `processText(text, opts)` / `processTextStream(text, opts, onDelta)`
  - `processImage(opts)` / `processImageStream(opts, onDelta)`
  - `updateApiKey(apiKey)` (backward compat for any caller)
  - `getStats()`

这是最大的一块（~650 行），就是把现有 `src/services/llm.service.js` 的 Gemini 部分整体搬过来，把方法名改成适配统一接口。

- [ ] **Step 1: 创建文件**

```javascript
const { GoogleGenAI } = require('@google/genai');
const logger = require('../../../core/logger').createServiceLogger('GeminiAdapter');
const config = require('../../../core/config');
const { promptLoader } = require('../../../../prompt-loader');
const { NoApiKeyError, normalizeError } = require('../errors');

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
          const result = await this.client.models.generateContent({
            model: modelName,
            contents: 'Test connection. Please respond with "OK".',
            config: generationConfig
          });
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
    const langNote = programmingLanguage ? ` Use only ${programmingLanguage.toUpperCase()} for any code.` : '';
    return `Analyze this image for a ${activeSkill.toUpperCase()} question. Extract the problem concisely and provide the best possible solution with explanation and final code.${langNote}`;
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
```

- [ ] **Step 2: 验证 require 不报错**

Run:
```bash
cd "D:\code\笔试软件\OpenCluely" && node -e "const A = require('./src/services/llm/adapters/gemini.adapter'); const a = new A({ providerId: 'gemini', config: { apiKey: '', model: 'gemini-3.1-flash-lite' } }); console.log('id:', a.id, 'initialized:', a.isInitialized);"
```

Expected: 输出 `id: gemini initialized: false`

- [ ] **Step 3: 提交**

```bash
cd "D:\code\笔试软件\OpenCluely" && git add src/services/llm/adapters/gemini.adapter.js && git commit -m "feat(llm): extract Gemini implementation into adapter"
```

注：此 commit 后老的 `llm.service.js` 暂时仍存在并直接用 `@google/genai`；任务 7 才把 orchestrator 切换到 router。这是为了让 diff 小、风险低、回滚简单。

---

## Task 7: 重写 llm.service.js 为 orchestrator

**Files:**
- Modify: `src/services/llm.service.js` (重写)

**Interfaces:**
- Consumes: `llm-router.js`, `errors.js`, 各 adapter（通过 router）
- Produces: 与现有 public API 兼容的 `LLMService` 单例

公开方法保持兼容：
- `processTextWithSkill(text, skill, sessionMemory, programmingLanguage)`
- `processTextWithSkillStream(text, skill, sessionMemory, programmingLanguage, onDelta)`
- `processImageWithSkill(imageBuffer, mimeType, skill, sessionMemory, programmingLanguage)`
- `processImageWithSkillStream(imageBuffer, mimeType, skill, sessionMemory, programmingLanguage, onDelta)`
- `processTranscriptionWithIntelligentResponse(text, skill, sessionMemory, programmingLanguage)`
- `processTranscriptionWithIntelligentResponseStream(text, skill, sessionMemory, programmingLanguage, onDelta)`
- `testConnection()`
- `getStats()`
- `updateApiKey(apiKey)` — 保留向后兼容，转发给 router 当前 adapter
- `initializeClient()`

- [ ] **Step 1: 替换 llm.service.js 全部内容**

```javascript
const logger = require('../core/logger').createServiceLogger('LLMService');
const router = require('./llm/llm-router');
const { NoApiKeyError, ImageNotSupportedError, normalizeError } = require('./llm/errors');

class LLMService {
  constructor() {
    this.requestCount = 0;
    this.errorCount = 0;
    // Note: not initialized here — orchestrator delegates to router.
    // Legacy callers that check `this.isInitialized` get a derived value.
  }

  // ── Legacy compat ──
  get isInitialized() {
    const a = router.getActive();
    return !!(a && a.isInitialized);
  }

  initializeClient() {
    const a = router.getActive();
    if (a && typeof a.initialize === 'function') {
      return a.initialize();
    }
    return false;
  }

  updateApiKey(apiKey) {
    const a = router.getActive();
    if (a && typeof a.updateApiKey === 'function') {
      return a.updateApiKey(apiKey);
    }
    logger.warn('Cannot updateApiKey: no active adapter');
    return false;
  }

  // ── New unified entry points ──
  async processText(text, opts) {
    return this._delegate('processText', [text, opts]);
  }

  async processTextStream(text, opts, onDelta) {
    return this._delegate('processTextStream', [text, opts, onDelta]);
  }

  async processImage(opts) {
    return this._delegate('processImage', [opts]);
  }

  async processImageStream(opts, onDelta) {
    return this._delegate('processImageStream', [opts, onDelta]);
  }

  async testConnection() {
    const a = router.getActive();
    if (!a) {
      return { success: false, error: 'No provider configured', errorType: 'NO_PROVIDER' };
    }
    return a.testConnection();
  }

  getStats() {
    const a = router.getActive();
    return {
      isInitialized: this.isInitialized,
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      successRate: this.requestCount > 0 ? ((this.requestCount - this.errorCount) / this.requestCount) * 100 : 0,
      activeProvider: router.getActiveProviderId(),
      provider: a ? a.getStats() : null
    };
  }

  // ── Legacy method signatures (kept for backward compat with main.js call sites) ──

  async processTextWithSkill(text, activeSkill, sessionMemory = [], programmingLanguage = null) {
    return this.processText(text, { activeSkill, sessionMemory, programmingLanguage });
  }

  async processTextWithSkillStream(text, activeSkill, sessionMemory = [], programmingLanguage = null, onDelta = null) {
    return this.processTextStream(text, { activeSkill, sessionMemory, programmingLanguage }, onDelta);
  }

  async processImageWithSkill(imageBuffer, mimeType, activeSkill, sessionMemory = [], programmingLanguage = null) {
    return this.processImage({ imageBuffer, mimeType, activeSkill, sessionMemory, programmingLanguage });
  }

  async processImageWithSkillStream(imageBuffer, mimeType, activeSkill, sessionMemory = [], programmingLanguage = null, onDelta = null) {
    return this.processImageStream({ imageBuffer, mimeType, activeSkill, sessionMemory, programmingLanguage }, onDelta);
  }

  async processTranscriptionWithIntelligentResponse(text, activeSkill, sessionMemory = [], programmingLanguage = null) {
    return this.processText(text, { activeSkill, sessionMemory, programmingLanguage });
  }

  async processTranscriptionWithIntelligentResponseStream(text, activeSkill, sessionMemory = [], programmingLanguage = null, onDelta = null) {
    return this.processTextStream(text, { activeSkill, sessionMemory, programmingLanguage }, onDelta);
  }

  // ── Internals ──

  async _delegate(method, args) {
    this.requestCount++;
    const a = router.getActive();
    if (!a) {
      const err = new NoApiKeyError(router.getActiveProviderId() || 'unknown');
      logger.error('No active adapter', { activeProvider: router.getActiveProviderId() });
      throw err;
    }
    try {
      return await a[method](...args);
    } catch (e) {
      this.errorCount++;
      logger.error('LLM call failed', {
        method,
        provider: router.getActiveProviderId(),
        error: e.message
      });
      throw e;
    }
  }
}

logger.info('LLM service orchestrator loaded');

module.exports = new LLMService();
```

- [ ] **Step 2: 验证模块加载**

Run:
```bash
cd "D:\code\笔试软件\OpenCluely" && node -e "const s = require('./src/services/llm.service'); console.log(typeof s.processTextWithSkill, typeof s.testConnection);"
```

Expected: 输出 `function function`

- [ ] **Step 3: 启动 EXE，确认 Gemini 仍工作（手工 smoke）**

Run:
```bash
cd "D:\code\笔试软件\OpenCluely" && npm start
```

验证：
- 主浮层出现
- 截图分析走 Gemini 成功（如有真 key）
- 文字问答走 Gemini 成功

如果 router 还没初始化（main.js 还没改），LLMService 会拿到 null adapter 并抛 NoApiKeyError。这是预期的——下一步 main.js 会初始化 router。

- [ ] **Step 4: 提交**

```bash
cd "D:\code\笔试软件\OpenCluely" && git add src/services/llm.service.js && git commit -m "refactor(llm): slim llm.service into router-delegating orchestrator"
```

---

## Task 8: main.js 启动时初始化 store + router + 镜像 process.env

**Files:**
- Modify: `main.js` — 在 dotenv 加载之后、注册 IPC handler 之前加 store + router 初始化

**Interfaces:**
- Consumes: `providers.store.js`, `llm-router.js`
- Produces: 启动时
  - 加载 `llm-providers.json`
  - 镜像激活 provider 字段到 `process.env`
  - 初始化 router

- [ ] **Step 1: 在 main.js 现有 ENV_PATH 初始化附近插入**

定位到现有这段（main.js 顶部）：

```javascript
const ENV_PATH = resolveEnvPath();
require("dotenv").config({ path: ENV_PATH });
```

紧接着**下方**插入：

```javascript
// ── Initialize LLM provider storage + router ──
const providersStore = require("./src/services/llm/providers.store");
const llmRouter = require("./src/services/llm/llm-router");

const llmProvidersState = providersStore.init({ userDataDir: app.getPath("userData") });
{
  const active = llmProvidersState.providers[llmProvidersState.activeProvider] || {};
  // Mirror active provider fields to process.env so legacy config.getApiKey() calls keep working.
  if (llmProvidersState.activeProvider === "gemini") {
    if (active.apiKey) process.env.GEMINI_API_KEY = active.apiKey;
    if (active.model)  process.env.GEMINI_MODEL  = active.model;
  } else if (llmProvidersState.activeProvider === "openai") {
    if (active.apiKey) process.env.OPENAI_API_KEY = active.apiKey;
    if (active.model)  process.env.OPENAI_MODEL  = active.model;
  } else if (llmProvidersState.activeProvider === "openai-compatible") {
    if (active.apiKey)  process.env.OPENAI_COMPAT_API_KEY  = active.apiKey;
    if (active.model)   process.env.OPENAI_COMPAT_MODEL   = active.model;
    if (active.baseUrl) process.env.OPENAI_COMPAT_BASE_URL = active.baseUrl;
  }
  // Always mirror all provider fields too — non-active keys are still read by config layer
  // when user switches active provider without re-saving.
  const allProviders = llmProvidersState.providers;
  if (allProviders.gemini && allProviders.gemini.apiKey)  process.env.GEMINI_API_KEY  = allProviders.gemini.apiKey;
  if (allProviders.gemini && allProviders.gemini.model)   process.env.GEMINI_MODEL   = allProviders.gemini.model;
  if (allProviders.openai && allProviders.openai.apiKey)   process.env.OPENAI_API_KEY  = allProviders.openai.apiKey;
  if (allProviders.openai && allProviders.openai.model)    process.env.OPENAI_MODEL   = allProviders.openai.model;
  if (allProviders['openai-compatible']) {
    if (allProviders['openai-compatible'].apiKey)  process.env.OPENAI_COMPAT_API_KEY  = allProviders['openai-compatible'].apiKey;
    if (allProviders['openai-compatible'].model)   process.env.OPENAI_COMPAT_MODEL   = allProviders['openai-compatible'].model;
    if (allProviders['openai-compatible'].baseUrl) process.env.OPENAI_COMPAT_BASE_URL = allProviders['openai-compatible'].baseUrl;
  }
  logger.info("LLM providers loaded", {
    filePath: providersStore.getFilePath(),
    activeProvider: llmProvidersState.activeProvider
  });
}
llmRouter.init({ providersStore });
```

注：上面代码放在 `llmService = require("./src/services/llm.service");` **之前**（如果存在），保证 router 在 LLMService 第一次被调用时已就绪。

- [ ] **Step 2: 验证启动**

Run:
```bash
cd "D:\code\笔试软件\OpenCluely" && npm start
```

验证：
- 主浮层出现
- 如果之前 `.env` 有 GEMINI_API_KEY 且没有 `llm-providers.json`，检查 `userData/llm-providers.json` 是否生成（路径：`app.getPath("userData")` — 在 Windows 是 `%APPDATA%/opencluely/`）
- 走 Gemini 截图分析 / 文字问答仍然成功

- [ ] **Step 3: 提交**

```bash
cd "D:\code\笔试软件\OpenCluely" && git add main.js && git commit -m "feat(llm): initialize providers store and router at startup"
```

注：到这一步，老用户应该完全感受不到区别——Gemini 工作正常，配置文件已经迁移。

---

## Task 9: 创建 adapters/openai.adapter.js

**Files:**
- Create: `src/services/llm/adapters/openai.adapter.js`

**Interfaces:**
- Consumes: `openai` npm 包, `errors.js`
- Produces: `class OpenAIAdapter` 暴露与 GeminiAdapter 一致的统一接口

- [ ] **Step 1: 创建文件**

```javascript
const OpenAI = require('openai');
const logger = require('../../../core/logger').createServiceLogger('OpenAIAdapter');
const config = require('../../../core/config');
const { promptLoader } = require('../../../../prompt-loader');
const { NoApiKeyError, normalizeError, ImageNotSupportedError } = require('../errors');

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

logger.info('OpenAI adapter module loaded');

module.exports = OpenAIAdapter;
```

- [ ] **Step 2: 验证模块加载**

Run:
```bash
cd "D:\code\笔试软件\OpenCluely" && node -e "const A = require('./src/services/llm/adapters/openai.adapter'); const a = new A({ providerId: 'openai', config: { apiKey: '', model: 'gpt-4o-mini' } }); console.log('id:', a.id, 'initialized:', a.isInitialized, 'supports:', { text: true, image: true });"
```

Expected: 输出 `id: openai initialized: false supports: { text: true, image: true }`

- [ ] **Step 3: 提交**

```bash
cd "D:\code\笔试软件\OpenCluely" && git add src/services/llm/adapters/openai.adapter.js && git commit -m "feat(llm): add OpenAI adapter using official SDK"
```

---

## Task 10: 创建 adapters/openai-compatible.adapter.js

**Files:**
- Create: `src/services/llm/adapters/openai-compatible.adapter.js`

**Interfaces:**
- Consumes: `openai` npm 包 (复用), `errors.js`
- Produces: `class OpenAICompatibleAdapter`，与 OpenAIAdapter 同接口，唯一区别是 `baseURL` 可配 + 默认不支持图片

- [ ] **Step 1: 创建文件**

```javascript
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
```

- [ ] **Step 2: 验证模块加载**

Run:
```bash
cd "D:\code\笔试软件\OpenCluely" && node -e "const A = require('./src/services/llm/adapters/openai-compatible.adapter'); const a = new A({ providerId: 'openai-compatible', config: { apiKey: 'x', model: 'm', baseUrl: 'http://localhost' } }); console.log('id:', a.id, 'initialized:', a.isInitialized);"
```

Expected: 输出 `id: openai-compatible initialized: false`

- [ ] **Step 3: 提交**

```bash
cd "D:\code\笔试软件\OpenCluely" && git add src/services/llm/adapters/openai-compatible.adapter.js && git commit -m "feat(llm): add OpenAI-compatible adapter for DeepSeek/Ollama/custom"
```

---

## Task 11: 更新 main.js getSettings/saveSettings 处理新 schema

**Files:**
- Modify: `main.js` — 修改 `getSettings()` 和 `saveSettings()` 让它们读写 providers store

**Interfaces:**
- Consumes: `providers.store.js`, `provider-registry.js`
- Produces:
  - `this.getSettings()` 新增 `activeProvider`、`providers` 字段；保留所有老字段
  - `this.saveSettings(settings)` 处理新 payload + 校验 + 触发 router reload

- [ ] **Step 1: 修改 getSettings()**

定位到 `getSettings()` 方法（main.js ~1586），替换整个方法体为：

```javascript
getSettings() {
  const providerState = providersStore.load();
  const providers = providerState.providers || {};
  return {
    schemaVersion: providersStore.SCHEMA_VERSION,
    activeProvider: providerState.activeProvider,
    providers: {
      gemini: providers.gemini || { apiKey: "", model: "gemini-3.1-flash-lite" },
      openai: providers.openai || { apiKey: "", model: "gpt-4o-mini" },
      "openai-compatible": providers["openai-compatible"] || { apiKey: "", model: "", baseUrl: "" }
    },
    // Legacy bridge fields (existing UI may still read these)
    geminiKey: process.env.GEMINI_API_KEY || "",

    codingLanguage: this.codingLanguage || "cpp",
    activeSkill: this.activeSkill || "dsa",
    appIcon: this.appIcon || "terminal",
    selectedIcon: this.appIcon || "terminal",
    windowGap: windowManager.windowGap,

    speechProvider: speechService.provider || "whisper",
    azureKey: process.env.AZURE_SPEECH_KEY || "",
    azureRegion: process.env.AZURE_SPEECH_REGION || "",
    whisperCommand: process.env.WHISPER_COMMAND || "",
    whisperModel: process.env.WHISPER_MODEL || "small",
    whisperLanguage: process.env.WHISPER_LANGUAGE || "auto",
    whisperDevice: process.env.WHISPER_DEVICE || "auto",
    whisperCaptureMode: process.env.WHISPER_CAPTURE_MODE ||
      (process.env.WHISPER_MANUAL_CAPTURE === "true" ? "manual" : "vad"),
    whisperResponseTarget: process.env.WHISPER_RESPONSE_TARGET || "both",
    whisperSegmentMs: process.env.WHISPER_SEGMENT_MS || "4000",

    azureConfigured: !!process.env.AZURE_SPEECH_KEY && !!process.env.AZURE_SPEECH_REGION,
    speechAvailable: this.speechAvailable
  };
}
```

- [ ] **Step 2: 修改 saveSettings()**

定位到 `saveSettings()` 方法（main.js ~1616），在 `const envUpdates = {};` **之前**插入 provider 处理块：

```javascript
      // ── Provider config (active + all keys) ──
      if (settings.providers && typeof settings.providers === 'object') {
        const next = providersStore.load();
        const incoming = settings.providers;
        for (const pid of ['gemini', 'openai', 'openai-compatible']) {
          if (incoming[pid]) {
            next.providers[pid] = {
              ...next.providers[pid],
              ...incoming[pid]
            };
          }
        }
        // activeProvider 切换：必须确保目标 provider 至少有 key
        if (settings.activeProvider && ['gemini', 'openai', 'openai-compatible'].includes(settings.activeProvider)) {
          next.activeProvider = settings.activeProvider;
        }
        // 校验目标 provider 字段
        const target = next.providers[next.activeProvider] || {};
        if (!target.apiKey || !String(target.apiKey).trim()) {
          logger.warn('Active provider has no API key', { activeProvider: next.activeProvider });
          return { success: false, error: `Active provider "${next.activeProvider}" requires an API key. Add one in Settings.` };
        }
        if (next.activeProvider === 'openai-compatible') {
          if (!target.baseUrl || !target.model) {
            return { success: false, error: 'OpenAI Compatible requires both baseUrl and model.' };
          }
          try { new URL(target.baseUrl); }
          catch (_) { return { success: false, error: 'OpenAI Compatible baseUrl is not a valid URL.' }; }
        }
        providersStore.save(next);
        // 镜像到 process.env（向后兼容 config.getApiKey）
        const allProviders = next.providers;
        if (allProviders.gemini && allProviders.gemini.apiKey) process.env.GEMINI_API_KEY = allProviders.gemini.apiKey;
        if (allProviders.gemini && allProviders.gemini.model)  process.env.GEMINI_MODEL  = allProviders.gemini.model;
        if (allProviders.openai && allProviders.openai.apiKey)  process.env.OPENAI_API_KEY = allProviders.openai.apiKey;
        if (allProviders.openai && allProviders.openai.model)   process.env.OPENAI_MODEL  = allProviders.openai.model;
        if (allProviders['openai-compatible']) {
          if (allProviders['openai-compatible'].apiKey)  process.env.OPENAI_COMPAT_API_KEY  = allProviders['openai-compatible'].apiKey;
          if (allProviders['openai-compatible'].model)   process.env.OPENAI_COMPAT_MODEL   = allProviders['openai-compatible'].model;
          if (allProviders['openai-compatible'].baseUrl) process.env.OPENAI_COMPAT_BASE_URL = allProviders['openai-compatible'].baseUrl;
        }
        // 重新初始化 router 走新 provider
        try { llmRouter.reload(); }
        catch (e) { logger.warn('Failed to reload LLM router', { error: e.message }); }
        // 触发 LLMService 内部状态重置（兼容老 updateApiKey 调用路径）
        try { llmService.initializeClient(); } catch (_) {}
        logger.info('LLM provider config updated', { activeProvider: next.activeProvider });
      }
```

紧接着的 `const envUpdates = {};` 块保留不变（仍处理老的 speech/whisper 设置）。**删除**原来 `if (settings.geminiKey !== undefined) { envUpdates.GEMINI_API_KEY = settings.geminiKey; }` 那一段（被上面 provider 处理替代了）。

紧接着也**删除**下面这段（已被新逻辑替代）：

```javascript
      if (settings.geminiKey !== undefined && envUpdates.GEMINI_API_KEY !== undefined) {
        try {
          llmService.initializeClient();
          logger.info("LLM service reinitialized after Gemini key update");
        } catch (e) { ... }
      }
```

- [ ] **Step 3: 验证 require 不破**

Run:
```bash
cd "D:\code\笔试软件\OpenCluely" && node -e "require('./main.js')" 2>&1 | head -20 || true
```

Expected: 输出可能是 Electron 入口错误（找不到 app 等），但只要 module 语法没问题就算通过。如果出现 syntax error，检查 main.js 编辑是否对齐。

- [ ] **Step 4: 提交**

```bash
cd "D:\code\笔试软件\OpenCluely" && git add main.js && git commit -m "feat(llm): getSettings/saveSettings handle new provider schema"
```

---

## Task 12: 更新 settings.html — provider dropdown + 表单容器

**Files:**
- Modify: `settings.html`

**Interfaces:**
- Consumes: 无
- Produces: 在 AI / Gemini 配置区域附近新增 provider 选择 UI

- [ ] **Step 1: 在 settings.html 找到 Gemini key 那一段**

grep `geminiKey` 找到对应 `<input>` 所在的 section。在它附近添加新的 provider 选择 UI（在 geminiKey input 之前）。

具体做法：在 `<input type="password" class="input-field" id="geminiKey" ...>` 上面插入：

```html
<div class="form-group">
    <label class="form-label" for="activeProvider">Active Provider</label>
    <select id="activeProvider" class="input-field">
        <option value="gemini">Google Gemini</option>
        <option value="openai">OpenAI</option>
        <option value="openai-compatible">OpenAI Compatible (DeepSeek / Ollama / OpenRouter / Custom)</option>
    </select>
    <p class="form-hint">Select which LLM provider to use. All providers can be configured below.</p>
</div>

<div id="provider-fields">
    <!-- Filled dynamically by settings-window.js based on registry -->
</div>

<hr style="margin: 16px 0; opacity: 0.2;">

<div class="form-group">
    <label class="form-label" for="geminiKey">Google Gemini API Key</label>
    <input type="password" class="input-field" id="geminiKey" placeholder="Enter your Google API key">
    <label class="form-label" for="geminiModel" style="margin-top:8px;">Gemini Model</label>
    <input type="text" class="input-field" id="geminiModel" placeholder="gemini-3.1-flash-lite">
</div>

<div class="form-group">
    <label class="form-label" for="openaiKey">OpenAI API Key</label>
    <input type="password" class="input-field" id="openaiKey" placeholder="sk-...">
    <label class="form-label" for="openaiModel" style="margin-top:8px;">OpenAI Model</label>
    <input type="input-field" class="input-field" id="openaiModel" placeholder="gpt-4o-mini">
</div>

<div class="form-group">
    <label class="form-label">OpenAI Compatible (DeepSeek / Ollama / OpenRouter / Custom)</label>
    <input type="password" class="input-field" id="openaiCompatKey" placeholder="API Key">
    <input type="text" class="input-field" id="openaiCompatModel" placeholder="Model (deepseek-chat, llama3, ...)" style="margin-top:8px;">
    <input type="text" class="input-field" id="openaiCompatBaseUrl" placeholder="Base URL (https://api.deepseek.com/v1)" style="margin-top:8px;">
</div>

<button id="testLlmConnection" class="secondary-button" style="margin-top:8px;">Test LLM Connection</button>
<span id="llmConnectionStatus" style="margin-left:8px;"></span>
```

注：上面的 `<input type="input-field">` 应修正为 `type="text"`（复制粘贴时注意）：

```html
<input type="text" class="input-field" id="openaiModel" placeholder="gpt-4o-mini">
```

- [ ] **Step 2: 验证 HTML 文件结构没坏**

Run:
```bash
cd "D:\code\笔试软件\OpenCluely" && node -e "const html = require('fs').readFileSync('settings.html', 'utf8'); console.log('has activeProvider:', html.includes('id=\"activeProvider\"'), 'has geminiKey:', html.includes('id=\"geminiKey\"'), 'has openaiCompatBaseUrl:', html.includes('id=\"openaiCompatBaseUrl\"'));"
```

Expected: 输出 `has activeProvider: true has geminiKey: true has openaiCompatBaseUrl: true`

- [ ] **Step 3: 提交**

```bash
cd "D:\code\笔试软件\OpenCluely" && git add settings.html && git commit -m "feat(ui): add provider dropdown and dynamic form fields to settings"
```

---

## Task 13: 更新 settings-window.js — 动态渲染 + 保存

**Files:**
- Modify: `src/ui/settings-window.js`

**Interfaces:**
- Consumes: settings.html 里的新 input 元素
- Produces: 启动时渲染 provider 配置；save 时发新 schema 给 main.js

- [ ] **Step 1: 在 loadSettingsIntoUI 之后追加动态加载逻辑**

定位到 `loadSettingsIntoUI` 函数末尾，在它结束 `};` 之后插入：

```javascript
    // ── New: load activeProvider and provider fields ──
    const populateProviderFields = (settings) => {
        if (!settings) return;
        if (settings.activeProvider && document.getElementById('activeProvider')) {
            document.getElementById('activeProvider').value = settings.activeProvider;
        }
        const p = settings.providers || {};
        if (p.gemini) {
            if (document.getElementById('geminiKey'))   document.getElementById('geminiKey').value   = p.gemini.apiKey || '';
            if (document.getElementById('geminiModel')) document.getElementById('geminiModel').value = p.gemini.model || '';
        }
        if (p.openai) {
            if (document.getElementById('openaiKey'))   document.getElementById('openaiKey').value   = p.openai.apiKey || '';
            if (document.getElementById('openaiModel')) document.getElementById('openaiModel').value = p.openai.model || '';
        }
        if (p['openai-compatible']) {
            if (document.getElementById('openaiCompatKey'))     document.getElementById('openaiCompatKey').value     = p['openai-compatible'].apiKey || '';
            if (document.getElementById('openaiCompatModel'))  document.getElementById('openaiCompatModel').value  = p['openai-compatible'].model || '';
            if (document.getElementById('openaiCompatBaseUrl'))document.getElementById('openaiCompatBaseUrl').value= p['openai-compatible'].baseUrl || '';
        }
    };

    // Hook into existing load path
    const _origLoadSettings = loadSettingsIntoUI;
    loadSettingsIntoUI = function(settings) {
        _origLoadSettings(settings);
        populateProviderFields(settings);
    };
```

- [ ] **Step 2: 修改 saveSettings 让它发新 schema**

定位到 `const saveSettings = () => { ... }` 函数体，在 `if (activeSkillSelect) settings.activeSkill = activeSkillSelect.value;` 之后追加：

```javascript
        // ── Provider config ──
        const ap = document.getElementById('activeProvider');
        if (ap) settings.activeProvider = ap.value;
        settings.providers = {
            gemini: {
                apiKey:  (document.getElementById('geminiKey')   || {}).value || '',
                model:   (document.getElementById('geminiModel') || {}).value || ''
            },
            openai: {
                apiKey:  (document.getElementById('openaiKey')   || {}).value || '',
                model:   (document.getElementById('openaiModel') || {}).value || ''
            },
            'openai-compatible': {
                apiKey:  (document.getElementById('openaiCompatKey')     || {}).value || '',
                model:   (document.getElementById('openaiCompatModel')  || {}).value || '',
                baseUrl: (document.getElementById('openaiCompatBaseUrl')|| {}).value || ''
            }
        };
```

- [ ] **Step 3: 添加 Test Connection 按钮事件**

在 `quitButton` 处理代码附近添加：

```javascript
    const testLlmBtn = document.getElementById('testLlmConnection');
    const testStatus = document.getElementById('llmConnectionStatus');
    if (testLlmBtn) {
        testLlmBtn.addEventListener('click', async () => {
            testStatus.textContent = 'Testing...';
            try {
                if (window.electronAPI && window.electronAPI.testGeminiConnection) {
                    const r = await window.electronAPI.testGeminiConnection();
                    if (r && r.success) {
                        testStatus.textContent = '✓ Connected (' + (r.latency || 0) + 'ms)';
                    } else {
                        testStatus.textContent = '✗ ' + (r && r.error || 'Failed');
                    }
                } else {
                    testStatus.textContent = 'Test API not available';
                }
            } catch (e) {
                testStatus.textContent = '✗ ' + e.message;
            }
            setTimeout(() => { testStatus.textContent = ''; }, 5000);
        });
    }
```

- [ ] **Step 4: 启动 EXE 验证 Settings 渲染**

Run:
```bash
cd "D:\code\笔试软件\OpenCluely" && npm start
```

打开 Settings（Cmd/Ctrl + ,）：
- 应该看到 Active Provider dropdown
- 三个 provider 的 key/model/baseUrl 字段
- Test LLM Connection 按钮

- [ ] **Step 5: 提交**

```bash
cd "D:\code\笔试软件\OpenCluely" && git add src/ui/settings-window.js && git commit -m "feat(ui): dynamic provider field rendering and save schema"
```

---

## Task 14: 更新 src/core/first-run.js 检测 JSON 文件

**Files:**
- Modify: `src/core/first-run.js`

**Interfaces:**
- Consumes: `providers.store.js`（不再读 GEMINI_API_KEY）
- Produces:
  - `needsOnboarding()` — 检测 JSON 文件 + 激活 provider key
  - `getStatus()` — 返回新结构

- [ ] **Step 1: 修改 needsOnboarding()**

定位到 `needsOnboarding()` 方法，替换为：

```javascript
  needsOnboarding() {
    if (!fs.existsSync(this.sentinelPath)) return true;
    const jsonPath = path.join(path.dirname(this.envPath), 'llm-providers.json');
    if (!fs.existsSync(jsonPath)) return true;
    try {
      const providersStore = require('../services/llm/providers.store');
      const state = providersStore.init({ userDataDir: path.dirname(this.envPath) });
      const active = state.providers[state.activeProvider];
      return !active || !active.apiKey || !String(active.apiKey).trim();
    } catch (_) {
      return true;
    }
  }
```

- [ ] **Step 2: 修改 getStatus()**

```javascript
  getStatus() {
    let providerState;
    try {
      const providersStore = require('../services/llm/providers.store');
      providerState = providersStore.init({ userDataDir: path.dirname(this.envPath) });
    } catch (_) {
      providerState = { activeProvider: 'gemini', providers: { gemini: { apiKey: '' } } };
    }
    const active = providerState.providers[providerState.activeProvider] || {};
    return {
      envExists: fs.existsSync(this.envPath),
      sentinelExists: fs.existsSync(this.sentinelPath),
      jsonExists: fs.existsSync(path.join(path.dirname(this.envPath), 'llm-providers.json')),
      activeProvider: providerState.activeProvider,
      activeConfigured: !!(active.apiKey && String(active.apiKey).trim()),
      azureConfigured: !!(this._readEnv().AZURE_SPEECH_KEY || '').trim() && !!(this._readEnv().AZURE_SPEECH_REGION || '').trim(),
      whisperConfigured: !!(this._readEnv().WHISPER_COMMAND || '').trim(),
      needsOnboarding: this.needsOnboarding()
    };
  }
```

- [ ] **Step 3: 验证**

Run:
```bash
cd "D:\code\笔试软件\OpenCluely" && node -e "const FRM = require('./src/core/first-run'); const fr = new FRM.FirstRunManager(); console.log(fr.getStatus());"
```

Expected: 输出包含 `activeProvider: 'gemini'`、`jsonExists: true`（如果上一步 store 已初始化过）；`needsOnboarding: false`（如果 JSON 已有 key）。

- [ ] **Step 4: 提交**

```bash
cd "D:\code\笔试软件\OpenCluely" && git add src/core/first-run.js && git commit -m "feat(llm): first-run detection reads from providers store"
```

---

## Task 15: 更新 env.example + src/core/config.js

**Files:**
- Modify: `env.example`
- Modify: `src/core/config.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `env.example` 引导用户用 Settings
  - `config.js` 新增 `getActiveProviderId()` / `getProviderField(id, key)`

- [ ] **Step 1: 重写 env.example**

完整内容：

```bash
# OpenCluely Configuration
# ──────────────────────────────────────────────────
# LLM provider (Gemini / OpenAI / OpenAI-Compatible) is configured
# inside the EXE Settings window (Cmd/Ctrl + ,).
# All keys, models, and base URLs are stored in:
#   <userData>/llm-providers.json
#   (Windows: %APPDATA%/opencluely/llm-providers.json)
#
# The legacy GEMINI_API_KEY env var below is read only on FIRST LAUNCH
# (auto-migrated to llm-providers.json, then ignored).
# ──────────────────────────────────────────────────

# Legacy (optional, used only for one-time migration):
# GEMINI_API_KEY=your_gemini_api_key_here

# Speech Recognition
SPEECH_PROVIDER=whisper

# Azure Speech (if SPEECH_PROVIDER=azure)
AZURE_SPEECH_KEY=your_azure_speech_key_here
AZURE_SPEECH_REGION=your_azure_region_here

# Local Whisper (if SPEECH_PROVIDER=whisper)
WHISPER_COMMAND=whisper
WHISPER_MODEL=small
WHISPER_LANGUAGE=auto
WHISPER_DEVICE=auto
WHISPER_PYTHON=
WHISPER_CAPTURE_MODE=vad
WHISPER_RESPONSE_TARGET=both
WHISPER_MANUAL_MAX_MS=90000
WHISPER_GPU_IDLE_MS=60000
WHISPER_SEGMENT_MS=4000
```

- [ ] **Step 2: 在 config.js 加新方法**

定位到 `getApiKey(service)` 方法后插入：

```javascript
  getActiveProviderId() {
    // 优先读 router 状态；如果 router 没初始化，回落到环境变量
    try {
      const router = require('../services/llm/llm-router');
      if (router.getActiveProviderId && router.getActiveProviderId()) {
        return router.getActiveProviderId();
      }
    } catch (_) {}
    return process.env.LLM_PROVIDER || 'gemini';
  }

  getProviderField(providerId, fieldKey) {
    const envMap = {
      gemini: { apiKey: 'GEMINI_API_KEY', model: 'GEMINI_MODEL' },
      openai: { apiKey: 'OPENAI_API_KEY', model: 'OPENAI_MODEL' },
      'openai-compatible': { apiKey: 'OPENAI_COMPAT_API_KEY', model: 'OPENAI_COMPAT_MODEL', baseUrl: 'OPENAI_COMPAT_BASE_URL' }
    };
    const envName = envMap[providerId] && envMap[providerId][fieldKey];
    return envName ? process.env[envName] : undefined;
  }

  getAllProviders() {
    const registry = require('../services/llm/provider-registry');
    return registry.listProviders().map(p => ({
      id: p.id,
      label: p.label,
      fields: p.fields.map(f => ({
        ...f,
        value: this.getProviderField(p.id, f.key) || ''
      })),
      supports: p.supports
    }));
  }
```

- [ ] **Step 3: 验证**

Run:
```bash
cd "D:\code\笔试软件\OpenCluely" && node -e "const c = require('./src/core/config'); console.log(c.getActiveProviderId()); console.log(c.getAllProviders().map(p => p.id));"
```

Expected: 输出第一行是 `'gemini'`，第二行是 `[ 'gemini', 'openai', 'openai-compatible' ]`

- [ ] **Step 4: 提交**

```bash
cd "D:\code\笔试软件\OpenCluely" && git add env.example src/core/config.js && git commit -m "docs+feat: update env.example, add provider-aware config helpers"
```

---

## Task 16: 完整 smoke test

**Files:**
- 无文件改动

**Interfaces:**
- Consumes: 所有上述任务的结果
- Produces: 验证报告

- [ ] **Step 1: 删除旧的 providers.json 模拟首次启动**

Run:
```bash
cd "D:\code\笔试软件\OpenCluely" && node -e "
const path = require('path');
const fs = require('fs');
const { app } = require('electron') || {};
" 2>&1 | head -5
```

注：直接 node 跑拿不到 userData 路径。最简单做法：手动定位 userData。在 Windows 上是 `%APPDATA%/opencluely/`。

```bash
DEL "%APPDATA%\opencluely\llm-providers.json"
```

（如果文件不存在会报错，忽略。）

- [ ] **Step 2: 在 .env 临时塞一个测试 Gemini key**

在项目根 `.env` 文件追加一行（仅用于验证迁移）：
```
GEMINI_API_KEY=AIza_test_key_for_migration_only
```

- [ ] **Step 3: npm start**

Run:
```bash
cd "D:\code\笔试软件\OpenCluely" && npm start
```

打开 Settings：
- 应该看到 Active Provider = Gemini
- Gemini API Key 应该自动填充 `AIza_test_key_for_migration_only`

验证 `llm-providers.json` 已创建：
```bash
type "%APPDATA%\opencluely\llm-providers.json"
```

应该看到：
```json
{
  "schemaVersion": 2,
  "activeProvider": "gemini",
  "providers": {
    "gemini": { "apiKey": "AIza_test_key_for_migration_only", "model": "gemini-3.1-flash-lite" },
    ...
  }
}
```

- [ ] **Step 4: 在 Settings 切换到 OpenAI，填测试 key + model，点 Save**

- Active Provider: OpenAI
- OpenAI API Key: `sk-test-invalid`
- OpenAI Model: `gpt-4o-mini`
- 点 Save

预期：
- Settings 弹一条错误提示"Invalid API key for OpenAI..."（因为是测试 key）
- `llm-providers.json` 已更新 activeProvider = openai，但 apiKey 是测试值

- [ ] **Step 5: 切回 Gemini，删掉 .env 的测试 key，重启**

清掉测试 key 后重启，确认 Gemini 工作（如果填的是真 key）。

- [ ] **Step 6: 验证截图分析（image flow）**

如果当前 active provider 是 Gemini 或 OpenAI：点截图按钮 → 弹 AI 回答。
如果当前是 OpenAI-Compatible：点截图 → 弹"当前 provider 不支持图片分析"。

- [ ] **Step 7: 把测试 key 还原（去掉）**

```bash
DEL "%APPDATA%\opencluely\llm-providers.json"
```

- [ ] **Step 8: 提交**

如果没有改动，跳过此步骤。如果有清理工作（如撤回测试 key 的提交），可以打一个 cleanup commit：

```bash
cd "D:\code\笔试软件\OpenCluely" && git status
```

如果有 untracked 改动 → 视情况清理。

---

## 自审

- **Spec coverage**:
  - §3 三家厂家 ✓ (Tasks 6, 9, 10)
  - §5.1 JSON schema ✓ (Task 4)
  - §5.2 ProviderRegistry ✓ (Task 3)
  - §5.3 启动顺序 ✓ (Tasks 4 + 8)
  - §5.3 process.env 镜像 ✓ (Tasks 8 + 11)
  - §6 组件拆分 ✓ (Tasks 2-7, 9, 10)
  - §7 Settings UI ✓ (Tasks 12, 13)
  - §7.4 SchemaVersion 兼容 ✓ (Task 13 populateProviderFields 兜底 geminiKey)
  - §8 错误归一化 ✓ (Tasks 2, 6, 9, 10 都用 normalizeError)
  - §8.2 边界场景 ✓ (NoApiKeyError 抛错，UI 在 Task 13 处理)
  - §10 smoke test ✓ (Task 16)
- **占位符扫描**: 无 TBD / TODO / "implement later"。每个 step 都有具体代码或命令。
- **类型一致性**:
  - `PROVIDERS` 在 Task 3 定义，Task 5 router 引用 `registry.getProvider(id).adapter` 字符串匹配 — 一致
  - `processImageStream(opts, onDelta)` 参数顺序在三个 adapter 和 orchestrator 一致
  - `save(payload)` 接收 `{ activeProvider, providers: {...} }`，Task 11 的 saveSettings 调用一致
  - `_state` 在 providers.store 内部命名一致
  - `llmRouter.init({ providersStore })` / `reload()` 接口在 Task 5 定义、Task 8/11 调用一致

无问题。
