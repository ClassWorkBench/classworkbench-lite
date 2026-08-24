// ============================================
// settings/nav.js — 设置面板导航切换
// ============================================

window.SettingsModules = window.SettingsModules || {};

window.SettingsModules.nav = function(dialog) {
    const navItems = Array.from(dialog.querySelectorAll('.settings-nav-item'));

    const switchPanel = (item) => {
        navItems.forEach(n => n.classList.remove('active'));
        item.classList.add('active');
        dialog.querySelectorAll('.settings-panel').forEach(p => p.classList.remove('active'));
        const targetPanel = document.getElementById('panel-' + item.dataset.panel);
        if (targetPanel) targetPanel.classList.add('active');
    };

    navItems.forEach((item, i) => {
        item.addEventListener('click', () => switchPanel(item));
        // 导航项现为原生 <button>：支持方向键巡游（WAI-ARIA tablist 心智一致），
        // Tab 键退到内容区继续浏览
        item.addEventListener('keydown', (e) => {
            let next = null;
            if (e.key === 'ArrowDown') next = navItems[i + 1] || navItems[0];
            else if (e.key === 'ArrowUp') next = navItems[i - 1] || navItems[navItems.length - 1];
            else if (e.key === 'Home') next = navItems[0];
            else if (e.key === 'End') next = navItems[navItems.length - 1];
            if (!next || next === item) return;
            e.preventDefault();
            switchPanel(next);
            next.focus();
        });
    });
};
