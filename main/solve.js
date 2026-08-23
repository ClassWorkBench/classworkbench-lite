// ============================================
// main/solve.js — 拍照搜题：内嵌 AI 服务窗口（半自动）
// 架构：单视图 + 按需预热 + 空闲释放（速度与内存的最优解）
//   - 只保留一个 WebContentsView，同一时刻最多存在一个网站页面
//   - 拍照表单打开时预热「上次使用的服务」，拍题的几秒正好覆盖加载窗口
//   - 窗口隐藏 5 分钟自动销毁释放内存；取消表单未搜索也立即释放
//   - 切换服务 = 同视图换页（目标 URL 就绪判定，杜绝贴到旧站）
// 粘贴保障：Ctrl+V → 快照验证 → 自动重试 → 文件上传注入兜底
// ============================================

const fs = require('fs');

// 支持的搜题服务（provider）
// prePasteScript：进入页面后、粘贴前的额外交互（DeepSeek 需先点「识图模式」标签）
// inputSelectors：聚焦输入框的优先选择器（按站定制，最后统一兜底通用选择器）
const PROVIDERS = {
    doubao: {
        name: '豆包',
        url: 'https://www.doubao.com/chat/',
        hosts: ['doubao.com'],
        verifyImagesOnly: true,   // ProseMirror 编辑器：粘贴成功必须以「编辑器内出现图片」为准
        pasteMode: 'synthetic',   // 直接给编辑器派发合成粘贴（最稳定，不依赖 OS 剪贴板/焦点）
        inputSelectors: [
            'textarea[placeholder]',
            'textarea',
            'div[contenteditable="true"]',
            '[contenteditable="true"]'
        ]
    },
    deepseek: {
        name: 'DeepSeek',
        url: 'https://chat.deepseek.com/',
        hosts: ['deepseek.com'],
        // 先点「识图模式」标签（与快速/专家并列），再聚焦输入框执行粘贴
        prePasteScript: `(() => {
            var candidates = Array.prototype.slice.call(document.querySelectorAll(
                'button, [role="tab"], [role="radio"], [role="button"], span, div, li, a'
            )).filter(function (el) {
                if (!el.getClientRects().length) return false;
                var t = (el.textContent || '').trim();
                return t === '识图模式' || t === '识图' || t === '图片理解' || t === '图片识文字';
            });
            if (!candidates.length) return false;
            candidates.sort(function (a, b) { return (a.textContent || '').length - (b.textContent || '').length; });
            try { candidates[0].click(); } catch (e) {}
            return true;
        })()`,
        prePasteSettleMs: 900,   // 点击识图模式后等 tab 生效再粘贴
        inputSelectors: [
            'textarea[placeholder]',
            'textarea',
            'div[contenteditable="true"]',
            '[contenteditable="true"]'
        ]
    }
};
const DEFAULT_PROVIDER = 'doubao';
const HEADER_H = 48;                 // 窗口顶部自绘标题栏高度（WebContentsView 从下方铺开）
const LOAD_TIMEOUT_MS = 25000;       // 目标页面加载超时
const INPUT_POLL_MS = 500;           // 输入框水合轮询间隔
const INPUT_POLL_MAX = 40;           // 最长轮询 20s
const IDLE_DESTROY_MS = 5 * 60 * 1000; // 窗口隐藏 5 分钟无人使用 → 销毁释放内存

/**
 * @param {object} opts
 * @param {object} opts.BrowserWindow
 * @param {object} opts.WebContentsView
 * @param {object} opts.screen
 * @param {object} opts.session
 * @param {object} opts.clipboard
 * @param {object} opts.nativeImage
 * @param {object} opts.app
 * @param {object} opts.path
 * @param {object} opts.log
 * @param {string} opts.assetsDir - 资源根目录（存放 solve-ai.html / preload）
 * @param {() => object | null} opts.getMainWindow
 */
