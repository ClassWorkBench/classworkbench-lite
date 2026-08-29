// ============================================
// src/scripts/scan-floater.js — 相机扫描浮窗渲染层
// 形态切换（收缩按钮 ↔ 展开清单）、图片清单渲染、插入/保存交互
// ============================================

(function () {
    'use strict';

    const api = window.scanFloaterAPI;
    let images = [];       // dataURL 列表
    let busy = false;      // 是否正在批量插入

    // 跟随全局深浅色：主进程已按外观设置 nativeTheme.themeSource，
    // 这里读 prefers-color-scheme（其值已随 themeSource 同步）落到 html data-theme，
    // 复用 base.css 的 :root[data-theme="dark"] 深色变量层；浮窗专用硬编码白底由本页 style 覆盖。
    function syncTheme() {
        const dark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
        document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    }
    syncTheme();
    if (window.matchMedia) {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncTheme);
    }

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
    const successOverlay = document.getElementById('scanSuccess');

    function setTip(t) { if (tipEl) tipEl.textContent = t; }

    /**
     * 形态切换：
     * - 展开：先 resize 窗口到 364×488（瞬间），CSS 过渡让面板从按钮位置丝滑放大、按钮淡出
     * - 收缩：先让面板 CSS 过渡缩小淡出，等过渡完再 resize 窗口回 60×60（避免内容被瞬裁）
     */
    function setShape(s) {
        if (s === 'expanded') {
            bodyEl.classList.remove('collapsed');
            bodyEl.classList.add('expanded');
            api.shape('expanded').catch(() => {});
        } else {
            bodyEl.classList.remove('expanded');
            bodyEl.classList.add('collapsed');
            // 等内容过渡完成后再缩窗口，否则窗口先变小会把面板内容瞬裁
            setTimeout(() => api.shape('collapsed').catch(() => {}), 280);
        }
    }

    function expand() {
        if (successOverlay) successOverlay.classList.remove('show');
        setShape('expanded');
    }

    function collapse() { setShape('collapsed'); }

    /**
     * 显示绿色对勾成功动画，可选在动画后执行回调（如收缩）
     * @param {Function|null} then - 对勾展示 700ms 后执行（传 null 则仅闪现）
     */
    function showSuccess(then) {
        if (!successOverlay) { if (then) then(); return; }
        successOverlay.classList.remove('show');
        void successOverlay.offsetWidth;   // 强制 reflow，确保 transition 重新触发
        successOverlay.classList.add('show');
        if (then) {
            setTimeout(then, 700);         // 对勾画完 → 开始收缩
        } else {
            // 单张插入：闪现 600ms 后淡出
            setTimeout(() => {
                successOverlay.classList.remove('show');
            }, 600);
        }
    }

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
        if (res && res.ok) {
            setTip('第 ' + (idx + 1) + ' 张已插入。');
            showSuccess(null);   // 单张：闪现绿色对勾，不收缩
        } else {
            setTip('插入失败：' + ((res && res.error) || '未知错误'));
        }
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
            // 全部插入完成：绿色对勾 → 丝滑收缩回按钮
            if (ok === indexes.length) {
                showSuccess(() => collapse());
            }
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