// 自定义下拉「分裂」诊断：打开设置面板，检查每个 select 的增强层数/重复情况
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PORT = 12002;
const root = path.resolve(__dirname, '..', '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cwb-csel-'));

(function seed() {
    fs.writeFileSync(path.join(userData, 'homework-data.enc'), JSON.stringify({
        homeworks: [],
        subjects: null,
        settings: { wizardCompleted: true, acceptedAgreementVersion: '1.0.1', schemaVersion: 1 }
    }), 'utf8');
})();

const child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [
    '.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`, '--no-sandbox'
], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });

child.stderr.on('data', d => process.stdout.write('[app-err] ' + d));

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function listTargets() {
    try { return await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json()); }
    catch (_) { return []; }
}

async function getPageTarget() {
    for (let i = 0; i < 60; i++) {
        const list = await listTargets();
        const page = list.find(t => t.type === 'page' && /index\.html/.test(t.url));
        if (page) return page;
        await sleep(300);
    }
    return null;
}

function evaluate(wsUrl, expression) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 20000);
        ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
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

(async () => {
    try {
        const page = await getPageTarget();
        if (!page) throw new Error('未找到应用页面');
        let ready = false;
        for (let i = 0; i < 40 && !ready; i++) {
            ready = await evaluate(page.webSocketDebuggerUrl, '!!window.AppRegistry && window.AppRegistry.ready === true');
            if (!ready) await sleep(500);
        }
        await sleep(800);
        await evaluate(page.webSocketDebuggerUrl, 'window.AppSettings.openSettings()');
        await sleep(800);

        const dump = JSON.parse(await evaluate(page.webSocketDebuggerUrl, `JSON.stringify({
            selects: Array.prototype.map.call(document.querySelectorAll('select'), function (s) {
                return {
                    id: s.id,
                    dataCselect: s.getAttribute('data-cselect') || null,
                    cselectDone: s.getAttribute('data-cselect-done') || null,
                    inWrap: !!(s.parentElement && s.parentElement.classList.contains('cselect-wrap')),
                    parentClass: s.parentElement ? s.parentElement.className : '',
                    grandClass: (s.parentElement && s.parentElement.parentElement) ? s.parentElement.parentElement.className : ''
                };
            }),
            wraps: document.querySelectorAll('.cselect-wrap').length,
            triggers: document.querySelectorAll('.cselect-trigger').length,
            pops: document.querySelectorAll('.cselect-pop').length,
            nativeStyle: (function () {
                var s = document.querySelector('select.cselect-native');
                if (!s) return null;
                var cs = getComputedStyle(s);
                return { opacity: cs.opacity, width: cs.width };
            })(),
            bodyHtmlLen: document.body.innerHTML.length
        })`));
        console.log('=== 自定义下拉 DOM 诊断 ===');
        console.log(JSON.stringify(dump, null, 1));
        const hidden = dump.nativeStyle && dump.nativeStyle.opacity === '0' && parseFloat(dump.nativeStyle.width) <= 1;
        const ok = dump.selects.every(s => s.inWrap && !s.grandClass.includes('cselect-wrap'));
        const dup = dump.selects.some(s => s.grandClass.includes('cselect-wrap'));
        console.log('原生 select 隐藏样式:', JSON.stringify(dump.nativeStyle), hidden ? '✓ 生效' : '✗ 未生效（会显示两套下拉）');
        console.log(dup ? '✗ 发现 select 被双层包裹' : (ok ? '✓ 无双层包裹' : '（结构见上）'));
        process.exitCode = (dup || !hidden) ? 1 : 0;
    } catch (e) {
        console.error('探测失败:', e.message);
        process.exitCode = 1;
    } finally {
        child.kill();
        try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
    }
})();
