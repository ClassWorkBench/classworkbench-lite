// ============================================
// main/scan.js — 相机多页扫描 + 跨应用插入浮窗
// 承载两个职责：
//   1) 保存：把多张扫描图以文件形式落到「桌面/相机扫描/扫描_YYYYMMDD/」
//   2) 插入：置顶小浮窗（收缩按钮 ↔ 展开清单）把图交给当前前台窗口
//       实现：clipboard.writeImage 写入位图 → PowerShell SendKeys 模拟 Ctrl+V
//       浮窗置顶常驻，用户切到外部输入框后即可逐张/全部粘贴（QQ 会聚合多图，
//       微信等只收单张则用「单张插入」兜底）。
// ============================================

const DPI = 96;
// 浮窗两种形态尺寸
const SIZE_COLLAPSED = { w: 60, h: 60 };
const SIZE_EXPANDED = { w: 364, h: 488 };
const MARGIN = 16;                 // 浮窗与工作区边缘距离
const SAVE_ROOT = '相机扫描';        // 桌面根目录名
const SAVE_PREFIX = '扫描_';         // 日期子目录前缀
const SENDKEYS_DELAY_MS = 120;     // 写剪贴板后、发按键前的稳定延时

function pad(n) { return String(n).padStart(2, '0'); }

