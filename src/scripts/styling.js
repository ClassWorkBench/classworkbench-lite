// ============================================
// styling.js
// 应用样式：字号、accent RGB、背景层底色、模糊/减弱动画
// ============================================

(function () {
    const state = window.AppState;
    const { hexToRgb } = window.AppUtils;

    function applyStyling() {
        const settings = state.settings;
        const bgLayer = state.dom.bgLayer();

        // 注意：不要清空 document.body.className —— 模糊开关(blur-*-off)、
        // 减弱动画(reduce-anim)、截图(capturing)等运行时状态都挂在 body class 上，
        // 清空会导致这些状态丢失、CSS 回退到默认值（例如关闭的模糊被"强制打开"）。
        document.documentElement.style.setProperty('--font-size-content', settings.contentFontSize + 'px');

        const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
        if (accent) {
            const rgb = hexToRgb(accent);
            if (rgb) {
                document.documentElement.style.setProperty('--accent-rgb', `${rgb.r},${rgb.g},${rgb.b}`);
            }
        }
        if (bgLayer) {
            bgLayer.style.backgroundColor = getComputedStyle(document.documentElement).getPropertyValue('--bg-body').trim() || '#fafaf7';
        }
    }

    // 减弱动画：完全由软件内设置决定（标准/减弱），不跟随系统
    function applyReducedMotion() {
        document.body.classList.toggle('reduce-anim', !!state.settings.reduceAnimation);
    }

    // 模糊效果：完全由三个开关决定，不跟随系统透明效果
    function applyBlurClasses() {
        document.body.classList.toggle('blur-bars-off', !state.settings.blurBars);
        document.body.classList.toggle('blur-card-off', !state.settings.blurCard);
        document.body.classList.toggle('blur-modal-off', !state.settings.blurModal);
    }

    // ----- 外观模式（浅色/深色/跟随系统）-----
    // 解析外观配置 → 实际主题 'light' | 'dark'
    function resolveTheme(appearance) {
        if (appearance === 'dark') return 'dark';
        if (appearance === 'light') return 'light';
        // 'system' 跟随系统
        return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    }

    // 应用外观：将解析结果落到 html 的 data-theme（而非 body，避免触碰模糊/减动效等 body 运行时类），
    // 再同步背景层底色（浅色/深色 --bg-body 不同）。
    function applyAppearance() {
        const theme = resolveTheme(state.settings.appearance || 'system');
        document.documentElement.setAttribute('data-theme', theme);
        applyStyling();
    }

    // 跟随系统：注册系统主题变化监听，仅在外观为 system 时响应
    function initThemeWatcher() {
        if (!window.matchMedia) return;
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const handler = () => {
            if ((state.settings.appearance || 'system') === 'system') applyAppearance();
        };
        if (mq.addEventListener) mq.addEventListener('change', handler);
        else if (mq.addListener) mq.addListener(handler); // 旧内核兜底
    }

    function initStyling() {
        applyAppearance();       // 初始化外观（含 data-theme 与背景层底色）
        applyReducedMotion();
        applyBlurClasses();
        initThemeWatcher();      // 跟随系统的实时切换
    }

    window.AppStyling = {
        applyStyling,
        applyReducedMotion,
        applyBlurClasses,
        applyAppearance,
        initThemeWatcher,
        initStyling
    };
})();