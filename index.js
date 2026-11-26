import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types, chat, saveChatConditional } from "../../../../script.js";
import { getTokenCountAsync } from "../../../tokenizers.js";

const MODULE_NAME = "gemini_cost_calculator";
const EXT_VERSION = "2.3.0";
const SETTINGS_HTML_URL = new URL("./settings.html", import.meta.url).href;
const STATS_STORAGE_KEY = "gemini_cost_daily_stats_v2";
const RECENT_LOGS_KEY = "gemini_cost_recent_logs_v2";
const ERROR_LOGS_KEY = "gemini_cost_error_logs_v1";
const WALLETS_STORAGE_KEY = "gemini_cost_wallets_v1";

// 2026 최신 Gemini 모델별 단가 프리셋 (1M 토큰당 USD)
const PRESETS = {
    "gemini-4-carbon-promo": {
        label: "Gemini 4 Carbon / Argon (~11/30)",
        shortLabel: "Carbon (프로모션)",
        tierThreshold: 200000,
        inBase: 2.00, cacheBase: 0.10, outBase: 10.00,
        inHigh: 2.00, cacheHigh: 0.10, outHigh: 10.00,
    },
    "gemini-4-carbon-std": {
        label: "Gemini 4 Carbon / Argon (12/1~)",
        shortLabel: "Carbon (정상가)",
        tierThreshold: 200000,
        inBase: 4.00, cacheBase: 0.20, outBase: 20.00,
        inHigh: 4.00, cacheHigh: 0.20, outHigh: 20.00,
    },
    "gemini-4-hydrogen": {
        label: "Gemini 4 Hydrogen",
        shortLabel: "Hydrogen",
        tierThreshold: 200000,
        inBase: 1.50, cacheBase: 0.075, outBase: 7.50,
        inHigh: 1.50, cacheHigh: 0.075, outHigh: 7.50,
    },
    "gemini-4-neon": {
        label: "Gemini 4 Neon",
        shortLabel: "Neon",
        tierThreshold: 200000,
        inBase: 3.00, cacheBase: 0.15, outBase: 15.00,
        inHigh: 3.00, cacheHigh: 0.15, outHigh: 15.00,
    },
    "gemini-3.8-flash": {
        label: "Gemini 3.8 Flash (~12/31)",
        shortLabel: "3.8 Flash",
        tierThreshold: 200000,
        inBase: 0.75, cacheBase: 0.075, outBase: 3.75,
        inHigh: 0.75, cacheHigh: 0.075, outHigh: 3.75,
    },
    "gemini-3.5-flash-lite": {
        label: "Gemini 3.5 Flash-Lite",
        shortLabel: "3.5 Flash-Lite",
        tierThreshold: 200000,
        inBase: 0.30, cacheBase: 0.03, outBase: 2.50,
        inHigh: 0.30, cacheHigh: 0.03, outHigh: 2.50,
    },
    "gemini-3.1-pro": {
        label: "Gemini 3.1 Pro Preview (200k)",
        shortLabel: "3.1 Pro",
        tierThreshold: 200000,
        inBase: 2.00, cacheBase: 0.20, outBase: 12.00,
        inHigh: 4.00, cacheHigh: 0.40, outHigh: 18.00,
    },
};

const DEFAULT_SETTINGS = {
    enabled: true,
    showBadges: true,
    notifyCacheMiss: false,
    vertexRegionalMarkup: false,
    interceptFetch: true,
    autoModelPricing: true,
    preset: "gemini-4-carbon-promo",
    customName: "직접 입력",
    customPresets: [],
    tierThreshold: 200000,
    inBase: 2.00,
    cacheBase: 0.10,
    outBase: 10.00,
    inHigh: 2.00,
    cacheHigh: 0.10,
    outHigh: 10.00,
    autoCache: true,
    autoCacheRate: true,
    cacheRate: 80,
    autoBasePrompt: true,
    basePromptTokens: 2500,
    exchangeRate: 1400,
    displayMode: "both",
    dailyBudgetKrw: 0,
    monthlyBudgetKrw: 0,
};

const CATEGORY_LABELS = {
    main: "메인",
    ext: "확장",
    summary: "요약",
    translate: "번역",
    aux: "부가기능",
};

const WRAPPER_EXTENSION_FRAMES = [
    { ext: "gemini-cost-calculator" },
    { ext: "blue-lemonade", sub: "/src/addons/perf/" },
    { ext: "ST-QuickActions", sub: "vertex-profile-fix.js" },
    { ext: "ST-QuickActions", sub: "qr-input.js" },
    { ext: "perf-assist" },
    { ext: "request-log" },
];

let lastPromptTokens = 0;
let lastMainPromptAt = 0;
let lastCapturedMainRecord = null;
let pendingMainFetchPromise = null;
const notifiedBudgetFlags = new Set();
const notifiedWalletFlags = new Set();
const tokenCountCache = new Map();
let cachedSecretState = null;

// SillyTavern 다중 API 키 관리(secret_state)에서 키 원문은 절대 읽지 않고 '키 이름(label)'만 안전하게 참조
import("../../../secrets.js")
    .then(mod => {
        if (mod && mod.secret_state) cachedSecretState = mod.secret_state;
    })
    .catch(() => { /* 구버전 ST 호환: 미지원 시 무시 */ });

async function getCachedTokenCount(text) {
    const str = String(text || "");
    if (!str) return 0;
    const cacheKey = `${str.length}:${str.slice(0, 64)}:${str.slice(-32)}`;
    if (tokenCountCache.has(cacheKey)) return tokenCountCache.get(cacheKey);
    const count = await getTokenCountAsync(str);
    if (tokenCountCache.size >= 3000) {
        const firstKey = tokenCountCache.keys().next().value;
        if (firstKey !== undefined) tokenCountCache.delete(firstKey);
    }
    tokenCountCache.set(cacheKey, count);
    return count;
}

function getEffectiveMaxContext() {
    try {
        const ctx = window.SillyTavern?.getContext?.() || {};
        const candidates = [
            Number(ctx.maxContext),
            Number(ctx.chatCompletionSettings?.openai_max_context),
        ].filter(n => Number.isFinite(n) && n >= 2048);
        if (candidates.length > 0) return candidates[0];
    } catch { /* ignore */ }
    return 0;
}

function getTodayKey() {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
}

function getTimeStr() {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

function loadDailyStats() {
    try {
        return JSON.parse(localStorage.getItem(STATS_STORAGE_KEY)) || {};
    } catch {
        return {};
    }
}

function saveDailyStats(stats) {
    localStorage.setItem(STATS_STORAGE_KEY, JSON.stringify(stats));
}

function loadRecentLogs() {
    try {
        return JSON.parse(localStorage.getItem(RECENT_LOGS_KEY)) || [];
    } catch {
        return [];
    }
}

function saveRecentLogs(logs) {
    localStorage.setItem(RECENT_LOGS_KEY, JSON.stringify(logs.slice(0, 100)));
}

function loadWallets() {
    try {
        const parsed = JSON.parse(localStorage.getItem(WALLETS_STORAGE_KEY));
        if (parsed && Array.isArray(parsed.items)) {
            return {
                activeId: typeof parsed.activeId === "string" ? parsed.activeId : "",
                paused: Boolean(parsed.paused),
                items: parsed.items,
            };
        }
    } catch { /* ignore */ }
    return { activeId: "", paused: false, items: [] };
}

function saveWallets(data) {
    try {
        localStorage.setItem(WALLETS_STORAGE_KEY, JSON.stringify({
            activeId: data?.activeId || "",
            paused: Boolean(data?.paused),
            items: Array.isArray(data?.items) ? data.items : [],
        }));
    } catch { /* ignore */ }
}

/**
 * SillyTavern Connection Manager 현재 활성 프로필명 조회 (API 키는 절대 읽지 않음)
 */
function getActiveConnectionProfileName() {
    try {
        const cm = extension_settings?.connectionManager;
        if (cm && Array.isArray(cm.profiles) && cm.selectedProfile) {
            const found = cm.profiles.find(p => p && p.id === cm.selectedProfile);
            if (found?.name) return String(found.name).trim();
        }
    } catch { /* ignore */ }
    return "";
}

/**
 * SillyTavern 다중 API 키 관리에서 현재 활성화된 '키 이름(label)' 목록만 안전하게 조회
 * (API 키 원문은 단 한 글자도 읽거나 저장하지 않음)
 */
function getActiveSecretLabels() {
    const labels = [];
    try {
        const state = cachedSecretState;
        if (!state || typeof state !== "object") return labels;

        const ctx = window.SillyTavern?.getContext?.() || {};
        const source = String(ctx.chatCompletionSettings?.chat_completion_source || "").toLowerCase();
        const sourceToSecretKey = {
            vertexai: "api_key_vertexai",
            makersuite: "api_key_makersuite",
            openrouter: "api_key_openrouter",
            custom: "api_key_custom",
            openai: "api_key_openai",
            claude: "api_key_claude",
            deepseek: "api_key_deepseek",
            xai: "api_key_xai",
        };

        const orderedKeys = [];
        if (sourceToSecretKey[source]) orderedKeys.push(sourceToSecretKey[source]);
        Object.keys(state).forEach(k => {
            if (!orderedKeys.includes(k)) orderedKeys.push(k);
        });

        for (const sKey of orderedKeys) {
            const arr = state[sKey];
            if (!Array.isArray(arr)) continue;
            for (const entry of arr) {
                if (entry && entry.active === true && typeof entry.label === "string") {
                    const lbl = entry.label.trim();
                    if (lbl && !labels.includes(lbl)) labels.push(lbl);
                }
            }
        }
    } catch { /* ignore */ }
    return labels;
}

/**
 * 지갑에 등록된 쉼표(,) 구분 자동 매칭 이름 목록 파싱
 */
function parseWalletMatchNames(raw) {
    return String(raw || "")
        .split(",")
        .map(s => s.trim())
        .filter(Boolean);
}

/**
 * 다른 지갑에 이미 등록된 키 이름(라벨) 중복 여부 확인
 */
function findDuplicateWalletKeys(walletsData, matchNames, excludeWalletId = "") {
    const conflicts = [];
    const items = Array.isArray(walletsData?.items) ? walletsData.items : [];
    const targetLowers = new Set(matchNames.map(n => n.toLowerCase()));
    if (targetLowers.size === 0) return conflicts;

    for (const w of items) {
        if (!w || w.id === excludeWalletId) continue;
        const wNames = parseWalletMatchNames(w.profileName);
        for (const wn of wNames) {
            if (targetLowers.has(wn.toLowerCase())) {
                conflicts.push({ keyName: wn, walletName: w.name });
            }
        }
    }
    return conflicts;
}

/**
 * 현재 API 호출에 적용할 크레딧 지갑 결정
 * - 사용자가 명시적으로 '차감 안 함(paused)' 선택 시 자동 매칭도 일시 중지
 * 1순위: 현재 활성 API 키 이름(label) 매칭
 * 2순위: 현재 SillyTavern 연결 프로필 이름 매칭
 * 3순위: 사용자가 선택한 기본 활성 지갑
 */
function resolveTargetWalletWithReason(walletsData) {
    const items = Array.isArray(walletsData?.items) ? walletsData.items : [];
    if (items.length === 0 || walletsData?.paused) return { wallet: null, matchedBy: "", matchedName: "" };

    // 1. 현재 활성 API 키 이름(label) 매칭 (키 원문 미접근)
    const activeLabels = getActiveSecretLabels();
    if (activeLabels.length > 0) {
        const labelMap = new Map(activeLabels.map(l => [l.toLowerCase(), l]));
        for (const w of items) {
            const names = parseWalletMatchNames(w.profileName);
            for (const n of names) {
                const hit = labelMap.get(n.toLowerCase());
                if (hit) return { wallet: w, matchedBy: "keyLabel", matchedName: hit };
            }
        }
    }

    // 2. SillyTavern 연결 프로필 이름 매칭
    const activeProfile = getActiveConnectionProfileName();
    if (activeProfile) {
        const lowerProf = activeProfile.toLowerCase();
        for (const w of items) {
            const names = parseWalletMatchNames(w.profileName);
            if (names.some(n => n.toLowerCase() === lowerProf)) {
                return { wallet: w, matchedBy: "profile", matchedName: activeProfile };
            }
        }
    }

    // 3. 수동 선택 활성 지갑
    if (walletsData.activeId) {
        const byId = items.find(w => w.id === walletsData.activeId);
        if (byId) return { wallet: byId, matchedBy: "manual", matchedName: "" };
    }
    return { wallet: null, matchedBy: "", matchedName: "" };
}

function resolveTargetWallet(walletsData) {
    return resolveTargetWalletWithReason(walletsData).wallet;
}

function formatWalletAmount(amount, currency) {
    const num = Number(amount) || 0;
    if (currency === "KRW") {
        return `${Math.round(num).toLocaleString()}원`;
    }
    const sign = num < 0 ? "-" : "";
    return `${sign}$${Math.abs(num).toFixed(2)}`;
}

function getWalletDdayLabel(expiresAt) {
    if (!expiresAt) return "";
    const target = Date.parse(`${expiresAt}T23:59:59`);
    if (!Number.isFinite(target)) return "";
    const diffDays = Math.ceil((target - Date.now()) / (24 * 60 * 60 * 1000));
    if (diffDays < 0) return "만료됨";
    if (diffDays === 0) return "D-Day";
    return `D-${diffDays}`;
}

function checkWalletAlert(wallet) {
    if (!wallet || !window.toastr) return;
    const init = Number(wallet.initialAmount) || 0;
    const bal = Number(wallet.balance) || 0;
    const balStr = formatWalletAmount(bal, wallet.currency);

    if (bal <= 0) {
        const flag0 = `w0:${wallet.id}`;
        if (!notifiedWalletFlags.has(flag0)) {
            notifiedWalletFlags.add(flag0);
            notifiedWalletFlags.add(`w20:${wallet.id}`);
            toastr.error(`잔액 ${balStr}`, `[${wallet.name}] 크레딧 소진`);
        }
    } else if (init > 0 && (bal / init) <= 0.2) {
        const flag20 = `w20:${wallet.id}`;
        if (!notifiedWalletFlags.has(flag20)) {
            notifiedWalletFlags.add(flag20);
            toastr.warning(`남은 잔액 ${balStr} (${Math.round((bal / init) * 100)}%)`, `[${wallet.name}] 크레딧 부족`);
        }
    }
}

function deductFromWallet(costUsd, costKrw) {
    const wallets = loadWallets();
    const target = resolveTargetWallet(wallets);
    if (!target) return { walletId: "", walletDeducted: 0 };

    const deduct = target.currency === "KRW" ? (Number(costKrw) || 0) : (Number(costUsd) || 0);
    target.balance = (Number(target.balance) || 0) - deduct;
    target.updatedAt = Date.now();
    saveWallets(wallets);
    checkWalletAlert(target);
    return { walletId: target.id, walletDeducted: deduct };
}

function refundToWallet(walletId, amount) {
    if (!walletId || !amount) return;
    const wallets = loadWallets();
    const target = wallets.items.find(w => w.id === walletId);
    if (!target) return;
    target.balance = (Number(target.balance) || 0) + (Number(amount) || 0);
    target.updatedAt = Date.now();
    saveWallets(wallets);
}

function loadErrorLogs() {
    try {
        return JSON.parse(localStorage.getItem(ERROR_LOGS_KEY)) || [];
    } catch {
        return [];
    }
}

function saveErrorLogs(logs) {
    try {
        localStorage.setItem(ERROR_LOGS_KEY, JSON.stringify(logs.slice(0, 30)));
    } catch { /* ignore */ }
}

function recordErrorLog(code, context, err) {
    try {
        const logs = loadErrorLogs();
        const message = err instanceof Error ? err.message : String(err ?? "Unknown error");
        const stack = err instanceof Error && err.stack
            ? err.stack.split("\n").slice(0, 4).map(s => s.trim()).join(" | ")
            : "";
        logs.unshift({
            code: String(code || "GCOST-ERR"),
            time: `${getTodayKey()} ${getTimeStr()}`,
            ts: Date.now(),
            context: String(context || ""),
            message: message.slice(0, 300),
            stack: stack.slice(0, 500),
        });
        saveErrorLogs(logs);
    } catch { /* ignore */ }
}

/**
 * 해당 오류 코드의 작업이 정상적으로 성공하면 이전 오류 기록을 자동 해소
 */
function resolveErrorCode(code) {
    try {
        const logs = loadErrorLogs();
        if (!logs.length) return;
        const filtered = logs.filter(e => e.code !== code);
        if (filtered.length === logs.length) return;
        saveErrorLogs(filtered);
        const $btn = $(".gcost-diag-btn");
        if ($btn.length) {
            if (filtered.length > 0) {
                $btn.addClass("has-error").text(`오류 확인 · ${filtered.length}`);
            } else {
                $btn.removeClass("has-error").text("오류 확인");
            }
        }
    } catch { /* ignore */ }
}

function clearErrorLogs() {
    localStorage.removeItem(ERROR_LOGS_KEY);
}

function buildDiagnosticReportText() {
    const s = getSettings();
    const errors = loadErrorLogs();
    const lines = [
        `[Gemini Cost Calculator 진단 리포트]`,
        `- 버전: v${EXT_VERSION}`,
        `- 시각: ${getTodayKey()} ${getTimeStr()}`,
        `- 설정: preset=${s.preset}, intercept=${s.interceptFetch}, autoModel=${s.autoModelPricing}, autoCache=${s.autoCache}, autoBase=${s.autoBasePrompt}, rate=${s.exchangeRate}`,
        `- 환경: ${navigator.userAgent}`,
        `- 기록된 오류: ${errors.length}건`,
    ];

    if (errors.length > 0) {
        lines.push("", "--- 오류 상세 ---");
        errors.slice(0, 15).forEach((e, i) => {
            lines.push(`${i + 1}. [${e.code}] (${e.time}) ${e.context ? `[${e.context}] ` : ""}${e.message}`);
            if (e.stack) lines.push(`   stack: ${e.stack}`);
        });
    }

    return lines.join("\n");
}

async function copyTextToClipboard(text) {
    try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch { /* fallback below */ }

    try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
    } catch {
        return false;
    }
}

function findPresetByKey(key, settings) {
    if (!key) return null;
    if (PRESETS[key]) return PRESETS[key];
    const customs = Array.isArray(settings?.customPresets) ? settings.customPresets : [];
    const found = customs.find(c => c.id === key);
    if (found) {
        return {
            label: `${found.label} (커스텀)`,
            shortLabel: found.label,
            tierThreshold: found.tierThreshold ?? 200000,
            inBase: found.inBase,
            cacheBase: found.cacheBase,
            outBase: found.outBase,
            inHigh: found.inHigh ?? found.inBase,
            cacheHigh: found.cacheHigh ?? found.cacheBase,
            outHigh: found.outHigh ?? found.outBase,
            isCustom: true,
        };
    }
    return null;
}

function getDefaultPresetKey() {
    return getTodayKey() <= "2026-11-30" ? "gemini-4-carbon-promo" : "gemini-4-carbon-std";
}

/**
 * 모델별 공식 암묵적 캐싱 최소 토큰 임계값 (Google 공식 문서 기준)
 * - Gemini 2.5 계열: 2,048 토큰
 * - Gemini 3.x / Gemini 4 계열: 4,096 토큰
 */
function getMinCacheTokens(modelHint = "") {
    const lower = String(modelHint || "").toLowerCase();
    if (lower.includes("2.5") || lower.includes("2-5")) return 2048;
    return 4096;
}

function getRegionalMultiplier(settings, isCustomPricing = false) {
    return (settings?.vertexRegionalMarkup && !isCustomPricing) ? 1.1 : 1;
}

/**
 * 캐시 적중으로 절약된 금액(USD/KRW) 계산 (일반 입력 단가 대비 차액)
 */
function calcCacheSaved(cacheTokens, totalInput, pricing, exchangeRate, multiplier = 1) {
    if (!cacheTokens || cacheTokens <= 0 || !pricing) return { savedUsd: 0, savedKrw: 0 };
    const isHighTier = totalInput > (pricing.tierThreshold || 200000);
    const pIn = (isHighTier ? (pricing.inHigh ?? pricing.inBase ?? 0) : (pricing.inBase ?? 0)) * multiplier;
    const pCache = (isHighTier ? (pricing.cacheHigh ?? pricing.cacheBase ?? 0) : (pricing.cacheBase ?? 0)) * multiplier;
    const diff = Math.max(0, pIn - pCache);
    const savedUsd = (cacheTokens * diff) / 1_000_000;
    const savedKrw = savedUsd * (Number(exchangeRate) || 1400);
    return { savedUsd, savedKrw };
}

function getLogSavedKrw(log, settings) {
    if (!log || !log.cacheTokens || log.cacheTokens <= 0) return 0;
    if (typeof log.savedKrw === "number" && Number.isFinite(log.savedKrw)) return log.savedKrw;
    const resolved = resolveModelPricing(log.modelLabel || log.modelKey || "", settings);
    const rate = log.exchangeRate || settings.exchangeRate || 1400;
    const mult = getRegionalMultiplier(settings, !resolved.matched && (settings.preset === "custom" || Boolean(findPresetByKey(settings.preset, settings)?.isCustom)));
    return calcCacheSaved(log.cacheTokens, log.totalInput || 0, resolved.pricing, rate, mult).savedKrw;
}

function formatElapsedMs(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "";
    const sec = Math.round(ms / 1000);
    if (sec < 60) return `${sec}초`;
    const min = Math.floor(sec / 60);
    const remSec = sec % 60;
    if (min < 60) return remSec > 0 ? `${min}분 ${remSec}초` : `${min}분`;
    const hr = Math.floor(min / 60);
    const remMin = min % 60;
    return remMin > 0 ? `${hr}시간 ${remMin}분` : `${hr}시간`;
}

/**
 * 로그의 타임스탬프(ms) 추출 (구버전 로그 호환: ts → id 앞자리 → date+time 폴백)
 */
function getLogTimestamp(log) {
    if (!log) return 0;
    if (typeof log.ts === "number" && Number.isFinite(log.ts) && log.ts > 0) return log.ts;
    if (typeof log.id === "string") {
        const prefix = parseInt(log.id.split("_")[0], 10);
        if (Number.isFinite(prefix) && prefix > 1_600_000_000_000) return prefix;
    }
    if (log.date && log.time) {
        const parsed = Date.parse(`${log.date}T${log.time}:00`);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return 0;
}

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        const defKey = getDefaultPresetKey();
        const { label, shortLabel, ...pricing } = PRESETS[defKey];
        extension_settings[MODULE_NAME] = { ...DEFAULT_SETTINGS, preset: defKey, ...pricing, customPresets: [] };
    }
    const merged = Object.assign({}, DEFAULT_SETTINGS, extension_settings[MODULE_NAME]);
    if (!Array.isArray(merged.customPresets)) merged.customPresets = [];
    if (merged.preset !== "custom" && !findPresetByKey(merged.preset, merged)) {
        const defKey = getDefaultPresetKey();
        const { label, shortLabel, ...pricing } = PRESETS[defKey];
        Object.assign(merged, { preset: defKey, ...pricing });
        extension_settings[MODULE_NAME] = merged;
    }
    return merged;
}

function updateSettings(partial) {
    extension_settings[MODULE_NAME] = Object.assign(getSettings(), partial);
    saveSettingsDebounced();
}

/**
 * 요청/응답의 모델 문자열로부터 자동으로 단가 프리셋 매칭
 */
