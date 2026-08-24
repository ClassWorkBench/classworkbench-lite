// ============================================
// settings/solve.js — 拍照搜题面板
// 摄像头选择 + 镜像翻转 + 扫描仪自动抓拍
// ============================================

window.SettingsModules = window.SettingsModules || {};

window.SettingsModules.solve = {
    render(ctx) {
        const { settings } = ctx;
        const sol = settings.solve || {};
        return `
                    <!-- 面板：拍照搜题 -->
                    <div class="settings-panel" id="panel-solve">
                        <div class="panel-header">
                            <h3>拍照搜题</h3>
                            <p class="panel-desc">展台 / 摄像头自动扫描题目，图片粘贴到豆包或 DeepSeek 网页版搜索（半自动）</p>
                        </div>
                        <div class="panel-body">
                            <div class="setting-group">
                                <label for="solveCameraSelect">摄像头（希沃展台等）</label>
                                <div class="setting-row">
                                    <select id="solveCameraSelect" class="input-flex" aria-label="选择摄像头">
                                        <option value="">正在扫描摄像头…</option>
                                    </select>
                                    <button class="btn" id="solveCameraRefresh" type="button" aria-label="刷新摄像头列表">刷新</button>
                                </div>
                                <small>若列表为空，请先在「更多 → 拍照搜题」中授权一次摄像头。</small>
                            </div>
                            <div class="setting-group">
                                <label>画面方向（展台旋转 / 镜像）</label>
                                <div class="orient-row">
                                    <div class="orient-preview" id="solveOrientPreview">
                                        <video id="solveLiveVideo" autoplay playsinline muted></video>
                                    </div>
                                    <div class="orient-controls">
                                        <div class="segmented" id="solveOrientSeg" role="radiogroup" aria-label="画面旋转角度">
                                            <button type="button" class="seg-btn ${((sol.rotation || 0) % 360) === 0 ? 'active' : ''}" data-rot="0" role="radio" aria-checked="${((sol.rotation || 0) % 360) === 0}">0°</button>
                                            <button type="button" class="seg-btn ${((sol.rotation || 0) % 360) === 90 ? 'active' : ''}" data-rot="90" role="radio" aria-checked="${((sol.rotation || 0) % 360) === 90}">90°</button>
                                            <button type="button" class="seg-btn ${((sol.rotation || 0) % 360) === 180 ? 'active' : ''}" data-rot="180" role="radio" aria-checked="${((sol.rotation || 0) % 360) === 180}">180°</button>
                                            <button type="button" class="seg-btn ${((sol.rotation || 0) % 360) === 270 ? 'active' : ''}" data-rot="270" role="radio" aria-checked="${((sol.rotation || 0) % 360) === 270}">270°</button>
                                        </div>
                                        <div class="toggle-row">
                                            <div class="toggle-row-text">
                                                <span class="toggle-row-title">水平镜像</span>
                                                <span class="toggle-row-desc">左右颠倒时开启</span>
                                            </div>
                                            <label class="setting-toggle">
                                                <input type="checkbox" id="solveMirrorToggle" ${sol.flip ? 'checked' : ''} aria-label="水平镜像">
                                                <span class="toggle-slider"></span>
                                            </label>
                                        </div>
                                        <small class="orient-tip">实时摄像头已在左侧，旋转 / 镜像即时生效（进入本页自动开启）。</small>
                                    </div>
                                </div>
                            </div>
                            <div class="setting-group">
                                <label>自动抓拍</label>
                                <div class="toggle-row">
                                    <div class="toggle-row-text">
                                        <span class="toggle-row-title">扫描仪式</span>
                                        <span class="toggle-row-desc">把题目放到镜头前、画面稳定后自动拍照，无需按键</span>
                                    </div>
                                    <label class="setting-toggle">
                                        <input type="checkbox" id="solveAutoScanToggle" ${sol.autoScan ? 'checked' : ''} aria-label="扫描仪式自动抓拍">
                                        <span class="toggle-slider"></span>
                                    </label>
                                </div>
                            </div>
                            <div class="setting-group" id="solveSensitivityGroup">
                                <label>抓拍灵敏度</label>
                                <div class="segmented" id="solveSensitivitySeg" role="radiogroup" aria-label="抓拍灵敏度">
                                    <button type="button" class="seg-btn ${sol.sensitivity === 1 ? 'active' : ''}" data-sens="1" role="radio" aria-checked="${sol.sensitivity === 1}">低</button>
                                    <button type="button" class="seg-btn ${sol.sensitivity === 2 ? 'active' : ''}" data-sens="2" role="radio" aria-checked="${sol.sensitivity === 2}">中</button>
                                    <button type="button" class="seg-btn ${sol.sensitivity === 3 ? 'active' : ''}" data-sens="3" role="radio" aria-checked="${sol.sensitivity === 3}">高</button>
                                </div>
                                <small>低：画面需完全静止才拍；高：稍有动静也会触发。</small>
                            </div>
                            <div class="setting-group">
                                <label>摄像头清晰度</label>
                                <div class="segmented" id="solveResolutionSeg" role="radiogroup" aria-label="摄像头清晰度">
                                    <button type="button" class="seg-btn ${sol.resolution === '640' ? 'active' : ''}" data-res="640" role="radio" aria-checked="${sol.resolution === '640'}">流畅</button>
                                    <button type="button" class="seg-btn ${(sol.resolution || '720') === '720' ? 'active' : ''}" data-res="720" role="radio" aria-checked="${(sol.resolution || '720') === '720'}">标准</button>
                                    <button type="button" class="seg-btn ${sol.resolution === '1080' ? 'active' : ''}" data-res="1080" role="radio" aria-checked="${sol.resolution === '1080'}">高清</button>
                                </div>
                                <small>流畅/标准启动最快；高清画面最细但冷启动较慢，展台拍题建议用标准。</small>
                            </div>
                            <div class="setting-group">
                                <label>启动优化</label>
                                <div class="toggle-row">
                                    <div class="toggle-row-text">
                                        <span class="toggle-row-title">启动时预加载搜题页面</span>
                                        <span class="toggle-row-desc">应用启动后后台预加载上次使用的搜题页面（默认关闭，省内存）</span>
                                    </div>
                                    <label class="setting-toggle">
                                        <input type="checkbox" id="solvePrewarmToggle" ${sol.prewarm === true ? 'checked' : ''} aria-label="启动时预加载搜题页面">
                                        <span class="toggle-slider"></span>
                                    </label>
                                </div>
                            </div>
                            <div class="setting-group">
                                <button class="btn primary" id="solveOpenBtn" type="button">打开拍照搜题</button>
                                <small>在底栏「更多」菜单中也有「拍照搜题」入口。</small>
                            </div>
                        </div>
                    </div>
        `;
    },

    bind(ctx) {
        const { settings, saveSettings, toast } = ctx;
        const sol = settings.solve || (settings.solve = {});
        const api = window.electronAPI;

        async function refreshCameraList(select) {
            if (!select) return;
            select.innerHTML = '<option value="">正在扫描摄像头…</option>';
            let devices = [];
            try {
                if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
                    devices = (await navigator.mediaDevices.enumerateDevices())
                        .filter(d => d.kind === 'videoinput');
                }
            } catch (e) {
                toast('读取摄像头列表失败');
            }
            if (!devices.length) {
                select.innerHTML = '<option value="">未找到摄像头（请先授权）</option>';
                return;
            }
            select.innerHTML = devices.map(d =>
                `<option value="${escapeHtml(d.deviceId)}" ${sol.cameraId === d.deviceId ? 'selected' : ''}>${escapeHtml(d.label || '摄像头 ' + (devices.indexOf(d) + 1))}</option>`
            ).join('');
            if (!devices.some(d => d.deviceId === sol.cameraId)) {
                sol.cameraId = devices[0].deviceId;
                await saveSettings();
            }
        }

        const select = document.getElementById('solveCameraSelect');
        const refreshBtn = document.getElementById('solveCameraRefresh');
        if (select) refreshCameraList(select);
        if (refreshBtn && select) {
            refreshBtn.addEventListener('click', () => refreshCameraList(select));
        }

        // —— 画面方向：旋转 + 镜像（左侧实时摄像头即时反映）——
        const liveVideo = document.getElementById('solveLiveVideo');
        const orientPreview = document.getElementById('solveOrientPreview');
        function updateLiveTransform() {
            if (!liveVideo) return;
            // 与拍摄端同一规则：先镜像(scaleX) 再旋转，所见即所得
            liveVideo.style.transform = 'rotate(' + ((sol.rotation || 0) % 360) + 'deg) scaleX(' + (sol.flip ? -1 : 1) + ')';
        }
        const orientSeg = document.getElementById('solveOrientSeg');
        if (orientSeg) {
            orientSeg.addEventListener('click', async (e) => {
                const btn = e.target.closest('.seg-btn');
                if (!btn) return;
                const rot = Number(btn.dataset.rot);
                if (rot === (sol.rotation || 0)) return;
                sol.rotation = rot;
                orientSeg.querySelectorAll('.seg-btn').forEach((b) => {
                    const active = Number(b.dataset.rot) === rot;
                    b.classList.toggle('active', active);
                    b.setAttribute('aria-checked', active ? 'true' : 'false');
                });
                updateLiveTransform();
                await saveSettings();
            });
        }
        const mirrorToggle = document.getElementById('solveMirrorToggle');
        if (mirrorToggle) {
            mirrorToggle.addEventListener('change', async () => {
                sol.flip = !!mirrorToggle.checked;
                updateLiveTransform();
                await saveSettings();
            });
        }

        // —— 实时摄像头预览：进入本面板自动开启，关闭设置时释放 ——
        let stream = null;
        let started = false;
        let starting = false;
        const panel = document.getElementById('panel-solve');

        async function startPreview() {
            if (started || starting) return;
            starting = true;
            if (orientPreview) orientPreview.classList.add('is-loading');
            try {
                let devices = [];
                try {
                    devices = (await navigator.mediaDevices.enumerateDevices())
                        .filter(d => d.kind === 'videoinput');
                } catch (_) {}
                if (!devices.length) {
                    toast('未找到摄像头，请先在「拍照搜题」中授权');
                    return;
                }
                // 先按首选设备；失败再退化为系统默认设备，提升稳定性
                const tryConst = (exact) => ({
                    video: {
                        width: { ideal: 640, max: 1280 },
                        height: { ideal: 360, max: 720 },
                        frameRate: { ideal: 15 },
                        ...(exact ? { deviceId: { exact } } : {})
                    },
                    audio: false
                });
                let s;
                try {
                    s = await navigator.mediaDevices.getUserMedia(tryConst(sol.cameraId));
                } catch (_) {
                    s = await navigator.mediaDevices.getUserMedia(tryConst(null));
                }
                started = true;
                starting = false;
                stream = s;
                liveVideo.srcObject = s;
                if (orientPreview) orientPreview.classList.remove('is-loading');
                updateLiveTransform();
                await liveVideo.play().catch(() => {});
            } catch (e) {
                starting = false;
                if (orientPreview) orientPreview.classList.remove('is-loading');
                console.error('设置面板摄像头预览启动失败:', e);
                toast('实时预览不可用，请先关闭「拍照搜题」再试');
            }
        }
        function stopPreview() {
            if (stream) {
                stream.getTracks().forEach(t => t.stop());
                stream = null;
            }
            started = false;
            starting = false;
            if (liveVideo) liveVideo.srcObject = null;
        }
        function restartPreview() {
            stopPreview();
            startPreview();
        }
        if (select) {
            select.addEventListener('change', async () => {
                sol.cameraId = select.value;
                await saveSettings();
                if (started) restartPreview(); // 切换摄像头后重连预览
            });
        }
        // 面板切换为活动时开启预览
        let previewObs = null;
        const ensureOnActive = () => {
            if (panel && !panel.classList.contains('active')) return;
            startPreview();
        };
        if (panel) {
            previewObs = new MutationObserver(ensureOnActive);
            previewObs.observe(panel, { attributes: true, attributeFilter: ['class'] });
            ensureOnActive();
        }

        const autoToggle = document.getElementById('solveAutoScanToggle');
        const sensGroup = document.getElementById('solveSensitivityGroup');
        if (autoToggle) {
            autoToggle.addEventListener('change', async () => {
                sol.autoScan = !!autoToggle.checked;
                if (sensGroup) sensGroup.style.opacity = sol.autoScan ? '' : '0.5';
                await saveSettings();
            });
            if (sensGroup) sensGroup.style.opacity = sol.autoScan ? '' : '0.5';
        }

        const sensSeg = document.getElementById('solveSensitivitySeg');
        if (sensSeg) {
            sensSeg.addEventListener('click', async (e) => {
                const btn = e.target.closest('.seg-btn');
                if (!btn) return;
                const sens = Number(btn.dataset.sens);
                if (sens === sol.sensitivity) return;
                sol.sensitivity = sens;
                sensSeg.querySelectorAll('.seg-btn').forEach(b => {
                    const active = Number(b.dataset.sens) === sens;
                    b.classList.toggle('active', active);
                    b.setAttribute('aria-checked', active ? 'true' : 'false');
                });
                await saveSettings();
            });
        }

        const resSeg = document.getElementById('solveResolutionSeg');
        if (resSeg) {
            resSeg.addEventListener('click', async (e) => {
                const btn = e.target.closest('.seg-btn');
                if (!btn) return;
                const res = btn.dataset.res;
                if (res === sol.resolution) return;
                sol.resolution = res;
                resSeg.querySelectorAll('.seg-btn').forEach(b => {
                    const active = b.dataset.res === res;
                    b.classList.toggle('active', active);
                    b.setAttribute('aria-checked', active ? 'true' : 'false');
                });
                await saveSettings();
            });
        }

        const prewarmToggle = document.getElementById('solvePrewarmToggle');
        if (prewarmToggle) {
            prewarmToggle.addEventListener('change', async () => {
                sol.prewarm = !!prewarmToggle.checked;
                await saveSettings();
                if (sol.prewarm && api && typeof api.solve.warmup === 'function') {
                    api.solve.warmup().catch(() => {});
                }
            });
        }

        const openBtn = document.getElementById('solveOpenBtn');
        if (openBtn) {
            openBtn.addEventListener('click', () => {
                if (window.AppSolve && typeof window.AppSolve.open === 'function') {
                    window.AppSolve.open();
                } else {
                    toast('拍照搜题模块未加载');
                }
            });
        }

        // 面板卸载 / 设置关闭时释放摄像头预览资源
        return () => {
            if (previewObs) previewObs.disconnect();
            stopPreview();
        };
    }
};
