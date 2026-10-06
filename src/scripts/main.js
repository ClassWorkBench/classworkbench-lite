// ============================================
// main.js  (渲染进程入口)
// 启动顺序：加载 -> 主题 -> 渲染 -> 天气 -> 背景 -> 事件绑定
// ============================================

(function () {
    'use strict';

    window.addEventListener('error', (e) => {
        console.error('[渲染进程异常]', e.message, e.filename, e.lineno);
    });
    window.addEventListener('unhandledrejection', (e) => {
        console.error('[未处理Promise拒绝]', e.reason);
    });

    const { loadAll } = window.AppStorage;
    const { initStyling } = window.AppStyling;
    const { loadWeather, setupWeatherRefresh } = window.AppWeather;
    const { initBackground, setupBgRefresh } = window.AppBackground;
    const { adjustContentPadding } = window.AppLayout;
    const { toast } = window.AppUtils;
    const Renderer = window.Renderer;

    // 向导"完成"页预热标记：背景图只预热一次（天气靠 loadWeather 内部防重入）
    let bgPrewarmed = false;

    /**
     * 资源预热：向导进入"完成"页时提前发起天气请求与背景图加载。
     * 天气请求有 weatherFetching 防重 + 30 分钟缓存，背景下载有并发锁，重复调用安全。
     */
    function prewarmResources() {
        try {
            const provider = window.AppState.settings.weatherProvider || 'openmeteo';
            const cities = provider === 'qweather'
                ? window.AppState.settings.qweatherCities
                : window.AppState.settings.openmeteoCities;
            const firstCity = cities && cities.length > 0 ? cities[0] : null;
            if (firstCity) loadWeather(firstCity);
            else loadWeather(null);
        } catch (e) {
            console.warn('[预热] 天气预热失败:', e);
        }
        if (!bgPrewarmed) {
            bgPrewarmed = true;
            try { initBackground(); }
            catch (e) { console.warn('[预热] 背景预热失败:', e); }
        }
    }

    async function init() {
        // 防御性检查：确认关键依赖已加载
        const deps = ['AppStorage', 'AppStyling', 'AppWeather', 'AppBackground', 'AppLayout', 'AppSettings', 'Renderer'];
        for (const dep of deps) {
            if (!window[dep]) {
                console.error(`[启动失败] 依赖 ${dep} 未加载，请检查脚本加载顺序`);
                return;
            }
        }

        // 注册表（registry.js）若记录了模块加载问题，启动时明确列出，便于定位
        if (window.AppRegistry && window.AppRegistry.errors && window.AppRegistry.errors.length) {
            console.error('[启动] 模块加载校验未通过，可能存在功能缺失:', window.AppRegistry.errors);
        }

        // 视图日期变更统一收敛：调用方用 state.setViewDate(date, { slide|animate }) 触发渲染，
        // 渲染器在此订阅，避免各处手动调用 render* 造成状态泄漏
        Renderer.bindViewDate();

        await loadAll();
        // 视觉与性能：模糊降级 + 减弱动画（含系统透明/减动效同步）由 AppStyling 统一应用
        initStyling();
        window.AppStyling.applyBlurClasses();

        // 首次使用设置向导：全新安装走完整 7 步；老用户协议版本更新只弹协议确认。
        // await 等待向导完成后再渲染主界面，学科/晚修/天气城市的改动一次生效。
        if (window.AppWizard) {
            try {
                // 向导"完成"页进入时预热资源（用户停留阅读时网络请求已在途）
                window.addEventListener('wizard:near-complete', prewarmResources);
                await window.AppWizard.maybeStart();
            } catch (e) {
                console.error('[向导] 执行异常:', e);
            }
        }

        // 预热模糊/合成上下文：必须在卡片首屏动画之前。
        // 卡片与菜单面板都带 backdrop-filter + will-change，首次栅格化会阻塞合成器，
        // 把同帧启动的入场动画快进/吞掉（表现为启动时"所有卡片抖一下"、首开菜单无动画）。
        // 这里先屏幕外绘制一次菜单面板，把一次性开销挪到卡片渲染之前。
        if (window.AppMoreMenu && typeof window.AppMoreMenu.prewarmPaint === 'function') {
            try {
                window.AppMoreMenu.prewarmPaint();
                // 双 rAF 等一次合成；窗口处于后台/隐藏时 rAF 会被节流，加超时兜底避免启动流程卡死
                await Promise.race([
                    new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))),
                    new Promise(r => setTimeout(r, 300))
                ]);
            } catch (e) {
                console.warn('[预热] 模糊合成预热失败:', e);
            }
        }

        Renderer.renderAll();

        const provider = window.AppState.settings.weatherProvider || 'openmeteo';
        const cities = provider === 'qweather' ? window.AppState.settings.qweatherCities : window.AppState.settings.openmeteoCities;
        const firstCity = cities && cities.length > 0 ? cities[0] : null;
        // 若已在向导"完成"页预热过天气/背景，这里靠防重与缓存兜底，不重复启动
        if (firstCity) loadWeather(firstCity);
        else loadWeather(null);

        // 启动天气定时刷新（根据 weatherRefreshInterval 和 weatherRefreshMode）
        setupWeatherRefresh();

        if (!bgPrewarmed) initBackground();
        setupBgRefresh(window.AppState.settings.bgRefreshInterval);

        setInterval(() => Renderer.updateClock(), 30000);  // 原 10s，大屏场景 30s 精度完全够用
        Renderer.updateClock();

        window.addEventListener('resize', () => {
            setTimeout(adjustContentPadding, 100);
        });
        const topCapsule = document.getElementById('topCapsule');
        if (topCapsule) {
            const observer = new ResizeObserver(() => adjustContentPadding());
            observer.observe(topCapsule);
        }

        if (window.AppMoreMenu) window.AppMoreMenu.init();
        if (window.AppDatePicker) window.AppDatePicker.init();
        // 浮窗模式（画中画）：订阅主进程事件 + 绑定退出按钮
        if (window.AppFloatingMode && typeof window.AppFloatingMode.init === 'function') {
            window.AppFloatingMode.init();
        }

        setTimeout(adjustContentPadding, 100);

        // 启动完成标志：供冒烟/自动化探测等待「交互已就绪」。
        // 注意 AppRegistry.ready 只代表模块脚本已加载，此时本 init 仍可能未绑定事件。
        window.AppReady = true;
        document.dispatchEvent(new CustomEvent('app:ready'));
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
