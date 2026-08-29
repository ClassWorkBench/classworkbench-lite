// ============================================
// settings/weather-view.js — 天气面板视图
// 纯渲染，无逻辑副作用：产出面板 HTML 模板；
// 城市行模板 .rowHtml 供 render 与 weather-city 共用。
// ============================================

window.WeatherView = {
    // 单条城市行 HTML（render 与 city 模块重建列表时复用，保证两处表现一致）
    rowHtml(c, i, escapeHtml) {
        var region = [c.country, c.admin1].filter(Boolean).join(' · ');
        return '<div class="weather-city-item" draggable="true" data-index="' + i + '">' +
            '<span class="weather-city-drag">⠿</span>' +
            '<span class="weather-city-name">' + escapeHtml(c.name) + '</span>' +
            (region ? '<span class="weather-city-region">' + escapeHtml(region) + '</span>' : '') +
            '<span class="weather-city-badge">' + (i === 0 ? '显示中' : '') + '</span>' +
            '<button class="weather-city-del" data-index="' + i + '" title="移除">&times;</button>' +
            '</div>';
    },

    render(ctx) {
        const { settings, escapeHtml, REFRESH_OPTIONS } = ctx;
        const cities = window.WeatherStore.list();

        const cityListHtml = cities.map(function (c, i) {
            return window.WeatherView.rowHtml(c, i, escapeHtml);
        }).join('') || '<div class="weather-city-empty">还没有添加城市，在上方搜索并添加</div>';

        return `
                    <!-- 面板：天气 -->
                    <div class="settings-panel" id="panel-weather">
                        <div class="panel-header">
                            <h3>天气</h3>
                            <p class="panel-desc">选择天气 API 来源、配置参数与刷新策略</p>
                        </div>
                        <div class="panel-body">
                            <div class="setting-group" id="qwTopGroup">
                                <div class="setting-label-row">
                                    <label for="weatherProviderSelect">天气 API</label>
                                    <span class="qw-status-inline" id="qwStatusInline" style="display:${settings.weatherProvider === 'qweather' ? '' : 'none'};">
                                        <span class="qw-status-dot" id="qweatherStatusDot"></span>
                                        <span id="qweatherStatusText">检测中…</span>
                                    </span>
                                </div>
                                <select id="weatherProviderSelect" data-cselect aria-label="选择天气数据来源">
                                    <option value="openmeteo" ${settings.weatherProvider === 'qweather' ? '' : 'selected'}>Open-Meteo（免费，简单）</option>
                                    <option value="qweather" ${settings.weatherProvider === 'qweather' ? 'selected' : ''}>和风天气（需配置 API）</option>
                                </select>
                                <small>和风天气需 JWT 认证配置 — <a href="#" id="qweatherConfigLink" class="link-accent">${settings.qweatherApiHost && settings.qweatherKid && settings.qweatherSub && settings.qweatherPrivateKey ? '修改 API 配置' : '配置 API 认证'}</a></small>
                            </div>
                            <!-- 城市搜索 + 已添加城市：和风天气需检测通过后方可展开 -->
                            <div id="weatherCitySection" class="qw-city-section" style="${settings.weatherProvider === 'qweather' && !(settings.qweatherApiHost && settings.qweatherKid && settings.qweatherSub && settings.qweatherPrivateKey) ? 'max-height:0;opacity:0;' : 'max-height:900px;opacity:1;'}">
                                <div class="setting-group">
                                    <label>城市搜索</label>
                                    <div class="weather-search-wrap">
                                        <input type="text" id="weatherSearchInput" placeholder="输入城市名搜索，如：北京、上海、纽约" autocomplete="off" spellcheck="false" />
                                        <div class="weather-search-results" id="weatherSearchResults" style="display:none;"></div>
                                    </div>
                                    <small>搜索后点击结果即可添加到下方列表，拖拽排序，仅第一个城市显示在主界面</small>
                                </div>
                                <div class="setting-group">
                                    <label>已添加城市</label>
                                    <div class="weather-city-list" id="weatherCityList">
                                        ${cityListHtml}
                                    </div>
                                </div>
                            </div>
                            <div class="setting-group" id="alertLevelGroup" style="display:none;">
                                <label>预警级别</label>
                                <div class="alert-level-row">
                                    <button type="button" class="alert-level-pill ${(settings.alertEnabledLevels || ['blue','yellow','orange','red']).includes('blue') ? 'active' : ''}" data-level="blue" style="--ac:#3b82f6;">蓝色</button>
                                    <button type="button" class="alert-level-pill ${(settings.alertEnabledLevels || ['blue','yellow','orange','red']).includes('yellow') ? 'active' : ''}" data-level="yellow" style="--ac:#eab308;">黄色</button>
                                    <button type="button" class="alert-level-pill ${(settings.alertEnabledLevels || ['blue','yellow','orange','red']).includes('orange') ? 'active' : ''}" data-level="orange" style="--ac:#f97316;">橙色</button>
                                    <button type="button" class="alert-level-pill ${(settings.alertEnabledLevels || ['blue','yellow','orange','red']).includes('red') ? 'active' : ''}" data-level="red" style="--ac:#ef4444;">红色</button>
                                </div>
                            </div>
                            <div class="setting-group">
                                <label for="weatherRefreshIntervalSelect">刷新频率</label>
                                <select id="weatherRefreshIntervalSelect" data-cselect aria-label="天气刷新频率">${REFRESH_OPTIONS.map(o =>
                                    `<option value="${o.value}" ${settings.weatherRefreshInterval === o.value ? 'selected' : ''}>${o.label}</option>`
                                ).join('')}</select>
                                <small>设置为"不刷新"则仅首次加载，后续不再自动更新</small>
                            </div>
                            <div class="setting-group">
                                <label for="weatherRefreshModeSelect">刷新模式</label>
                                <select id="weatherRefreshModeSelect" data-cselect aria-label="天气刷新模式">
                                    <option value="always" ${settings.weatherRefreshMode === 'foreground' ? '' : 'selected'}>始终刷新</option>
                                    <option value="foreground" ${settings.weatherRefreshMode === 'foreground' ? 'selected' : ''}>仅前台刷新</option>
                                </select>
                                <small>仅前台刷新：窗口在后台时暂停刷新，回到前台时立即刷新一次</small>
                            </div>
                        </div>
                    </div>
        `;
    }
};