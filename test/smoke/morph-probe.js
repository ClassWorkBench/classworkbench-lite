// 形变动画探针：验证「底部胶囊 → 对话框」入场形变与「保存 → 收束回卡片」退场形变。
// 用法：node test/smoke/morph-probe.js   （退出码 0 通过 / 1 失败）
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PORT = 9819;
const root = path.resolve(__dirname, '..', '..');
const electronBin = require('electron');

function localDateStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cwb-morph-'));
(function seed() {
    const date = localDateStr();
    fs.writeFileSync(path.join(userData, 'homework-data.enc'), JSON.stringify({
        homeworks: [{
            id: 'hw_seed_1', subjectId: 'chinese', subjectName: '语文',
            content: '1. 已有作业', date
        }],
        subjects: null,
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
        const timer = setTimeout(() => { ws.close(); reject(new Error('evaluate timeout')); }, 30000);
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

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name} ${detail}`); }
};

(async () => {
    let cdpUrl = null;
    try {
        const page = await getPageTarget();
        if (!page) throw new Error('未找到应用页面');
        cdpUrl = page.webSocketDebuggerUrl;
        let ready = false;
        for (let i = 0; i < 40 && !ready; i++) {
            ready = await evaluate(cdpUrl, '!!window.AppRegistry && window.AppRegistry.ready === true && window.AppReady === true');
            if (!ready) await sleep(500);
        }
        check('渲染层就绪', ready);
        await sleep(700);

        console.log('\n[1] 入场：底部胶囊 → 对话框（共享元素形变）');
        await evaluate(cdpUrl, `document.querySelector('.subject-pill[data-subject-id="math"]').click()`);
        const openState = JSON.parse(await evaluate(cdpUrl, `JSON.stringify({
            dialog: !!document.querySelector('.dialog'),
            dialogMorph: !!(document.querySelector('.dialog') || {}).classList && document.querySelector('.dialog').classList.contains('morph'),
            overlayMorph: !!(document.querySelector('.overlay') || {}).classList && document.querySelector('.overlay').classList.contains('morph'),
            bodyMorphOpen: document.body.classList.contains('morph-open'),
            transform: (document.querySelector('.dialog') || {}).style ? document.querySelector('.dialog').style.transform : ''
        })`));
        check('对话框已创建', openState.dialog === true);
        check('对话框进入形变模式(.morph)', openState.dialogMorph === true);
        check('蒙层进入形变模式(.overlay.morph)', openState.overlayMorph === true);
        check('底部胶囊进入溶解态(body.morph-open)', openState.bodyMorphOpen === true);
        check('对话框初态带位移/缩放 transform', /scale/.test(openState.transform), `(got "${openState.transform}")`);

        // 轮询等待入场形变落定（时长受机器负载影响，固定 sleep 会误判）
        let settled = null;
        for (let i = 0; i < 25; i++) {
            await sleep(120);
            settled = JSON.parse(await evaluate(cdpUrl, `JSON.stringify({
                transform: document.querySelector('.dialog') ? document.querySelector('.dialog').style.transform : '',
                bodyMorphOpen: document.body.classList.contains('morph-open'),
                capsuleOpacity: parseFloat(getComputedStyle(document.getElementById('bottomCapsule')).opacity)
            })`));
            if (settled.transform === '' && settled.capsuleOpacity < 0.02 && settled.bodyMorphOpen) break;
        }
        check('入场完成后 inline transform 已清理', settled.transform === '', `(got "${settled.transform}")`);
        check('对话框打开期间底部胶囊保持溶解', settled.bodyMorphOpen === true);
        check('底部胶囊已淡出', settled.capsuleOpacity < 0.02, `(opacity=${settled.capsuleOpacity})`);

        console.log('\n[2] 退场：保存 → 对话框收束回看板卡片');
        await evaluate(cdpUrl, `(() => {
            document.getElementById('newContent').value = '1. 形变测试作业';
            document.getElementById('btnSave').click();
            return 'saved';
        })()`);

        let sawCloseTransform = false, sawAck = false, overlayGone = false, morphOpenCleared = false;
        for (let i = 0; i < 30; i++) {
            await sleep(60);
            const s = JSON.parse(await evaluate(cdpUrl, `JSON.stringify({
                overlay: !!document.querySelector('.overlay'),
                transform: document.querySelector('.dialog') ? document.querySelector('.dialog').style.transform : '',
                ack: !!document.querySelector('.homework-card.card-morph-ack'),
                bodyMorphOpen: document.body.classList.contains('morph-open'),
                cards: document.querySelectorAll('.homework-card').length
            })`));
            if (s.overlay && /scale/.test(s.transform)) sawCloseTransform = true;
            if (s.ack) sawAck = true;
            if (!s.overlay && s.cards >= 2) { overlayGone = true; }
            if (!s.overlay && !s.bodyMorphOpen) morphOpenCleared = true;
            if (overlayGone && morphOpenCleared && (sawAck || i > 12)) break;
        }
        check('退场时对话框带收束 transform', sawCloseTransform);
        check('新卡片已加入看板', overlayGone);
        check('底部胶囊恢复（morph-open 已移除）', morphOpenCleared);
        check('卡片播放"被接收"落点动画', sawAck);

        const finalCards = await evaluate(cdpUrl, `document.querySelectorAll('.homework-card').length`);
        check('看板卡片数为 2', finalCards === 2, `(got ${finalCards})`);

        console.log('\n[3] 减弱动画：回退为普通弹窗（不做形变）');
        await evaluate(cdpUrl, `window.AppState.settings.reduceAnimation = true; 'set'`);
        await evaluate(cdpUrl, `document.querySelector('.subject-pill[data-subject-id="english"]').click()`);
        const reduceState = JSON.parse(await evaluate(cdpUrl, `JSON.stringify({
            dialog: !!document.querySelector('.dialog'),
            dialogMorph: document.querySelector('.dialog') ? document.querySelector('.dialog').classList.contains('morph') : null,
            bodyMorphOpen: document.body.classList.contains('morph-open'),
            anim: document.querySelector('.dialog') ? getComputedStyle(document.querySelector('.dialog')).animationName : ''
        })`));
        check('减弱动画下不进入形变模式', reduceState.dialog === true && reduceState.dialogMorph === false && reduceState.bodyMorphOpen === false, JSON.stringify(reduceState));
        check('减弱动画下沿用 dialogPop', /dialogPop/.test(reduceState.anim), `(anim=${reduceState.anim})`);
        await evaluate(cdpUrl, `document.getElementById('btnCancel').click()`);
        await sleep(400);

        console.log(`\n=== 形变探针结果: ${pass} 通过, ${fail} 失败 ===`);
        process.exitCode = fail ? 1 : 0;
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
