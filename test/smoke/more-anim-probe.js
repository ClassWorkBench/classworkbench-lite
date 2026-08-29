// 「更多」菜单首开动画丢失复现探测
// 验证假设：元素首次从 visibility:hidden 转可见并同时启动 CSS 动画时，Chromium 会跳过动画
// 用法：node test/smoke/more-anim-probe.js
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PORT = 9801;
const root = path.resolve(__dirname, '..', '..');
const electronBin = require('electron');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cwb-more-anim-'));

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

async function openAndSample(wsUrl, clickExpr) {
    // 布防采样器 + 触发打开（记录动画真实时间线）
    await evaluate(wsUrl, `(() => {
        const panel = document.getElementById('moreSheetPanel');
        window.__samples = [];
        window.__started = 0;
        window.__ended = 0;
        window.__tStart = null;
        window.__tEnd = null;
        window.__tClick = null;
        window.__curTimes = [];
        window.__rafTimes = [];
        panel.addEventListener('animationstart', () => { window.__started++; window.__tStart = performance.now(); }, true);
        panel.addEventListener('animationend', () => { window.__ended++; window.__tEnd = performance.now(); }, true);
        const raf = () => {
            window.__samples.push(Number(getComputedStyle(panel).opacity));
            window.__rafTimes.push(Math.round(performance.now() - window.__tClick));
            const anims = panel.getAnimations();
            window.__curTimes.push(anims.length ? Number(anims[0].currentTime) : -1);
            if (window.__samples.length < 14) requestAnimationFrame(raf);
        };
        window.__tClick = performance.now();
        requestAnimationFrame(raf);
        ${clickExpr};
        return 'armed';
    })()`);
    await sleep(900);
    return evaluate(wsUrl, `JSON.stringify({
        samples: window.__samples,
        rafTimes: window.__rafTimes,
        curTimes: window.__curTimes,
        started: window.__started,
        ended: window.__ended,
        animMs: (window.__tEnd !== null && window.__tStart !== null) ? Math.round(window.__tEnd - window.__tStart) : null,
        startDelayMs: (window.__tStart !== null) ? Math.round(window.__tStart - window.__tClick) : null,
        open: document.getElementById('moreSheet').classList.contains('open'),
        sheetClass: document.getElementById('moreSheet').className,
        toggleAria: document.getElementById('moreToggle').getAttribute('aria-expanded'),
        animCount: document.getElementById('moreSheetPanel').getAnimations().length
    })`);
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
        // 手动初始化更多菜单并显式执行启动预热（不依赖向导流程）
        await evaluate(page.webSocketDebuggerUrl, `(() => {
            if (window.AppMoreMenu && typeof window.AppMoreMenu.init === 'function') {
                window.AppMoreMenu.init();
            }
            if (window.AppMoreMenu && typeof window.AppMoreMenu.prewarmPaint === 'function') {
                window.AppMoreMenu.prewarmPaint();
            }
            return 'ready';
        })()`);
        await sleep(800);   // 等待预热栅格化完成

        console.log('=== 场景A：首次打开（依赖应用内置启动预热） ===');
        const classOnly = JSON.parse(await openAndSample(page.webSocketDebuggerUrl, `(() => {
            const sheet = document.getElementById('moreSheet');
            sheet.classList.add('shown');
            void sheet.offsetHeight;
            requestAnimationFrame(() => requestAnimationFrame(() => sheet.classList.add('open')));
            return 'ok';
        })()`));
        console.log('opacity 采样:', classOnly.samples.map(v => v.toFixed(2)).join(' '));
        console.log('采样时刻(ms):', classOnly.rafTimes.join(' '));
        console.log('动画时间线: currentTime:', classOnly.curTimes.map(v => v === -1 ? '-' : Math.round(v)).join(' '));
        console.log('动画时长:', classOnly.animMs + 'ms', '| 点击→启动延迟:', classOnly.startDelayMs + 'ms');
        const longTasks = await evaluate(page.webSocketDebuggerUrl, `JSON.stringify(
            performance.getEntriesByType('longtask').map(function (t) {
                return { start: Math.round(t.startTime), dur: Math.round(t.duration) };
            })
        )`);
        console.log('Long Tasks:', longTasks);
        const resTiming = await evaluate(page.webSocketDebuggerUrl, `JSON.stringify(
            performance.getEntriesByType('resource').map(function (r) {
                return { name: r.name.split('/').pop(), start: Math.round(r.startTime), dur: Math.round(r.duration) };
            }).filter(function (r) { return r.dur > 30; })
        )`);
        console.log('耗时资源:', resTiming);

        // 关闭（纯 class）
        await evaluate(page.webSocketDebuggerUrl, `(() => {
            const sheet = document.getElementById('moreSheet');
            sheet.classList.remove('open');
            sheet.classList.add('closing');
            sheet.classList.remove('shown');
            return 'closed';
        })()`);
        await sleep(500);

        console.log('\n=== 场景B：点击按钮打开（完整 handler） ===');
        const second = JSON.parse(await openAndSample(page.webSocketDebuggerUrl, `document.getElementById('moreToggle').click()`));
        console.log('opacity 采样:', second.samples.map(v => v.toFixed(2)).join(' '));
        console.log('采样时刻(ms):', second.rafTimes.join(' '));
        console.log('动画时间线: currentTime:', second.curTimes.map(v => v === -1 ? '-' : Math.round(v)).join(' '));
        console.log('animationstart 次数:', second.started, '| animationend 次数:', second.ended);
        console.log('动画时长:', second.animMs + 'ms', '| 点击→启动延迟:', second.startDelayMs + 'ms');

        // 回归断言：首次打开必须有中间帧（动画未被吞）
        const firstAnimated = classOnly.samples.some(v => v > 0.01 && v < 0.99);
        const secondAnimated = second.samples.some(v => v > 0.01 && v < 0.99);
        const firstSmooth = classOnly.rafTimes.length > 3 &&
            (classOnly.rafTimes[3] - classOnly.rafTimes[2]) < 200;   // 前几帧无长间隙
        console.log('\n结论:', firstAnimated && secondAnimated && firstSmooth
            ? '✓ 首次打开动画正常（有中间帧、无长间隙）'
            : '✗ 首次打开动画异常（被跳过/有长间隙）');
        process.exitCode = (firstAnimated && secondAnimated && firstSmooth) ? 0 : 1;
    } catch (e) {
        console.error('探测失败:', e.message);
        process.exitCode = 1;
    } finally {
        child.kill();
        try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
    }
})();
