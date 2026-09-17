# 多厂家 LLM 动态配置 — 设计规格

**日期**：2026-09-17
**状态**：待用户审阅
**目标**：让用户在 EXE 的 Settings 里动态切换 / 配置多个 LLM 厂家的 API key，不再硬编码 Gemini。

---

## 1. 背景与动机

当前 OpenCluely 只有一个 LLM 厂家 — Google Gemini：
- 逻辑硬编码在 `src/services/llm.service.js`（1655 行）
- API key 通过 `GEMINI_API_KEY` 环境变量读取
- Settings UI 只有一个 `geminiKey` 输入框
- README 已标注 "Planned: Multiple model backends alongside Gemini (OpenAI, Anthropic, local)"

这次改造把这个限制拆掉。

## 2. 目标 & 非目标

**目标**：
- 支持 Gemini / OpenAI / OpenAI 兼容（DeepSeek / Ollama / OpenRouter / 自定义代理）三个选项
- 用户在 Settings 里填各家的 key + model（OpenAI 兼容额外填 baseUrl）
- 用户选一个"当前激活的 provider"，运行时无重启切换
- Settings 改完立即写入 `userData/llm-providers.json`（结构化存储，原子写）
- 老的 `.env` 中的 `GEMINI_API_KEY` 自动迁移到 JSON，向后兼容

**非目标**（明确不做）：
- 不支持 Anthropic Claude（用户没选）
- 不支持 OAuth 流程，仅 API key
- 不做 per-request 路由（同一时刻只用一个 provider）
- 不做使用量统计、计费、配额看板
- 不引入 SQL/SQLite 持久层（用 JSON 文件）
- 不重写语音 / 截图 / Whisper 等无关模块

## 3. 用户决策记录

| 决策点 | 选择 |
|---|---|
| 支持哪些厂家 | Gemini + OpenAI + OpenAI 兼容 |
| 选择模式 | "当前激活 provider" + 多 key 同时存储 |
| 配置粒度 | OpenAI: key+model；OpenAI 兼容: key+model+baseUrl |
| Settings UI 布局 | 下拉切换激活 provider + 当前 provider 表单 + 其他折叠 |
| 持久化方式 | `userData/llm-providers.json`（无 SQLite） |
| 架构模式 | Adapter 模式 + Provider 注册表 |

## 4. 架构总览

```
┌─────────────────────────────────────┐
│  UI / 语音 / 截图 / Chat            │  ← 调用方不变
└────────────────┬────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│  LLMService (orchestrator, ~150 行) │
│  - public API 不变                  │
│  - 内部从 router 取 adapter          │
└────────────────┬────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│  LLMRouter + ProviderRegistry       │
│  - 知道有哪些 provider              │
│  - 暴露 getActive()                 │
└────────────────┬────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│  Adapter (Gemini|OpenAI|OpenAI-     │
│  Compatible)                         │
│  - 厂家逻辑全封在这里                │
└─────────────────────────────────────┘
```

**关键不变量**：
- LLMService 公开方法签名（`processTextWithSkill`、`processImageWithSkill`、`processImageWithSkillStream` 等）保持不变 → 上层调用方零修改
- 激活 provider 热切换不需要重启 → LLMService 每次进入方法时通过 `router.getActive()` 取最新 adapter
- `.env` 文件不再参与 LLM key 持久化；只是首次启动时的一次性迁移源

## 5. 数据模型

### 5.1 `userData/llm-providers.json`

```json
{
  "schemaVersion": 2,
  "activeProvider": "gemini",
  "providers": {
    "gemini": {
      "apiKey": "AIza...",
      "model": "gemini-3.1-flash-lite"
    },
    "openai": {
      "apiKey": "sk-...",
      "model": "gpt-4o-mini"
    },
    "openai-compatible": {
      "apiKey": "sk-...",
      "model": "deepseek-chat",
      "baseUrl": "https://api.deepseek.com/v1"
    }
  }
}
```

### 5.2 Provider 注册表（`src/services/llm/provider-registry.js`，代码常量）

```js
const PROVIDERS = {
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    adapter: 'gemini',
    fields: [
      { key: 'apiKey', label: 'API Key', type: 'password' },
      { key: 'model',  label: 'Model',   type: 'text', default: 'gemini-3.1-flash-lite' }
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
        placeholder: 'gpt-4o, gpt-4o-mini, o1-mini, ...' }
    ],
    supports: { text: true, image: true, streaming: true }
  },
  'openai-compatible': {
    id: 'openai-compatible',
    label: 'OpenAI Compatible (DeepSeek / Ollama / OpenRouter / Custom)',
    adapter: 'openai-compatible',
    fields: [
      { key: 'apiKey',  label: 'API Key',  type: 'password' },
      { key: 'model',   label: 'Model',    type: 'text', required: true },
      { key: 'baseUrl', label: 'Base URL', type: 'text', required: true,
        placeholder: 'https://api.deepseek.com/v1' }
    ],
    supports: { text: true, image: false, streaming: true }
  }
};
```

### 5.3 配置加载顺序

