// ============================================
// src/scripts/scan.js — 相机多页扫描（更多菜单入口）
// 弹出式表单：展台/摄像头预览 + 倒计时自动连拍，多页模式
// 勾选「自动扫描」后：每拍完一页自动进入下一轮倒计时
// （黑底 + 大号粗体数字倒数），倒数完自动拍摄下一页；秒数可轮询切换。
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

    // 倒计时秒数（无运动检测，改用固定延时自动连拍）
    const DELAYS = [3, 5, 10];     // 可轮询切换的倒计时档位
    const REST_PREVIEW_MS = 1200;  // 每张之间的清晰预览时长：拍完先短暂看画面，再进入下一轮倒计时
    const MAX_EDGE = 1600;         // 出图最长边像素（控制体积）
    const RES_MAP = {
        '640':  { w: 640,  h: 480 },
        '720':  { w: 1280, h: 720 },
        '1080': { w: 1920, h: 1080 }
    };

    function getSolveSettings() {
        if (!state.settings.solve) {
            state.settings.solve = { cameraId: '', flip: false, rotation: 0, autoScan: true, sensitivity: 2, delaySec: 5 };
        }
        return state.settings.solve;
    }

    function buildHtml(sol) {
        return `
            <div class="solve-head">
                <span class="solve-head-icon"><img class="emoji" src="emoji/camera_color.svg" alt="📷"></span>
                <div class="solve-head-text">
                    <div class="solve-title">相机扫描</div>
                    <div class="solve-sub">多页模式：倒计时自动连拍，完成后插入或保存</div>
                </div>
            </div>
            <div class="scan-stage">
                <div class="solve-preview" id="scanPreview">
                    <video id="scanVideo" autoplay playsinline muted></video>
                    <div class="scan-countdown" id="scanCountdown" aria-hidden="true" hidden>
                        <span class="scan-countdown-num" id="scanCountdownNum">5</span>
                    </div>
                </div>
                <div class="scan-strip" id="scanStrip"></div>
            </div>
            <div class="solve-status" id="scanStatus">正在打开摄像头…</div>
            <div class="solve-opts">
                <label class="solve-opt"><input type="checkbox" id="scanAutoCb" ${sol.autoScan ? 'checked' : ''}> 自动扫描</label>
                <button class="scan-delay-btn" id="scanDelayBtn" type="button">${(sol.delaySec || 5)}秒</button>
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
            countdownEl: dialog.querySelector('#scanCountdown'),
            countdownNum: dialog.querySelector('#scanCountdownNum'),
            strip: dialog.querySelector('#scanStrip'),
            statusEl: dialog.querySelector('#scanStatus'),
            manualBtn: dialog.querySelector('#scanManualBtn'),
            saveBtn: dialog.querySelector('#scanSaveBtn'),
            doneBtn: dialog.querySelector('#scanDoneBtn'),
            stream: null,
            pages: [],           // 已拍摄页面（dataURL，按顺序）
            delayBtn: null,
            countTimer: 0,       // 倒计时 setTimeout 句柄
            countdown: 0,        // 当前剩余秒数
            counting: false,     // 是否处于倒计时状态
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

        // 秒数轮询切换：3 → 5 → 10 → 3 …
        c.delayBtn = document.getElementById('scanDelayBtn');
        c.delayBtn.addEventListener('click', async () => {
            const idx = DELAYS.indexOf(c.sol.delaySec || 5);
            c.sol.delaySec = DELAYS[(idx + 1) % DELAYS.length];
            c.delayBtn.textContent = c.sol.delaySec + '秒';
            await window.AppStorage.saveSettings();
            // 本轮仍在倒计时时改用新秒数重开，反馈即时
            if (c.counting) rearm();
        });

        const autoCb = document.getElementById('scanAutoCb');
        autoCb.addEventListener('change', async () => {
            c.sol.autoScan = !!autoCb.checked;
            resetCountdown();
            updateScanStatus();
            if (c.sol.autoScan) rearm();   // 从关→开时启动倒计时
            await window.AppStorage.saveSettings();
        });
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
        setStatus('摄像头就绪，放好页面后自动倒计时拍摄，可连续多页');
        if (current !== c) return;
        setTimeout(rearm, 0);
        updateScanStatus();
    }

    // ---- 倒计时：黑底 + 大号粗体数字，每档 N 秒后自动拍摄 ----
    function showCountdown() {
        const c = current;
        if (!c) return;
        c.countdownEl.hidden = false;
    }

    function setCountdownNum(n) {
        const c = current;
        if (c && c.countdownNum) c.countdownNum.textContent = n;
    }

    function hideCountdown() {
        const c = current;
        if (c && c.countdownEl) c.countdownEl.hidden = true;
    }

    /** 重置倒计时状态，恢复清晰预览 */
    function resetCountdown() {
        const c = current;
        if (!c) return;
        clearTimeout(c.countTimer);
        c.countTimer = 0;
        c.counting = false;
        c.countdown = 0;
        hideCountdown();
    }

    /** 拍完先短暂恢复清晰预览给换页留喘息，随后自动进入下一轮倒计时 */
    function previewBreak(ms) {
        const c = current;
        if (!c || c.stopped) return;
        clearTimeout(c.countTimer);
        resetCountdown();
        setStatus(`已拍摄 ${c.pages.length} 页，稍后自动倒计时…`);
        c.countTimer = setTimeout(() => {
            if (current === c) rearm();
        }, ms);
    }

    /** 启动一轮倒计时（自动扫描开启时） */
    function rearm() {
        const c = current;
        if (!c || c.stopped || !c.sol.autoScan) return;
        clearTimeout(c.countTimer);
        c.counting = true;
        c.countdown = c.sol.delaySec || 5;
        showCountdown();
        setCountdownNum(c.countdown);
        updateScanStatus();
        c.countTimer = setTimeout(countStep, 1000);
    }

    // 每秒推进，数到 0 自动拍摄
    function countStep() {
        const c = current;
        if (!c || c.stopped) return;
        if (c.countdown <= 1) { capture('auto'); return; }
        c.countdown--;
        setCountdownNum(c.countdown);
        updateScanStatus();
        c.countTimer = setTimeout(countStep, 1000);
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

        // 自动模式：拍完先短暂清晰预览，再自动进入下一轮倒计时（间隔自然防同页连拍）
        if (mode === 'auto') {
            previewBreak(REST_PREVIEW_MS);
        } else {
            // 手动模式：恢复清晰预览，等用户再次点击
            resetCountdown();
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

    function updateScanStatus() {
        const c = current;
        if (!c) return;
        if (!c.sol.autoScan) { setStatus('手动模式：对准页面点「手动拍照」'); return; }
        if (c.counting) setStatus(`倒计时 ${c.countdown} 秒后自动拍摄…`);
        else if (c.pages.length) setStatus(`已拍摄 ${c.pages.length} 页，放好下一页后自动拍摄…`);
        else setStatus('放好页面后自动倒计时拍摄…');
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
        // 先把当前倒计时/残留清掉，避免切走后背后仍在拍摄
        resetCountdown();
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
        clearTimeout(c.countTimer);
        stopTracks(c);
        current = null;
    }

    window.AppScan = { open };
})();