// ============================================
// src/scripts/scan-floater.js — 相机扫描浮窗渲染层
// 形态切换（收缩按钮 ↔ 展开清单）、图片清单渲染、插入/保存交互
// ============================================

(function () {
    'use strict';

    const api = window.scanFloaterAPI;
    let images = [];       // dataURL 列表
    let busy = false;      // 是否正在批量插入

    const bodyEl = document.body;
    const floatBtn = document.getElementById('floatBtn');
    const floatHit = document.getElementById('floatHit');
    const floatBadge = document.getElementById('floatBadge');
    const scanPanel = document.getElementById('scanPanel');
    const thumbsEl = document.getElementById('thumbs');
    const panelCnt = document.getElementById('panelCnt');
    const tipEl = document.querySelector('.scan-tip');
    const insertAllBtn = document.getElementById('insertAllBtn');
    const saveBtn = document.getElementById('saveBtn');
    const closeBtn = document.getElementById('closeBtn');

    function setTip(t) { if (tipEl) tipEl.textContent = t; }

    function setShape(s) {
        bodyEl.classList.remove('collapsed', 'expanded');
        bodyEl.classList.add(s === 'expanded' ? 'expanded' : 'collapsed');
        api.shape(s).catch(() => {});
    }

    function expand() { setShape('expanded'); }

    function collapse() { setShape('collapsed'); }

    /** 渲染清单：每张图一个卡片 = 复选框 + 缩略图 + 单张插入 */
    function render() {
        floatBadge.hidden = images.length === 0;
        floatBadge.textContent = images.length;
        panelCnt.textContent = images.length + ' 张';
        thumbsEl.innerHTML = images.map((d, i) => `
            <div class="scan-thumb" data-i="${i}">
                <input type="checkbox" class="chk" checked aria-label="勾选第${i + 1}张" data-i="${i}">
                <span class="idx">${i + 1}</span>
                <img src="${d}" alt="扫描图${i + 1}">
                <button class="scan-btn thumb-insert" type="button" data-i="${i}" title="插入这张">插入</button>
            </div>
        `).join('');
        thumbsEl.querySelectorAll('.thumb-insert').forEach((b) => {
            b.addEventListener('click', () => insertOne(Number(b.dataset.i)));
        });
    }

    /** 选中索引（复选框勾选者，保持原顺序） */
    function selectedIndexes() {
        const out = [];
        thumbsEl.querySelectorAll('.scan-thumb .chk').forEach((c) => {
            if (c.checked) out.push(Number(c.dataset.i));
        });
        return out;
    }

    async function insertOne(idx) {
        if (busy) return;
        setTip('正在插入第 ' + (idx + 1) + ' 张…');
        const res = await api.insert(idx);
        setTip(res && res.ok
            ? '第 ' + (idx + 1) + ' 张已插入。'
            : '插入失败：' + ((res && res.error) || '未知错误'));
        return res;
    }

    async function insertAll() {
        if (busy) return;
        const indexes = selectedIndexes();
        if (!indexes.length) { setTip('请先勾选要插入的图片'); return; }
        busy = true;
        insertAllBtn.disabled = true;
        saveBtn.disabled = true;
        let ok = 0;
        try {
            for (let i = 0; i < indexes.length; i++) {
                setTip('正在插入第 ' + (i + 1) + '/' + indexes.length + ' 张…');
                const res = await api.insert(indexes[i]);
                if (res && res.ok) ok++;
                // 逐张间隔，让 QQ 把连续粘贴聚合起来；也方便用户中途把焦点切到目标框
                await new Promise(r => setTimeout(r, 350));
            }
            setTip('已插入 ' + ok + '/' + indexes.length + ' 张。');
        } catch (e) {
            setTip('插入中断：' + (e.message || e));
        } finally {
            busy = false;
            insertAllBtn.disabled = false;
            saveBtn.disabled = false;
        }
    }

    async function saveAll() {
        if (busy) return;
        busy = true;
        saveBtn.disabled = true;
        try {
            const res = await api.save();
            if (res && res.ok) {
                setTip('已保存到：' + (res.dir || '桌面/相机扫描/') + '（' + res.saved.length + ' 张）');
            } else {
                setTip('保存失败：' + ((res && res.error) || '未知错误'));
            }
        } catch (e) {
            setTip('保存失败：' + (e.message || e));
        } finally {
            busy = false;
            saveBtn.disabled = false;
        }
    }

    function confirmDiscard() {
        const msg = '要放弃这 ' + images.length + ' 张扫描图吗？关闭后内容将不可恢复。';
        if (!window.confirm(msg)) return;
        api.close();
    }

    function bind() {
        floatHit.addEventListener('click', expand);
        closeBtn.addEventListener('click', () => confirmDiscard());
        insertAllBtn.addEventListener('click', insertAll);
        saveBtn.addEventListener('click', saveAll);

        // 主进程通知数据更新（首页打开时）→ 重新拉取并保持形态
        api.onData(() => {
            api.list().then((r) => {
                if (r && r.ok) {
                    images = (r.images || []).map(x => (x && x.data) || x);
                    render();
                }
            });
        });
    }

    async function init() {
        bind();
        const r = await api.list();
        if (r && r.ok) {
            images = (r.images || []).map(x => (x && x.data) || x);
            render();
        }
    }

    init();
})();