function resolveModelPricing(modelName, settings) {
    const raw = String(modelName || "").trim();
    const lower = raw.toLowerCase();

    if (settings.autoModelPricing && lower) {
        const isPromoPeriod = getTodayKey() <= "2026-11-30";
        if (lower.includes("carbon") || lower.includes("argon")) {
            const key = isPromoPeriod ? "gemini-4-carbon-promo" : "gemini-4-carbon-std";
            return { key, shortLabel: PRESETS[key].shortLabel, pricing: PRESETS[key], matched: true };
        }
        if (lower.includes("hydrogen")) {
            return { key: "gemini-4-hydrogen", shortLabel: PRESETS["gemini-4-hydrogen"].shortLabel, pricing: PRESETS["gemini-4-hydrogen"], matched: true };
        }
        if (lower.includes("neon")) {
            return { key: "gemini-4-neon", shortLabel: PRESETS["gemini-4-neon"].shortLabel, pricing: PRESETS["gemini-4-neon"], matched: true };
        }
        if (lower.includes("3.8") || lower.includes("3-8")) {
            return { key: "gemini-3.8-flash", shortLabel: PRESETS["gemini-3.8-flash"].shortLabel, pricing: PRESETS["gemini-3.8-flash"], matched: true };
        }
        if (lower.includes("flash-lite") || lower.includes("flash_lite") || lower.includes("3.5")) {
            return { key: "gemini-3.5-flash-lite", shortLabel: PRESETS["gemini-3.5-flash-lite"].shortLabel, pricing: PRESETS["gemini-3.5-flash-lite"], matched: true };
        }
        if (lower.includes("3.1-pro") || lower.includes("3.1_pro")) {
            return { key: "gemini-3.1-pro", shortLabel: PRESETS["gemini-3.1-pro"].shortLabel, pricing: PRESETS["gemini-3.1-pro"], matched: true };
        }
    }

    const activePresetObj = findPresetByKey(settings.preset, settings);
    const fallbackLabel = raw
        || (settings.preset === "custom" ? (settings.customName?.trim() || "직접 입력") : activePresetObj?.shortLabel)
        || "Custom";
    return {
        key: settings.preset || "custom",
        shortLabel: fallbackLabel.length > 22 ? fallbackLabel.slice(0, 22) + "…" : fallbackLabel,
        pricing: settings,
        matched: false,
    };
}

function calcTurnCostUsd(normalInput, cacheTokens, outTokens, thinkTokens, totalInput, pricing, multiplier = 1) {
    const isHighTier = totalInput > pricing.tierThreshold;
    const pIn = (isHighTier ? pricing.inHigh : pricing.inBase) * multiplier;
    const pCache = (isHighTier ? pricing.cacheHigh : pricing.cacheBase) * multiplier;
    const pOut = (isHighTier ? pricing.outHigh : pricing.outBase) * multiplier;

    const costUsd = ((normalInput * pIn) + (cacheTokens * pCache) + ((outTokens + thinkTokens) * pOut)) / 1_000_000;
    return { costUsd, isHighTier };
}

/**
 * 일별·월별 통계 기록 (카테고리별 + 모델별 + 호출 출처별 분리 집계)
 */
function getCurrentChatId() {
    try {
        const ctx = window.SillyTavern?.getContext?.() || {};
        if (ctx.chatId) return String(ctx.chatId);
    } catch { /* ignore */ }
    return "";
}

function recordApiUsage({ category, caller, callerLabel, modelKey, modelLabel, costUsd, costKrw, savedUsd = 0, savedKrw = 0, normalInput, cacheTokens, outTokens, thinkTokens, isEstimated, exchangeRate }) {
    const stats = loadDailyStats();
    const today = getTodayKey();

    if (!stats[today]) {
        stats[today] = {
            usd: 0, krw: 0, turns: 0,
            byCategory: {},
            byModel: {},
            byCaller: {},
        };
    }

    const day = stats[today];
    day.usd += costUsd;
    day.krw += costKrw;
    day.turns += 1;

    if (!day.byCategory) day.byCategory = {};
    if (!day.byCategory[category]) day.byCategory[category] = { usd: 0, krw: 0, calls: 0 };
    day.byCategory[category].usd += costUsd;
    day.byCategory[category].krw += costKrw;
    day.byCategory[category].calls += 1;

    const mKey = modelLabel || modelKey || "Unknown";
    if (!day.byModel) day.byModel = {};
    if (!day.byModel[mKey]) day.byModel[mKey] = { usd: 0, krw: 0, calls: 0 };
    day.byModel[mKey].usd += costUsd;
    day.byModel[mKey].krw += costKrw;
    day.byModel[mKey].calls += 1;

    const cKey = callerLabel || (category === "main" ? "메인 채팅" : (caller || CATEGORY_LABELS[category] || "부가기능"));
    if (!day.byCaller) day.byCaller = {};
    if (!day.byCaller[cKey]) day.byCaller[cKey] = { usd: 0, krw: 0, calls: 0, category };
    day.byCaller[cKey].usd += costUsd;
    day.byCaller[cKey].krw += costKrw;
    day.byCaller[cKey].calls += 1;

    saveDailyStats(stats);

    // 크레딧 지갑 자동 차감 (활성 지갑 또는 ST 연결 프로필 매칭 지갑)
    const { walletId, walletDeducted } = deductFromWallet(costUsd, costKrw);

    const logs = loadRecentLogs();
    logs.unshift({
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        ts: Date.now(),
        date: today,
        time: getTimeStr(),
        chatId: category === "main" ? getCurrentChatId() : "",
        category,
        caller: caller || category,
        callerLabel: cKey,
        modelKey: modelKey || "",
        modelLabel: mKey,
        costUsd,
        costKrw,
        savedUsd: savedUsd || 0,
        savedKrw: savedKrw || 0,
        walletId,
        walletDeducted,
        exchangeRate: exchangeRate || getSettings().exchangeRate,
        totalInput: normalInput + cacheTokens,
        cacheTokens,
        outTokens,
        thinkTokens,
        isEstimated,
    });
    saveRecentLogs(logs);

    renderStatsUI();
    checkBudgetAlerts(stats, today);

    // [v2.3.0] 캐시 풀 미스(0%) 실시간 알림 (사용자가 ⚙ 확장 설정에서 켠 경우에만)
    try {
        const curS = getSettings();
        const totalIn = (normalInput || 0) + (cacheTokens || 0);
        const minTok = getMinCacheTokens(modelLabel || modelKey || "");
        if (curS.notifyCacheMiss && window.toastr && category === "main" && isEstimated === false && totalIn >= minTok && (cacheTokens || 0) === 0) {
            toastr.warning(
                `입력 ${fmtK(totalIn)}t 전액 일반 과금 (약 ${Math.round(costKrw).toLocaleString()}원)`,
                "이번 턴 캐시 미적중 (0%)"
            );
        }
    } catch { /* ignore */ }
}

/**
 * 일일 · 월간 예산 도달(80% / 100%) 시 1회성 경고 토스트 알림
 */
function checkBudgetAlerts(stats, today) {
    if (!window.toastr) return;
    const s = getSettings();
    const dailyLimit = Number(s.dailyBudgetKrw) || 0;
    const monthlyLimit = Number(s.monthlyBudgetKrw) || 0;
    if (dailyLimit <= 0 && monthlyLimit <= 0) return;

    const todayKrw = stats[today]?.krw || 0;
    if (dailyLimit > 0) {
        const pct = (todayKrw / dailyLimit) * 100;
        const flag100 = `d100:${today}`;
        const flag80 = `d80:${today}`;
        if (pct >= 100 && !notifiedBudgetFlags.has(flag100)) {
            notifiedBudgetFlags.add(flag100);
            notifiedBudgetFlags.add(flag80);
            toastr.error(`약 ${Math.round(todayKrw).toLocaleString()}원 / ${dailyLimit.toLocaleString()}원`, "오늘 예산 초과");
        } else if (pct >= 80 && !notifiedBudgetFlags.has(flag80)) {
            notifiedBudgetFlags.add(flag80);
            toastr.warning(`약 ${Math.round(todayKrw).toLocaleString()}원 / ${dailyLimit.toLocaleString()}원`, `오늘 예산 ${Math.round(pct)}% 도달`);
        }
    }

    if (monthlyLimit > 0) {
        const monthPrefix = today.slice(0, 7);
        let monthKrw = 0;
        Object.entries(stats).forEach(([k, v]) => {
            if (k.startsWith(monthPrefix)) monthKrw += v.krw || 0;
        });
        const pct = (monthKrw / monthlyLimit) * 100;
        const flag100 = `m100:${monthPrefix}`;
        const flag80 = `m80:${monthPrefix}`;
        if (pct >= 100 && !notifiedBudgetFlags.has(flag100)) {
            notifiedBudgetFlags.add(flag100);
            notifiedBudgetFlags.add(flag80);
            toastr.error(`약 ${Math.round(monthKrw).toLocaleString()}원 / ${monthlyLimit.toLocaleString()}원`, "이번 달 예산 초과");
        } else if (pct >= 80 && !notifiedBudgetFlags.has(flag80)) {
            notifiedBudgetFlags.add(flag80);
            toastr.warning(`약 ${Math.round(monthKrw).toLocaleString()}원 / ${monthlyLimit.toLocaleString()}원`, `이번 달 예산 ${Math.round(pct)}% 도달`);
        }
    }
}

/**
 * 최근 로그 개별 삭제 + 해당 날짜 일별 통계에서 정확히 차감
 */
function deleteRecentLogByIndex(idx) {
    const logs = loadRecentLogs();
    if (idx < 0 || idx >= logs.length) return false;
    const [removed] = logs.splice(idx, 1);
    saveRecentLogs(logs);

    // 해당 로그로 차감되었던 크레딧 지갑 잔액 자동 환불
    if (removed?.walletId && removed?.walletDeducted) {
        refundToWallet(removed.walletId, removed.walletDeducted);
    }

    if (removed && removed.date) {
        const stats = loadDailyStats();
        const day = stats[removed.date];
        if (day) {
            day.usd = Math.max(0, (day.usd || 0) - (removed.costUsd || 0));
            day.krw = Math.max(0, (day.krw || 0) - (removed.costKrw || 0));
            day.turns = Math.max(0, (day.turns || 0) - 1);

            const cat = removed.category;
            if (cat && day.byCategory?.[cat]) {
                day.byCategory[cat].usd = Math.max(0, (day.byCategory[cat].usd || 0) - (removed.costUsd || 0));
                day.byCategory[cat].krw = Math.max(0, (day.byCategory[cat].krw || 0) - (removed.costKrw || 0));
                day.byCategory[cat].calls = Math.max(0, (day.byCategory[cat].calls || 0) - 1);
                if (day.byCategory[cat].calls === 0) delete day.byCategory[cat];
            }

            const mKey = removed.modelLabel;
            if (mKey && day.byModel?.[mKey]) {
                day.byModel[mKey].usd = Math.max(0, (day.byModel[mKey].usd || 0) - (removed.costUsd || 0));
                day.byModel[mKey].krw = Math.max(0, (day.byModel[mKey].krw || 0) - (removed.costKrw || 0));
                day.byModel[mKey].calls = Math.max(0, (day.byModel[mKey].calls || 0) - 1);
                if (day.byModel[mKey].calls === 0) delete day.byModel[mKey];
            }

            const cKey = removed.callerLabel;
            if (cKey && day.byCaller?.[cKey]) {
                day.byCaller[cKey].usd = Math.max(0, (day.byCaller[cKey].usd || 0) - (removed.costUsd || 0));
                day.byCaller[cKey].krw = Math.max(0, (day.byCaller[cKey].krw || 0) - (removed.costKrw || 0));
                day.byCaller[cKey].calls = Math.max(0, (day.byCaller[cKey].calls || 0) - 1);
                if (day.byCaller[cKey].calls === 0) delete day.byCaller[cKey];
            }

            if (day.turns === 0 && day.krw < 0.01) {
                delete stats[removed.date];
            }
            saveDailyStats(stats);
        }
    }

    renderStatsUI();
    return true;
}

/**
 * 통계 & 로그 JSON 백업 다운로드
 */
