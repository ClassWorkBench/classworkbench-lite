// ============================================
// solve-paste.js — 搜题粘贴单格式修复冒烟测试
// 用法：electron test/smoke/solve-paste.js [轮数，默认 3]
//
// 验证内容（粘贴重复 bug 的根因与修复）：
//   T1 旧行为（双格式 DataTransfer）在贪婪编辑器上插入 2 张 → 复现根因
//   T2 file 单格式 → 恰好 1 张
//   T3 html 单格式 → 恰好 1 张
//   T4 升级路径：只认 HTML 的编辑器上 file 通道 0 张 → 升级 html 通道 1 张
//   T5 真实 Ctrl+V + 剪贴板单格式位图（DeepSeek 修复后行为）→ 1 张
//   T6 真实 Ctrl+V + 剪贴板双格式（DeepSeek 旧行为）→ 2 张 → 复现根因
//   T7 真实 Ctrl+V + 剪贴板 html-only → 1 张
//
// 测试图由模拟页生成：1280×960、含噪点 PNG，体积与真实展台抓拍同一量级，
// 并强制断言 > 200KB，杜绝小图失真。
// ============================================

const { app, BrowserWindow, clipboard, nativeImage } = require('electron');
const path = require('path');
const { buildSyntheticPasteScript } = require('../../main/solve');

const ROUNDS = Math.max(1, parseInt(process.argv[2] || '3', 10) || 3);
const MIN_IMAGE_BYTES = 200 * 1024;   // 测试图必须 > 200KB（真实尺寸下限）
const WATCHDOG_MS = 120 * 1000;

let failed = 0;
let passed = 0;
const failures = [];

function check(name, ok, detail) {
    if (ok) {
        passed++;
        console.log('  [PASS] ' + name + (detail ? '  (' + detail + ')' : ''));
    } else {
        failed++;
        failures.push(name + (detail ? ' -> ' + detail : ''));
        console.log('  [FAIL] ' + name + (detail ? '  (' + detail + ')' : ''));
    }
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function counts(wc) {
    return JSON.parse(await wc.executeJavaScript('getInsertCounts()', true));
}

async function reset(wc, mode) {
    await wc.executeJavaScript("resetEditor('" + (mode || 'greedy') + "')", true);
}

function ctrlV(wc) {
    wc.focus();
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['control'] });
}

async function runRound(round, wc, dataUrl, base64, native) {
    console.log('---- 第 ' + round + '/' + ROUNDS + ' 轮 ----');
    let c;

    // T1 旧行为：双格式（不传 mode）→ 贪婪编辑器两条路径都插图
    await reset(wc, 'greedy');
    await wc.executeJavaScript(buildSyntheticPasteScript(base64), true);
    await sleep(500);
    c = await counts(wc);
    check('T1 旧行为双格式插入 2 张（复现根因）', c.total === 2, JSON.stringify(c));

    // T2 修复-file：单格式 File → 恰好 1 张
    await reset(wc, 'greedy');
    await wc.executeJavaScript(buildSyntheticPasteScript(base64, 'file'), true);
    await sleep(500);
    c = await counts(wc);
    check('T2 file 单格式插入 1 张', c.total === 1 && c.files === 1, JSON.stringify(c));

    // T3 修复-html：单格式 HTML → 恰好 1 张
    await reset(wc, 'greedy');
    await wc.executeJavaScript(buildSyntheticPasteScript(base64, 'html'), true);
    await sleep(500);
    c = await counts(wc);
    check('T3 html 单格式插入 1 张', c.total === 1 && c.html === 1, JSON.stringify(c));

    // T4 升级路径：htmlOnly 编辑器（忽略 files）上 file 通道无效 → html 通道生效
    await reset(wc, 'htmlOnly');
    await wc.executeJavaScript(buildSyntheticPasteScript(base64, 'file'), true);
    await sleep(500);
    c = await counts(wc);
    check('T4a htmlOnly 编辑器 file 通道 0 张', c.total === 0, JSON.stringify(c));
    await wc.executeJavaScript(buildSyntheticPasteScript(base64, 'html'), true);
    await sleep(500);
    c = await counts(wc);
    check('T4b 升级 html 通道插入 1 张', c.total === 1 && c.html === 1, JSON.stringify(c));

    // T5 真实 Ctrl+V：剪贴板单格式位图（DeepSeek 修复后行为）→ 1 张
    await reset(wc, 'greedy');
    clipboard.write({ image: native });
    await sleep(200);
    ctrlV(wc);
    await sleep(900);
    c = await counts(wc);
    check('T5 Ctrl+V 单格式位图插入 1 张', c.total === 1 && c.files === 1, JSON.stringify(c));

    // T6 真实 Ctrl+V：剪贴板双格式（DeepSeek 旧行为）→ 2 张（复现根因）
    await reset(wc, 'greedy');
    clipboard.write({ image: native, html: '<img src="' + dataUrl + '">' });
    await sleep(200);
    ctrlV(wc);
    await sleep(900);
    c = await counts(wc);
    check('T6 Ctrl+V 双格式插入 2 张（复现根因）', c.total === 2, JSON.stringify(c));

    // T7 真实 Ctrl+V：剪贴板 html-only（DeepSeek 补写重试通道）→ 1 张
    await reset(wc, 'greedy');
    clipboard.write({ html: '<img src="' + dataUrl + '">' });
    await sleep(200);
    ctrlV(wc);
    await sleep(900);
    c = await counts(wc);
    check('T7 Ctrl+V html-only 插入 1 张', c.total === 1 && c.html === 1, JSON.stringify(c));
}

async function main() {
    // 无 GPU / 受限环境（CI、沙箱）也能跑；真机上无副作用
    app.disableHardwareAcceleration();

    // 看门狗：任何挂死直接判失败退出
    const watchdog = setTimeout(() => {
        console.error('[FATAL] 冒烟测试超时（120s），强制退出');
        process.exit(1);
    }, WATCHDOG_MS);

    await app.whenReady();
    const win = new BrowserWindow({
        show: false,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false,
            spellcheck: false
        }
    });
    await win.loadFile(path.join(__dirname, 'solve-paste-mock.html'));
    const wc = win.webContents;

    // 生成真实尺寸测试图并断言体积（杜绝小图）
    const dataUrl = await wc.executeJavaScript('makeImageDataURL()', true);
    const base64 = dataUrl.split(',')[1] || '';
    const imageBytes = Buffer.byteLength(Buffer.from(base64, 'base64'));
    console.log('测试图：1280x960 PNG，' + (imageBytes / 1024).toFixed(0) + ' KB');
    check('测试图为真实尺寸（>200KB）', imageBytes > MIN_IMAGE_BYTES, imageBytes + ' bytes');

    const native = nativeImage.createFromDataURL(dataUrl);

    for (let r = 1; r <= ROUNDS; r++) {
        await runRound(r, wc, dataUrl, base64, native);
    }

    clearTimeout(watchdog);
    console.log('========================================');
    console.log('结果：' + passed + ' 通过 / ' + failed + ' 失败（' + ROUNDS + ' 轮 × 7 项 + 1 前置）');
    if (failed > 0) {
        console.log('失败项：');
        failures.forEach(f => console.log('  - ' + f));
    }
    const ok = failed === 0;
    console.log(ok ? 'ALL PASS' : 'SMOKE FAILED');
    process.exit(ok ? 0 : 1);
}

main().catch(e => {
    console.error('[FATAL]', e);
    process.exit(1);
});
