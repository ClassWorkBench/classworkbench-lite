// ============================================
// settings/weather-store.js — 天气城市列表读写
// 按当前 provider 选择存储 key（openmeteo/qweather），
// 是天气面板各模块共享的唯一数据入口。
// ============================================

window.WeatherStore = {
    // node_modules 无关；当前 provider 对应的城市列表 key
    key() {
        var provider = window.AppState.settings.weatherProvider || 'openmeteo';
        return provider === 'qweather' ? 'qweatherCities' : 'openmeteoCities';
    },
    list() {
        var k = this.key();
        return window.AppState.settings[k] || [];
    },
    set(list) {
        var k = this.key();
        window.AppState.settings[k] = list;
    }
};