function exportCostData() {
    const s = getSettings();
    const payload = {
        version: EXT_VERSION,
        exportedAt: new Date().toISOString(),
        dailyStats: loadDailyStats(),
        recentLogs: loadRecentLogs(),
        customPresets: Array.isArray(s.customPresets) ? s.customPresets : [],
        wallets: loadWallets(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `gemini-cost-backup-${getTodayKey()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (window.toastr) toastr.success("지출 통계·로그·프리셋·지갑을 JSON 파일로 백업했습니다.");
}

/**
 * JSON 파일로부터 통계 & 로그 & 커스텀 프리셋 & 크레딧 지갑 복원
 */
function triggerImportCostData(onImported) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
            const text = await file.text();
            const parsed = JSON.parse(text);
            if (!parsed || typeof parsed !== "object" || (!parsed.dailyStats && !parsed.recentLogs && !parsed.customPresets && !parsed.wallets)) {
                throw new Error("올바른 Gemini 비용 계산기 백업 파일이 아닙니다.");
            }
            if (parsed.dailyStats && typeof parsed.dailyStats === "object") {
                saveDailyStats(parsed.dailyStats);
            }
            if (Array.isArray(parsed.recentLogs)) {
                saveRecentLogs(parsed.recentLogs);
            }
            let restoredPresetCount = 0;
            if (Array.isArray(parsed.customPresets) && parsed.customPresets.length > 0) {
                const cur = getSettings();
                const existing = Array.isArray(cur.customPresets) ? [...cur.customPresets] : [];
                const existingIds = new Set(existing.map(c => c.id));
                parsed.customPresets.forEach(c => {
                    if (c && c.id && c.label && !existingIds.has(c.id)) {
                        existing.push(c);
                        existingIds.add(c.id);
                        restoredPresetCount += 1;
                    }
                });
                if (restoredPresetCount > 0) {
                    updateSettings({ customPresets: existing });
                    syncDrawerPresetOptions(getSettings());
                }
            }
            let restoredWalletCount = 0;
            if (parsed.wallets && Array.isArray(parsed.wallets.items) && parsed.wallets.items.length > 0) {
                const curW = loadWallets();
                const existingIds = new Set(curW.items.map(w => w.id));
                parsed.wallets.items.forEach(w => {
                    if (w && w.id && w.name && !existingIds.has(w.id)) {
                        curW.items.push(w);
                        existingIds.add(w.id);
                        restoredWalletCount += 1;
                    }
                });
                if (!curW.activeId && parsed.wallets.activeId) {
                    curW.activeId = parsed.wallets.activeId;
                }
                if (restoredWalletCount > 0) saveWallets(curW);
            }
            renderStatsUI();
            resolveErrorCode("GCOST-IMPORT");
            const extras = [];
            if (restoredPresetCount > 0) extras.push(`프리셋 ${restoredPresetCount}개`);
            if (restoredWalletCount > 0) extras.push(`지갑 ${restoredWalletCount}개`);
            const extraMsg = extras.length > 0 ? ` (${extras.join(" · ")} 포함)` : "";
            if (window.toastr) toastr.success(`백업 파일에서 지출 통계를 복원했습니다.${extraMsg}`);
            if (typeof onImported === "function") onImported();
        } catch (err) {
            recordErrorLog("GCOST-IMPORT", "백업 JSON 복원", err);
            if (window.toastr) toastr.error(`복원 실패: ${err?.message || "파일을 읽을 수 없습니다."}`);
        }
    };
    input.click();
}

function renderStatsUI() {
    const stats = loadDailyStats();
    const today = getTodayKey();
    const thisMonthPrefix = today.slice(0, 7);

    const todayData = stats[today] || { usd: 0, krw: 0, turns: 0, byCategory: {} };
    const todayMainKrw = todayData.byCategory?.main?.krw || 0;
    const todayAuxKrw = Math.max(0, (todayData.krw || 0) - todayMainKrw);

    let monthKrw = 0;
    let monthMainKrw = 0;
    Object.entries(stats).forEach(([dateKey, data]) => {
        if (dateKey.startsWith(thisMonthPrefix)) {
            monthKrw += data.krw || 0;
            monthMainKrw += data.byCategory?.main?.krw || 0;
        }
    });
    const monthAuxKrw = Math.max(0, monthKrw - monthMainKrw);

    $("#gcost_stat_today").text(`${Math.round(todayData.krw || 0).toLocaleString()}원`);
    $("#gcost_stat_today_sub").text(`메인 ${Math.round(todayMainKrw).toLocaleString()}원 · 부가 ${Math.round(todayAuxKrw).toLocaleString()}원`);

    $("#gcost_stat_month").text(`${Math.round(monthKrw).toLocaleString()}원`);
    $("#gcost_stat_month_sub").text(`메인 ${Math.round(monthMainKrw).toLocaleString()}원 · 부가 ${Math.round(monthAuxKrw).toLocaleString()}원`);

    // 확장 설정 서랍 미니 크레딧 잔액 바 갱신 (등록된 지갑이 있을 때만 표시)
    const $wBar = $("#gcost_drawer_wallet_bar");
    if ($wBar.length) {
        const wallets = loadWallets();
        const target = resolveTargetWallet(wallets);
        if (target) {
            const s = getSettings();
            const balStr = formatWalletAmount(target.balance, target.currency);
            const krwHint = target.currency === "USD"
                ? ` (약 ${Math.round((Number(target.balance) || 0) * s.exchangeRate).toLocaleString()}원)`
                : "";
            const dday = getWalletDdayLabel(target.expiresAt);
            const ddayStr = dday ? ` · ${dday}` : "";
            const init = Number(target.initialAmount) || 0;
            const bal = Number(target.balance) || 0;
            $wBar.removeClass("warn over");
            if (bal <= 0) $wBar.addClass("over");
            else if (init > 0 && (bal / init) <= 0.2) $wBar.addClass("warn");
            $wBar.html(`<span><strong>${escapeHtml(target.name)}</strong>${escapeHtml(ddayStr)}</span><span>잔액 <strong>${escapeHtml(balStr)}</strong>${escapeHtml(krwHint)}</span>`).show();
        } else {
            $wBar.hide();
        }
    }
}

/**
 * 호출 스택에서 API 요청을 시작한 확장 폴더명(또는 메인 채팅)을 식별
 */
function detectCallerFromStack() {
    try {
        const stack = new Error().stack || "";
        const frames = [];

        for (const line of stack.split("\n")) {
            const thirdMatch = line.match(/\/scripts\/extensions\/third-party\/([^/?#]+)\//);
            if (thirdMatch) {
                const extName = decodeURIComponent(thirdMatch[1]);
                const isWrapper = WRAPPER_EXTENSION_FRAMES.some(w =>
                    w.ext === extName && (!w.sub || line.includes(w.sub))
                );
                if (!isWrapper) {
                    frames.push({ kind: "ext", name: extName });
                }
                continue;
            }

            const builtinMatch = line.match(/\/scripts\/extensions\/([^/?#]+)\//);
            if (builtinMatch && builtinMatch[1] !== "third-party") {
                frames.push({ kind: "ext", name: decodeURIComponent(builtinMatch[1]) });
                continue;
            }

            if (/\/scripts\/(openai|textgen-settings|kai-settings|nai-settings|horde)\.js|\/script\.js/.test(line)) {
                frames.push({ kind: "core" });
            }
        }

        const firstCore = frames.findIndex(f => f.kind === "core");
        const outerExts = frames.filter((f, idx) => f.kind === "ext" && (firstCore < 0 || idx > firstCore));
        if (outerExts.length > 0) {
            return outerExts[outerExts.length - 1].name;
        }
        if (firstCore >= 0) {
            return "main";
        }
    } catch { /* ignore */ }
    return "unknown";
}

/**
 * URL이 추적 대상 LLM/AI 생성 엔드포인트인지 판별 (ST 백엔드 + 외부 직접 API 호출)
 */
function isTrackedApiRequest(url, method) {
    if (String(method || "GET").toUpperCase() !== "POST") return false;
    const raw = String(url || "");
    if (!raw) return false;

    let pathname = raw;
    try {
        pathname = new URL(raw, window.location.origin).pathname;
    } catch { /* keep raw */ }
    const lowerPath = pathname.toLowerCase();

    // 1. SillyTavern 기본 백엔드 생성 엔드포인트
    if (
        lowerPath.includes("/api/backends/chat-completions/generate") ||
        lowerPath.includes("/api/backends/text-completions/generate")
    ) {
        return true;
    }

    // 2. SillyTavern Google 엔드포인트 (단순 목록 조회 list-* 제외)
    if (lowerPath.includes("/api/google/")) {
        if (lowerPath.includes("list-") || lowerPath.includes("/models")) return false;
        return lowerPath.includes("generate");
    }

    // 3. 확장 내부에서 외부 API로 직접 호출하는 경우
    if (/\/chat\/completions\/?$/.test(lowerPath)) return true;
    if (/\/v1\/messages\/?$/.test(lowerPath)) return true;
    if (/\/models\/[^/?:]+:(?:streamgeneratecontent|generatecontent)\/?$/.test(lowerPath)) return true;

    return false;
}

/**
 * Gemini 네이티브 URL 경로(/models/{model}:generateContent)에서 모델명 추출
 */
function extractModelFromUrl(url) {
    try {
        const pathname = new URL(String(url || ""), window.location.origin).pathname;
        const m = pathname.match(/\/models\/([^/?:]+):(?:streamGenerateContent|generateContent)/i);
        if (m && m[1]) return decodeURIComponent(m[1]);
    } catch { /* ignore */ }
    return "";
}

/**
 * 요청 본문에서 입력 텍스트 추출 (OpenAI / Anthropic / Gemini 네이티브 / Text Completion 대응)
 */
function extractInputTextFromBody(reqBody) {
    if (!reqBody || typeof reqBody !== "object") return "";
    const chunks = [];

    if (typeof reqBody.system === "string") {
        chunks.push(reqBody.system);
    } else if (Array.isArray(reqBody.system)) {
        chunks.push(reqBody.system.map(p => (typeof p === "string" ? p : (p?.text || ""))).join("\n"));
    }

    const sysInst = reqBody.systemInstruction || reqBody.system_instruction;
    if (sysInst?.parts && Array.isArray(sysInst.parts)) {
        chunks.push(sysInst.parts.map(p => p?.text || "").join("\n"));
    }

    if (Array.isArray(reqBody.messages)) {
        reqBody.messages.forEach(m => {
            if (typeof m?.content === "string") {
                chunks.push(m.content);
            } else if (Array.isArray(m?.content)) {
                chunks.push(m.content.map(c => (typeof c === "string" ? c : (c?.text || ""))).join("\n"));
            }
        });
    } else if (Array.isArray(reqBody.contents)) {
        reqBody.contents.forEach(c => {
            if (Array.isArray(c?.parts)) {
                chunks.push(c.parts.map(p => p?.text || "").join("\n"));
            }
        });
    } else if (typeof reqBody.prompt === "string") {
        chunks.push(reqBody.prompt);
    }

    return chunks.filter(Boolean).join("\n");
}

/**
 * 비스트리밍 JSON 응답에서 본문/추론 텍스트 추출 (OpenAI / Gemini / Anthropic 대응)
 */
function extractOutputFromResponseData(data) {
    if (!data || typeof data !== "object") return { outText: "", thinkText: "" };
    let outText = "";
    let thinkText = "";

    const choiceMsg = data.choices?.[0]?.message;
    if (choiceMsg) {
        if (typeof choiceMsg.content === "string") outText += choiceMsg.content;
        if (typeof choiceMsg.reasoning_content === "string") thinkText += choiceMsg.reasoning_content;
        else if (typeof choiceMsg.reasoning === "string") thinkText += choiceMsg.reasoning;
        return { outText, thinkText };
    }

    const gemParts = data.candidates?.[0]?.content?.parts;
    if (Array.isArray(gemParts)) {
        gemParts.forEach(p => {
            if (!p?.text) return;
            if (p.thought) thinkText += p.text;
            else outText += p.text;
        });
        return { outText, thinkText };
    }

    if (Array.isArray(data.content)) {
        data.content.forEach(p => {
            if (p?.type === "thinking" && typeof p.thinking === "string") thinkText += p.thinking;
            else if (typeof p?.text === "string") outText += p.text;
        });
        return { outText, thinkText };
    }

    if (typeof data.choices?.[0]?.text === "string") {
        outText = data.choices[0].text;
    }

    return { outText, thinkText };
}

/**
 * 요청 URL, 페이로드, 호출 스택 기반으로 용도(메인/확장/요약/번역/부가기능) 및 출처 자동 분류
 */
function classifyCall(url, reqBody, caller) {
    const u = String(url || "").toLowerCase();
    const cLower = String(caller || "").toLowerCase();
    const isExternalExt = caller && caller !== "main" && caller !== "unknown";

    // 명확하게 메인 채팅 코어에서 호출된 경우
    if (caller === "main") {
        if (u.includes("translate")) {
            return { category: "translate", caller: "main", callerLabel: "번역" };
        }
        return { category: "main", caller: "main", callerLabel: "메인 채팅" };
    }

    // 방금 메인 채팅 전송(CHAT_COMPLETION_PROMPT_READY)이 발생한 직후의 ST 백엔드 생성 요청은
    // QR/단축키/편의 확장을 거쳐 트리거되었더라도 본 채팅 요청이므로 메인으로 정확히 분류 (중복 집계 방지)
    // 1회 매칭 후 lastMainPromptAt을 소비(0)하여 직후 1~2초 내 실행되는 자동 번역·요약 확장 오분류를 차단
    const isRecentMain = (Date.now() - lastMainPromptAt) < 4000;
    const isStBackend = u.includes("/api/backends/");
    if (isRecentMain && isStBackend && !u.includes("translate")) {
        lastMainPromptAt = 0;
        return { category: "main", caller: "main", callerLabel: "메인 채팅" };
    }

    // 프롬프트 샘플 텍스트 (요약/번역 판별용)
    let sampleText = "";
    if (Array.isArray(reqBody?.messages)) {
        const lastMsgs = reqBody.messages.slice(-2);
        sampleText = lastMsgs.map(m => typeof m.content === "string" ? m.content : "").join(" ").toLowerCase();
    } else if (typeof reqBody?.prompt === "string") {
        sampleText = reqBody.prompt.slice(-600).toLowerCase();
    } else if (Array.isArray(reqBody?.contents)) {
        sampleText = reqBody.contents.slice(-2).flatMap(c => (c.parts || []).map(p => p.text || "")).join(" ").toLowerCase();
    }

    // 특정 서드파티/내장 확장이 독립 호출한 경우 (본 채팅과 무관하므로 main으로 오분류하지 않음)
    if (isExternalExt) {
        if (u.includes("translate") || cLower.includes("translat") || sampleText.includes("translate") || sampleText.includes("번역")) {
            return { category: "translate", caller, callerLabel: caller };
        }
        if (cLower.includes("summar") || sampleText.includes("summarize") || sampleText.includes("summary") || sampleText.includes("요약")) {
            return { category: "summary", caller, callerLabel: caller };
        }
        return { category: "ext", caller, callerLabel: caller };
    }

    // 스택으로 호출자를 특정하지 못한 경우 기존 휴리스틱 폴백
    if (u.includes("translate")) {
        return { category: "translate", caller: "translate", callerLabel: "번역" };
    }

    if (sampleText.includes("summarize") || sampleText.includes("summary") || sampleText.includes("요약")) {
        return { category: "summary", caller: "summary", callerLabel: "요약" };
    }
    if (sampleText.includes("translate") || sampleText.includes("번역")) {
        return { category: "translate", caller: "translate", callerLabel: "번역" };
    }
    return { category: isStBackend ? "aux" : "ext", caller: "external", callerLabel: isStBackend ? "부가기능" : "외부 API" };
}

/**
 * 응답 JSON 또는 SSE 청크에서 usage 메타데이터 추출
 */
function extractUsageFromPayload(data) {
    if (!data || typeof data !== "object") return null;
    const u = data.usageMetadata || data.usage || data.message?.usage || data.response?.usageMetadata || data.response?.usage;
    if (!u) return null;

    const totalInput = u.promptTokenCount ?? u.prompt_tokens ?? u.input_tokens ?? 0;
    const cacheTokens = u.cachedContentTokenCount
        ?? u.prompt_tokens_details?.cached_tokens
        ?? u.cached_tokens
        ?? u.cache_read_input_tokens
        ?? 0;
    const outTokens = u.candidatesTokenCount ?? u.completion_tokens ?? u.output_tokens ?? 0;
    const thinkTokens = u.thoughtsTokenCount ?? u.completion_tokens_details?.reasoning_tokens ?? 0;

    if (totalInput === 0 && outTokens === 0) return null;
    return { totalInput, cacheTokens, outTokens, thinkTokens };
}

/**
 * [핵심 기능] window.fetch 인터셉터로 모든 LLM 호출(메인 + 독립 확장/외부 직접 API/요약/번역/멀티모델) 자동 추적
 */
function installFetchInterceptor() {
    if (window.__gcostFetchInstalled) return;
    window.__gcostFetchInstalled = true;

    const originalFetch = window.fetch.bind(window);

    window.fetch = async function (...args) {
        const settings = getSettings();
        const url = typeof args[0] === "string"
            ? args[0]
            : (args[0] instanceof URL ? args[0].href : (args[0]?.url || ""));
        const options = args[1] || {};
        const method = options.method || (typeof args[0] === "object" && args[0]?.method) || "GET";

        const isGenEndpoint =
            settings.enabled &&
            settings.interceptFetch &&
            isTrackedApiRequest(url, method);

        if (!isGenEndpoint) {
            return originalFetch(...args);
        }

        // fetch 호출 시점의 동기 스택에서 호출자(확장명 또는 메인)를 캡처
        const detectedCaller = detectCallerFromStack();

        let reqBody = null;
        try {
            if (typeof options.body === "string") {
                reqBody = JSON.parse(options.body);
            }
        } catch { /* ignore */ }

        const { category, caller, callerLabel } = classifyCall(url, reqBody, detectedCaller);
        const reqModel = reqBody?.model
            || reqBody?.custom_model
            || reqBody?.google_model
            || reqBody?.claude_model
            || extractModelFromUrl(url)
            || reqBody?.chat_completion_source
            || "";

        const response = await originalFetch(...args);

        // 비동기 백그라운드에서 복제된 응답 분석 (실리태번 스트리밍/성능에 영향 없음)
        const analyzePromise = (async () => {
            try {
                if (!response.ok) return;
                const cloned = response.clone();
                const contentType = (cloned.headers.get("content-type") || "").toLowerCase();

                // 바이너리(오디오/이미지) 응답은 본문 파싱 생략하고 요청 텍스트 기반으로만 추정
                const isBinaryResp = contentType.startsWith("audio/") || contentType.startsWith("image/") || contentType.includes("octet-stream");

                let usage = null;
                let respModel = reqModel;
                let accumulatedOutText = "";
                let accumulatedThinkText = "";

                const processSseLine = (line) => {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith("data:")) return;
                    const jsonStr = trimmed.slice(5).trim();
                    if (!jsonStr || jsonStr === "[DONE]") return;
                    try {
                        const chunk = JSON.parse(jsonStr);
                        if (chunk.model) respModel = chunk.model;
                        if (chunk.message?.model) respModel = chunk.message.model;
                        const u = extractUsageFromPayload(chunk);
                        if (u) usage = u;

                        // OpenAI SSE
                        const delta = chunk.choices?.[0]?.delta;
                        if (delta?.content) accumulatedOutText += delta.content;
                        if (delta?.reasoning_content || delta?.reasoning) {
                            accumulatedThinkText += (delta.reasoning_content || delta.reasoning);
                        }

                        // Anthropic SSE
                        if (chunk.delta?.type === "text_delta" && chunk.delta.text) {
                            accumulatedOutText += chunk.delta.text;
                        }
                        if (chunk.delta?.type === "thinking_delta" && chunk.delta.thinking) {
                            accumulatedThinkText += chunk.delta.thinking;
                        }

                        // Gemini 네이티브 SSE
                        const gemParts = chunk.candidates?.[0]?.content?.parts;
                        if (Array.isArray(gemParts)) {
                            gemParts.forEach(p => {
                                if (!p?.text) return;
                                if (p.thought) accumulatedThinkText += p.text;
                                else accumulatedOutText += p.text;
                            });
                        }
                    } catch { /* ignore partial */ }
                };

                const looksLikeStream = contentType.includes("text/event-stream")
                    || (Boolean(reqBody?.stream || reqBody?.streaming) && !contentType.includes("application/json"));

                if (isBinaryResp) {
                    cloned.body?.cancel().catch(() => {});
                } else if (looksLikeStream) {
                    const reader = cloned.body?.getReader();
                    if (reader) {
                        const decoder = new TextDecoder("utf-8");
                        let buffer = "";
                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            buffer += decoder.decode(value, { stream: true });
                            const lines = buffer.split("\n");
                            buffer = lines.pop() || "";
                            for (const line of lines) processSseLine(line);
                        }
                        if (buffer.trim()) processSseLine(buffer);
                    }
                } else {
                    const rawText = await cloned.text();
                    const trimmedRaw = rawText.trimStart();
                    if (!trimmedRaw) {
                        // 빈 응답은 무시
                    } else if (trimmedRaw.startsWith("data:") || trimmedRaw.includes("\ndata:")) {
                        // Content-Type이 text/event-stream이 아니어도 본문이 SSE 형식이면 SSE 파서로 안전 처리
                        trimmedRaw.split("\n").forEach(processSseLine);
                    } else {
                        const data = JSON.parse(trimmedRaw);
                        if (data?.model) respModel = data.model;
                        usage = extractUsageFromPayload(data);
                        const extracted = extractOutputFromResponseData(data);
                        accumulatedOutText = extracted.outText;
                        accumulatedThinkText = extracted.thinkText;
                    }
                }

                const curSettings = getSettings();
                const resolved = resolveModelPricing(respModel, curSettings);

                let totalInput = 0;
                let cacheTokens = 0;
                let normalInput = 0;
                let outTokens = 0;
                let thinkTokens = 0;
                let isEstimated = true;

                if (curSettings.autoCache && usage) {
                    totalInput = usage.totalInput;
                    cacheTokens = usage.cacheTokens;
                    normalInput = Math.max(0, totalInput - cacheTokens);
                    outTokens = usage.outTokens;
                    thinkTokens = usage.thinkTokens;
                    isEstimated = false;
                } else {
                    // 메타데이터가 없을 때 로컬 토크나이저로 추정
                    if (category === "main" && lastPromptTokens > 0) {
                        totalInput = lastPromptTokens;
                    } else {
                        const inputText = extractInputTextFromBody(reqBody);
                        if (inputText) {
                            totalInput = await getTokenCountAsync(inputText);
                        }
                    }

                    // 부가기능/독립 확장 호출은 단발성인 경우가 많아 캐시 적중률 0, 메인은 설정 캐시율 적용
                    const appliedCacheRate = category === "main" ? (curSettings.cacheRate / 100) : 0;
                    cacheTokens = Math.floor(totalInput * appliedCacheRate);
                    normalInput = Math.max(0, totalInput - cacheTokens);

                    outTokens = accumulatedOutText ? await getTokenCountAsync(accumulatedOutText) : 0;
                    thinkTokens = accumulatedThinkText ? await getTokenCountAsync(accumulatedThinkText) : 0;
                }

                if (totalInput === 0 && outTokens === 0) return;

                const isCustomPricing = !resolved.matched && (curSettings.preset === "custom" || Boolean(findPresetByKey(curSettings.preset, curSettings)?.isCustom));
                const regionalMult = getRegionalMultiplier(curSettings, isCustomPricing);
                const { costUsd, isHighTier } = calcTurnCostUsd(
                    normalInput, cacheTokens, outTokens, thinkTokens, totalInput, resolved.pricing, regionalMult
                );
                const costKrw = costUsd * curSettings.exchangeRate;
                const { savedUsd, savedKrw } = calcCacheSaved(
                    cacheTokens, totalInput, resolved.pricing, curSettings.exchangeRate, regionalMult
                );

                const record = {
                    category,
                    caller,
                    callerLabel,
                    modelKey: resolved.key,
                    modelLabel: resolved.shortLabel,
                    normalInput,
                    cacheTokens,
                    outTokens,
                    thinkTokens,
                    totalInput,
                    isHighTier,
                    isEstimated,
                    costUsd,
                    costKrw,
                    savedUsd,
                    savedKrw,
                    exchangeRate: curSettings.exchangeRate,
                    capturedAt: Date.now(),
                };

                recordApiUsage(record);
                resolveErrorCode("GCOST-FETCH");

                if (category === "main") {
                    lastCapturedMainRecord = record;
                }
            } catch (err) {
                recordErrorLog("GCOST-FETCH", "네트워크 응답 분석", err);
                console.warn(`[Gemini Cost v${EXT_VERSION}] 네트워크 응답 분석 중 오류:`, err);
            }
        })();

        if (category === "main") {
            pendingMainFetchPromise = analyzePromise.finally(() => {
                if (pendingMainFetchPromise === analyzePromise) {
                    pendingMainFetchPromise = null;
                }
            });
        }

        return response;
    };
}

async function onPromptReady(eventData) {
    const settings = getSettings();
    if (!settings.enabled || eventData?.dryRun) return;

    lastMainPromptAt = Date.now();
    try {
        const messages = eventData?.chat || [];
        const fullText = messages.map(m => {
            if (typeof m.content === "string") return m.content;
            if (Array.isArray(m.content)) {
                return m.content.filter(c => c.type === "text").map(c => c.text).join("\n");
            }
            return "";
        }).join("\n");

        lastPromptTokens = await getTokenCountAsync(fullText);
        resolveErrorCode("GCOST-PROMPT");
    } catch (err) {
        recordErrorLog("GCOST-PROMPT", "프롬프트 토큰 계산", err);
        lastPromptTokens = 0;
    }
}

function attachCostToMessage(message, newRecord) {
    if (!message.extra) message.extra = {};
    const prev = message.extra.gemini_cost;
    const merged = { ...newRecord };

    // 같은 말풍선에 스와이프/재생성으로 새 응답이 덮어씌워질 때 이전 시도 비용을 리롤 숨은 비용으로 누적 보존
    if (prev && typeof prev.costUsd === "number") {
        const prevExtraUsd = (prev.rerollExtraUsd || 0) + prev.costUsd;
        const prevExtraKrw = (prev.rerollExtraKrw || 0) + (prev.costKrw || 0);
        const prevCount = (prev.rerollCount || 0) + 1;
        merged.rerollCount = prevCount;
        merged.rerollExtraUsd = prevExtraUsd;
        merged.rerollExtraKrw = prevExtraKrw;
    }

    message.extra.gemini_cost = merged;
}

async function onMessageReceived(messageId) {
    const settings = getSettings();
    if (!settings.enabled) return;

    const message = chat[messageId];
    if (!message || message.is_user || message.is_system) return;

    // fetch 인터셉터의 백그라운드 스트림 분석이 아직 진행 중이면 최대 800ms 대기 (미세 타이밍 중복 집계 방지)
    if (settings.interceptFetch && !lastCapturedMainRecord && pendingMainFetchPromise) {
        try {
            await Promise.race([
                pendingMainFetchPromise,
                new Promise(resolve => setTimeout(resolve, 800)),
            ]);
        } catch { /* ignore */ }
    }

    // fetch 인터셉터가 방금 메인 응답을 캡처했다면 그 실측/모델 데이터를 그대로 말풍선에 연결 (중복 집계 방지)
    if (settings.interceptFetch && lastCapturedMainRecord && (Date.now() - lastCapturedMainRecord.capturedAt) < 15000) {
        attachCostToMessage(message, lastCapturedMainRecord);
        lastCapturedMainRecord = null;
        lastPromptTokens = 0;
        await saveChatConditional();
        renderAllBadges();
        return;
    }

    // 인터셉터가 꺼져 있거나 캡처되지 않은 경우 기존 폴백 로직 수행
    // 첫 인사말(#0) 로드나 프롬프트 전송 없이 삽입된 메시지(lastPromptTokens === 0)는 실제 API 호출이 아니므로 기록하지 않음
    const hasRecentMainPrompt = lastPromptTokens > 0 && (Date.now() - lastMainPromptAt) < 180000;
    if (messageId === 0 || !hasRecentMainPrompt) {
        return;
    }

    let outTokens = message.extra?.token_count || await getTokenCountAsync(message.mes || "");
    let thinkTokens = message.extra?.reasoning ? await getTokenCountAsync(message.extra.reasoning) : 0;
    let totalInput = lastPromptTokens;
    let cacheTokens = Math.floor(totalInput * (settings.cacheRate / 100));
    let normalInput = Math.max(0, totalInput - cacheTokens);

    const resolved = resolveModelPricing("", settings);
    const isCustomPricing = settings.preset === "custom" || Boolean(findPresetByKey(settings.preset, settings)?.isCustom);
    const regionalMult = getRegionalMultiplier(settings, isCustomPricing);
    const { costUsd, isHighTier } = calcTurnCostUsd(
        normalInput, cacheTokens, outTokens, thinkTokens, totalInput, resolved.pricing, regionalMult
    );
    const costKrw = costUsd * settings.exchangeRate;

    const record = {
        category: "main",
        caller: "main",
        callerLabel: "메인 채팅",
        modelKey: resolved.key,
        modelLabel: resolved.shortLabel,
        normalInput,
        cacheTokens,
        outTokens,
        thinkTokens,
        totalInput,
        isHighTier,
        isEstimated: true,
        costUsd,
        costKrw,
        exchangeRate: settings.exchangeRate,
    };

    attachCostToMessage(message, record);

    recordApiUsage(record);
    lastPromptTokens = 0;
    await saveChatConditional();
    renderAllBadges();
}

/**
 * AI 호출 없이 현재 캐릭터·프리셋·페르소나·작가의 노트(또는 API 실측 역산)로 고정 프롬프트 토큰 자동 산출
 */
async function estimateBasePromptTokens(maxIdx = null) {
    // 1. 현재 채팅에 API 실측 기록이 있는 AI 메시지가 있다면, (실측 입력 - 직전 말풍선 합계)로 로어북 포함 고정 프롬프트 역산
    try {
        if (Array.isArray(chat) && chat.length > 0) {
            const limit = (maxIdx !== null && maxIdx >= 0 && maxIdx < chat.length) ? maxIdx : chat.length - 1;
            let measuredIdx = -1;
            for (let i = limit; i >= 0; i--) {
                const info = chat[i]?.extra?.gemini_cost;
                if (info && info.isEstimated === false && info.totalInput > 0) {
                    measuredIdx = i;
                    break;
                }
            }
            if (measuredIdx >= 0) {
                let chatMsgsBefore = 0;
                for (let i = 0; i < measuredIdx; i++) {
                    const m = chat[i];
                    if (!m || m.is_system) continue;
                    chatMsgsBefore += m.extra?.token_count || await getTokenCountAsync(m.mes || "");
                }
                const derived = chat[measuredIdx].extra.gemini_cost.totalInput - chatMsgsBefore;
                if (derived > 0 && derived < 500000) {
                    return {
                        tokens: derived,
                        source: "measured",
                        detail: `API 실측 역산 (#${measuredIdx}, 로어북 포함)`,
                    };
                }
            }
        }
    } catch { /* fallback to context sum */ }

    // 2. SillyTavern 현재 컨텍스트(시스템 프리셋 + 캐릭터 카드 + 페르소나 + 작가의 노트)에서 직접 합산
    try {
        const ctx = window.SillyTavern?.getContext?.() || {};

        // 2-1. 캐릭터 카드
        const charObj = (ctx.characterId !== undefined && ctx.characters) ? ctx.characters[ctx.characterId] : null;
        const charParts = charObj ? [
            charObj.description,
            charObj.personality,
            charObj.scenario,
            charObj.system_prompt,
            charObj.post_history_instructions,
            charObj.mes_example,
        ].filter(v => typeof v === "string" && v.trim()) : [];
        const charText = charParts.join("\n");

        // 2-2. 페르소나
        const personaText = String(ctx.powerUserSettings?.persona_description || $("#persona_description").val() || "").trim();

        // 2-3. 작가의 노트 / 메모리 등 채팅 메타데이터
        const metaParts = [
            ctx.chatMetadata?.note_prompt,
            ctx.chatMetadata?.extensions?.memory,
        ].filter(v => typeof v === "string" && v.trim());
        const metaText = metaParts.join("\n");

        // 2-4. Chat Completion 활성 시스템 프롬프트 프리셋
        let presetText = "";
        const oai = ctx.chatCompletionSettings;
        if (oai && Array.isArray(oai.prompts)) {
            const enabledIds = new Set();
            if (Array.isArray(oai.prompt_order)) {
                const orderEntry = oai.prompt_order.find(o => o.character_id === 100001) || oai.prompt_order[oai.prompt_order.length - 1];
                if (Array.isArray(orderEntry?.order)) {
                    orderEntry.order.forEach(item => {
                        if (item?.enabled && item?.identifier) enabledIds.add(item.identifier);
                    });
                }
            }
            const activePrompts = oai.prompts.filter(p => {
                if (!p || p.marker || !p.content || typeof p.content !== "string" || !p.content.trim()) return false;
                if (enabledIds.size > 0) return enabledIds.has(p.identifier);
                return p.enabled !== false;
            });
            presetText = activePrompts.map(p => p.content).join("\n");
        }

        // 2-5. 연결된 월드인포/로어북의 상시 활성화(constant) 항목 합산 (AI 호출 없음 · 로컬 ST 서버 조회)
        let loreText = "";
        try {
            const worldNames = new Set();
            const charWorld = charObj?.data?.extensions?.world;
            if (typeof charWorld === "string" && charWorld.trim()) worldNames.add(charWorld.trim());
            const chatWorld = ctx.chatMetadata?.world_info;
            if (typeof chatWorld === "string" && chatWorld.trim()) worldNames.add(chatWorld.trim());
            const globalWorlds = $("#world_info").val();
            if (Array.isArray(globalWorlds)) {
                globalWorlds.forEach(w => { if (typeof w === "string" && w.trim()) worldNames.add(w.trim()); });
            }

            if (worldNames.size > 0) {
                const reqHeaders = typeof ctx.getRequestHeaders === "function"
                    ? ctx.getRequestHeaders()
                    : { "Content-Type": "application/json" };
                const loreChunks = [];
                await Promise.all([...worldNames].map(async (wName) => {
                    try {
                        const res = await fetch("/api/worldinfo/get", {
                            method: "POST",
                            headers: reqHeaders,
                            body: JSON.stringify({ name: wName }),
                        });
                        if (!res.ok) return;
                        const data = await res.json();
                        const entries = Object.values(data?.entries || {});
                        entries.forEach(e => {
                            if (e && !e.disable && e.constant === true && typeof e.content === "string" && e.content.trim()) {
                                loreChunks.push(e.content);
                            }
                        });
                    } catch { /* ignore individual worldbook error */ }
                }));
                loreText = loreChunks.join("\n");
            }
        } catch { /* ignore lorebook fetch error */ }

        const [presetTokens, charTokens, loreTokens, personaTokens, metaTokens] = await Promise.all([
            presetText ? getTokenCountAsync(presetText) : 0,
            charText ? getTokenCountAsync(charText) : 0,
            loreText ? getTokenCountAsync(loreText) : 0,
            personaText ? getTokenCountAsync(personaText) : 0,
            metaText ? getTokenCountAsync(metaText) : 0,
        ]);

        const total = presetTokens + charTokens + loreTokens + personaTokens + metaTokens;
        if (total > 0) {
            const parts = [];
            if (presetTokens > 0) parts.push(`프리셋 ${presetTokens.toLocaleString()}`);
            if (charTokens > 0) parts.push(`캐릭터 ${charTokens.toLocaleString()}`);
            if (loreTokens > 0) parts.push(`로어북 ${loreTokens.toLocaleString()}`);
            if (personaTokens > 0) parts.push(`페르소나 ${personaTokens.toLocaleString()}`);
            if (metaTokens > 0) parts.push(`메모 ${metaTokens.toLocaleString()}`);
            resolveErrorCode("GCOST-EST");
            return {
                tokens: total,
                source: "context",
                detail: parts.join(" + "),
            };
        }
    } catch (err) {
        recordErrorLog("GCOST-EST", "고정 프롬프트 측정", err);
    }

    return {
        tokens: Math.max(0, Number(getSettings().basePromptTokens) || 2500),
        source: "manual",
        detail: "기본값 사용",
    };
}

/**
 * 최근 API 실측 메인 호출 기록에서 평균 프롬프트 캐시 적중률 자동 산출 (AI 호출 없음)
 * 모델별 공식 암묵적 캐싱 최소 임계값(Gemini 2.5: 2,048t / Gemini 3.x·4: 4,096t) 미만 호출 제외
 */
function estimateMeasuredCacheRate(fallbackRate = 80) {
    try {
        const logs = loadRecentLogs();
        const measured = logs.filter(l => {
            if (l.category !== "main" || l.isEstimated !== false) return false;
            const minTok = getMinCacheTokens(l.modelLabel || l.modelKey || "");
            return (l.totalInput || 0) >= minTok;
        });
        if (measured.length > 0) {
            const sumIn = measured.reduce((acc, l) => acc + (l.totalInput || 0), 0);
            const sumCache = measured.reduce((acc, l) => acc + (l.cacheTokens || 0), 0);
            const pct = sumIn > 0 ? Math.min(99, Math.max(0, Math.round((sumCache / sumIn) * 100))) : 0;
            return {
                rate: pct,
                source: "measured",
                detail: `최근 실측 ${measured.length}회 평균`,
            };
        }
    } catch { /* ignore */ }

    const safeRate = Math.min(99, Math.max(0, Number(fallbackRate) || 80));
    return {
        rate: safeRate,
        source: "default",
        detail: `실측 대기 (기본 ${safeRate}%)`,
    };
}

