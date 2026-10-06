// 性能探针：验证「卡片渲染去重」生效，并对比「跳过重建」与「真实重建」的主线程耗时。
// 用法：node test/smoke/perf-probe.js   （退出码 0 通过 / 1 失败）
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PORT = 9817;
const root = path.resolve(__dirname, '..', '..');
const electronBin = require('electron');

function localDateStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cwb-perf-'));
(function seed() {
    const date = localDateStr();
    const subjects = [
        { id: 'chinese', name: '语文', color: '#d97a6a' },
        { id: 'math', name: '数学', color: '#6a7ad9' },
        { id: 'english', name: '英语', color: '#4ab8b8' },
        { id: 'physics', name: '物理', color: '#4a8ad9' },
        { id: 'chemistry', name: '化学', color: '#d97aaa' },
        { id: 'biology', name: '生物', color: '#4ab87a' },
        { id: 'history', name: '历史', color: '#d9a84a' },
        { id: 'politics', name: '政治', color: '#8a7ad9' }
    ];
    const homeworks = [];
    let n = 0;
    for (let r = 0; r < 3; r++) {
        for (const s of subjects) {
            n++;
            homeworks.push({
                id: `hw_perf_${n}`,
                subjectId: s.id,
                subjectName: s.name,
                content: `${r + 1}. 第 ${n} 条作业内容（性能测试）${'作业'.repeat((n % 5) + 1)}`,
                date
            });
        }
    }
    fs.writeFileSync(path.join(userData, 'homework-data.enc'), JSON.stringify({
        homeworks,
        subjects,
        settings: { wizardCompleted: true, acceptedAgreementVersion: '1.0.0', schemaVersion: 1, cardColumns: 3, beautifyNumber: true }
    }), 'utf8');
})();

const child = spawn(electronBin, [
    '.',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userData}`,
    '--no-sandbox',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding'
], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });

child.stdout.on('data', d => process.stdout.write('[app] ' + d));
child.stderr.on('data', d => process.stderr.write('[app-err] ' + d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPageTarget() {
    for (let i = 0; i < 60; i++) {
        try {
            const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
            const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
            if (page) return page;
        } catch (_) { /* 端口未就绪 */ }
        await sleep(500);
    }
    return null;
}

function evaluate(wsUrl, expression) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timer = setTimeout(() => { ws.close(); reject(new Error('evaluate timeout')); }, 60000);
        ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
        ws.onmessage = (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.id !== 1) return;
            clearTimeout(timer);
            ws.close();
            if (msg.result && msg.result.exceptionDetails) reject(new Error(JSON.stringify(msg.result.exceptionDetails)));
            else resolve(msg.result && msg.result.result ? msg.result.result.value : undefined);
        };
        ws.onerror = (e) => { clearTimeout(timer); reject(e); };
    });
}

const MEASURE = `(() => {
    const R = window.Renderer;
    if (!R || !R._perf) return JSON.stringify({ error: 'no perf hooks' });
    const cardCount = document.querySelectorAll('.homework-card').length;

    // 1) 状态不变：40 次 renderAll 应全部命中"跳过重建"
    const b1 = Object.assign({}, R._perf);
    const t0 = performance.now();
    for (let i = 0; i < 40; i++) R.renderAll();
    const skipMs = performance.now() - t0;
    const a1 = Object.assign({}, R._perf);

    // 2) 每次改动草稿（影响卡片）：10 次 renderAll 全部真实重建
    const t1 = performance.now();
    for (let i = 0; i < 10; i++) {
        window.AppState.settings.drafts.edit['hw_perf_1'] = 'x'.repeat(i + 1);
        R.renderAll();
    }
    const rebuildMs = performance.now() - t1;
    const a2 = Object.assign({}, R._perf);

    return JSON.stringify({
        cardCount: cardCount,
        skipCalls: 40, skipMs: skipMs,
        rebuildCalls: 10, rebuildMs: rebuildMs,
        skipsAdded: a1.cardSkips - b1.cardSkips,
        rebuildsAddedSkipPhase: a1.cardRebuilds - b1.cardRebuilds,
        rebuildsAddedRebuildPhase: a2.cardRebuilds - a1.cardRebuilds
    });
})()`;

(async () => {
    try {
        const page = await getPageTarget();
        if (!page) throw new Error('未找到应用页面');
        let ready = false;
        for (let i = 0; i < 40 && !ready; i++) {
            ready = await evaluate(page.webSocketDebuggerUrl, '!!window.AppRegistry && window.AppRegistry.ready === true && window.AppReady === true');
            if (!ready) await sleep(500);
        }
        if (!ready) throw new Error('渲染层未就绪');
        await sleep(800);

        const r = JSON.parse(await evaluate(page.webSocketDebuggerUrl, MEASURE));
        if (r.error) throw new Error(r.error);

        const perSkip = r.skipMs / r.skipCalls;
        const perRebuild = r.rebuildMs / r.rebuildCalls;
        console.log(`卡片数: ${r.cardCount}`);
        console.log(`跳过阶段: ${r.skipCalls} 次调用 共 ${r.skipMs.toFixed(1)}ms → 平均 ${perSkip.toFixed(2)}ms/次（跳过 ${r.skipsAdded} 次、重建 ${r.rebuildsAddedSkipPhase} 次）`);
        console.log(`重建阶段: ${r.rebuildCalls} 次调用 共 ${r.rebuildMs.toFixed(1)}ms → 平均 ${perRebuild.toFixed(2)}ms/次（重建 ${r.rebuildsAddedRebuildPhase} 次）`);
        console.log(`单次开销比: 重建 / 跳过 = ${(perRebuild / Math.max(perSkip, 0.0001)).toFixed(1)}x`);

        const ok = r.cardCount >= 20
            && r.skipsAdded === r.skipCalls
            && r.rebuildsAddedSkipPhase === 0
            && r.rebuildsAddedRebuildPhase === r.rebuildCalls
            && perRebuild > perSkip;
        console.log(ok ? '✓ 渲染去重生效：状态不变时零重建' : '✗ 去重未按预期生效');
        process.exitCode = ok ? 0 : 1;
    } catch (e) {
        console.error('探测失败:', e.message);
        process.exitCode = 1;
    } finally {
        if (child) {
            await new Promise((resolve) => {
                if (child.exitCode !== null || child.signalCode !== null) return resolve();
                child.once('exit', resolve);
                child.kill();
                setTimeout(resolve, 2500);
            });
        }
        try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
    }
})();
