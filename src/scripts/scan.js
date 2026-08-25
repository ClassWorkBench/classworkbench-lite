// ============================================
// src/scripts/scan.js — 相机多页扫描（更多菜单入口）
// 弹出式表单：展台/摄像头预览 + 自动扫描，多页模式
// 每次抓拍缩成缩略图累积到侧边「文档条」，可连续拍摄/删除单张，
// 直到用户手动点「完成」→ 唤起置顶浮窗跨应用插入；或「保存为文件」
// 落盘到桌面「相机扫描/扫描_YYYYMMDD/」。
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
    // 滑动窗口稳定判定：最近 WINDOW_N 次采样中稳定帧数 >= WINDOW_K 即触发
    const WINDOW_N = 9;
    const WINDOW_K = 7;
    const MAX_EDGE = 1600;       // 出图最长边像素（控制体积）
    const RES_MAP = {
        '640':  { w: 640,  h: 480 },
        '720':  { w: 1280, h: 720 },
        '1080': { w: 1920, h: 1080 }
    };
    // 自动抓拍后需先检测到画面变化，再重新稳定，才允许拍摄下一页（避免同页连拍）
    const AWAIT_CHANGE_MS = 600; // 抓拍后给一次静置缓冲（毫秒）

    function getSolveSettings() {
        if (!state.settings.solve) {
            state.settings.solve = { cameraId: '', flip: false, rotation: 0, resolution: '720', autoScan: true, sensitivity: 2 };
        }
        return state.settings.solve;
    }

    function buildHtml(sol) {
        return `
            <div class="solve-head">
                <span class="solve-head-icon"><img class="emoji" src="emoji/camera_color.svg" alt="📷"></span>
                <div class="solve-head-text">
                    <div class="solve-title">相机扫描</div>
                    <div class="solve-sub">多页模式：拍一页缩成一张放到右侧，完成后再插入或保存</div>
                </div>
            </div>
            <div class="scan-stage">
                <div class="solve-preview" id="scanPreview">
                    <video id="scanVideo" autoplay playsinline muted></video>
                    <div class="solve-scan" id="scanScan" aria-hidden="true"><i class="solve-scan-line"></i></div>
                </div>
                <div class="scan-strip" id="scanStrip"></div>
            </div>
            <div class="solve-status" id="scanStatus">正在打开摄像头…</div>
            <div class="solve-opts">
                <label class="solve-opt"><input type="checkbox" id="scanAutoCb" ${sol.autoScan ? 'checked' : ''}> 自动扫描</label>
            </div>
            <div class="dialog-btn-row solve-btns">
                <button class="btn" id="scanCancelBtn" type="button">取消</button>
                <button class="btn" id="scanManualBtn" type="button">手动拍照</button>
                <button class="btn" id="scanSaveBtn" type="button">保存为文件</button>
                <button class="btn primary" id="scanDoneBtn" type="button">完成</button>
            </div>
        `;
    }

    function setStatus(text) {
        if (current && current.statusEl) current.statusEl.textContent = text;
    }

    async function open() {
        if (current) { toast('相机扫描已打开'); return; }
        const sol = getSolveSettings();
        let streamPromise;
        try {
            streamPromise = acquireStream(sol, sol.cameraId).catch((e) => ({ error: e }));
        } catch (e) {
            streamPromise = Promise.resolve({ error: e });
        }
        const { dialog, close } = showModal(buildHtml(sol), cleanup);
        dialog.classList.add('solve-dialog');

        current = {
            close,
            sol,
            video: dialog.querySelector('#scanVideo'),
            preview: dialog.querySelector('#scanPreview'),
            scan: dialog.querySelector('#scanScan'),
            strip: dialog.querySelector('#scanStrip'),
            statusEl: dialog.querySelector('#scanStatus'),
            manualBtn: dialog.querySelector('#scanManualBtn'),
            saveBtn: dialog.querySelector('#scanSaveBtn'),
            doneBtn: dialog.querySelector('#scanDoneBtn'),
            stream: null,
            raf: 0,
            pages: [],           // 已拍摄页面（dataURL，按顺序）
            phase: 'idle',
            motionCount: 0,
            stableCount: 0,
            lastSample: 0,
            bench: null,
            win: null,
            winStable: 0,
            awaitChange: false,  // 待画面变化后才允许下一次抓拍
            stopped: false
        };

        bindControls();
        await attachStream(current, await streamPromise);
    }

    function bindControls() {
        const c = current;
        c.manualBtn.addEventListener('click', () => capture('manual'));
        c.saveBtn.addEventListener('click', saveAsFiles);
        c.doneBtn.addEventListener('click', finish);
        const cancelBtn = document.getElementById('scanCancelBtn');
        cancelBtn.addEventListener('click', () => c.close());

        const autoCb = document.getElementById('scanAutoCb');
        autoCb.addEventListener('change', async () => {
            c.sol.autoScan = !!autoCb.checked;
            c.scan.classList.toggle('hidden', !c.sol.autoScan);
            resetScanState();
            updateScanStatus();
            if (c.sol.autoScan) rearm();
            await window.AppStorage.saveSettings();
        });
        c.scan.classList.toggle('hidden', !c.sol.autoScan);
    }

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
        c.video.style.transform = 'rotate(' + ((c.sol.rotation || 0) % 360) + 'deg) scaleX(' + (c.sol.flip ? -1 : 1) + ')';
        try { await c.video.play(); } catch (_) {}
        if (current !== c) { stopTracks(c); return; }
        setStatus('摄像头就绪，放入页面：稳定后自动拍摄，可连续多页');
        resetScanState();
        if (current !== c) return;
        setTimeout(rearm, 0);
        updateScanStatus();
    }

    function rearm() {
        const c = current;
        if (!c || c.stopped || !c.sol.autoScan) return;
        c.raf = setTimeout(scanLoop, SAMPLE_MS);
    }

    // ---- 帧差异：相邻帧灰度平均绝对差（带曝光/亮度漂移补偿） ----
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
        let sum = 0, n = 0, lum = 0;
        for (let i = 0; i < data.length; i += 16) {
            lum += (data[i] + data[i + 1] + data[i + 2]) / 3;
            if (c.bench && c.bench.px[i] !== undefined) sum += Math.abs(data[i] - c.bench.px[i]);
            n++;
        }
        lum /= n;
        let diff = n ? sum / n : 0;
        if (c.bench) {
            const drift = lum - c.bench.lum;
            diff = Math.max(0, diff - Math.abs(drift) * 0.5);
        }
        if (!c.bench) c.bench = {};
        c.bench.px = new Uint8ClampedArray(data);
        c.bench.lum = lum;
        return diff;
    }

    function resetScanState() {
        const c = current;
        if (!c) return;
        c.phase = 'idle';
        c.motionCount = 0;
        c.stableCount = 0;
        c.bench = null;
        c.win = null;
        c.winStable = 0;
    }

    function updateScanStatus() {
        const c = current;
        if (!c) return;
        if (c.pages.length) setStatus('已拍摄 ' + c.pages.length + ' 页，可继续拍或点「完成」');
        else if (!c.sol.autoScan) setStatus('手动模式：对准页面点「手动拍照」');
        else if (c.awaitChange) setStatus('已拍摄，换下一页时自动重拍…');
        else if (c.phase === 'motion') setStatus('检测到页面，正在对焦…');
        else if (c.phase === 'stable') setStatus('保持稳定，即将自动拍摄…');
        else setStatus('等待放入页面…（自动扫描中）');
    }

    function scanLoop() {
        const c = current;
        if (!c || c.stopped) return;
        if (!c.sol.autoScan) return;
        sampleFrame();
        c.raf = setTimeout(scanLoop, SAMPLE_MS);
    }

    function sampleFrame() {
        const c = current;
        if (!c || !c.video.videoWidth || !c.sol.autoScan) return;
        if (!c.bench) { computeDiff(c, c.video); return; }

        const d = computeDiff(c, c.video);
        const th = MOTION_TH[c.sol.sensitivity] || 12;

        // 待换页态：需先检测到明显运动，才解除，避免同页连拍
        if (c.awaitChange) {
            if (d > th) {
                c.awaitChange = false;
                resetScanState();
                updateScanStatus();
            }
            c.stableCount = 0;
            return;
        }

        let cat;
        if (d > th) {
            c.motionCount++;
            c.stableCount = 0;
            cat = 0;
            if (c.motionCount >= 2 || c.phase !== 'idle') c.phase = 'motion';
        } else {
            c.motionCount = 0;
            c.stableCount++;
            c.phase = 'stable';
            cat = 1;
        }

        c.win = c.win || [];
        c.win.push(cat);
        if (cat === 1) c.winStable++;
        while (c.win.length > WINDOW_N) {
            if (c.win.shift() === 1) c.winStable--;
        }
        if (c.winStable >= WINDOW_K) { capture('auto'); return; }
        updateScanStatus();
    }

    // ---- 抓拍：出图并累积到页面列表，不停止视频（可继续下一页） ----
    function capture(mode) {
        const c = current;
        if (!c || !c.video.videoWidth) { toast('画面尚未就绪'); return; }

        const vw = c.video.videoWidth;
        const vh = c.video.videoHeight;
        const scale = Math.min(1, MAX_EDGE / Math.max(vw, vh));
        const rawW = Math.round(vw * scale);
        const rawH = Math.round(vh * scale);
        const rot = (c.sol.rotation || 0) % 360;
        const swap = rot % 180 !== 0;
        const w = swap ? rawH : rawW;
        const h = swap ? rawW : rawH;
        const canvas = c._shotCanvas || (c._shotCanvas = document.createElement('canvas'));
        canvas.width = w;
        canvas.height = h;
        const g = canvas.getContext('2d');
        g.translate(w / 2, h / 2);
        g.rotate(rot * Math.PI / 180);
        g.scale(c.sol.flip ? -1 : 1, 1);
        g.drawImage(c.video, -rawW / 2, -rawH / 2, rawW, rawH);

        const data = canvas.toDataURL('image/png');
        c.pages.push(data);
        renderStrip();

        // 自动模式下：进入「待换页」状态（需先发生画面变化才允许下一张）
        if (mode === 'auto') {
            c.awaitChange = true;
            // 短暂静置缓冲，避免切换瞬间被误判为稳定
            setTimeout(() => { if (current === c) { c.awaitChange = false; } }, AWAIT_CHANGE_MS);
        } else {
            resetScanState();
        }
        updateScanStatus();
    }

    function renderStrip() {
        const c = current;
        if (!c) return;
        c.strip.innerHTML = c.pages.map((d, i) => `
            <div class="scan-strip-item" data-i="${i}">
                <img src="${d}" alt="第${i + 1}页">
                <button type="button" class="scan-strip-del" data-i="${i}" aria-label="删除第${i + 1}页">×</button>
                <span class="scan-strip-idx">${i + 1}</span>
            </div>
        `).join('');
        c.strip.querySelectorAll('.scan-strip-del').forEach((b) => {
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = Number(b.dataset.i);
                c.pages.splice(idx, 1);
                renderStrip();
                updateScanStatus();
            });
        });
    }

    // ---- 保存为文件：落盘桌面「相机扫描/扫描_YYYYMMDD/」 ----
    async function saveAsFiles() {
        const c = current;
        if (!c) return;
        if (!c.pages.length) { toast('还没有拍摄页面'); return; }
        if (!window.electronAPI.scan) { toast('当前环境不支持保存'); return; }
        toast('正在保存…');
        try {
            const res = await window.electronAPI.scan.save(c.pages);
            toast(res && res.ok ? '已保存 ' + res.saved.length + ' 张到 ' + res.dir : ((res && res.error) || '保存失败'));
        } catch (e) {
            toast('保存失败：' + (e.message || e));
        }
    }

    // ---- 完成：唤起置顶浮窗，跨应用插入 ----
    async function finish() {
        const c = current;
        if (!c) return;
        if (!c.pages.length) { toast('还没有拍摄页面'); return; }
        if (!window.electronAPI.scan) { toast('当前环境不支持浮窗插入'); return; }
        // 先把当前画面残留清掉
        stopTracks(c);
        try {
            const res = await window.electronAPI.scan.open(c.pages);
            if (res && res.ok) {
                toast('已唤起插入面板，切到目标输入框后点插入');
                c.close();
            } else {
                toast((res && res.error) || '打开插入面板失败');
            }
        } catch (e) {
            toast('打开插入面板失败：' + (e.message || e));
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
    }

    window.AppScan = { open };
})();