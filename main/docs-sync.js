// ============================================
// main/docs-sync.js — 协议/文档读取
// Lite 版关闭在线同步（DOC_SYNC_ENABLED = false）：随包文档为唯一真源，
// 启动时不再联网拉取，也就不会从完整版仓库取到已过时的旧条款。
// 若日后为 Lite 建立独立文档仓库，打开开关即可恢复以下完整同步能力：
//   启动后台异步拉取（三源兜底：GitHub Pages → jsDelivr → raw 直链），
//   SHA-256 与本地缓存比对，变更则覆盖缓存并触发协议重新确认。
// 版本：每份文档顶部约定 "**版本：vX.Y.Z**"，用于决定是否触发重新确认协议。
// 缓存目录（仅在开关打开时写入）：userData/doc-cache/{name}.md + meta.json
// ============================================

// Lite 版没有独立的文档仓库：随包文档即唯一真源，关闭在线同步，
// 避免从完整版仓库拉取仍包含"数据加密 / QQ 捕获"等已移除功能的旧条款。
const DOC_SYNC_ENABLED = false;

const DOC_FILES = Object.freeze({
    agreement: 'AGREEMENT.md',
    privacy: 'PRIVACY.md',
    security: 'SECURITY.md',
    opensource: 'OPENSOURCE.md',
    contact: 'CONTACT.md'
});

// 主仓库 org/repo（避免与页面名拼写漂移，集中在此）
const OWNER = 'ClassWorkBench';
const REPO = 'classworkbench';
const SITE_REPO = 'classworkbench-site';

// 三源模板：依次作为 primary → fallback1 → fallback2
// 注意：主仓库默认分支为 master（git ls-remote 验证），jsDelivr/raw 必须指向实际分支名
const SOURCE_BASES = [
    `https://${OWNER}.github.io/${SITE_REPO}/docs/`,                            // GitHub Pages
    `https://cdn.jsdelivr.net/gh/${OWNER}/${REPO}@master/`,                 // jsDelivr CDN
    `https://raw.githubusercontent.com/${OWNER}/${REPO}/master/`            // raw 直链（权威，内地不稳）
];

const PER_SOURCE_TIMEOUT = 6000;   // 单个源超时（ms），整链最多约 18s
const SYNC_TTL_MS = 12 * 60 * 60 * 1000;  // 距上次成功同步不足该时长且缓存有效 → 跳过网络拉取
const CACHE_DIR_NAME = 'doc-cache';
const META_FILE = 'meta.json';

module.exports = { createDocsSync, DOC_FILES };

/**
 * 创建文档同步模块（显式依赖注入，风格与其他 main/* 模块一致）。
 * @param {object} opts
 * @param {object} opts.app    - Electron app（取 userData / getAppPath）
 * @param {object} opts.fs     - node fs
 * @param {object} opts.path   - node path
 * @param {object} opts.crypto - node crypto（SHA-256）
 * @param {object} opts.net    - Electron net（net.fetch）
 * @param {object} opts.log    - electron-log
 */
