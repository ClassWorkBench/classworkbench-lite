// ============================================
// settings/weather-city.js — 天气面板城市管理
// 城市搜索、列表增删排、拖拽排序。
// 自持搜索计时与拖拽源索引；共享温度状态均收敛在本模块闭包。
// 返回 { renderCityList, getFirstCity } 供 weather-qweather / 主模块协作。
// ============================================

window.WeatherCity = {
    setup(B) {
        const { state, saveSettings, toast, escapeHtml, searchCities, loadWeather } = B;
        const Store = window.WeatherStore;
        const rowHtml = window.WeatherView.rowHtml;

        const searchInput = document.getElementById('weatherSearchInput');
        const searchResults = document.getElementById('weatherSearchResults');
        let searchTimer = null;
        let searchSeq = 0;
        let dragSrcIndex = null;

        function getFirstCity() {
            var cities = Store.list();
            return cities.length > 0 ? cities[0] : null;
        }

        // ---- 城市搜索 ----
        searchInput.addEventListener('input', function () {
            var kw = searchInput.value.trim();
            clearTimeout(searchTimer);
            if (!kw) {
                hideSearchResults();
                return;
            }
            searchTimer = setTimeout(function () {
                doSearch(kw);
            }, 400);
        });

        searchInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                var first = searchResults.querySelector('.weather-search-item');
                if (first) first.click();
            } else if (e.key === 'Escape') {
                hideSearchResults();
                searchInput.blur();
            }
        });

        document.addEventListener('click', function (e) {
            if (!e.target.closest('.weather-search-wrap')) {
                hideSearchResults();
            }
        });

        // ---- 搜索下拉显示/隐藏（复刻作业搜索微窗：spring 就地生长）----
        function showSearchResults() {
            searchResults.classList.add('qw-magic');
            // 第 1 帧：归零起点，为生长动画定格
            searchResults.style.display = 'block';
            searchResults.style.height = '0px';
            searchResults.style.opacity = '0';
            searchResults.style.overflow = 'hidden';
            // 第 2 帧：从 0 生长到内容高度（spring 缓动），透明度同步介入
            requestAnimationFrame(function () {
                var target = searchResults.scrollHeight;
                var cap = 240;                          // 与 CSS max-height 一致，超高则容器内滚动
                searchResults.style.height = Math.min(target, cap) + 'px';
                searchResults.style.opacity = '1';
                searchResults.style.overflow = (target > cap) ? 'auto' : 'hidden';
            });
            // 逐项错峰淡入（下落 + 清晰化）
            Array.prototype.forEach.call(searchResults.children, function (el) {
                el.style.opacity = '0';
                el.style.transform = 'translateY(5px)';
                el.style.transition = 'opacity .22s var(--transition-smooth), transform .3s var(--transition-spring)';
            });
            requestAnimationFrame(function () {
                Array.prototype.forEach.call(searchResults.children, function (el, i) {
                    el.style.transitionDelay = (90 + i * 35) + 'ms';
                });
            });
            // 下一帧让项过渡到原位
            requestAnimationFrame(function () {
                Array.prototype.forEach.call(searchResults.children, function (el) {
                    el.style.opacity = '1';
                    el.style.transform = 'translateY(0)';
                });
            });
        }

        function hideSearchResults() {
            searchResults.classList.remove('qw-magic');
            searchResults.style.height = '';
            searchResults.style.opacity = '';
            searchResults.style.overflow = '';
            // 还原项样式，供下次重复使用
            Array.prototype.forEach.call(searchResults.children, function (el) {
                el.style.opacity = '';
                el.style.transform = '';
                el.style.transition = '';
                el.style.transitionDelay = '';
            });
            searchResults.style.display = 'none';
        }

        async function doSearch(keyword) {
            var mySeq = ++searchSeq;
            try {
                var results = await searchCities(keyword);
                if (mySeq !== searchSeq) return;
                if (!results || results.length === 0) {
                    searchResults.innerHTML = '<div class="weather-search-empty">未找到"' + escapeHtml(keyword) + '"，请换个关键词试试</div>';
                    showSearchResults();
                    return;
                }
                renderSearchResults(results);
            } catch (err) {
                if (mySeq !== searchSeq) return;
                if (err.message === 'NO_CONFIG') {
                    searchResults.innerHTML = '<div class="weather-search-empty">请先配置和风天气 JWT（Host + kid/sub/私钥）</div>';
                    showSearchResults();
                    return;
                }
                searchResults.innerHTML = '<div class="weather-search-empty">搜索失败，请重试</div>';
                showSearchResults();
            }
        }

        function renderSearchResults(results) {
            searchResults.innerHTML = '';
            results.forEach(function (city) {
                var item = document.createElement('div');
                item.className = 'weather-search-item';
                var region = [city.country, city.admin1].filter(Boolean).join(' · ');
                item.innerHTML = '<span class="weather-search-item-name">' + escapeHtml(city.name) + '</span>' +
                    (region ? '<span class="weather-search-item-region">' + escapeHtml(region) + '</span>' : '');
                item.addEventListener('click', function () {
                    addCity(city);
                    hideSearchResults();
                    searchInput.value = '';
                });
                searchResults.appendChild(item);
            });
            showSearchResults();
        }

        function addCity(city) {
            var cities = Store.list();
            // 避免重复添加（同 provider 同 id）
            var exists = cities.some(function (c) { return c.id === city.id; });
            if (exists) {
                toast('"' + city.name + '" 已在列表中');
                return;
            }
            // 只保留当前 provider 所需字段
            var provider = state.settings.weatherProvider || 'openmeteo';
            var entry;
            if (provider === 'qweather') {
                entry = { id: city.id, name: city.name, locationId: city.locationId, lat: city.lat, lon: city.lon, country: city.country || '', admin1: city.admin1 || '', timezone: city.timezone || 'auto' };
            } else {
                entry = { id: city.id, name: city.name, lat: city.lat, lon: city.lon, country: city.country || '', admin1: city.admin1 || '', timezone: city.timezone || 'auto' };
            }
            cities.push(entry);
            Store.set(cities);
            saveSettings().then(function () {
                renderCityList();
                // 如果这是第一个城市，立即加载天气
                var first = getFirstCity();
                if (first && first.id === entry.id) {
                    loadWeather(entry);
                }
                toast('已添加 ' + entry.name);
            });
        }

        // ---- 城市列表渲染 ----
        function renderCityList() {
            var container = document.getElementById('weatherCityList');
            if (!container) return;
            var cities = Store.list();
            if (cities.length === 0) {
                container.innerHTML = '<div class="weather-city-empty">还没有添加城市，在上方搜索并添加</div>';
                return;
            }
            var html = cities.map(function (c, i) {
                return rowHtml(c, i, escapeHtml);
            }).join('');
            container.innerHTML = html;

            // 绑定删除事件
            container.querySelectorAll('.weather-city-del').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    var idx = parseInt(btn.dataset.index);
                    removeCity(idx);
                });
            });

            // 绑定拖拽事件
            container.querySelectorAll('.weather-city-item').forEach(function (item) {
                item.addEventListener('dragstart', onDragStart);
                item.addEventListener('dragover', onDragOver);
                item.addEventListener('drop', onDrop);
                item.addEventListener('dragend', onDragEnd);
            });
        }

        // ---- 删除城市 ----
        function removeCity(index) {
            var cities = Store.list();
            if (index < 0 || index >= cities.length) return;
            var removed = cities[index];
            cities.splice(index, 1);
            Store.set(cities);
            saveSettings().then(function () {
                renderCityList();
                var first = getFirstCity();
                loadWeather(first);
                toast('已移除 ' + removed.name);
            });
        }

        // ---- 拖拽排序 ----
        function onDragStart(e) {
            dragSrcIndex = parseInt(e.target.closest('.weather-city-item').dataset.index);
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(dragSrcIndex));
            var item = e.target.closest('.weather-city-item');
            setTimeout(function () { item.classList.add('weather-city-dragging'); }, 0);
        }

        function onDragOver(e) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            document.querySelectorAll('.weather-city-dragover').forEach(function (el) {
                el.classList.remove('weather-city-dragover');
            });
            var target = e.target.closest('.weather-city-item');
            if (!target) return;
            var targetIndex = parseInt(target.dataset.index);
            if (targetIndex === dragSrcIndex) return;
            target.classList.add('weather-city-dragover');
        }

        function onDrop(e) {
            e.preventDefault();
            var dropTarget = e.target.closest('.weather-city-item');
            if (!dropTarget) return;
            var targetIndex = parseInt(dropTarget.dataset.index);
            if (targetIndex === dragSrcIndex || dragSrcIndex === null) return;

            var cities = Store.list();
            var item = cities.splice(dragSrcIndex, 1)[0];
            cities.splice(targetIndex, 0, item);
            Store.set(cities);
            dragSrcIndex = null;

            saveSettings().then(function () {
                renderCityList();
                var first = getFirstCity();
                if (first) loadWeather(first);
            });
        }

        function onDragEnd(e) {
            var item = e.target.closest('.weather-city-item');
            if (item) item.classList.remove('weather-city-dragging');
            document.querySelectorAll('.weather-city-dragover').forEach(function (el) {
                el.classList.remove('weather-city-dragover');
            });
            dragSrcIndex = null;
        }

        return { renderCityList, getFirstCity };
    }
};