/**
 * 로컬 채팅 즉시 계산 (AI 호출 없음) + 실시간 모델/부가기능 내역 모달 열기
 */
async function openCostModal(upToIndex = null, defaultTab = "chat") {
    let settings = getSettings();
    let chatResult = null;
    let basePromptInfo = {
        tokens: Math.max(0, Number(settings.basePromptTokens) || 0),
        source: "manual",
        detail: "수동 설정값",
    };
    let cacheRateInfo = {
        rate: Math.min(99, Math.max(0, Number(settings.cacheRate) || 0)),
        source: "manual",
        detail: "수동 설정값",
    };

    if (settings.autoCacheRate) {
        cacheRateInfo = estimateMeasuredCacheRate(settings.cacheRate);
        if (cacheRateInfo.source === "measured" && cacheRateInfo.rate !== settings.cacheRate) {
            updateSettings({ cacheRate: cacheRateInfo.rate });
            settings = getSettings();
            $("#gcost_cache_rate").val(settings.cacheRate);
            $("#gcost_cache_rate_val").text(settings.cacheRate);
        }
    }

    if (settings.autoBasePrompt) {
        const maxIdxForEst = (chat && chat.length > 0 && upToIndex !== null && upToIndex >= 0 && upToIndex < chat.length)
            ? upToIndex
            : null;
        basePromptInfo = await estimateBasePromptTokens(maxIdxForEst);
        if (basePromptInfo.source !== "manual" && basePromptInfo.tokens !== settings.basePromptTokens) {
            updateSettings({ basePromptTokens: basePromptInfo.tokens });
            settings = getSettings();
            $("#gcost_base_prompt_tokens").val(settings.basePromptTokens);
        }
    }

    if (chat && chat.length > 0) {
        const maxIdx = (upToIndex !== null && upToIndex >= 0 && upToIndex < chat.length)
            ? upToIndex
            : chat.length - 1;

        if (maxIdx > 80 && window.toastr) {
            toastr.info(`장기 채팅(${maxIdx + 1}개 메시지) 토큰을 계산하고 있어요…`, "", { timeOut: 1800 });
        }

        const maxContextLimit = getEffectiveMaxContext();
        const minCacheTokens = getMinCacheTokens(settings.preset);
        const isCurrentCustom = settings.preset === "custom" || Boolean(findPresetByKey(settings.preset, settings)?.isCustom);
        const activeRegionalMult = getRegionalMultiplier(settings, isCurrentCustom);
        let runningContext = Math.max(0, Number(basePromptInfo.tokens) || 0);
        let prevContextForCache = 0;
        let aiTurnCount = 0;
        let measuredTurnCount = 0;
        let sumNormalIn = 0, sumCacheIn = 0, sumOut = 0, sumThink = 0, sumUsd = 0;
        let sumRerollCount = 0, sumRerollKrw = 0;
        let contextCapped = false;
        const turnRecords = [];

        for (let i = 0; i <= maxIdx; i++) {
            const msg = chat[i];
            if (!msg || msg.is_system) continue;

            const msgTokens = msg.extra?.token_count || await getCachedTokenCount(msg.mes || "");
            if (msg.is_user) {
                runningContext += msgTokens;
                continue;
            }

            aiTurnCount += 1;
            const prevCost = msg.extra?.gemini_cost;
            if (prevCost?.rerollCount > 0) {
                sumRerollCount += prevCost.rerollCount;
                sumRerollKrw += prevCost.rerollExtraKrw || 0;
            }

            const hasMeasured = Boolean(prevCost && prevCost.isEstimated === false && prevCost.totalInput > 0);
            let totalInput = 0;
            let cacheTokens = 0;
            let normalInput = 0;
            let outTokens = msgTokens;
            let thinkTokens = 0;

            if (hasMeasured) {
                measuredTurnCount += 1;
                totalInput = prevCost.totalInput;
                cacheTokens = Math.min(prevCost.cacheTokens || 0, totalInput);
                normalInput = Math.max(0, totalInput - cacheTokens);
                outTokens = prevCost.outTokens ?? msgTokens;
                thinkTokens = prevCost.thinkTokens || 0;
                runningContext = Math.max(runningContext, totalInput);
            } else {
                thinkTokens = msg.extra?.reasoning ? await getCachedTokenCount(msg.extra.reasoning) : 0;
                totalInput = runningContext;
                if (maxContextLimit > 0 && totalInput > maxContextLimit) {
                    totalInput = maxContextLimit;
                    contextCapped = true;
                }

                // 공식 암묵적 캐싱 최소 토큰 임계값(2,048t / 4,096t) 이상일 때만 캐시 추정 적용
                if (aiTurnCount > 1 && prevContextForCache >= minCacheTokens && totalInput >= minCacheTokens) {
                    cacheTokens = Math.min(Math.floor(prevContextForCache * (settings.cacheRate / 100)), totalInput);
                }
                normalInput = Math.max(0, totalInput - cacheTokens);
            }

            const { costUsd, isHighTier } = calcTurnCostUsd(
                normalInput, cacheTokens, outTokens, thinkTokens, totalInput, settings, activeRegionalMult
            );

            sumNormalIn += normalInput;
            sumCacheIn += cacheTokens;
            sumOut += outTokens;
            sumThink += thinkTokens;
            sumUsd += costUsd;

            turnRecords.push({
                index: i, normalInput, cacheTokens, outTokens, thinkTokens,
                totalInput, isHighTier, hasMeasured, costUsd, costKrw: costUsd * settings.exchangeRate,
            });

            runningContext += outTokens;
            prevContextForCache = maxContextLimit > 0 ? Math.min(runningContext, maxContextLimit) : runningContext;
        }

        const effectiveNextContext = maxContextLimit > 0 ? Math.min(runningContext, maxContextLimit) : runningContext;
        const nextCache = effectiveNextContext >= minCacheTokens
            ? Math.floor(effectiveNextContext * (settings.cacheRate / 100))
            : 0;
        const nextNormal = Math.max(0, effectiveNextContext - nextCache);
        const nextAvgOut = aiTurnCount > 0 ? Math.round((sumOut + sumThink) / aiTurnCount) : 800;
        const { costUsd: nextTurnUsd } = calcTurnCostUsd(
            nextNormal, nextCache, nextAvgOut, 0, effectiveNextContext, settings, activeRegionalMult
        );
        const { costUsd: nextTurnMissUsd } = calcTurnCostUsd(
            effectiveNextContext, 0, nextAvgOut, 0, effectiveNextContext, settings, activeRegionalMult
        );

        chatResult = {
            maxIdx, aiTurnCount, measuredTurnCount,
            runningContext: effectiveNextContext,
            rawRunningContext: runningContext,
            maxContextLimit, contextCapped,
            sumNormalIn, sumCacheIn, sumOut, sumThink,
            sumUsd, sumKrw: sumUsd * settings.exchangeRate,
            nextTurnUsd, nextTurnKrw: nextTurnUsd * settings.exchangeRate,
            nextTurnMissUsd, nextTurnMissKrw: nextTurnMissUsd * settings.exchangeRate,
            nextAvgOut, turnRecords,
            sumRerollCount, sumRerollKrw,
        };
    }

    renderCombinedModal(settings, chatResult, defaultTab, upToIndex, basePromptInfo, cacheRateInfo);
}

function fmtK(num) {
    if (num >= 100000) return `${(num / 1000).toFixed(0)}k`;
    if (num >= 10000) return `${(num / 1000).toFixed(1)}k`;
    return num.toLocaleString();
}