function createDocsSync({ app, fs, path, crypto, net, log }) {

    const cacheDir = () => path.join(app.getPath('userData'), CACHE_DIR_NAME);
    const metaPath = () => path.join(cacheDir(), META_FILE);
    const contentPath = (name) => path.join(cacheDir(), `${name}.md`);
    const bundledPath = (name) => path.join(app.getAppPath(), DOC_FILES[name]);

    // ---- 版本解析：从文档顶部 "**版本：vX.Y.Z**" 提取 semver ----
    function parseVersion(md) {
        if (!md) return '';
        const m = md.match(/\*\*[\s]*版本[\s]*[:：][\s]*[vV]?([0-9]+\.[0-9]+\.[0-9]+)/);
        return m ? m[1] : '';
    }

    // ---- 读取陈旧缓存元信息 ----
    function readMeta() {
        try {
            return JSON.parse(fs.readFileSync(metaPath(), 'utf8'));
        } catch (_) {
            return {};
        }
    }

    function writeMeta(meta) {
        const dir = cacheDir();
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const tmp = `${metaPath()}.tmp-${Date.now()}`;
        fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf8');
        fs.renameSync(tmp, metaPath());
    }

    // ---- TTL 判断：所有文档缓存均在有效期内且文件存在 → 无需联网 ----
    function isSyncFresh(meta) {
        const cutoff = Date.now() - SYNC_TTL_MS;
        for (const name of Object.keys(DOC_FILES)) {
            const m = meta && meta[name];
            if (!m || !m.fetchedAt || m.fetchedAt < cutoff) return false;
            if (!fs.existsSync(contentPath(name))) return false;
        }
        return true;
    }

    // ---- 读取某文档当前生效内容：在线缓存优先，无缓存回退随应用分发的源文件 ----
    function readDoc(name) {
        const file = DOC_FILES[name];
        if (!file) return null;
        // Lite：随包文档为唯一真源，忽略历史在线缓存
        if (!DOC_SYNC_ENABLED) return readBundled(name);
        // 原子写 + 损坏容错：缓存文件读取失败（半写损坏等）时回退随包文件
        try {
            return fs.readFileSync(contentPath(name), 'utf8');
        } catch (_) {
            // 无在线缓存 → 用本地随包文件
        }
        try {
            return fs.readFileSync(bundledPath(name), 'utf8');
        } catch (e) {
            log.error(`[docs-sync] 读取 ${file} 失败:`, e);
            return null;
        }
    }

    function readBundled(name) {
        const file = DOC_FILES[name];
        if (!file) return null;
        try {
            return fs.readFileSync(bundledPath(name), 'utf8');
        } catch (_) {
            return null;
        }
    }

    // ---- 单文档三源兜底拉取：返回 {content} 或 null ----
    async function fetchDoc(name) {
        const file = DOC_FILES[name];
        const buster = `?_t=${Date.now()}`;   // 打散各级 HTTP 缓存
        for (const base of SOURCE_BASES) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), PER_SOURCE_TIMEOUT);
            try {
                const res = await net.fetch(base + file + buster, { signal: controller.signal });
                if (!res.ok) continue;
                const text = await res.text();
                if (text && text.trim()) {
                    return { content: text, source: base };
                }
            } catch (e) {
                // 当前源失败 → 继续下一个兜底源
            } finally {
                clearTimeout(timer);
            }
        }
        return null;
    }

    /**
     * 同步一次：拉取全部文档 → 哈希比对 → 变更则落盘缓存。
     * 返回 { changed: string[], effective: {name:{source}} , failed: string[] }
     * changed 中按文档名列出本次确有内容变化者（可在渲染层触发重新确认协议）。
     */
    async function sync() {
        if (!DOC_SYNC_ENABLED) {
            log.info('[docs-sync] Lite 版已关闭在线文档同步，使用随包文档');
            return { changed: [], failed: [], effective: {}, disabled: true };
        }
        const prevMeta = readMeta();
        // TTL 短路：缓存仍在有效期内则跳过网络拉取，直接返回缓存状态（不产生 changed）
        if (isSyncFresh(prevMeta)) {
            log.info('[docs-sync] 缓存仍在有效期内，跳过在线同步');
            const effective = {};
            for (const name of Object.keys(DOC_FILES)) if (prevMeta[name]) effective[name] = prevMeta[name];
            return { changed: [], failed: [], effective, fresh: true };
        }
        const changed = [];
        const failed = [];
        const effective = {};

        await Promise.all(Object.keys(DOC_FILES).map(async (name) => {
            try {
                const got = await fetchDoc(name);
                if (!got) { failed.push(name); return; }
                const hash = crypto.createHash('sha256').update(got.content, 'utf8').digest('hex');
                const old = prevMeta && prevMeta[name];
                // 原子写（tmp + rename）：进程在写一半退出也不会留损坏缓存
                const dir = cacheDir();
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                const tmp = `${contentPath(name)}.tmp-${Date.now()}`;
                fs.writeFileSync(tmp, got.content, 'utf8');
                fs.renameSync(tmp, contentPath(name));
                prevMeta[name] = { hash, fetchedAt: Date.now(), source: got.source };
                effective[name] = prevMeta[name];
                if (!old || old.hash !== hash) {
                    changed.push(name);
                    log.info(`[docs-sync] 文档已更新: ${name}（source=${got.source}）`);
                }
            } catch (e) {
                log.error(`[docs-sync] 同步 ${name} 异常:`, e);
                failed.push(name);
            }
        }));

        writeMeta(prevMeta);
        if (failed.length) log.warn(`[docs-sync] 同步失败，沿用旧缓存: ${failed.join(', ')}`);
        return { changed, failed, effective };
    }

    // ---- 本地生效对象最近一次成功来源（无则空串） ----
    function sourceFor(name) {
        if (!DOC_SYNC_ENABLED) return '';
        const meta = readMeta();
        return (meta && meta[name] && meta[name].source) || '';
    }

    return { readDoc, readBundled, parseVersion, sync, sourceFor };
}
