// ============================================
// settings/weather.js — 天气面板（装配层）
// 对外契约保持不变：window.SettingsModules.weather = { render, bind }。
// 渲染与交互逻辑已拆分为职责单一的子模块（view / qweather / city / misc），
// 本文件负责组装与初始化。
// ============================================

window.SettingsModules = window.SettingsModules || {};

window.SettingsModules.weather = {
    render(ctx) {
        return window.WeatherView.render(ctx);
    },

    bind(ctx) {
        // 共享绑定上下文：子模块由此读取 ctx 依赖，协作函数经 deps 回调传递
        const B = {
            ctx,
            state: ctx.state,
            api: ctx.api,
            saveSettings: ctx.saveSettings,
            toast: ctx.toast,
            escapeHtml: ctx.escapeHtml,
            showModal: ctx.showModal,
            loadWeather: ctx.loadWeather,
            restartWeatherRefresh: ctx.restartWeatherRefresh,
            searchCities: ctx.searchCities,
            refilterAlerts: ctx.refilterAlerts
        };

        // 安装顺序：city 先（提供 renderCityList/getFirstCity 供 qweather 协作），
        // qweather 次（依赖 city 回调），misc 最后（独立）。
        const city = window.WeatherCity.setup(B);
        window.WeatherQweather.setup(B, {
            renderCityList: city.renderCityList,
            getFirstCity: city.getFirstCity
        });
        window.WeatherMisc.setup(B);

        // ---- 初始化：为已渲染的城市列表绑定删除/拖拽事件 ----
        // render() 内联了列表 HTML，但未走 renderCityList()（它负责重建 + 绑事件）。
        // bind() 时必须主动执行一次，否则初始列表的删除/拖拽无监听器。
        city.renderCityList();
    }
};