function escapeHtml(str) {
    return String(str ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function getPrevMonthPrefix() {
    const now = new Date();
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}`;
}

function getDateKeyOffset(daysAgo) {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function buildWalletCardHtml(settings) {
    const wallets = loadWallets();
    if (!wallets.items.length) return "";

    const { wallet: current, matchedBy, matchedName } = resolveTargetWalletWithReason(wallets);

    const optionsHtml = `<option value="" ${!current ? "selected" : ""}>차감 안 함 (선택 해제)</option>`
        + wallets.items.map(w => {
            const sel = current && current.id === w.id ? "selected" : "";
            const balShort = formatWalletAmount(w.balance, w.currency);
            return `<option value="${escapeHtml(w.id)}" ${sel}>${escapeHtml(w.name)} (${balShort})</option>`;
        }).join("");

    if (!current) {
        return `
            <div class="gcost-wallet-card">
                <div class="gcost-wallet-top">
                    <span class="gcost-wallet-label">크레딧 지갑</span>
                    <select id="gcost_live_wallet_select" class="gcost-wallet-select">${optionsHtml}</select>
                </div>
                <div class="gcost-wallet-sub">현재 자동 차감이 꺼져 있어요. 위에서 계정을 선택하면 통장처럼 자동 차감됩니다.</div>
            </div>
        `;
    }

    const bal = Number(current.balance) || 0;
    const init = Number(current.initialAmount) || 0;
    const pctRaw = init > 0 ? Math.round((bal / init) * 100) : 0;
    const pctClamped = Math.max(0, Math.min(100, pctRaw));
    const stateClass = bal <= 0 ? "over" : (init > 0 && (bal / init) <= 0.2 ? "warn" : "");
    const balStr = formatWalletAmount(bal, current.currency);
    const initStr = init > 0 ? formatWalletAmount(init, current.currency) : "";
    const krwSub = current.currency === "USD"
        ? `약 ${Math.round(bal * settings.exchangeRate).toLocaleString()}원`
        : "";
    const dday = getWalletDdayLabel(current.expiresAt);
    const ddayTag = dday ? `<span class="gcost-wallet-pill">${escapeHtml(dday)}</span>` : "";
    let autoTag = "";
    if (matchedBy === "keyLabel") {
        autoTag = `<span class="gcost-wallet-pill gcost-wallet-pill-auto" title="활성 API 키 이름(${escapeHtml(matchedName)})과 자동 매칭됨 (키 원문 미수집)">키 이름: ${escapeHtml(matchedName)}</span>`;
    } else if (matchedBy === "profile") {
        autoTag = `<span class="gcost-wallet-pill gcost-wallet-pill-auto" title="SillyTavern 연결 프로필(${escapeHtml(matchedName)})과 자동 매칭됨">프로필: ${escapeHtml(matchedName)}</span>`;
    }

    return `
        <div class="gcost-wallet-card ${stateClass}">
            <div class="gcost-wallet-top">
                <select id="gcost_live_wallet_select" class="gcost-wallet-select" title="활성 크레딧 지갑 전환">${optionsHtml}</select>
                <div class="gcost-wallet-btns">
                    <button type="button" class="gcost-inline-auto-btn gcost-wallet-topup-btn" data-wallet-id="${escapeHtml(current.id)}">+ 충전</button>
                    <button type="button" class="gcost-inline-auto-btn gcost-wallet-sync-btn" data-wallet-id="${escapeHtml(current.id)}">보정</button>
                </div>
            </div>
            <div class="gcost-wallet-mid">
                <div class="gcost-wallet-bal-wrap">
                    <strong class="gcost-wallet-bal">${escapeHtml(balStr)}</strong>
                    ${krwSub ? `<span class="gcost-wallet-krw">${escapeHtml(krwSub)}</span>` : ""}
                </div>
                <div class="gcost-wallet-meta">
                    ${autoTag}
                    ${ddayTag}
                    ${init > 0 ? `<span class="gcost-wallet-pct">${pctRaw}% (${escapeHtml(initStr)})</span>` : ""}
                </div>
            </div>
            ${init > 0 ? `<div class="gcost-progress-track"><div class="gcost-progress-fill ${stateClass}" style="width:${pctClamped}%"></div></div>` : ""}
        </div>
    `;
}

function buildLiveStatsHtml(logFilter = "all", logLimit = 8) {
    const settings = getSettings();
    const stats = loadDailyStats();
    const logs = loadRecentLogs();
    const today = getTodayKey();
    const monthPrefix = today.slice(0, 7);
    const prevMonthPrefix = getPrevMonthPrefix();

    let monthTotalKrw = 0, monthTotalUsd = 0;
    let prevMonthTotalKrw = 0;
    const monthByCat = {};
    const monthByModel = {};
    const monthByCaller = {};

    Object.entries(stats).forEach(([dateKey, d]) => {
        if (dateKey.startsWith(prevMonthPrefix)) {
            prevMonthTotalKrw += d.krw || 0;
            return;
        }
        if (!dateKey.startsWith(monthPrefix)) return;
        monthTotalKrw += d.krw || 0;
        monthTotalUsd += d.usd || 0;

        Object.entries(d.byCategory || {}).forEach(([cat, v]) => {
            if (!monthByCat[cat]) monthByCat[cat] = { usd: 0, krw: 0, calls: 0 };
            monthByCat[cat].usd += v.usd || 0;
            monthByCat[cat].krw += v.krw || 0;
            monthByCat[cat].calls += v.calls || 0;
        });

        Object.entries(d.byModel || {}).forEach(([m, v]) => {
            if (!monthByModel[m]) monthByModel[m] = { usd: 0, krw: 0, calls: 0 };
            monthByModel[m].usd += v.usd || 0;
            monthByModel[m].krw += v.krw || 0;
            monthByModel[m].calls += v.calls || 0;
        });

        Object.entries(d.byCaller || {}).forEach(([c, v]) => {
            if (!monthByCaller[c]) monthByCaller[c] = { usd: 0, krw: 0, calls: 0, category: v.category || "ext" };
            monthByCaller[c].usd += v.usd || 0;
            monthByCaller[c].krw += v.krw || 0;
            monthByCaller[c].calls += v.calls || 0;
        });
    });

    const todayKrw = stats[today]?.krw || 0;
    const mainKrw = monthByCat.main?.krw || 0;
    const auxKrw = Math.max(0, monthTotalKrw - mainKrw);

    // 1. 예산 진행률 바 (설정한 경우에만 표시)
    const dailyLimit = Number(settings.dailyBudgetKrw) || 0;
    const monthlyLimit = Number(settings.monthlyBudgetKrw) || 0;
    const budgetBars = [];
    if (dailyLimit > 0) {
        const pct = Math.min(100, Math.round((todayKrw / dailyLimit) * 100));
        const overClass = todayKrw >= dailyLimit ? "over" : (pct >= 80 ? "warn" : "");
        budgetBars.push(`
            <div class="gcost-budget-row">
                <div class="gcost-budget-head">
                    <span>오늘 예산</span>
                    <span>${Math.round(todayKrw).toLocaleString()} / ${dailyLimit.toLocaleString()}원 (${Math.round((todayKrw / dailyLimit) * 100)}%)</span>
                </div>
                <div class="gcost-progress-track"><div class="gcost-progress-fill ${overClass}" style="width:${pct}%"></div></div>
            </div>
        `);
    }
    if (monthlyLimit > 0) {
        const pct = Math.min(100, Math.round((monthTotalKrw / monthlyLimit) * 100));
        const overClass = monthTotalKrw >= monthlyLimit ? "over" : (pct >= 80 ? "warn" : "");
        budgetBars.push(`
            <div class="gcost-budget-row">
                <div class="gcost-budget-head">
                    <span>이번 달 예산</span>
                    <span>${Math.round(monthTotalKrw).toLocaleString()} / ${monthlyLimit.toLocaleString()}원 (${Math.round((monthTotalKrw / monthlyLimit) * 100)}%)</span>
                </div>
                <div class="gcost-progress-track"><div class="gcost-progress-fill ${overClass}" style="width:${pct}%"></div></div>
            </div>
        `);
    }
    const budgetHtml = budgetBars.length > 0 ? `<div class="gcost-budget-box">${budgetBars.join("")}</div>` : "";

    // 2. 실측 프롬프트 캐시 적중률 + 절약액 모니터링 (모델별 공식 최소 임계값 기준)
    const measuredMainLogs = logs.filter(l => {
        if (l.category !== "main" || l.isEstimated !== false) return false;
        const minTok = getMinCacheTokens(l.modelLabel || l.modelKey || "");
        return (l.totalInput || 0) >= minTok;
    });
    const belowThresholdMainCount = logs.filter(l => {
        if (l.category !== "main" || l.isEstimated !== false) return false;
        const minTok = getMinCacheTokens(l.modelLabel || l.modelKey || "");
        return (l.totalInput || 0) > 0 && (l.totalInput || 0) < minTok;
    }).length;

    let cacheInsightHtml = "";
    if (measuredMainLogs.length > 0) {
        const sumIn = measuredMainLogs.reduce((acc, l) => acc + (l.totalInput || 0), 0);
        const sumCache = measuredMainLogs.reduce((acc, l) => acc + (l.cacheTokens || 0), 0);
        const sumSavedKrw = measuredMainLogs.reduce((acc, l) => acc + getLogSavedKrw(l, settings), 0);
        const hitPct = sumIn > 0 ? Math.round((sumCache / sumIn) * 100) : 0;

        // 최근 호출 간격이 긴 편인지 확인 (300초 이상 간격 비율)
        let longGapCount = 0;
        let gapPairs = 0;
        for (let i = 0; i < measuredMainLogs.length - 1; i++) {
            const newer = getLogTimestamp(measuredMainLogs[i]);
            const older = getLogTimestamp(measuredMainLogs[i + 1]);
            if (newer && older && newer >= older) {
                gapPairs += 1;
                if ((newer - older) > 5 * 60 * 1000) longGapCount += 1;
            }
        }
        const mostlyLongGap = gapPairs > 0 && (longGapCount / gapPairs) >= 0.5;
        const savedText = sumSavedKrw >= 1 ? ` · 약 ${Math.round(sumSavedKrw).toLocaleString()}원 절약` : "";

        let statusClass = "ok";
        let statusNote = `최근 ${measuredMainLogs.length}회 평균${savedText}`;
        if (hitPct < 50 && mostlyLongGap) {
            statusClass = "warn";
            statusNote = `요청 간격이 길어 캐시가 풀렸을 수 있어요${savedText}`;
        } else if (hitPct === 0 && measuredMainLogs.length >= 2) {
            statusClass = "warn";
            statusNote = "캐시 미작동 · 프롬프트 순서/로어북 점검 권장";
        } else if (hitPct < 50) {
            statusClass = "warn";
            statusNote = `최근 ${measuredMainLogs.length}회 평균 · 캐시 효율 낮음${savedText}`;
        }
        cacheInsightHtml = `
            <div class="gcost-insight-bar ${statusClass}">
                <span class="gcost-insight-label">실측 캐시 적중률 <strong>${hitPct}%</strong></span>
                <span class="gcost-insight-note">${statusNote}</span>
            </div>
        `;
    } else if (belowThresholdMainCount > 0) {
        cacheInsightHtml = `
            <div class="gcost-insight-bar">
                <span class="gcost-insight-label">실측 캐시 대기</span>
                <span class="gcost-insight-note">최근 호출이 최소 캐싱 임계값(2,048~4,096t) 미만이에요</span>
            </div>
        `;
    }

    // 3. 일자별 지출 (이번 달 기록된 전체 날짜 + 최근 7일, 접이식으로 컴팩트 유지)
    const dailyKeySet = new Set();
    for (let i = 0; i < 7; i++) dailyKeySet.add(getDateKeyOffset(i));
    Object.keys(stats).forEach(dk => {
        if (dk.startsWith(monthPrefix)) dailyKeySet.add(dk);
    });
    const sortedDailyKeys = [...dailyKeySet].sort((a, b) => (a < b ? 1 : -1));
    const todayDk = getTodayKey();
    const yesterdayDk = getDateKeyOffset(1);

    let activeDaysInMonth = 0;
    const dailyRows = sortedDailyKeys.map(dk => {
        const d = stats[dk];
        const krw = d?.krw || 0;
        const calls = d?.turns || 0;
        if (dk.startsWith(monthPrefix) && calls > 0) activeDaysInMonth += 1;
        const dayTag = dk === todayDk ? "오늘" : (dk === yesterdayDk ? "어제" : dk.slice(5));
        const mainK = d?.byCategory?.main?.krw || 0;
        const auxK = Math.max(0, krw - mainK);
        const dayTip = calls > 0
            ? `${dk} · 총 ${calls}회 (메인 ${Math.round(mainK).toLocaleString()}원 / 부가 ${Math.round(auxK).toLocaleString()}원)`
            : `${dk} · 기록 없음`;
        return `
            <div class="gcost-compare-row" title="${escapeHtml(dayTip)}">
                <span class="gcost-model-name">${dayTag} <span class="gcost-compare-note">(${dk})</span></span>
                <span class="gcost-model-usd">${calls}회</span>
                <span class="gcost-model-krw">${Math.round(krw).toLocaleString()}원</span>
            </div>
        `;
    });
    const dailySummaryNote = activeDaysInMonth > 0
        ? `이번 달 ${activeDaysInMonth}일 기록 · ${Math.round(monthTotalKrw).toLocaleString()}원`
        : `이번 달 기록 없음`;
    const last7Html = `
        <details class="gcost-details">
            <summary class="gcost-details-summary">
                <span>일자별 전체 지출 (최근 7일 · 이번 달)</span>
                <span class="gcost-compare-note">${dailySummaryNote}</span>
            </summary>
            <div class="gcost-compare-list" style="margin-top:4px;">${dailyRows.join("")}</div>
        </details>
    `;

    const callerEntries = Object.entries(monthByCaller)
        .filter(([name]) => name !== "메인 채팅")
        .sort((a, b) => b[1].krw - a[1].krw);

    const callerSectionHtml = callerEntries.length > 0 ? `
        <div class="gcost-compare-header">
            <span class="gcost-compare-title">확장·외부 호출별 사용량 (이번 달)</span>
            <span class="gcost-compare-note">본 채팅 외 독립 호출</span>
        </div>
        <div class="gcost-compare-list">
            ${callerEntries.map(([name, v]) => `
                <div class="gcost-compare-row">
                    <span class="gcost-model-name">
                        <span class="gcost-cat-badge cat-${escapeHtml(v.category || "ext")}">${escapeHtml(CATEGORY_LABELS[v.category] || "확장")}</span>
                        <span title="${escapeHtml(name)}">${escapeHtml(name)} (${v.calls}회)</span>
                    </span>
                    <span class="gcost-model-usd">$${v.usd.toFixed(4)}</span>
                    <span class="gcost-model-krw">${Math.round(v.krw).toLocaleString()}원</span>
                </div>
            `).join("")}
        </div>
    ` : "";

    const catRows = Object.entries(monthByCat)
        .sort((a, b) => b[1].krw - a[1].krw)
        .map(([cat, v]) => `
            <div class="gcost-compare-row">
                <span class="gcost-model-name">
                    <span class="gcost-cat-badge cat-${escapeHtml(cat)}">${escapeHtml(CATEGORY_LABELS[cat] || cat)}</span>
                    <span>${v.calls}회 호출</span>
                </span>
                <span class="gcost-model-usd">$${v.usd.toFixed(4)}</span>
                <span class="gcost-model-krw">${Math.round(v.krw).toLocaleString()}원</span>
            </div>
        `).join("") || `<div class="gcost-empty-msg">아직 추적된 API 호출 기록이 없습니다.</div>`;

    const modelRows = Object.entries(monthByModel)
        .sort((a, b) => b[1].krw - a[1].krw)
        .map(([m, v]) => `
            <div class="gcost-compare-row">
                <span class="gcost-model-name">${escapeHtml(m)} (${v.calls}회)</span>
                <span class="gcost-model-usd">$${v.usd.toFixed(4)}</span>
                <span class="gcost-model-krw">${Math.round(v.krw).toLocaleString()}원</span>
            </div>
        `).join("") || `<div class="gcost-empty-msg">모델별 집계 내역이 없습니다.</div>`;

    // 각 메인 로그와 직전 메인 로그의 경과 시간 맵 계산
    const prevMainGapByIdx = new Map();
    const mainIndices = [];
    logs.forEach((l, i) => { if (l.category === "main") mainIndices.push(i); });
    for (let k = 0; k < mainIndices.length - 1; k++) {
        const curIdx = mainIndices[k];
        const prevIdx = mainIndices[k + 1];
        const curTs = getLogTimestamp(logs[curIdx]);
        const prevTs = getLogTimestamp(logs[prevIdx]);
        if (curTs && prevTs && curTs >= prevTs) {
            prevMainGapByIdx.set(curIdx, curTs - prevTs);
        }
    }

    const indexedLogs = logs
        .map((l, origIdx) => ({ log: l, origIdx }))
        .filter(({ log }) => {
            if (logFilter === "main") return log.category === "main";
            if (logFilter === "aux") return log.category !== "main";
            return true;
        });

    const visibleLogs = indexedLogs.slice(0, logLimit);
    const hasMoreLogs = indexedLogs.length > visibleLogs.length;

    const recentRows = visibleLogs.map(({ log: l, origIdx }) => {
        const showCaller = l.callerLabel && l.callerLabel !== "메인 채팅" && l.callerLabel !== CATEGORY_LABELS[l.category];
        const callerTag = showCaller ? `<span class="gcost-caller-tag" title="${escapeHtml(l.callerLabel)}">${escapeHtml(l.callerLabel)}</span>` : "";
        const totalIn = l.totalInput || 0;
        const cacheIn = l.cacheTokens || 0;
        const normalIn = Math.max(0, totalIn - cacheIn);
        const outT = l.outTokens || 0;
        const thinkT = l.thinkTokens || 0;
        const hitPct = totalIn > 0 ? Math.round((cacheIn / totalIn) * 100) : 0;
        const savedKrw = getLogSavedKrw(l, settings);
        const gapMs = prevMainGapByIdx.get(origIdx);
        const gapLine = gapMs !== undefined ? `직전 메인 호출 후 ${formatElapsedMs(gapMs)} 경과 · 캐시 ${hitPct}%` : `캐시 ${hitPct}%`;
        const savedLine = savedKrw >= 1 ? ` (약 ${Math.round(savedKrw).toLocaleString()}원 절약)` : "";
        const logTip = [
            `[${l.isEstimated ? "로컬 추정" : "API 실측"}] ${l.modelLabel} (${l.date || ""} ${l.time || ""})`,
            `입력 ${totalIn.toLocaleString()}t (캐시 ${cacheIn.toLocaleString()}t / 일반 ${normalIn.toLocaleString()}t)`,
            `출력 ${outT.toLocaleString()}t (생각 ${thinkT.toLocaleString()}t 포함)`,
            `${gapLine}${savedLine}`,
        ].join("\n");
        return `
            <div class="gcost-compare-row gcost-log-row" title="${escapeHtml(logTip)}">
                <span class="gcost-model-name">
                    <span class="gcost-cat-badge cat-${escapeHtml(l.category)}">${escapeHtml(CATEGORY_LABELS[l.category] || l.category)}</span>
                    ${callerTag}
                    <span>${escapeHtml(l.modelLabel)}</span>
                </span>
                <span class="gcost-model-usd">${escapeHtml(l.time)} · ${fmtK(totalIn)}→${fmtK(outT + thinkT)}</span>
                <span class="gcost-model-krw">${Math.round(l.costKrw).toLocaleString()}원</span>
                <button type="button" class="gcost-log-del-btn" data-log-idx="${origIdx}" title="이 로그 삭제 및 통계에서 차감">×</button>
            </div>
        `;
    }).join("") || `<div class="gcost-empty-msg">해당 조건의 호출 로그가 없습니다.</div>`;

    const logMoreBtnHtml = hasMoreLogs ? `
        <div class="gcost-log-more-wrap">
            <button type="button" id="gcost_log_more_btn" class="gcost-btn gcost-btn-xs">더 보기 (${visibleLogs.length} / ${indexedLogs.length}건)</button>
        </div>
    ` : "";

    const prevMonthSub = prevMonthTotalKrw > 0
        ? ` · 지난달 ${Math.round(prevMonthTotalKrw).toLocaleString()}원`
        : "";

    const walletCardHtml = buildWalletCardHtml(settings);

    return `
        ${walletCardHtml}

        <div class="gcost-summary-cards">
            <div class="gcost-card">
                <div class="gcost-card-title">이번 달 메인 채팅</div>
                <div class="gcost-card-main">${Math.round(mainKrw).toLocaleString()}원</div>
                <div class="gcost-card-sub">총 ${monthByCat.main?.calls || 0}회 호출${prevMonthSub}</div>
            </div>
            <div class="gcost-card">
                <div class="gcost-card-title">이번 달 확장·부가기능</div>
                <div class="gcost-card-main">${Math.round(auxKrw).toLocaleString()}원</div>
                <div class="gcost-card-sub">전체 합계 ${Math.round(monthTotalKrw).toLocaleString()}원 ($${monthTotalUsd.toFixed(3)})</div>
            </div>
        </div>

        ${budgetHtml}
        ${cacheInsightHtml}
        ${last7Html}
        ${callerSectionHtml}

        <div class="gcost-compare-header">
            <span class="gcost-compare-title">용도별 사용량 (이번 달)</span>
            <span class="gcost-compare-note">네트워크 자동 감지</span>
        </div>
        <div class="gcost-compare-list">${catRows}</div>

        <div class="gcost-compare-header">
            <span class="gcost-compare-title">모델별 사용량 (이번 달)</span>
            <span class="gcost-compare-note">모델별 단가 자동 적용</span>
        </div>
        <div class="gcost-compare-list">${modelRows}</div>

        <div class="gcost-compare-header gcost-log-header">
            <span class="gcost-compare-title">최근 API 호출 로그 (${indexedLogs.length}건)</span>
            <div class="gcost-log-filters">
                <button type="button" class="gcost-filter-chip ${logFilter === "all" ? "active" : ""}" data-filter="all">전체</button>
                <button type="button" class="gcost-filter-chip ${logFilter === "main" ? "active" : ""}" data-filter="main">메인</button>
                <button type="button" class="gcost-filter-chip ${logFilter === "aux" ? "active" : ""}" data-filter="aux">확장·부가</button>
            </div>
        </div>
        <div class="gcost-compare-list">${recentRows}</div>
        ${logMoreBtnHtml}
    `;
}

/**
 * [v2.0.0 신규] 캐싱 분석 전용 탭 HTML 생성
 * - 실측 캐시 적중률 · 절약액 · 평균 간격 요약
 * - 호출 간격별 내 실측 캐시 적중률 구간표
 * - 최근 실측 턴별 캐시 히트 타임라인
 */
function buildCacheAnalysisHtml() {
    const settings = getSettings();
    const logs = loadRecentLogs();

    const allMeasuredMain = logs.filter(l => l.category === "main" && l.isEstimated === false && (l.totalInput || 0) > 0);
    const eligibleLogs = allMeasuredMain.filter(l => (l.totalInput || 0) >= getMinCacheTokens(l.modelLabel || l.modelKey || ""));
    const excludedShortCount = allMeasuredMain.length - eligibleLogs.length;

    if (eligibleLogs.length === 0) {
        const reason = excludedShortCount > 0
            ? `최근 실측 메인 호출 ${excludedShortCount}건이 모두 최소 캐싱 임계값(2,048~4,096t) 미만이라 분석 대상이 아직 없어요.`
            : "아직 API 실측(usage)으로 기록된 메인 채팅 호출이 없어요. 대화를 몇 턴 진행하시면 내 실측 캐시 패턴이 자동으로 분석됩니다.";
        return `
            <div class="gcost-empty-msg" style="padding:22px 14px;line-height:1.6;">
                <strong style="display:block;color:#334155;margin-bottom:4px;">캐싱 분석 데이터 수집 대기 중</strong>
                <span>${reason}</span>
            </div>
            <div class="gcost-cache-spec-box">
                <div class="gcost-cache-spec-title">공식 문서 기준 안내 (Google Gemini API · Vertex AI)</div>
                <ul>
                    <li><strong>최소 임계값:</strong> Gemini 2.5 계열 2,048t · Gemini 3.x / 4 계열 4,096t 이상</li>
                    <li><strong>유지 시간:</strong> 암묵적 캐싱은 고정 만료 시간이 없으며 서버 부하·빈도에 따라 동적 관리 (Vertex Durable 최대 24시간)</li>
                    <li><strong>Gemini 4 멀티턴:</strong> 신규 2,050t 이상 추가 시 직전 턴 전체 롤오버</li>
                </ul>
            </div>
        `;
    }

    const sumIn = eligibleLogs.reduce((acc, l) => acc + (l.totalInput || 0), 0);
    const sumCache = eligibleLogs.reduce((acc, l) => acc + (l.cacheTokens || 0), 0);
    const sumSavedKrw = eligibleLogs.reduce((acc, l) => acc + getLogSavedKrw(l, settings), 0);
    const totalHitPct = sumIn > 0 ? Math.round((sumCache / sumIn) * 100) : 0;
    const fullMissCount = eligibleLogs.filter(l => (l.cacheTokens || 0) === 0).length;
    const fullMissPct = eligibleLogs.length > 0 ? Math.round((fullMissCount / eligibleLogs.length) * 100) : 0;

    // [v2.3.0] 2027/1/12 Hydrogen 및 이후 모델 캐시 쓰기(1.25배) 예고 기준 참고 손익 시뮬레이션
    // 입력비 배수 = 0.05 * r + 1.25 * (1 - r) = 1.25 - 1.20 * r (본전선 r = 20.83%)
    const hitRatio = sumIn > 0 ? (sumCache / sumIn) : 0;
    const writeSimMult = 1.25 - (1.20 * hitRatio);
    const writeSimDiffPct = Math.round(Math.abs(1 - writeSimMult) * 100);
    const writeSimIsProfit = writeSimMult <= 1.0;
    const writeSimBoxHtml = `
        <div class="gcost-cache-sim-box ${writeSimIsProfit ? "ok" : "warn"}">
            <div class="gcost-cache-sim-head">
                <strong>2027/1/12 캐시 쓰기(1.25배) 예고 기준 참고 진단</strong>
                <span>${writeSimIsProfit ? `입력비 약 ${writeSimDiffPct}% 절감 (이득)` : `입력비 약 ${writeSimDiffPct}% 증가 (주의)`}</span>
            </div>
            <div class="gcost-cache-sim-desc">
                내 실측 캐시율 <strong>${totalHitPct}%</strong> (본전선 20.8% 대비 ${writeSimIsProfit ? "초과" : "미만"}) ·
                ${writeSimIsProfit ? "Hydrogen 이후 모델에서도 캐싱 유지가 유리한 패턴이에요." : "프롬프트 앞부분 고정·간격 점검 시 절감 효과가 커져요."}
                <span class="gcost-cache-sim-note">※ 참고 시뮬레이션이며 현재 실제 과금에는 반영되지 않아요.</span>
            </div>
        </div>
    `;

    // 호출 간격 구간별 집계 (logs는 최신순이므로 i가 newer, i+1이 older)
    const buckets = [
        { id: "0-1", label: "0 ~ 1분", min: 0, max: 60_000, count: 0, sumHit: 0, hitCalls: 0 },
        { id: "1-3", label: "1 ~ 3분", min: 60_000, max: 180_000, count: 0, sumHit: 0, hitCalls: 0 },
        { id: "3-5", label: "3 ~ 5분", min: 180_000, max: 300_000, count: 0, sumHit: 0, hitCalls: 0 },
        { id: "5-10", label: "5 ~ 10분", min: 300_000, max: 600_000, count: 0, sumHit: 0, hitCalls: 0 },
        { id: "10-30", label: "10 ~ 30분", min: 600_000, max: 1_800_000, count: 0, sumHit: 0, hitCalls: 0 },
        { id: "30+", label: "30분 이상", min: 1_800_000, max: Infinity, count: 0, sumHit: 0, hitCalls: 0 },
    ];

    const gapByIdx = new Map();
    let totalGapMs = 0;
    let gapCount = 0;

    for (let i = 0; i < eligibleLogs.length - 1; i++) {
        const cur = eligibleLogs[i];
        const prev = eligibleLogs[i + 1];
        // 서로 다른 채팅방으로 이동한 경우(둘 다 chatId가 있고 서로 다르면) 연속 캐시 간격 집계에서 제외
        if (cur.chatId && prev.chatId && cur.chatId !== prev.chatId) continue;
        const curTs = getLogTimestamp(cur);
        const prevTs = getLogTimestamp(prev);
        if (!curTs || !prevTs || curTs < prevTs) continue;
        const diff = curTs - prevTs;
        gapByIdx.set(i, diff);
        // 6시간(세션 변경) 이상 떨어진 호출은 평균 간격 왜곡 방지를 위해 평균에서 제외하되 30분+ 구간에는 집계
        if (diff <= 6 * 3600 * 1000) {
            totalGapMs += diff;
            gapCount += 1;
        }
        const hitRate = cur.totalInput > 0 ? (cur.cacheTokens || 0) / cur.totalInput : 0;
        const bucket = buckets.find(b => diff >= b.min && diff < b.max);
        if (bucket) {
            bucket.count += 1;
            bucket.sumHit += hitRate * 100;
            if (hitRate > 0) bucket.hitCalls += 1;
        }
    }

    const avgGapText = gapCount > 0 ? formatElapsedMs(totalGapMs / gapCount) : "-";

    const bucketRowsHtml = buckets.map(b => {
        const avgPct = b.count > 0 ? Math.round(b.sumHit / b.count) : 0;
        const barClass = b.count === 0 ? "empty" : (avgPct >= 70 ? "high" : (avgPct >= 30 ? "mid" : "low"));
        const countLabel = b.count > 0 ? `${b.count}회` : "기록 없음";
        const pctLabel = b.count > 0 ? `${avgPct}%` : "-";
        return `
            <div class="gcost-cache-bucket-row">
                <span class="gcost-cache-bucket-label">${b.label}</span>
                <div class="gcost-cache-bar-track">
                    <div class="gcost-cache-bar-fill ${barClass}" style="width:${b.count > 0 ? Math.max(4, avgPct) : 0}%"></div>
                </div>
                <span class="gcost-cache-bucket-cnt">${countLabel}</span>
                <span class="gcost-cache-bucket-pct">${pctLabel}</span>
            </div>
        `;
    }).join("");

    const timelineRowsHtml = eligibleLogs.slice(0, 12).map((l, idx) => {
        const totalIn = l.totalInput || 0;
        const cacheIn = l.cacheTokens || 0;
        const pct = totalIn > 0 ? Math.round((cacheIn / totalIn) * 100) : 0;
        const savedKrw = getLogSavedKrw(l, settings);
        const gapMs = gapByIdx.get(idx);
        const gapBadge = gapMs !== undefined ? formatElapsedMs(gapMs) : "첫 기록";
        const barClass = pct >= 70 ? "high" : (pct >= 30 ? "mid" : "low");
        return `
            <div class="gcost-cache-tl-row" title="${escapeHtml(`${l.date || ""} ${l.time || ""} · ${l.modelLabel} · 입력 ${totalIn.toLocaleString()}t (캐시 ${cacheIn.toLocaleString()}t)`)}">
                <span class="gcost-cache-tl-time">${escapeHtml(l.time || "")}</span>
                <span class="gcost-cache-tl-gap">${escapeHtml(gapBadge)}</span>
                <span class="gcost-cache-tl-in">${fmtK(totalIn)}t</span>
                <div class="gcost-cache-bar-track gcost-cache-tl-bar">
                    <div class="gcost-cache-bar-fill ${barClass}" style="width:${pct > 0 ? Math.max(4, pct) : 0}%"></div>
                </div>
                <span class="gcost-cache-tl-pct">${pct}%</span>
                <span class="gcost-cache-tl-saved">${savedKrw >= 1 ? `-${Math.round(savedKrw).toLocaleString()}원` : "-"}</span>
            </div>
        `;
    }).join("");

    return `
        <div class="gcost-summary-cards gcost-cards-3">
            <div class="gcost-card gcost-card-highlight">
                <div class="gcost-card-title">실측 캐시 적중률</div>
                <div class="gcost-card-main">${totalHitPct}%</div>
                <div class="gcost-card-sub" title="임계값 이상 ${eligibleLogs.length}회 중 완전 실패(0%) ${fullMissCount}회">대상 ${eligibleLogs.length}회 · 풀미스 ${fullMissCount}회(${fullMissPct}%)</div>
            </div>
            <div class="gcost-card">
                <div class="gcost-card-title">캐시 절약액</div>
                <div class="gcost-card-main">약 ${Math.round(sumSavedKrw).toLocaleString()}원</div>
                <div class="gcost-card-sub">최근 실측 ${eligibleLogs.length}회 합계</div>
            </div>
            <div class="gcost-card">
                <div class="gcost-card-title">평균 호출 간격</div>
                <div class="gcost-card-main">${avgGapText}</div>
                <div class="gcost-card-sub">${gapCount > 0 ? `연속 ${gapCount}구간 기준` : "데이터 수집 중"}</div>
            </div>
        </div>

        ${writeSimBoxHtml}

        <div class="gcost-compare-header">
            <span class="gcost-compare-title">호출 간격별 내 실측 캐시 적중률</span>
            <span class="gcost-compare-note">${excludedShortCount > 0 ? `임계값 미만 ${excludedShortCount}건 제외` : "실측 메인 호출 기준"}</span>
        </div>
        <div class="gcost-cache-bucket-list">${bucketRowsHtml}</div>

        <div class="gcost-compare-header">
            <span class="gcost-compare-title">최근 실측 턴별 캐시 타임라인</span>
            <span class="gcost-compare-note">시각 · 경과 · 입력 · 적중률 · 절약액</span>
        </div>
        <div class="gcost-cache-tl-list">${timelineRowsHtml}</div>

        <div class="gcost-cache-spec-box">
            <div class="gcost-cache-spec-title">공식 문서 기준 안내 (Google Gemini API · Vertex AI)</div>
            <ul>
                <li><strong>최소 임계값:</strong> Gemini 2.5 계열 2,048t · Gemini 3.x / 4 계열 4,096t 이상</li>
                <li><strong>유지 시간:</strong> 암묵적 캐싱은 고정 만료 시간이 없으며 서버 부하·빈도에 따라 동적 관리 (Vertex Durable 최대 24시간)</li>
                <li><strong>Gemini 4 멀티턴:</strong> 신규 2,050t 이상 추가 시 직전 턴 전체 롤오버</li>
            </ul>
        </div>
    `;
}

function buildModalSettingsHtml(settings, basePromptInfo = null, cacheRateInfo = null) {
    const customs = Array.isArray(settings.customPresets) ? settings.customPresets : [];
    const presetOptions = Object.entries(PRESETS).map(([key, p]) => {
        const sel = settings.preset === key ? "selected" : "";
        return `<option value="${key}" ${sel}>${p.label}</option>`;
    }).join("")
        + customs.map(c => {
            const sel = settings.preset === c.id ? "selected" : "";
            return `<option value="${escapeHtml(c.id)}" ${sel}>${escapeHtml(c.label)} (커스텀)</option>`;
        }).join("")
        + `<option value="custom" ${settings.preset === "custom" ? "selected" : ""}>직접 입력 (Custom)</option>`;

    const savedCustomListHtml = customs.length > 0 ? `
        <div class="gcost-custom-saved-list">
            <div class="gcost-custom-saved-title">저장된 커스텀 프리셋 (${customs.length})</div>
            ${customs.map(c => `
                <div class="gcost-custom-saved-row">
                    <span class="gcost-custom-saved-name" title="${escapeHtml(c.label)}">${escapeHtml(c.label)}</span>
                    <span class="gcost-custom-saved-price">$${c.inBase} / $${c.cacheBase} / $${c.outBase}</span>
                    <button type="button" class="gcost-log-del-btn gcost-custom-del-btn" data-custom-id="${escapeHtml(c.id)}" title="이 커스텀 프리셋 삭제">×</button>
                </div>
            `).join("")}
        </div>
    ` : "";

    const quickRates = [1350, 1400, 1450, 1500];
    const rateChips = quickRates.map(r => {
        const active = Number(settings.exchangeRate) === r ? "active" : "";
        return `<button type="button" class="gcost-rate-chip ${active}" data-rate="${r}">${r.toLocaleString()}원</button>`;
    }).join("");

    const autoActiveClass = settings.autoBasePrompt ? "active" : "";
    const autoHint = basePromptInfo?.detail
        ? `현재 산출: ${escapeHtml(basePromptInfo.detail)}`
        : "현재 캐릭터·프리셋·페르소나 기준으로 자동 측정";

    const autoCacheClass = settings.autoCacheRate ? "active" : "";
    const autoCacheDetail = cacheRateInfo?.detail || (settings.autoCacheRate ? "실측 대기 (기본값)" : "수동 설정값");
    const autoCacheHint = `현재 기준: ${escapeHtml(autoCacheDetail)}`;

    const wallets = loadWallets();
    const activeProfileName = getActiveConnectionProfileName();
    const activeSecretLabels = getActiveSecretLabels();
    const hasAutoDetectTarget = Boolean(activeProfileName || activeSecretLabels.length > 0);
    const savedWalletsHtml = wallets.items.length > 0 ? `
        <div class="gcost-custom-saved-list" style="margin-bottom:8px;">
            <div class="gcost-custom-saved-title">등록된 크레딧 지갑 (${wallets.items.length}) · 클릭해 활성 전환</div>
            ${wallets.items.map(w => {
                const isActive = wallets.activeId === w.id;
                const balStr = formatWalletAmount(w.balance, w.currency);
                const dday = getWalletDdayLabel(w.expiresAt);
                const subTags = [
                    w.profileName ? `매칭:${w.profileName}` : "",
                    dday,
                ].filter(Boolean).join(" · ");
                return `
                    <div class="gcost-wallet-saved-row ${isActive ? "active" : ""}">
                        <button type="button" class="gcost-wallet-pick-btn" data-wallet-id="${escapeHtml(w.id)}" title="이 지갑을 기본 활성 지갑으로 선택">
                            <span class="gcost-wallet-dot ${isActive ? "on" : ""}"></span>
                            <span class="gcost-wallet-pick-name">${escapeHtml(w.name)}${subTags ? ` <small>(${escapeHtml(subTags)})</small>` : ""}</span>
                        </button>
                        <span class="gcost-custom-saved-price">${escapeHtml(balStr)}</span>
                        <button type="button" class="gcost-inline-auto-btn gcost-wallet-keys-btn" data-wallet-id="${escapeHtml(w.id)}" title="이 지갑에 연결할 API 키 이름(쉼표 구분) 수정">키</button>
                        <button type="button" class="gcost-inline-auto-btn gcost-wallet-topup-btn" data-wallet-id="${escapeHtml(w.id)}" title="크레딧 추가 충전">+충전</button>
                        <button type="button" class="gcost-inline-auto-btn gcost-wallet-sync-btn" data-wallet-id="${escapeHtml(w.id)}" title="실제 콘솔 잔액과 맞추기">보정</button>
                        <button type="button" class="gcost-log-del-btn gcost-wallet-del-btn" data-wallet-id="${escapeHtml(w.id)}" title="이 지갑 삭제">×</button>
                    </div>
                `;
            }).join("")}
        </div>
    ` : "";

    return `
        <div class="gcost-mset-group">
            <div class="gcost-mset-row">
                <label class="gcost-mset-label">
                    <span>크레딧 지갑 (다계정 잔액 차감)</span>
                    <button type="button" id="gcost_w_toggle_form_btn" class="gcost-inline-auto-btn active">+ 지갑 추가하기</button>
                </label>
                ${savedWalletsHtml}
                <div id="gcost_w_add_form" class="gcost-mset-custom-box" style="display:none;margin-bottom:0;">
                    <div class="gcost-mset-grid3">
                        <div class="gcost-mset-row">
                            <label class="gcost-mset-label" for="gcost_w_name">계정 이름</label>
                            <input id="gcost_w_name" type="text" maxlength="24" class="gcost-mset-input" placeholder="예: 버텍스 본계정" />
                        </div>
                        <div class="gcost-mset-row">
                            <label class="gcost-mset-label" for="gcost_w_currency">통화</label>
                            <select id="gcost_w_currency" class="gcost-mset-select">
                                <option value="USD">달러 (USD $)</option>
                                <option value="KRW">원화 (KRW 원)</option>
                            </select>
                        </div>
                        <div class="gcost-mset-row">
                            <label class="gcost-mset-label" for="gcost_w_amount">초기 잔액</label>
                            <input id="gcost_w_amount" type="number" step="0.01" min="0" class="gcost-mset-input" placeholder="예: 300" />
                        </div>
                    </div>
                    <div class="gcost-mset-grid2" style="margin-top:8px;">
                        <div class="gcost-mset-row">
                            <label class="gcost-mset-label" for="gcost_w_expires">만료일 (선택)</label>
                            <input id="gcost_w_expires" type="date" class="gcost-mset-input" />
                        </div>
                        <div class="gcost-mset-row">
                            <label class="gcost-mset-label" for="gcost_w_profile">
                                <span>API 키 이름 매칭</span>
                                ${hasAutoDetectTarget ? `<button type="button" id="gcost_w_fill_profile" class="gcost-inline-auto-btn" title="현재 켜져 있는 API 키 이름 추가 (키 원문 미수집)">현재 키 추가</button>` : ""}
                            </label>
                            <input id="gcost_w_profile" type="text" maxlength="120" class="gcost-mset-input" placeholder="예: 버텍스1, 보조키 (쉼표 구분)" />
                        </div>
                    </div>
                    <div class="gcost-custom-add-row">
                        <span class="gcost-mset-hint">API 키 원문은 읽지 않고 키 이름(라벨)만 매칭해 자동 차감합니다</span>
                        <button type="button" id="gcost_w_add_btn" class="gcost-btn gcost-btn-primary gcost-btn-xs">+ 지갑 추가</button>
                    </div>
                </div>
            </div>
        </div>

        <div class="gcost-mset-group">
            <div class="gcost-mset-row">
                <label class="gcost-mset-label" for="gcost_modal_exchange_rate">
                    <span>원화(KRW) 환율 (1 USD 기준)</span>
                    <span style="font-weight:500;color:#64748b;">현재 ${Number(settings.exchangeRate).toLocaleString()}원</span>
                </label>
                <input id="gcost_modal_exchange_rate" type="number" step="1" min="1" class="gcost-mset-input" value="${settings.exchangeRate}" />
                <div class="gcost-mset-quick-rates">
                    ${rateChips}
                </div>
            </div>
        </div>

        <div class="gcost-mset-group">
            <div class="gcost-mset-row">
                <label class="gcost-mset-label" for="gcost_modal_preset">기본 모델 단가 프리셋</label>
                <select id="gcost_modal_preset" class="gcost-mset-select">
                    ${presetOptions}
                </select>
                <label class="gcost-regional-chk-row" title="Vertex AI에서 지역(Region)을 'global'이 아닌 개별 지역(예: us-central1, asia-northeast3 등)으로 설정하거나, 프록시로 Vertex 개별 지역을 돌려 쓰는 경우에만 체크하세요!&#10;구글 공식 정책상 Vertex 비글로벌 지역 호출은 요금이 10% 더 붙어요. AI Studio나 Vertex global 사용자는 꺼두시면 됩니다.">
                    <input id="gcost_modal_vertex_regional" type="checkbox" class="gcost-extset-chk" ${settings.vertexRegionalMarkup ? "checked" : ""} />
                    <span>Vertex AI 비글로벌 지역 설정 (+10% 할증)</span>
                </label>
            </div>
            <div id="gcost_modal_custom_box" class="gcost-mset-custom-box" style="${settings.preset === "custom" ? "" : "display:none;"}">
                <div class="gcost-mset-row">
                    <label class="gcost-mset-label" for="gcost_modal_custom_name">직접 입력 단가 이름</label>
                    <input id="gcost_modal_custom_name" type="text" maxlength="30" class="gcost-mset-input" placeholder="예: 내 커스텀 모델" value="${escapeHtml(settings.customName || "직접 입력")}" />
                </div>
                <div class="gcost-mset-grid3">
                    <div class="gcost-mset-row">
                        <label class="gcost-mset-label" for="gcost_modal_in_base">일반 입력 ($)</label>
                        <input id="gcost_modal_in_base" type="number" step="0.01" min="0" class="gcost-mset-input" value="${settings.inBase}" />
                    </div>
                    <div class="gcost-mset-row">
                        <label class="gcost-mset-label" for="gcost_modal_cache_base">캐시 입력 ($)</label>
                        <input id="gcost_modal_cache_base" type="number" step="0.001" min="0" class="gcost-mset-input" value="${settings.cacheBase}" />
                    </div>
                    <div class="gcost-mset-row">
                        <label class="gcost-mset-label" for="gcost_modal_out_base">출력·생각 ($)</label>
                        <input id="gcost_modal_out_base" type="number" step="0.01" min="0" class="gcost-mset-input" value="${settings.outBase}" />
                    </div>
                </div>
                <div class="gcost-custom-add-row">
                    <span class="gcost-mset-hint">1M 토큰당 USD · 추가하면 비교표에 포함됩니다</span>
                    <button type="button" id="gcost_modal_add_custom_btn" class="gcost-btn gcost-btn-primary gcost-btn-xs">+ 프리셋 추가</button>
                </div>
            </div>
            ${savedCustomListHtml}
            <div class="gcost-mset-grid2">
                <div class="gcost-mset-row">
                    <label class="gcost-mset-label" for="gcost_modal_cache_rate">
                        <span>추정 캐시 적중률</span>
                        <span style="display:inline-flex;align-items:center;gap:5px;">
                            <span id="gcost_modal_cache_val">${settings.cacheRate}%</span>
                            <button type="button" id="gcost_modal_auto_cache_btn" class="gcost-inline-auto-btn ${autoCacheClass}" title="${autoCacheHint}">${settings.autoCacheRate ? "자동" : "자동 맞춤"}</button>
                        </span>
                    </label>
                    <input id="gcost_modal_cache_rate" type="range" min="0" max="99" step="1" value="${settings.cacheRate}" style="width:100%;margin-top:6px;" />
                    <div id="gcost_modal_cache_detail" class="gcost-mset-hint" title="${autoCacheHint}">${escapeHtml(autoCacheDetail)}</div>
                </div>
                <div class="gcost-mset-row">
                    <label class="gcost-mset-label" for="gcost_modal_base_prompt">
                        <span>고정 프롬프트 (토큰)</span>
                        <button type="button" id="gcost_modal_auto_base_btn" class="gcost-inline-auto-btn ${autoActiveClass}" title="${autoHint}">${settings.autoBasePrompt ? "자동" : "자동 측정"}</button>
                    </label>
                    <input id="gcost_modal_base_prompt" type="number" step="500" min="0" class="gcost-mset-input" value="${settings.basePromptTokens}" title="${autoHint}" />
                    <div id="gcost_modal_base_detail" class="gcost-mset-hint" title="${autoHint}">${escapeHtml(basePromptInfo?.detail || (settings.autoBasePrompt ? "자동 측정 대기" : "수동 입력값"))}</div>
                </div>
            </div>
            <div class="gcost-mset-grid2" style="margin-top:8px;">
                <div class="gcost-mset-row">
                    <label class="gcost-mset-label" for="gcost_modal_daily_budget">일일 예산 (원 · 0=끔)</label>
                    <input id="gcost_modal_daily_budget" type="number" step="1000" min="0" class="gcost-mset-input" value="${settings.dailyBudgetKrw || 0}" />
                </div>
                <div class="gcost-mset-row">
                    <label class="gcost-mset-label" for="gcost_modal_monthly_budget">월간 예산 (원 · 0=끔)</label>
                    <input id="gcost_modal_monthly_budget" type="number" step="5000" min="0" class="gcost-mset-input" value="${settings.monthlyBudgetKrw || 0}" />
                </div>
            </div>
        </div>

        <div class="gcost-mset-actions">
            <div class="gcost-mset-backup-btns">
                <button type="button" id="gcost_modal_export_btn" class="gcost-btn">백업</button>
                <button type="button" id="gcost_modal_import_btn" class="gcost-btn">복원</button>
            </div>
            <button type="button" id="gcost_modal_save_recalc" class="gcost-btn gcost-btn-primary">설정 저장 및 다시 계산</button>
        </div>
    `;
}

/**
 * 오류 확인 및 제보용 진단 모달 열기
 */
function openDiagnosticModal() {
    $(".gcost-diag-overlay").remove();

    const errors = loadErrorLogs();
    const hasErrors = errors.length > 0;
    const reportText = buildDiagnosticReportText();

    const bodyHtml = hasErrors
        ? `
            <div class="gcost-diag-status warn">
                <strong>최근 감지된 오류 ${errors.length}건</strong>
                <span>아래 리포트를 복사해 제보해 주시면 빠르게 원인을 확인할 수 있어요.</span>
            </div>
            <pre class="gcost-diag-pre">${escapeHtml(reportText)}</pre>
        `
        : `
            <div class="gcost-diag-status ok">
                <strong>지금은 정상적인 상태예요.</strong>
                <span>기록된 오류가 없어요. (Gemini Cost Calculator v${EXT_VERSION})</span>
            </div>
        `;

    const footerHtml = hasErrors
        ? `
            <button type="button" id="gcost_diag_clear_btn" class="gcost-btn">기록 비우기</button>
            <button type="button" id="gcost_diag_copy_btn" class="gcost-btn gcost-btn-primary">오류 리포트 복사</button>
            <button type="button" id="gcost_diag_close_btn" class="gcost-btn">닫기</button>
        `
        : `
            <button type="button" id="gcost_diag_close_btn" class="gcost-btn gcost-btn-primary">닫기</button>
        `;

    const diagModal = $(`
        <div class="gcost-modal-overlay gcost-diag-overlay">
            <div class="gcost-modal gcost-diag-modal">
                <div class="gcost-modal-header">
                    <div class="gcost-modal-title-wrap">
                        <h3>오류 확인 · 제보</h3>
                        <span class="gcost-pill-tag">v${EXT_VERSION}</span>
                    </div>
                    <span class="gcost-modal-close gcost-diag-close" title="닫기">✕</span>
                </div>
                <div class="gcost-modal-body">
                    ${bodyHtml}
                </div>
                <div class="gcost-modal-footer">
                    ${footerHtml}
                </div>
            </div>
        </div>
    `);

    $("body").append(diagModal);

    const closeDiag = () => diagModal.remove();
    let diagOverlayMouseDown = false;
    diagModal.find(".gcost-diag-close, #gcost_diag_close_btn").on("click", closeDiag);
    diagModal.on("mousedown", function (e) {
        diagOverlayMouseDown = $(e.target).hasClass("gcost-diag-overlay");
    });
    diagModal.on("click", function (e) {
        if (diagOverlayMouseDown && $(e.target).hasClass("gcost-diag-overlay")) closeDiag();
        diagOverlayMouseDown = false;
    });

    diagModal.find("#gcost_diag_copy_btn").on("click", async () => {
        const ok = await copyTextToClipboard(reportText);
        if (window.toastr) {
            if (ok) toastr.success("오류 리포트를 복사했습니다. 제보 시 그대로 붙여넣어 주세요.");
            else toastr.warning("자동 복사에 실패했습니다. 위 박스 내용을 직접 선택해 복사해 주세요.");
        }
    });

    diagModal.find("#gcost_diag_clear_btn").on("click", () => {
        clearErrorLogs();
        $(".gcost-diag-btn").removeClass("has-error").text("오류 확인");
        if (window.toastr) toastr.info("오류 기록을 비웠습니다.");
        openDiagnosticModal();
    });
}

/**
 * [v2.2.0] 확장 설정 서브 모달 (말풍선 배지 표시 ON/OFF · 표시 형식 · 추적 옵션 · 초기화)
 */
function openExtensionSettingsModal(onChanged) {
    $(".gcost-extset-overlay").remove();
    const s = getSettings();

    const extModal = $(`
        <div class="gcost-modal-overlay gcost-diag-overlay gcost-extset-overlay">
            <div class="gcost-modal gcost-diag-modal">
                <div class="gcost-modal-header">
                    <div class="gcost-modal-title-wrap">
                        <h3>확장 설정</h3>
                        <span class="gcost-pill-tag">v${EXT_VERSION}</span>
                    </div>
                    <span class="gcost-modal-close gcost-extset-close" title="닫기">✕</span>
                </div>
                <div class="gcost-modal-body">
                    <div class="gcost-tab-desc">확장 활성화 여부와 배지 표시, 캐시 미적중 알림을 한 번에 설정할 수 있어요.</div>

                    <div class="gcost-mset-group">
                        <div class="gcost-extset-toggle-row">
                            <div>
                                <div class="gcost-extset-title">비용 계산 확장 활성화</div>
                                <div class="gcost-extset-sub">확장 전체의 추적 및 배지 기능을 켜거나 끕니다.</div>
                            </div>
                            <input id="gcost_ext_enabled" type="checkbox" class="gcost-extset-chk" ${s.enabled ? "checked" : ""} />
                        </div>
                    </div>

                    <div class="gcost-mset-group">
                        <div class="gcost-extset-toggle-row">
                            <div>
                                <div class="gcost-extset-title">말풍선 하단 비용 배지 표시</div>
                                <div class="gcost-extset-sub">꺼도 백그라운드 비용 계산과 지갑 차감은 계속 동작해요.</div>
                            </div>
                            <input id="gcost_ext_show_badges" type="checkbox" class="gcost-extset-chk" ${s.showBadges !== false ? "checked" : ""} />
                        </div>

                        <div class="gcost-extset-toggle-row">
                            <div class="gcost-extset-title">배지 표시 형식</div>
                            <div class="gcost-extset-unit-checks">
                                <label class="gcost-extset-unit-item">
                                    <input id="gcost_ext_unit_krw" type="checkbox" class="gcost-extset-chk" ${s.displayMode !== "usd" ? "checked" : ""} />
                                    <span>원화</span>
                                </label>
                                <label class="gcost-extset-unit-item">
                                    <input id="gcost_ext_unit_usd" type="checkbox" class="gcost-extset-chk" ${s.displayMode !== "krw" ? "checked" : ""} />
                                    <span>달러</span>
                                </label>
                            </div>
                        </div>

                        <div class="gcost-extset-toggle-row">
                            <div>
                                <div class="gcost-extset-title">캐시 풀 미스(0%) 실시간 알림</div>
                                <div class="gcost-extset-sub">임계값 이상 메인 호출에서 캐시가 0%일 때 토스트로 알려줘요.</div>
                            </div>
                            <input id="gcost_ext_notify_miss" type="checkbox" class="gcost-extset-chk" ${s.notifyCacheMiss ? "checked" : ""} />
                        </div>
                    </div>

                    <div class="gcost-extset-danger-row">
                        <button type="button" id="gcost_ext_reset_today" class="gcost-btn gcost-btn-xs">오늘 지출 초기화</button>
                        <button type="button" id="gcost_ext_reset_all" class="gcost-btn gcost-btn-xs">전체 통계 초기화</button>
                    </div>
                </div>
                <div class="gcost-modal-footer">
                    <button type="button" id="gcost_extset_close_btn" class="gcost-btn gcost-btn-primary">완료</button>
                </div>
            </div>
        </div>
    `);

    $("body").append(extModal);

    const closeExt = () => extModal.remove();
    let extOverlayMouseDown = false;
    extModal.find(".gcost-extset-close, #gcost_extset_close_btn").on("click", closeExt);
    extModal.on("mousedown", function (e) {
        extOverlayMouseDown = $(e.target).hasClass("gcost-extset-overlay");
    });
    extModal.on("click", function (e) {
        if (extOverlayMouseDown && $(e.target).hasClass("gcost-extset-overlay")) closeExt();
        extOverlayMouseDown = false;
    });

    const syncDrawerToggles = (cfg) => {
        $("#gcost_enabled").prop("checked", cfg.enabled);
        $("#gcost_show_badges").prop("checked", cfg.showBadges !== false);
        $("#gcost_intercept_fetch").prop("checked", cfg.interceptFetch);
        $("#gcost_auto_model_pricing").prop("checked", cfg.autoModelPricing);
        $("#gcost_auto_cache").prop("checked", cfg.autoCache);
        $("#gcost_display_mode").val(cfg.displayMode);
    };

    extModal.find("#gcost_ext_show_badges").on("change", function () {
        const checked = $(this).is(":checked");
        updateSettings({ showBadges: checked });
        syncDrawerToggles(getSettings());
        renderAllBadges();
        if (window.toastr) toastr.info(checked ? "말풍선 비용 배지를 표시합니다." : "말풍선 비용 배지를 숨겼습니다. (비용 추적은 계속 동작)");
    });

    const applyDisplayUnitChecks = (changedEl) => {
        const $krw = extModal.find("#gcost_ext_unit_krw");
        const $usd = extModal.find("#gcost_ext_unit_usd");
        let useKrw = $krw.is(":checked");
        let useUsd = $usd.is(":checked");
        if (!useKrw && !useUsd) {
            $(changedEl).prop("checked", true);
            useKrw = $krw.is(":checked");
            useUsd = $usd.is(":checked");
            if (window.toastr) toastr.info("원화 또는 달러 중 최소 하나는 선택되어 있어야 해요.");
        }
        const mode = (useKrw && useUsd) ? "both" : (useKrw ? "krw" : "usd");
        updateSettings({ displayMode: mode });
        syncDrawerToggles(getSettings());
        renderAllBadges();
    };

    extModal.find("#gcost_ext_unit_krw, #gcost_ext_unit_usd").on("change", function () {
        applyDisplayUnitChecks(this);
    });

    extModal.find("#gcost_ext_enabled").on("change", function () {
        updateSettings({ enabled: $(this).is(":checked") });
        syncDrawerToggles(getSettings());
        renderAllBadges();
    });

    extModal.find("#gcost_ext_notify_miss").on("change", function () {
        const checked = $(this).is(":checked");
        updateSettings({ notifyCacheMiss: checked });
        if (window.toastr) toastr.info(checked ? "캐시 풀 미스(0%) 실시간 알림을 켰습니다." : "캐시 풀 미스 알림을 껐습니다.");
    });

    extModal.find("#gcost_ext_reset_today").on("click", () => {
        if (!confirm("오늘의 지출 기록을 초기화할까요?")) return;
        const stats = loadDailyStats();
        delete stats[getTodayKey()];
        saveDailyStats(stats);
        notifiedBudgetFlags.clear();
        renderStatsUI();
        if (typeof onChanged === "function") onChanged();
        if (window.toastr) toastr.info("오늘 지출 기록을 초기화했습니다.");
    });

    extModal.find("#gcost_ext_reset_all").on("click", () => {
        if (!confirm("모든 날짜의 지출 기록과 호출 로그를 완전히 삭제할까요? (등록된 크레딧 지갑은 유지됩니다)")) return;
        localStorage.removeItem(STATS_STORAGE_KEY);
        localStorage.removeItem(RECENT_LOGS_KEY);
        notifiedBudgetFlags.clear();
        renderStatsUI();
        if (typeof onChanged === "function") onChanged();
        if (window.toastr) toastr.info("전체 지출 기록과 로그를 초기화했습니다.");
    });
}

function renderCombinedModal(settings, result, defaultTab, upToIndex = null, basePromptInfo = null, cacheRateInfo = null) {
    $(".gcost-modal-overlay").remove();

    const customLabel = (settings.customName || "").trim() || "직접 입력";
    const activePresetObj = findPresetByKey(settings.preset, settings);
    const activeShort = settings.preset === "custom"
        ? customLabel
        : (activePresetObj?.shortLabel || "직접 입력");
    let chatTabHtml = `<div class="gcost-empty-msg">현재 열려 있는 채팅 메시지가 없습니다.</div>`;
    let rangePill = "실시간 추적";

    if (result) {
        rangePill = result.maxIdx === chat.length - 1
            ? `전체 · AI ${result.aiTurnCount}턴`
            : `#${result.maxIdx}까지 · AI ${result.aiTurnCount}턴`;

        const compareEntries = Object.entries(PRESETS).map(([key, preset]) => ({
            key,
            label: preset.label,
            pricing: preset,
        }));

        const savedCustoms = Array.isArray(settings.customPresets) ? settings.customPresets : [];
        savedCustoms.forEach(c => {
            compareEntries.push({
                key: c.id,
                label: `${c.label} (커스텀)`,
                pricing: {
                    tierThreshold: c.tierThreshold ?? 200000,
                    inBase: c.inBase,
                    cacheBase: c.cacheBase,
                    outBase: c.outBase,
                    inHigh: c.inHigh ?? c.inBase,
                    cacheHigh: c.cacheHigh ?? c.cacheBase,
                    outHigh: c.outHigh ?? c.outBase,
                },
            });
        });

        if (settings.preset === "custom") {
            compareEntries.unshift({
                key: "custom",
                label: `${customLabel} (직접 입력)`,
                pricing: settings,
            });
        }

        const compareRows = compareEntries.map(({ key, label, pricing }) => {
            const isCustomRow = key === "custom" || key.startsWith("custom_");
            const rowMult = getRegionalMultiplier(settings, isCustomRow);
            let modelUsd = 0;
            result.turnRecords.forEach(t => {
                const { costUsd } = calcTurnCostUsd(
                    t.normalInput, t.cacheTokens, t.outTokens, t.thinkTokens, t.totalInput, pricing, rowMult
                );
                modelUsd += costUsd;
            });
            const modelKrw = Math.round(modelUsd * settings.exchangeRate).toLocaleString();
            const activeClass = settings.preset === key ? "gcost-active-row" : "";
            return `
                <div class="gcost-compare-row ${activeClass}">
                    <span class="gcost-model-name">${escapeHtml(label)}</span>
                    <span class="gcost-model-usd">$${modelUsd.toFixed(4)}</span>
                    <span class="gcost-model-krw">약 ${modelKrw}원</span>
                </div>
            `;
        }).join("");

        const thisTurn = result.turnRecords.length > 0
            ? result.turnRecords[result.turnRecords.length - 1]
            : null;
        const thisTurnKrw = thisTurn ? Math.round(thisTurn.costKrw).toLocaleString() : "0";
        const thisTurnUsd = thisTurn ? thisTurn.costUsd.toFixed(4) : "0.0000";
        const thisTurnOut = thisTurn ? (thisTurn.outTokens + (thisTurn.thinkTokens || 0)).toLocaleString() : "0";
        const thisTurnTitle = thisTurn ? `이번 턴 (#${thisTurn.index})` : "이번 턴 예상";

        // 고용량 구간(예: 200k) 단가 점프 임박/초과 경고 배너
        let tierWarnHtml = "";
        const hasHigherTier = (settings.inHigh > settings.inBase) || (settings.outHigh > settings.outBase);
        const threshold = Number(settings.tierThreshold) || 200000;
        if (hasHigherTier && threshold > 0) {
            const pct = Math.round((result.runningContext / threshold) * 100);
            if (result.runningContext > threshold) {
                tierWarnHtml = `<div class="gcost-tier-warn over">고용량 구간(${fmtK(threshold)}+) 진입 · 단가 상승 적용 중 (${fmtK(result.runningContext)}t)</div>`;
            } else if (pct >= 85) {
                tierWarnHtml = `<div class="gcost-tier-warn">고용량 구간(${fmtK(threshold)}) 임박 (${pct}%) · 요약 또는 새 채팅 권장</div>`;
            }
        }

        // 12월 1일 이후 Carbon/Argon 프로모션 프리셋이 선택돼 있으면 정상가 원클릭 전환 안내 배너
        let promoEndWarnHtml = "";
        if (getTodayKey() > "2026-11-30" && settings.preset === "gemini-4-carbon-promo") {
            promoEndWarnHtml = `
                <div class="gcost-tier-warn gcost-promo-warn">
                    <span>Carbon/Argon 프로모션(11/30)이 종료되었어요.</span>
                    <button type="button" id="gcost_switch_std_promo_btn" class="gcost-inline-auto-btn active">정상가로 전환</button>
                </div>
            `;
        }

        const rerollSub = result.sumRerollCount > 0
            ? ` · 리롤+${result.sumRerollCount}(${Math.round(result.sumRerollKrw).toLocaleString()}원)`
            : ` · ${settings.exchangeRate.toLocaleString()}원`;

        const measuredNote = result.measuredTurnCount > 0
            ? ` · 실측 ${result.measuredTurnCount}턴 반영`
            : "";

        chatTabHtml = `
            <div class="gcost-summary-cards gcost-cards-3">
                <div class="gcost-card gcost-card-highlight">
                    <div class="gcost-card-title">${thisTurnTitle}</div>
                    <div class="gcost-card-main">약 ${thisTurnKrw}원</div>
                    <div class="gcost-card-sub">$${thisTurnUsd} · 출력 ${thisTurnOut}t</div>
                </div>
                <div class="gcost-card">
                    <div class="gcost-card-title">누적 예상 (${activeShort})</div>
                    <div class="gcost-card-main">약 ${Math.round(result.sumKrw).toLocaleString()}원</div>
                    <div class="gcost-card-sub" title="환율 ${settings.exchangeRate.toLocaleString()}원${measuredNote}">$${result.sumUsd.toFixed(4)}${rerollSub}</div>
                </div>
                <div class="gcost-card" title="캐시 적중 시 약 ${Math.round(result.nextTurnKrw).toLocaleString()}원 ($${result.nextTurnUsd.toFixed(4)}) / 캐시 0% 실패 시 약 ${Math.round(result.nextTurnMissKrw).toLocaleString()}원 ($${result.nextTurnMissUsd.toFixed(4)}) · 평균 출력 ${result.nextAvgOut.toLocaleString()}t">
                    <div class="gcost-card-title">다음 1턴 예상</div>
                    <div class="gcost-card-main">약 ${Math.round(result.nextTurnKrw).toLocaleString()}원</div>
                    <div class="gcost-card-sub">미적중 시 약 ${Math.round(result.nextTurnMissKrw).toLocaleString()}원</div>
                </div>
            </div>

            ${promoEndWarnHtml}
            ${tierWarnHtml}

            <div class="gcost-meta-grid">
                <div class="gcost-meta-item" title="고정 프롬프트 ${(basePromptInfo?.tokens ?? settings.basePromptTokens).toLocaleString()}t (${escapeHtml(basePromptInfo?.detail || "설정값")})${result.contextCapped ? ` · 최대 컨텍스트(${fmtK(result.maxContextLimit)}t) 상한 적용됨` : ""}">
                    <span class="gcost-meta-label">현재 컨텍스트</span>
                    <span class="gcost-meta-val">${fmtK(result.runningContext)}t${result.contextCapped ? " (상한)" : ""}</span>
                </div>
                <div class="gcost-meta-item">
                    <span class="gcost-meta-label">캐시 적중률</span>
                    <span class="gcost-meta-val">${settings.cacheRate}%</span>
                </div>
                <div class="gcost-meta-item">
                    <span class="gcost-meta-label">누적 입력 (일반/캐시)</span>
                    <span class="gcost-meta-val">${fmtK(result.sumNormalIn)} / ${fmtK(result.sumCacheIn)}</span>
                </div>
                <div class="gcost-meta-item">
                    <span class="gcost-meta-label">누적 출력 (본문/생각)</span>
                    <span class="gcost-meta-val">${fmtK(result.sumOut)} / ${fmtK(result.sumThink)}</span>
                </div>
            </div>

            <div class="gcost-compare-header">
                <span class="gcost-compare-title">모델별 비용 비교</span>
                <span class="gcost-compare-note">이 작업은 AI를 호출하지 않아요</span>
            </div>
            <div class="gcost-compare-list">${compareRows}</div>
        `;
    }

    let modalLogFilter = "all";
    let modalLogLimit = 8;

    const liveTabHtml = buildLiveStatsHtml(modalLogFilter, modalLogLimit);
    const cacheTabHtml = buildCacheAnalysisHtml();
    const settingsTabHtml = buildModalSettingsHtml(settings, basePromptInfo, cacheRateInfo);
    const isChatTab = defaultTab === "chat";
    const isLiveTab = defaultTab === "live";
    const isCacheTab = defaultTab === "cache";
    const isSetTab = defaultTab === "settings";

    const errCount = loadErrorLogs().length;
    const diagBtnClass = errCount > 0 ? "gcost-diag-btn has-error" : "gcost-diag-btn";
    const diagBtnLabel = errCount > 0 ? `오류 확인 · ${errCount}` : "오류 확인";

    const modalHtml = $(`
        <div class="gcost-modal-overlay">
            <div class="gcost-modal">
                <div class="gcost-modal-header">
                    <div class="gcost-modal-title-wrap">
                        <h3>Gemini 비용 계산기</h3>
                        <span class="gcost-pill-tag">${rangePill}</span>
                    </div>
                    <div class="gcost-modal-header-right">
                        <button type="button" id="gcost_open_diag_btn" class="${diagBtnClass}" title="확장 오류 상태 확인 및 제보 리포트 복사">${diagBtnLabel}</button>
                        <button type="button" id="gcost_open_extset_btn" class="gcost-gear-btn" title="확장 설정 (배지 표시 · 추적 옵션)" aria-label="확장 설정"><i class="fa-solid fa-gear"></i></button>
                        <span class="gcost-modal-close" title="닫기">✕</span>
                    </div>
                </div>

                <div class="gcost-tabs">
                    <button type="button" class="gcost-tab-btn ${isChatTab ? "active" : ""}" data-tab="chat">현재 채팅</button>
                    <button type="button" class="gcost-tab-btn ${isLiveTab ? "active" : ""}" data-tab="live">전체 내역</button>
                    <button type="button" class="gcost-tab-btn ${isCacheTab ? "active" : ""}" data-tab="cache">캐싱 분석</button>
                    <button type="button" class="gcost-tab-btn ${isSetTab ? "active" : ""}" data-tab="settings">비용 설정</button>
                </div>

                <div class="gcost-modal-body">
                    <div class="gcost-tab-panel ${isChatTab ? "active" : ""}" data-panel="chat">
                        <div class="gcost-tab-desc">지금 열려 있는 이 채팅방의 예상·실측 비용과 모델별 비교를 계산해 드려요.</div>
                        ${chatTabHtml}
                    </div>
                    <div class="gcost-tab-panel ${isLiveTab ? "active" : ""}" data-panel="live">
                        <div class="gcost-tab-desc">메인 채팅과 모델·확장·부가기능을 포함한 실리태번 전체의 날짜별·월별 지출과 크레딧 잔액을 보여드려요.</div>
                        <div class="gcost-live-inner">${liveTabHtml}</div>
                    </div>
                    <div class="gcost-tab-panel ${isCacheTab ? "active" : ""}" data-panel="cache">
                        <div class="gcost-tab-desc">실측 메인 호출 기록을 바탕으로 호출 간격별 캐시 적중률과 절약 금액을 분석해 드려요.</div>
                        <div class="gcost-cache-inner">${cacheTabHtml}</div>
                    </div>
                    <div class="gcost-tab-panel ${isSetTab ? "active" : ""}" data-panel="settings">
                        <div class="gcost-tab-desc">크레딧 지갑, 환율, 모델 단가 프리셋, 예산 알림과 백업·복원을 관리할 수 있어요.</div>
                        ${settingsTabHtml}
                    </div>
                </div>

                <div class="gcost-modal-footer">
                    ${result ? `<button type="button" id="gcost_apply_badges_btn" class="gcost-btn gcost-btn-primary">배지 일괄 적용</button>` : ""}
                    <button type="button" id="gcost_close_modal_btn" class="gcost-btn">닫기</button>
                </div>
            </div>
        </div>
    `);

    $("body").append(modalHtml);

    const refreshLiveAndCachePanels = () => {
        modalHtml.find(".gcost-live-inner").html(buildLiveStatsHtml(modalLogFilter, modalLogLimit));
        modalHtml.find(".gcost-cache-inner").html(buildCacheAnalysisHtml());
    };

    // [v2.1.0] 크레딧 지갑 이벤트 (탭 2 드롭다운 전환, 충전, 잔액 보정, 탭 4 추가/선택/삭제)
    modalHtml.on("change", "#gcost_live_wallet_select", function () {
        const nextId = String($(this).val() || "");
        const wData = loadWallets();
        if (!nextId) {
            wData.activeId = "";
            wData.paused = true;
        } else {
            wData.activeId = nextId;
            wData.paused = false;
        }
        saveWallets(wData);
        const resolved = resolveTargetWalletWithReason(wData);
        if (nextId && resolved.wallet && resolved.wallet.id !== nextId && (resolved.matchedBy === "keyLabel" || resolved.matchedBy === "profile")) {
            if (window.toastr) {
                toastr.info(`현재 활성 키/프로필(${resolved.matchedName})이 [${resolved.wallet.name}]에 자동 매칭되어 있어요.`);
            }
        }
        renderStatsUI();
        modalHtml.find(".gcost-live-inner").html(buildLiveStatsHtml(modalLogFilter, modalLogLimit));
    });

    modalHtml.on("click", ".gcost-wallet-pick-btn", function () {
        const wId = String($(this).data("wallet-id") || "");
        if (!wId) return;
        const wData = loadWallets();
        if (wData.activeId === wId && !wData.paused) {
            wData.activeId = "";
            wData.paused = true;
        } else {
            wData.activeId = wId;
            wData.paused = false;
        }
        saveWallets(wData);
        renderStatsUI();
        openCostModal(upToIndex, "settings");
    });

    modalHtml.on("click", ".gcost-wallet-topup-btn", function () {
        const wId = String($(this).data("wallet-id") || "");
        const wData = loadWallets();
        const target = wData.items.find(w => w.id === wId);
        if (!target) return;
        const unit = target.currency === "KRW" ? "원" : "USD($)";
        const raw = prompt(`[${target.name}] 추가로 충전할 금액(${unit})을 입력해 주세요.`, "");
        if (raw === null) return;
        const add = parseFloat(raw);
        if (isNaN(add) || add <= 0) {
            if (window.toastr) toastr.warning("0보다 큰 숫자를 입력해 주세요.");
            return;
        }
        target.balance = (Number(target.balance) || 0) + add;
        target.initialAmount = Math.max(Number(target.initialAmount) || 0, target.balance);
        target.updatedAt = Date.now();
        notifiedWalletFlags.delete(`w0:${target.id}`);
        notifiedWalletFlags.delete(`w20:${target.id}`);
        saveWallets(wData);
        renderStatsUI();
        const activeTab = modalHtml.find(".gcost-tab-btn.active").data("tab") || "live";
        if (window.toastr) toastr.success(`[${target.name}] ${formatWalletAmount(add, target.currency)} 충전 완료`);
        openCostModal(upToIndex, activeTab);
    });

    modalHtml.on("click", ".gcost-wallet-sync-btn", function () {
        const wId = String($(this).data("wallet-id") || "");
        const wData = loadWallets();
        const target = wData.items.find(w => w.id === wId);
        if (!target) return;
        const unit = target.currency === "KRW" ? "원" : "USD($)";
        const curVal = target.currency === "KRW" ? Math.round(target.balance || 0) : Number((target.balance || 0).toFixed(2));
        const raw = prompt(`[${target.name}] 현재 실제 잔액(${unit})으로 보정할 금액을 입력해 주세요.`, String(curVal));
        if (raw === null) return;
        const nextBal = parseFloat(raw);
        if (isNaN(nextBal)) {
            if (window.toastr) toastr.warning("올바른 숫자를 입력해 주세요.");
            return;
        }
        target.balance = nextBal;
        if (nextBal > (Number(target.initialAmount) || 0)) target.initialAmount = nextBal;
        target.updatedAt = Date.now();
        if (nextBal > 0) notifiedWalletFlags.delete(`w0:${target.id}`);
        saveWallets(wData);
        renderStatsUI();
        const activeTab = modalHtml.find(".gcost-tab-btn.active").data("tab") || "live";
        if (window.toastr) toastr.success(`[${target.name}] 잔액을 ${formatWalletAmount(nextBal, target.currency)}으로 보정했습니다.`);
        openCostModal(upToIndex, activeTab);
    });

    modalHtml.on("click", "#gcost_w_toggle_form_btn", function () {
        const $form = modalHtml.find("#gcost_w_add_form");
        const isOpen = $form.is(":visible");
        if (isOpen) {
            $form.hide();
            $(this).addClass("active").text("+ 지갑 추가하기");
        } else {
            $form.show();
            $(this).removeClass("active").text("접기");
        }
    });

    modalHtml.on("click", "#gcost_w_fill_profile", () => {
        const $inp = modalHtml.find("#gcost_w_profile");
        const existing = parseWalletMatchNames($inp.val());
        const keyLabels = getActiveSecretLabels();
        // API 키 이름이 있으면 오직 현재 활성 API 키 이름만 깔끔하게 추가 (없을 때만 연결 프로필 폴백)
        const targetName = keyLabels.length > 0 ? keyLabels[0] : getActiveConnectionProfileName();
        if (targetName && !existing.some(e => e.toLowerCase() === targetName.toLowerCase())) {
            existing.push(targetName);
            $inp.val(existing.join(", "));
        }
    });

    modalHtml.on("click", ".gcost-wallet-keys-btn", function () {
        const wId = String($(this).data("wallet-id") || "");
        const wData = loadWallets();
        const target = wData.items.find(w => w.id === wId);
        if (!target) return;
        const curKey = getActiveSecretLabels()[0] || "";
        const hint = curKey ? `\n(현재 활성 API 키 이름: ${curKey})` : "";
        const raw = prompt(
            `[${target.name}]에 연결할 API 키 이름을 쉼표(,)로 입력해 주세요.${hint}`,
            target.profileName || ""
        );
        if (raw === null) return;
        const nextNames = parseWalletMatchNames(raw);
        const conflicts = findDuplicateWalletKeys(wData, nextNames, target.id);
        if (conflicts.length > 0) {
            const detail = conflicts.map(c => `'${c.keyName}' → [${c.walletName}]`).join("\n");
            const proceed = confirm(
                `아래 키 이름이 이미 다른 지갑에 연결되어 있어요:\n${detail}\n\n중복 등록 시 목록 위쪽 지갑이 우선 차감됩니다. 그래도 저장할까요?`
            );
            if (!proceed) return;
        }
        target.profileName = nextNames.join(", ");
        target.updatedAt = Date.now();
        saveWallets(wData);
        renderStatsUI();
        if (window.toastr) toastr.success(`[${target.name}] 키 이름 매칭을 저장했습니다.`);
        openCostModal(upToIndex, "settings");
    });

    modalHtml.on("click", "#gcost_w_add_btn", () => {
        const name = String(modalHtml.find("#gcost_w_name").val() || "").trim();
        const currency = modalHtml.find("#gcost_w_currency").val() === "KRW" ? "KRW" : "USD";
        const amount = parseFloat(modalHtml.find("#gcost_w_amount").val());
        const expiresAt = String(modalHtml.find("#gcost_w_expires").val() || "").trim();
        const profileNames = parseWalletMatchNames(modalHtml.find("#gcost_w_profile").val());

        if (!name) {
            if (window.toastr) toastr.warning("계정(지갑) 이름을 입력해 주세요.");
            return;
        }
        if (isNaN(amount) || amount < 0) {
            if (window.toastr) toastr.warning("초기 잔액을 0 이상의 숫자로 입력해 주세요.");
            return;
        }

        const wData = loadWallets();
        const conflicts = findDuplicateWalletKeys(wData, profileNames, "");
        if (conflicts.length > 0) {
            const detail = conflicts.map(c => `'${c.keyName}' → [${c.walletName}]`).join("\n");
            const proceed = confirm(
                `아래 키 이름이 이미 다른 지갑에 연결되어 있어요:\n${detail}\n\n중복 등록 시 목록 위쪽 지갑이 우선 차감됩니다. 그래도 추가할까요?`
            );
            if (!proceed) return;
        }

        const newId = `w_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
        wData.items.push({
            id: newId,
            name,
            currency,
            initialAmount: amount,
            balance: amount,
            expiresAt,
            profileName: profileNames.join(", "),
            updatedAt: Date.now(),
        });
        wData.activeId = newId;
        wData.paused = false;
        saveWallets(wData);
        renderStatsUI();
        if (window.toastr) toastr.success(`"${name}" 크레딧 지갑을 추가하고 활성화했습니다.`);
        openCostModal(upToIndex, "settings");
    });

    modalHtml.on("click", ".gcost-wallet-del-btn", function () {
        const wId = String($(this).data("wallet-id") || "");
        const wData = loadWallets();
        const target = wData.items.find(w => w.id === wId);
        if (!target) return;
        if (!confirm(`"${target.name}" 크레딧 지갑을 삭제할까요?`)) return;
        wData.items = wData.items.filter(w => w.id !== wId);
        if (wData.activeId === wId) {
            wData.activeId = wData.items[0]?.id || "";
        }
        saveWallets(wData);
        renderStatsUI();
        if (window.toastr) toastr.info(`"${target.name}" 지갑을 삭제했습니다.`);
        openCostModal(upToIndex, "settings");
    });

    modalHtml.find(".gcost-tab-btn").on("click", function () {
        const target = $(this).data("tab");
        modalHtml.find(".gcost-tab-btn").removeClass("active");
        $(this).addClass("active");
        modalHtml.find(".gcost-tab-panel").removeClass("active");
        modalHtml.find(`.gcost-tab-panel[data-panel="${target}"]`).addClass("active");
    });

    // 12월 1일 프로모션 종료 시 원클릭 정상가 전환 버튼
    modalHtml.on("click", "#gcost_switch_std_promo_btn", () => {
        const { label, shortLabel, ...stdPricing } = PRESETS["gemini-4-carbon-std"];
        updateSettings({ preset: "gemini-4-carbon-std", ...stdPricing });
        const updated = getSettings();
        syncDrawerPresetOptions(updated);
        $("#gcost_preset").val(updated.preset);
        $("#gcost_in_base").val(updated.inBase);
        $("#gcost_cache_base").val(updated.cacheBase);
        $("#gcost_out_base").val(updated.outBase);
        $("#gcost_in_high").val(updated.inHigh);
        $("#gcost_cache_high").val(updated.cacheHigh);
        $("#gcost_out_high").val(updated.outHigh);
        if (window.toastr) toastr.success("Carbon / Argon 정상가(12/1~) 프리셋으로 전환했습니다.");
        openCostModal(upToIndex, "chat");
    });

    // 탭 2 로그 필터 칩 & 더 보기 버튼 (위임 바인딩)
    modalHtml.on("click", ".gcost-filter-chip", function () {
        modalLogFilter = String($(this).data("filter") || "all");
        modalLogLimit = 8;
        modalHtml.find(".gcost-live-inner").html(buildLiveStatsHtml(modalLogFilter, modalLogLimit));
    });

    modalHtml.on("click", "#gcost_log_more_btn", () => {
        modalLogLimit += 15;
        modalHtml.find(".gcost-live-inner").html(buildLiveStatsHtml(modalLogFilter, modalLogLimit));
    });

    // 모달 내 설정 탭 이벤트 바인딩
    modalHtml.find(".gcost-rate-chip").on("click", function () {
        const rate = parseFloat($(this).data("rate"));
        modalHtml.find("#gcost_modal_exchange_rate").val(rate);
        modalHtml.find(".gcost-rate-chip").removeClass("active");
        $(this).addClass("active");
    });

    let modalAutoCacheRate = !!settings.autoCacheRate;
    let modalAutoBasePrompt = !!settings.autoBasePrompt;

    modalHtml.find("#gcost_modal_cache_rate").on("input", function () {
        modalAutoCacheRate = false;
        modalHtml.find("#gcost_modal_cache_val").text(`${$(this).val()}%`);
        modalHtml.find("#gcost_modal_auto_cache_btn").removeClass("active").text("자동 맞춤");
        modalHtml.find("#gcost_modal_cache_detail").text("수동 설정값").attr("title", "수동 설정값");
    });

    modalHtml.find("#gcost_modal_auto_cache_btn").on("click", function () {
        const est = estimateMeasuredCacheRate(settings.cacheRate);
        modalAutoCacheRate = true;
        modalHtml.find("#gcost_modal_cache_rate").val(est.rate);
        modalHtml.find("#gcost_modal_cache_val").text(`${est.rate}%`);
        modalHtml.find("#gcost_modal_cache_detail").text(est.detail).attr("title", `현재 기준: ${est.detail}`);
        $(this).addClass("active").text("자동").attr("title", `현재 기준: ${est.detail}`);
        if (window.toastr) {
            toastr.info(`추정 캐시 적중률 ${est.rate}% (${est.detail})`);
        }
    });

    modalHtml.find("#gcost_modal_base_prompt").on("input", function () {
        modalAutoBasePrompt = false;
        modalHtml.find("#gcost_modal_auto_base_btn").removeClass("active").text("자동 측정");
        modalHtml.find("#gcost_modal_base_detail").text("수동 입력값").attr("title", "수동 입력값");
    });

    modalHtml.find("#gcost_modal_auto_base_btn").on("click", async function () {
        const $btn = $(this);
        $btn.text("측정 중…");
        const est = await estimateBasePromptTokens(upToIndex);
        modalAutoBasePrompt = true;
        modalHtml.find("#gcost_modal_base_prompt").val(est.tokens).attr("title", `현재 산출: ${est.detail}`);
        modalHtml.find("#gcost_modal_base_detail").text(est.detail).attr("title", `현재 산출: ${est.detail}`);
        $btn.addClass("active").text("자동").attr("title", `현재 산출: ${est.detail}`);
        if (window.toastr) {
            toastr.info(`고정 프롬프트 ${est.tokens.toLocaleString()}t (${est.detail})`);
        }
    });

    // 탭 2 최근 로그 행 터치/클릭 시 상세 토큰 내역 표시 (모바일 호버 불가 대응)
    modalHtml.on("click", ".gcost-log-row", function (e) {
        if ($(e.target).closest(".gcost-log-del-btn").length) return;
        const tip = $(this).attr("title");
        if (tip && window.toastr) {
            toastr.info(tip.replace(/\n/g, " · "), "호출 상세", { timeOut: 4000 });
        }
    });

    // 탭 2 최근 로그 개별 삭제 이벤트 (위임 바인딩)
    modalHtml.on("click", ".gcost-log-del-btn", function () {
        const idx = parseInt($(this).data("log-idx"), 10);
        if (isNaN(idx)) return;
        if (!confirm("이 호출 로그를 삭제하고 해당 날짜 통계에서도 차감할까요?")) return;
        if (deleteRecentLogByIndex(idx)) {
            refreshLiveAndCachePanels();
            if (window.toastr) toastr.info("로그를 삭제하고 통계를 갱신했습니다.");
        }
    });

    // 직접 입력(Custom) 프리셋 선택 시 커스텀 단가 입력 박스 토글
    modalHtml.find("#gcost_modal_preset").on("change", function () {
        const val = $(this).val();
        if (val === "custom") {
            modalHtml.find("#gcost_modal_custom_box").show();
        } else {
            modalHtml.find("#gcost_modal_custom_box").hide();
            const found = findPresetByKey(val, getSettings());
            if (found) {
                modalHtml.find("#gcost_modal_in_base").val(found.inBase);
                modalHtml.find("#gcost_modal_cache_base").val(found.cacheBase);
                modalHtml.find("#gcost_modal_out_base").val(found.outBase);
            }
        }
    });

    // 커스텀 프리셋 목록에 추가 버튼
    modalHtml.find("#gcost_modal_add_custom_btn").on("click", () => {
        const cName = String(modalHtml.find("#gcost_modal_custom_name").val() || "").trim();
        const cIn = parseFloat(modalHtml.find("#gcost_modal_in_base").val());
        const cCache = parseFloat(modalHtml.find("#gcost_modal_cache_base").val());
        const cOut = parseFloat(modalHtml.find("#gcost_modal_out_base").val());

        if (!cName) {
            if (window.toastr) toastr.warning("단가 이름을 입력해 주세요.");
            return;
        }
        if (isNaN(cIn) || cIn < 0 || isNaN(cCache) || cCache < 0 || isNaN(cOut) || cOut < 0) {
            if (window.toastr) toastr.warning("입력·캐시·출력 단가를 0 이상의 숫자로 입력해 주세요.");
            return;
        }

        const cur = getSettings();
        const list = Array.isArray(cur.customPresets) ? [...cur.customPresets] : [];
        const newId = `custom_${Date.now()}`;
        list.push({
            id: newId,
            label: cName,
            tierThreshold: 200000,
            inBase: cIn,
            cacheBase: cCache,
            outBase: cOut,
            inHigh: cIn,
            cacheHigh: cCache,
            outHigh: cOut,
        });

        updateSettings({
            customPresets: list,
            preset: newId,
            customName: cName,
            inBase: cIn, cacheBase: cCache, outBase: cOut,
            inHigh: cIn, cacheHigh: cCache, outHigh: cOut,
        });
        syncDrawerPresetOptions(getSettings());

        if (window.toastr) toastr.success(`"${cName}" 커스텀 프리셋을 추가했습니다.`);
        openCostModal(upToIndex, "settings");
    });

    // 저장된 커스텀 프리셋 삭제 버튼
    modalHtml.on("click", ".gcost-custom-del-btn", function () {
        const delId = String($(this).data("custom-id") || "");
        if (!delId) return;
        const cur = getSettings();
        const target = (cur.customPresets || []).find(c => c.id === delId);
        if (!confirm(`"${target?.label || "커스텀"}" 프리셋을 삭제할까요?`)) return;

        const nextList = (cur.customPresets || []).filter(c => c.id !== delId);
        const patch = { customPresets: nextList };
        if (cur.preset === delId) {
            const defKey = getDefaultPresetKey();
            const { label, shortLabel, ...pricing } = PRESETS[defKey];
            Object.assign(patch, { preset: defKey, ...pricing });
        }
        updateSettings(patch);
        syncDrawerPresetOptions(getSettings());
        if (window.toastr) toastr.info("커스텀 프리셋을 삭제했습니다.");
        openCostModal(upToIndex, "settings");
    });

    // 모달 내 설정 탭 백업 / 복원
    modalHtml.find("#gcost_modal_export_btn").on("click", () => exportCostData());
    modalHtml.find("#gcost_modal_import_btn").on("click", () => {
        triggerImportCostData(() => {
            openCostModal(upToIndex, "settings");
        });
    });

    modalHtml.find("#gcost_modal_save_recalc").on("click", () => {
        const newRate = parseFloat(modalHtml.find("#gcost_modal_exchange_rate").val());
        const newPreset = modalHtml.find("#gcost_modal_preset").val();
        const newCache = parseInt(modalHtml.find("#gcost_modal_cache_rate").val(), 10);
        const newBasePrompt = parseInt(modalHtml.find("#gcost_modal_base_prompt").val(), 10);
        const newDailyBudget = parseInt(modalHtml.find("#gcost_modal_daily_budget").val(), 10);
        const newMonthlyBudget = parseInt(modalHtml.find("#gcost_modal_monthly_budget").val(), 10);
        const newVertexRegional = modalHtml.find("#gcost_modal_vertex_regional").is(":checked");

        const patch = {
            autoBasePrompt: modalAutoBasePrompt,
            autoCacheRate: modalAutoCacheRate,
            vertexRegionalMarkup: newVertexRegional,
        };
        if (!isNaN(newRate) && newRate > 0) patch.exchangeRate = newRate;
        if (!isNaN(newCache)) patch.cacheRate = newCache;
        if (!isNaN(newBasePrompt) && newBasePrompt >= 0) patch.basePromptTokens = newBasePrompt;
        if (!isNaN(newDailyBudget) && newDailyBudget >= 0) patch.dailyBudgetKrw = newDailyBudget;
        if (!isNaN(newMonthlyBudget) && newMonthlyBudget >= 0) patch.monthlyBudgetKrw = newMonthlyBudget;

        const matchedPreset = findPresetByKey(newPreset, getSettings());
        if (newPreset && matchedPreset) {
            const { label, shortLabel, isCustom, ...pricing } = matchedPreset;
            Object.assign(patch, { preset: newPreset, ...pricing });
        } else if (newPreset === "custom") {
            const cName = String(modalHtml.find("#gcost_modal_custom_name").val() || "").trim() || "직접 입력";
            const cIn = parseFloat(modalHtml.find("#gcost_modal_in_base").val());
            const cCache = parseFloat(modalHtml.find("#gcost_modal_cache_base").val());
            const cOut = parseFloat(modalHtml.find("#gcost_modal_out_base").val());
            patch.preset = "custom";
            patch.customName = cName;
            if (!isNaN(cIn) && cIn >= 0) { patch.inBase = cIn; patch.inHigh = cIn; }
            if (!isNaN(cCache) && cCache >= 0) { patch.cacheBase = cCache; patch.cacheHigh = cCache; }
            if (!isNaN(cOut) && cOut >= 0) { patch.outBase = cOut; patch.outHigh = cOut; }
        }

        updateSettings(patch);

        // 확장 설정 패널 UI도 함께 동기화
        const updated = getSettings();
        syncDrawerPresetOptions(updated);
        $("#gcost_exchange_rate").val(updated.exchangeRate);
        $("#gcost_preset").val(updated.preset);
        $("#gcost_in_base").val(updated.inBase);
        $("#gcost_cache_base").val(updated.cacheBase);
        $("#gcost_out_base").val(updated.outBase);
        $("#gcost_in_high").val(updated.inHigh);
        $("#gcost_cache_high").val(updated.cacheHigh);
        $("#gcost_out_high").val(updated.outHigh);
        $("#gcost_cache_rate").val(updated.cacheRate);
        $("#gcost_cache_rate_val").text(updated.cacheRate);
        $("#gcost_auto_base_prompt").prop("checked", updated.autoBasePrompt);
        $("#gcost_base_prompt_tokens").val(updated.basePromptTokens);
        $("#gcost_daily_budget").val(updated.dailyBudgetKrw || 0);
        $("#gcost_monthly_budget").val(updated.monthlyBudgetKrw || 0);

        renderAllBadges();
        if (window.toastr) toastr.success(`환율 ${updated.exchangeRate.toLocaleString()}원으로 저장하고 다시 계산했습니다.`);
        openCostModal(upToIndex, "chat");
    });

    const closeModal = () => modalHtml.remove();
    let modalOverlayMouseDown = false;
    modalHtml.find("#gcost_open_diag_btn").on("click", () => openDiagnosticModal());
    modalHtml.find("#gcost_open_extset_btn").on("click", () => openExtensionSettingsModal(() => refreshLiveAndCachePanels()));
    modalHtml.find(".gcost-modal-close, #gcost_close_modal_btn").on("click", closeModal);
    modalHtml.on("mousedown", function (e) {
        modalOverlayMouseDown = $(e.target).hasClass("gcost-modal-overlay");
    });
    modalHtml.on("click", function (e) {
        if (modalOverlayMouseDown && $(e.target).hasClass("gcost-modal-overlay")) closeModal();
        modalOverlayMouseDown = false;
    });

    if (result) {
        modalHtml.find("#gcost_apply_badges_btn").on("click", async () => {
            let appliedCount = 0;
            let preservedCount = 0;
            result.turnRecords.forEach(t => {
                const msg = chat[t.index];
                if (!msg) return;
                if (!msg.extra) msg.extra = {};
                const prev = msg.extra.gemini_cost;
                // 이미 API 실측(isEstimated === false)으로 정확히 기록된 말풍선 배지는 덮어쓰지 않고 보존
                if (prev && prev.isEstimated === false && prev.totalInput > 0) {
                    preservedCount += 1;
                    return;
                }
                appliedCount += 1;
                msg.extra.gemini_cost = {
                    category: "main",
                    modelLabel: activeShort,
                    normalInput: t.normalInput,
                    cacheTokens: t.cacheTokens,
                    outTokens: t.outTokens,
                    thinkTokens: t.thinkTokens,
                    totalInput: t.totalInput,
                    isHighTier: t.isHighTier,
                    isEstimated: true,
                    costUsd: t.costUsd,
                    costKrw: t.costKrw,
                    exchangeRate: settings.exchangeRate,
                    ...(prev?.rerollCount > 0 ? {
                        rerollCount: prev.rerollCount,
                        rerollExtraUsd: prev.rerollExtraUsd || 0,
                        rerollExtraKrw: prev.rerollExtraKrw || 0,
                    } : {}),
                };
            });
            await saveChatConditional();
            renderAllBadges();
            if (window.toastr) {
                const msgText = preservedCount > 0
                    ? `과거 ${appliedCount}개 말풍선에 적용했습니다. (API 실측 ${preservedCount}개 보존)`
                    : `채팅 말풍선 ${appliedCount}개에 비용 배지를 일괄 적용했습니다.`;
                toastr.success(msgText);
            }
            closeModal();
        });
    }
}

function formatCost(usd, krw, mode) {
    const krwStr = `${Math.round(krw).toLocaleString()}원`;
    const usdStr = `$${usd.toFixed(4)}`;
    if (mode === "krw") return krwStr;
    if (mode === "usd") return usdStr;
    return `${krwStr} (${usdStr})`;
}

function renderAllBadges() {
    const settings = getSettings();
    const chatEl = document.getElementById("chat");
    const wasNearBottom = chatEl
        ? (chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight) < 80
        : false;

    $(".gcost-badge").remove();
    if (!settings.enabled || settings.showBadges === false) return;

    let cumulativeUsd = 0;
    let cumulativeKrw = 0;

    chat.forEach((msg, index) => {
        const info = msg?.extra?.gemini_cost;
        if (!info) return;

        const rerollCount = info.rerollCount || 0;
        const rerollExtraUsd = info.rerollExtraUsd || 0;
        const rerollExtraKrw = info.rerollExtraKrw || 0;
        const turnTotalUsd = info.costUsd + rerollExtraUsd;
        const turnTotalKrw = info.costKrw + rerollExtraKrw;

        cumulativeUsd += turnTotalUsd;
        cumulativeKrw += turnTotalKrw;

        const mesEl = $(`#chat .mes[mesid="${index}"] .mes_block`);
        if (!mesEl.length) return;

        const turnText = formatCost(info.costUsd, info.costKrw, settings.displayMode);
        const totalText = formatCost(cumulativeUsd, cumulativeKrw, settings.displayMode);
        const modelTag = info.modelLabel ? `<span class="gcost-model-pill">${escapeHtml(info.modelLabel)}</span>` : "";
        const rerollTag = rerollCount > 0
            ? `<span class="gcost-reroll-tag" title="리롤/재생성 ${rerollCount}회 추가 (이 턴 총 ${Math.round(turnTotalKrw).toLocaleString()}원)">리롤+${rerollCount} · ${Math.round(turnTotalKrw).toLocaleString()}원</span>`
            : "";
        const tierTag = info.isHighTier ? `<span class="gcost-tier-tag">200k+</span>` : "";
        const estPrefix = info.isEstimated ? "약 " : "";

        const tooltipLines = [
            `[모델] ${info.modelLabel || "기본"}`,
            `[입력] 총 ${info.totalInput.toLocaleString()} (캐시 ${info.cacheTokens.toLocaleString()} / 일반 ${info.normalInput.toLocaleString()})`,
            `[출력] ${info.outTokens.toLocaleString()} (생각 ${(info.thinkTokens || 0).toLocaleString()} 포함)`,
            `[기준] ${info.isEstimated ? "추정치" : "API 실측"} | 환율 ${info.exchangeRate}원`,
        ];
        if (rerollCount > 0) {
            tooltipLines.push(`[리롤] ${rerollCount}회 숨은 비용 +${Math.round(rerollExtraKrw).toLocaleString()}원 (이 턴 총 ${Math.round(turnTotalKrw).toLocaleString()}원)`);
        }
        tooltipLines.push("클릭하면 비용 계산기를 열어요");

        const badge = $(`
            <div class="gcost-badge" role="button" tabindex="0" title="${escapeHtml(tooltipLines.join("\n"))}">
                ${modelTag}
                <span>${estPrefix}${turnText}</span>
                ${rerollTag}
                <span class="gcost-sep">·</span>
                <span>누적 ${totalText}</span>
                ${tierTag}
            </div>
        `);

        badge.on("click", (e) => {
            e.stopPropagation();
            openCostModal(index, "chat");
        });

        mesEl.append(badge);
    });

    // 배지 추가 직전 스크롤이 바닥 근처에 있었다면, 늘어난 배지 높이만큼 바닥 위치를 유지 (위로 밀림 방지)
    if (wasNearBottom && chatEl) {
        chatEl.scrollTop = chatEl.scrollHeight;
    }
}

