// 无障碍(Tab/方向键)冒烟探测：启动应用 → CDP 真实按键走查 → 断言 Tab 顺序/焦点圈闭/无幽灵可聚焦/无 transition:all
// 用法：node test/smoke/a11y-probe.js   （退出码 0 通过 / 1 失败）
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

// 注意：避开 Windows Hyper-V 保留端口段（9255-9754 等），否则 Chromium 无法绑定
const PORT = 9811;
const root = path.resolve(__dirname, '..', '..');
const electronBin = require('electron'); // 在 node 下 require('electron') 返回可执行文件路径

// 隔离用户数据目录：不写真实 %APPDATA%，并把协议版本设为当前值避免首启/协议向导遮挡
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cwb-a11y-'));
fs.writeFileSync(path.join(userData, 'homework-data.enc'), JSON.stringify({
    homeworks: [], subjects: null,
    settings: { wizardCompleted: true, acceptedAgreementVersion: '1.0.0', schemaVersion: 1 }
}), 'utf8');

const child = spawn(electronBin, [
    '.',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userData}`,
    '--no-sandbox'
], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });

child.stdout.on('data', d => process.stdout.write('[app] ' + d));
child.stderr.on('data', d => process.stdout.write('[app-err] ' + d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPageTarget() {
    let seen = [];
    for (let i = 0; i < 60; i++) {
        try {
            const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
            seen = list.filter((t) => t.type === 'page').map((t) => t.url);
            const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
            if (page) return page;
        } catch (_) { /* 端口未就绪 */ }
        await sleep(500);
    }
    console.error('未匹配到 index.html 页面目标，已见 page 目标:', JSON.stringify(seen));
    return null;
}

class CDP {
    constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; }
    send(method, params) {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(this.wsUrl);
            const id = ++this.id;
            const timer = setTimeout(() => { ws.close(); reject(new Error(method + ' timeout')); }, 30000);
            ws.onopen = () => ws.send(JSON.stringify({ id, method, params: params || {} }));
            ws.onmessage = (ev) => {
                const msg = JSON.parse(ev.data);
                if (msg.id !== id) return;
                clearTimeout(timer);
                ws.close();
                if (msg.error) reject(new Error(method + ': ' + JSON.stringify(msg.error)));
                else resolve(msg.result);
            };
            ws.onerror = (e) => { clearTimeout(timer); reject(e); };
        });
    }
    async eval(expression, awaitPromise = false) {
        const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
        if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
        return r.result ? r.result.value : undefined;
    }
    async key(code, key, modifiers = 0) {
        await this.send('Input.dispatchKeyEvent', { type: 'keyDown', code, key, modifiers });
        await this.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, modifiers });
        await sleep(80);
    }
}

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name} ${detail}`); }
};

