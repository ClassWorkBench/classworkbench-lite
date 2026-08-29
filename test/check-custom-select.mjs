#!/usr/bin/env node
/**
 * check-custom-select.mjs — 自定义下拉（AppSelect）接线与关键实现冒烟校验
 *
 * 目的：把「原生 <select> 是否真的被 AppSelect 接管」从运行时排查变成一条可重复的
 *      静态校验链路（并入 npm test），防止补丁式开发踩雷：
 *       1. registry 未登记 custom-select.js / 未兑现 AppSelect 契约
 *       2. 某处 <select> 忘了标 data-cselect → 仍是丑的原生系统下拉（含深色失效）
 *       3. 组件关键行为退化：隐藏层仍可聚焦（虚空焦点）、无 aria、disabled 不同步
 *       4. CSS 关键类缺失（触发钮/弹层/深色/禁用/减弱动画）
 *
 * 用法：node test/check-custom-select.mjs   （退出码 0 通过 / 1 失败）
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let errors = 0;
const fail = (msg) => { console.error('[FAIL] ' + msg); errors++; };

const read = (p) => readFileSync(join(root, p), 'utf8');

// ---------- 1) registry 登记 + AppSelect 契约 ----------
const registrySrc = read('src/scripts/registry.js');
const moduleFile = 'src/scripts/custom-select.js';
const { modules: REGISTRY } = require('../src/scripts/registry.js');
const entry = REGISTRY.find((e) => e.file === moduleFile);
if (!entry) fail('registry 未登记 src/scripts/custom-select.js');
else if (!entry.exposes || !entry.exposes.includes('AppSelect')) fail('custom-select 契约未声明 AppSelect');
if (!registrySrc.includes(moduleFile)) fail('registry 源文件缺少 custom-select.js 引用');

// ---------- 2) 各设置面板的 <select> 均标了 data-cselect ----------
const selectSpots = [
    ['settings/weather-view.js', 'weatherProviderSelect'],
    ['settings/weather-view.js', 'weatherRefreshIntervalSelect'],
    ['settings/weather-view.js', 'weatherRefreshModeSelect'],
    ['settings/personal.js', 'bgSourceSelect'],
    ['settings/personal.js', 'bgRefreshSelect'],
    ['settings/personal.js', 'bgRefreshModeSelect'],
    ['settings/personal.js', 'colsSelect'],
    ['settings/qq.js', 'newTeacherSubject'],
    ['settings/qq.js', 'teacher-subject-select'],
    ['settings/solve.js', 'solveCameraSelect'],
];
for (const [file, id] of selectSpots) {
    const src = existsSync(join(root, 'src/scripts', file)) ? read('src/scripts/' + file) : '';
    if (!src) { fail(`找不到文件 src/scripts/${file}`); continue; }
    // 断言该 select 的声明带 data-cselect（容忍跨行/转义）
    const re = new RegExp(`<select[^>]*\\b(${id})[\\s\\S]{0,400}?data-cselect|<select[^>]*data-cselect[\\s\\S]{0,400}?\\b(${id})\\b`);
    if (!re.test(src)) fail(`src/scripts/${file} 中 ${id} 未标记 data-cselect`);
}

// ---------- 3) settings.js 打开设置时挂载 AppSelect ----------
{
    const src = read('src/scripts/settings.js');
    if (!/AppSelect\.mount/.test(src)) fail('settings.js 未调用 AppSelect.mount()');
    if (!/disposers\.push\([^)]*AppSelect\.mount/.test(src)) fail('settings.js 未将 AppSelect.mount 结果纳入 disposers 清理');
}

// ---------- 4) custom-select.js 关键实现不失守 ----------
{
    const src = read(moduleFile);
    const must = [
        [/cselect-native/, '原生 select 隐藏类'],
        [/tabIndex\s*=\s*-1/, '隐藏 select 移出 Tab 顺序（防虚空焦点）'],
        [/addEventListener\(['"]focus['"]/, '焦点守卫（转回 trigger）'],
        [/aria-activedescendant/, 'aria-activedescendant 读屏支持'],
        [/aria-controls/, 'aria-controls 弹层关联'],
        [/function applyDisabled/, 'disabled 态同步'],
        [/MutationObserver/, 'options/disabled 变化的观察回调'],
    ];
    for (const [re, label] of must) {
        if (!re.test(src)) fail(`custom-select.js 缺少关键实现：${label}`);
    }
}

// ---------- 5) CSS 关键类齐全（触发钮/弹层/深色/禁用/减弱动画） ----------
{
    const css = read('src/styles/components.css');
    const must = [
        [/\.cselect-trigger/, '触发按钮类'],
        [/\.cselect-pop\b/, '弹出列表类'],
        [/\[data-theme="dark"\] .cselect-pop/, '深色弹层'],
        [/\[data-theme="dark"\] .cselect-trigger/, '深色触发钮'],
        [/\.cselect-trigger(?::|\.)disabled/, '禁用态样式'],
        [/body\.reduce-anim .cselect-pop/, '减弱动画适配'],
    ];
    for (const [re, label] of must) {
        if (!re.test(css)) fail(`components.css 缺少 ${label}`);
    }
}

console.log(errors === 0
    ? `✓ 自定义下拉接线冒烟通过（registry/标记/实现/CSS 关键点全部符合）`
    : `✗ 自定义下拉接线冒烟发现 ${errors} 个问题`);
process.exit(errors ? 1 : 0);