function closeExtraMesButtons($mes, $extraBtns, $btn) {
    try {
        if ($btn && $btn.length) $btn[0].blur();
        if (document.activeElement && document.activeElement !== document.body && typeof document.activeElement.blur === "function") {
            document.activeElement.blur();
        }

        const el = $extraBtns[0];
        const $hint = $mes.find(".extraMesButtonsHint");

        const isStillVisible = () => {
            if (!el) return false;
            const st = window.getComputedStyle(el);
            return st.display !== "none" && st.visibility !== "hidden" && parseFloat(st.opacity) > 0;
        };

        if (!isStillVisible()) return;

        // 1. HTML Popover API / Tippy 대응
        if (typeof el.hidePopover === "function") {
            try { el.hidePopover(); } catch { /* ignore */ }
        }
        if (el._tippy) {
            try { el._tippy.hide(); } catch { /* ignore */ }
        }
        if ($hint[0]?._tippy) {
            try { $hint[0]._tippy.hide(); } catch { /* ignore */ }
        }

        // 2. 바깥쪽 클릭 + ESC 키 이벤트로 테마 팝오버 닫기 (모달 열기 전 실행)
        if (isStillVisible()) {
            const evtInit = { bubbles: true, cancelable: true, view: window };
            try { document.body.dispatchEvent(new PointerEvent("pointerdown", evtInit)); } catch { /* ignore */ }
            document.body.dispatchEvent(new MouseEvent("mousedown", evtInit));
            document.body.dispatchEvent(new MouseEvent("mouseup", evtInit));
            document.body.dispatchEvent(new MouseEvent("click", evtInit));
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
        }

        // 3. 클래스 제거 및 표준 ST 토글 폴백
        if (isStillVisible()) {
            $extraBtns.removeClass("visible open active show expanded is-open");
            $mes.removeClass("extraMesButtonsOpen");
        }
        if (isStillVisible() && $hint.length) {
            $hint[0].click();
        }
        if (isStillVisible()) {
            $extraBtns.hide();
        }
    } catch { /* ignore */ }
}