(async () => {
    let cdp = null;
    try {
        const page = await getPageTarget();
        if (!page) throw new Error('未找到应用页面');
        cdp = new CDP(page.webSocketDebuggerUrl);

        // 等渲染层就绪：AppRegistry.ready 仅代表模块已加载，AppReady 才代表事件绑定完成
        let ready = false;
        for (let i = 0; i < 40 && !ready; i++) {
            ready = await cdp.eval('!!window.AppRegistry && window.AppRegistry.ready === true && window.AppReady === true');
            if (!ready) await sleep(500);
        }
        check('渲染层就绪', ready);

        console.log('\n[1] 初始无幽灵可聚焦（弹窗/菜单未打开）');
        const initial = JSON.parse(await cdp.eval(`JSON.stringify({
            moreItems: Array.from(document.querySelectorAll('.more-sheet .more-item')).filter(function (b) {
                var s = getComputedStyle(b); return s.visibility !== 'hidden' && b.offsetParent !== null && !b.disabled;
            }).length,
            cardActionBtns: Array.from(document.querySelectorAll('.card-actions button')).filter(function (b) {
                var a = b.closest('.card-actions'); var s = getComputedStyle(a);
                return s.visibility !== 'hidden' && a.offsetParent !== null;
            }).length,
            clockAriaLive: document.getElementById('clockDisplay').getAttribute('aria-live')
        })`));
        check('关闭态下 more 菜单无幽灵可聚焦项', initial.moreItems === 0, `(got ${initial.moreItems})`);
        check('关闭态下卡片操作条无幽灵按钮', initial.cardActionBtns === 0, `(got ${initial.cardActionBtns})`);
        check('时钟已移除 aria-live (避免读屏刷屏)', initial.clockAriaLive === null, `(got ${initial.clockAriaLive})`);

        console.log('\n[2] 更多菜单：焦点落到首项 + 方向键巡游 + Esc 回焦');
        await cdp.eval(`document.getElementById('moreToggle').focus(); document.getElementById('moreToggle').click()`);
        // 菜单项在面板开启动画后才真正可聚焦，轮询等待焦点落定（上限 1.5s）
        let landedFirst = false;
        for (let i = 0; i < 30; i++) {
            const id = await cdp.eval(`document.activeElement ? document.activeElement.id : ''`);
            if (id === 'searchHomeworkBtn') { landedFirst = true; break; }
            await sleep(50);
        }
        let m = JSON.parse(await cdp.eval(`JSON.stringify({
            open: document.getElementById('moreSheet').classList.contains('open'),
            activeId: document.activeElement ? document.activeElement.id : ''
        })`));
        check('菜单打开', m.open === true);
        check('焦点自动落在首个 more-item', landedFirst, `(最后: ${m.activeId})`);

        await cdp.key('ArrowDown', 'ArrowDown');
        m = JSON.parse(await cdp.eval(`JSON.stringify({ activeId: document.activeElement ? document.activeElement.id : '' })`));
        check('ArrowDown 巡游到第二项', m.activeId === 'exportImageBtn', `(got ${m.activeId})`);

        await cdp.key('Escape', 'Escape');
        await sleep(250);
        m = JSON.parse(await cdp.eval(`JSON.stringify({
            open: document.getElementById('moreSheet').classList.contains('open'),
            activeId: document.activeElement ? document.activeElement.id : ''
        })`));
        check('Esc 关闭菜单', m.open === false);
        check('Esc 后焦点还给触发按钮', m.activeId === 'moreToggle', `(got ${m.activeId})`);

        console.log('\n[3] 设置界面：无诡异动画(transition:all) + 导航为button + 方向键切面板');
        await cdp.eval(`document.getElementById('openSettingsBtn').click()`);
        await sleep(550); // 等 dialogPop 播完
        let s = JSON.parse(await cdp.eval(`JSON.stringify({
            open: !!document.querySelector('#settingsModal, .settings-shell'),
            navTransition: getComputedStyle(document.querySelector('.settings-nav-item')).transitionProperty,
            navTags: Array.from(document.querySelectorAll('.settings-nav-item')).map(function (b) { return b.tagName; }),
            activePanel: (document.querySelector('.settings-panel.active') || {}).id,
            activeNav: (document.querySelector('.settings-nav-item.active') || { dataset: { panel: '' } }).dataset.panel,
            activeId: document.activeElement ? document.activeElement.tagName + '.' + (document.activeElement.className || '') : ''
        })`));
        check('设置面板已打开', s.open === true);
        const transitionHasAll = /all/.test(s.navTransition);
        check('导航项 transition 不含 all（诡异动画根因已消除）', !transitionHasAll, `(got: ${s.navTransition})`);
        check('导航项均为原生 <button>', s.navTags.every((t) => t === 'BUTTON'), `(got ${s.navTags.join(',')})`);

        // 方向键切换面板：当前聚焦在导航上（auto-focus），ArrowDown 切到"天气"
        await cdp.key('ArrowDown', 'ArrowDown');
        s = JSON.parse(await cdp.eval(`JSON.stringify({
            activePanel: (document.querySelector('.settings-panel.active') || {}).id,
            activeNav: (document.querySelector('.settings-nav-item.active') || { dataset: { panel: '' } }).dataset.panel,
            focusPanel: document.activeElement ? document.activeElement.closest('.settings-panel')?.id : ''
        })`));
        check('ArrowDown 切到「天气」面板', s.activeNav === 'weather' && s.activePanel === 'panel-weather', `(got ${s.activeNav}/${s.activePanel})`);

        console.log('\n[4] 设置焦点圈闭：Tab 在 dialog 内回绕');
        // 焦点先移到导航首项，再连续 Tab 足够多次，断言焦点从未逃出 dialog
        await cdp.eval(`document.querySelector('.settings-nav-item').focus()`);
        let escaped = false;
        for (let i = 0; i < 40; i++) {
            await cdp.key('Tab', 'Tab');
            const inside = await cdp.eval(`!!document.querySelector('.dialog') && document.querySelector('.dialog').contains(document.activeElement)`);
            if (!inside) { escaped = true; break; }
        }
        check('连续 Tab 40 次始终被圈闭在 dialog 内', !escaped);

        // Esc 关闭设置
        await cdp.key('Escape', 'Escape');
        await sleep(300);
        const afterClose = JSON.parse(await cdp.eval(`JSON.stringify({
            open: !!document.querySelector('.settings-shell'),
            activeId: document.activeElement ? document.activeElement.id : '',
            ghostSettingsNav: getComputedStyle(document.querySelector('.settings-nav-item') || document.body).visibility
        })`));
        check('设置面板已关闭', afterClose.open === false);
        check('设置关闭后焦点还给菜单触发按钮', afterClose.activeId === 'moreToggle', `(got ${afterClose.activeId})`);

        console.log('\n[5] 统一焦点环：键盘聚焦控件应显示主题色描边，而非默认黄环');
        // 用真实 Tab 触发 focus-visible 键盘态，读取当前控件的 outline 计算值
        await cdp.key('Tab', 'Tab');
        const ring = JSON.parse(await cdp.eval(`JSON.stringify({
            tag: document.activeElement ? document.activeElement.tagName + '.' + (document.activeElement.className || '') : 'none',
            style: document.activeElement ? getComputedStyle(document.activeElement).outlineStyle : '',
            color: document.activeElement ? getComputedStyle(document.activeElement).outlineColor : ''
        })`));
        const ringOk = ring.style === 'solid' && /^rgb\(45, 62, 142\)$/i.test(ring.color);
        check('焦点描边为主题色 accent(45,62,142)', ringOk, `(got ${ring.style} ${ring.color} on ${ring.tag})`);

        console.log('\n[6] 设置-个性化 内容区 Tab 聚焦可自动滚动（美化编号开关在末尾可见）');
        await cdp.eval(`document.getElementById('openSettingsBtn').click()`);
        await sleep(550);
        await cdp.eval(`document.querySelector('.settings-nav-item[data-panel="personal"]').click()`);
        await sleep(300);
        const scr = JSON.parse(await cdp.eval(`JSON.stringify((function(){
            var sc = document.querySelector('.settings-content');
            var chk = document.getElementById('beautifyNumberToggle');
            if (!sc || !chk) return { err: 'missing' };
            sc.scrollTop = 0;            // 先置顶，验证聚焦确实触发滚动
            chk.focus();
            var cr = chk.getBoundingClientRect();
            var sr = sc.getBoundingClientRect();
            return {
                box: { w: cr.width, h: cr.height },
                scrollTop: sc.scrollTop,
                scrolled: sc.scrollTop > 0,
                visible: cr.top >= sr.top - 1 && cr.bottom <= sr.bottom + 1,
                active: document.activeElement ? document.activeElement.id : ''
            };
        })())`));
        check('美化编号开关拥有真实盒模型(非0尺寸)', !!scr && !!scr.box && scr.box.w > 0 && scr.box.h > 0, `(got ${JSON.stringify(scr && scr.box)})`);
        check('聚焦美化编号开关后滚动容器自动下滚', !!scr && scr.scrolled === true, `(got scrollTop=${scr && scr.scrollTop})`);
        check('美化编号开关位于滚动视口内(未被裁切)', !!scr && scr.visible === true);
        await cdp.key('Escape', 'Escape'); // 关闭设置，避免影响后续/进程退出

        const summary = `\n=== a11y 冒烟结果: ${pass} 通过, ${fail} 失败 ===`;
        console.log(summary);
        process.exitCode = fail ? 1 : 0;
    } catch (e) {
        console.error('探测失败:', e.message);
        process.exitCode = 1;
    } finally {
        if (child) child.kill();
        await sleep(500);
        try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
    }
})();