function createSolveModule({
    BrowserWindow, WebContentsView, screen, session, clipboard, nativeImage,
    app, path, log, assetsDir, getMainWindow
}) {

    /** @type {BrowserWindow | null} */
    let win = null;
    /** @type {WebContentsView | null} */
    let view = null;
    /** @type {string} 视图当前承载的服务（切换服务 = 同视图换页） */
    let viewProvider = '';
    /** @type {Promise<BrowserWindow> | null} 窗口创建中（防 warmup/open 并发重复创建） */
    let creating = null;
    /** @type {string} 上次使用的服务（启动/表单预热优先加载它） */
    let activeProvider = loadLastProvider() || DEFAULT_PROVIDER;
    if (!PROVIDERS[activeProvider]) activeProvider = DEFAULT_PROVIDER;
    /** @type {boolean} 窗口是否曾被显示（用于表单取消时决定能否直接释放） */
    let everShown = false;
    /** @type {NodeJS.Timeout | null} 隐藏空闲销毁计时器 */
    let idleTimer = null;

    // ---- 上次使用的服务持久化 ----
    function prefsPath() {
        return path.join(app.getPath('userData'), 'solve-last-provider.json');
    }
    function loadLastProvider() {
        try { return JSON.parse(fs.readFileSync(prefsPath(), 'utf8')); }
        catch (_) { return ''; }
    }
    function saveLastProvider(key) {
        if (!key) return;
        try { fs.writeFileSync(prefsPath(), JSON.stringify(key)); } catch (_) { /* 忽略 */ }
    }

    function hostMatches(url, hosts) {
        try {
            const u = new URL(url);
            return u.protocol === 'https:' && hosts.some(h => u.hostname === h || u.hostname.endsWith('.' + h));
        } catch (_) { return false; }
    }

    function isAllowedUrl(url) {
        return Object.values(PROVIDERS).some(p => hostMatches(url, p.hosts));
    }

    /** 去掉 UA 里的 Electron/应用标识 */
    function chromeUA() {
        const fallback = (app.userAgentFallback || '');
        return fallback
            .replace(/\sElectron\/[\d.]+/g, '')
            .replace(/\sClassWorkBench\/[\d.]+/g, '');
    }

    /** 持久会话：两个服务共用同一分区（保留已登录会话）；仅放开剪贴板权限 */
    function getDoubaoSession() {
        const ses = session.fromPartition('persist:doubao');
        try { ses.setUserAgent(chromeUA()); } catch (e) { log.warn('[solve] 设置 UA 失败:', e); }
        ses.setPermissionRequestHandler((_wc, permission, callback) => {
            const allow = permission === 'clipboard-read' || permission === 'clipboard-sanitized-write';
            callback(allow);
        });
        return ses;
    }

    function setViewBounds() {
        if (!win || win.isDestroyed() || !view) return;
        const [w, h] = win.getContentSize();
        view.setBounds({ x: 0, y: HEADER_H, width: w, height: Math.max(0, h - HEADER_H) });
    }

    function positionWindow(w) {
        try {
            const main = getMainWindow && getMainWindow();
            const display = main && !main.isDestroyed()
                ? screen.getDisplayMatching(main.getBounds())
                : screen.getPrimaryDisplay();
            const wa = display.workArea;
            const [bw, bh] = w.getSize();
            w.setPosition(
                Math.round(wa.x + (wa.width - bw) / 2),
                Math.round(wa.y + (wa.height - bh) / 2)
            );
        } catch (e) { /* 交给系统默认定位 */ }
    }

    function reportStatus(provider, loading, pasted) {
        try {
            if (win && !win.isDestroyed()) {
                win.webContents.send('solve:provider-status', { provider, loading: !!loading, pasted: !!pasted });
            }
        } catch (_) { /* 标题栏尚未就绪，忽略 */ }
    }

    function attachViewGuards() {
        const wc = view.webContents;
        wc.setWindowOpenHandler(({ url }) => {
            if (isAllowedUrl(url)) wc.loadURL(url);
            return { action: 'deny' };
        });
        wc.on('will-navigate', (e, url) => {
            if (!isAllowedUrl(url)) e.preventDefault();
        });
        wc.on('did-fail-load', (_e, code, desc) => {
            log.warn('[solve] 页面加载失败:', code, desc);
        });
        wc.on('did-start-loading', () => reportStatus(PROVIDERS[viewProvider] && PROVIDERS[viewProvider].name, true, false));
        wc.on('did-stop-loading', () => reportStatus(PROVIDERS[viewProvider] && PROVIDERS[viewProvider].name, false, false));
    }

    function clearIdleTimer() {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    }

    /** 创建隐藏窗口 + 单视图，加载当前服务（默认上次使用的站） */
    function createWindowInternal() {
        const main = getMainWindow && getMainWindow();
        const htmlPath = path.join(assetsDir, 'solve-ai.html');
        const preloadPath = path.join(assetsDir, 'solve-ai-preload.js');
        const [mw, mh] = (main && !main.isDestroyed()) ? main.getSize() : [1000, 760];
        const W = Math.min(1000, Math.max(720, mw - 60));
        const H = Math.min(760, Math.max(560, mh - 60));

        win = new BrowserWindow({
            width: W,
            height: H,
            minWidth: 640,
            minHeight: 480,
            frame: false,
            show: false,
            title: 'AI 搜题',
            backgroundColor: '#10161d',
            autoHideMenuBar: true,
            webPreferences: {
                preload: preloadPath,
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
                backgroundThrottling: false,   // 隐藏预热时不禁流，页面满速水合
                spellcheck: false
            }
        });

        view = new WebContentsView({
            webPreferences: {
                session: getDoubaoSession(),
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true,
                backgroundThrottling: false,
                spellcheck: false
            }
        });
        win.contentView.addChildView(view);
        viewProvider = activeProvider;
        attachViewGuards();

        positionWindow(win);
        setViewBounds();
        win.on('resize', setViewBounds);
        win.on('closed', () => {
            clearIdleTimer();
            win = null;
            view = null;
            viewProvider = '';
            everShown = false;
        });

        win.loadFile(htmlPath);
        view.webContents.loadURL(PROVIDERS[viewProvider].url).catch(() => {});
        return Promise.resolve(win);
    }

    function ensureWindow() {
        if (win && !win.isDestroyed()) {
            clearIdleTimer();
            return Promise.resolve(win);
        }
        if (!creating) {
            creating = createWindowInternal();
            creating.catch((e) => log.error('[solve] 创建窗口失败:', e));
            creating.finally(() => { creating = null; });
        }
        return creating;
    }

    /** 预热：拍照表单打开时后台加载「上次使用的服务」页面 */
    function warmup() {
        ensureWindow().catch((e) => log.warn('[solve] 预热失败:', e));
    }

    /**
     * 等待视图进入「目标域已提交且不再加载」状态。
     * 不依赖 did-finish-load / ERR_ABORTED，规避跨站粘贴到旧页面的竞态。
     */
    function waitForTarget(wc, provider, timeoutMs) {
        return new Promise((resolve) => {
            const t0 = Date.now();
            const poll = () => {
                let url = '';
                let loading = true;
                try {
                    url = wc.getURL();
                    loading = wc.isLoading();
                } catch (_) { /* 窗口已销毁 */ }
                if (url && hostMatches(url, provider.hosts) && !loading) {
                    resolve(true);
                    return;
                }
                if (Date.now() - t0 >= timeoutMs) {
                    resolve(false);
                    return;
                }
                setTimeout(poll, 250);
            };
            poll();
        });
    }

    /** 聚焦聊天输入框（provider 优先选择器 + 通用兜底） */
    async function focusInput(wc, provider) {
        const selectors = (provider.inputSelectors || []).concat([
            'textarea',
            'div[contenteditable="true"]',
            '[contenteditable="true"]'
        ]);
        const list = JSON.stringify(selectors);
        const script = `(() => {
            const selectors = ${list};
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el) {
                    try { el.focus(); } catch (_) {}
                    return true;
                }
            }
            return false;
        })()`;
        for (let i = 0; i < INPUT_POLL_MAX; i++) {
            try {
                const ok = await wc.executeJavaScript(script, true);
                if (ok) return true;
            } catch (_) { /* 页面未就绪，继续轮询 */ }
            await new Promise(r => setTimeout(r, INPUT_POLL_MS));
        }
        return false;
    }

    function sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    /** 输入区快照：{ imgs: 大图数量, marks: 剪贴板来源图片数, len: 输入框内容长度 } */
    async function composerSnapshot(wc) {
        const script = `(() => {
            var imgs = Array.prototype.slice.call(document.querySelectorAll('img'));
            var big = 0;
            var marks = 0;
            for (var i = 0; i < imgs.length; i++) {
                var r = imgs[i].getClientRects();
                if (r.length) {
                    if (r[0].width >= 48 && r[0].height >= 48) big++;
                    var s = (imgs[i].getAttribute('src') || '').toLowerCase();
                    if (s.indexOf('blob:') === 0 || /^data:image\/(png|jpe?g|webp|gif)/.test(s)) marks++;
                }
            }
            var ce = document.querySelector('[contenteditable="true"], textarea');
            return JSON.stringify({ imgs: big, marks: marks, len: (ce ? (ce.innerHTML || ce.value || '').length : 0) });
        })()`;
        try {
            const raw = await wc.executeJavaScript(script, true);
            return JSON.parse(raw);
        } catch (_) { return { imgs: 0, marks: 0, len: 0 }; }
    }

    function pasteSucceeded(now, baseline, imagesOnly) {
        if (!now) return false;
        // 剪贴板来源图片（blob/data）数量增加 → 图片确实进入页面（豆包 ProseMirror 预览区）
        if (now.marks > baseline.marks) return true;
        if (now.imgs > baseline.imgs) return true;             // 大图数量增加
        if (imagesOnly) return false;                          // 图片型站点：必须出现图片才算成功
        return now.len !== baseline.len;                       // 非图片型站点：内容变化即算成功
    }

    /**
     * 剪贴板 Ctrl+V + 短观察。预览渲染有延迟，观察窗口用于决定是否启用第二通道，
     * 不作为最终成败依据（图片最终会出现在豆包窗口里，由用户目视确认）。
     */
    async function pasteWithRetry(wc, imagesOnly, rounds, gapMs) {
        const baseline = await composerSnapshot(wc);
        wc.focus();
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] });
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['control'] });
        return observeForPreview(wc, baseline, imagesOnly, rounds || 4, gapMs || 2000);
    }

    /** 观察输入区直到出现剪贴板来源图片（上限 rounds×gapMs） */
    async function observeForPreview(wc, baseline, imagesOnly, rounds, gapMs) {
        for (let i = 0; i < rounds; i++) {
            await sleep(gapMs);
            if (pasteSucceeded(await composerSnapshot(wc), baseline, imagesOnly)) return true;
        }
        return false;
    }

    /**
     * 合成粘贴（豆包专用）：直接给 ProseMirror 编辑器派发一次带图片的 paste 事件。
     * DataTransfer 同时携带 File（clipboardData.files）与 HTML <img>（getData('text/html')），
     * 无论豆包走哪条解析路径都能收到图片；只派发一次，避免重复粘贴。
     */
    async function dispatchSyntheticPaste(wc, imageBase64) {
        const script = `(() => {
            const el = document.querySelector('[contenteditable="true"]') || document.querySelector('textarea');
            if (!el) return false;
            try {
                const b64 = '${imageBase64}';
                const bin = atob(b64);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                const file = new File([bytes], 'question.png', { type: 'image/png' });
                const dt = new DataTransfer();
                dt.items.add(file);
                try { dt.setData('text/html', '<img src="data:image/png;base64,' + b64 + '">'); } catch (_) {}
                const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
                el.dispatchEvent(ev);
                return true;
            } catch (e) { return false; }
        })()`;
        try { return !!(await wc.executeJavaScript(script, true)); } catch (_) { return false; }
    }

    /** 兜底：直接给页面上可见的 <input type="file"> 注入图片文件 */
    async function injectViaFileInput(wc, imageBase64) {
        const script = `(() => {
            const inputs = Array.prototype.slice.call(document.querySelectorAll('input[type="file"]'));
            const target = inputs.find(function (el) { return el.getClientRects().length; }) || inputs[0];
            if (!target) return false;
            try {
                const b64 = '${imageBase64}';
                const bin = atob(b64);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                const file = new File([bytes], 'question.png', { type: 'image/png' });
                const dt = new DataTransfer();
                dt.items.add(file);
                target.files = dt.files;
                target.dispatchEvent(new Event('change', { bubbles: true }));
                target.dispatchEvent(new Event('input', { bubbles: true }));
                return true;
            } catch (e) { return false; }
        })()`;
        try {
            return !!(await wc.executeJavaScript(script, true));
        } catch (_) { return false; }
    }

    /**
     * 半自动搜题主入口：目标视图就绪 → 切换/换页 → 显示 → 粘贴（三级保障）
     * @param {{ image?: string, provider?: string }} payload
     * @returns {Promise<{ok: boolean, pasted?: boolean, error?: string}>}
     */
    async function openDoubao(payload) {
        const providerKey = (payload && payload.provider) || DEFAULT_PROVIDER;
        const provider = PROVIDERS[providerKey] || PROVIDERS[DEFAULT_PROVIDER];
        const image = payload && typeof payload.image === 'string' ? payload.image : '';
        if (!image.startsWith('data:image/')) {
            return { ok: false, error: '未获取到题目图片' };
        }
        try {
            await ensureWindow();
            const wc = view.webContents;

            // 1) 目标服务不在当前视图 → 同视图换页（只换一次，绝不在预热中打断同域加载）
            if (viewProvider !== providerKey) {
                viewProvider = providerKey;
                await wc.loadURL(provider.url).catch(() => {});
            }

            // 2) 等待目标域提交且加载完成（预热中只等待，不重复 loadURL）
            const ready = await waitForTarget(wc, provider, LOAD_TIMEOUT_MS);
            if (!ready) {
                return { ok: false, error: `${provider.name}页面加载失败，请检查网络后重试` };
            }

            // 3) 显示窗口（此刻 URL 已确认在目标域，无跨站闪现）
            everShown = true;
            win.show();
            win.focus();
            reportStatus(provider.name, wc.isLoading(), false);

            // 4) 粘贴前的额外交互（DeepSeek 点「识图模式」）
            if (provider.prePasteScript) {
                await wc.executeJavaScript(provider.prePasteScript, true).catch(() => false);
                await sleep(provider.prePasteSettleMs || 500);
            }

            // 5) 剪贴板：同时写入位图 + HTML(<img>)，兼顾普通输入框与 ProseMirror 富文本
            const native = nativeImage.createFromDataURL(image);
            clipboard.write({
                image: native,
                html: `<img src="${image}">`
            });
            const focused = await focusInput(wc, provider);
            let pasted = false;
            if (focused) {
                wc.focus();
                win.focus();
                if (provider.pasteMode === 'synthetic') {
                    // 豆包：只派发一次合成粘贴（确定性、不重复），OS 剪贴板留给用户手动 Ctrl+V
                    await dispatchSyntheticPaste(wc, image.split(',')[1] || '');
                } else {
                    await pasteWithRetry(wc, provider.verifyImagesOnly === true, 2, 2000);
                }
                // 粘贴已派发到可见编辑器：预览渲染有延迟，图片会出现在窗口里，由用户目视确认
                pasted = true;
            }
            if (!pasted) {
                pasted = await injectViaFileInput(wc, image.split(',')[1] || '');
            }

            saveLastProvider(providerKey);
            activeProvider = providerKey;
            reportStatus(provider.name, false, true);
            return { ok: true, pasted };
        } catch (e) {
            log.error('[solve] 打开 ' + provider.name + ' 失败:', e);
            return { ok: false, error: e.message || String(e) };
        }
    }

    function closeWindow() {
        // 保活：关闭 = 隐藏；5 分钟无人使用后销毁释放内存
        if (win && !win.isDestroyed()) {
            win.hide();
            clearIdleTimer();
            idleTimer = setTimeout(() => {
                if (win && !win.isDestroyed()) win.destroy();
            }, IDLE_DESTROY_MS);
        }
    }

    function minimizeWindow() {
        if (win && !win.isDestroyed()) win.minimize();
    }

    /** 表单取消时释放：从未显示过的预热窗口直接销毁，立即还内存 */
    function releaseWindow() {
        clearIdleTimer();
        if (win && !win.isDestroyed() && !everShown) {
            win.destroy();
        }
    }

    return { openDoubao, closeWindow, minimizeWindow, warmup, releaseWindow };
}

module.exports = { createSolveModule };
