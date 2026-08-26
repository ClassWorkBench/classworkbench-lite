// ============================================
// solve-ai-preload.js — AI 搜题窗口安全桥接
// 本窗口使用系统标题栏（非客户区），不提供状态显示；
// 保留最小窗口控制桥接，无 Node 能力。
// ============================================

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('solveDoubaoAPI', {
    close: () => ipcRenderer.invoke('solve:close'),
    minimize: () => ipcRenderer.invoke('solve:minimize')
});