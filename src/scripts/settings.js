// ============================================
// settings.js — 设置面板入口
// 拆分后的模块在 src/scripts/settings/ 目录下
// ============================================

(function () {
    const state = window.AppState;
    const { escapeHtml, toast } = window.AppUtils;
    const { showModal } = window.AppModal;
    const { saveSettings, saveSubjects, persistHomeworks } = window.AppStorage;
    const { applyStyling } = window.AppStyling;
    const { loadWeather, restartWeatherRefresh, searchCities, refilterAlerts } = window.AppWeather;
    const { setupBgRefresh, refreshBackground, restartBgRefresh } = window.AppBackground;
    const Renderer = window.Renderer;
    const api = window.electronAPI;
    const ArchiveView = window.ArchiveView;

    // 天气和背景共用的刷新频率选项
    const REFRESH_OPTIONS = [
        { value: 0, label: '不刷新' },
        { value: 5, label: '每 5 分钟' },
        { value: 10, label: '每 10 分钟' },
        { value: 30, label: '每 30 分钟' },
        { value: 60, label: '每小时' },
    ];

    // QQ IPC 监听清理函数的可变引用（通过对象传递给子模块）
    const qqCleanup = { current: null };

    // 为所有 role="radiogroup" 分段控件绑定左右方向键切换（radio 语义要求方向键移动并选中）
    function bindRadiogroupKeys(root) {
        root.querySelectorAll('[role="radiogroup"]').forEach(group => {
            group.addEventListener('keydown', (e) => {
                if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                const btns = Array.from(group.querySelectorAll('[role="radio"]'));
                if (!btns.length) return;
                const focused = btns.indexOf(document.activeElement);
                const current = focused >= 0 ? focused : Math.max(btns.findIndex(b => b.classList.contains('active')), 0);
                const delta = e.key === 'ArrowRight' ? 1 : -1;
                const target = btns[(current + delta + btns.length) % btns.length];
                e.preventDefault();
                target.focus();
                target.click(); // 复用既有 click 逻辑，联动保存/aria-checked
            });
        });
    }

    function openSettings() {
        const settings = state.settings;
        const qq = settings.qq;
        const eveningStr = settings.eveningSections.map(s => s.start + '-' + s.end).join(', ');

        const refreshHtml = REFRESH_OPTIONS.map(o =>
            `<option value="${o.value}" ${settings.bgRefreshInterval === o.value ? 'selected' : ''}>${o.label}</option>`
        ).join('');

        const bgSourceHtml = [
            { value: 'upx8', label: 'Upx8 风景' },
            { value: 'xxapi', label: 'XXAPI 4K 壁纸' },
            { value: 'ltyuanfang', label: '兔图苑 风景' },
        ].map(o =>
            `<option value="${o.value}" ${settings.bgSource === o.value ? 'selected' : ''}>${o.label}</option>`
        ).join('');

        const colsHtml = [
            { value: 2, label: '2 列（默认）' },
            { value: 3, label: '3 列（紧凑）' },
        ].map(o =>
            `<option value="${o.value}" ${settings.cardColumns === o.value ? 'selected' : ''}>${o.label}</option>`
        ).join('');

        // 组装上下文，传递给各面板模块
        const ctx = {
            state, settings, qq, api, Renderer, ArchiveView,
            saveSettings, saveSubjects, persistHomeworks,
            toast, escapeHtml, showModal, applyStyling,
            loadWeather, restartWeatherRefresh, searchCities, refilterAlerts,
            REFRESH_OPTIONS,
            setupBgRefresh, refreshBackground, restartBgRefresh,
            eveningStr, refreshHtml, bgSourceHtml, colsHtml,
            qqCleanup,
            openArchiveView: () => openArchiveView(),
        };

        const M = window.SettingsModules;
        const html = `
            <div class="settings-shell">
                <!-- 左侧导航 -->
                <nav class="settings-nav" id="settingsNav">
                    <button type="button" class="settings-nav-item active" data-panel="general">
                        <span class="nav-icon">${emoji('⚙️')}</span>
                        <span class="nav-label">常规设置</span>
                    </button>
                    <button type="button" class="settings-nav-item" data-panel="weather">
                        <span class="nav-icon">${emoji('🌤️')}</span>
                        <span class="nav-label">天气</span>
                    </button>
                    <button type="button" class="settings-nav-item" data-panel="personal">
                        <span class="nav-icon">${emoji('🎨')}</span>
                        <span class="nav-label">个性化</span>
                    </button>
                    <button type="button" class="settings-nav-item" data-panel="accessibility">
                        <span class="nav-icon">${emoji('👓')}</span>
                        <span class="nav-label">辅助功能</span>
                    </button>
                    <button type="button" class="settings-nav-item" data-panel="subjects">
                        <span class="nav-icon">${emoji('📚')}</span>
                        <span class="nav-label">学科管理</span>
                    </button>
                    <button type="button" class="settings-nav-item" data-panel="qq">
                        <span class="nav-icon">${emoji('📨')}</span>
                        <span class="nav-label">QQ监听</span>
                    </button>
                    <button type="button" class="settings-nav-item" data-panel="solve">
                        <span class="nav-icon"><img class="emoji" src="emoji/camera_color.svg" alt="📷"></span>
                        <span class="nav-label">拍照搜题</span>
                    </button>
                    <button type="button" class="settings-nav-item" data-panel="data">
                        <span class="nav-icon">${emoji('🗃️')}</span>
                        <span class="nav-label">数据管理</span>
                    </button>
                    <div class="settings-nav-spacer"></div>
                    <button type="button" class="settings-nav-item" data-panel="about">
                        <span class="nav-icon"><img class="emoji" src="icons/info.svg" alt="ℹ️"></span>
                        <span class="nav-label">关于</span>
                    </button>
                </nav>

                <!-- 右侧内容区 -->
                <div class="settings-content" id="settingsContent">
                    ${M.general.render(ctx)}
                    ${M.weather.render(ctx)}
                    ${M.personal.render(ctx)}
                    ${M.accessibility.render(ctx)}
                    ${M.subjects.render(ctx)}
                    ${M.qq.render(ctx)}
                    ${M.solve.render(ctx)}
                    ${M.data.render(ctx)}
                    ${M.about.render(ctx)}
                </div>
            </div>
        `;

        const disposers = [];
        const { close, dialog } = showModal(html, () => {
            // 关闭设置面板：先卸掉各面板返回的清理函数（如 solve 的实时摄像头预览），
            // 再卸掉 QQ IPC 监听，避免状态回调操作已移除的 DOM。
            for (const d of disposers) { try { d(); } catch (_) {} }
            if (qqCleanup.current) {
                try { qqCleanup.current(); } catch (_) {}
                qqCleanup.current = null;
            }
        });
        if (dialog) dialog.classList.add('wide', 'settings-dialog');

        // 导航切换
        M.nav(dialog);
        // 分段控件（radio 组）支持左右方向键
        bindRadiogroupKeys(dialog);

        // 各面板绑定
        M.general.bind(ctx);
        M.weather.bind(ctx);
        M.personal.bind(ctx);
        M.accessibility.bind(ctx);
        M.subjects.bind(ctx);
        M.qq.bind(ctx);
        const solveCleanup = M.solve.bind(ctx);
        if (solveCleanup) disposers.push(solveCleanup);
        M.data.bind(ctx);
        M.about.bind(ctx);

        // 自定义下拉：增强 dialog 内所有原生 <select>（含后续动态重建的，由内部 Observer 承接）；
        // 关闭设置时随 disposers 一起卸载并收掉弹层。
        if (window.AppSelect) {
            try { disposers.push(window.AppSelect.mount(dialog)); }
            catch (e) { console.error('[settings] 挂载自定义下拉失败:', e); }
        }
    }

    // 打开内嵌归档视图：设置关闭后独立打开的归档模态框
    function openArchiveView() {
        const html = `
            <div class="archive-view-shell">
                <!-- 顶栏：标题 + 月份显示 -->
                <div class="archive-top">
                    <div class="archive-title">已归档作业</div>
                    <div class="archive-month-display">--</div>
                </div>
                <!-- 卡片网格 -->
                <div class="archive-cards cards-grid" role="list"></div>
                <!-- 底栏：月份选择器 + 返回设置按钮 -->
                <div class="archive-bottom bottom-capsule-like">
                    <button class="dp-arrow archive-prev" aria-label="上个月">‹</button>
                    <button class="date-btn archive-date-btn" aria-label="选择月份">📅 <span class="archive-date-text">--</span></button>
                    <button class="dp-arrow archive-next" aria-label="下个月">›</button>
                    <button class="archive-back-btn" aria-label="返回设置">返回设置</button>
                </div>
            </div>
        `;
        const { dialog, close: closeArchive } = showModal(html, null, { replace: false });
        if (dialog) {
            dialog.classList.add('wide', 'archive-dialog');
            const disposeArchive = ArchiveView.mountArchiveView(dialog, () => {
                disposeArchive();
                closeArchive();
            });
        }
    }

    window.AppSettings = { openSettings, openArchiveView };
})();
