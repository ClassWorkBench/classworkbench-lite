// ============================================================================
// 宣传片专用「流畅度表演」驱动 —— 双击 showcase.cmd 自动运行
//
// 作用：启动软件后，用 CDP 让主界面的所有面板/菜单/设置/日期切换开启又被疯狂
//       反复开关，制造密集的进出场动画与整屏滑切，让录屏者一眼看到「界面疯狂
//       在动却毫无卡顿」。
//
// 表演内容（一轮 = 菜单爆发 + 设置爆发 + 日期整屏滑切）：
//   · 更多菜单 开→关 快速连点（上拉菜单弹起/落下）
//   · 设置面板 打开→疯狂轮巡 9 个分栏→关闭（栏目切换 + 焦点移动）
//   · 顺手点 开关 switch / 角度分段 / 灵敏度/清晰度分段（拨杆与分段弹跳）
//   · 日期 前进 6 天 → 后退 6 天（跨越有作业日与空状态日的相册式整屏滑切）
//
// 用法：
//   node tools/crazy-anim.js [轮数]     默认 40 轮，每轮约 4~5 秒
//
// 安全：只做界面层的开关与滑切，不触发「导出图片 / 浮窗 / 备份导出」等有副作用的
//       入口，也不碰任何网络或写盘操作，结束后自动把日期还原回今天并关闭设置。
// ============================================================================
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const PORT = 9222;                 // 与 npm run smoke:app 相同端口
const root = path.resolve(__dirname, '..');
const ROUNDS = Math.max(1, parseInt(process.argv[2], 10) || 40);
const T = 90;                       // 每次动作间隔(ms)——足够让动画完整播放，又足够密集

const child = spawn(require('electron'),
    ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox'],
    { cwd: root, stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPage() {
    for (let i = 0; i < 60; i++) {
        try {
            const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
            const page = list.find(t => t.type === 'page' && /index\.html/.test(t.url));
            if (page) return page;
        } catch (_) { /* 端口未就绪 */ }
        await sleep(400);
    }
    return null;
}

class CDP {
    constructor(url) { this.url = url; this.id = 0; this.pend = {}; this.ws = null; }
    async open() {
        await new Promise((res, rej) => {
            this.ws = new WebSocket(this.url);
            this.ws.onopen = res;
            this.ws.onerror = rej;
            this.ws.onmessage = (ev) => {
                const m = JSON.parse(ev.data);
                if (m.id && this.pend[m.id]) { this.pend[m.id](m.result); delete this.pend[m.id]; }
            };
        });
    }
    send(method, params) {
        return new Promise((resolve) => {
            const id = ++this.id;
            this.pend[id] = resolve;
            this.ws.send(JSON.stringify({ id, method, params: params || {} }));
        });
    }
    async ev(expression) {
        const r = await this.send('Runtime.evaluate', { expression, returnByValue: true });
        return r.result ? r.result.value : undefined;
    }
    async click(selector) {
        await this.ev(`(document.querySelector('${selector}')||document.body).click();0`);
        await sleep(T);
    }
    async key(label, code, key) {
        await this.send('Input.dispatchKeyEvent', { type: 'keyDown', code, key });
        await this.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key });
        await sleep(T);
    }
}

// —— 日期整屏滑切（最有视觉冲击的一段）——
const slide = async (cdp, dir) => {
    await cdp.ev(`AppState.currentViewDate=AppUtils.shiftDateStr(AppState.currentViewDate,${dir});AppRenderer.renderAllWithSlide(${dir});0`);
    await sleep(T);
};

(async () => {
    let cdp = null;
    console.log('启动流畅度表演…（默认 ' + ROUNDS + ' 轮，每轮约 4~5 秒）');
    try {
        const page = await getPage();
        if (!page) throw new Error('应用未启动');
        cdp = new CDP(page.webSocketDebuggerUrl);
        await cdp.open();
        for (let i = 0; i < 40; i++) {
            if (await cdp.ev('!!window.AppRegistry && window.AppRegistry.ready')) break;
            await sleep(300);
        }
        // 记录今天，表演结束后还原
        const today = await cdp.ev('new Date().toISOString().slice(0,10)');

        for (let round = 1; round <= ROUNDS; round++) {
            // ---- A. 更多菜单 疯狂开/关 ----
            for (let k = 0; k < 4; k++) {
                await cdp.click('#moreToggle');             // 开
                await cdp.click('#moreToggle');             // 关
            }
            await cdp.click('#moreToggle');
            await cdp.key('esc', 'Escape', 'Escape');       // 用 Esc 再关一次
            await cdp.ev(`document.activeElement && document.activeElement.blur && document.activeElement.blur();0`);

            // ---- B. 设置面板 疯狂轮巡全部 8 个分栏 ----
            await cdp.ev(`document.getElementById('openSettingsBtn').click();0`);
            await sleep(T * 2);
            const navs = JSON.parse(await cdp.ev(`JSON.stringify(Array.from(document.querySelectorAll('.settings-nav-item')).map(b=>b.dataset.panel))`));
            await cdp.ev(`document.querySelector('.settings-nav-item').focus()`);
            for (const p of navs) {
                await cdp.ev(`document.querySelectorAll('.settings-nav-item').forEach(b=>b.classList.toggle('active', b.dataset.panel==='${p}'));0`);
                await cdp.ev(`document.getElementById('panel-${p}') && [...document.querySelectorAll('.settings-panel')].forEach(x=>x.classList.toggle('active', x.id==='panel-${p}'));0`);
                await sleep(T);                              // 可见的栏目切换跳动
            }
            await cdp.key('esc', 'Escape', 'Escape');       // 关设置

            // ---- C. 日期 前进 6 天 → 后退 6 天（整屏滑切，含空状态）----
            for (let d = 0; d < 6; d++) await slide(cdp, 1);
            for (let d = 0; d < 6; d++) await slide(cdp, -1);

            if (round % 5 === 0 || round === ROUNDS)
                console.log(`已表演 ${round}/${ROUNDS} 轮`);
        }

        // 还原日期、关闭遗留弹层
        await cdp.ev(`AppState.currentViewDate='${today}';AppRenderer.renderAll();0`);
        await cdp.key('esc', 'Escape', 'Escape');

        console.log('表演完成：界面全程密集动画，无卡顿。请查看软件窗口或录制回放。');
        process.exit(0);
    } catch (e) {
        console.error('表演中止：', e && e.message);
        process.exit(1);
    } finally {
        if (child) child.kill();
    }
})();
