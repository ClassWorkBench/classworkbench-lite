// 拍照搜题大体积图片多轮冒烟测试
// 重点验证豆包合成粘贴链：真实校验、file input 兜底、多轮成功率
// 用法：node test/smoke/solve-paste-cycle.js
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

// 避开 Windows Hyper-V 保留端口段（9255-9754 等）
const PORT = 9801;
const ROUNDS = 3;                  // 多轮冒烟轮数
const root = path.resolve(__dirname, '..', '..');
const electronBin = require('electron');

const child = spawn(electronBin, [
    '.',
    `--remote-debugging-port=${PORT}`,
    '--no-sandbox'
], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });

child.stdout.on('data', d => process.stdout.write('[app] ' + d));
child.stderr.on('data', d => process.stdout.write('[app-err] ' + d));

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getPageTarget() {
    for (let i = 0; i < 80; i++) {
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
        const timer = setTimeout(() => { ws.close(); reject(new Error('evaluate timeout')); }, 90000);
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

// 在渲染层用 canvas 生成一张大体积、内容复杂的题目照片（非简陋底图）
const GEN_BIG_IMG = `(function () {
    const W = 2000, H = 1500;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#f5f0e8';
    g.fillRect(0, 0, W, H);
    // 大量浅色噪点 + 随机线段 + 文字块，制造接近真实纸张的大体积画面
    for (let i = 0; i < 22000; i++) {
        g.fillStyle = 'rgba(' + Math.floor(Math.random()*80+40) + ',' + Math.floor(Math.random()*80+40) + ',' + Math.floor(Math.random()*80+40) + ',' + 0.08 + ')';
        const s = Math.random()*4 + 1;
        g.fillRect(Math.random()*W, Math.random()*H, s, s);
    }
    g.strokeStyle = '#202020';
    g.lineWidth = 3;
    for (let i = 0; i < 260; i++) {
        g.beginPath();
        g.moveTo(Math.random()*W, Math.random()*H);
        g.lineTo(Math.random()*W, Math.random()*H);
        g.stroke();
    }
    g.fillStyle = '#1a1a1a';
    g.font = 'bold 72px sans-serif';
    for (let i = 0; i < 32; i++) {
        g.fillText('例题 ' + (i + 1) + '：x² + 3x - 4 = 0 求根', 40, 160 + i * 90, W - 80);
    }
    try { window.__solveBigImg = c.toDataURL('image/png'); return window.__solveBigImg.length; }
    catch (e) { return -1; }
})()`;

(async () => {
    const report = [];
    try {
        const page = await getPageTarget();
        if (!page) throw new Error('未找到应用页面');
        let ready = false;
        for (let i = 0; i < 40 && !ready; i++) {
            ready = await evaluate(page.webSocketDebuggerUrl, '!!window.AppRegistry && window.AppRegistry.ready === true');
            if (!ready) await sleep(500);
        }
        if (!ready) throw new Error('渲染层未就绪');

        // 生成大体积图片
        const imgLen = await evaluate(page.webSocketDebuggerUrl, GEN_BIG_IMG);
        if (!imgLen || imgLen < 1) { throw new Error('大图生成失败'); }
        report.push(`大体积图片数据 URL 长度: ${imgLen} bytes`);

        // 如果块过长会卡，先确认图能进剪贴板不崩
        console.log('=== 大体积图片多轮冒烟（豆包） ===');
        for (let round = 1; round <= ROUNDS; round++) {
            console.log(`\n----- 第 ${round}/${ROUNDS} 轮 -----`);
            await evaluate(page.webSocketDebuggerUrl, 'window.electronAPI.solve.warmup()', true);
            await sleep(4000);
            const openResult = await evaluate(page.webSocketDebuggerUrl,
                `(async () => {
                    const t0 = performance.now();
                    const r = await window.electronAPI.solve.open({ image: window.__solveBigImg });
                    return Object.assign({}, r, { ms: Math.round(performance.now() - t0) });
                })()`, true);
            report.push(`第${round}轮 solve.open → ok=${openResult && openResult.ok}, pasted=${openResult && openResult.pasted}, ms=${openResult && openResult.ms}`);
            console.log(`open 返回:`, JSON.stringify(openResult));

            // 检查豆包页内真实出现了大图
            await sleep(9000);   // 等预览渲染
            const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
            const doubaoTarget = targets.find(t => /doubao\.com/.test(t.url));
            if (doubaoTarget) {
                const dom = await evaluate(doubaoTarget.webSocketDebuggerUrl,
                    `JSON.stringify({
                        ceImgs: (function(){var el=document.querySelector('[contenteditable="true"]');return el?el.querySelectorAll('img').length:-1;})(),
                        bigImgs: Array.prototype.slice.call(document.querySelectorAll('img')).filter(function(i){var r=i.getClientRects();return r.length&&r[0].width>=48&&r[0].height>=48;}).length
                    })`);
                const d = JSON.parse(dom);
                report.push(`第${round}轮豆包编辑区图数=${d.ceImgs}, 大图数=${d.bigImgs}`);
                console.log(`豆包编辑区图数=${d.ceImgs}, 大图数=${d.bigImgs}`);
            } else {
                report.push(`第${round}轮未找到豆包页面目标`);
                console.log('✗ 未找到豆包页面目标');
            }
            await evaluate(page.webSocketDebuggerUrl, 'window.electronAPI.solve.close()', true);
            await sleep(2500);
        }

        console.log('\n======== 汇总 ========');
        report.forEach(r => console.log('- ' + r));
        const passed = report.filter(r => /图数=[1-9]/.test(r)).length;
        console.log(`\n${passed > 0 ? '✓ 至少一轮出现图片，粘贴链有效' : '✗ 未在任何轮次看到编辑区图片'}`);
        process.exitCode = passed > 0 ? 0 : 1;
    } catch (e) {
        console.error('冒烟失败:', e.message);
        process.exitCode = 1;
    } finally {
        child.kill();
    }
})();