// ============================================
// layout.js
// 顶栏高度自适应：让 body padding-top 跟随顶栏高度
// ============================================

(function () {
    let lastPT = -1;      // 上次写入的 body padding-top，未变则跳过写入
    let pending = false;  // 同一帧内多次调用合并为一次测量

    function adjustContentPadding() {
        if (pending) return;
        const topCapsule = document.getElementById('topCapsule');
        if (!topCapsule) return;
        pending = true;
        // 放进下一帧再量：顶栏 flex-wrap 换行/注入 info 时高度会先经过过渡中间态，
        // 等布局稳定后再取高度，避免 body.padding-top 卡在旧的 80px。
        requestAnimationFrame(() => {
            pending = false;
            const rect = topCapsule.getBoundingClientRect();
            const topGap = parseInt(getComputedStyle(topCapsule).top) || 10;
            // 量出换行后的真实高度；高度为 0 说明还没渲染出来，给个底盘避免内容扎进顶栏
            const targetPT = Math.round(Math.max(rect.height, 0) + topGap + 12);
            // 高度未变则不写样式：写 body.padding-top 会触发整页重排，
            // 进而让所有 backdrop-filter 图层重新取样，是设置类操作后的主要卡顿来源
            if (targetPT === lastPT) return;
            lastPT = targetPT;
            document.body.style.paddingTop = targetPT + 'px';
            const toastContainerEl = document.getElementById('toastContainer');
            if (toastContainerEl) {
                toastContainerEl.style.top = (targetPT + 4) + 'px';
            }
        });
    }

    window.AppLayout = { adjustContentPadding };
})();