function injectMessageMoreButtons() {
    $("#chat .mes").each(function () {
        const $mes = $(this);
        const $extraBtns = $mes.find(".extraMesButtons");
        if (!$extraBtns.length || $extraBtns.find(".gcost_mes_calc_btn").length) return;

        const mesId = parseInt($mes.attr("mesid"), 10);
        const $btn = $(`
            <div title="여기까지 채팅 비용 즉시 계산 (AI 호출 없음)"
                 class="mes_button gcost_mes_calc_btn fa-solid fa-coins interactable"
                 tabindex="0"></div>
        `);

        $btn.on("click", () => {
            // 원래 클릭 이벤트가 테마/ST의 메뉴 닫기 리스너로 정상 전파되도록 stopPropagation을 제거하고,
            // 한 틱 뒤에 팝업이 아직 열려 있으면 모든 방식으로 확실히 닫은 뒤 모달을 염
            setTimeout(() => {
                closeExtraMesButtons($mes, $extraBtns, $btn);
                openCostModal(isNaN(mesId) ? null : mesId, "chat");
            }, 0);
        });

        $extraBtns.append($btn);
    });
}

function injectChatMenuButtons() {
    const $optionsContent = $("#options .options-content");
    if ($optionsContent.length && !$("#gcost_option_calc").length) {
        const $optItem = $(`
            <a id="gcost_option_calc" title="채팅 비용 즉시 계산 및 모델·부가기능 사용량 확인">
                <i class="fa-lg fa-solid fa-coins"></i>
                <span>채팅 비용 · 사용량 계산</span>
            </a>
        `);
        $optItem.on("click", () => {
            $("#options").hide();
            openCostModal(null, "chat");
        });
        $optionsContent.append($optItem);
    }

    const $extMenu = $("#extensionsMenu");
    if ($extMenu.length && !$("#gcost_ext_menu_calc").length) {
        const $extItem = $(`
            <div id="gcost_ext_menu_calc" class="list-group-item flex-container flexGap5" title="채팅 비용 즉시 계산 및 모델·부가기능 사용량 확인">
                <div class="fa-solid fa-coins extensionsMenuExtensionButton"></div>
                <span>채팅 비용 · 사용량 계산</span>
            </div>
        `);
        $extItem.on("click", () => {
            $("#extensionsMenu").hide();
            openCostModal(null, "chat");
        });
        $extMenu.append($extItem);
    }
}

