// 相机扫描浮窗探针（复现"第二轮无法弹出面板"）：通过主窗口 CDP 直接调用
// electronAPI.scan.open 两轮，检查浮窗 target 是否存活/复用/重建、渲染层状态。
// 用法：node test/smoke/scan-floater-probe.js
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const electronBin = require('electron');

const PORT = 9810;

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const child = spawn(electronBin, [
    '.',
    `--remote-debugging-port=${PORT}`,
    '--no-sandbox'
], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });

child.stdout.on('data', d => process.stdout.write('[app] ' + d));
child.stderr.on('data', d => process.stdout.write('[app-err] ' + d));

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getPageTarget() {
    for (let i = 0; i < 60; i++) {
        try {
            const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
            const page = list.find(t => t.type === 'page' && /index\.html/.test(t.url));
            if (page) return page;
        } catch (_) {}
        await sleep(500);
    }
    return null;
}

function evaluate(wsUrl, expression, awaitPromise = false) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 30000);
        ws.onopen = () => ws.send(JSON.stringify({
            id: 1, method: 'Runtime.evaluate',
            params: { expression, returnByValue: true, awaitPromise }
        }));
        ws.onmessage = (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.id === 1) {
                clearTimeout(timer); ws.close();
                if (msg.result && msg.result.exceptionDetails) reject(new Error(JSON.stringify(msg.result.exceptionDetails)));
                else resolve(msg.result && msg.result.result ? msg.result.result.value : undefined);
            }
        };
        ws.onerror = (e) => { clearTimeout(timer); reject(e); };
    });
}

async function findFloater() {
    const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
    return list.find(t => t.type === 'page' && /scan-floater\.html/.test(t.url)) || null;
}

(async () => {
    try {
        const page = await getPageTarget();
        if (!page) throw new Error('未找到应用页面');
        for (let i = 0; i < 40; i++) {
            if (await evaluate(page.webSocketDebuggerUrl, '!!window.electronAPI && !!window.electronAPI.scan')) break;
            await sleep(400);
        }

        const R1 = await evaluate(page.webSocketDebuggerUrl, `(async () => {
            const r = await window.electronAPI.scan.open(['${TINY_PNG}', '${TINY_PNG}']);
            return r;
        })()`, true);
        await sleep(1200);
        const f1 = await findFloater();
        const state1 = f1 ? await evaluate(f1.webSocketDebuggerUrl,
            `JSON.stringify({ bodyClass: document.body.className, badgeHidden: (document.getElementById('floatBadge')||{}).hidden, badgeTxt: (document.getElementById('floatBadge')||{}).textContent })`) : null;
        console.log('=== 第一轮 ===');
        console.log('open 返回:', JSON.stringify(R1));
        console.log('浮窗 target:', f1 ? 'id=' + f1.id : '未找到');
        console.log('浮窗渲染态:', state1);

        // 模拟"展开→全部插入→收缩"
        await evaluate(page.webSocketDebuggerUrl, `window.electronAPI.scan.shape('expanded')`, true);
        await sleep(500);
        await evaluate(page.webSocketDebuggerUrl, `window.electronAPI.scan.shape('collapsed')`, true);
        await sleep(500);

        // 第二轮：再 open 一次（不复用扫描表单，直接模拟"第二次点击完成"）
        const R2 = await evaluate(page.webSocketDebuggerUrl, `(async () => {
            const r = await window.electronAPI.scan.open(['${TINY_PNG}']);
            return r;
        })()`, true);
        await sleep(1500);
        const f2 = await findFloater();
        const state2 = f2 ? await evaluate(f2.webSocketDebuggerUrl,
            `JSON.stringify({ bodyClass: document.body.className, badgeHidden: (document.getElementById('floatBadge')||{}).hidden, badgeTxt: (document.getElementById('floatBadge')||{}).textContent, scanPanelShown: getComputedStyle(document.getElementById('scanPanel')).display, successShown: (document.getElementById('scanSuccess')||{}).className })`) : null;
        console.log('\n=== 第二轮 ===');
        console.log('open 返回:', JSON.stringify(R2));
        console.log('浮窗 target:', f2 ? 'id=' + f2.id : '未找到');
        console.log('浮窗渲染态:', state2);
        console.log('\n复用判断:', (f1 && f2) ? (f1.id === f2.id ? '同一浮窗（REUSED）' : '不同浮窗（RECREATED）') : (f2 ? '仅第二轮有' : '两轮都没有'));

        await evaluate(page.webSocketDebuggerUrl, `window.electronAPI.scan.close()`, true).catch(() => {});
        await sleep(500);
        child.kill();
    } catch (e) {
        console.error('探测失败:', e.message);
        process.exitCode = 1;
        child.kill();
    }
})();