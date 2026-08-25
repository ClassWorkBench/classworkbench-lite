// 相机扫描浮窗几何探针（完整流程）：open → 展开 → 收缩 → 第二轮 open，读取 OS 窗口尺寸/位置。
// 用法：node test/smoke/scan-floater-geo.js
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const electronBin = require('electron');

const PORT = 9811;
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const child = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', d => process.stdout.write('[app] ' + d));
child.stderr.on('data', d => process.stdout.write('[app-err] ' + d));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getPageTarget() {
    for (let i = 0; i < 60; i++) {
        try {
            const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
            const p = list.find(t => t.type === 'page' && /index\.html/.test(t.url));
            if (p) return p;
        } catch (_) {}
        await sleep(500);
    }
    return null;
}
function evaluate(wsUrl, expression, awaitPromise = false) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 30000);
        ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate',
            params: { expression, returnByValue: true, awaitPromise } }));
        ws.onmessage = (ev) => { const m = JSON.parse(ev.data);
            if (m.id === 1) { clearTimeout(timer); ws.close();
                if (m.result && m.result.exceptionDetails) reject(new Error(JSON.stringify(m.result.exceptionDetails)));
                else resolve(m.result && m.result.result ? m.result.result.value : undefined); } };
        ws.onerror = (e) => { clearTimeout(timer); reject(e); };
    });
}
async function findFloater() {
    const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
    return list.find(t => t.type === 'page' && /scan-floater\.html/.test(t.url)) || null;
}
const GEOM = `JSON.stringify({ sx: window.screenX, sy: window.screenY, ow: window.outerWidth, oh: window.outerHeight })`;

(async () => {
    try {
        const page = await getPageTarget();
        if (!page) throw new Error('未找到应用页面');
        for (let i = 0; i < 40; i++) {
            if (await evaluate(page.webSocketDebuggerUrl, '!!window.electronAPI && !!window.electronAPI.scan')) break;
            await sleep(400);
        }
        await evaluate(page.webSocketDebuggerUrl, `window.electronAPI.scan.open(['${TINY_PNG}','${TINY_PNG}'])`, true);
        await sleep(1500);
        let f = await findFloater();
        console.log('R1 open       :', f ? await evaluate(f.webSocketDebuggerUrl, GEOM) : '无');
        if (f) {
            await evaluate(f.webSocketDebuggerUrl, `document.getElementById('floatHit').click(); 'x'`);
            await sleep(700);
            console.log('R1 click展开  :', await evaluate(f.webSocketDebuggerUrl, GEOM), await evaluate(f.webSocketDebuggerUrl, 'document.body.className'));
        }
        // 通过 MAIN 直接收缩（等价于渲染层「插入完成→自动收缩」走到的 api.shape）
        await evaluate(page.webSocketDebuggerUrl, `window.electronAPI.scan.shape('collapsed')`, true);
        await sleep(500);
        console.log('R1 收缩       :', f ? await evaluate(f.webSocketDebuggerUrl, GEOM) : '无');
        // 第二轮
        await evaluate(page.webSocketDebuggerUrl, `window.electronAPI.scan.open(['${TINY_PNG}'])`, true);
        await sleep(1200);
        f = await findFloater();
        console.log('R2 open       :', f ? await evaluate(f.webSocketDebuggerUrl, GEOM) : '无');
        await evaluate(page.webSocketDebuggerUrl, `window.electronAPI.scan.close()`, true).catch(() => {});
        await sleep(300);
        child.kill();
    } catch (e) {
        console.error('探测失败:', e.message);
        process.exitCode = 1;
        child.kill();
    }
})();