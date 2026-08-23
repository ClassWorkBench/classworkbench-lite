// ============================================
// solve-ai.js — AI 搜题窗口标题栏交互
// ============================================

(function () {
    'use strict';
    const api = window.solveDoubaoAPI;
    const closeBtn = document.getElementById('solveDbClose');
    const minBtn = document.getElementById('solveDbMin');
    const statusEl = document.getElementById('solveDbStatus');
    const titleText = document.getElementById('solveDbTitleText');
    if (closeBtn && api) closeBtn.addEventListener('click', () => api.close());
    if (minBtn && api) minBtn.addEventListener('click', () => api.minimize());
    if (api && api.onProvider) {
        api.onProvider(({ provider, loading, pasted }) => {
            if (titleText) titleText.textContent = (provider || 'AI') + '搜题';
            if (statusEl) {
                statusEl.textContent = pasted
                    ? '图片已自动粘贴，点一下发送即可'
                    : (loading ? '正在加载' + (provider || '') + '页面（首次稍慢）…' : '正在打开' + (provider || '') + '…');
            }
        });
    }
})();
