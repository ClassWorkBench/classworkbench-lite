// Lite 精简版启动冒烟：渲染层模块完整性 + 更多菜单 + 设置面板可打开
// 用法：node test/smoke/boot-probe.js
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PORT = 12001;
const root = path.resolve(__dirname, '..', '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cwb-boot-'));

(function seed() {
    fs.writeFileSync(path.join(userData, 'homework-data.enc'), JSON.stringify({
        homeworks: [],
        subjects: null,
        settings: { wizardCompleted: true, acceptedAgreementVersion: '1.0.0', schemaVersion: 1 }
    }), 'utf8');
})();

const child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [
    '.',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userData}`,
    '--no-sandbox'
], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });

child.stdout.on('data', d => process.stdout.write('[app] ' + d));
child.stderr.on('data', d => process.stdout.write('[app-err] ' + d));

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function listTargets() {
    try { return await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json()); }
    catch (_) { return []; }
}

async function getPageTarget() {
    for (let i = 0; i < 60; i++) {
        const list = await listTargets();
        const page = list.find(t => t.type === 'page' && /index\.html/.test(t.url));
        if (page) return page;
        await sleep(300);
    }
    return null;
}

function evaluate(wsUrl, expression) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timer = setTimeout(() => { ws.close(); reject(new Error('evaluate timeout')); }, 20000);
        ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
        ws.onmessage = (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.id === 1) {
                clearTimeout(timer);
                ws.close();
                if (msg.result && msg.result.exceptionDetails) reject(new Error(JSON.stringify(msg.result.exceptionDetails)));
                else resolve(msg.result && msg.result.result ? msg.result.result.value : undefined);
            }
        };
        ws.onerror = (e) => { clearTimeout(timer); reject(e); };
    });
}

(async () => {
    try {
        const page = await getPageTarget();
        if (!page) throw new Error('未找到应用页面');
        let ready = false;
        for (let i = 0; i < 40 && !ready; i++) {
            ready = await evaluate(page.webSocketDebuggerUrl, '!!window.AppRegistry && window.AppRegistry.ready === true');
            if (!ready) await sleep(500);
        }
        await sleep(1200);
        const probe = JSON.parse(await evaluate(page.webSocketDebuggerUrl, `JSON.stringify({
            ready: !!(window.AppRegistry && window.AppRegistry.ready),
            errors: (window.AppRegistry && window.AppRegistry.errors) || [],
            removedModules: {
                AppSolve: typeof window.AppSolve,
                AppScan: typeof window.AppScan,
                QQPending: typeof window.QQPending
            },
            menuItems: Array.prototype.slice.call(document.querySelectorAll('#moreSheetPanel .more-item')).map(function (b) { return b.id; }),
            settingsModules: Object.keys(window.SettingsModules || {})
        })`));
        console.log('渲染层探测:', JSON.stringify(probe, null, 0));
        const ok = probe.ready && probe.errors.length === 0
            && probe.removedModules.AppSolve === 'undefined'
            && probe.removedModules.AppScan === 'undefined'
            && probe.removedModules.QQPending === 'undefined'
            && probe.menuItems.indexOf('solveSearchBtn') < 0
            && probe.menuItems.indexOf('scanBtn') < 0
            && probe.settingsModules.indexOf('solve') < 0
            && probe.settingsModules.indexOf('qq') < 0;
        console.log(ok ? '✓ Lite 渲染层完整（被删模块全部移除、无报错）' : '✗ 存在问题');
        process.exitCode = ok ? 0 : 1;
    } catch (e) {
        console.error('探测失败:', e.message);
        process.exitCode = 1;
    } finally {
        child.kill();
        try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
    }
})();
