// ============================================
// dialogs.js
// 业务弹窗：添加、修改作业
// 自动编号：button 形式开关，打开时按钮发光，回车自动续写编号，首次预置 1.
// ============================================

(function () {
    const state = window.AppState;
    const { escapeHtml, toast } = window.AppUtils;
    const { showModal } = window.AppModal;
    const { persistHomeworks, saveSettings } = window.AppStorage;
    const Renderer = window.Renderer;

    // ---- 未保存内容草稿：点击空白/Esc 退出时保留，胶囊/卡片显示笔图标 ----
    function getDrafts() {
        if (!state.settings.drafts || typeof state.settings.drafts !== 'object') {
            state.settings.drafts = { add: {}, edit: {} };
        }
        if (!state.settings.drafts.add || typeof state.settings.drafts.add !== 'object') state.settings.drafts.add = {};
        if (!state.settings.drafts.edit || typeof state.settings.drafts.edit !== 'object') state.settings.drafts.edit = {};
        return state.settings.drafts;
    }

    function saveDraft(kind, key, content) {
        getDrafts()[kind][key] = content;
        saveSettings().catch(() => {});
        Renderer.renderAll();
    }

    function clearDraft(kind, key) {
        const drafts = getDrafts();
        if (key in drafts[kind]) {
            delete drafts[kind][key];
            saveSettings().catch(() => {});
            Renderer.renderAll();
        }
    }

    /** 看板上的卡片元素（用于「对话框收束回卡片」的共享元素动画） */
    function cardElFor(id) {
        return id ? document.querySelector(`.homework-card[data-hw-id="${id}"]`) : null;
    }

    /** 形变落点确认：卡片被"接收"时轻微发光一下（不改变任何既有动画） */
    function playLanding(el) {
        if (!el) return;
        el.classList.add('card-morph-ack');
        setTimeout(() => el.classList.remove('card-morph-ack'), 700);
    }

    // 给 textarea 绑定/解绑自动编号回车逻辑
    function bindAutoNumber(ta, enabledRef) {
        function onKeyDown(e) {
            if (!enabledRef.value) return;
            if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;

            const start = ta.selectionStart;
            const end = ta.selectionEnd;
            if (start !== end) return; // 有选区交给浏览器正常换行

            const before = ta.value.substring(0, start);
            const after = ta.value.substring(end);
            const beforeLines = before.split('\n');
            const currentLine = beforeLines[beforeLines.length - 1] || '';

            const currentHas = /^\s*\d+[.、．]/.test(currentLine);
            const prefixOnlyBlank = currentLine.trim() === '';

            let insertPrefix = null;
            if (currentHas) {
                insertPrefix = nextLineNumber(before);
            } else if (prefixOnlyBlank) {
                const beforeWithoutTail = beforeLines.slice(0, -1).join('\n');
                if (/^\s*\d+[.、．]/m.test(beforeWithoutTail)) {
                    insertPrefix = nextLineNumber(beforeWithoutTail);
                }
            }

            if (insertPrefix == null) return;

            e.preventDefault();
            const insertText = '\n' + insertPrefix + '. ';
            ta.value = before + insertText + after;
            const caret = (before + insertText).length;
            ta.selectionStart = ta.selectionEnd = caret;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
        }
        ta.addEventListener('keydown', onKeyDown);
        return () => ta.removeEventListener('keydown', onKeyDown);
    }

    // 根据最后一行计算下一个编号
    function nextLineNumber(text) {
        const lines = (text || '').split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
            const m = lines[i].match(/^\s*(\d+)[.、．]/);
            if (m) return parseInt(m[1], 10) + 1;
        }
        return 1;
    }

    function openAddDialog(subject, opts = {}) {
        const enabledRef = { value: state.settings.autoNumber !== false };
        const draft = getDrafts().add[subject.id] || '';
        const html = `
            <h3>${emoji('📝')} ${escapeHtml(subject.name)} 作业</h3>
            <textarea id="newContent" placeholder="输入作业内容，每行一条…（开启自动编号时回车自动续写编号）" style="min-height:180px;" aria-label="作业内容"></textarea>
            <div class="dialog-btn-row">
                <button class="btn auto-num-btn ${enabledRef.value ? 'on' : 'off'}" id="autoNumToggle" aria-pressed="${enabledRef.value}" aria-label="自动编号开关">
                    自动编号：${enabledRef.value ? '打开' : '关闭'}
                </button>
                <button class="btn" id="btnCancel" aria-label="取消">取消</button>
                <button class="btn primary" id="btnSave" aria-label="保存作业">保存</button>
            </div>
        `;
        let landingEl = null;
        const { close } = showModal(html, (reason) => {
            // 空白点击 / Esc 关闭：保留输入为草稿；显式按钮关闭由按钮自身处理
            if (reason === 'overlay' || reason === 'escape') {
                const v = ta.value.trim();
                if (v) saveDraft('add', subject.id, v);
                else clearDraft('add', subject.id);
            }
            if (reason === 'save' && !state.settings.reduceAnimation) playLanding(landingEl);
            unbindAutoNum();
        }, { originRect: opts.originRect });
        const ta = document.getElementById('newContent');
        const toggle = document.getElementById('autoNumToggle');

        const unbindAutoNum = bindAutoNumber(ta, enabledRef);

        const refreshToggleUI = () => {
            const on = enabledRef.value;
            toggle.classList.toggle('on', on);
            toggle.classList.toggle('off', !on);
            toggle.textContent = '自动编号：' + (on ? '打开' : '关闭');
            toggle.setAttribute('aria-pressed', String(on));
        };

        toggle.addEventListener('click', async () => {
            enabledRef.value = !enabledRef.value;
            state.settings.autoNumber = enabledRef.value;
            refreshToggleUI();
            try { await saveSettings(); } catch (_) {}
        });

        if (draft) {
            // 恢复未保存草稿
            ta.value = draft;
            setTimeout(() => {
                ta.focus();
                ta.selectionStart = ta.selectionEnd = ta.value.length;
            }, 120);
        } else {
            setTimeout(() => {
                if (enabledRef.value && !ta.value.trim()) {
                    ta.value = '1. ';
                    requestAnimationFrame(() => {
                        ta.selectionStart = ta.selectionEnd = ta.value.length;
                        ta.focus();
                    });
                } else {
                    ta.focus();
                }
            }, 120);
        }

        document.getElementById('btnCancel').addEventListener('click', () => {
            clearDraft('add', subject.id);
            unbindAutoNum();
            close('cancel');
        });
        document.getElementById('btnSave').addEventListener('click', async () => {
            const content = ta.value.trim();
            if (!content) { toast('内容不能为空'); return; }
            const existing = state.homeworks.find(h => h.subjectId === subject.id && h.date === state.currentViewDate);
            let newHomeworks;
            let targetId;
            if (existing) {
                targetId = existing.id;
                newHomeworks = state.homeworks.map(h =>
                    h.id === existing.id ? { ...h, content: h.content + '\n' + content } : h
                );
            } else {
                targetId = 'hw_' + Date.now();
                newHomeworks = [...state.homeworks, {
                    id: targetId,
                    subjectId: subject.id,
                    subjectName: subject.name,
                    content,
                    date: state.currentViewDate
                }];
            }
            const ok = await persistHomeworks(newHomeworks);
            if (ok) {
                clearDraft('add', subject.id);
                Renderer.renderAll();
                unbindAutoNum();
                const el = cardElFor(targetId);
                if (el) {
                    // 新卡片的入场动画会让 getBoundingClientRect 量到缩放中间态；
                    // 直接去掉入场类，让卡片先落到最终位置，由对话框的形变来完成"进入看板"
                    el.classList.remove('card-enter');
                    landingEl = el;
                }
                close('save', el ? el.getBoundingClientRect() : null);
            }
        });
    }

    function openModifyDialog(hw, opts = {}) {
        const enabledRef = { value: state.settings.autoNumber !== false };
        const draft = getDrafts().edit[hw.id] || '';
        const html = `
            <h3>${emoji('✏️')} 修改 ${escapeHtml(hw.subjectName)}</h3>
            <textarea id="modContent" style="min-height:180px;" aria-label="修改作业内容">${escapeHtml(draft || hw.content)}</textarea>
            <div class="dialog-btn-row">
                <button class="btn auto-num-btn ${enabledRef.value ? 'on' : 'off'}" id="autoNumToggle2" aria-pressed="${enabledRef.value}" aria-label="自动编号开关">
                    自动编号：${enabledRef.value ? '打开' : '关闭'}
                </button>
                <button class="btn" id="btnCancel2" aria-label="取消">取消</button>
                <button class="btn primary" id="btnSave2" aria-label="保存修改">保存</button>
            </div>
        `;
        let landingEl = null;
        const { close } = showModal(html, (reason) => {
            // 空白点击 / Esc 关闭：内容有改动则保留草稿
            if (reason === 'overlay' || reason === 'escape') {
                const v = ta.value.trim();
                if (v && v !== hw.content.trim()) saveDraft('edit', hw.id, v);
                else clearDraft('edit', hw.id);
            }
            if (reason === 'save' && !state.settings.reduceAnimation) playLanding(landingEl);
            unbindAutoNum();
        }, { originRect: opts.originRect });
        const ta = document.getElementById('modContent');
        const toggle = document.getElementById('autoNumToggle2');

        const unbindAutoNum = bindAutoNumber(ta, enabledRef);

        const refreshToggleUI = () => {
            const on = enabledRef.value;
            toggle.classList.toggle('on', on);
            toggle.classList.toggle('off', !on);
            toggle.textContent = '自动编号：' + (on ? '打开' : '关闭');
            toggle.setAttribute('aria-pressed', String(on));
        };

        toggle.addEventListener('click', async () => {
            enabledRef.value = !enabledRef.value;
            state.settings.autoNumber = enabledRef.value;
            refreshToggleUI();
            try { await saveSettings(); } catch (_) {}
        });

        setTimeout(() => {
            ta.focus();
            const len = ta.value.length;
            ta.selectionStart = ta.selectionEnd = len;
        }, 120);

        document.getElementById('btnCancel2').addEventListener('click', () => {
            clearDraft('edit', hw.id);
            unbindAutoNum();
            close('cancel');
        });
        document.getElementById('btnSave2').addEventListener('click', async () => {
            const v = ta.value.trim();
            if (!v) { toast('内容不能为空'); return; }
            const newHomeworks = state.homeworks.map(h =>
                h.id === hw.id ? { ...h, content: v } : h
            );
            const ok = await persistHomeworks(newHomeworks);
            if (ok) {
                clearDraft('edit', hw.id);
                Renderer.renderAll();
                unbindAutoNum();
                const el = cardElFor(hw.id);
                landingEl = el;
                close('save', el ? el.getBoundingClientRect() : null);
            }
        });
    }

    window.AppDialogs = { openAddDialog, openModifyDialog };
})();
