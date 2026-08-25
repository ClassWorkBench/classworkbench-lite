#!/usr/bin/env node
/**
 * check-wiring.mjs — 渲染层模块接线冒烟校验
 *
 * 目的：把「所有 window.App* 是否加载齐全」从肉眼/运行时排查，变成一条可重复执行的
 *      静态校验链路（npm test），防止补丁式开发踩到这些雷：
 *       1. 新增了模块却忘了登记进 registry → 页面里模块根本不会执行
 *       2. registry 登记了 exposes 契约，但源码实际没有暴露该全局 → 依赖方直接崩
 *       3. 改了 script 名/删了文件，但 registry 还指着旧路径 → 404 静默失败
 *       4. src/scripts/ 下残留没登记的死文件 → 无人执行、无人维护
 *       5. index.html 里又手写了 <script>，绕过 registry 的依赖顺序/契约校验
 *
 * 校验内容：
 *   1. registry 中登记的每个模块文件必须真实存在
 *   2. 每个 exposes 契约必须在对应源码里有声明（window.AppX = ...）
 *   3. src/scripts/ 下每个 .js 必须被 registry 登记（防死代码漏网）
 *   4. index.html 只能通过 registry.js 加载渲染层模块，不允许残留手写 <script>
 *
 * 用法：npm test    （退出码 0 通过 / 1 失败）
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

// registry.js 同时兼容浏览器/Node（module.exports = REGISTRY），直接复用同一份清单
const { modules: registryModules, errors: _ignored } = require('../src/scripts/registry.js');
const REGISTRY = registryModules;

// 统一分隔符比较（registry 里用 "/"，Windows 下磁盘路径是 "\"）
const norm = (p) => p.split('/').join(sep);

let errors = 0;
const fail = (msg) => { console.error('[FAIL] ' + msg); errors++; };

// ---------- 1) 登记的模块文件必须存在 ----------
const missing = [];
for (const entry of REGISTRY) {
    if (!existsSync(join(root, entry.file))) missing.push(entry.file);
}
if (missing.length) {
    missing.forEach((f) => fail(`登记的文件不存在：${f}`));
} else {
    console.log(`[1/4] 模块文件齐全：${REGISTRY.length} 个登记项均存在`);
}

// ---------- 2) exposes 契约必须在源码中有声明 ----------
// 单层契约（如 AppState）要求出现 window.AppState = / |=
// 多层契约（如 SettingsModules.general）要求顶层 window.SettingsModules 声明，
// 且完整路径 window.SettingsModules.general 出现（防止「只建了命名空间没挂叶子」）
let exposesTotal = 0;
const contractMiss = [];
for (const entry of REGISTRY) {
    const filePath = join(root, entry.file);
    if (!existsSync(filePath)) continue; // 已在上一步报错
    const src = readFileSync(filePath, 'utf8');
    for (const expose of entry.exposes) {
        exposesTotal++;
        const [top, ...rest] = expose.split('.');
        const topRe = new RegExp(`window\\.${top}(?:\\s*=|\\s*\\|\\|=|\\s*\\.)`);
        if (!topRe.test(src)) {
            contractMiss.push(`${entry.file} -> ${expose}（缺 window.${top} 声明）`);
            continue;
        }
        if (rest.length) {
            const fullRe = new RegExp(`window\\.${expose.replace(/\./g, '\\.')}\\s*=`);
            if (!fullRe.test(src)) contractMiss.push(`${entry.file} -> ${expose}（缺完整路径声明）`);
        }
    }
}
if (contractMiss.length) {
    contractMiss.forEach((m) => fail(`exposes 契约未兑现：${m}`));
} else {
    console.log(`[2/4] exposes 契约兑现：${exposesTotal} 个全局契约均在源码有声明`);
}

// ---------- 3) src/scripts/ 下不允许有未登记的死文件 ----------
function collectJs(dir, acc = []) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) collectJs(p, acc);
        else if (name.endsWith('.js')) acc.push(p);
    }
    return acc;
}
// "已覆盖" = 在 registry 登记，或被任一 HTML 页面显式 <script> 引用。
// 覆盖两个独立入口：index.html（走 registry 统一加载）与 floating.html（浮窗独立加载）。
const covered = new Set(REGISTRY.map((e) => norm(e.file)));
for (const htmlFile of ['index.html', 'floating.html', 'scan-floater.html']) {
    const p = join(root, htmlFile);
    if (!existsSync(p)) continue;
    for (const m of readFileSync(p, 'utf8').matchAll(/<script[^>]+src=["']([^"']+)["'][^>]*>/g)) {
        const src = m[1];
        if (src.includes('src/scripts/')) covered.add(norm(src));
    }
}
const scriptsDir = join(root, 'src', 'scripts');
const orphans = [];
if (existsSync(scriptsDir)) {
    for (const p of collectJs(scriptsDir)) {
        const rel = 'src' + sep + 'scripts' + sep + p.slice(scriptsDir.length + 1).split(sep).join(sep);
        if (!covered.has(rel)) orphans.push(rel.split(sep).join('/'));
    }
}
if (orphans.length) {
    orphans.forEach((o) => fail(`未登记的死文件：${o}（既未在 registry.js 登记，也无任何 HTML 引用）`));
} else {
    console.log(`[3/4] 无死文件：src/scripts/ 下所有 .js 均已被 registry 或 HTML 覆盖`);
}

// ---------- 4) index.html 只能通过 registry.js 加载渲染层模块 ----------
const indexHtml = readFileSync(join(root, 'index.html'), 'utf8');
const scriptTags = [...indexHtml.matchAll(/<script[^>]+src=["']([^"']+)["'][^>]*>/g)].map((m) => m[1]);
const stray = scriptTags.filter((s) => s.includes('src/scripts/') && !s.endsWith('registry.js'));
const hasRegistry = scriptTags.some((s) => s.endsWith('registry.js'));
if (!hasRegistry) fail('index.html 未加载 src/scripts/registry.js');
if (stray.length) stray.forEach((s) => fail(`index.html 残留手写模块 script 标签：${s}（应删掉，统一走 registry）`));
if (hasRegistry && !stray.length) {
    console.log(`[4/4] 加载入口干净：index.html 仅由 registry.js 统一加载（共 ${scriptTags.length} 个 script 标签）`);
}

// ---------- 汇总 ----------
console.log('--------------------------------------------------');
if (errors) {
    console.error(`✗ 接线冒烟校验未通过：${errors} 处问题`);
    process.exit(1);
}
console.log('✓ 接线冒烟校验通过：模块/契约/无死文件/单一入口全部符合预期');
