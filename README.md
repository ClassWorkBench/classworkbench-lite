# 班级工作台 Lite

**ClassWorkBench Lite** —— 面向班级教学场景的 Windows 桌面应用：作业管理、学科系统、天气预警、画中画浮窗，一块大屏管好晚修。

**本地优先 · 无账号 · 纯明文存储 · MIT 开源**

> 本仓库是 **ClassWorkBench 精简版（Lite）**。相较完整版，移除了「拍照搜题」「相机扫描」「数据加密」「QQ 通知捕获」四组重型功能，去掉 C# Sidecar 依赖，数据以明文 JSON 存储在本机，代码与依赖更轻、构建更简单。如需上述功能，请使用完整版。

## 功能

| 模块 | 说明 |
|---|---|
| 作业管理 | 录入/编辑/归档/恢复作业，按截止时间排序，晚修进度一目了然 |
| 学科系统 | 8 学科预设配色，自定义名称/颜色/图标 |
| 天气预警 | 多城市搜索管理，双数据源（和风天气 + Open-Meteo），四级预警（蓝/黄/橙/红） |
| 画中画浮窗 | 作业卡片独立置顶窗口，贴边探头交互，不打断其他操作 |
| 备份恢复 | 手动导出 + 自动快照 + 一键恢复，恢复前自动生成快照兜底 |
| 个性化 | 5 套配色方案、取色器、背景图源、布局调整 |
| 辅助功能 | 三档字号、减弱动画、三路模糊（顶栏/卡片/弹窗） |

## 与完整版的差异

| 能力 | 完整版 | Lite 版 |
|---|---|---|
| 拍照搜题（豆包 / DeepSeek） | ✅ | ❌ 已移除 |
| 相机扫描 / 多页拍摄 | ✅ | ❌ 已移除 |
| 数据加密（AES-256-GCM + DPAPI） | ✅ | ❌ 改为明文存储 |
| QQ 通知捕获（C# Sidecar） | ✅ | ❌ 已移除 |
| .NET 8 运行时 / Sidecar 构建 | 需要 | 不需要 |

## 技术栈

- **Electron 33**（主进程模块化：`main/` 领域模块 + IPC 胶水层，渲染进程原生 JS/CSS）
- **本地明文存储**：作业 / 学科 / 设置以 JSON 明文写入本机 `userData`（Lite 版不含数据加密）
- **图标**：IconPark（Apache-2.0）+ Fluent UI Emoji（MIT）

## 命名约定

| 场合 | 写法 | 示例 |
|---|---|---|
| 包名 / 仓库 / appId / 目录 | `classworkbench-lite`（全小写） | `com.classworkbench.lite` |
| 主程序可执行文件 | `ClassWorkBenchLite.exe` | exe 文件名保持英文 |
| 显示名 / 安装包 / 快捷方式 | 班级工作台 Lite | 窗口标题、托盘、向导、安装包、桌面快捷方式、开始菜单 |

## 构建

### 环境要求

- Node.js 20+
- Windows 10 19041+（Lite 版不需要 .NET 运行时）

### 开发运行

```bash
npm install
npm run dev
```

### 打包安装程序

```bash
npm run build
```

产物位于 `dist/`，卸载时会询问是否删除用户数据（`build/cwb-uninstaller.nsh`）。

## 数据与隐私

- **本地优先**：作业、学科、设置全部存储在本机 `%APPDATA%\classworkbench-lite`，无账号、无云同步、无遥测
- **明文存储**：Lite 版不含数据加密，数据文件为可直接阅读的 JSON，请自行注意本机账户安全
- **第三方服务**：天气（和风 / Open-Meteo）与背景图（Upx8 / XXAPI / 兔图苑）为功能必需的最小请求，均为单向获取，不上传本地数据
- **协议文档**：随安装包内置，不在启动时联网同步

详见 [隐私声明](PRIVACY.md)、[数据的安全性](SECURITY.md)。

## 开源许可

本软件以 **MIT License** 开源，详见 [LICENSE](LICENSE)。

- [用户协议](AGREEMENT.md)
- [隐私声明](PRIVACY.md)
- [数据的安全性](SECURITY.md)
- [开源软件声明](OPENSOURCE.md)
- [第三方许可](THIRD-PARTY-LICENSES)
- [联系我们](CONTACT.md)

## 致谢

- 界面图标：[IconPark](https://github.com/bytedance/IconPark)（字节跳动，Apache-2.0）
- 彩色 Emoji：[Fluent UI Emoji](https://github.com/microsoft/fluentui-emoji)（微软，MIT）
- 天气数据：[和风天气](https://www.qweather.com) / [Open-Meteo](https://open-meteo.com)
