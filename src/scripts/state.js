// ============================================
// state.js
// 全局状态与 DOM 引用集中管理
// ============================================

let homeworks = [];
let subjectList = [];
function localTodayStr() {
    const d = new Date();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${month}-${day}`;
}
let currentViewDate = localTodayStr();
let settings = {
    eveningSections: [
        { start: '19:00', end: '19:50' },
        { start: '20:00', end: '20:50' },
        { start: '21:00', end: '21:50' }
    ],
    contentFontSize: 26,
    openmeteoCities: [],           // Open-Meteo 城市列表 [{ id, name, lat, lon, country, admin1, timezone }]
    qweatherCities: [],            // 和风天气城市列表 [{ id, name, locationId, country, admin1, timezone }]
    weatherProvider: 'openmeteo',    // 'openmeteo' | 'qweather'
    weatherRefreshInterval: 30,      // 天气刷新间隔（分钟），0 = 不刷新
    weatherRefreshMode: 'foreground',    // 'always' | 'foreground' 始终刷新 / 仅前台刷新（默认前台更省资源，可在设置面板改）
    qweatherApiHost: '',             // 和风天气专属 API Host
    qweatherApiKey: '',              // 和风天气 API Key（旧认证，JWT 迁移后保留兼容）
    qweatherKid: '',                 // 和风 JWT 凭据 ID（控制台-项目管理查看）
    qweatherSub: '',                 // 和风 JWT 项目 ID（sub 签发主体）
    qweatherPrivateKey: '',          // 和风 Ed25519 私钥状态：渲染层只持有掩码 '*configured*'（有值=已配置），明文仅存主进程加密存储
    alertEnabledLevels: ['blue', 'yellow', 'orange', 'red'],  // 预警级别筛选，默认全选
    bgRefreshInterval: 30,
    bgSource: 'upx8',
    bgRefreshMode: 'foreground',       // 'always' | 'foreground' 始终刷新 / 仅前台刷新（默认前台更省资源，可在设置面板改）
    cardColumns: 3,
    autoNumber: true,                // 弹窗中回车自动编号，首次预置 "1. "
    beautifyNumber: true,            // 卡片中把 "1. " 格式化为圆圈编号显示
    blurBars: true,                  // 顶/底栏/Toast 高斯模糊
    blurCard: true,                  // 作业卡片高斯模糊
    blurModal: true,                 // 模态弹窗高斯模糊
    reduceAnimation: false,          // 减弱动画效果（标准/减弱，iOS 式淡入淡出）
    appearance: 'system',            // 外观模式：'system' 跟随系统 | 'light' 浅色 | 'dark' 深色
    // 首次使用向导
    wizardCompleted: false,          // 是否已完成首次设置向导
    acceptedAgreementVersion: '',    // 已同意的用户协议/隐私声明版本（AGREEMENT_VERSION）
    // QQ sidecar 配置
    qq: {
        enabled: false,                // 是否启用监听
        // 老师列表：每项 { name: QQ昵称, subjectId: 学科id, subjectName: 学科名（冗余便于显示） }
        teachers: [],
        scanIntervalSeconds: 0.5,      // sidecar 轮询间隔
        cooldownSeconds: 3,            // 同条消息冷却
        // 作业关键词（用户可自定义，分值固定：强 +40 / 弱 +30）
        keywords: {
            strong: ['作业', '完成', '上交', '提交', '订正', '背诵', '默写'],
            weak: ['做', '写', '复习', '预习', '练习', '答案']
        },
        // 待确认作业候选队列
        pendingCandidates: []
    },
    // 拍照搜题配置
    solve: {
        cameraId: '',                  // 默认摄像头 deviceId（空 = 系统默认）
        flip: false,                   // 画面镜像翻转（展台常需水平翻转）
        autoScan: true,                // 扫描仪式自动抓拍（放稳后自动拍照）
        sensitivity: 2,                // 自动抓拍灵敏度 1=低 2=中 3=高
        resolution: '720',             // 摄像头启动分辨率 640=流畅 720=标准 1080=高清
        prewarm: false                 // 应用启动后后台预加载搜题页面（默认关：省内存；开：换速度）
    }
};

const $ = (id) => document.getElementById(id);

const dom = {
    clockDisplay: () => $('clockDisplay'),
    eveningLabel: () => $('eveningLabel'),
    eveningTime: () => $('eveningTime'),
    progressFill: () => $('progressFill'),
    progressBar: () => document.querySelector('#progressBar'),
    cardsGrid: () => $('cardsGrid'),
    subjectPills: () => $('subjectPills'),
    dateText: () => $('dateText'),
    toastContainer: () => $('toastContainer'),
    weatherAreaName: () => $('weatherAreaName'),
    weatherEmoji: () => $('weatherEmoji'),
    weatherTemp: () => $('weatherTemp'),
    weatherDesc: () => $('weatherDesc'),
    weatherDisplay: () => $('weatherDisplay'),
    alertCapsule: () => $('alertCapsule'),
    alertDot: () => $('alertDot'),
    alertText: () => $('alertText'),
    alertCount: () => $('alertCount'),
    bgLayer: () => $('bgLayer'),
    topCapsule: () => $('topCapsule'),
    modalRoot: () => $('modalRoot'),
    moreToggle: () => $('moreToggle'),
    dateBtn: () => $('dateBtn'),
    bottomCapsule: () => $('bottomCapsule'),
    dpPrev: () => $('dpPrev'),
    dpNext: () => $('dpNext'),
};

// ---- 状态变更订阅：key -> [fn(value, extra)] ----
// 目前用于 currentViewDate 的「单一渲染入口」：渲染器订阅后，
// 调用方只需 state.setViewDate(date, { slide|animate })，不再各自手动触发渲染。
// 直接给 setter 赋值（state.currentViewDate = x）不触发通知，保持旧行为。
const stateListeners = {};
function notifyState(key, value, extra) {
    const ls = stateListeners[key];
    if (!ls) return;
    for (const fn of ls) {
        try { fn(value, extra); }
        catch (e) { console.error('[state] 变更回调异常:', key, e); }
    }
}

window.AppState = {
    get homeworks() { return homeworks; },
    set homeworks(v) { homeworks = v; },
    get subjectList() { return subjectList; },
    set subjectList(v) { subjectList = v; },
    get currentViewDate() { return currentViewDate; },
    set currentViewDate(v) { currentViewDate = v; },
    get settings() { return settings; },
    set settings(v) { settings = v; },
    dom,

    // 变更视图日期：集中入口，统一触发订阅（渲染器据此渲染），
    // opts：{ slide: ±1 } 用滑切动画；{ animate: true } 用渐变动画；否则默认重渲染
    setViewDate(date, opts = {}) {
        currentViewDate = date;
        notifyState('currentViewDate', date, opts);
    },

    // 订阅状态变更；返回取消订阅函数
    onChange(key, fn) {
        (stateListeners[key] || (stateListeners[key] = [])).push(fn);
        return () => {
            const a = stateListeners[key];
            if (!a) return;
            const i = a.indexOf(fn);
            if (i >= 0) a.splice(i, 1);
        };
    },
};