function syncDrawerPresetOptions(cfg) {
    const $sel = $("#gcost_preset");
    if (!$sel.length) return;
    const customs = Array.isArray(cfg?.customPresets) ? cfg.customPresets : [];
    const optionsHtml = Object.entries(PRESETS).map(([key, p]) =>
        `<option value="${key}">${escapeHtml(p.label)}</option>`
    ).join("")
        + customs.map(c =>
            `<option value="${escapeHtml(c.id)}">${escapeHtml(c.label)} (커스텀)</option>`
        ).join("")
        + `<option value="custom">직접 입력 (Custom)</option>`;
    $sel.html(optionsHtml);
    $sel.val(cfg?.preset || "gemini-4-carbon-promo");
}

function bindSettingsUI() {
    const s = getSettings();

    const syncInputs = (cfg) => {
        $("#gcost_enabled").prop("checked", cfg.enabled);
        $("#gcost_show_badges").prop("checked", cfg.showBadges !== false);
        $("#gcost_intercept_fetch").prop("checked", cfg.interceptFetch);
        $("#gcost_auto_model_pricing").prop("checked", cfg.autoModelPricing);
        syncDrawerPresetOptions(cfg);
        $("#gcost_tier_threshold").val(cfg.tierThreshold);
        $("#gcost_in_base").val(cfg.inBase);
        $("#gcost_cache_base").val(cfg.cacheBase);
        $("#gcost_out_base").val(cfg.outBase);
        $("#gcost_in_high").val(cfg.inHigh);
        $("#gcost_cache_high").val(cfg.cacheHigh);
        $("#gcost_out_high").val(cfg.outHigh);
        $("#gcost_auto_cache").prop("checked", cfg.autoCache);
        $("#gcost_cache_rate").val(cfg.cacheRate);
        $("#gcost_cache_rate_val").text(cfg.cacheRate);
        $("#gcost_auto_base_prompt").prop("checked", cfg.autoBasePrompt);
        $("#gcost_base_prompt_tokens").val(cfg.basePromptTokens);
        $("#gcost_exchange_rate").val(cfg.exchangeRate);
        $("#gcost_daily_budget").val(cfg.dailyBudgetKrw || 0);
        $("#gcost_monthly_budget").val(cfg.monthlyBudgetKrw || 0);
        $("#gcost_display_mode").val(cfg.displayMode);
    };

    syncInputs(s);

    $("#gcost_calc_now_btn").on("click", () => openCostModal(null, "chat"));
    $("#gcost_open_live_btn").on("click", () => openCostModal(null, "live"));

    $("#gcost_enabled").on("change", function () {
        updateSettings({ enabled: $(this).is(":checked") });
        renderAllBadges();
    });

    $("#gcost_show_badges").on("change", function () {
        updateSettings({ showBadges: $(this).is(":checked") });
        renderAllBadges();
    });

    $("#gcost_intercept_fetch").on("change", function () {
        updateSettings({ interceptFetch: $(this).is(":checked") });
    });

    $("#gcost_auto_model_pricing").on("change", function () {
        updateSettings({ autoModelPricing: $(this).is(":checked") });
    });

    $("#gcost_preset").on("change", function () {
        const val = $(this).val();
        const found = findPresetByKey(val, getSettings());
        if (found) {
            const { label, shortLabel, isCustom, ...pricing } = found;
            updateSettings({ preset: val, ...pricing });
            syncInputs(getSettings());
        } else {
            updateSettings({ preset: "custom" });
        }
    });

    const numFields = [
        ["#gcost_tier_threshold", "tierThreshold"],
        ["#gcost_in_base", "inBase"],
        ["#gcost_cache_base", "cacheBase"],
        ["#gcost_out_base", "outBase"],
        ["#gcost_in_high", "inHigh"],
        ["#gcost_cache_high", "cacheHigh"],
        ["#gcost_out_high", "outHigh"],
        ["#gcost_base_prompt_tokens", "basePromptTokens"],
        ["#gcost_exchange_rate", "exchangeRate"],
        ["#gcost_daily_budget", "dailyBudgetKrw"],
        ["#gcost_monthly_budget", "monthlyBudgetKrw"],
    ];

    numFields.forEach(([selector, key]) => {
        $(selector).on("input", function () {
            const num = parseFloat($(this).val());
            if (!isNaN(num)) {
                const isPriceField = !["basePromptTokens", "exchangeRate", "dailyBudgetKrw", "monthlyBudgetKrw"].includes(key);
                const patch = isPriceField
                    ? { [key]: num, preset: "custom" }
                    : (key === "basePromptTokens" ? { [key]: num, autoBasePrompt: false } : { [key]: num });
                updateSettings(patch);
                if (isPriceField) $("#gcost_preset").val("custom");
                if (key === "basePromptTokens") $("#gcost_auto_base_prompt").prop("checked", false);
            }
        });
    });

    $("#gcost_auto_cache").on("change", function () {
        updateSettings({ autoCache: $(this).is(":checked") });
    });

    $("#gcost_auto_base_prompt").on("change", async function () {
        const checked = $(this).is(":checked");
        updateSettings({ autoBasePrompt: checked });
        if (checked) {
            const est = await estimateBasePromptTokens(null);
            if (est.source !== "manual") {
                updateSettings({ basePromptTokens: est.tokens });
                $("#gcost_base_prompt_tokens").val(est.tokens);
            }
        }
    });

    $("#gcost_cache_rate").on("input", function () {
        const val = parseInt($(this).val(), 10);
        $("#gcost_cache_rate_val").text(val);
        updateSettings({ cacheRate: val, autoCacheRate: false });
    });

    $("#gcost_display_mode").on("change", function () {
        updateSettings({ displayMode: $(this).val() });
        renderAllBadges();
    });

    $("#gcost_export_btn").on("click", () => exportCostData());
    $("#gcost_import_btn").on("click", () => triggerImportCostData());

    $("#gcost_reset_today").on("click", function () {
        if (!confirm("오늘의 지출 기록을 초기화할까요?")) return;
        const stats = loadDailyStats();
        delete stats[getTodayKey()];
        saveDailyStats(stats);
        notifiedBudgetFlags.clear();
        renderStatsUI();
    });

    $("#gcost_reset_all").on("click", function () {
        if (!confirm("모든 날짜의 지출 기록과 호출 로그를 완전히 삭제할까요?")) return;
        localStorage.removeItem(STATS_STORAGE_KEY);
        localStorage.removeItem(RECENT_LOGS_KEY);
        notifiedBudgetFlags.clear();
        renderStatsUI();
    });

    renderStatsUI();
}

jQuery(async () => {
    try {
        installFetchInterceptor();

        const settingsHtml = await $.get(SETTINGS_HTML_URL);
        $("#extensions_settings").append(settingsHtml);
        bindSettingsUI();
        injectChatMenuButtons();
        injectMessageMoreButtons();

        const chatEl = document.getElementById("chat");
        if (chatEl) {
            let injectTimer = null;
            const observer = new MutationObserver(() => {
                if (injectTimer) clearTimeout(injectTimer);
                injectTimer = setTimeout(() => {
                    injectTimer = null;
                    injectMessageMoreButtons();
                }, 100);
            });
            observer.observe(chatEl, { childList: true });
        }

        // ESC 키로 최상단 모달(오류 확인 창 → 메인 모달 순) 닫기
        if (!window.__gcostEscBound) {
            window.__gcostEscBound = true;
            document.addEventListener("keydown", (e) => {
                if (e.key !== "Escape") return;
                const $extSet = $(".gcost-extset-overlay");
                if ($extSet.length) {
                    $extSet.remove();
                    return;
                }
                const $diag = $(".gcost-diag-overlay");
                if ($diag.length) {
                    $diag.remove();
                    return;
                }
                const $main = $(".gcost-modal-overlay");
                if ($main.length) {
                    $main.remove();
                }
            });
        }

        eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
        eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
        eventSource.on(event_types.CHAT_CHANGED, () => {
            setTimeout(() => {
                renderAllBadges();
                injectMessageMoreButtons();
                injectChatMenuButtons();
            }, 300);
        });
        eventSource.on(event_types.MESSAGE_SWIPED, () => setTimeout(renderAllBadges, 100));

        renderAllBadges();
        resolveErrorCode("GCOST-INIT");
        console.log(`[Gemini Cost Calculator v${EXT_VERSION}] 로드 완료`);
    } catch (err) {
        recordErrorLog("GCOST-INIT", "확장 초기화", err);
        console.error("[Gemini Cost Calculator] 초기화 실패:", err);
    }
});
