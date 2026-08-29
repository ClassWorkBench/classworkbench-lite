// 作业草稿回归探测：点空白关闭添加/修改弹窗后，内容保留为草稿，
// 学科胶囊/作业卡片显示笔图标，重开弹窗内容恢复
// 用法：node test/smoke/draft-probe.js
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PORT = 9805;
const root = path.resolve(__dirname, '..', '..');
const electronBin = require('electron');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cwb-draft-'));

function fmt(d) {
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

(function seed() {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(path.join(userData, 'homework-data.enc'), JSON.stringify({
        homeworks: [{
            id: 'hw_test1',
            date: fmt(new Date()),
            subjectId: 'chinese',
            subjectName: '语文',
            content: '第一组作业'
        }],
        subjects: null,
        settings: {
            wizardCompleted: true,
            acceptedAgreementVersion: '1.0.1',
            schemaVersion: 1,
            dataEncryption: false,
            cardColumns: 3,
            autoNumber: true
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

// 模拟"点击空白关闭"：mousedown+mouseup 直接落在 overlay 上
const CLICK_OUTSIDE = `(() => {
    const overlay = document.querySelector('#modalRoot .overlay');
    if (!overlay) return 'no-overlay';
    overlay.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    overlay.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return 'clicked';
})()`;

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

        // ---- 添加草稿：输入 → 点空白关闭 ----
        await evaluate(page.webSocketDebuggerUrl, `window.AppDialogs.openAddDialog({ id: 'math', name: '数学' })`);
        await evaluate(page.webSocketDebuggerUrl, `(() => {
            const ta = document.getElementById('newContent');
            ta.value = '草稿内容A\\n第二行';
            return ta.value.length;
        })()`);
        await evaluate(page.webSocketDebuggerUrl, CLICK_OUTSIDE);
        await sleep(500);
        const afterAdd = JSON.parse(await evaluate(page.webSocketDebuggerUrl, `JSON.stringify({
            draft: (window.AppState.settings.drafts.add || {}).math || null,
            pillIcon: !!document.querySelector('.subject-pill[data-subject-id="math"] .pill-draft-icon'),
            pillIconColor: (function () {
                var i = document.querySelector('.subject-pill[data-subject-id="math"] .pill-draft-icon');
                return i ? getComputedStyle(i).backgroundColor : null;
            })(),
            pillColor: (function () {
                var p = document.querySelector('.subject-pill[data-subject-id="math"]');
                return p ? getComputedStyle(p).color : null;
            })()
        })`));
        console.log('添加草稿后:', JSON.stringify(afterAdd));

        // 重开添加弹窗 → 内容恢复
        await evaluate(page.webSocketDebuggerUrl, `window.AppDialogs.openAddDialog({ id: 'math', name: '数学' })`);
        const restored = await evaluate(page.webSocketDebuggerUrl, `document.getElementById('newContent').value`);
        console.log('重开恢复内容:', JSON.stringify(restored));

        // ---- 与 QQ 小红点共存检查：同一学科 草稿笔图标 + QQ 红点 ----
        await evaluate(page.webSocketDebuggerUrl, `(() => {
            const qq = window.AppState.settings.qq;
            if (!qq.pendingCandidates) qq.pendingCandidates = [];
            qq.pendingCandidates.push({ id: 'p1', subjectId: 'math', name: '测试同学', content: '第1题' });
            if (window.QQPending && window.QQPending.updatePendingBadge) {
                window.QQPending.updatePendingBadge();
            }
            return 'seeded';
        })()`);
        await sleep(200);
        const conflict = JSON.parse(await evaluate(page.webSocketDebuggerUrl, `JSON.stringify((function () {
            const btn = document.querySelector('.subject-pill[data-subject-id="math"]');
            const kids = Array.from(btn.children);
            const textSpan = btn.querySelector('.pill-text');
            const badge = btn.querySelector('.pill-badge-inline');
            const pen = btn.querySelector('.pill-draft-icon');
            return {
                hasPen: !!pen,
                hasBadge: !!badge,
                badgeAfterText: badge && textSpan ? kids.indexOf(badge) > kids.indexOf(textSpan) : false,
                order: kids.map(k => k.classList.contains('pill-text') ? 'text' : (k.classList.contains('pill-badge-inline') ? 'badge' : (k.classList.contains('pill-draft-icon') ? 'pen' : k.tagName))).join(' | ')
            };
        })())`));
        console.log('QQ 红点共存:', JSON.stringify(conflict));
        await evaluate(page.webSocketDebuggerUrl, `document.getElementById('btnCancel').click()`);
        await sleep(400);

        // ---- 修改草稿：改内容 → 点空白关闭 ----
        await evaluate(page.webSocketDebuggerUrl, `window.AppDialogs.openModifyDialog(window.AppState.homeworks.find(h => h.subjectId === 'chinese'))`);
        await evaluate(page.webSocketDebuggerUrl, `(() => {
            const ta = document.getElementById('modContent');
            ta.value = ta.value + '\\n新修改内容';
            return ta.value;
        })()`);
        await evaluate(page.webSocketDebuggerUrl, CLICK_OUTSIDE);
        await sleep(500);
        const afterEdit = JSON.parse(await evaluate(page.webSocketDebuggerUrl, `JSON.stringify({
            draft: (window.AppState.settings.drafts.edit || {}).hw_test1 || null,
            cardIcon: !!document.querySelector('.homework-card[data-hw-id="hw_test1"] .card-draft-icon'),
            cardIconColor: (function () {
                var i = document.querySelector('.homework-card[data-hw-id="hw_test1"] .card-draft-icon');
                return i ? getComputedStyle(i).backgroundColor : null;
            })(),
            cardSubjectColor: (function () {
                var s = document.querySelector('.homework-card[data-hw-id="hw_test1"] .card-subject');
                return s ? getComputedStyle(s).color : null;
            })()
        })`));
        console.log('修改草稿后:', JSON.stringify(afterEdit));

        // 重开修改弹窗 → 内容恢复
        await evaluate(page.webSocketDebuggerUrl, `window.AppDialogs.openModifyDialog(window.AppState.homeworks.find(h => h.subjectId === 'chinese'))`);
        const restoredEdit = await evaluate(page.webSocketDebuggerUrl, `document.getElementById('modContent').value`);
        console.log('重开恢复内容:', JSON.stringify(restoredEdit));
        await evaluate(page.webSocketDebuggerUrl, `document.getElementById('btnCancel2').click()`);

        const addOk = afterAdd.draft === '草稿内容A\n第二行' && afterAdd.pillIcon === true && restored === '草稿内容A\n第二行';
        const editOk = afterEdit.draft !== null && afterEdit.draft.indexOf('新修改内容') >= 0 && afterEdit.cardIcon === true && restoredEdit.indexOf('新修改内容') >= 0;
        const colorOk = afterAdd.pillIconColor === afterAdd.pillColor && afterEdit.cardIconColor === afterEdit.cardSubjectColor;
        const conflictOk = conflict.hasPen === true && conflict.hasBadge === true && conflict.badgeAfterText === true;
        console.log('追色校验: 胶囊', afterAdd.pillIconColor, '===', afterAdd.pillColor,
            '| 卡片', afterEdit.cardIconColor, '===', afterEdit.cardSubjectColor);
        console.log('\n结论:', addOk && editOk && colorOk && conflictOk
            ? '✓ 草稿/笔图标/追色/QQ红点共存 全部正常'
            : '✗ 存在异常（见上方输出）');
        process.exitCode = addOk && editOk && colorOk && conflictOk ? 0 : 1;
    } catch (e) {
        console.error('探测失败:', e.message);
        process.exitCode = 1;
    } finally {
        child.kill();
        try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
    }
})();
