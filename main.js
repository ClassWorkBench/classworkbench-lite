// ============================================
// main.js  (Electron 主进程)  —— 启动编排层
// 拆分后约 150 行。业务逻辑已下沉到 main/ 下各领域模块：
//   main/constants.js       — 共享常量（BG/自启注册表/Sidecar阈值/窗口尺寸）
//   main/archive.js         — 按月归档（原子写入/损坏备份/幂等去重）
//   main/background-cache.js— 背景图本地缓存（魔数校验/索引/下载驱逐）
//   main/auto-launch.js     — 开机自启 + 开发版自启清理
//   main/window.js          — BrowserWindow + Tray + 钩子
//   main/floating.js        — 浮窗模式（画中画：每卡一窗，置顶可拖）
//   main/ipc.js             — 32 个 IPC 胶水层 handler（无业务）
// ============================================

const { app, BrowserWindow, ipcMain, Tray, Menu, net, clipboard, shell, dialog, screen, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { execFileSync } = require('child_process');
const log = require('electron-log');

// Lite 版使用独立数据目录，与完整版（classworkbench）数据互不干扰
app.setPath('userData', path.join(app.getPath('appData'), 'classworkbench-lite'));

// ---- 模块工厂 ----
const { STORE_DEFAULTS } = require('./main/constants');
const { createArchiveModule } = require('./main/archive');
const { createBgCacheModule } = require('./main/background-cache');
const { createAutoLaunchModule } = require('./main/auto-launch');
const { createBackupModule } = require('./main/backup');
const { createFloatingModule } = require('./main/floating');
const { createDataStore } = require('./main/data-store');
const { createWindowModule } = require('./main/window');
const { createDocsSync } = require('./main/docs-sync');
const { createQweatherClient } = require('./main/qweather-auth');
const { createUpdaterModule } = require('./main/updater');
const { setupIpc } = require('./main/ipc');

// ============================================
// 性能优化：V8 / Chromium 启动参数（必须在 whenReady() 之前注入）
// ============================================
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=256');
app.commandLine.appendSwitch('enable-features', 'BackForwardCache:memory_limit_in_percent/10');
app.commandLine.appendSwitch('memory-pressure-offloading');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');

// ---- 全局异常捕获 ----
process.on('uncaughtException', (err) => log.error('[uncaughtException]', err));
process.on('unhandledRejection', (reason) => log.error('[unhandledRejection]', reason));

// ---- 单实例锁 ----
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {

    // ===== 跨模块共享的引用（用对象包装，方便异步赋值后模块也能读到） =====
    const mainWindowRef = { value: null };
    const isQuittingRef = { value: false };
    const trayRef = { value: null };
    const atomicWriteRef = { value: null };

    const startHidden = process.argv.includes('--hidden');
    const archivesDir = path.join(app.getPath('userData'), 'archives');

    // ====== 各领域模块实例（先声明，whenReady 里 store/atomicWrite 就绪后 new 出来） ======
    let archive = null;
    let bg = null;
    let autoLaunch = null;
    let backup = null;
    let floating = null;
    let store = null;
    let windowMod = null;
    let docsSync = null;
    let qweather = null;
    let updater = null;

    // ---- 主窗口变化时把引用同步给 mainWindowRef（供 IPC/second-instance 调用） ----
    function onMainWindowChange(w) { mainWindowRef.value = w; }

    // ---- 事件 → 转发给渲染层 ----
    function emitToRenderer(event, data) {
        const w = mainWindowRef.value;
        if (w && !w.isDestroyed()) w.webContents.send(event, data);
    }

    // ============================================
    // 生命周期钩子（second-instance 注册必须放在 whenReady 前）
    // ============================================
    app.on('second-instance', (_event, argv) => {
        if (argv.includes('--hidden')) return; // 开机自启的隐藏实例不要把已运行实例顶出来
        const w = mainWindowRef.value;
        if (w) w.setAlwaysOnTop(true, 'screen-saver');
        if (windowMod) windowMod.showMainWindow();
        if (w) w.setAlwaysOnTop(false);
    });

    app.whenReady().then(async () => {
        // ---- 明文数据存储（Lite 版已移除数据加密）----
        store = createDataStore({ app, fs, path, log, defaults: STORE_DEFAULTS });
        store.load();   // 旧明文自动迁移 + 损坏自愈

        // 深色模式：启动即按已存外观设置原生主题
        const _initAppearance = (store.get('settings') || {}).appearance;
        nativeTheme.themeSource = { system: 'system', light: 'light', dark: 'dark' }[_initAppearance] || 'system';

        try {
            const atomically = await import('atomically');
            atomicWriteRef.value = atomically.writeFileSync;
        } catch (e) {
            log.warn('atomically 加载失败，降级为手动原子写:', e);
        }

        if (!fs.existsSync(archivesDir)) fs.mkdirSync(archivesDir, { recursive: true });

        // ---- 各模块工厂实例化，显式依赖注入 ----
        archive = createArchiveModule({ archivesDir, store, atomicWriteRef, fs, path, log });
        // 背景图缓存索引为明文内部文件（无隐私价值），使用独立的明文原子写，
        // 不经过 archive 的加密写入（避免索引被加密后自身无法读取）。
        const plainAtomicWrite = (filePath, data) => {
            if (atomicWriteRef.value) {
                atomicWriteRef.value(filePath, data, { encoding: 'utf8' });
            } else {
                const tmpPath = filePath + '.tmp-' + Date.now();
                fs.writeFileSync(tmpPath, data, 'utf8');
                fs.renameSync(tmpPath, filePath);
            }
        };
        bg = createBgCacheModule({
            app, fs, path, crypto, net, pathToFileURL, log,
            atomicWriteFileSync: plainAtomicWrite,
            getSettings: () => store.get('settings') || null
        });
        autoLaunch = createAutoLaunchModule({ app, fs, path, execFileSync, log });

        backup = createBackupModule({ app, dialog, fs, path, log, store, archive });

        windowMod = createWindowModule({
            BrowserWindow, Tray, Menu, path, log,
            assetsDir: __dirname,
            startHidden, isQuittingRef, trayRef,
            onMainWindowChange,
            // 呼出主界面时保留浮窗（画中画共存）：退出浮窗只走显式入口（横幅/更多菜单）
            beforeShow: () => {}
        });

        floating = createFloatingModule({
            BrowserWindow, screen, path, log,
            assetsDir: __dirname,
            getMainWindow: () => mainWindowRef.value,
            showMainWindow: () => windowMod.showMainWindow(),
            isQuitting: () => isQuittingRef.value,
            emit: emitToRenderer,
            getSettings: () => store.get('settings') || {}
        });

        // 协议/文档在线同步（三级兜底 + SHA-256 比对 + 本地缓存），不阻塞启动
        docsSync = createDocsSync({ app, fs, path, crypto, net, log });

        // 和风天气 JWT 认证客户端（主进程签名，渲染层不接触私钥）
        qweather = createQweatherClient({ net, log });

        // 自动更新（electron-updater + GitHub Releases）：启动静默检查一次，交互由用户确认
        updater = createUpdaterModule({
            app, log, net,
            getMainWindow: () => mainWindowRef.value
        });
        updater.setup();

        // ---- IPC 胶水层 ----
        setupIpc({
            ipcMain, clipboard, shell, log, store,
            archive, bg, autoLaunch, backup, floating, docsSync,
            qweather, updater,
            getMainWindow: () => mainWindowRef.value,
            fs, path, app
        });

        // ---- 启动就绪后的一次性初始化 ----
        bg.cleanupBgCache();

        const hadDevAutoLaunch = autoLaunch.removeDevAutoLaunchEntry();
        if (hadDevAutoLaunch || autoLaunch.getAutoLaunch()) {
            try { autoLaunch.setAutoLaunch(true); }
            catch (e) { log.warn('[autoLaunch] 刷新登录项失败:', e); }
        }

        windowMod.createWindow();
        windowMod.createTray();

        // 后台异步同步协议/文档（不阻塞界面）；变了则通知渲染层展示最新/重弹协议
        docsSync.sync().then((summary) => {
            if (summary && summary.changed && summary.changed.length) {
                emitToRenderer('docs:updated', summary);
            }
        }).catch((e) => log.error('[docs-sync] 后台同步失败:', e));

        // 启动静默检查更新（发现新版不打扰，等用户在"关于"面板操作）
        updater.check().catch((e) => log.error('[updater] 启动检查失败:', e));
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) windowMod.createWindow(true);
        else windowMod.showMainWindow();
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });

    app.on('before-quit', () => {
        isQuittingRef.value = true;
    });
}
