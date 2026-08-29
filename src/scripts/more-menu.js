// ============================================
// more-menu.js
// 底部“更多”上拉菜单：复制排版图、设置
// ============================================

(function () {
    'use strict';

    const { toast } = window.AppUtils;
    const sheet = document.getElementById('moreSheet');
    const panel = document.getElementById('moreSheetPanel');
    const toggleBtn = document.getElementById('moreToggle');
    let isOpen = false;
    let closeTimer = null;   // 出场动画结束后的瞬态清理定时器

    function positionPanel() {
        if (!panel || !toggleBtn) return;
        const rect = toggleBtn.getBoundingClientRect();
        const capsule = toggleBtn.closest('.bottom-capsule');
        const baseTop = capsule ? capsule.getBoundingClientRect().top : rect.top;
        const panelWidth = panel.offsetWidth || 220;
        const half = Math.min(panelWidth / 2, (window.innerWidth - 16) / 2);
        const minLeft = Math.max(8, half);
        const maxLeft = Math.min(window.innerWidth - 8, window.innerWidth - half);
        const centerX = rect.left + rect.width / 2;
        panel.style.left = Math.min(Math.max(centerX, minLeft), Math.max(minLeft, maxLeft)) + 'px';
        panel.style.top = Math.max(8, baseTop - 14) + 'px';
    }

    function setOpen(open) {
        if (!sheet || !toggleBtn) return;
        // 关闭菜单时，若处于搜索微窗，先还原菜单内容
        if (!open && window.AppSearch && window.AppSearch.isActive()) {
            window.AppSearch.restore();
        }
        isOpen = open;
        if (open) updateFloatBtnLabel();
        toggleBtn.classList.toggle('open', open);
        toggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) {
            // 两步显示，修复「首次打开动画被跳过」：
            // 元素首次从 visibility:hidden 转可见时若与动画同帧启动，
            // Chromium 会快进/跳过首帧动画（表现为直接闪出、第二次起才正常）。
            // 先只加 .shown 让面板可见但不带动画，强制布局提交一帧，
            // 再在下一帧补 .open 启动入场动画。
            clearTimeout(closeTimer);
            sheet.classList.remove('closing');
            sheet.classList.add('shown');
            void sheet.offsetHeight;
            requestAnimationFrame(() => requestAnimationFrame(() => {
                if (isOpen) sheet.classList.add('open');
            }));
            positionPanel();
            // 聚焦第一项，而不是第三个"复制排版图"——键盘用户打开菜单应落在逻辑起点。
            // 注意：.open 刚加上时，浏览器要到下一帧样式重算后才把 visibility 从 hidden 变为 visible，
            // 此刻同步 focus() 会因"元素尚不可聚焦"静默失效。requestAnimationFrame 回调又早于样式重算，
            // 故采用"逐帧重试直到焦点真正落到目标"的稳妥写法（通常第 1~2 帧即命中）。
            const firstItem = panel.querySelector('.more-item');
            if (firstItem) {
                // Chromium 下 visibility 从 hidden→visible 是逐帧提交的，点击打开后往往要等面板
                // 开启动画（0.25s）走完才真正可聚焦。逐帧重试直到焦点落定，上限 40 帧（≈0.67s）
                // 做安全兜底，避免极端情况下无限循环；通常 0.25s 内即可命中。
                let tries = 0;
                const tryFocus = () => {
                    firstItem.focus();
                    if (document.activeElement === firstItem || tries++ >= 40) return;
                    requestAnimationFrame(tryFocus);
                };
                tryFocus();
            }
        } else {
            // 移除 .open，加瞬态 .closing 播放出场动画，结束后一并清理：
            // 避免「关闭态常驻 moreSheetOut 动画 + fill-mode both」在下次打开时吞掉入场动画
            sheet.classList.remove('open');
            sheet.classList.add('closing');
            clearTimeout(closeTimer);
            closeTimer = setTimeout(() => {
                sheet.classList.remove('closing');
                sheet.classList.remove('shown');
            }, 260);
            if (sheet.contains(document.activeElement)) toggleBtn.focus();
        }
    }

    // 浮窗模式中，菜单按钮文字切换为"退出浮窗模式"
    function updateFloatBtnLabel() {
        const floatBtn = document.getElementById('floatModeBtn');
        if (!floatBtn) return;
        const label = floatBtn.querySelector('.more-item-label');
        if (!label) return;
        const active = !!(window.AppFloatingMode && window.AppFloatingMode.isActive());
        label.textContent = active ? '退出浮窗模式' : '浮窗';
    }

    function closeMenu() {
        setOpen(false);
    }

    function openMenu() {
        setOpen(true);
    }

    async function copyLayoutImage() {
        closeMenu();
        if (!window.electronAPI || typeof window.electronAPI.copyLayoutImage !== 'function') {
            toast('当前环境不支持复制图片');
            return;
        }

        document.body.classList.add('capturing');
        // 等浮层透明过渡结束后再截图
        await new Promise(resolve => setTimeout(resolve, 260));
        try {
            const result = await window.electronAPI.copyLayoutImage();
            if (result && result.success) {
                toast('已复制排版图片，可直接粘贴');
            } else {
                toast((result && result.error) || '导出失败');
            }
        } catch (e) {
            toast('复制失败：' + (e.message || e));
        } finally {
            document.body.classList.remove('capturing');
        }
    }

    function bindButtons() {
        // 注意：每次调用都会重新 getElementById 获取最新 DOM 并绑定事件。
        // 因为搜索微窗退出时会重建面板内按钮 DOM，需要重新绑定才能恢复交互。
        const exportBtn = document.getElementById('exportImageBtn');
        const floatBtn = document.getElementById('floatModeBtn');
        const settingsBtn = document.getElementById('openSettingsBtn');
        const searchBtn = document.getElementById('searchHomeworkBtn');
        const solveBtn = document.getElementById('solveSearchBtn');
        const scanBtn = document.getElementById('scanBtn');

        if (exportBtn) exportBtn.addEventListener('click', copyLayoutImage);
        if (solveBtn) {
            solveBtn.addEventListener('click', () => {
                closeMenu();
                if (window.AppSolve && typeof window.AppSolve.open === 'function') {
                    window.AppSolve.open();
                } else {
                    toast('拍照搜题模块未加载');
                }
            });
        }
        if (scanBtn) {
            scanBtn.addEventListener('click', () => {
                closeMenu();
                if (window.AppScan && typeof window.AppScan.open === 'function') {
                    window.AppScan.open();
                } else {
                    toast('相机扫描模块未加载');
                }
            });
        }
        if (floatBtn) {
            floatBtn.addEventListener('click', () => {
                closeMenu();
                if (window.AppFloatingMode && typeof window.AppFloatingMode.toggle === 'function') {
                    window.AppFloatingMode.toggle();
                } else {
                    toast('浮窗模块未加载');
                }
            });
        }
        if (settingsBtn) {
            settingsBtn.addEventListener('click', () => {
                closeMenu();
                if (window.AppSettings && typeof window.AppSettings.openSettings === 'function') {
                    window.AppSettings.openSettings();
                }
            });
        }
        if (searchBtn) {
            searchBtn.addEventListener('click', (e) => {
                // 必须阻止冒泡：点击后微窗就地重建 DOM，原按钮被销毁，
                // 若不阻止，document 的"点击外部关闭菜单"会把 e.target(旧按钮) 判为外部而关闭菜单。
                e.stopImmediatePropagation();
                e.preventDefault();
                // 微窗就地变形：不关闭菜单，在面板内切换为搜索界面
                if (window.AppSearch && typeof window.AppSearch.open === 'function') {
                    window.AppSearch.open();
                    requestAnimationFrame(() => positionPanel());
                }
            });
        }
    }

    /**
     * 启动预热栅格化：首次打开动画被吞的根因是面板图层第一次真正绘制
     * （合成/backdrop-filter/阴影）会阻塞合成器数百毫秒，动画按墙钟跑完后
     * 中间帧一帧都没提交，用户看到的就是"直接闪出"。
     * 这里在启动后以打开位置 + opacity≈0 把面板真实绘制一次，成本挪到启动阶段，
     * 之后任何一次打开都走已就绪的图层，动画稳定播放。
     */
    function prewarmPaint() {
        if (!sheet || !panel || isOpen) return;
        sheet.classList.add('prewarm-paint');
        // 注意：绝不能调用 positionPanel()！那会把面板定位到屏幕内（底部按钮上方），
        // 带着 backdrop-filter 在卡片区域"闪"两帧，并首次创建 backdrop 根导致整页
        // 重新合成（表现为卡片抖动 + 背景色调变化）。
        // 保持 CSS 基础位（视口上方、屏幕外）即可完成图层/合成预热，对首开动画同样有效。
        void panel.offsetHeight;
        requestAnimationFrame(() => requestAnimationFrame(() => {
            sheet.classList.remove('prewarm-paint');
        }));
    }

    function init() {
        if (!sheet || !toggleBtn) return;
        toggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            setOpen(!isOpen);
        });
        document.addEventListener('click', (e) => {
            if (!isOpen) return;
            const inPanel = panel.contains(e.target) || toggleBtn.contains(e.target);
            // 搜索筛选浮层挂在 body（见 search.js），须视为菜单「内部」，
            // 否则点学科/日期/归档会误关菜单；焦点在浮层内（含原生日期选择器）同样不算外部。
            // 注：search.js 已用事件委托，点击学科胶囊只切 class 不再销毁 DOM，
            // 故此处 e.target.closest() 全程有效，无需 composedPath 兜底。
            const inSearchPop = e.target && e.target.closest && !!e.target.closest('.sm-filter-pop');
            const focusInFilter = document.activeElement &&
                document.activeElement.closest && document.activeElement.closest('.sm-filter-pop');
            if (!inPanel && !inSearchPop && !focusInFilter) closeMenu();
        });
        window.addEventListener('resize', () => {
            if (isOpen) positionPanel();
        });
        bindButtons();
        document.addEventListener('keydown', (e) => {
            if (!isOpen) return;
            if (e.key === 'Escape') { closeMenu(); return; }
            // 菜单用方向键在菜单项间巡游（role=menu/menuitem 的标准交互）。
            // 搜索微窗模式下 panel 内的 .more-item 已被替换为空 → 数组为空直接跳过，不抢搜索键控
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                const items = Array.from(panel.querySelectorAll('.more-item'));
                if (!items.length) return;
                e.preventDefault();
                const cur = items.indexOf(document.activeElement);
                const delta = e.key === 'ArrowDown' ? 1 : -1;
                const next = cur >= 0
                    ? items[(cur + delta + items.length) % items.length]
                    : items[delta === 1 ? 0 : items.length - 1];
                next.focus();
            }
        });
    }

    window.AppMoreMenu = { init, openMenu, closeMenu, bindButtons, positionPanel, prewarmPaint };
})();
