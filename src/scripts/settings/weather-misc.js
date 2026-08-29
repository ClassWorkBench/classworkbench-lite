// ============================================
// settings/weather-misc.js — 天气面板杂项
// 预警级别筛选 pill + 刷新频率/模式。
// 纯事件绑定，无共享可变状态。
// ============================================

window.WeatherMisc = {
    setup(B) {
        const { state, saveSettings, refilterAlerts, restartWeatherRefresh } = B;

        // ---- 预警级别筛选（色块 pill：点击切换选中态，醒目排开不换行）----
        document.querySelectorAll('.alert-level-pill').forEach(function (pill) {
            pill.addEventListener('click', async function () {
                pill.classList.toggle('active');
                var levels = Array.from(document.querySelectorAll('.alert-level-pill'))
                    .filter(function (p) { return p.classList.contains('active'); })
                    .map(function (p) { return p.dataset.level; });
                state.settings.alertEnabledLevels = levels;
                await saveSettings();
                refilterAlerts();
            });
        });

        // ---- 天气刷新频率 ----
        const weatherRefreshIntervalSelect = document.getElementById('weatherRefreshIntervalSelect');
        weatherRefreshIntervalSelect.addEventListener('change', async () => {
            const interval = parseInt(weatherRefreshIntervalSelect.value);
            state.settings.weatherRefreshInterval = interval;
            await saveSettings();
            restartWeatherRefresh();
        });

        // ---- 天气刷新模式 ----
        const weatherRefreshModeSelect = document.getElementById('weatherRefreshModeSelect');
        weatherRefreshModeSelect.addEventListener('change', async () => {
            state.settings.weatherRefreshMode = weatherRefreshModeSelect.value;
            await saveSettings();
            restartWeatherRefresh();
        });
    }
};