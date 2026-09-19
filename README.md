<div align="center">

# OpenCluely

**隐形的 AI 面试助手。**

一个屏幕录制与会议软件都看不到的悬浮覆盖层。语音提问或截图提问,AI 实时给出清晰答案,流式显示在浮窗里。

<p>
  <a href="https://github.com/TechyCSR/OpenCluely/releases/latest"><img src="https://img.shields.io/github/v/release/TechyCSR/OpenCluely?style=for-the-badge&label=Latest&color=111111&labelColor=000000" alt="Latest release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-111111?style=for-the-badge&labelColor=000000" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/Platforms-Windows%20%7C%20macOS%20%7C%20Linux-111111?style=for-the-badge&labelColor=000000" alt="Platforms" />
</p>

</div>

---

## 安装

### Windows / macOS / Linux — 从源码运行

```bash
git clone https://github.com/TechyCSR/OpenCluely.git
cd OpenCluely
./setup.sh        # Windows 请用 Git Bash
```

`setup.sh` 会自动:安装 Node 依赖、根据 `.env.example` 生成 `.env`、搭建本地 Whisper 虚拟环境、写入配置,然后启动应用。

首次启动会自动打开设置窗口。前往 [Google AI Studio](https://aistudio.google.com/) 申请免费的 Gemini API Key 粘贴进去即可,或直接编辑 `.env`。设置改动无需重启即可生效。

### 平台说明

- Windows:用 Git Bash 或 WSL 运行 `setup.sh`。
- macOS / Linux:直接用终端即可。
- macOS 没有预编译包,必须从源码运行(因为应用未签名)。
- 所有步骤由 `setup.sh` 自动完成,无需手动 `npm install`。

### `setup.sh` 可选参数

```bash
./setup.sh --build                # 构建当前系统的安装包
./setup.sh --ci                   # 使用 npm ci 而不是 npm install
./setup.sh --no-run               # 仅初始化,不启动应用
./setup.sh --install-system-deps  # 安装麦克风依赖 sox(可选)
./setup.sh --skip-whisper         # 跳过本地 Whisper 初始化
```

---

## 功能特性

### 🤖 AI 答题

- **多模型支持**:内置 Gemini 适配器,以及 OpenAI、OpenAI 兼容协议适配器,可在设置中切换。
- **流式回答**:AI 回复逐字流入浮窗,无需等待完整答案。
- **多语言代码回答**:针对 C++、C、Python、Java、JavaScript 给出对应的代码风格答案(顶部下拉框切换)。
- **DSA 技能模式**:内置数据结构与算法专项提示词,提升算法题的回答质量。
- **Markdown + 代码高亮**:AI 响应窗口支持 Markdown 渲染和 Prism.js 代码高亮,可一键复制代码块。
- **会话记忆**:整个对话过程在本地保留,追问、边界情况、优化讨论都会带上完整上下文。

### 📸 截图分析

- **直接喂给 Gemini 看图**:截图后无需 OCR,直接作为图像发给 Gemini 做视觉推理。
- **批量截图队列**:可连续按 `Ctrl+Alt+S` 截多张,最多入队 10 张,统一提交分析(`Ctrl+Alt+D`)。
- **队列可视**:截图中下方出现一个水平条带显示当前队列内容。
- **多显示器支持**:支持选择具体显示器或自定义区域截图。

### 🎙️ 语音识别

- **本地 Whisper**:支持本地离线转写(`openai-whisper`),可选模型 `tiny/base/small/medium/large`,支持 CUDA 加速,闲置时自动释放 GPU。
- **Azure 语音**:也支持 Azure Speech 作为云端备选。
- **两种捕获模式**:
  - **VAD(语音活动检测)**:自动识别开始/结束,无需手动按键。
  - **手动**:按 `Alt+R` 开始/停止录音,可录最长 90 秒。
- **智能过滤**:自动丢弃静音时 Whisper 产生的"幻觉短语"。
- **可选回答目标**:语音回答可路由到聊天窗、浮窗,或两者同时。
- **可选配置**:无语音配置时,麦克风按钮自动隐藏,不显示无意义的入口。

### 🕶️ 隐身与隐私

- **屏幕录制不可见**:所有覆盖层在 Zoom / Google Meet / Microsoft Teams / Discord / OBS 抓取中均不可见。
- **屏幕共享自动隐藏**:检测到屏幕共享开始时自动隐藏所有窗口。
- **隐身模式**(`Ctrl+Shift+H`):一键隐藏全部 overlay 并暂停轮询,适合遇到监考切换页面时快速反应。
- **点击穿透**(`Ctrl+Shift+I` 或 `Alt+A`):窗口默认不拦截鼠标事件,不影响浏览器操作;按一次切换为可交互模式后可点击。
- **应用程序图标伪装**:可设置应用图标伪装成普通工具(如计算器、记事本)。
- **进程名伪装**:可使用 `--stealth` 启动参数以普通系统名称运行。
- **零遥测**:无任何数据上报,会话信息全部本地保存。
- **AI 响应紧凑默认**(450×300):默认窗口故意做小,避免在双机位监控下被房间摄像头拍到 AI 答案。

### 🎛️ 浮窗与窗口管理

- **无边框透明覆盖层**:主导航栏、聊天窗、AI 响应窗、截图队列条都是 frameless + transparent。
- **导航栏 + AI 响应无缝衔接**:`windowGap = 0`,两个面板看起来像一个整体,中间无空隙。
- **可拖到屏幕外**:取消屏幕边缘夹紧,允许悬浮窗移到屏幕外以避免遮挡特定内容(兼容多屏和不同 DPI 缩放)。
- **不可边缘拖拽放大**:`resizable: false`,避免光标靠近边缘时窗口被意外拉伸。
- **内容保护**:开启 `setContentProtection(true)`,防止被屏幕录制抓到。
- **窗口置顶**:可设置所有 overlay 永远置顶(`Ctrl+Shift+T`),自检置顶状态(`Ctrl+Shift+Alt+T`)。
- **个性化尺寸持久化**:通过 `Ctrl+[` / `Ctrl+]` 调整过的大小会保存,下次启动仍然有效。
- **零隐藏成本**:按 `Ctrl+Shift+V` 一键显示/隐藏所有 overlay,任何状态都能秒切。

### 💬 聊天窗

- **独立聊天面板**(`Ctrl+Shift+C`):与 AI 进行多轮对话,UI 与 AI 响应窗分离,适合长时间讨论。
- **代码块一键复制**:聊天消息中的代码块右上角带复制按钮。
- **会话记忆联动**:聊天窗、AI 响应窗、语音回答共享同一份会话历史。
- **清空记忆**(`Ctrl+Shift+\`):一键清空本地会话历史。

### ⚙️ 设置

- **设置入口**(`Ctrl+,`):可设置 API Key、语音提供商、模型选择、捕获模式、回答目标、伪装图标等。
- **首次启动引导**:首次打开应用时自动展示设置引导流程,可选择安装本地 Whisper。
- **一键诊断**:设置中提供 Gemini 连接测试与诊断。

### 🌍 跨平台

- **Windows**:NSIS 安装包 + Portable 绿色版。
- **Linux**:`.deb`(自动拉 Python、ffmpeg、GTK 依赖)和 `AppImage`(免安装)。
- **macOS**:源码运行(`./setup.sh` 即可,一行命令搞定)。
- **多显示器与多 DPI**:支持多屏布局,跨屏移动窗口不会跑偏。

---

## 快捷键总览

> 所有 `Ctrl` 在 macOS 上对应 `Cmd`。`Alt+A` 在任何地方都能切换交互模式(可点击/穿透)。

### 📸 截图相关

| 快捷键 | 功能 |
|---|---|
| `Ctrl + Alt + S` | 截图并加入截图队列(最多 10 张) |
| `Ctrl + Alt + D` | 把队列中所有截图一次性发给 AI 分析 |
| `Ctrl + Alt + X` | 清空截图队列 |

### 🤖 AI / 语音

| 快捷键 | 功能 |
|---|---|
| `Alt + R` | 开始/停止语音识别 |

### 🪟 窗口控制

| 快捷键 | 功能 |
|---|---|
| `Ctrl + Shift + V` | 显示 / 隐藏所有 overlay |
| `Ctrl + Shift + I` 或 `Alt + A` | 切换交互模式(可点击 ↔ 点击穿透) |
| `Ctrl + Shift + C` | 打开聊天窗 |
| `Ctrl + ,` | 打开设置 |
| `Ctrl + Shift + \` | 清空会话记忆 |
| `Ctrl + Shift + H` | 隐身模式(隐藏全部 overlay 并暂停轮询) |
| `Ctrl + Shift + T` | 强制所有 overlay 置顶 |
| `Ctrl + Shift + Alt + T` | 自检所有 overlay 置顶状态 |
| `Ctrl + Alt + Q` | 彻底退出应用（绕过隐身模式与托盘残留） |

### ↔️ 浮窗位置与尺寸(唯一会改变窗口位置/尺寸的快捷键)

| 快捷键 | 功能 |
|---|---|
| `Ctrl + ↑ / ↓ / ← / →` | 浮窗 上 / 下 / 左 / 右 移动(20 像素/次) |
| `Ctrl + [` / `Ctrl + ]` | 整体悬浮窗 缩小 / 放大(主窗、聊天窗、AI 响应一起) |
| `Tab + ↑ / ↓` | AI 响应内容 上 / 下翻页(窗口不动,只滚内容) |

### 🎨 透明度

| 快捷键 | 功能 |
|---|---|
| `Alt + =` | 增加不透明度(更不透明) |
| `Alt + -` | 降低不透明度(更透明,可到全透明) |
| `Alt + 0` | 恢复默认不透明度 |

> 为什么截图用 `Ctrl+Alt` 而不是 `Ctrl+Shift`?因为 `Ctrl+Shift+S` 被很多应用占用(截图工具、Teams、OneDrive、GitHub Desktop、VS Code 等),在 Windows 上系统会把按键交给先注册者,导致旧快捷键"时而能用时而不灵"。`Ctrl+Alt+S/D/X` 几乎没人占用,Electron 的全局注册成功率几乎 100%。

---

## 配置

`.env` 中唯一必需的是 Gemini API Key:

```bash
# 必需
GEMINI_API_KEY=your_gemini_api_key_here

# 可选语音提供商,选一个
SPEECH_PROVIDER=whisper

# Azure 语音
AZURE_SPEECH_KEY=your_azure_speech_key
AZURE_SPEECH_REGION=your_region

# 本地 Whisper
WHISPER_COMMAND=whisper
WHISPER_MODEL_DIR=.whisper-models
WHISPER_MODEL=small
WHISPER_LANGUAGE=auto
WHISPER_DEVICE=auto
WHISPER_PYTHON=
WHISPER_CAPTURE_MODE=vad          # vad(自动)或 manual(手动)
WHISPER_RESPONSE_TARGET=both      # chat / overlay / both
WHISPER_MANUAL_MAX_MS=90000
WHISPER_GPU_IDLE_MS=60000
```

语音可选 — 不配置任何语音提供商时,整个应用的麦克风入口都会自动隐藏。

### 可选的语音设置

- **本地 Whisper**:`./setup.sh` 会全自动初始化(创建 `.venv-whisper`、安装 `openai-whisper`、写入 `.env`、创建 `.whisper-models`、跑一次语音自测)。
- **Azure Speech**:在 [Azure Portal](https://portal.azure.com/) 创建语音资源,把 key 和 region 写入 `.env`(`SPEECH_PROVIDER=azure`)。

---

## 工作流程

1. **提问**:用 VAD 自动起停、手动按 `Alt+R`、或者按 `Ctrl+Alt+S` 截图。
2. **推理**:Gemini 直接读图像或音频,带上完整会话上下文,给出精确答案。
3. **回答**:回答流式进入浮窗或聊天窗(由设置决定),代码块自动高亮,鼠标悬停可一键复制。

---

## 故障排查

### 安装问题

- **`setup.sh` 无法运行**:确保在项目目录下(`cd OpenCluely`),且脚本有执行权限(`chmod +x setup.sh`)。Windows 上请用 Git Bash。
- **退出码 130**:说明按了 Ctrl+C,重新运行 `./setup.sh` 即可。
- **依赖安装失败**:检查 Node.js 版本 ≥ 18。
- **Whisper 安装失败**:可加 `--skip-whisper` 先跳过,语音功能之后再配。

### 运行时问题

- **AI 响应窗不显示**:确认按了 `Ctrl+Alt+D` 而不是只截图了。检查 Gemini Key 是否在设置中正确填写。
- **快捷键不生效**:检查是否有其他应用(如 Snipping Tool、Stream Deck)占用了 `Ctrl+Alt+S/D/X`。
- **麦克风按钮消失**:未配置任何语音提供商,这是预期行为。去设置里配 Whisper 或 Azure。
- **屏幕共享时仍能看到 overlay**:确认会议软件的"屏幕共享窗口"选项没有勾选 — 应共享"整个屏幕"或"显示器"。Overlay 用了 `setContentProtection`,只有深度系统级抓屏才会泄漏。
- **窗口位置奇怪**:试 `Ctrl+↑/↓/←/→` 把浮窗移回来。窗口现在允许被拖到屏幕外以适配多屏。

---

## 开发

### 项目结构

```
OpenCluely/
├── main.js                      # Electron 主进程入口
├── preload.js                   # contextBridge IPC 暴露
├── index.html                   # 顶部导航栏(主覆盖层)
├── llm-response.html            # AI 响应浮窗
├── chat.html                    # 聊天窗
├── screenshot-queue.html        # 截图队列条带
├── settings.html                # 设置面板
├── onboarding.html              # 首次启动引导
├── src/
│   ├── core/                    # 配置、日志、首次运行
│   ├── managers/
│   │   ├── window.manager.js    # 所有覆盖层窗口管理
│   │   └── session.manager.js   # 会话记忆
│   ├── services/
│   │   ├── capture.service.js   # 截图 + 图像分析
│   │   ├── speech.service.js    # 语音编排
│   │   ├── whisper-worker.service.js
│   │   ├── llm.service.js       # LLM 入口
│   │   └── llm/
│   │       ├── adapters/        # gemini / openai / openai-compatible
│   │       └── llm-router.js    # 适配器路由
│   ├── ui/                      # 各窗口的渲染逻辑
│   └── styles/                  # 通用样式
├── prompts/                     # DSA / 其他技能 prompt
├── scripts/                     # Whisper worker / 辅助脚本
└── setup.sh                     # 跨平台一键初始化
```

### 启动开发模式

```bash
./setup.sh --no-run    # 仅初始化
npm run dev            # electron . --no-sandbox
```

### 打包发布

```bash
npm run build          # 当前平台
npm run build:win      # Windows NSIS + Portable
npm run build:mac      # macOS dmg + zip
npm run build:linux    # AppImage + deb
```

---

## 隐私承诺

- **不收集任何遥测数据**。
- **会话记忆只存在本地**(`session.memory.json`),可随时 `Ctrl+Shift+\` 清空。
- **API 调用只发送必要内容**:截图、语音转写文本、当前问题 — 不会附带任何用户标识。
- **AI 响应窗口紧凑默认**(450×300):避免在双机位面试监控下被房间摄像头拍到 AI 答案;需要大窗口时按 `Ctrl+]` 即用即放。
- **窗口允许拖到屏幕外**:应对监考/防作弊系统的"屏幕边界检测"。
- **隐身模式**(`Ctrl+Shift+H`):一键消失所有 overlay,不弹任何提示。
- **不写入浏览器历史/不触发页面失焦**:overlay 不抢焦点,即使监考软件检测浏览器焦点变化也不会被触发。

---

## 许可证

MIT License — 详见 [LICENSE](LICENSE) 文件。

## 致谢

由 [@TechyCSR](https://techycsr.dev) 制作。
