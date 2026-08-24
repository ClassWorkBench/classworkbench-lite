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
                            <div class="solve-sub">展台自动扫描 → 粘贴到 AI 搜题（半自动）</div>
                        </div>
                    </div>
                    <div class="solve-preview" id="solvePreview">
                        <video id="solveVideo" autoplay playsinline muted></video>
                        <div class="solve-scan" id="solveScan" aria-hidden="true"><i class="solve-scan-line"></i></div>
                        <img class="solve-shot" id="solveShot" alt="拍摄结果" hidden>
                    </div>
                    <div class="solve-status" id="solveStatus">正在打开摄像头…</div>
                    <div class="solve-opts">
                        <label class="solve-opt"><input type="checkbox" id="solveAutoCb" ${sol.autoScan ? 'checked' : ''}> 自动扫描</label>
                    </div>
                    <div class="dialog-btn-row solve-btns">
                        <button class="btn" id="solveCancelBtn" type="button">取消</button>
                        <button class="btn" id="solveManualBtn" type="button">手动拍照</button>
                        <button class="btn" id="solveRescanBtn" type="button" hidden>重新扫描</button>
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
            video: dialog.querySelector('#solveVideo'),
            preview: dialog.querySelector('#solvePreview'),
            scan: dialog.querySelector('#solveScan'),
            shot: dialog.querySelector('#solveShot'),
            statusEl: dialog.querySelector('#solveStatus'),
            manualBtn: dialog.querySelector('#solveManualBtn'),
            rescanBtn: dialog.querySelector('#solveRescanBtn'),
            goDoubao: dialog.querySelector('#solveGoDoubao'),
            goDeepseek: dialog.querySelector('#solveGoDeepseek'),
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
        await attachStream(current, await streamPromise);
    }

    function bindControls() {
        const c = current;
        c.manualBtn.addEventListener('click', () => capture('manual'));
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
        c.goDoubao.hidden = false;
        c.goDeepseek.hidden = false;
        setStatus('已拍摄 ✓ 确认无误后选一个服务搜题');
    }

    function rescan() {
        const c = current;
        if (!c) return;
        c.shot.hidden = true;
        c.video.style.display = '';
        c.scan.classList.toggle('hidden', !c.sol.autoScan);
        c.manualBtn.hidden = false;
        c.rescanBtn.hidden = true;
        c.goDoubao.hidden = true;
        c.goDeepseek.hidden = true;
        resetScanState();
        c.raf = setTimeout(scanLoop, SAMPLE_MS);
        updateScanStatus();
    }

    // ---- 半自动：去 AI 服务搜题 ----
    async function goto(provider) {
        const c = current;
        if (!c || !c.shotData) return;
        if (!window.electronAPI || typeof window.electronAPI.solve !== 'object' || typeof window.electronAPI.solve.open !== 'function') {
            toast('当前环境不支持内嵌 AI 搜题');
            return;
        }
        const name = provider === 'deepseek' ? 'DeepSeek' : '豆包';
        setStatus(`正在打开 ${name} 并粘贴图片…`);
        try {
            const res = await window.electronAPI.solve.open({ image: c.shotData, provider });
            if (res && res.ok) {
                toast(res.pasted ? `图片已粘贴到${name}，请点击发送` : `${name}已打开，请点击输入框后按 Ctrl+V 粘贴`);
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
        stopTracks(c);
        current = null;
        // 表单关闭且从未搜题：让主进程释放未显示的预热窗口，立即还内存
        if (window.electronAPI && window.electronAPI.solve && typeof window.electronAPI.solve.release === 'function') {
            window.electronAPI.solve.release().catch(() => {});
        }
    }

    window.AppSolve = { open };
})();
