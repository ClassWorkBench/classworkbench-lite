// ============================================
// solve-ai-preload.js — AI 搜题窗口安全桥接
// 仅暴露最小窗口控制，无 Node 能力
// ============================================

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('solveDoubaoAPI', {
    close: () => ipcRenderer.invoke('solve:close'),
    minimize: () => ipcRenderer.invoke('solve:minimize'),
    // 订阅服务状态：{ provider, loading, pasted }（标题/状态栏动态显示）
    onProvider: (cb) => {
        const h = (_e, data) => cb(data);
        ipcRenderer.on('solve:provider-status', h);
        return () => ipcRenderer.removeListener('solve:provider-status', h);
    }
});
