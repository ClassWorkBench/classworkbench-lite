# 班级工作台 Lite (ClassWorkBench Lite) · Code Wiki

> 版本：1.0.0　|　应用 ID：`com.classworkbench.lite`　|　技术栈：Electron 33 + 原生 JS/CSS
> 本文档描述 **ClassWorkBench Lite（精简版）** 的代码结构。完整版另有拍照搜题、相机扫描、数据加密与 QQ 通知捕获（C# Sidecar）等功能，Lite 版均已移除。

---

## 目录

1. [项目概览](#1-项目概览)
2. [整体架构](#2-整体架构)
3. [目录结构](#3-目录结构)
4. [主进程（main.js + main/ 模块）](#4-主进程mainjs--main-模块)
5. [预加载脚本](#5-预加载脚本)
6. [渲染进程模块详解](#6-渲染进程模块详解)
7. [数据模型与存储设计](#7-数据模型与存储设计)
8. [IPC 通信协议](#8-ipc-通信协议)
9. [关键业务流程](#9-关键业务流程)
10. [样式架构](#10-样式架构)
11. [依赖关系](#11-依赖关系)
12. [构建与运行](#12-构建与运行)

---

## 1. 项目概览

**班级工作台 Lite** 是一款面向中学班级场景的 Electron 桌面应用，核心用途是**在班级大屏上展示当日各学科作业**，并配套晚修进度、天气与预警、云端背景图、浮窗画中画等实用功能。

### 核心功能

| 功能 | 说明 |
|---|---|
| 作业管理 | 录入 / 编辑 / 删除 / 归档 / 恢复，按学科分组、按截止时间排序 |
| 学科系统 | 8 学科预设配色，可增删改名称 / 颜色 / 图标 |
| 天气预警 | 多城市搜索管理，和风天气 + Open-Meteo 双数据源，四级预警 |
| 画中画浮窗 | 每个作业卡独立置顶窗口，贴边探头交互 |
| 备份恢复 | 手动导出 / 导入、恢复前自动快照、按月归档收集与写回 |
| 个性化 | 5 套配色、取色器、背景图源（Upx8 / XXAPI / 兔图苑）、布局调整 |
| 辅助功能 | 三档字号、减弱动画、三路模糊（顶栏 / 卡片 / 弹窗） |

### Lite 精简说明（相对完整版移除）

| 能力 | 说明 |
|---|---|
| 拍照搜题（豆包 / DeepSeek） | 已移除：`main/solve.js`、`src/scripts/solve.js`、`settings/solve.js`、`solve-ai*.html` |
| 相机扫描 / 多页拍摄 | 已移除：`main/scan.js`、`src/scripts/scan.js`、`scan-floater.js`、`settings/scan.js`、`settings/camera.js` |
| 数据加密（AES-256-GCM + DPAPI） | 已移除：`main/data-cipher.js`；`data-store.js` 改为纯明文 |
| QQ 通知捕获（C# Sidecar） | 已移除：`main/sidecar.js`、`src/scripts/qq-pending-dialog.js`、`homework-engine.js`、`settings/qq.js`、`sidecar/` |

### 设计特点

- **本地优先**：数据全部存本机，无账号、无云同步、无遥测；仅天气 / 背景图 / 更新检查发起最小网络请求。
- **纯明文存储**：数据文件为可直接阅读的 JSON（Lite 版不含加密）。
- **模块化主进程**：`main.js` 仅作启动编排，业务逻辑下沉到 `main/` 各领域模块。
- **渲染层模块注册表**：`src/scripts/registry.js` 作为单一事实来源顺序加载并校验 37 个模块，`npm test` 交叉校验。

## 2. 整体架构

应用采用 **Electron 三进程结构 + 浮窗子窗口**（Lite 版无 Sidecar 子进程）：

```
┌────────────────────────────────────────────────────────────────┐
│                        Electron App                             │
│                                                                  │
│  ┌────────────────────────┐      IPC      ┌───────────────────┐ │
│  │      主进程 main.js     │◄────────────►│  渲染进程          │ │
│  │  + main/* 领域模块       │ contextBridge │  index.html +      │ │
│  │  存储 / 归档 / 背景缓存 / │              │  src/scripts/*     │ │
│  │  浮窗管理 / IPC 胶水层    │              │  原生 JS/CSS       │ │
│  └───────────┬────────────┘              └───────────────────┘ │
│              │ 每卡一窗                                          │
│              ▼                                                   │
│  ┌────────────────────────┐                                     │
│  │ 浮窗子窗口（浮窗卡片）    │  floating.html + floating-preload   │
│  └────────────────────────┘                                     │
└────────────────────────────────────────────────────────────────┘
        │                 │                    │
        ▼                 ▼                    ▼
   和风天气 / Open-Meteo   Upx8 / XXAPI / 兔图苑   GitHub Releases
```

### 进程职责划分

| 进程 | 入口 | 职责 |
|---|---|---|
| 主进程 | `main.js` + `main/*`（12 个模块） | 启动编排、依赖注入；窗口 / 托盘生命周期、明文存储读写、按月归档、背图下载缓存、浮窗窗口管理、备份恢复文件操作、和风 JWT 认证、自动更新、IPC 注册、截图剪贴板 |
| 渲染进程 | `index.html` + `src/scripts/*`（37 个注册模块） | UI 渲染、状态管理、作业 / 学科 / 天气 / 设置交互、备份业务组装 |
| 浮窗子窗口 | `floating.html` + `floating-preload.js` | 单卡画中画展示、贴边探头、拖拽（系统级 app-region） |

## 3. 目录结构

```
ClassWorkBench-Lite/
├── main.js                      # 主进程启动编排层
├── preload.js                   # 主窗口 IPC 安全桥接
├── floating-preload.js          # 浮窗窗口 IPC 桥接
├── index.html                   # 主窗口页面（仅 1 个 <script>：registry.js）
├── floating.html                # 浮窗卡片页面
├── icon.ico                     # 应用图标
├── package.json                 # name / appId / publish 均为 lite 独立标识
│
├── main/                        # 主进程领域模块（工厂函数显式注入依赖）
│   ├── constants.js             #   共享常量：图源 / 缓存上限 / 自启注册表 / 窗口尺寸 / 默认值
│   ├── data-store.js            #   ★ 明文数据存储（load/get/set/save/flush + 旧文件迁移 + 损坏自愈）
│   ├── archive.js               #   按月归档（3 个月 cutoff / 原子写 / 损坏备份 / 幂等去重）
│   ├── background-cache.js      #   云端背景图缓存（魔数校验 / 索引 / 驱逐 6 张）
│   ├── backup.js                #   备份恢复文件层（导出 / 导入 / 快照 / 归档收集写回）
│   ├── floating.js              #   ★ 浮窗模式（每卡一窗 / 贴边探头 / 系统级拖拽）
│   ├── window.js                #   主窗口 + 托盘（深浅色窗口底色预置）
│   ├── auto-launch.js           #   开机自启 + 开发版自启清理
│   ├── docs-sync.js             #   协议文档读取（Lite 版已关闭在线同步）
│   ├── qweather-auth.js         #   和风天气 JWT(Ed25519) 签名与请求
│   ├── updater.js               #   自动更新（electron-updater + GitHub Releases）
│   └── ipc.js                   #   IPC 胶水层（37 个 handler，无业务）
│
├── src/
│   ├── scripts/                 # 渲染层模块（由 registry.js 顺序加载）
│   │   ├── registry.js          # ★ 模块注册表 + 加载器 + exposes 契约校验
│   │   ├── config.js            #   存储键 / 默认学科 / 天气码字典 / 版本兜底
│   │   ├── state.js             #   全局状态（AppState）
│   │   ├── utils.js             #   DOM / 日期 / 转义 / Markdown 工具
│   │   ├── storage.js           #   数据持久化（electronAPI 封装）
│   │   ├── styling.js           #   主题 / 配色 / 辅助功能应用
│   │   ├── weather.js           #   天气加载（双 API + 多城市 + 预警）
│   │   ├── background.js        #   背景图（主进程缓存模式）
│   │   ├── layout.js            #   布局适配
│   │   ├── renderer.js          # ★ 渲染引擎（作业卡 / 学科胶囊 / 状态）
│   │   ├── modal.js             #   通用模态框
│   │   ├── dialogs.js           #   业务弹窗
│   │   ├── search.js            #   作业搜索
│   │   ├── color-picker.js      #   自定义颜色选择器
│   │   ├── custom-select.js     #   玻璃自定义下拉（AppSelect）
│   │   ├── archive-renderer.js  #   归档视图
│   │   ├── backup.js            #   备份与恢复（渲染层业务）
│   │   ├── settings.js          #   设置面板容器 + settings/* 注册
│   │   ├── wizard.js            #   首启向导（协议确认 / 默认学科 / 自启）
│   │   ├── floating-mode.js     #   主窗口侧浮窗控制
│   │   ├── floating-window.js   #   浮窗卡片渲染层
│   │   ├── more-menu.js         #   更多菜单
│   │   ├── window-controls.js   #   自定义窗口控制
│   │   ├── datepicker.js        #   日期导航
│   │   ├── main.js              #   渲染进程入口（最后加载）
│   │   └── settings/            #   设置子面板
│   │       ├── general.js / personal.js / accessibility.js / subjects.js
│   │       ├── data.js / about.js / nav.js
│   │       └── weather*.js      #   weather / weather-store / weather-view /
│   │                            #   weather-city / weather-qweather / weather-misc
│   └── styles/                  # base / layout / components / floating / wizard / animations
│
├── emoji/                       # Fluent UI Emoji 资源 + emoji-map.js
├── icons/                       # IconPark 图标资源
├── build/cwb-uninstaller.nsh    # NSIS 卸载钩子（询问是否删除用户数据）
├── test/                        # 接线校验 + 冒烟 / 压测脚本
└── tools/                       # check-emoji / 动画工具 / 发布助手
```

## 4. 主进程（main.js + main/ 模块）

### 4.1 模块化设计

`main.js` 已精简为**启动编排层**。所有业务逻辑下沉到 `main/` 下 12 个领域模块，每个模块导出 `createXxxModule(deps)` 工厂函数，由 `main.js` 在 `whenReady` 后显式注入依赖（`app` / `fs` / `path` / `log` / `store` / 各模块实例等）。

| 模块 | 关键能力 |
|---|---|
| `constants.js` | `BG_SOURCES` / 缓存上限 / `RUN_KEY` / `STORE_DEFAULTS` / `BROWSER_WINDOW_DEFAULTS` |
| `data-store.js` | 内存 `get/set` + 显式 `flush()` 明文落盘，兼容 electron-store 接口 |
| `archive.js` | 3 个月 cutoff、按月 `YYYY-MM.json`、原子写、幂等去重、路径白名单 |
| `background-cache.js` | 主进程下载 + 魔数校验 + 索引 + 缓存驱逐（渲染层零网络请求） |
| `backup.js` | 保存 / 打开对话框、恢复快照（最多保留 5 份）、归档收集与写回 |
| `floating.js` | 每个作业卡一个无边框置顶窗口、贴边探头、系统级拖拽 |
| `window.js` | BrowserWindow / Tray / 关闭即隐藏 / 深浅色窗口底色预置 |
| `auto-launch.js` | `get/setLoginItemSettings` 封装、清理开发版自启项 |
| `docs-sync.js` | 读取随包协议文档（Lite 版 `DOC_SYNC_ENABLED = false`） |
| `qweather-auth.js` | Ed25519 JWT 签名（私钥只在主进程）+ `net.fetch` 请求 |
| `updater.js` | electron-updater + GitHub Releases，检查 / 下载 / 安装均需用户确认 |
| `ipc.js` | 37 个 IPC handler，只做「校验 → 调模块 → 返回」 |

### 4.2 启动流程

```
main.js 顶部
  ├─ app.setPath('userData', %APPDATA%/classworkbench-lite)   # 与完整版隔离
  ├─ V8 / Chromium 启动参数注入（必须在 whenReady 之前）
  ├─ process.on('uncaughtException' / 'unhandledRejection')
  └─ requestSingleInstanceLock()

app.whenReady()
  ├─ createDataStore() + store.load()          # 明文：读 .enc / 迁移 .json / 损坏自愈
  ├─ nativeTheme.themeSource = 已存外观设置
  ├─ 动态 import atomically → atomicWriteRef
  ├─ 实例化领域模块（archive/bg/autoLaunch/backup/window/floating/docsSync/qweather/updater）
  ├─ setupIpc(...)                              # 注册 37 个 handler
  ├─ bg.cleanupBgCache() / 刷新自启项
  ├─ window.createWindow() + window.createTray()
  ├─ docsSync.sync()                            # Lite：立即返回（在线同步已关闭）
  └─ updater.check()                            # 静默检查更新
```

> `--hidden` 启动参数用于开机自启时后台启动（不显示窗口）。

### 4.3 constants.js — 共享常量

- `BG_SOURCES`：`upx8`（Upx8 风景）、`xxapi`（XXAPI 4K 壁纸）、`ltyuanfang`（兔图苑风景）；
- `BG_MAX_CACHE_FILES = 6`、`BG_MAX_BYTES = 20MB`、`BG_TIMEOUT_MS = 30s`；
- `RUN_KEY`：开机自启注册表路径 `HKCU\...\Run`；
- `STORE_DEFAULTS = { settings: null, subjects: null, homeworks: [] }`；
- `BROWSER_WINDOW_DEFAULTS`：窗口尺寸 / 最小尺寸 / 标题「班级工作台 Lite」/ 背景色。

### 4.4 archive.js — 按月归档

`createArchiveModule({ archivesDir, store, atomicWriteRef, fs, path, log })`

| 方法 | 说明 |
|---|---|
| `getCutoffDate()` | 当前日期往前 3 个月、当月 1 日 0 点 |
| `getMonthKey(date)` / `parseDateLocal(str)` | 日期与月份键互转 |
| `archiveHomeworks(homeworks)` | cutoff 之前的作业按月分组写入 `archives/YYYY-MM.json`，返回活跃作业 |
| `loadDataInternal()` | 启动时归档 → 回写活跃作业 → 返回 `{homeworks, subjects, settings}` |
| `getArchiveMonths()` / `loadArchiveByMonth(key)` | 归档月份列表 / 按月读取（月份键正则白名单） |
| `validateData(data)` | `data:save` 参数校验（homeworks 上限 10000 条） |

**去重与容错**：归档写入基于作业 `id` 合并（幂等）；读取时若 JSON 损坏或遇到旧加密前缀 `CBW1:`，备份为 `.corrupted.<ts>.bak` 后返回空数组。

### 4.5 background-cache.js — 背景图缓存

主进程负责下载与缓存，渲染层拿到的是本地文件 URL：

1. 按 `BG_SOURCES` 拉取图片（重定向 → 实际图片地址）；
2. **魔数完整性校验**：JPEG / PNG / WebP / GIF 头尾校验，拒绝损坏或伪装文件；
3. 索引落盘（明文内部文件），缓存驱逐至不超过 6 张；
4. 单张超 20MB、超时 30s 均中止。

### 4.6 auto-launch.js — 开机自启

- `getPreferredAutoLaunchPath()`：打包版用 `process.execPath`；开发版优先已打包 `dist/win-unpacked/ClassWorkBenchLite.exe`，否则用 `electron.exe`（带项目路径参数）；
- `getAutoLaunch()` / `setAutoLaunch(enabled)`：封装 `get/setLoginItemSettings`；
- `removeDevAutoLaunchEntry()`：打包版扫描 RUN 注册表清理指向开发版 `electron.exe` 的旧自启项。

### 4.7 backup.js — 备份与恢复（文件层）

`createBackupModule({ app, dialog, fs, path, log, store, archive })`

| 方法 | 说明 |
|---|---|
| `exportBackup({suggestedName, payload})` | 系统保存对话框，写明文 JSON |
| `importBackup()` | 系统打开对话框，解析并返回 JSON |
| `createSnapshot(data)` | 覆盖前快照写入 `restore-snapshots/`（最多保留 5 份） |
| `collectArchives()` / `restoreArchives(archives)` | 收集全部月份归档 / 校验后写回 |

### 4.8 floating.js — 浮窗模式（画中画）

每个作业卡 = 一个独立无边框置顶 `BrowserWindow`：

- 卡片样式与主窗口一致（白底深色字 + 学科色追色）；
- 默认贴屏幕右侧竖排，超出屏幕高度自动加列；
- 拖动使用系统级 `-webkit-app-region`（无手动 IPC 拖动）；
- 贴边后收起为探头（`PROBE_W=26` / `PROBE_FINAL_H=36`），`FADE_OUT_DELAY_MS=3000` 后淡化；
- 进入浮窗自动隐藏主窗口，退出 / 全部关闭时自动显示主窗口；事件经 `emit()` 转发给主窗口渲染层。

### 4.9 window.js — 主窗口与托盘

- 创建 `BrowserWindow`（无边框自定义窗口控制）、注册 close / hide / show 钩子；
- 关闭窗口不退出而是隐藏到托盘，真正退出走托盘菜单「退出」或 `before-quit`；
- 深浅色下窗口底色预置（`THEME_BG`），与页面 `--bg-body` 对齐，避免首帧错色。

### 4.10 data-store.js — 明文数据存储层 ★

> Lite 版已移除数据加密。`data-store.js` 提供与 electron-store 兼容的 `get/set` 内存接口 + 显式 `flush()` 落盘。

| 项 | 说明 |
|---|---|
| 主数据文件 | `userData/homework-data.enc`（**明文 JSON**，保留 `.enc` 命名以兼容既有读取路径） |
| 旧文件 | `userData/homework-data.json`（存在时并入后删除） |
| 写入 | 临时文件 + `rename` 原子写，串行队列防并发覆盖 |
| 损坏自愈 | 解析失败备份为 `.corrupted.<ts>`，回退默认值，绝不静默覆盖 |
| 旧加密文件 | 遇到 `CBW1:` 前缀视为不可读 → 走损坏流程（Lite 不解密） |

接口：`load()` / `get(key, def)` / `set(key, value)` / `save()` / `flush()`。

### 4.11 docs-sync.js — 协议文档读取

Lite 版**关闭在线同步**（`DOC_SYNC_ENABLED = false`）：

- `readDoc(name)` 直接返回随包文档（agreement / privacy / security / opensource / contact），忽略历史在线缓存；
- `sync()` 立即返回 `{changed:[], failed:[], effective:{}, disabled:true}`，不发起网络请求；
- `sourceFor()` 返回空串。

这样可避免从完整版仓库拉取仍包含「数据加密 / QQ 捕获」等已移除功能的旧条款。若日后为 Lite 建立独立文档仓库，只需打开该开关并调整 `OWNER/REPO`。

### 4.12 qweather-auth.js — 和风天气 JWT 认证

主进程完成签名与请求，渲染层永远拿不到私钥：

1. `JWT = base64url(header).base64url(payload).base64url(signature)`（EdDSA / Ed25519）；
2. header 仅 `{alg:'EdDSA', kid}`，payload 仅 `{sub, iat(now-30s), exp}`；
3. 每次请求带 `Authorization: Bearer <token>`；
4. 依赖 Node `crypto` + Electron `net.fetch`（绕过渲染层 CSP）。

### 4.13 updater.js — 自动更新

- 基于 `electron-updater`，安装源为 `package.json` 的 `build.publish`（GitHub Releases：`ClassWorkBench/classworkbench-lite`）；
- `autoDownload = false`、`autoInstallOnAppQuit = false`：发现新版不自动下载 / 安装，全部由用户确认；
- 状态机 `idle | checking | available | downloading | downloaded | not-available | error`，经 `updater:event` 推送渲染层；
- `latestNotes()` 拉取最新 release 说明（更新日志），运行期缓存 + 并发去重。

## 5. 预加载脚本

### 5.1 preload.js — 主窗口桥接

用 `contextBridge.exposeInMainWorld('electronAPI', ...)` 暴露白名单 API（渲染层无法直接调用任意 IPC）：

| 分组 | 方法 |
|---|---|
| 数据 | `loadData` / `saveData` |
| 备份恢复 | `exportBackup` / `importBackup` / `createRestoreSnapshot` / `getArchives` / `restoreArchives` |
| 归档 | `archiveGetMonths` / `archiveLoadMonth` |
| 浮窗 | `floatEnter` / `floatExit` / `onFloatCardBack` / `onFloatExited` |
| 自启 | `getAutoLaunch` / `setAutoLaunch` |
| 背景 | `getBackground` / `refreshBackground` |
| 窗口 / 剪贴板 / 外链 | `windowControls.close` / `copyLayoutImage` / `openExternal` |
| 和风天气 | `qweather.get` / `qweather.getToken` / `qweather.genKeyPair` |
| 文档 | `readDoc` / `getDocVersions` / `onDocsUpdated` |
| 更新 | `update.check` / `update.download` / `update.install` / `update.getState` / `update.releaseNotes` / `update.onEvent` |
| 版本 | `getVersion` |

### 5.2 floating-preload.js — 浮窗窗口桥接

浮窗窗口经由独立 preload 暴露卡片所需的最小 API（初始化卡片数据、就绪上报、贴边 / 淡出、关闭动画等），与主窗口桥接相互隔离。

## 6. 渲染进程模块详解

> 渲染层不使用打包器，`index.html` 仅引入 `registry.js`；`registry.js` 按依赖顺序动态加载其余 37 个模块，并逐一校验 `exposes` 声明的全局契约。

### 6.1 registry.js — 模块注册表 + 加载器 ★

- `modules: [{file, exposes}]` 是加载顺序与契约的**单一事实来源**；
- 暴露 `window.AppRegistry`；加载完成后派发 `app:modules-ready` 事件；
- 任一模块缺失契约会记入 `AppRegistry.errors` 并输出控制台错误；
- Node 侧通过 `module.exports` 导出同一份清单，供 `test/check-wiring.mjs` 交叉校验。

### 6.2 config.js — 全局配置

`window.AppConfig`：`STORAGE`（存储键）、`AGREEMENT_VERSION`、`APP_VERSION`、`DEFAULT_SUBJECTS`（8 学科）、`GEOCODING_URL`、`weatherCodeDict`、`qweatherIconMap`。

### 6.3 state.js — 全局状态

`window.AppState`：当前日期、作业列表、学科、设置（含 `acceptedAgreementVersion`）、天气数据等；提供状态订阅供各模块响应变化。

### 6.4 utils.js — 工具函数

`window.AppUtils`：DOM 快捷方法、日期格式化、HTML 转义、`mdToHtml` 等。

### 6.5 storage.js — 数据持久化

`window.AppStorage`：封装 `electronAPI.loadData/saveData`，串行化持久化调用，避免并发覆盖。

### 6.6 styling.js — 样式应用

`window.AppStyling`：解析并应用外观（system/light/dark）、配色方案、字号、减弱动画、模糊等辅助功能。

### 6.7 weather.js — 天气加载 ★

`window.AppWeather`：多城市、双数据源（和风天气 JWT / Open-Meteo）、天气码 → emoji 映射、四级预警（蓝 / 黄 / 橙 / 红）渲染。

### 6.8 background.js — 背景图

`window.AppBackground`：调用主进程 `bg:get` / `bg:fetch`，应用本地缓存背景图；渲染层零网络请求。

### 6.9 layout.js — 布局适配

`window.AppLayout`：根据窗口尺寸 / 卡片数量计算列数与缩放。

### 6.10 renderer.js — 渲染引擎（核心）★

`window.Renderer` / `AppRenderer`：渲染底栏学科胶囊、作业卡片网格、空状态、状态提示；维护卡片与学科的 DOM 复用。

**性能要点**：
- **卡片渲染去重**：`cardsSignature()` 汇总 renderCards 输出的全部输入（日期/列数/美化编号/学科/修改草稿/当日作业）；签名不变则跳过整表重建——主题、字号、背景等与卡片无关的设置变更不会再重建全部卡片（重建会重新栅格化每张卡的 `backdrop-filter` 图层，是本应用最大的单次卡顿源）。
- **写入前比对**：顶栏晚修进度、学科胶囊 ARIA 标签仅在内容变化时写 DOM；学科胶囊的宽度过渡只在开合态真正变化时触发，避免每次渲染都做强制同步布局。
- `Renderer._perf` 暴露 `{ cardRebuilds, cardSkips }`，供 `npm run smoke:perf` 验证去重生效。

### 6.10.1 共享元素形变（iOS 式弹窗动画）

点击底部学科胶囊/卡片编辑时，对话框不再"原地弹出"，而是**从触发元素的位置长出来**；保存后对话框再**收束回看板卡片**。

- 触发：`renderer.js` 打开弹窗时传入 `originRect`（胶囊/卡片的 `getBoundingClientRect()`）。
- 代价/实现：`modal.js` 的 `showModal(html, onClose, { originRect })` 接收来源矩形。入场先加 `.dialog.morph`（停掉 `dialogPop` 关键帧）并量取最终尺寸，再把 `transform` 设为「平移到来源中心 + 等比缩放到来源宽度」，下一帧过渡到 `scale(1)`（`--transition-ios`）。
- 退场：`close(reason, morphTarget)` 传入目标卡片矩形，对话框 `transform` 收束到该矩形（内接缩放）并淡出（`--transition-ios-in`）；卡片随后播放 `card-morph-ack` 轻微发光表示"被接收"。
- 配套：`body.morph-open` 让底部胶囊整体溶解退场（`!important` 压过 `barRise` 的 `fill:both`）。
- 减弱动画（`settings.reduceAnimation`）下自动回退为原来的 `dialogPop`/`dialogPopOut`，不做形变。
- 验证：`npm run smoke:morph`（16 项：入场形变态、来源 transform、落定清理、退场收束、卡片落点、减弱回退）。
- 空闲预热：启动 1.2s 后以 `overlay-prewarm` 近乎不可见地渲染一次「蒙层+对话框」毛玻璃，把首次合成的开销挪到空闲期。

### 6.11 modal.js / dialogs.js — 模态与弹窗

`AppModal`（通用遮罩式模态框）、`AppDialogs`（确认 / 提示 / 输入等业务弹窗）。

### 6.12 search.js — 作业搜索 ★

`window.AppSearch`：作业关键词搜索、过滤与结果高亮。

### 6.13 color-picker.js — 自定义颜色选择器 ★

`window.ColorPicker`：学科配色取色器（色板 + 自定义）。

### 6.14 custom-select.js — 玻璃自定义下拉 ★

`window.AppSelect`：把原生 `<select data-cselect>` 增强为玻璃风格自定义下拉；`MutationObserver` 自动增强后续动态插入的 select。

### 6.15 archive-renderer.js — 归档视图

`window.ArchiveView`：内嵌归档月份浏览与恢复入口（只读调用 `archive:*`）。

### 6.16 backup.js — 备份与恢复（渲染层业务）★

`window.AppBackup`：组装设置 / 作业备份载荷，调用 `exportBackup` / `importBackup` / 快照 / 归档收集回收。

### 6.17 settings.js + settings/ — 设置面板 ★

`window.AppSettings` 为容器，子面板登记在 `SettingsModules`：

| 面板 | 模块 | 内容 |
|---|---|---|
| 常规 | `settings/general.js` | 开机自启等 |
| 天气 | `settings/weather.js` + `weather-*.js` | 城市管理、和风 JWT、显示项、存储 |
| 个性化 | `settings/personal.js` | 配色、背景图源、外观 |
| 辅助功能 | `settings/accessibility.js` | 字号、减弱动画、模糊 |
| 学科 | `settings/subjects.js` | 学科增删改 |
| 数据 | `settings/data.js` | 备份恢复入口、数据清理 |
| 关于 | `settings/about.js` | 版本、更新检查、法律文档 |
| 导航 | `settings/nav.js` | 面板切换 |

### 6.18 floating-mode.js — 主窗口侧浮窗控制 ★

`window.AppFloatingMode`：在渲染层控制进入 / 退出浮窗，过滤可浮窗的卡片并调用 `floatEnter/floatExit`。

### 6.19 floating-window.js — 浮窗窗口渲染层 ★

浮窗卡片页面逻辑：初始化卡片、上报高度就绪、贴边 / 淡出 / 关闭动画、返卡回主窗口。

### 6.20 more-menu.js — 更多菜单

`window.AppMoreMenu`：右上角「更多」菜单（含浮窗、复制排版图等入口）。

### 6.21 window-controls.js — 自定义窗口控制

无边框窗口的最小化 / 最大化 / 关闭按钮绑定。

### 6.22 datepicker.js — 日期导航

`window.AppDatePicker`：日期切换与日历面板。

### 6.23 main.js — 渲染进程入口

最后加载：等待 `app:modules-ready` 后初始化存储、状态、渲染与首启向导。

### 6.24 wizard.js — 首启向导 ★

`window.AppWizard`：展示协议（读取随包 AGREEMENT / PRIVACY）、默认学科配色、开机自启；记录 `acceptedAgreementVersion`。

## 7. 数据模型与存储设计

### 7.1 数据结构

```js
// 主数据（明文 JSON，userData/homework-data.enc）
{
  homeworks: [
    { id: "hw_<ts>", subject: "math", content: "...", date: "2026-10-06" /* ... */ }
  ],
  subjects: [ { id, name, color } ],
  settings: {
    appearance, theme, accent, bgSource, cities, qweather, accessibility,
    acceptedAgreementVersion /* ... */
  }
}

// 归档：userData/archives/YYYY-MM.json —— 作业数组
// 快照：userData/restore-snapshots/restore-<ts>.json
// 背景：userData/bg-cache/ + 索引
// 日志：userData/logs/
```

### 7.2 存储架构（明文）

| 数据 | 位置 | 说明 |
|---|---|---|
| 活跃数据 | `homework-data.enc`（明文 JSON） | 近 3 个月作业 + 学科 + 设置 |
| 归档数据 | `archives/YYYY-MM.json` | 超过 3 个月的作业 |
| 恢复快照 | `restore-snapshots/restore-<ts>.json` | 恢复前自动生成（保留最近 5 份） |
| 背景缓存 | `bg-cache/` | 云端背景图本地缓存（上限 6 张） |
| 日志 | `logs/` | electron-log 本地日志 |
| 文档 | 随安装包内置 | Lite 不写 `doc-cache/` |

> 数据根目录：`%APPDATA%\classworkbench-lite`（与完整版 `classworkbench` 独立）。

### 7.3 数据安全机制

- **本地优先**：无服务器中转，仅天气 / 背景 / 更新检查为最小联网。
- **原子写入**：临时文件 + `rename`，避免半写损坏。
- **损坏自愈**：解析失败备份为 `.corrupted.<ts>` 后回退默认值。
- **路径白名单**：归档月份键强制 `^\d{4}-\d{2}$`，防路径穿越。
- **明文提醒**：Lite 版**不含加密**，数据可被同账户程序读取；如需加密请使用完整版。

## 8. IPC 通信协议

### 8.1 请求-响应型（渲染层 invoke → 主进程 handle）

| 分组 | 通道 |
|---|---|
| 数据 | `data:load` / `data:save` |
| 备份恢复 | `data:exportBackup` / `data:importBackup` / `data:createSnapshot` / `data:getArchives` / `data:restoreArchives` |
| 归档 | `archive:getMonths` / `archive:loadMonth` |
| 浮窗 | `float:enter` / `float:exit` / `float:exitAll` / `float:init` / `float:ready` / `float:closeAfterFade` / `float:dock` / `float:undock` / `float:unfade` / `float:refade` |
| 背景 | `bg:get` / `bg:fetch` |
| 自启 | `app:getAutoLaunch` / `app:setAutoLaunch` |
| 窗口 / 系统 | `window:close` / `shell:openExternal` / `page:copy` |
| 和风天气 | `qweather:get` / `qweather:getToken` / `qweather:genKeyPair` |
| 文档 | `docs:read` / `docs:getVersions` |
| 更新 | `updater:check` / `updater:download` / `updater:install` / `updater:state` / `updater:release-notes` |
| 版本 | `app:getVersion` |

### 8.2 事件推送型（主进程 → 渲染层）

| 事件 | 说明 |
|---|---|
| `float:card-back` / `float:exited` | 浮窗卡片返回 / 浮窗退出 |
| `docs:updated` | 文档更新（Lite 版在线同步关闭，通常不触发） |
| `updater:event` | 更新状态变化 `{type, ...}` |

## 9. 关键业务流程

### 9.1 应用启动流程

`main.js` 注入启动参数 → 单实例锁 → `whenReady` → 明文存储 `load()` → 主题预置 → 实例化模块 → 注册 IPC → 创建窗口与托盘 → 文档同步（Lite 为 no-op）→ 静默检查更新。

### 9.2 添加作业流程

用户填写作业（学科 / 内容 / 截止日期）→ 校验 → `AppState` 更新 → `Renderer` 重绘卡片与学科胶囊 → `AppStorage.saveData` → 主进程 `data:save`（先归档超期）→ 明文落盘。

### 9.3 删除作业流程（二次确认）

点击删除 → 弹窗二次确认 → 从状态移除 → 重绘 → 保存。

### 9.4 自动归档流程

`data:load` / `data:save` 或启动加载时：`archiveHomeworks()` 把早于 cutoff 的作业按 `YYYY-MM` 写入归档文件（幂等去重），活跃作业回写主数据。

### 9.5 背景图加载流程

渲染层 `bg:get` → 主进程返回缓存文件 URL；`bg:fetch` 触发下载 → 魔数校验 → 写缓存 + 索引 → 驱逐超限 → 返回新图 URL。

### 9.6 日期翻页流程

日期导航切换 → `AppState` 更新当前日期 → 过滤当日作业 → 相册式滑切重绘。

### 9.7 浮窗模式流程（画中画）

`AppFloatingMode` 收集卡片 → `float:enter` → 主进程为每卡创建置顶窗口并隐藏主窗口 → 卡片就绪 / 贴边 / 淡化 → 返回卡片或退出浮窗 → `float:exit` → 显示主窗口。

### 9.8 备份与恢复流程

- **导出**：渲染层组装载荷 → `data:exportBackup` → 系统保存对话框 → 写明文 JSON；
- **恢复**：`data:createSnapshot`（先快照）→ 校验导入 JSON → 合并归档（按 id 去重）→ 写回主数据 → 重绘。

## 10. 样式架构

| 文件 | 职责 |
|---|---|
| `base.css` | CSS 变量、重置、字体、全局焦点环 |
| `layout.css` | 窗口骨架与网格布局 |
| `components.css` | 卡片 / 按钮 / 弹窗 / 设置面板等组件样式 |
| `floating.css` | 浮窗卡片与贴边探头样式 |
| `wizard.css` | 首启向导样式 |
| `animations.css` | 过渡与关键帧动画 |

- **主题**：`--bg-body`、`--text-primary`、`--accent`、`--transition-smooth` 等变量驱动深浅色与配色方案；

**模糊预算（性能）**：`backdrop-filter` 代价 ≈ 面积 × 半径，且「带模糊的层持续移动」会每帧重新模糊。三条硬约束：
- 全屏模态遮罩 `blur(8px)`（曾为 24px；遮罩本身是 55% 黑，半径在深色蒙层上视觉差别极小）；
- **弹窗本体不再叠 `backdrop-filter`**，改纯 rgba 实底——它压在已模糊的遮罩上，第二层几乎不可见却要再做一次回读+高斯（嵌套模糊）；
- 空状态玻璃胶囊 `.grid-empty` 保持**静止**，只让内层 `.grid-empty-float` 播 `emptyFloat`。

参考：`chat.deepseek.com` 整份 CSS 仅 8 处 `backdrop-filter`，其模态遮罩为 `blur(2px)`、弹窗为实体表面；我们此前有 70 处声明、全屏遮罩 `blur(24px)` + 弹窗再叠 `blur(16px)`。

- **辅助功能**：三档字号、减弱动画、三路模糊由根元素类名 / 变量切换；
- **焦点可达性**：小控件用主题描边环，大表面（作业卡 / 提醒条 / 状态卡）用柔光 `--glow-focus`；
- **玻璃拟态**：半透明背景 + 背景模糊（视辅助功能开关）。

## 11. 依赖关系

### 11.1 模块依赖图（主进程）

```
main.js
  ├─ 依赖 Node：path / fs / crypto / child_process，Electron：app/BrowserWindow/ipcMain/Tray/Menu/net/... 
  └─ createXxxModule(...) 显式注入
       ├─ constants.js        无依赖
       ├─ data-store.js       依赖 fs / path / app
       ├─ archive.js          依赖 archivesDir / store / atomicWriteRef / fs / path / log
       ├─ background-cache.js 依赖 constants / fs / path / crypto / net / pathToFileURL / log
       ├─ backup.js           依赖 app / dialog / fs / path / log / store / archive
       ├─ floating.js         依赖 BrowserWindow / screen / path / log / assetsDir / emit
       ├─ window.js           依赖 BrowserWindow / Tray / Menu / path / log / assetsDir
       ├─ auto-launch.js      依赖 constants(RUN_KEY) / app / fs / path / execFileSync / log
       ├─ docs-sync.js        依赖 app / fs / path / crypto / net / log（Lite 关闭同步）
       ├─ qweather-auth.js    依赖 crypto / net / log
       └─ updater.js          依赖 electron-updater / app / net / log
```

### 11.2 模块依赖图（渲染进程）

```
registry.js ──► 顺序加载 37 个模块（含 emoji/emoji-map.js）
main.js(入口) ──► state / storage / renderer / settings / wizard / weather / floating-mode ...
renderer.js ───► state / utils / layout / floating-mode（过滤卡片）
settings.js ───► settings/*（general/weather/personal/accessibility/subjects/data/about/nav）
backup.js ─────► storage / electronAPI（exportBackup / importBackup / snapshot / archives）
wizard.js ─────► config / utils / electronAPI（readDoc / setAutoLaunch）
```

### 11.3 npm 依赖

| 依赖 | 版本 | 类型 | 用途 |
|---|---|---|---|
| `atomically` | ^2.0.3 | dependency | 原子文件写入 |
| `electron-log` | ^5.2.0 | dependency | 本地日志 |
| `electron-updater` | ^6.8.9 | dependency | 自动更新 |
| `electron` | ^33.0.0 | devDependency | 运行时 |
| `electron-builder` | ^25.0.0 | devDependency | 打包 |

> Lite 版**不依赖** .NET / C# Sidecar 相关工具链。

### 11.4 外部服务依赖

| 服务 | 用途 | 是否必需 |
|---|---|---|
| 和风天气（QWeather） | 天气 / 预警 | 用户配置 Key 后启用 |
| Open-Meteo | 天气 / 城市搜索 | 免费，无需 Key |
| Upx8 / XXAPI / 兔图苑 | 背景图 | 可切换或关闭 |
| GitHub Releases | 自动更新 | 非必需（用户可忽略） |

## 12. 构建与运行

### 12.1 环境要求

- Node.js 20+
- Windows 10 19041+
- 无需 .NET 8 SDK（Lite 版无 Sidecar）

### 12.2 开发运行

```bash
npm install
npm run dev        # 等价于 electron .
```

### 12.3 打包构建

```bash
npm run build      # 等价于 electron-builder，NSIS 安装包
```

### 12.4 构建产物

```
dist/
  ├── 班级工作台 Lite Setup x.y.z.exe   # NSIS 安装包
  └── win-unpacked/
      └── ClassWorkBenchLite.exe          # 免安装可执行文件
```

### 12.5 运行时数据位置

```
%APPDATA%\classworkbench-lite\
  ├── homework-data.enc         # 明文 JSON 主数据
  ├── archives/                 # 按月归档 YYYY-MM.json（明文）
  ├── restore-snapshots/        # 恢复前快照（明文）
  ├── bg-cache/                 # 背景图缓存
  └── logs/                     # electron-log 日志
```

## 附录：模块加载顺序

`src/scripts/registry.js` 中 `modules` 的登记顺序即为加载顺序（依赖在前）：

```
emoji-map → config → state → utils → storage → styling → weather → background → layout
→ renderer → modal → search → dialogs → color-picker → custom-select → archive-renderer
→ settings/general → weather-store → weather-view → weather-city → weather-qweather
→ weather-misc → weather → personal → accessibility → subjects → data → about → nav
→ backup → settings → wizard → floating-mode → more-menu → window-controls → datepicker → main
```

> 新增模块：在 `registry.js` 追加一条 `{ file, exposes }` 即可，无需改 `index.html`；随后 `npm test` 会校验「登记项 / 契约 / 无死文件 / 单一入口」。
