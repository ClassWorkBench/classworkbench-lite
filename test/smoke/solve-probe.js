// 拍照搜题冒烟探测：启动应用 → CDP 检查渲染层模块/按钮/图标是否就位
// 用法：node test/smoke/solve-probe.js
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

// 注意：避开 Windows Hyper-V 保留端口段（9255-9754 等），否则 Chromium 无法绑定
const PORT = 9800;
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const root = path.resolve(__dirname, '..', '..');
const electronBin = require('electron'); // 在 node 下 require('electron') 返回可执行文件路径
// 注意：不复用临时 userData，使用默认分区（保留豆包/DeepSeek 的已登录会话），
//       这样才能在真实使用场景下验证“加载→识图→粘贴”链路

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
        } catch (_) { /* 端口未就绪 */ }
        await sleep(500);
    }
    return null;
}

function evaluate(wsUrl, expression, awaitPromise = false) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timer = setTimeout(() => { ws.close(); reject(new Error('evaluate timeout')); }, 60000);
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
        // 等模块加载完成
        let ready = false;
        for (let i = 0; i < 40 && !ready; i++) {
            ready = await evaluate(page.webSocketDebuggerUrl, '!!window.AppRegistry && window.AppRegistry.ready === true');
            if (!ready) await sleep(500);
        }
        const probe = await evaluate(page.webSocketDebuggerUrl, `JSON.stringify({
            registryReady: window.AppRegistry ? window.AppRegistry.ready : false,
            registryErrors: window.AppRegistry ? window.AppRegistry.errors : null,
            appSolve: typeof window.AppSolve,
            solveSettingsModule: typeof (window.SettingsModules || {}).solve,
            solveBtnInDom: !!document.getElementById('solveSearchBtn'),
            cameraEmojiInDom: !!document.querySelector('img[src="emoji/camera_color.svg"]'),
            solveSettingsDefaults: JSON.stringify((window.AppState.settings || {}).solve)
        })`);
        console.log('=== 渲染层探测结果 ===');
        console.log(probe);
        const data = JSON.parse(probe);
        const checks = {
            registryReady: data.registryReady === true,
            registryClean: Array.isArray(data.registryErrors) && data.registryErrors.length === 0,
            appSolve: data.appSolve === 'object',
            solveSettingsModule: data.solveSettingsModule === 'object',
            solveBtnInDom: data.solveBtnInDom === true,
            cameraEmojiInDom: data.cameraEmojiInDom === true,
            solveDefaults: !!(data.solveSettingsDefaults && data.solveSettingsDefaults.includes('autoScan'))
        };
        const failed = Object.keys(checks).filter(k => !checks[k]);
        console.log(failed.length ? '✗ 缺失项: ' + failed.join(', ') : '\n✓ 拍照搜题渲染层就位');
        process.exitCode = failed.length ? 1 : 0;

        // ---- 主进程链路：调用 solve.open 建内嵌豆包窗口（最长等待页面加载 25s） ----
        console.log('\n=== 主进程链路探测（内嵌豆包窗口） ===');
        // 预热：后台加载豆包页面（冷启动时模拟“拍照期间预热”）
        await evaluate(page.webSocketDebuggerUrl, 'window.electronAPI.solve.warmup()', true);
        await sleep(4000);
        const openResult = await evaluate(page.webSocketDebuggerUrl,
            `(async () => {
                const t0 = performance.now();
                const r = await window.electronAPI.solve.open({ image: '${TINY_PNG}' });
                return Object.assign({}, r, { ms: Math.round(performance.now() - t0) });
            })()`, true);
        console.log('solve.open 返回:', JSON.stringify(openResult));
        await sleep(1500);
        const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
        const doubaoTarget = targets.find(t => /doubao\.com/.test(t.url));
        console.log('豆包窗口目标:', doubaoTarget ? doubaoTarget.url : '未找到');
        if (openResult && openResult.ok && !doubaoTarget) {
            console.error('✗ 窗口已建但未找到 doubao 页面目标');
            process.exitCode = 1;
        } else if (openResult && openResult.ok) {
            console.log('✓ 内嵌豆包窗口创建成功（pasted=' + openResult.pasted + '）');
        } else {
            console.log('（open 返回失败，链路错误路径正常返回）');
        }

        // ---- 豆包页面 DOM 结构探查（输入框/文件上传/粘贴结果） ----
        if (doubaoTarget) {
            await sleep(10000);   // 等豆包上传预览渲染（实测有 5-40s 延迟）
            const domInfo = await evaluate(doubaoTarget.webSocketDebuggerUrl, `JSON.stringify({
                title: document.title,
                url: location.href,
                textareas: Array.prototype.slice.call(document.querySelectorAll('textarea')).map(function (t) {
                    var r = t.getClientRects();
                    return { ph: (t.placeholder || '').slice(0, 30), vis: !!r.length, w: t.offsetWidth, h: t.offsetHeight };
                }).slice(0, 6),
                contenteditables: document.querySelectorAll('[contenteditable="true"]').length,
                fileInputs: Array.prototype.slice.call(document.querySelectorAll('input[type="file"]')).map(function (f) {
                    var r = f.getClientRects();
                    return { accept: (f.accept || '').slice(0, 60), vis: !!r.length };
                }).slice(0, 6),
                bigImgs: Array.prototype.slice.call(document.querySelectorAll('img')).filter(function (i) {
                    var r = i.getClientRects();
                    return r.length && r[0].width >= 48 && r[0].height >= 48;
                }).length,
                ceImgs: (function () {
                    var ce = document.querySelector('[contenteditable="true"]');
                    return ce ? ce.querySelectorAll('img').length : -1;
                })(),
                imgSrcs: Array.prototype.slice.call(document.querySelectorAll('img')).map(function (i) {
                    var r = i.getClientRects();
                    var s = (i.getAttribute('src') || '').slice(0, 80);
                    return (r.length ? 'V' : 'H') + ' ' + (i.offsetWidth) + 'x' + (i.offsetHeight) + ' ' + s;
                }).slice(0, 10),
                active: (document.activeElement ? document.activeElement.tagName + '.' + document.activeElement.className : 'none').slice(0, 80)
            })`);
            console.log('=== 豆包 DOM 结构 ===');
            console.log(domInfo);
        }
        await evaluate(page.webSocketDebuggerUrl, 'window.electronAPI.solve.close()', true);
        await sleep(800);
        console.log('✓ 已关闭豆包窗口');

        // ---- 双站调度：切到 DeepSeek（应秒切、不闪现旧站） ----
        console.log('\n=== 双站调度探测（切 DeepSeek） ===');
        const dsResult = await evaluate(page.webSocketDebuggerUrl,
            `(async () => {
                const t0 = performance.now();
                const r = await window.electronAPI.solve.open({ image: '${TINY_PNG}', provider: 'deepseek' });
                return Object.assign({}, r, { ms: Math.round(performance.now() - t0) });
            })()`, true);
        console.log('deepseek.open 返回:', JSON.stringify(dsResult));
        await sleep(1200);
        const targets2 = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
        const dsTarget = targets2.find(t => /chat\.deepseek\.com/.test(t.url));
        const dbTarget = targets2.find(t => /doubao\.com/.test(t.url));
        console.log('DeepSeek 目标:', dsTarget ? dsTarget.url : '未找到', '| 单视图下豆包已释放:', !dbTarget);
        if (dsResult && dsResult.ok && dsTarget) {
            console.log('✓ 双站调度正常（DeepSeek 就绪 + 粘贴，耗时 ' + dsResult.ms + 'ms）');
        } else {
            console.log('（deepseek 未就绪：网络/风控环境下属正常错误路径）');
        }
        await evaluate(page.webSocketDebuggerUrl, 'window.electronAPI.solve.close()', true);
    } catch (e) {
        console.error('探测失败:', e.message);
        process.exitCode = 1;
    } finally {
        child.kill();
    }
})();
