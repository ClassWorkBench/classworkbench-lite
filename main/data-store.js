// ============================================
// main/data-store.js — 数据存储层（Lite：纯明文）
// 职责：内存读写（get/set）+ 明文落盘（flush）+ 旧文件迁移 + 损坏自愈。
// 接口与 electron-store 兼容（get/set），持久化改为显式 await flush()。
// 文件：
//   userData/homework-data.enc      — 主数据（明文 JSON，保留 .enc 命名兼容既有读取路径）
//   userData/homework-data.json     — 更早的明文文件，存在时自动并入后删除
// 注：Lite 版已移除数据加密。若遇到旧版加密文件（CBW1: 前缀），无法解密，
//     会备份为 .corrupted 并回到默认值，绝不静默覆盖。
// ============================================

/**
 * 工厂模式创建明文数据存储。
 * @param {object} opts
 * @param {object} opts.app      - Electron app（取 userData）
 * @param {object} opts.fs       - Node fs
 * @param {object} opts.path     - Node path
 * @param {object} opts.log      - electron-log
 * @param {object} opts.defaults - 默认值（STORE_DEFAULTS）
 */
function createDataStore({ app, fs, path, log, defaults }) {

    const data = Object.assign({}, defaults || {});
    let loaded = false;
    let dirty = false;   // 内存是否有未落盘变更
    let saveChain = Promise.resolve(true);

    function encFile() {
        return path.join(app.getPath('userData'), 'homework-data.enc');
    }

    function plainFile() {
        return path.join(app.getPath('userData'), 'homework-data.json');
    }

    /** 原子写（临时文件 + rename） */
    function writeFileSync(filePath, content) {
        const tmpPath = filePath + '.tmp-' + Date.now();
        fs.writeFileSync(tmpPath, content, 'utf8');
        fs.renameSync(tmpPath, filePath);
    }

    /** 损坏文件备份：重命名为 .corrupted.<ts>，保留现场不直接覆盖 */
    function backupCorrupted(filePath) {
        try {
            const ts = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
            fs.renameSync(filePath, filePath + `.corrupted.${ts}`);
        } catch (e) {
            log.error('[data-store] 备份损坏文件失败:', filePath, e);
        }
    }

    /** 从指定文件加载并解析（纯明文；旧加密 CBW1: 视为不可读 → 交损坏流程） */
    function loadFromFile(filePath) {
        try {
            const raw = fs.readFileSync(filePath, 'utf8');
            if (raw.startsWith('CBW1:')) {
                log.error('[data-store] 检测到旧版加密数据文件，Lite 版不再支持解密:', filePath);
                throw new Error('encrypted-legacy');
            }
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
                Object.assign(data, parsed);
                return true;
            }
        } catch (e) {
            log.error('[data-store] 数据文件损坏，备份后使用默认值:', filePath, e.message || e);
        }
        backupCorrupted(filePath);
        return false;
    }

    /**
     * 加载数据（同步）：优先 homework-data.enc，其次旧明文 homework-data.json。
     * 应在应用启动早期调用一次。
     */
    function load() {
        if (loaded) return;
        loaded = true;

        const enc = encFile();
        const plain = plainFile();

        if (fs.existsSync(enc)) {
            if (loadFromFile(enc)) return;
            if (fs.existsSync(plain) && loadFromFile(plain)) {
                log.warn('[data-store] 主数据文件损坏，已回退读取旧明文文件');
                return;
            }
            log.error('[data-store] 主数据不可读，损坏文件已备份，使用默认值');
            return;
        }

        if (fs.existsSync(plain) && loadFromFile(plain)) {
            log.info('[data-store] 已加载旧明文数据文件');
        }
    }

    /** 读取内存值（兼容 electron-store.get） */
    function get(key, def) {
        const v = data[key];
        return v !== undefined ? v : def;
    }

    /** 写入内存值（兼容 electron-store.set；持久化需后续 await flush()） */
    function set(key, value) {
        data[key] = value;
        dirty = true;
    }

    /** 明文落盘（串行队列，防并发覆盖）；顺带清理旧明文文件 */
    function save() {
        const next = saveChain.then(() => {
            try {
                const plain = JSON.stringify(data, null, 2);
                writeFileSync(encFile(), plain);
                const legacy = plainFile();
                if (fs.existsSync(legacy)) {
                    try { fs.unlinkSync(legacy); } catch (e) {
                        log.error('[data-store] 删除旧明文文件失败:', legacy, e);
                    }
                }
                dirty = false;
                return true;
            } catch (e) {
                log.error('[data-store] 写入失败:', e);
                return false;
            }
        });
        saveChain = next.then(() => true, () => true);
        return next;
    }

    /** 确保变更落盘：若有脏数据先触发保存，再等待队列完成 */
    async function flush() {
        if (dirty) save();
        await saveChain;
    }

    return { load, get, set, save, flush };
}

module.exports = { createDataStore };
