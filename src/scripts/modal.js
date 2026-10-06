// ============================================
// modal.js
// 通用模态框（提供 showModal）
// ============================================

(function () {
    const state = window.AppState;

    // 元素是否处于可见/可聚焦状态（display:none、visibility:hidden 均视为不可见，
    // 用于关闭后回焦时跳过已经隐藏的触发者，避免把焦点落到不可见元素上）
    function isVisible(el) {
        for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
            const s = getComputedStyle(n);
            if (s.display === 'none' || s.visibility === 'hidden') return false;
        }
        return true;
    }
    const FOCUSABLE_SELECTOR = 'button, input, textarea, select, [tabindex]:not([tabindex="-1"])';

    function showModal(html, onClose, options = {}) {
        const { replace = true, originRect = null } = options;
        // 减弱动画模式不做形变，沿用原来的缩放淡入/淡出
        const reduce = !!state.settings.reduceAnimation;
        const morphFrom = (!reduce && originRect) ? originRect : null;
        const overlay = document.createElement('div');
        overlay.className = 'overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        const dialog = document.createElement('div');
        dialog.className = 'dialog';
        dialog.innerHTML = html;
        overlay.appendChild(dialog);
        const root = state.dom.modalRoot();
        if (replace) {
            root.innerHTML = '';
        }
        root.appendChild(overlay);
        // 标记 body 进入模态态：卡片激活态监听器据此跳过"点击外部关闭"逻辑，
        // 避免未来 z-index 调整后出现穿透误触发
        document.body.classList.add('modal-open');

        let closing = false;

        // ---- iOS 式「共享元素形变」入场：对话框从被点击的胶囊/卡片位置长出来 ----
        // 关键：先加 .morph 停掉 dialogPop 关键帧，否则动画会覆盖我们设置的 inline transform，
        // 且 getBoundingClientRect 量到的是动画中间态而非最终尺寸。
        if (morphFrom) {
            dialog.classList.add('morph');
            overlay.classList.add('morph');
            const dRect = dialog.getBoundingClientRect();
            const scale0 = Math.min(1, Math.max(0.05, morphFrom.width / dRect.width));
            const dx = (morphFrom.left + morphFrom.width / 2) - (dRect.left + dRect.width / 2);
            const dy = (morphFrom.top + morphFrom.height / 2) - (dRect.top + dRect.height / 2);
            dialog.style.transformOrigin = 'center center';
            dialog.style.transform = `translate(${dx}px, ${dy}px) scale(${scale0})`;
            dialog.style.opacity = '0.2';
            dialog.style.borderRadius = '16px';
            document.body.classList.add('morph-open');
            requestAnimationFrame(() => {
                if (closing) return;   // 入场动画尚未开始就已被关闭
                dialog.style.transition = 'transform 0.58s var(--transition-ios), opacity 0.3s var(--transition-smooth), border-radius 0.58s var(--transition-ios)';
                dialog.style.transform = 'translate(0, 0) scale(1)';
                dialog.style.opacity = '1';
                dialog.style.borderRadius = '28px';
                const settle = (ev) => {
                    if (ev && ev.propertyName !== 'transform') return;
                    dialog.removeEventListener('transitionend', settle);
                    if (closing) return;   // 已开始退场：不要清掉退场用的 inline transform
                    dialog.style.transition = '';
                    dialog.style.transform = '';
                    dialog.style.opacity = '';
                    dialog.style.borderRadius = '';
                };
                dialog.addEventListener('transitionend', settle);
                setTimeout(settle, 640);
            });
        }

        // 记录打开前的焦点，供关闭后回焦（键盘用户必须知道窗口关掉后自己落在哪）
        const prevFocus = document.activeElement;
        const getFocusable = () => Array.from(dialog.querySelectorAll(FOCUSABLE_SELECTOR))
            .filter(el => !el.disabled && el.offsetParent !== null);

        const focusable = dialog.querySelector(FOCUSABLE_SELECTOR);
        if (focusable) setTimeout(() => focusable.focus(), 50);

        const finishClose = (reason) => {
            if (overlay.parentNode) overlay.remove();
            // 仅当所有 overlay 都关闭后才移除 .modal-open，支持嵌套弹窗（如清空确认）
            if (!root.querySelector('.overlay')) {
                document.body.classList.remove('modal-open');
                document.body.classList.remove('morph-open');
            }
            // 关闭后把焦点还给触发者，避免"焦点悬空掉到 body"（弹窗最常踩的键盘坑）
            const pf = prevFocus;
            if (pf && pf.isConnected && isVisible(pf)) {
                try { pf.focus({ preventScroll: true }); } catch (_) {}
            }
            if (onClose) onClose(reason || 'button');
        };
        /**
         * @param {string} reason 关闭原因
         * @param {DOMRect|null} [morphTarget] 传入则收束到目标位置（保存后飞向新卡片）；
         *        未传但入场有来源时，回缩到来源胶囊（取消）。
         */
        const close = (reason, morphTarget) => {
            // 多个关闭入口（遮罩点击 / Esc / 按钮）可能并发，加守卫避免动画重播
            if (closing) return;
            closing = true;
            const target = (!reduce && (morphTarget || morphFrom)) ? (morphTarget || morphFrom) : null;
            if (target) {
                // 共享元素退场：把对话框吸回目标位置并淡出
                dialog.classList.add('morph');   // 停掉 dialogPop，避免关键帧覆盖 inline transform
                const rect = dialog.getBoundingClientRect();
                // 收束到目标矩形"内接"（宽高都取比值的最小者），这样落点不会比卡片还大
                const scale1 = Math.min(1, Math.max(0.05, Math.min(target.width / rect.width, target.height / rect.height)));
                const dx = (target.left + target.width / 2) - (rect.left + rect.width / 2);
                const dy = (target.top + target.height / 2) - (rect.top + rect.height / 2);
                dialog.style.transformOrigin = 'center center';
                dialog.style.transition = 'transform 0.46s var(--transition-ios-in), opacity 0.36s ease, border-radius 0.46s var(--transition-ios-in)';
                dialog.style.transform = `translate(${dx}px, ${dy}px) scale(${scale1})`;
                dialog.style.opacity = '0';
                dialog.style.borderRadius = '14px';
                overlay.style.transition = 'opacity 0.4s ease';
                overlay.style.opacity = '0';
                setTimeout(() => finishClose(reason), 450);
            } else {
                // dialog 自身回缩下沉，与打开时的 dialogPop 形成对称的进退场
                dialog.classList.add('closing');
                overlay.style.opacity = '0';
                overlay.style.transition = 'opacity 0.25s ease';
                setTimeout(() => finishClose(reason), 250);
            }
        };
        // 仅当 mousedown 与 mouseup 均直接发生在 overlay 本身时才视为“点击外部”关闭。
        // 不能用 click：其 e.target 是 mousedown/mouseup 的最近共同祖先，
        // 从 dialog 内按住拖到 overlay 上释放会被误判为点击外部。
        let mouseDownOnOverlay = false;
        overlay.addEventListener('mousedown', e => {
            mouseDownOnOverlay = (e.target === overlay);
        });
        overlay.addEventListener('mouseup', e => {
            if (mouseDownOnOverlay && e.target === overlay) close('overlay');
            mouseDownOnOverlay = false;
        });
        overlay.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') close('escape');
            // 焦点圈闭：aria-modal 必须配合真实 Tab 圈闭才成立，
            // 否则 Tab 会一路逃逸到背景页面的可聚焦元素上
            else if (e.key === 'Tab') {
                const els = getFocusable();
                if (!els.length) return;
                const first = els[0];
                const last = els[els.length - 1];
                if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
            }
        });
        return { overlay, dialog, close };
    }

    window.AppModal = { showModal };
})();
