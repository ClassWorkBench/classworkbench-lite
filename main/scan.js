// ============================================
// main/scan.js — 相机多页扫描 + 跨应用插入浮窗
// 承载两个职责：
//   1) 保存：把多张扫描图以文件形式落到「桌面/相机扫描/扫描_YYYYMMDD/」
//   2) 插入：置顶小浮窗（收缩按钮 ↔ 展开清单）把图交给当前前台窗口
//       实现：clipboard.writeImage 写入位图 → PowerShell SendKeys 模拟 Ctrl+V
//       浮窗置顶常驻，用户切到外部输入框后即可逐张/全部粘贴（QQ 会聚合多图，
//       微信等只收单张则用「单张插入」兜底）。
//
// 生命周期设计（本次重构收敛为单一职责，避免分散标志导致的状态漂移）：
//   - 同一时刻只存在一个浮窗实例，由内部 state 统一持有；
//   - 创建并发安全：creating 只作"在途创建"记号，成功后立即清空，杜绝陈旧
//     Promise 被后续轮次误复用；
//   - 尺寸/位置统一走 layoutShape()：用 setBounds 一步原子设置宽高与位置。
//     此窗口为 transparent + resizable:false 无边框窗，在 Windows 上
//     setSize 无法把"先前展开过"的窗口缩回（只设尺寸、位置错乱），
//     setBounds 一起设置才可靠——这是"第二轮浮窗卡成展开大面板、FAB 消失"
//     的真根因。
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
    app, path, fs, log, spawn, assetsDir, getMainWindow, getSettings
}) {

    // ---- 模块级状态：浮窗实例、形态、待插入图片（单一数据源） ----
    const state = {
        win: null,                // 浮窗实例（同一时刻唯一）
        creating: null,           // 在途创建 Promise，创建完成后立即清空
        images: [],               // 当前待插入的图片（dataURL）
        shape: 'collapsed'        // 当前形态：'collapsed' | 'expanded'
    };

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
        const img = state.images[idx];
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

    /** 创建浮窗窗口（show:false，交由 layoutShape/open 显示） */
    function createWindow() {
        const htmlPath = path.join(assetsDir, 'scan-floater.html');
        const preloadPath = path.join(assetsDir, 'scan-floater-preload.js');
        const w = new BrowserWindow({
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
        w.setAlwaysOnTop(true);
        // 不抢焦点：用户操作外部应用时浮窗只是提示，不打断输入焦点
        w.setFocusable(false);

        state.win = w;             // 登记为当前唯一浮窗实例，供后续生命周期函数引用
        w.on('closed', () => {
            if (state.win === w) state.win = null;
        });
        w.loadFile(htmlPath);
        return w;
    }

    /** 确保存在可用窗口，返回 Promise（并发安全；在途创建成功后立即清空 creating） */
    function ensureWindow() {
        if (state.win && !state.win.isDestroyed()) return Promise.resolve(state.win);
        if (!state.creating) {
            state.creating = Promise.resolve(createWindow());
            state.creating.then(() => { state.creating = null; })
                .catch(() => { state.creating = null; });
        }
        return state.creating;
    }

    /** 把浮窗按指定形态设尺寸并贴左工作区下沿，然后显示（不抢输入焦点）。
     *  用 setBounds 一步原子设置宽高与位置——此窗口为 transparent+resizable:false 无边框窗，
     *  在 Windows 上单独 setSize 缩回先前展开过的尺寸不可靠（实际不生效），
     *  而 setBounds 一起设置可避免尺寸吞掉、位置错乱。 */
    function layoutShape(w, shapeName) {
        const size = shapeName === 'expanded' ? SIZE_EXPANDED : SIZE_COLLAPSED;
        const wa = workArea();
        if (!wa) return false;
        const left = wa.x + MARGIN;
        let top = wa.y + wa.height - MARGIN - size.h;
        if (top < wa.y) top = wa.y;
        w.setBounds({ x: Math.round(left), y: Math.round(top), width: size.w, height: size.h });
        w.showInactive();
        return true;
    }

    /** 广播最新数据给浮窗渲染层（渲染层据此拉取唯一数据源） */
    function broadcast() {
        const w = state.win;
        if (w && !w.isDestroyed() && w.webContents) {
            w.webContents.send('scan:data', {
                count: state.images.length,
                reduceAnimation: !!(getSettings && getSettings().reduceAnimation)
            });
        }
    }

    /** 打开/刷新浮窗：重置数据源 → 建窗 → 复位收缩且锚定左下角 → 显示 → 广播 */
    async function open(imgs) {
        state.images = Array.isArray(imgs) ? imgs.map(d => (typeof d === 'string' ? { data: d } : d)) : [];
        await ensureWindow();
        const w = state.win;
        if (!w || w.isDestroyed()) return { ok: false, error: '浮窗创建失败' };
        // 每次打开都回到"收缩小按钮"形态并贴左下角，避免复用窗口停留在上次的展开态，
        // 或新建窗口因未定位而落在屏幕中央（被主窗口全屏表单盖住而无法点击）。
        state.shape = 'collapsed';
        layoutShape(w, 'collapsed');
        broadcast();
        return { ok: true, count: state.images.length };
    }

    /** 更新浮窗形态并联动窗口 resize，锚定左下角向上生长 */
    function setShape(s) {
        state.shape = s === 'expanded' ? 'expanded' : 'collapsed';
        const w = state.win;
        if (!w || w.isDestroyed()) return { ok: false };
        layoutShape(w, state.shape);
        return { ok: true };
    }

    /** 保存到桌面「相机扫描/扫描_YYYYMMDD/」 */
    function saveToDesktop(input) {
        const imgs = Array.isArray(input) ? input : state.images;
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
        state.images = [];
        if (state.win && !state.win.isDestroyed()) { state.win.destroy(); }
        state.win = null;
        state.creating = null;
    }

    return {
        open,
        close,
        setShape,
        insertIndex,
        saveToDesktop,
        getImages: () => state.images,
        getShape: () => state.shape
    };
}

module.exports = { createScanModule };
