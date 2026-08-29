// ============================================
// custom-select.js — 原生 <select> 玻璃下拉增强
// 原生 <select> 的弹出列表由系统渲染，不跟随应用深浅色（prefers-color-scheme
// 管不到系统原生 popup），且外观各不相同。本组件在保留 <select> 的前提下，
// 用一层「玻璃触发按钮 + 顶层弹出列表」替换它的可视形态：
//   - select 本身保留在 DOM（各模块仍可 .value / change 照常读写、监听）；
//   - 选中时代码回写 select.value 并派发 change，完全兼容既有逻辑；
//   - 弹层挂到 document.body 顶层并使用 fixed 定位，避开设置面板滚动裁剪。
// 深色样式由 CSS 变量 + :root[data-theme="dark"] 自动跟随。
// ============================================

(function () {
    'use strict';

    const ROOT_SELECTOR = 'select[data-cselect]';

    let cselectSeq = 0;   // 弹层唯一 id 计数器

    // 当前打开的弹层（同时只允许一个）
    let activePop = null;

    function closeActive() {
        if (activePop) { activePop.close(); }
    }

    // 捕获阶段：任意滚动即关闭当前弹层（避免窗口/容器滚动后定位错位）
    function onScroll() {
        if (activePop) activePop.close();
    }

    /**
     * 增强单个 select：包一层触发按钮 + 建弹层结构
     * @returns {boolean} 是否新建（false = 已增强/重复）
     */
    function enhance(select) {
        if (select.dataset.cselectDone === '1') return false;
        if (select.options.length === 0) {
            // 无选项（如摄像头枚举前）：仅打标记不渲染按钮，避免空按钮
            select.dataset.cselectDone = '1';
            select.dataset.cselectEmpty = '1';
            return false;
        }
        select.dataset.cselectDone = '1';

        // ---- 触发按钮 ----
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'cselect-trigger';
        trigger.setAttribute('aria-haspopup', 'listbox');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.setAttribute('tabindex', '0');

        const valueSpan = document.createElement('span');
        valueSpan.className = 'cselect-value';

        const arrow = document.createElement('span');
        arrow.className = 'cselect-arrow';
        arrow.setAttribute('aria-hidden', 'true');

        trigger.appendChild(valueSpan);
        trigger.appendChild(arrow);

        // 用一个内层容器包裹 trigger（隐藏的 select 仍留在其内）
        const wrap = document.createElement('div');
        wrap.className = 'cselect-wrap';
        // 继承原 select 的布局类（个人面板用了 input-flex/input-flex-wide 等控制宽度/伸缩）
        const layoutCls = (select.className || '').trim();
        const layoutParts = layoutCls ? layoutCls.split(/\s+/) : [];
        if (layoutParts.length) wrap.classList.add(...layoutParts);
        if (layoutParts.length) select.classList.remove(...layoutParts); // 空 token 会导致 remove('') 抛错，故先判空
        select.classList.add('cselect-native');
        // 原生 select 隐藏后仍可聚焦，会让 Tab/方向键落到"虚空焦点"并触发系统下拉。
        // 移出 Tab 顺序，键盘入口由自定义 trigger（focusable）接管。
        select.tabIndex = -1;

        select.parentNode.insertBefore(wrap, select);
        wrap.appendChild(trigger);
        wrap.appendChild(select);

        // ---- 弹层内容（fixed 于 body 顶层，规避设置面板滚动裁剪） ----
        const pop = document.createElement('div');
        pop.className = 'cselect-pop';
        pop.setAttribute('role', 'listbox');
        pop.setAttribute('tabindex', '-1');
        pop.style.display = 'none';
        // 弹层唯一 id，供 trigger 的 aria-controls / aria-activedescendant 引用
        const popId = 'cselect-pop-' + (++cselectSeq);
        pop.id = popId;
        trigger.setAttribute('aria-controls', popId);

        // 无障碍：置顶当前活动的 option id，供读屏朗读
        function setActiveDesc(id) {
            trigger.setAttribute('aria-activedescendant', id || '');
        }

        // disabled 态：select.disabled 同步到按钮（禁用点击/键盘，置 aria-disabled）
        function applyDisabled() {
            const dis = !!select.disabled;
            trigger.disabled = dis;
            trigger.setAttribute('aria-disabled', String(dis));
            trigger.classList.toggle('is-disabled', dis);
            if (dis) closeActive();
        }

        // 焦点守卫：隐藏的 select 一旦被聚焦，强制转回 trigger，杜绝虚空焦点
        select.addEventListener('focus', () => {
            if (!select.disabled && trigger.focus) trigger.focus();
        });

        const list = document.createElement('div');
        list.className = 'cselect-list';
        pop.appendChild(list);

        function buildOptions() {
            list.innerHTML = '';
            const opts = Array.from(select.options);
            // 分组（<optgroup>）用分隔项展示
            let groupLabel = null;
            opts.forEach((opt, idx) => {
                const optParent = opt.parentElement;
                if (optParent && optParent.tagName === 'OPTGROUP' && optParent.label !== groupLabel) {
                    groupLabel = optParent.label;
                    const sep = document.createElement('div');
                    sep.className = 'cselect-group';
                    sep.textContent = groupLabel;
                    list.appendChild(sep);
                }
                const item = document.createElement('div');
                item.className = 'cselect-opt';
                item.id = popId + '-opt' + idx;
                item.setAttribute('role', 'option');
                item.setAttribute('aria-selected', opt.selected ? 'true' : 'false');
                item.setAttribute('data-idx', String(idx));
                item.textContent = opt.label || opt.value;
                if (opt.disabled) item.classList.add('is-disabled');
                list.appendChild(item);
            });
        }

        function valueText() {
            const opt = select.selectedOptions && select.selectedOptions[0];
            return opt ? (opt.label || opt.value) : (select.value || '');
        }

        function syncLabel() {
            valueSpan.textContent = valueText();
        }

        // ---- 打开 / 关闭 ----
        function open() {
            closeActive();
            buildOptions();
            // 同步当前高亮
            const listEl = list;
            const cur = Array.from(listEl.querySelectorAll('.cselect-opt')).find(el => el.getAttribute('aria-selected') === 'true');
            listEl.querySelectorAll('.cselect-opt.hover').forEach(el => el.classList.remove('hover'));
            if (cur) cur.classList.add('hover');
            setActiveDesc(cur ? cur.id : '');

            // 定位：相对按钮视口坐标，底部溢出则向上展开
            const rect = trigger.getBoundingClientRect();
            pop.style.minWidth = Math.max(rect.width, 160) + 'px';
            pop.style.left = rect.left + 'px';
            const vh = window.innerHeight;
            const estimate = Math.min(pop.offsetHeight || 0, 300); // 未挂载先用预估
            const upward = (rect.bottom + 8 + estimate) > vh;
            pop.style.top = upward ? '' : (rect.bottom + 6) + 'px';
            pop.style.bottom = upward ? (vh - rect.top + 6) + 'px' : '';
            pop.style.display = 'block';

            document.body.appendChild(pop);
            // 挂载后重新精确置高（若向上）
            if (upward) {
                const h = pop.offsetHeight;
                pop.style.top = '';
                pop.style.bottom = (vh - rect.top + 6) + 'px';
            }
            pop.classList.add('open');

            trigger.setAttribute('aria-expanded', 'true');
            trigger.classList.add('open');
            activePop = {
                close,
                el: pop,
                select,
                trigger
            };
            // 保持滚动后定位正确
            window.addEventListener('scroll', onScroll, true);
            // 打开后焦点落入弹层，方便方向键/Enter/Esc 操作
            if (pop.focus) pop.focus();
        }

        function close() {
            if (activePop && activePop.close !== close) { return; }
            if (activePop) activePop = null;
            window.removeEventListener('scroll', onScroll, true);
            if (pop.parentNode) pop.parentNode.removeChild(pop);
            trigger.setAttribute('aria-expanded', 'false');
            setActiveDesc('');
            trigger.classList.remove('open');
        }

        // ---- 提交选中 ----
        function commit(idx) {
            if (idx == null) return;
            const opt = select.options[idx];
            if (!opt || opt.disabled) return;
            if (select.value === opt.value) { close(); return; }
            select.value = opt.value;
            syncLabel();
            close();
            // 派发 change，既有各面板的 addEventListener('change') 照常触发
            select.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        }

        // 键盘：方向键移动/预览（不改 select.value），Enter 提交，Esc 关闭
        function onKeydown(e) {
            const opts = list.querySelectorAll('.cselect-opt:not(.is-disabled)');
            if (!opts.length) return;
            const idxs = opts.length && activePop && activePop.el === pop
                ? Array.from(opts).map(el => el.classList.contains('hover'))
                : null;
            // 未打开：↑/↓ 打开并定位到当前项
            if (!(activePop && activePop.el === pop)) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    open();
                    const cur = select.selectedIndex;
                    const tgt = opts[cur] || opts[0];
                    list.querySelectorAll('.cselect-opt.hover').forEach(el => el.classList.remove('hover'));
                    if (tgt) tgt.classList.add('hover');
                    setActiveDesc(tgt ? tgt.id : '');
                    return;
                }
                return;
            }
            // 已打开：方向键移动高亮，Enter 提交
            const hoverList = Array.from(list.querySelectorAll('.cselect-opt:not(.is-disabled)'));
            const curHover = hoverList.findIndex(el => el.classList.contains('hover'));
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const step = e.key === 'ArrowDown' ? 1 : -1;
                let ni = curHover + step;
                if (ni < 0) ni = hoverList.length - 1;
                if (ni > hoverList.length - 1) ni = 0;
                list.querySelectorAll('.cselect-opt.hover').forEach(el => el.classList.remove('hover'));
                hoverList[ni].classList.add('hover');
                hoverList[ni].scrollIntoView({ block: 'nearest' });
                setActiveDesc(hoverList[ni].id);
            } else if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (curHover >= 0) commit(Number(hoverList[curHover].dataset.idx));
                else close();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                close();
            }
        }

        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            if (activePop && activePop.el === pop) close();
            else open();
        });
        trigger.addEventListener('keydown', onKeydown);
        /* 打开后焦点落到弹层承接方向键；preventDefault 阻止 mousedown 让弹层聚焦走程序而非点击 */
        pop.addEventListener('mousedown', (e) => e.preventDefault()); // 避免触发外层 document 关闭
        pop.addEventListener('click', (e) => {
            const item = e.target.closest('.cselect-opt');
            if (!item || item.classList.contains('is-disabled')) { return; }
            commit(Number(item.dataset.idx));
        });
        pop.addEventListener('keydown', onKeydown);

        syncLabel();
        // 异步填充 options / disabled 属性变化：同步按钮文本与禁用态
        // （弹层每次 open 都重建，这里只确保关闭态按钮显示/禁用正确）
        try {
            const comboObserver = new MutationObserver(() => { syncLabel(); applyDisabled(); });
            comboObserver.observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
        } catch (_) {}
        applyDisabled();
        return true;
    }

    // document 级点击关闭（捕获，点击弹层外区域）
    document.addEventListener('mousedown', (e) => {
        if (!activePop) return;
        if (activePop.el.contains(e.target)) return;
        const t = e.target.closest ? e.target.closest('.cselect-trigger') : null;
        if (t && activePop.trigger === t) return; // trigger 自身的 toggle 负责
        closeActive();
    }, true);

    /**
     * 承载组件：增强 root 内的所有 select[data-cselect]，并挂 MutationObserver
     * 自动增强后续动态插入的 select（如 QQ 老师列表每次重建）。
     * @returns {Function} dispose —— 停掉观察者
     */
    function mount(root) {
        if (!root) return () => {};
        // content 属性作为设置面板 dialog 或任意容器
        const scope = root.querySelector ? root : document;

        scope.querySelectorAll(ROOT_SELECTOR).forEach(el => { try { enhance(el); } catch (e) { console.error('[cselect] 增强失败:', e); } });

        const mo = new MutationObserver((muts) => {
            for (const m of muts) {
                if (m.type !== 'childList') continue;
                m.addedNodes.forEach((node) => {
                    if (node.nodeType !== 1) return;
                    if (node.matches && node.matches(ROOT_SELECTOR)) {
                        try { enhance(node); } catch (e) { console.error('[cselect] 增强失败:', e); }
                    }
                    const inside = node.querySelectorAll ? node.querySelectorAll(ROOT_SELECTOR) : [];
                    inside.forEach(el => { try { enhance(el); } catch (e) { console.error('[cselect] 增强失败:', e); } });
                });
            }
        });
        mo.observe(scope, { childList: true, subtree: true });
        return () => {
            try { mo.disconnect(); } catch (_) {}
            closeActive();   // 宿主（设置面板）关闭时，一并收掉可能开着的弹层
        };
    }

    window.AppSelect = { mount, enhance };
})();