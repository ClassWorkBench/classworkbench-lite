// 天气面板重构冒烟：启动应用 → 打开设置 → 切到天气面板 → 校验渲染/绑定/无加载错误
// 用法：node test/smoke/weather-panel.js  （退出码 0 通过 / 1 失败）
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PORT = 9813;
const root = path.resolve(__dirname, '..', '..');
const electronBin = require('electron');

// 隔离用户数据目录：不写真实 %APPDATA%，并把协议版本设为当前值避免向导遮挡
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cwb-weather-'));
fs.writeFileSync(path.join(userData, 'homework-data.enc'), JSON.stringify({
    homeworks: [], subjects: null,
    settings: { wizardCompleted: true, acceptedAgreementVersion: '1.0.0', schemaVersion: 1 }
}), 'utf8');

const child = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`, '--no-sandbox'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', d => process.stdout.write('[app] ' + d));
child.stderr.on('data', d => process.stdout.write('[app-err] ' + d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPageTarget() {
    for (let i = 0; i < 60; i++) {
        try {
            const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
            const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
            if (page) return page;
        } catch (_) { }
        await sleep(500);
    }
    return null;
}

class CDP {
    constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; }
    send(method, params) {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(this.wsUrl);
            const id = ++this.id;
            const timer = setTimeout(() => { ws.close(); reject(new Error(method + ' timeout')); }, 30000);
            ws.onopen = () => ws.send(JSON.stringify({ id, method, params: params || {} }));
            ws.onmessage = (ev) => {
                const msg = JSON.parse(ev.data);
                if (msg.id !== id) return;
                clearTimeout(timer);
                ws.close();
                if (msg.error) reject(new Error(method + ': ' + JSON.stringify(msg.error)));
                else resolve(msg.result);
            };
            ws.onerror = (e) => { clearTimeout(timer); reject(e); };
        });
    }
    async eval(expression) {
        const r = await this.send('Runtime.evaluate', { expression, returnByValue: true });
        if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
        return r.result ? r.result.value : undefined;
    }
}

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name} ${detail}`); }
};

(async () => {
    let cdp = null;
    try {
        const page = await getPageTarget();
        if (!page) throw new Error('未找到应用页面');
        cdp = new CDP(page.webSocketDebuggerUrl);

        let ready = false;
        for (let i = 0; i < 40 && !ready; i++) {
            ready = await cdp.eval('!!window.AppRegistry && window.AppRegistry.ready === true');
            if (!ready) await sleep(500);
        }
        check('渲染层就绪', ready);

        // 模块加载无错误（新增 5 个文件后重点核对）
        const modErr = await cdp.eval('window.AppRegistry.errors.length');
        check('registry 无模块加载/契约错误', modErr === 0, `(got ${modErr} 个错误)`);

        // 子模块全局都已按契约注入（SettingsModules.weather 为点路径，与 registry 解析方式一致）
        const globals = await cdp.eval(`['WeatherStore','WeatherView','WeatherCity','WeatherQweather','WeatherMisc','SettingsModules.weather'].map(function(n){
            var ok = n.split('.').reduce(function(o,k){ return o == null ? undefined : o[k]; }, window);
            return [n, ok !== undefined];
        })`);
        check('5 个子模块 + weather 契约全部就位', globals.every(([, ok]) => ok), `(got ${JSON.stringify(globals)})`);

        // 打开设置 → 切到天气面板（触发 render + bind）
        await cdp.eval(`document.getElementById('openSettingsBtn').click()`);
        await sleep(550);
        await cdp.eval(`document.querySelector('.settings-nav-item[data-panel="weather"]').click()`);
        await sleep(350);

        const s = JSON.parse(await cdp.eval(`JSON.stringify((function(){
            var ids = ['weatherProviderSelect','qwStatusInline','weatherCitySection','weatherSearchInput','weatherSearchResults','weatherCityList','alertLevelGroup','weatherRefreshIntervalSelect','weatherRefreshModeSelect','qweatherConfigLink'];
            var elems = {};
            ids.forEach(function(id){ elems[id] = !!document.getElementById(id); });
            var items = document.querySelectorAll('#weatherCityList .weather-city-item').length;
            var empty = document.querySelectorAll('#weatherCityList .weather-city-empty').length;
            var activePanel = (document.querySelector('.settings-panel.active') || {}).id;
            return { elems: elems, items: items, empty: empty, activePanel: activePanel,
                     provider: (document.getElementById('weatherProviderSelect')||{}).value,
                     citySectionDisplay: document.getElementById('weatherCitySection').style.display,
                     citySectionOpacity: document.getElementById('weatherCitySection').style.opacity };
        })())`));

        const allPresent = Object.keys(s.elems).every(k => s.elems[k] === true);
        check('天气面板已激活', s.activePanel === 'panel-weather', `(got ${s.activePanel})`);
        check('天气面板全部关键元素已渲染', allPresent, `(缺失: ${Object.keys(s.elems).filter(k => !s.elems[k]).join(',') || '无'})`);

        // bind 未抛错：provider 初始值应正常（非 qweather 打开态），城市列表要么有项要么有空态
        check('城市列表渲染（有项或空态）', s.items > 0 || s.empty > 0, `(items=${s.items} empty=${s.empty})`);
        check('provider 初始值正确', s.provider === 'openmeteo' || s.provider === 'qweather', `(got ${s.provider})`);

        // Esc 关闭设置
        await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); document.dispatchEvent(new KeyboardEvent('keyup',{key:'Escape',bubbles:true}));`);
        await sleep(300);

        const summary = `\n=== weather 面板重构冒烟结果: ${pass} 通过, ${fail} 失败 ===`;
        console.log(summary);
        process.exitCode = fail ? 1 : 0;
    } catch (e) {
        console.error('探测失败:', e.message);
        process.exitCode = 1;
    } finally {
        if (child) child.kill();
        await sleep(500);
        try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
    }
})();
