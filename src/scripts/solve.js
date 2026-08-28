// ============================================
// solve.js — 拍照搜题（更多菜单入口）
// 弹出式表单：展台/摄像头预览 + 扫描仪式自动抓拍
// 半自动流程：抓拍 → 剪贴板 → 内嵌豆包窗口粘贴，用户点发送
// ============================================

(function () {
    'use strict';

    const state = window.AppState;
    const { toast } = window.AppUtils;
    const { showModal } = window.AppModal;

    let current = null;   // 当前打开的扫描会话

    // 灵敏度 → 运动判定阈值（相邻帧灰度差/像素，0-255）。数值越小越灵敏
    const MOTION_TH = { 1: 18, 2: 12, 3: 7 };
    const SAMPLE_MS = 240;       // 采样间隔（毫秒）
    // 滑动窗口稳定判定：最近 WINDOW_N 次采样中稳定帧数 >= WINDOW_K 即触发。
    // 滞回窗口容忍偶发一帧抖动/光照闪烁，比「严格连续 N 帧」更稳。
    const WINDOW_N = 9;
    const WINDOW_K = 7;
    const MAX_EDGE = 1600;       // 出图最长边像素（控制剪贴板体积）
    // 启动分辨率：640 流畅 / 720 标准（默认，冷启动快）/ 1080 高清（最慢）
    const RES_MAP = {
        '640':  { w: 640,  h: 480 },
        '720':  { w: 1280, h: 720 },
        '1080': { w: 1920, h: 1080 }
    };

    function getSolveSettings() {
        if (!state.settings.solve) {
            state.settings.solve = { cameraId: '', flip: false, rotation: 0, autoScan: true, sensitivity: 2 };
        }
        return state.settings.solve;
    }

    // 预览带重拍图标（内联 SVG）
    const RESCAN_ICON =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.3"/><path d="M21 3v6h-6"/></svg>';

    function buildHtml(sol) {
        return `
                    <div class="solve-head">
                        <span class="solve-head-icon"><img class="emoji" src="emoji/camera_color.svg" alt="📷"></span>
                        <div class="solve-head-text">
                            <div class="solve-title">拍照搜题</div>
                            <div class="solve-sub">拍下题目，选 AI 搜题</div>
                        </div>
                    </div>
                    <div class="solve-preview" id="solvePreview">
                        <video id="solveVideo" autoplay playsinline muted></video>
                        <div class="solve-scan" id="solveScan" aria-hidden="true"><i class="solve-scan-line"></i></div>
                        <img class="solve-shot" id="solveShot" alt="拍摄结果" hidden>
                    </div>
                    <div class="solve-pages" id="solvePages" aria-label="已拍页面"></div>
                    <div class="solve-status" id="solveStatus">正在打开摄像头…</div>
                    <div class="solve-opts">
                        <label class="solve-opt"><input type="checkbox" id="solveAutoCb" ${sol.autoScan ? 'checked' : ''}> 自动扫描</label>
                    </div>
                    <div class="dialog-btn-row solve-btns">
                        <button class="btn" id="solveCancelBtn" type="button">取消</button>
                        <button class="btn" id="solveManualBtn" type="button">手动拍照</button>
                        <button class="btn primary" id="solveGoDoubao" type="button" hidden>豆包搜题</button>
                        <button class="btn primary" id="solveGoDeepseek" type="button" hidden>DeepSeek 搜题</button>
                    </div>
                `;
    }

    function setStatus(text) {
        if (current && current.statusEl) current.statusEl.textContent = text;
    }

    async function open() {
        if (current) {
            toast('拍照搜题已打开');
            return;
        }
        const sol = getSolveSettings();
        // 摄像头获取与弹窗渲染并行，缩短感知上的冷启动时间
        let streamPromise;
        try {
            streamPromise = acquireStream(sol, sol.cameraId).catch((e) => ({ error: e }));
        } catch (e) {
            streamPromise = Promise.resolve({ error: e });
        }
        const { dialog, close } = showModal(buildHtml(sol), cleanup);
        dialog.classList.add('solve-dialog');

        // 预热：拍照/扫描期间后台加载全部搜题服务页面，缩短等待
        if (window.electronAPI && window.electronAPI.solve && typeof window.electronAPI.solve.warmup === 'function') {
            window.electronAPI.solve.warmup().catch(() => {});
        }

        current = {
            close,
            sol,
            dialog,
            video: dialog.querySelector('#solveVideo'),
            preview: dialog.querySelector('#solvePreview'),
            scan: dialog.querySelector('#solveScan'),
            shot: dialog.querySelector('#solveShot'),
            statusEl: dialog.querySelector('#solveStatus'),
            manualBtn: dialog.querySelector('#solveManualBtn'),
            goDoubao: dialog.querySelector('#solveGoDoubao'),
            goDeepseek: dialog.querySelector('#solveGoDeepseek'),
            pagesEl: dialog.querySelector('#solvePages'),
            pages: [],
            stream: null,
            raf: 0,
            shotData: null,
            phase: 'idle',
            motionCount: 0,
            stableCount: 0,
            lastSample: 0,
            bench: null,
            win: null,
            winStable: 0,
            stopped: false
        };

        bindControls();
        watchLayout();
        await attachStream(current, await streamPromise);
    }

    // ---- 取景框精确适配 + 手动贝塞尔动画 ----
    // 为什么不用 CSS 定死：弹窗内容（缩略图带出现/消失、按钮显隐）和窗口高度都动态变化，
    // CSS 魔数（固定比例/固定 vh）在极端窗口高度下要么撑出滚动条、要么把内容压扁。
    // 为什么不用 CSS transition 做动画：Chromium 在「测量归零/类切换」链路里会合并、取消、
    // 残留过渡中间帧，导致动画僵硬、突变、甚至尺寸冻结。这里改用 JS 逐帧插值（README 见下），
    // 完全确定、可中断可逆转、不受任何布局侧操作干扰 → 始终丝滑。
    //
    // 测量（仅显式 force 进入，两段式实测，不枚举兄弟元素——gap/隐藏项/边框陷阱太多）：
    //   1. 取景框临时归零 → 弹窗此刻的实际总高 = 其余内容的精确总高
    //   2. 限高 - 该值 = 可用高度，再按真实视频流比例求宽高
    //   - 测量会改布局 → 归零期间必须暂停动画；测完从恢复点无缝续播
    //   非测量（RO / resize）只做纯计算（缓存余高 + 实时限高）→ 切断测量引起的自激振荡。
    // 记忆：真实视频比例存入设置，视频就绪前用记忆比例，打开瞬间不再 4:3→16:9 突跳
    function fitPreview(force) {
        const c = current;
        if (!c || !c.dialog || !c.preview) return;
        const dlg = c.dialog;
        const pv = c.preview;

        if (force) {
            // 暂停动画，记录当前渲染尺寸作为无缝续播的起点
            const cur = pauseAnim(c);
            const prevW = pv.style.width;
            const prevH = pv.style.height;
            pv.style.width = '0px';
            pv.style.height = '0px';
            const restH = dlg.offsetHeight;   // border-box 口径，与 max-height 同口径
            c._restH = restH;                 // 缓存：此后所有非 force 调用复用（内容变化由 renderPages 强制刷新）
            pv.style.width = prevW;           // 恢复原样式值，布局回到测量前状态
            pv.style.height = prevH;
            pv.offsetWidth;
            // 记忆真实摄像头比例（未旋转的原始值），供下次打开在视频就绪前直接使用
            if (c.video.videoWidth && c.video.videoHeight) {
                const base = c.video.videoWidth / c.video.videoHeight;
                if (Math.abs((c.sol.previewAR || 0) - base) > 0.01) {
                    c.sol.previewAR = +base.toFixed(4);
                    window.AppStorage.saveSettings().catch(() => {});
                }
            }
            startAnim(c, computeTarget(c, restH), cur);   // 从恢复点(cur)平滑到新目标
        } else if (c._restH) {
            startAnim(c, computeTarget(c, c._restH));      // 纯计算快速路径：不测量
        }
    }

    // ---------- 手动贝塞尔尺寸动画 ----------
    // 每次调用：若目标与「动画最终目标」不同，或动画未在跑，则从当前渲染位置启动新插值。
    // 单帧内多次触发只会收敛到同一个目标，不会中断/重启 → 无突变。
    // 目标未变且动画已停 → 什么都不做（不触碰 style，绝无振荡）。
    const ANIM_MS = 320;   // 与苹果缓出 feel 一致
    // 预采样 cubic-bezier(0.22, 1, 0.36, 1) 曲线 → 避免每帧解三次方程
    const EASE = (() => {
        const n = 64, out = new Float64Array(n + 1);
        // Newton 迭代解 x(t)=p，取 y(t)。控制点 P0(0,0) P1(0.22,1) P2(0.36,1) P3(1,1)
        for (let i = 0; i <= n; i++) {
            const p = i / n;
            let t = p;
            for (let k = 0; k < 8; k++) {
                const mt = 1 - t;
                const x = 3 * mt * mt * t * 0.22 + 3 * mt * t * t * 0.36 + t * t * t;
                const dx = 3 * mt * mt * 0.22 + 6 * mt * t * (0.36 - 0.22) + 3 * t * t * (1 - 0.36);
                if (Math.abs(dx) < 1e-6) break;
                t -= (x - p) / dx;
                if (t < 0) { t = 0; } else if (t > 1) { t = 1; }
            }
            const mt = 1 - t;
            out[i] = 3 * mt * mt * t * 1 + 3 * mt * t * t * 1 + t * t * t;
        }
        return out;
    })();

    // 暂停动画：返回「当前渲染尺寸」作为续播起点，并取消进行中的插值帧
    function pauseAnim(c) {
        const pv = c.preview;
        const r = pv.getBoundingClientRect();
        if (c._animRaf) { cancelAnimationFrame(c._animRaf); c._animRaf = 0; }
        c._anim = null;
        return { w: r.width, h: r.height };
    }

    // 从当前渲染尺寸向目标尺寸逐帧插值
    function startAnim(c, to, from) {
        const pv = c.preview;
        if (!to || to.w <= 0 || to.h <= 0) return;
        if (!from) {
            // 无显式起点：用当前渲染尺寸（含正在进行的动画中间值，保证无缝衔接/可逆）
            const r = pv.getBoundingClientRect();
            from = { w: r.width, h: r.height };
        }
        // 已在朝同一目标动画 → 保持（不重启、不突变）
        if (c._to && c._to.w === to.w && c._to.h === to.h && c._animRaf) return;
        // 目标等于当前渲染尺寸（且无活跃动画）→ 直接定格，不启动插值
        if (!c._anim && Math.abs(from.w - to.w) < 0.5 && Math.abs(from.h - to.h) < 0.5) {
            pv.style.width = to.w + 'px';
            pv.style.height = to.h + 'px';
            c._anim = null; c._to = null;
            return;
        }
        c._from = from;
        c._to = to;
        c._t0 = performance.now();   // 从 from（当前渲染位置）播一段新的 320ms 插值
        if (!c._animRaf) c._animRaf = requestAnimationFrame(() => animStep(c));
    }

    function animStep(c) {
        c._animRaf = 0;
        const pv = c.preview;
        if (!c || current !== c || !pv) return;
        const from = c._from, to = c._to;
        if (!from || !to) return;
        const p = Math.min(1, (performance.now() - c._t0) / ANIM_MS);
        const e = EASE[Math.min(EASE.length - 1, Math.round(p * (EASE.length - 1)))];
        const w = from.w + (to.w - from.w) * e;
        const h = from.h + (to.h - from.h) * e;
        pv.style.width = w + 'px';
        pv.style.height = h + 'px';
        pv.style.aspectRatio = 'auto';
        if (p < 1) {
            c._animRaf = requestAnimationFrame(() => animStep(c));
        } else {
            // 定稿：写入精确目标，清理态，绝无残留中间帧
            pv.style.width = to.w + 'px';
            pv.style.height = to.h + 'px';
            c._anim = null; c._to = null; c._from = null; c._t0 = 0;
        }
    }

    // 由「余高 + 限高 + 视频流比例」求取景框目标尺寸
    function computeTarget(c, restH) {
        const dlg = c.dialog;
        const st = getComputedStyle(dlg);
        let maxDlgH = parseFloat(st.maxHeight);
        if (!maxDlgH || !isFinite(maxDlgH)) maxDlgH = window.innerHeight;
        const padX = parseFloat(st.paddingLeft) + parseFloat(st.paddingRight);
        const availW = dlg.clientWidth - padX;
        let ar = (c.video.videoWidth && c.video.videoHeight)
            ? c.video.videoWidth / c.video.videoHeight
            : (c.sol.previewAR || 4 / 3);   // 视频未就绪：用上次会话记忆的摄像头比例，避免就绪后突跳
        // 旋转 90/270 时画面与输出图都是竖向 → 比例取倒数
        if ((c.sol.rotation || 0) % 180 !== 0) ar = 1 / ar;
        // 限高内的剩余空间都给取景框（140 保底：极小窗口下至少能看清画面）
        const h = Math.floor(Math.max(140, Math.min(maxDlgH - restH, availW / ar)));
        return { w: Math.floor(h * ar), h };
    }

    // 弹窗内容或窗口尺寸变化（缩略图带出现、按钮显隐、窗口缩放）时重新适配
    function watchLayout() {
        const c = current;
        if (!c || !c.dialog) return;
        c._ro = new ResizeObserver(() => requestAnimationFrame(fitPreview));
        c._ro.observe(c.dialog);
        // 首次：显式强制测量（非 force 快速路径依赖 _restH，首次必须先实测一次拿到余高）
        requestAnimationFrame(() => fitPreview(true));
        // 窗口尺寸变化时重新适配（快速路径实时读限高/宽度，无需测量即可正确收敛）
        window.addEventListener('resize', fitPreview);
    }

    function bindControls() {
        const c = current;
        c.manualBtn.addEventListener('click', () => capture('manual'));
        c.goDoubao.addEventListener('click', () => goto('doubao'));
        c.goDeepseek.addEventListener('click', () => goto('deepseek'));
        // 预览带事件委托：重拍（当前页右上角）与继续拍下一页（+格）
        c.pagesEl.addEventListener('click', (e) => {
            const t = e.target.closest('[data-action]');
            if (!t) return;
            if (t.dataset.action === 'rescan') rescan();
            else if (t.dataset.action === 'add') nextPage();
        });
        dialogCloseBtn(c);

        const autoCb = document.getElementById('solveAutoCb');
        autoCb.addEventListener('change', async () => {
            c.sol.autoScan = !!autoCb.checked;
            c.scan.classList.toggle('hidden', !c.sol.autoScan);
            resetScanState();
            updateScanStatus();
            if (c.sol.autoScan) rearm();   // 从关→开时启动扫描循环
            await window.AppStorage.saveSettings();
        });
        // 初始自动扫描状态
        c.scan.classList.toggle('hidden', !c.sol.autoScan);
    }

    function dialogCloseBtn(c) {
        const cancelBtn = document.getElementById('solveCancelBtn');
        cancelBtn.addEventListener('click', () => c.close());
    }

    /** 按设置的分辨率请求摄像头（不含 UI 逻辑，便于并发启动） */
    function acquireStream(sol, deviceId) {
        const r = RES_MAP[sol.resolution] || RES_MAP['720'];
        const constraints = {
            video: {
                width: { ideal: r.w, max: 1920 },
                height: { ideal: r.h, max: 1080 },
                frameRate: { ideal: 20, max: 30 },
                ...(deviceId ? { deviceId: { exact: deviceId } } : {})
            },
            audio: false
        };
        return navigator.mediaDevices.getUserMedia(constraints);
    }

    /** 把已获取的流挂到视频元素并启动扫描 */
    async function attachStream(c, stream) {
        if (!c) return;
        if (!stream || stream.error) {
            const err = stream ? stream.error : new Error('无摄像头');
            setStatus('无法打开摄像头：' + (err.message || err));
            toast('摄像头打开失败，请检查设备与权限');
            return;
        }
        stopTracks(c);
        c.stream = stream;
        c.video.srcObject = stream;
        // 预览与拍摄共用同一方向规则（先镜像再旋转），所见即所得
        c.video.style.transform = 'rotate(' + ((c.sol.rotation || 0) % 360) + 'deg) scaleX(' + (c.sol.flip ? -1 : 1) + ')';
        try {
            await c.video.play();
        } catch (_) { /* 自动播放策略已放开，正常不会走到 */ }
        fitPreview();   // 视频元数据就绪：用真实流比例重新适配取景框
        if (current !== c) { stopTracks(c); return; }
        setStatus('摄像头就绪，等待放入题目…');
        resetScanState();
        if (current !== c) return;
        setTimeout(rearm, 0);
        updateScanStatus();
    }

    // 若自动扫描仍开启且有会话，则按节流启动扫描循环（否则彻底不空转）
    function rearm() {
        const c = current;
        if (!c || c.stopped || !c.sol.autoScan || c.shotData) return;
        c.raf = setTimeout(scanLoop, SAMPLE_MS);
    }

    // ---- 帧差异：相邻帧灰度平均绝对差（带曝光/亮度漂移补偿） ----
    // 与「基准帧」比较而非仅相邻帧：同时计算整幅平均亮度差，漂移大时补偿，
    // 从而降低自动曝光/光源缓慢变化导致的误判。静止时差值趋近于 0。
    function computeDiff(c, video) {
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        const W = 160;
        const H = Math.max(2, Math.round(vh * W / vw));
        const canvas = c._diffCanvas || (c._diffCanvas = document.createElement('canvas'));
        canvas.width = W;
        canvas.height = H;
        const g = canvas.getContext('2d', { willReadFrequently: true });
        g.drawImage(video, 0, 0, W, H);
        const data = g.getImageData(0, 0, W, H).data;

        // 累计当前帧像素差 + 平均亮度
        let sum = 0;
        let n = 0;
        let lum = 0;
        for (let i = 0; i < data.length; i += 16) {
            const r = data[i], gr = data[i + 1], b = data[i + 2];
            lum += (r + gr + b) / 3;
            if (c.bench && c.bench.px[i] !== undefined) sum += Math.abs(data[i] - c.bench.px[i]);
            n++;
        }
        lum /= n;

        let diff = n ? sum / n : 0;
        if (c.bench) {
            // 曝光漂移补偿：整体亮度偏移量按比例扣回，避免把均匀提亮/变暗误判为运动
            const drift = lum - c.bench.lum;
            diff = Math.max(0, diff - Math.abs(drift) * 0.5);
            // 写入新的基准而非直接更新，bottom-up：始终用当前帧作为下帧基准（相邻对比）
        }
        // 以当前帧刷新基准帧（相邻帧对比）
        if (!c.bench) c.bench = {};
        c.bench.px = new Uint8ClampedArray(data);
        c.bench.lum = lum;
        return diff;
    }

    // ---- 扫描仪式：运动检测 + 稳定判定（滑动窗口） ----
    function resetScanState() {
        const c = current;
        if (!c) return;
        c.phase = 'idle';
        c.motionCount = 0;
        c.stableCount = 0;
        c.bench = null;       // 基准帧（像素 + 平均亮度），用于相邻帧对比
        c.win = null;         // 滑动窗口（0=运动帧, 1=稳定帧）
        c.winStable = 0;      // 窗口内稳定帧数
        c.shotData = null;
    }

    function updateScanStatus() {
        const c = current;
        if (!c) return;
        if (c.shotData) { setStatus('已拍摄 ✓ 选 AI 搜题，或拍下一页'); return; }
        if (!c.sol.autoScan) { setStatus('手动模式：把题目对准镜头，点「手动拍照」'); return; }
        if (c.phase === 'motion') setStatus('检测到题目，正在对焦…');
        else if (c.phase === 'stable') setStatus('保持稳定，即将自动拍摄…');
        else setStatus('等待放入题目…（自动扫描中）');
    }

    function scanLoop() {
        const c = current;
        if (!c || c.stopped) return;
        // 手动模式 / 已抓拍：不再续排，避免每帧空转
        if (!c.sol.autoScan || c.shotData) return;
        sampleFrame();
        // 直接按采样节流排队下一帧，无需 60Hz 的 rAF 空转
        c.raf = setTimeout(scanLoop, SAMPLE_MS);
    }

    function sampleFrame() {
        const c = current;
        if (!c || !c.video.videoWidth || !c.sol.autoScan || c.shotData) return;
        if (!c.bench) { computeDiff(c, c.video); return; }   // 首帧仅作基准

        const d = computeDiff(c, c.video);
        const th = MOTION_TH[c.sol.sensitivity] || 12;   // 单阈值：超阈值即算运动

        let cat;   // 1=稳定帧, 0=运动帧
        if (d > th) {
            // 明显变化 → 运动帧（清零稳定累计）
            c.motionCount++;
            c.stableCount = 0;
            cat = 0;
            if (c.motionCount >= 2 || c.phase !== 'idle') c.phase = 'motion';
        } else {
            // 无显著运动 → 稳定帧。抗抖由滑动窗口兜底：
            // 偶发一帧超阈值只会让窗口少一个稳定帧，不会整体清零。
            c.motionCount = 0;
            c.stableCount++;
            c.phase = 'stable';
            cat = 1;
        }

        // 滑动窗口计数：最近 WINDOW_N 帧中稳定数 >= WINDOW_K 即触发。
        // 偶发一帧抖动只会让窗口内少一个稳定帧，不会像「连续计数」那样整体清零。
        c.win = c.win || [];
        c.win.push(cat);
        if (cat === 1) c.winStable++;
        while (c.win.length > WINDOW_N) {
            if (c.win.shift() === 1) c.winStable--;
        }
        if (c.winStable >= WINDOW_K) { capture('auto'); return; }

        updateScanStatus();
    }

    // ---- 抓拍 ----
    function capture(mode) {
        const c = current;
        if (!c || !c.video.videoWidth) {
            toast('画面尚未就绪');
            return;
        }
        if (c.shotData && mode === 'auto') return;

        const vw = c.video.videoWidth;
        const vh = c.video.videoHeight;
        const scale = Math.min(1, MAX_EDGE / Math.max(vw, vh));
        const rawW = Math.round(vw * scale);
        const rawH = Math.round(vh * scale);
        // 旋转 90/270 时输出宽高互换
        const rot = (c.sol.rotation || 0) % 360;
        const swap = rot % 180 !== 0;
        const w = swap ? rawH : rawW;
        const h = swap ? rawW : rawH;
        const canvas = c._shotCanvas || (c._shotCanvas = document.createElement('canvas'));
        canvas.width = w;
        canvas.height = h;
        const g = canvas.getContext('2d');
        // 顺序：先镜像(scaleX) 再旋转，与预览 CSS 规则一致 → 所见即所得
        g.translate(w / 2, h / 2);
        g.rotate(rot * Math.PI / 180);
        g.scale(c.sol.flip ? -1 : 1, 1);
        g.drawImage(c.video, -rawW / 2, -rawH / 2, rawW, rawH);

        c.shotData = canvas.toDataURL('image/png');
        c.shot.src = c.shotData;
        c.shot.hidden = false;
        c.video.style.display = 'none';
        c.scan.classList.add('hidden');
        clearTimeout(c.raf);
        c.manualBtn.hidden = true;
        c.goDoubao.hidden = false;
        c.goDeepseek.hidden = false;
        const total = c.pages.length + 1;
        setStatus(`已拍 ${total} 页 ✓ 选一个 AI 搜题，或拍下一页`);
        renderPages();   // 当前页即时滑入横向平铺预览带
    }

    // ---- 多页：把当前页定稿入列表，翻到下一页继续拍 ----
    function nextPage() {
        const c = current;
        if (!c || !c.shotData) return;
        c.pages.push(c.shotData);   // 当前页定稿
        c.shotData = null;
        startFraming();
        renderPages();
        setStatus(`已拍 ${c.pages.length} 页，请对准下一页…`);
    }

    function rescan() {
        const c = current;
        if (!c) return;
        c.shotData = null;          // 重拍当前页（已定稿的前页不受影响）
        const hadPages = c.pages.length > 0;
        startFraming();
        renderPages();   // 当前页从平铺预览带移除
        setStatus(hadPages ? `已拍 ${c.pages.length} 页，重拍本页…` : '等待放入题目…');
    }

    // 恢复相机实时预览 + 扫描循环（多页翻页 / 本页重拍共用）
    function startFraming() {
        const c = current;
        if (!c) return;
        c.shot.hidden = true;
        c.video.style.display = '';
        c.scan.classList.toggle('hidden', !c.sol.autoScan);
        c.manualBtn.hidden = false;
        c.goDoubao.hidden = true;
        c.goDeepseek.hidden = true;
        clearTimeout(c.raf);
        resetScanState();
        if (c.sol.autoScan) c.raf = setTimeout(scanLoop, SAMPLE_MS);
    }

    // 渲染横向平铺预览带：已定稿页 + 当前刚拍页（末位高亮 + 右上角重拍 + 滑入 + 滚到最新）
    // 当前页标题右侧追加「+」格 = 继续拍下一页（从底栏移除，避免底部按钮拥挤）
    function renderPages() {
        const c = current;
        if (!c || !c.pagesEl) return;
        c.pagesEl.innerHTML = '';
        c.pages.forEach((src, i) => {
            c.pagesEl.appendChild(buildPageItem(src, i + 1, false));
        });
        if (c.shotData) {
            c.pagesEl.appendChild(buildPageItem(c.shotData, c.pages.length + 1, true));
            c.pagesEl.appendChild(buildAddTile());   // 有当前页才允许继续拍下一页
        }
        c.pagesEl.classList.toggle('empty', c.pages.length === 0 && !c.shotData);
        if (c.pagesEl.scrollWidth > c.pagesEl.clientWidth) {
            c.pagesEl.scrollLeft = c.pagesEl.scrollWidth;   // scroll-behavior:smooth 平滑滚到最新
        }
        fitPreview(true);   // 内容变了（缩略图增删/按钮显隐都可能经由这里）→ 强制重测并重适配。
                            // 弹窗被限高钉死时高度不随内容变，ResizeObserver 看不见这类变化
    }

    function buildPageItem(src, idx, active) {
        const item = document.createElement('div');
        item.className = 'solve-pages-item' + (active ? ' is-active' : '');
        item.innerHTML = `<span class="scan-strip-idx">${idx}</span>` +
            (active
                ? `<button type="button" class="solve-page-rescan" data-action="rescan" title="重拍本页" aria-label="重拍本页">${RESCAN_ICON}</button>`
                : '') +
            `<img src="${src}" alt="第${idx}页">`;
        return item;
    }

    // 「继续拍下一页」占位格：半透明灰色圆角矩形 + 相机图标与加号角标
    function buildAddTile() {
        const tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'solve-pages-add';
        tile.dataset.action = 'add';
        tile.title = '继续拍下一页';
        tile.setAttribute('aria-label', '继续拍下一页');
        tile.innerHTML = '<img class="solve-pages-add-cam" src="emoji/camera_outline.svg" alt="继续拍下一页">' +
            '<span class="solve-pages-add-plus">+</span>';
        return tile;
    }

    // ---- 半自动：去 AI 服务搜题 ----
    async function goto(provider) {
        const c = current;
        if (!c) return;
        const imgs = c.pages.concat(c.shotData ? [c.shotData] : []);
        if (!imgs.length) return;
        if (!window.electronAPI || typeof window.electronAPI.solve !== 'object' || typeof window.electronAPI.solve.open !== 'function') {
            toast('当前环境不支持内嵌 AI 搜题');
            return;
        }
        const name = provider === 'deepseek' ? 'DeepSeek' : '豆包';
        setStatus(`正在打开 ${name} 并粘贴 ${imgs.length} 张图片…`);
        try {
            const res = await window.electronAPI.solve.open({ images: imgs, provider });
            if (res && res.ok) {
                toast(res.pasted ? `${imgs.length} 张图片已粘贴到${name}，请点击发送` : `${name}已打开，请点击输入框后按 Ctrl+V 粘贴`);
                c.close();
            } else {
                toast((res && res.error) || `打开${name}失败`);
                setStatus(`打开${name}失败，请重试`);
            }
        } catch (e) {
            toast(`打开${name}失败：` + (e.message || e));
            setStatus(`打开${name}失败，请重试`);
        }
    }

    function stopTracks(c) {
        if (c && c.stream) {
            c.stream.getTracks().forEach(t => t.stop());
            c.stream = null;
        }
    }

    function cleanup() {
        const c = current;
        if (!c) return;
        c.stopped = true;
        clearTimeout(c.raf);
        if (c._animRaf) { cancelAnimationFrame(c._animRaf); c._animRaf = 0; }
        c._anim = null; c._to = null; c._from = null;
        if (c._ro) { c._ro.disconnect(); c._ro = null; }
        window.removeEventListener('resize', fitPreview);
        stopTracks(c);
        current = null;
        // 表单关闭且从未搜题：让主进程释放未显示的预热窗口，立即还内存
        if (window.electronAPI && window.electronAPI.solve && typeof window.electronAPI.solve.release === 'function') {
            window.electronAPI.solve.release().catch(() => {});
        }
    }

    window.AppSolve = { open };
})();