/** 取「桌面/相机扫描/扫描_YYYYMMDD」目录，不存在则创建 */
function getSaveDir(app, fs, now) {
    const desk = app.getPath('desktop');
    const root = require('path').join(desk, SAVE_ROOT);
    const day = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const dir = require('path').join(root, SAVE_PREFIX + day);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * @param {object} opts
 * @param {object} opts.BrowserWindow
 * @param {object} opts.screen - 多屏定位
 * @param {object} opts.clipboard - clipboard.writeImage
 * @param {object} opts.nativeImage - nativeImage.createFromDataURL
 * @param {object} opts.app
 * @param {object} opts.path
 * @param {object} opts.fs
 * @param {object} opts.log
 * @param {Function} opts.spawn - child_process.spawn（SendKeys）
 * @param {string} opts.assetsDir - 资源根目录（scan-floater.html / preload）
 * @param {() => object | null} opts.getMainWindow
 */
function createScanModule({
    BrowserWindow, screen, clipboard, nativeImage,
    app, path, fs, log, spawn, assetsDir, getMainWindow
}) {

    /** @type {BrowserWindow | null} */
    let win = null;
    /** @type {Promise<BrowserWindow> | null} 创建中的浮窗（防并发重复建） */
    let creating = null;
    /** @type {{ data: string, dataUrl?: string, name?: string }[]} 当前待插入的图片（dataURL） */
    let images = [];
    /** @type {'collapsed' | 'expanded'} 浮窗当前形态 */
    let shape = 'collapsed';

    /** 取浮窗应停靠的工作区（跟随主窗口所在屏幕） */
    function workArea() {
        try {
            const main = getMainWindow && getMainWindow();
            const display = main && !main.isDestroyed()
                ? screen.getDisplayMatching(main.getBounds())
                : screen.getPrimaryDisplay();
            return display.workArea;
        } catch (e) {
            return null;
        }
    }

    /** 左下角停靠：收缩按钮贴工作区左下角 */
    function positionWindow(w) {
        const wa = workArea();
        if (!wa) return;
        const [bw] = w.getSize();
        w.setPosition(
            Math.round(wa.x + MARGIN),
            Math.round(wa.y + wa.height - bw - MARGIN)
        );
    }

    // ---- 跨应用插入：写剪贴板位图 + PowerShell SendKeys 模拟 Ctrl+V ----
    function sendPasteKey() {
        return new Promise((resolve) => {
            const script = "Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.SendKeys]::SendWait('^v')";
            try {
                const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
                    windowsHide: true
                });
                let done = false;
                const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
                child.on('error', (e) => { log.warn('[scan] SendKeys 失败:', e.message); finish(false); });
                child.on('exit', () => finish(true));
                // 兜底：2s 未退出强制当作完成
                setTimeout(() => finish(true), 2000);
            } catch (e) {
                log.warn('[scan] 启动 SendKeys 失败:', e);
                resolve(false);
            }
        });
    }

    async function insertIndex(idx) {
        const img = images[idx];
        if (!img || !img.data || !img.data.startsWith('data:image/')) {
            return { ok: false, error: '图片数据无效' };
        }
        try {
            const native = nativeImage.createFromDataURL(img.data);
            if (native.isEmpty()) return { ok: false, error: '图片解析失败' };
            // 1) 位图进剪贴板（外加 HTML <img>，兼顾富文本）
            clipboard.write({ image: native, html: `<img src="${img.data}">` });
            // 2) 小延时待剪贴板稳定后模拟 Ctrl+V，插入前台窗口
            await new Promise(r => setTimeout(r, SENDKEYS_DELAY_MS));
            const sent = await sendPasteKey();
            return { ok: true, sent };
        } catch (e) {
            log.error('[scan] 插入失败:', e);
            return { ok: false, error: e.message || String(e) };
        }
    }

    function createWindowInternal() {
        const htmlPath = path.join(assetsDir, 'scan-floater.html');
        const preloadPath = path.join(assetsDir, 'scan-floater-preload.js');
        win = new BrowserWindow({
            width: SIZE_COLLAPSED.w,
            height: SIZE_COLLAPSED.h,
            frame: false,
            show: false,
            resizable: false,
            alwaysOnTop: true,
            fullscreenable: false,
            minimizable: false,
            maximizable: false,
            skipTaskbar: true,
            hasShadow: false,
            title: '相机扫描',
            backgroundColor: '#00000000',
            transparent: true,
            movable: true,
            webPreferences: {
                preload: preloadPath,
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
                backgroundThrottling: false,
                spellcheck: false
            }
        });
        win.setAlwaysOnTop(true);
        // 不抢焦点：用户操作外部应用时浮窗只是提示，不打断输入焦点
        win.setFocusable(false);

        win.on('closed', () => { win = null; creating = null; });
        win.loadFile(htmlPath);
        return Promise.resolve(win);
    }

    function ensureWindow() {
        if (win && !win.isDestroyed()) return Promise.resolve(win);
        if (!creating) {
            creating = createWindowInternal();
            creating.catch((e) => log.error('[scan] 创建浮窗失败:', e));
        }
        return creating;
    }

    /** 更新浮窗形态并配合窗口 resize
     *  收缩：贴左下角的小按钮；展开：以左下角为锚，面板从按钮位置向上浮起 */
    function setShape(s) {
        shape = s === 'expanded' ? 'expanded' : 'collapsed';
        if (!win || win.isDestroyed()) return { ok: false };
        const wa = workArea();
        if (!wa) return { ok: false };
        const size = shape === 'expanded' ? SIZE_EXPANDED : SIZE_COLLAPSED;
        win.setSize(size.w, size.h);
        // 锚定左下角：面板底边贴工作区底，向左下角对齐并向上（垂直方向）生长；
        // 高度超屏时贴顶并保证不越出工作区底
        const left = wa.x + MARGIN;
        let top = wa.y + wa.height - MARGIN - size.h;
        if (top < wa.y) top = wa.y;
        win.setPosition(Math.round(left), Math.round(top));
        return { ok: true };
    }

    /** 打开/刷新浮窗：清空待插入数据，展示为收缩按钮 */
    async function open(imgs) {
        images = Array.isArray(imgs) ? imgs.map(d => (typeof d === 'string' ? { data: d } : d)) : [];
        await ensureWindow();
        if (!win || win.isDestroyed()) return { ok: false, error: '浮窗创建失败' };
        win.setFocusable(false);
        if (!win.isVisible()) {
            positionWindow(win);
            win.showInactive();
        }
        // 让浮窗渲染层拉取最新数据并锚定收缩态
        win.webContents.send('scan:data', { count: images.length });
        return { ok: true, count: images.length };
    }

    /** 保存到桌面「相机扫描/扫描_YYYYMMDD/」 */
    function saveToDesktop(input) {
        const imgs = Array.isArray(input) ? input : images;
        if (!imgs.length) return { ok: false, error: '没有可保存的图片' };
        let dir;
        try {
            dir = getSaveDir(app, fs, new Date());
        } catch (e) {
            log.error('[scan] 创建保存目录失败:', e);
            return { ok: false, error: '创建保存目录失败' };
        }
        const saved = [];
        for (let i = 0; i < imgs.length; i++) {
            const img = imgs[i];
            if (!img) continue;
            const data = typeof img === 'string' ? img : (img && img.data);
            if (!data || !data.startsWith('data:image/png')) continue;
            try {
                const buf = Buffer.from(data.split(',')[1] || '', 'base64');
                const file = path.join(dir, `图${i + 1}.png`);
                fs.writeFileSync(file, buf);
                saved.push(file);
            } catch (e) {
                log.warn(`[scan] 保存图${i + 1}失败:`, e);
            }
        }
        return { ok: true, saved, dir };
    }

    /** 关闭/销毁浮窗 */
    function close() {
        images = [];
        if (win && !win.isDestroyed()) { win.destroy(); }
        win = null;
        creating = null;
    }

    return {
        open,
        close,
        setShape,
        insertIndex,
        saveToDesktop,
        getImages: () => images,
        getShape: () => shape
    };
}

module.exports = { createScanModule };