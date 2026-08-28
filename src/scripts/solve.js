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

    function buildHtml(sol) {
        return `
                    <div class="solve-head">
                        <span class="solve-head-icon"><img class="emoji" src="emoji/camera_color.svg" alt="📷"></span>
                        <div class="solve-head-text">
                            <div class="solve-title">拍照搜题</div>
                            <div class="solve-sub">拍一页或「继续拍下一页」，完成后选 AI 搜题</div>
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
                        <button class="btn primary" id="solveMoreBtn" type="button" hidden>继续拍下一页</button>
                        <button class="btn" id="solveRescanBtn" type="button" hidden>重新扫描本页</button>
                        <button class="btn primary" id="solveGoDoubao" type="button" hidden>去豆包搜题</button>
                        <button class="btn primary" id="solveGoDeepseek" type="button" hidden>去 DeepSeek 搜题</button>
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
            moreBtn: dialog.querySelector('#solveMoreBtn'),
            rescanBtn: dialog.querySelector('#solveRescanBtn'),
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

    // ---- 取景框精确适配 ----
    // 为什么不用 CSS 定死：弹窗内容（缩略图带出现/消失、按钮显隐）和窗口高度都动态变化，
    // CSS 魔数（固定比例/固定 vh）在极端窗口高度下要么撑出滚动条、要么把内容压扁。
    // 测量（仅显式 force 进入，两段式实测，不枚举兄弟元素——gap/隐藏项/边框陷阱太多）：
    //   1. 取景框临时归零（过渡禁用）→ 弹窗此刻的实际总高 = 其余内容的精确总高
    //   2. 限高 - 该值 = 可用高度，再按真实视频流比例求宽高
    // 非测量快速路径：ResizeObserver 回调只做纯计算（缓存余高 + 实时限高），
    // 物理切断「测量改布局 → RO 触发 → 再测量」的自激振荡（模糊关闭时弹窗不在合成层，必现疯狂抖动）。
    // 动画（丝滑的关键，实测 Chromium 行为）：
    //   - 同帧「禁过渡+设新值」在真实布局链路里不启动过渡 → 最终应用推迟到 rAF
    //   - 测量后同步恢复过渡能力，新目标值经 CSS 过渡从当前渲染位置自然重启 → 无缝
    //   - 目标未变时不触碰样式 → 不打断进行中的过渡
    // 记忆：真实视频比例存入设置，视频就绪前用记忆比例，打开瞬间不再 4:3→16:9 突跳
    function fitPreview(force) {
        const c = current;
        if (!c || !c.dialog || !c.preview) return;
        const dlg = c.dialog;
        const pv = c.preview;

        // 快速路径（非 force）：不测量，直接用「缓存余高 + 实时限高/宽度」算目标。
        // 窗口缩放会改 maxHeight/clientWidth（computeTarget 实时读）→ 快速路径也能正确适配。
        // 关键：全测量的「归零→回填」本身会让弹窗高度产生亚像素变化 → 触发 ResizeObserver →
        // 若 RO 回调再走全测量就形成自激振荡（表现为弹窗疯狂抖动，且模糊关闭时弹窗
        // 不在合成层、亚像素通知不再被吸收，回路必然点燃）。因此测量只允许显式 force 进入。
        if (!force && c._restH) {
            const quick = computeTarget(c, c._restH);
            applyTarget(c, quick);
            return;
        }

        // 完整测量（仅显式 force：renderPages / resize / animationend / 首次）：
        // 禁过渡 + 归零 + 同步读高（读取 offsetHeight 触发 reflow，拿到确定性数值）。
        // 副作用控制（关键！曾因此出「打开即冻结在小尺寸」的 bug）：
        //   - 归零必须禁过渡，否则坍缩过程被动画化、测到垃圾值
        //   - 测完恢复「原样式值」而不是渲染中间值 cur——把 cur 写进 style 后若 applyTarget
        //     因目标未变早退（合法，不打断过渡），style 就永远停在过渡中间帧、
        //     .fitting(transition:none) 也永远残留 → 之后所有过渡死亡、尺寸冻死
        //   - .fitting 同步移除：配合 applyTarget 下一帧 rAF 设新值，可靠触发贝塞尔过渡
        const prevW = pv.style.width;
        const prevH = pv.style.height;
        pv.classList.add('fitting');
        pv.style.width = '0px';
        pv.style.height = '0px';
        const restH = dlg.offsetHeight;   // border-box 口径，与 max-height 同口径
        c._restH = restH;                 // 缓存：此后所有非 force 调用复用（内容变化由 renderPages 强制刷新）
        pv.style.width = prevW;           // 恢复原样式值（布局回到测量前状态）
        pv.style.height = prevH;
        pv.offsetWidth;
        pv.classList.remove('fitting');   // 同步恢复过渡能力

        applyTarget(c, computeTarget(c, restH));
        // 记忆真实摄像头比例（未旋转的原始值），供下次打开在视频就绪前直接使用
        if (c.video.videoWidth && c.video.videoHeight) {
            const base = c.video.videoWidth / c.video.videoHeight;
            if (Math.abs((c.sol.previewAR || 0) - base) > 0.01) {
                c.sol.previewAR = +base.toFixed(4);
                window.AppStorage.saveSettings().catch(() => {});
            }
        }
    }

    // 应用目标尺寸：_fitW/_fitH 同步更新（快速路径的比较立即生效，不等动画回调），
    // 实际样式推迟到 rAF——同帧「设新值」在测量刚恢复过渡的链路里不启动过渡，
    // 推迟一帧则可靠触发贝塞尔过渡（CSS 原生从当前渲染位置平滑过渡到新目标）
    function applyTarget(c, t) {
        const pv = c.preview;
        if (t.w === c._fitW && t.h === c._fitH) return;   // 目标未变：不触碰样式、不打断进行中的过渡
        c._fitW = t.w; c._fitH = t.h;
        c._pendT = t;   // 多次调用竞态：只应用最后一次
        requestAnimationFrame(() => {
            if (current !== c || !c.preview) return;
            if (c._pendT !== t) return;    // 已有更新的目标，让位
            c._pendT = null;
            pv.classList.remove('fitting');   // 兜底：确保过渡能力已恢复（正常在测量尾部已同步移除）
            pv.style.width = t.w + 'px';
            pv.style.height = t.h + 'px';
            pv.style.aspectRatio = 'auto';    // 接管基类 4:3，按显式宽高渲染
        });
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
        // 弹窗入场动画只改 transform（不触发 ResizeObserver），但 transform 缩放会让
        // getBoundingClientRect 测量失真 → 动画结束后用真实布局再校准一次
        c.dialog.addEventListener('animationend', fitPreview, { once: true });
        window.addEventListener('resize', fitPreview);
        requestAnimationFrame(fitPreview);
    }

    function bindControls() {
        const c = current;
        c.manualBtn.addEventListener('click', () => capture('manual'));
        c.moreBtn.addEventListener('click', nextPage);
        c.rescanBtn.addEventListener('click', rescan);
        c.goDoubao.addEventListener('click', () => goto('doubao'));
        c.goDeepseek.addEventListener('click', () => goto('deepseek'));
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
        if (c.shotData) { setStatus('已拍摄 ✓ 可重新扫描或去豆包搜题'); return; }
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
        c.rescanBtn.hidden = false;
        c.moreBtn.hidden = false;
        c.goDoubao.hidden = false;
        c.goDeepseek.hidden = false;
        const total = c.pages.length + 1;
        setStatus(`已拍摄第 ${total} 页 ✓ 可「继续拍下一页」累积，完成后选一个服务搜题`);
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
        c.rescanBtn.hidden = true;
        c.moreBtn.hidden = true;
        c.goDoubao.hidden = true;
        c.goDeepseek.hidden = true;
        clearTimeout(c.raf);
        resetScanState();
        if (c.sol.autoScan) c.raf = setTimeout(scanLoop, SAMPLE_MS);
    }

    // 渲染横向平铺预览带：已定稿页 + 当前刚拍页（末位高亮 + 滑入 + 滚到最新）
    function renderPages() {
        const c = current;
        if (!c || !c.pagesEl) return;
        c.pagesEl.innerHTML = '';
        c.pages.forEach((src, i) => {
            c.pagesEl.appendChild(buildPageItem(src, i + 1, false));
        });
        if (c.shotData) {
            c.pagesEl.appendChild(buildPageItem(c.shotData, c.pages.length + 1, true));
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
        item.innerHTML = `<span class="scan-strip-idx">${idx}</span><img src="${src}" alt="第${idx}页">`;
        return item;
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
