// ============================================
// registry.js —— 渲染层模块注册表 + 加载器
//
// 单一事实来源：所有渲染层模块按「依赖顺序」登记在 modules 中，
// 由本文件在运行时顺序加载并校验，替代原先在 index.html 里手写的 34 个
// <script> 标签。好处：
//   1. 新增模块只需在此追加一条 { file, exposes }，无需再改 HTML；
//   2. 每个模块加载后按 exposes 契约校验全局是否就位，缺失立刻记录报错；
//   3. `npm test`（test/check-wiring.mjs）读取同一份清单做静态交叉校验，
//      防止「加了模块忘了登记 / 登记了却不加载 / 留下死文件」这类问题。
// ============================================

(function () {
    'use strict';

    const REGISTRY = {
        // 模块清单：file 相对于 index.html；exposes 为加载后必须存在的全局路径
        // （支持 a.b.c 嵌套路径，如 SettingsModules.general；空数组表示无全局契约）
        modules: [
            { file: 'emoji/emoji-map.js', exposes: ['EMOJI_FILES', 'emoji'] },
            { file: 'src/scripts/config.js', exposes: ['AppConfig'] },
            { file: 'src/scripts/state.js', exposes: ['AppState'] },
            { file: 'src/scripts/utils.js', exposes: ['AppUtils'] },
            { file: 'src/scripts/storage.js', exposes: ['AppStorage'] },
            { file: 'src/scripts/styling.js', exposes: ['AppStyling'] },
            { file: 'src/scripts/weather.js', exposes: ['AppWeather'] },
            { file: 'src/scripts/background.js', exposes: ['AppBackground'] },
            { file: 'src/scripts/layout.js', exposes: ['AppLayout'] },
            { file: 'src/scripts/renderer.js', exposes: ['Renderer', 'AppRenderer'] },
            { file: 'src/scripts/modal.js', exposes: ['AppModal'] },
            { file: 'src/scripts/search.js', exposes: ['AppSearch'] },
            { file: 'src/scripts/dialogs.js', exposes: ['AppDialogs'] },
            { file: 'src/scripts/color-picker.js', exposes: ['ColorPicker'] },
            { file: 'src/scripts/archive-renderer.js', exposes: ['ArchiveView'] },
            { file: 'src/scripts/homework-engine.js', exposes: ['HomeworkEngine'] },
            { file: 'src/scripts/qq-pending-dialog.js', exposes: ['QQPending'] },
            { file: 'src/scripts/settings/general.js', exposes: ['SettingsModules.general'] },
            { file: 'src/scripts/settings/weather.js', exposes: ['SettingsModules.weather'] },
            { file: 'src/scripts/settings/personal.js', exposes: ['SettingsModules.personal'] },
            { file: 'src/scripts/settings/accessibility.js', exposes: ['SettingsModules.accessibility'] },
            { file: 'src/scripts/settings/subjects.js', exposes: ['SettingsModules.subjects'] },
            { file: 'src/scripts/settings/qq.js', exposes: ['SettingsModules.qq'] },
            { file: 'src/scripts/settings/solve.js', exposes: ['SettingsModules.solve'] },
            { file: 'src/scripts/settings/data.js', exposes: ['SettingsModules.data'] },
            { file: 'src/scripts/settings/about.js', exposes: ['SettingsModules.about'] },
            { file: 'src/scripts/settings/nav.js', exposes: ['SettingsModules.nav'] },
            { file: 'src/scripts/backup.js', exposes: ['AppBackup'] },
            { file: 'src/scripts/settings.js', exposes: ['AppSettings'] },
            { file: 'src/scripts/wizard.js', exposes: ['AppWizard'] },
            { file: 'src/scripts/floating-mode.js', exposes: ['AppFloatingMode'] },
            { file: 'src/scripts/solve.js', exposes: ['AppSolve'] },
            { file: 'src/scripts/more-menu.js', exposes: ['AppMoreMenu'] },
            { file: 'src/scripts/window-controls.js', exposes: [] },
            { file: 'src/scripts/datepicker.js', exposes: ['AppDatePicker'] },
            // 应用入口：必须最后加载（依赖前面所有模块），自身不暴露全局契约
            { file: 'src/scripts/main.js', exposes: [] }
        ],

        // 运行时状态（由加载器写入，供应用与测试读取）
        ready: false,
        errors: []
    };

    // 供 Node 侧工具（npm test / test/check-wiring.mjs）读取同一份清单
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = REGISTRY;
    }

    // 浏览器 / 渲染进程：暴露注册表并顺序加载模块
    if (typeof window === 'undefined') return;

    window.AppRegistry = REGISTRY;

    function loadModule(entry) {
        return new Promise((resolve) => {
            const s = document.createElement('script');
            s.src = entry.file;
            s.onload = () => resolve();
            s.onerror = () => {
                REGISTRY.errors.push({ file: entry.file, error: '资源加载失败（404 或网络错误）' });
                resolve();
            };
            (document.head || document.documentElement).appendChild(s);
        });
    }

    function resolvePath(path, root) {
        return path.split('.').reduce((obj, k) => (obj == null ? undefined : obj[k]), root);
    }

    async function boot() {
        for (const entry of REGISTRY.modules) {
            await loadModule(entry);
            for (const expose of entry.exposes) {
                if (resolvePath(expose, window) === undefined) {
                    REGISTRY.errors.push({ file: entry.file, exposes: expose, error: '缺少全局 ' + expose });
                }
            }
        }
        REGISTRY.ready = true;
        document.dispatchEvent(new CustomEvent('app:modules-ready', { detail: REGISTRY }));
        if (REGISTRY.errors.length) {
            console.error('[registry] 模块加载校验未通过：', REGISTRY.errors);
        }
    }

    boot();
})();
