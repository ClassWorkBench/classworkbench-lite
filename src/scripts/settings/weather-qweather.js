// ============================================
// settings/weather-qweather.js — 和风天气（qweather）能力
// API 提供商切换、JWT 配置弹窗、可用性检测、预警区显隐。
// 自持 qwDetectionPassed（检测是否通过）。
// deps.renderCityList / deps.getFirstCity 来自 weather-city 模块。
// ============================================

window.WeatherQweather = {
    setup(B, deps) {
        const { state, saveSettings, toast, escapeHtml, showModal, loadWeather, api } = B;
        const { renderCityList, getFirstCity } = deps;

        const weatherProviderSelect = document.getElementById('weatherProviderSelect');
        const qwStatusInline = document.getElementById('qwStatusInline');

        // 和风检测是否已通过（false=未配置/检测中/不可用，预警区此时应折叠）
        let qwDetectionPassed = false;

        function isQweatherConfigured() {
            return state.settings.qweatherApiHost && state.settings.qweatherKid &&
                state.settings.qweatherSub && state.settings.qweatherPrivateKey;
        }

        function toggleWeatherProviderUI() {
            const isQweather = weatherProviderSelect.value === 'qweather';
            if (qwStatusInline) qwStatusInline.style.display = isQweather ? '' : 'none';
            // 预警区：仅在和风 provider 且检测通过时显示，其余一律折叠
            updateAlertVisibility();
        }

        weatherProviderSelect.addEventListener('change', async () => {
            const provider = weatherProviderSelect.value;
            toggleWeatherProviderUI();
            state.settings.weatherProvider = provider;
            await saveSettings();
            // 重新渲染城市列表（展示对应 provider 的城市）
            renderCityList();
            // 加载对应 provider 的第一个城市
            var first = getFirstCity();
            loadWeather(first);
            // 切到和风时自动检测（通过后自动展开城市/搜索区）
            if (provider === 'qweather') {
                collapseCitySection();
                await checkQweather();
            } else {
                setStatusUi('unk', '');
                expandCitySection();
            }
        });

        // ---- 和风天气 API 配置（弹窗）---- JWT 认证：Host + kid + sub + 私钥
        function openQweatherConfigDialog() {
            var host = state.settings.qweatherApiHost || '';
            var kid = state.settings.qweatherKid || '';
            var sub = state.settings.qweatherSub || '';
            // 私钥绝不回显明文：渲染层只拿到掩码（*configured*），输入框留空 = 保持原值
            var hasPriv = !!state.settings.qweatherPrivateKey;
            var html = '<h3>和风天气 API 配置（JWT 认证）</h3>' +
                '<div style="margin-bottom:12px;">' +
                '<label style="display:block;font-size:0.8rem;color:var(--text-muted);margin-bottom:4px;">API Host</label>' +
                '<input type="text" id="qweatherConfigHost" placeholder="如 abc123.xyz.qweatherapi.com" value="' + escapeHtml(host) + '" />' +
                '</div>' +
                '<div style="margin-bottom:12px;">' +
                '<label style="display:block;font-size:0.8rem;color:var(--text-muted);margin-bottom:4px;">凭据 ID（kid）</label>' +
                '<input type="text" id="qweatherConfigKid" placeholder="控制台-项目管理中的凭据 ID" value="' + escapeHtml(kid) + '" />' +
                '</div>' +
                '<div style="margin-bottom:12px;">' +
                '<label style="display:block;font-size:0.8rem;color:var(--text-muted);margin-bottom:4px;">项目 ID（sub）</label>' +
                '<input type="text" id="qweatherConfigSub" placeholder="控制台-项目管理中的项目 ID" value="' + escapeHtml(sub) + '" />' +
                '</div>' +
                '<div style="margin-bottom:12px;">' +
                '<label style="display:block;font-size:0.8rem;color:var(--text-muted);margin-bottom:4px;">Ed25519 私钥</label>' +
                (hasPriv
                    ? '<small style="color:var(--text-success);display:block;margin-bottom:4px;">✓ 已配置。输入框留空保持不变，如需更换请在下方粘贴新私钥。</small>'
                    : '') +
                '<textarea id="qweatherConfigPrivateKey" rows="3" placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----&#10;（留空=不修改已配置的私钥）" style="width:100%;resize:vertical;font-family:monospace;"></textarea>' +
                '<button class="btn btn-secondary" id="qweatherConfigGenKey" style="margin-top:8px;width:100%;">一键生成密钥对（私钥自动填入，公钥去和风登记）</button>' +
                '</div>' +
                '<small style="color:var(--text-muted);">和风现采用 JWT(Ed25519) 认证。请在 <a href="#" id="qweatherConsoleLink2" class="link-accent">console.qweather.com</a> 的"项目管理→添加凭据"中选择 JWT 身份认证，上传你生成的<strong>公钥</strong>；这里填写<strong>私钥</strong>、凭据 ID 与项目 ID。私钥仅在本机加密存储，不会明文回显或上传。</small>' +
                '<div class="dialog-btn-row" style="margin-top:16px;">' +
                '<button class="btn btn-secondary" id="qweatherConfigCancel">取消</button>' +
                '<button class="btn btn-primary" id="qweatherConfigSave">保存</button>' +
                '</div>';

            var modal = showModal(html, function () {
                // 关闭时不做额外操作
            }, { replace: false });

            var hostEl = modal.dialog.querySelector('#qweatherConfigHost');
            var kidEl = modal.dialog.querySelector('#qweatherConfigKid');
            var subEl = modal.dialog.querySelector('#qweatherConfigSub');
            var privEl = modal.dialog.querySelector('#qweatherConfigPrivateKey');

            modal.dialog.querySelector('#qweatherConfigCancel').addEventListener('click', function () {
                modal.close();
            });

            modal.dialog.querySelector('#qweatherConfigSave').addEventListener('click', async function () {
                state.settings.qweatherApiHost = hostEl.value.trim();
                state.settings.qweatherKid = kidEl.value.trim();
                state.settings.qweatherSub = subEl.value.trim();
                // 私钥：留空 = 保持原值（不再覆盖成空）；填写了才更新
                var newPriv = privEl.value.trim();
                if (newPriv) state.settings.qweatherPrivateKey = newPriv;
                await saveSettings();
                // 更新状态显示
                updateQweatherStatus();
                // 更新链接文字
                var link = document.getElementById('qweatherConfigLink');
                if (link) {
                    link.textContent = (state.settings.qweatherApiHost && state.settings.qweatherKid && state.settings.qweatherSub && state.settings.qweatherPrivateKey) ? '修改 API 配置' : '配置 API 认证';
                }
                modal.close();
                // 重新加载天气
                loadWeather(getFirstCity());
            });

            // 和风控制台链接
            var consoleLink = modal.dialog.querySelector('#qweatherConsoleLink2');
            if (consoleLink && api && api.openExternal) {
                consoleLink.addEventListener('click', function (e) {
                    e.preventDefault();
                    api.openExternal('https://console.qweather.com/project');
                });
            }

            // 一键生成密钥对：主进程生成本地 ed25519，私钥自动填入，公钥弹窗供复制登记
            var genKeyBtn = modal.dialog.querySelector('#qweatherConfigGenKey');
            if (genKeyBtn) {
                genKeyBtn.addEventListener('click', async function () {
                    genKeyBtn.disabled = true;
                    genKeyBtn.textContent = '正在生成...';
                    try {
                        const res = api && api.qweather && await api.qweather.genKeyPair();
                        if (!res || !res.ok) {
                            toast('生成失败：' + ((res && res.error) || '未知错误'));
                            return;
                        }
                        // 私钥自动填入输入框
                        privEl.value = res.privateKey.trim();
                        // 弹窗公钥，提示去和风控制台登记
                        var pubModal = showModal(
                            '<h3>已生成密钥对</h3>' +
                            '<p style="font-size:0.8rem;color:var(--text-muted);margin:0 0 8px;">' +
                            '私钥已自动填入上方输入框，请勿外传。<br/>' +
                            '请复制以下<b>公钥</b>，到和风控制台「项目管理 → 添加凭据 → JWT」上传登记，' +
                            '并填写控制台返回的 Host / 凭据 ID（kid）/ 项目 ID（sub）。</p>' +
                            '<textarea id="genKeyPublic" rows="5" readonly style="width:100%;font-family:monospace;font-size:0.78rem;resize:vertical;">' +
                            escapeHtml(res.publicKey.trim()) + '</textarea>' +
                            '<div class="dialog-btn-row" style="margin-top:12px;">' +
                            '<button class="btn btn-primary" id="genKeyCopied">已去登记，关闭</button>' +
                            '</div>',
                            function () { /* 关闭时无额外操作 */ },
                            { replace: false }
                        );
                        pubModal.dialog.querySelector('#genKeyCopied').addEventListener('click', function () {
                            pubModal.close();
                        });
                    } catch (e) {
                        console.error('密钥生成失败:', e);
                        toast('生成失败，请稍后重试');
                    } finally {
                        genKeyBtn.disabled = false;
                        genKeyBtn.textContent = '一键生成密钥对（私钥自动填入，公钥去和风登记）';
                    }
                });
            }
        }

        // ---- 和风 API 状态展示（内联在「天气 API」标题右侧）+ 可用性检测 ----

        // 展开 / 折叠城市搜索 + 已添加城市区（贝塞尔曲线丝滑展开）
        function expandCitySection() {
            var sec = document.getElementById('weatherCitySection');
            if (!sec) return;
            sec.style.display = '';
            // 先确保有值可过渡：第一帧置当前高，第二帧过渡到目标高
            sec.style.maxHeight = '0px';
            sec.style.opacity = '1';
            requestAnimationFrame(function () {
                sec.style.maxHeight = sec.scrollHeight + 'px';
            });
            // 动画结束后解除固定高度，避免后续新增城市被裁剪（> 3 个时也能完整显示）
            setTimeout(function () {
                sec.style.maxHeight = 'none';
            }, 650);
        }

        function collapseCitySection() {
            var sec = document.getElementById('weatherCitySection');
            if (!sec) return;
            sec.style.maxHeight = 'none';        // 解除后取其真实高度用于收起
            void sec.offsetHeight;
            sec.style.maxHeight = sec.scrollHeight + 'px';
            void sec.offsetHeight;
            sec.style.maxHeight = '0px';
            sec.style.opacity = '0';
        }

        // 和风 provider 下，预警区仅在「检测通过」后才显示；未配置/检测中/不可用时一律折叠
        function updateAlertVisibility() {
            var alertGroup = document.getElementById('alertLevelGroup');
            if (!alertGroup) return;
            var isQweather = weatherProviderSelect && weatherProviderSelect.value === 'qweather';
            alertGroup.style.display = (isQweather && qwDetectionPassed) ? '' : 'none';
        }

        // mode: 'ok' | 'err' | 'loading' | 'unk'
        function setStatusUi(mode, text) {
            var dot = document.getElementById('qweatherStatusDot');
            var txt = document.getElementById('qweatherStatusText');
            var statusWrap = document.getElementById('qwStatusInline');
            if (!txt) return;
            updateAlertVisibility();
            if (mode === 'ok') {
                if (dot) { dot.className = ''; dot.style.background = '#1dc981'; }
                txt.textContent = text || '可用';
            } else if (mode === 'err') {
                if (dot) { dot.className = ''; dot.style.background = '#e8463a'; }
                txt.textContent = text || '不可用';
            } else if (mode === 'loading') {
                if (dot) { dot.className = 'qw-spinner'; dot.style.background = 'transparent'; }
                txt.textContent = text || '检测中…';
            } else {
                if (dot) { dot.className = ''; dot.style.background = '#9ca3af'; }
                txt.textContent = text || '';
            }
        }

        // 检测和风 API 可用性：发起一次实时天气请求（验证 Host/签名/凭据）。
        // 检测通过后自动展开城市搜索 / 已添加城市区。
        async function checkQweather() {
            var statusWrap = document.getElementById('qwStatusInline');
            if (statusWrap) statusWrap.style.display = '';
            if (!isQweatherConfigured()) {
                qwDetectionPassed = false;
                setStatusUi('unk', '未配置');
                collapseCitySection();
                return;
            }
            // 进入加载状态：圆环动画
            qwDetectionPassed = false;      // 检测中/未通过：预警区保持折叠
            setStatusUi('loading', '检测中…');
            // 取城市发起真实请求；若未添加城市，则用内置默认城市（北京）作为探测目标，
            // 仍能验证 Host / JWT 签名 / 凭据是否有效。
            var first = getFirstCity();
            try {
                var loc = (first && first.locationId) || '101010100'; // 默认探测城市：北京
                var getApi = api && api.qweather && api.qweather.get;
                var res = getApi ? await getApi({ endpoint: '/v7/weather/now', query: { location: loc } })
                                 : { ok: false, error: 'NO_CLIENT' };
                if (res && res.ok && res.data && res.data.code === '200') {
                    qwDetectionPassed = true;   // 检测通过：预警区才显示
                    setStatusUi('ok', '可用');
                    expandCitySection();   // 检测通过，丝滑展开城市区
                } else if (!res || !res.ok) {
                    var rerr = res && res.error ? res.error : '';
                    setStatusUi('err', '不可用 · ' + { NO_CONFIG: '未配置完整', NO_CLIENT: '组件未加载' }[rerr] || rerr || '请求失败');
                    collapseCitySection();
                } else {
                    setStatusUi('err', '返回异常 code=' + (res.data && res.data.code));
                    collapseCitySection();
                }
            } catch (e) {
                console.warn('[qweather] 可用性检测失败:', e);
                var reason = {
                    NO_CONFIG: '未配置完整',
                    PRIVATE_KEY_MISSING: '私钥缺失',
                    NO_CLIENT: '组件未加载',
                    UNKNOWN: '未知错误'
                }[e.message];
                setStatusUi('err', '不可用 · ' + (reason || e.message || '请求失败'));
                collapseCitySection();
            }
        }

        function updateQweatherStatus() {
            if (!isQweatherConfigured()) {
                setStatusUi('unk', '未配置');
                collapseCitySection();
                return;
            }
            // 配置完整：自动发起一次检测（通过则展开城市区）
            checkQweather();
        }

        document.getElementById('qweatherConfigLink').addEventListener('click', function (e) {
            e.preventDefault();
            openQweatherConfigDialog();
        });

        // 绑定初始化：若当前为和风且已配置，自动检测
        if (weatherProviderSelect.value === 'qweather' && isQweatherConfigured()) {
            updateQweatherStatus();
        }
    }
};