1. `dotenv.config({ path: ENV_PATH })` — 现有逻辑，加载 `.env`
2. `ProvidersStore.init()`：
   - 读 `llm-providers.json`
   - 文件不存在 + `.env` 有 `GEMINI_API_KEY` → 自动迁移到 JSON → 写文件
   - 文件存在 → 直接解析
3. 把激活 provider 的字段镜像到 `process.env`：
   - `process.env.GEMINI_API_KEY`、`process.env.GEMINI_MODEL`
   - `process.env.OPENAI_API_KEY`、`process.env.OPENAI_MODEL`
   - `process.env.OPENAI_COMPAT_API_KEY`、`process.env.OPENAI_COMPAT_MODEL`、`process.env.OPENAI_COMPAT_BASE_URL`
   → 保证 `config.getApiKey('GEMINI')` 这类老调用继续工作
4. `LLMRouter.init()` — 按 `activeProvider` 实例化 adapter
5. `LLMService` 拿到 router 引用 → 准备接收请求

## 6. 组件拆分

### 新增文件

| 路径 | 职责 |
|---|---|
| `src/services/llm/provider-registry.js` | 厂家元数据：id、label、fields、supports |
| `src/services/llm/providers.store.js` | 读/写/原子写 `llm-providers.json`；首次启动从 `.env` 迁移 |
| `src/services/llm/llm-router.js` | 内存里的当前激活 adapter 单例；监听 settings 变更热切换 |
| `src/services/llm/adapters/gemini.adapter.js` | 从现有 `llm.service.js` 迁出 Gemini 实现 |
| `src/services/llm/adapters/openai.adapter.js` | OpenAI 实现（用 `openai` npm 包） |
| `src/services/llm/adapters/openai-compatible.adapter.js` | OpenAI 兼容（`openai` 包 + 自定义 baseURL） |
| `src/services/llm/errors.js` | 统一错误归一化 |

### 修改文件

| 路径 | 改动 |
|---|---|
| `src/services/llm.service.js` | 重写为 orchestrator（~150 行），public API 签名不变 |
| `src/core/config.js` | 新增 `getActiveProviderId()`、`getProviderField(id, key)`、`getAllProviders()` |
| `main.js` | `getSettings()` 返回新结构；`saveSettings()` 持久化到 JSON + 触发 router reload |
| `src/ui/settings-window.js` | 渲染动态 provider 表单；保存时一次性提交 |
| `settings.html` | 加 provider dropdown + 表单容器 |
| `src/core/first-run.js` | 不再检测 GEMINI key 存在；改为检测 JSON 文件 + 激活 provider 是否就绪 |
| `package.json` | 新增 `openai` 依赖（`^4.x`） |
| `env.example` | 文档化新结构（不再含 `GEMINI_API_KEY` 字段样板，引导用户用 Settings） |

### Settings 热切换流程

```
UI 改 dropdown / 字段 → save-settings IPC
  → main.js saveSettings():
       校验字段
       ProvidersStore.save(payload)   // 原子写 llm-providers.json
       镜像字段到 process.env
       LLMRouter.reload()            // 重新实例化 adapter
       broadcast 'providers-updated'
  → 下一次 processText/processImage 调用走新 adapter
```

## 7. Settings UI 行为

### 布局

```
┌─ AI Provider ─────────────────────────────────┐
│ Active Provider: [ OpenAI                ▼ ]   │
│                                                │
│ ┌─ OpenAI Settings ────────────────────────┐   │
│ │ API Key:  [•••••••••••••••••••••] 👁      │   │
│ │ Model:    [ gpt-4o-mini                ]   │   │
│ │ [Test connection]   ✓ Connected (213ms)   │   │
│ └────────────────────────────────────────────┘   │
└────────────────────────────────────────────────┘
┌─ Other providers (collapsed) ──────────────────┐
│ > Google Gemini        (configured)              │
│ > OpenAI Compatible    (not configured)          │
└─────────────────────────────────────────────────┘
              [ Cancel ]   [ Save ]
```

要点：
- 顶部始终显示激活 provider 的可编辑表单
- 下面折叠列表显示其他 provider 的状态
- 状态徽章根据上次 `testConnection()` 结果（"configured" / "not configured" / "error: ..."）

### 校验规则

| 字段 | 规则 |
|---|---|
| `activeProvider` | 必须在注册表里 |
| 当前 provider 的 `apiKey` | 切换到该 provider 时必填；其他 provider 可空 |
| `openai-compatible.model` | 必填 |
| `openai-compatible.baseUrl` | 必填；`new URL()` 不抛错 |

校验失败 → Save 返回 `{ success: false, error: '...' }`，UI 红色错误条展示 3 秒。

### Test connection

- 只测当前激活 provider
- 不写入磁盘 / process.env，纯只读测试
- 成功后显示延迟，5 秒后回到默认状态

### IPC 契约

```
electronAPI.getSettings() → Promise<{
  schemaVersion: 2,
  activeProvider, providers: { gemini, openai, 'openai-compatible' },
  // 现有字段继续保留:
  speechProvider, azureKey, azureRegion, whisper*, windowGap, codingLanguage, activeSkill, ...
}>

electronAPI.saveSettings(settings) → Promise<{ success, error?, persistedKeys? }>
```

