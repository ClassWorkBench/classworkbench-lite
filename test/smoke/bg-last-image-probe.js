// 背景"最后一张"回归探测：预置两张缓存图（current=bg-last.jpg），
// 启动后校验 bg:get 返回的正是 current（而非随机/其他图）
// 用法：node test/smoke/bg-last-image-probe.js
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PORT = 9804;
const root = path.resolve(__dirname, '..', '..');
const electronBin = require('electron');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cwb-bg-last-'));

// 预置：明文设置（跳过向导）+ 两张合法最小 JPEG 缓存，current 指向 bg-last.jpg
function fakeJpeg() {
    // FF D8 FF ... FF D9（>=16 字节，通过魔数校验）
    return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x00, 0xff, 0xd9]);
}
(function seed() {
    const bgDir = path.join(userData, 'bg-cache');
    fs.mkdirSync(bgDir, { recursive: true });
    fs.writeFileSync(path.join(bgDir, 'bg-last.jpg'), fakeJpeg());
    fs.writeFileSync(path.join(bgDir, 'bg-other.jpg'), fakeJpeg());
    fs.writeFileSync(path.join(bgDir, 'index.json'), JSON.stringify({
        current: 'bg-last.jpg',
        files: [
            { name: 'bg-last.jpg', size: fakeJpeg().length, ts: 2000 },
            { name: 'bg-other.jpg', size: fakeJpeg().length, ts: 1000 }
        ]
    }));
    fs.writeFileSync(path.join(userData, 'homework-data.enc'), JSON.stringify({
        homeworks: [],
        subjects: [],
        settings: { wizardCompleted: true, acceptedAgreementVersion: '1.0.0', schemaVersion: 1 }
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

async function getPageTarget() {
    for (let i = 0; i < 60; i++) {
        try {
            const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
            const page = list.find(t => t.type === 'page' && /index\.html/.test(t.url));
            if (page) return page;
        } catch (_) { /* 端口未就绪 */ }
        await sleep(300);
    }
    return null;
}

function evaluate(wsUrl, expression) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timer = setTimeout(() => { ws.close(); reject(new Error('evaluate timeout')); }, 30000);
        ws.onopen = () => ws.send(JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: { expression, returnByValue: true, awaitPromise: true }
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
        await sleep(1500);

        const result = await evaluate(page.webSocketDebuggerUrl, `(async () => {
            const bg = await window.electronAPI.getBackground();
            const layer = document.getElementById('bgLayer');
            return JSON.stringify({
                ipc: bg,
                applied: layer ? getComputedStyle(layer).backgroundImage.slice(0, 120) : ''
            });
        })()`);
        console.log('bg:get 结果:', result);
        const data = JSON.parse(result);
        const ok = data.ipc && data.ipc.ok && /bg-last\.jpg$/.test(data.ipc.url);
        console.log(ok
            ? '✓ 启动加载的是最后一次的图（index.current = bg-last.jpg）'
            : '✗ 启动未加载最后一张（见上方结果）');
        process.exitCode = ok ? 0 : 1;
    } catch (e) {
        console.error('探测失败:', e.message);
        process.exitCode = 1;
    } finally {
        child.kill();
        try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
    }
})();
