// ============================================
// settings/data.js — 数据管理面板
// 归档查看 + 备份恢复 + 一键清空（紧凑行式布局）
// ============================================

window.SettingsModules = window.SettingsModules || {};

window.SettingsModules.data = {
    render(ctx) {
        const { state } = ctx;
        return `
                    <!-- 面板：数据管理 -->
                    <div class="settings-panel" id="panel-data">
                        <div class="panel-header">
                            <h3>数据管理</h3>
                            <p class="panel-desc">备份、恢复、查看归档或清空作业数据</p>
                        </div>
                        <div class="panel-body">
                            <div class="setting-group">
                                <div class="data-action-row">
                                    <div class="data-action-text">
                                        <span class="data-action-title">查看归档作业</span>
                                        <span class="data-action-desc">超过 3 个月的作业自动归档</span>
                                    </div>
                                    <button class="btn" id="openArchiveBtn" aria-label="打开归档查看窗口">打开</button>
                                </div>
                                <div class="data-action-row">
                                    <div class="data-action-text">
                                        <span class="data-action-title">备份与恢复</span>
                                        <span class="data-action-desc">导出或导入 JSON 备份文件</span>
                                    </div>
                                    <button class="btn" id="openBackupBtn" aria-label="打开备份与恢复">管理</button>
                                </div>
                                <div class="data-action-row danger-row">
                                    <div class="data-action-text">
                                        <span class="data-action-title">清空全部作业</span>
                                        <span class="data-action-desc">删除未归档作业，不可恢复</span>
                                    </div>
                                    <button class="btn danger" id="btnClearAll" aria-label="清空全部作业">清空</button>
                                </div>
                            </div>
                        </div>
                    </div>
        `;
    },

    bind(ctx) {
        const { state, toast, showModal, persistHomeworks, Renderer, openArchiveView, saveSettings } = ctx;

        // ---- 归档查看：直接切换到归档视图（showModal replace 会立即替换旧内容） ----
        document.getElementById('openArchiveBtn').addEventListener('click', () => {
            openArchiveView();
        });

        // ---- 备份与恢复：打开管理弹窗（渲染层 backup.js） ----
        document.getElementById('openBackupBtn').addEventListener('click', () => {
            if (window.AppBackup) window.AppBackup.openBackupRestore();
        });

        // ---- 数据管理：一键清空 ----
        document.getElementById('btnClearAll').addEventListener('click', () => {
            const count = state.homeworks.length;
            if (count === 0) { toast('当前没有作业'); return; }
            const confirmHtml = `
                <h3>确认清空</h3>
                <p class="confirm-text">
                    将删除所有未归档作业，共 <strong class="text-danger">${count}</strong> 条<br>
                    <small>此操作不可恢复，归档文件不受影响</small>
                </p>
                <div class="confirm-btn-row">
                    <button class="btn" id="btnCancelClearAll">取消</button>
                    <button class="btn danger" id="btnConfirmClearAll">确认清空</button>
                </div>
            `;
            const { close: closeConfirm } = showModal(confirmHtml, null, { replace: false });
            document.getElementById('btnCancelClearAll').addEventListener('click', closeConfirm);
            document.getElementById('btnConfirmClearAll').addEventListener('click', async () => {
                const ok = await persistHomeworks([]);
                if (!ok) return;
                Renderer.renderAll();
                toast(`已清空 ${count} 条作业`);
                closeConfirm();
            });
        });
    }
};
