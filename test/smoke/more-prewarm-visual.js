// 预热栅格化可视探测：验证「启动预热是否把带 backdrop-filter 的面板画在了屏幕内」
// 用法：node test/smoke/more-prewarm-visual.js
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PORT = 9802;
const root = path.resolve(__dirname, '..', '..');
const electronBin = require('electron');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cwb-prewarm-vis-'));
const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwb-shots-'));

const child = spawn(electronBin, [
    '.',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userData}`,
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
        } catch (_) { /* 端口未就绪 */ }
        await sleep(500);
    }
    return null;
}

function send(wsUrl, method, params = {}) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timer = setTimeout(() => { ws.close(); reject(new Error('timeout: ' + method)); }, 30000);
        ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
        ws.onmessage = (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.id === 1) {
                clearTimeout(timer);
                ws.close();
                if (msg.error) reject(new Error(JSON.stringify(msg.error)));
                else resolve(msg.result);
            }
        };
        ws.onerror = (e) => { clearTimeout(timer); reject(e); };
    });
}

async function shot(wsUrl, name) {
    const r = await send(wsUrl, 'Page.captureScreenshot', { format: 'png' });
    const p = path.join(shotDir, name + '.png');
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    console.log('截图:', p);
    return p;
}

(async () => {
    try {
        const page = await getPageTarget();
        if (!page) throw new Error('未找到应用页面');
        await send(page.webSocketDebuggerUrl, 'Page.enable');

        // 直接调用应用内置预热并同步测量面板矩形
        await send(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
            expression: `(() => {
                if (window.AppMoreMenu && typeof window.AppMoreMenu.prewarmPaint === 'function') {
                    window.AppMoreMenu.prewarmPaint();
                }
                const panel = document.getElementById('moreSheetPanel');
                const r = panel.getBoundingClientRect();
                window.__prewarmRect = {
                    inViewport: r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth,
                    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
                };
                return 'measured';
            })()`,
            returnByValue: true
        });

        const rect = JSON.parse((await send(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
            expression: `JSON.stringify(window.__prewarmRect || {})`,
            returnByValue: true
        })).result.value);
        console.log('预热面板矩形:', JSON.stringify(rect));
        const anyOnScreen = !!(rect && rect.inViewport);
        console.log(anyOnScreen
            ? '✗ 预热把面板画在了屏幕内（会造成卡片抖动/背景色调变化）'
            : '✓ 预热在屏幕外完成（无可见影响）');
        process.exitCode = anyOnScreen ? 1 : 0;
    } catch (e) {
        console.error('探测失败:', e.message);
        process.exitCode = 1;
    } finally {
        child.kill();
        try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
    }
})();
