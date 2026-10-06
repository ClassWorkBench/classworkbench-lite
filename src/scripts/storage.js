// ============================================
// storage.js
// 数据加载与持久化 —— 通过 IPC 调用主进程的 electron-store
// ============================================

(function () {
    const { DEFAULT_SUBJECTS } = window.AppConfig;
    const { isBlankHomeworkInput } = window.AppUtils;
    const state = window.AppState;
    const { toast } = window.AppUtils;
    const api = window.electronAPI;

    // 是否首次安装（loadAll 后有效）：磁盘上无 settings 记录
    let isFreshInstall = false;

    async function loadAll() {
        try {
            const data = await api.loadData();
            // 全新安装检测：磁盘上没有任何 settings 记录 → 首次使用，走完整设置向导；
            // 老用户（有 settings 但没走过向导）只弹协议确认。供向导（wizard.js）判断。
            isFreshInstall = (data.settings == null);
            state.homeworks = data.homeworks || [];
            if (data.settings) Object.assign(state.settings, data.settings);
            state.subjectList = data.subjects || [...DEFAULT_SUBJECTS];
            if (state.subjectList.length === 0) state.subjectList = [...DEFAULT_SUBJECTS];
            state.subjectList.forEach(s => { if (!s.color) s.color = '#5b6abf'; });
            if (!state.settings.weatherProvider) state.settings.weatherProvider = 'openmeteo';
            if (state.settings.weatherRefreshInterval === undefined) state.settings.weatherRefreshInterval = 30;
            if (!state.settings.weatherRefreshMode) state.settings.weatherRefreshMode = 'always';
            if (state.settings.qweatherApiHost === undefined) state.settings.qweatherApiHost = '';
            if (state.settings.qweatherApiKey === undefined) state.settings.qweatherApiKey = '';
            // 和风 JWT 认证字段兜底（v1.x 迁移新增）
            if (state.settings.qweatherKid === undefined) state.settings.qweatherKid = '';
            if (state.settings.qweatherSub === undefined) state.settings.qweatherSub = '';
            if (state.settings.qweatherPrivateKey === undefined) state.settings.qweatherPrivateKey = '';
            // 旧版 weatherCities → openmeteoCities / qweatherCities 迁移
            if (Array.isArray(state.settings.weatherCities) && state.settings.weatherCities.length > 0) {
                var om = [];
                var qw = [];
                state.settings.weatherCities.forEach(function (c) {
                    if (c.provider === 'qweather') {
                        qw.push({ id: c.id, name: c.name, locationId: c.locationId || c.id.replace('qw_',''), country: c.country || '', admin1: c.admin1 || '', timezone: c.timezone || 'auto' });
                    } else {
                        om.push({ id: c.id, name: c.name, lat: c.lat, lon: c.lon, country: c.country || '', admin1: c.admin1 || '', timezone: c.timezone || 'auto' });
                    }
                });
                if (om.length > 0) state.settings.openmeteoCities = om;
                if (qw.length > 0) state.settings.qweatherCities = qw;
            }
            if (!Array.isArray(state.settings.openmeteoCities)) state.settings.openmeteoCities = [];
            if (!Array.isArray(state.settings.qweatherCities)) state.settings.qweatherCities = [];
            // 清理旧字段
            delete state.settings.weatherArea;
            delete state.settings.qweatherCityId;
            delete state.settings.weatherCities;
            if (state.settings.bgRefreshInterval === undefined) state.settings.bgRefreshInterval = 30;
            if (state.settings.bgSource === undefined) state.settings.bgSource = 'upx8';
            if (!state.settings.bgRefreshMode) state.settings.bgRefreshMode = 'always';
            if (state.settings.cardColumns === undefined) state.settings.cardColumns = 3;
            // 视觉效果兜底
            if (state.settings.blurBars === undefined) state.settings.blurBars = true;
            if (state.settings.blurCard === undefined) state.settings.blurCard = true;
            if (state.settings.blurModal === undefined) state.settings.blurModal = true;
            if (state.settings.reduceAnimation === undefined) state.settings.reduceAnimation = false;
            // 未保存草稿兜底
            if (!state.settings.drafts || typeof state.settings.drafts !== 'object') {
                state.settings.drafts = { add: {}, edit: {} };
            }
            if (!state.settings.drafts.add || typeof state.settings.drafts.add !== 'object') {
                state.settings.drafts.add = {};
            }
            if (!state.settings.drafts.edit || typeof state.settings.drafts.edit !== 'object') {
                state.settings.drafts.edit = {};
            }
            // 迁移：清理"只含自动编号"的历史草稿（打开添加弹窗又关闭时被误存），
            // 否则学科胶囊会一直显示笔图标、把后面的学科挤出可视区
            let draftsPruned = false;
            for (const kind of ['add', 'edit']) {
                const map = state.settings.drafts[kind];
                for (const key of Object.keys(map)) {
                    if (isBlankHomeworkInput(map[key])) { delete map[key]; draftsPruned = true; }
                }
            }
            if (draftsPruned) _persist().catch(() => {});   // 落盘，避免每次启动重复清理
            // ---- Schema 版本管理 ----
            if (!state.settings.schemaVersion) state.settings.schemaVersion = 1;
            // ---- 首次使用向导兜底 ----
            if (state.settings.wizardCompleted === undefined) state.settings.wizardCompleted = false;
            if (state.settings.acceptedAgreementVersion === undefined) state.settings.acceptedAgreementVersion = '';
            // 未来版本迁移在此添加，例如：
            // if (state.settings.schemaVersion === 1) { ... migrate to 2 ...; state.settings.schemaVersion = 2; }
        } catch (e) {
            console.error('加载数据失败:', e);
            toast('数据加载失败');
            state.homeworks = [];
            state.subjectList = [...DEFAULT_SUBJECTS];
            isFreshInstall = true;  // 加载失败按首次使用处理（后续保存会重建数据）
        }
    }

    let _persistChain = Promise.resolve(true);

    /** 执行一次完整快照保存。每次运行时读取最新 state，避免旧快照覆盖新改动。 */
    function runSave() {
        return (async () => {
            try {
                const result = await api.saveData({
                    homeworks: state.homeworks,
                    subjects: state.subjectList,
                    settings: state.settings
                });
                if (result && result.success === false) {
                    toast('保存失败');
                    return false;
                }
                return true;
            } catch (e) {
                console.error('持久化失败:', e);
                toast('保存失败');
                return false;
            }
        })();
    }

    /** 所有持久化入口都走同一个串行队列，防止并发保存互相覆盖。 */
    function _persist() {
        const next = _persistChain.then(runSave, runSave);
        _persistChain = next.then(() => true, () => true);
        return next;
    }

    /** 先更新内存并排队写盘；写盘失败时回滚内存，保持 UI 与磁盘一致。 */
    async function persistHomeworks(newHomeworks) {
        const previousHomeworks = state.homeworks;
        state.homeworks = newHomeworks;
        const ok = await _persist();
        if (!ok) {
            state.homeworks = previousHomeworks;
            // 回滚后刷新渲染层，让界面反映真实(恢复)的数据，避免 UI 与磁盘不一致
            if (window.Renderer && typeof window.Renderer.renderAll === 'function') {
                try { window.Renderer.renderAll(); } catch (e) { console.error('回滚后重渲染失败:', e); }
            }
        }
        return ok;
    }

    async function saveHomeworks() {
        return await _persist();
    }

    async function saveSettings() {
        return await _persist();
    }

    async function saveSubjects() {
        return await _persist();
    }

    // 是否首次安装（loadAll 后有效）：磁盘上无 settings 记录
    window.AppStorage = { loadAll, saveHomeworks, saveSettings, saveSubjects, persistHomeworks, get isFreshInstall() { return isFreshInstall; } };
})();
