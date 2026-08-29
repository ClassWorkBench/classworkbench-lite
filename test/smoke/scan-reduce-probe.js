// 相机扫描浮窗「减弱动画」回归探测：主设置 reduceAnimation=true 时，
// 浮窗渲染层 body 必须挂上 reduce-anim 类
// 用法：node test/smoke/scan-reduce-probe.js
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PORT = 9811;
const root = path.resolve(__dirname, '..', '..');
const electronBin = require('electron');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cwb-scan-red-'));

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

(function seed() {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(path.join(userData, 'homework-data.enc'), JSON.stringify({
        homeworks: [],
        subjects: null,
        settings: {
            wizardCompleted: true,
            acceptedAgreementVersion: '1.0.1',
            schemaVersion: 1,
            dataEncryption: false,
            reduceAnimation: true
        }
    }), 'utf8');
})();

const child = spawn(electronBin, [
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

function evaluate(wsUrl, expression, awaitPromise = false) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timer = setTimeout(() => { ws.close(); reject(new Error('evaluate timeout')); }, 30000);
        ws.onopen = () => ws.send(JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: { expression, returnByValue: true, awaitPromise }
        }));
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
        await sleep(800);

        // 唤起扫描浮窗
        await evaluate(page.webSocketDebuggerUrl, `window.electronAPI.scan.open(['${TINY_PNG}'])`, true);
        await sleep(1500);

        const targets = await listTargets();
        const floater = targets.find(t => t.type === 'page' && /scan-floater\.html/.test(t.url));
        if (!floater) throw new Error('未找到扫描浮窗 target');
        const state = JSON.parse(await evaluate(floater.webSocketDebuggerUrl, `JSON.stringify({
            hasReduceClass: document.body.classList.contains('reduce-anim'),
            panelTransition: (function () {
                var p = document.getElementById('scanPanel');
                return p ? getComputedStyle(p).transition : '';
            })()
        })`));
        console.log('扫描浮窗状态:', JSON.stringify(state));
        const ok = state.hasReduceClass === true;
        console.log(ok
            ? '✓ 扫描粘贴面板已覆盖减弱动画（reduce-anim 生效）'
            : '✗ 未覆盖减弱动画');
        await evaluate(page.webSocketDebuggerUrl, 'window.electronAPI.scan.close()');
        process.exitCode = ok ? 0 : 1;
    } catch (e) {
        console.error('探测失败:', e.message);
        process.exitCode = 1;
    } finally {
        child.kill();
        try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
    }
})();