### 与现有 Gemini UI 的兼容

- 老的 `geminiKey` input 字段保留为隐藏兼容层
- 加载时 `geminiKey` → `providers.gemini.apiKey` 平移
- 第一次保存后老字段从 UI 移除（用 `schemaVersion` 标志位控制）

## 8. 错误处理

### 8.1 统一错误归一化（`src/services/llm/errors.js`）

每个 adapter 内部识别自家错误，对外只暴露统一结构：

```js
{
  type: 'AUTH_ERROR' | 'RATE_LIMIT_ERROR' | 'NETWORK_ERROR' |
        'TIMEOUT_ERROR' | 'MODEL_ERROR' | 'INVALID_REQUEST' | 'UNKNOWN',
  provider: 'openai',
  userMessage: 'OpenAI 拒绝了你的 API key，请到 platform.openai.com 检查',
  technicalMessage: '401 Incorrect API key provided: ***',
  retryable: false,
  statusCode: 401
}
```

### 8.2 边界场景

| 场景 | 行为 |
|---|---|
| JSON 损坏 | 备份为 `llm-providers.json.bak`；回空状态；Settings 重新配置 |
| 首次启动 + `.env` 有 `GEMINI_API_KEY` | 自动迁移；`activeProvider = 'gemini'` |
| 用户清空所有 key | `activeProvider` 保留；adapter `isInitialized = false`；下次请求抛 `NoApiKeyError` |
| 切换到 key 为空的 provider | Settings UI 阻止；如直接改 JSON 绕过，LLM 调用抛错 |
| `openai-compatible.baseUrl` 格式错 | `testConnection()` 返回友好错误 |
| OpenAI 流式断连 | Adapter 内部重试一次；失败回落非流式 |
| 当前 provider 不支持图片 + 用户点截图 | 浮层提示"当前 provider 不支持截图分析，已切换到 Gemini"（如 Gemini 有 key） |

### 8.3 加载顺序保证

LLMService 每次进入方法时**重新取** adapter 引用：

```js
const adapter = router.getActive();
if (!adapter) throw new NoApiKeyError(...);
return adapter.processText(...);
```

Router 的 `setActive()` 是同步、不可变替换，纳秒级开销。

## 9. 依赖

新增一个 npm 依赖：

```json
"dependencies": {
  "openai": "^4.77.0"
}
```

为什么用 `openai` 而不是手写 fetch：
- 官方 SDK，覆盖 Chat Completions / Vision / Streaming 全部场景
- OpenAI 兼容只换 `baseURL` 一个参数即可
- 现有项目已经有 `@google/genai` 和 `microsoft-cognitiveservices-speech-sdk`，加一个 SDK 是常态

## 10. 测试策略

### 必做 — 手工 smoke test（每项 ≤ 30 秒）

| # | 验证 | 操作 |
|---|---|---|
| 1 | 启动不崩 | `npm start` 进入主浮层 |
| 2 | 老用户迁移 | 删 `llm-providers.json`，在 `.env` 塞 `GEMINI_API_KEY`，重启 → 自动迁移 |
| 3 | 切到 OpenAI | Settings 选 OpenAI，填真 key + `gpt-4o-mini`，Save → 截图分析成功 |
| 4 | 切到 OpenAI 兼容（DeepSeek） | 填 key/model/baseUrl，Save → 文字问答成功 |
| 5 | 热切换 | 不重启，DeepSeek → Gemini，下一条问题走 Gemini |
| 6 | 空 key 拦截 | 清空 OpenAI key，Save → 弹错，JSON 不变 |
| 7 | Test connection | 每个 provider 测一次 |
| 8 | 截图边界 | 切到 Ollama（不开 vision），点截图 → 友好错误 |
| 9 | 现有功能 | Whisper / 截图 / 聊天 / 快捷键全部正常 |
| 10 | 持久化 | 关 EXE 再开 → 设置保留 |

### 可选 — 自动化单元测试（后续，不阻塞"跑起来"）

```
test/
  llm-router.test.js          # activeProvider 切换 / reload / 边界
  providers.store.test.js     # JSON 读写 / 迁移 / 原子写 / 损坏恢复
  adapters/
    gemini.adapter.test.js
    openai.adapter.test.js
```

命令：
```json
"test": "node --test test/"
```

## 11. 风险与开放问题

| 风险 | 缓解 |
|---|---|
| OpenAI 兼容厂家 vision 支持参差 | `supports.image` 字段先标 `false`；如要开启由具体 provider 决定 |
| OpenAI 流式响应格式和 Gemini 不同 | 抽象 `onDelta(delta)` 回调，每家 adapter 内部解析自家 SSE |
| `process.env` 镜像 + JSON 双源可能漂移 | 启动时从 JSON 写到 env；之后每次 saveSettings 同步；读取永远从 router 走 |
| OpenAI SDK 在 Electron 主进程的兼容性 | 已验证：官方支持 Node 18+；当前 Electron 29 含 Node 20 |
| 用户绕过 UI 直接编辑 JSON 后字段格式错 | `ProvidersStore` 启动时做 schema 校验；失败回退空配置 |
