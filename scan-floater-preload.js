// ============================================
// scan-floater-preload.js — 相机扫描浮窗桥接
// 仅暴露最小 IPC 面，无 Node 能力
// ============================================

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('scanFloaterAPI', {
    // 拉取待插入图片列表（dataURL 数组）
    list: () => ipcRenderer.invoke('scan:list'),
    // 切换形态（collapsed | expanded）
    shape: (s) => ipcRenderer.invoke('scan:shape', s),
    // 插入第 idx 张图到当前前台窗口
    insert: (idx) => ipcRenderer.invoke('scan:insert', idx),
    // 关闭/销毁浮窗
    close: () => ipcRenderer.invoke('scan:close'),
    // 全部以文件保存到桌面
    save: () => ipcRenderer.invoke('scan:save'),
    // 订阅待插入数据更新（open 时主进程触发）
    onData: (cb) => {
        const h = (_e, data) => cb(data);
        ipcRenderer.on('scan:data', h);
        return () => ipcRenderer.removeListener('scan:data', h);
    }
});