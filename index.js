import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types, chat, saveChatConditional } from "../../../../script.js";
import { getTokenCountAsync } from "../../../tokenizers.js";

const MODULE_NAME = "gemini_cost_calculator";
const EXT_VERSION = "1.0.0";
const SETTINGS_HTML_URL = new URL("./settings.html", import.meta.url).href;
const STATS_STORAGE_KEY = "gemini_cost_daily_stats_v2";
const RECENT_LOGS_KEY = "gemini_cost_recent_logs_v2";
const ERROR_LOGS_KEY = "gemini_cost_error_logs_v1";

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
    interceptFetch: true,
    autoModelPricing: true,
    preset: "gemini-4-carbon-promo",
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
    { ext: "perf-assist" },
    { ext: "request-log" },
];

let lastPromptTokens = 0;
let lastMainPromptAt = 0;
let lastCapturedMainRecord = null;
const notifiedBudgetFlags = new Set();

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
    localStorage.setItem(RECENT_LOGS_KEY, JSON.stringify(logs.slice(0, 40)));
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
            context: String(context || ""),
            message: message.slice(0, 300),
            stack: stack.slice(0, 500),
        });
        saveErrorLogs(logs);
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

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
    }
    const merged = Object.assign({}, DEFAULT_SETTINGS, extension_settings[MODULE_NAME]);
    if (merged.preset !== "custom" && !PRESETS[merged.preset]) {
        const { label, shortLabel, ...pricing } = PRESETS["gemini-4-carbon-promo"];
        Object.assign(merged, { preset: "gemini-4-carbon-promo", ...pricing });
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

    const fallbackLabel = raw || PRESETS[settings.preset]?.shortLabel || "Custom";
    return {
        key: settings.preset || "custom",
        shortLabel: fallbackLabel.length > 22 ? fallbackLabel.slice(0, 22) + "…" : fallbackLabel,
        pricing: settings,
        matched: false,
    };
}

function calcTurnCostUsd(normalInput, cacheTokens, outTokens, thinkTokens, totalInput, pricing) {
    const isHighTier = totalInput > pricing.tierThreshold;
    const pIn = isHighTier ? pricing.inHigh : pricing.inBase;
    const pCache = isHighTier ? pricing.cacheHigh : pricing.cacheBase;
    const pOut = isHighTier ? pricing.outHigh : pricing.outBase;

    const costUsd = ((normalInput * pIn) + (cacheTokens * pCache) + ((outTokens + thinkTokens) * pOut)) / 1_000_000;
    return { costUsd, isHighTier };
}

/**
 * 일별·월별 통계 기록 (카테고리별 + 모델별 + 호출 출처별 분리 집계)
 */
function recordApiUsage({ category, caller, callerLabel, modelKey, modelLabel, costUsd, costKrw, normalInput, cacheTokens, outTokens, thinkTokens, isEstimated }) {
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

    const logs = loadRecentLogs();
    logs.unshift({
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        date: today,
        time: getTimeStr(),
        category,
        caller: caller || category,
        callerLabel: cKey,
        modelLabel: mKey,
        costUsd,
        costKrw,
        totalInput: normalInput + cacheTokens,
        cacheTokens,
        outTokens,
        thinkTokens,
        isEstimated,
    });
    saveRecentLogs(logs);

    renderStatsUI();
    checkBudgetAlerts(stats, today);
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
    const payload = {
        version: EXT_VERSION,
        exportedAt: new Date().toISOString(),
        dailyStats: loadDailyStats(),
        recentLogs: loadRecentLogs(),
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
    if (window.toastr) toastr.success("지출 통계 및 로그를 JSON 파일로 백업했습니다.");
}

/**
 * JSON 파일로부터 통계 & 로그 복원
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
            if (!parsed || typeof parsed !== "object" || (!parsed.dailyStats && !parsed.recentLogs)) {
                throw new Error("올바른 Gemini 비용 계산기 백업 파일이 아닙니다.");
            }
            if (parsed.dailyStats && typeof parsed.dailyStats === "object") {
                saveDailyStats(parsed.dailyStats);
            }
            if (Array.isArray(parsed.recentLogs)) {
                saveRecentLogs(parsed.recentLogs);
            }
            renderStatsUI();
            if (window.toastr) toastr.success("백업 파일에서 지출 통계를 복원했습니다.");
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

    const isRecentMain = (Date.now() - lastMainPromptAt) < 4000;
    const isStBackend = u.includes("/api/backends/");
    if (isRecentMain && isStBackend) {
        return { category: "main", caller: "main", callerLabel: "메인 채팅" };
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
        (async () => {
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

                if (isBinaryResp) {
                    cloned.body?.cancel().catch(() => {});
                } else if (contentType.includes("text/event-stream")) {
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
                            for (const line of lines) {
                                const trimmed = line.trim();
                                if (!trimmed.startsWith("data:")) continue;
                                const jsonStr = trimmed.slice(5).trim();
                                if (!jsonStr || jsonStr === "[DONE]") continue;
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
                            }
                        }
                    }
                } else {
                    const data = await cloned.json();
                    if (data?.model) respModel = data.model;
                    usage = extractUsageFromPayload(data);
                    const extracted = extractOutputFromResponseData(data);
                    accumulatedOutText = extracted.outText;
                    accumulatedThinkText = extracted.thinkText;
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

                const { costUsd, isHighTier } = calcTurnCostUsd(
                    normalInput, cacheTokens, outTokens, thinkTokens, totalInput, resolved.pricing
                );
                const costKrw = costUsd * curSettings.exchangeRate;

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
                    exchangeRate: curSettings.exchangeRate,
                    capturedAt: Date.now(),
                };

                recordApiUsage(record);

                if (category === "main") {
                    lastCapturedMainRecord = record;
                }
            } catch (err) {
                recordErrorLog("GCOST-FETCH", "네트워크 응답 분석", err);
                console.warn(`[Gemini Cost v${EXT_VERSION}] 네트워크 응답 분석 중 오류:`, err);
            }
        })();

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
    const { costUsd, isHighTier } = calcTurnCostUsd(
        normalInput, cacheTokens, outTokens, thinkTokens, totalInput, resolved.pricing
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
 */
function estimateMeasuredCacheRate(fallbackRate = 80) {
    try {
        const logs = loadRecentLogs();
        const measured = logs.filter(l => l.category === "main" && l.isEstimated === false && l.totalInput > 0);
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

        let runningContext = Math.max(0, Number(basePromptInfo.tokens) || 0);
        let prevContextForCache = 0;
        let aiTurnCount = 0;
        let sumNormalIn = 0, sumCacheIn = 0, sumOut = 0, sumThink = 0, sumUsd = 0;
        let sumRerollCount = 0, sumRerollKrw = 0;
        const turnRecords = [];

        for (let i = 0; i <= maxIdx; i++) {
            const msg = chat[i];
            if (!msg || msg.is_system) continue;

            const msgTokens = msg.extra?.token_count || await getTokenCountAsync(msg.mes || "");
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
            const thinkTokens = msg.extra?.reasoning ? await getTokenCountAsync(msg.extra.reasoning) : 0;
            const totalInput = runningContext;

            let cacheTokens = 0;
            if (aiTurnCount > 1 && prevContextForCache > 0) {
                cacheTokens = Math.min(Math.floor(prevContextForCache * (settings.cacheRate / 100)), totalInput);
            }
            const normalInput = Math.max(0, totalInput - cacheTokens);

            const { costUsd, isHighTier } = calcTurnCostUsd(
                normalInput, cacheTokens, msgTokens, thinkTokens, totalInput, settings
            );

            sumNormalIn += normalInput;
            sumCacheIn += cacheTokens;
            sumOut += msgTokens;
            sumThink += thinkTokens;
            sumUsd += costUsd;

            turnRecords.push({
                index: i, normalInput, cacheTokens, outTokens: msgTokens, thinkTokens,
                totalInput, isHighTier, costUsd, costKrw: costUsd * settings.exchangeRate,
            });

            runningContext += msgTokens;
            prevContextForCache = runningContext;
        }

        const nextCache = Math.floor(runningContext * (settings.cacheRate / 100));
        const nextNormal = Math.max(0, runningContext - nextCache);
        const nextAvgOut = aiTurnCount > 0 ? Math.round((sumOut + sumThink) / aiTurnCount) : 800;
        const { costUsd: nextTurnUsd } = calcTurnCostUsd(
            nextNormal, nextCache, nextAvgOut, 0, runningContext, settings
        );

        chatResult = {
            maxIdx, aiTurnCount, runningContext,
            sumNormalIn, sumCacheIn, sumOut, sumThink,
            sumUsd, sumKrw: sumUsd * settings.exchangeRate,
            nextTurnUsd, nextTurnKrw: nextTurnUsd * settings.exchangeRate,
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

function buildLiveStatsHtml() {
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

    // 2. 실측 프롬프트 캐시 적중률 모니터링 (최근 실측 메인 호출 기준)
    const measuredMainLogs = logs.filter(l => l.category === "main" && l.isEstimated === false && l.totalInput > 0);
    let cacheInsightHtml = "";
    if (measuredMainLogs.length > 0) {
        const sumIn = measuredMainLogs.reduce((acc, l) => acc + (l.totalInput || 0), 0);
        const sumCache = measuredMainLogs.reduce((acc, l) => acc + (l.cacheTokens || 0), 0);
        const hitPct = sumIn > 0 ? Math.round((sumCache / sumIn) * 100) : 0;
        let statusClass = "ok";
        let statusNote = `최근 실측 ${measuredMainLogs.length}회 평균 · 정상 작동`;
        if (hitPct === 0 && measuredMainLogs.length >= 2) {
            statusClass = "warn";
            statusNote = "캐시 미작동 · 프롬프트 순서/로어북 점검 권장";
        } else if (hitPct < 50) {
            statusClass = "warn";
            statusNote = `최근 실측 ${measuredMainLogs.length}회 평균 · 캐시 효율 낮음`;
        }
        cacheInsightHtml = `
            <div class="gcost-insight-bar ${statusClass}">
                <span class="gcost-insight-label">실측 캐시 적중률 <strong>${hitPct}%</strong></span>
                <span class="gcost-insight-note">${statusNote}</span>
            </div>
        `;
    }

    // 3. 최근 7일 일자별 지출 (접이식으로 컴팩트 유지)
    const last7Rows = [];
    let last7Total = 0;
    for (let i = 0; i < 7; i++) {
        const dk = getDateKeyOffset(i);
        const d = stats[dk];
        const krw = d?.krw || 0;
        const calls = d?.turns || 0;
        last7Total += krw;
        const dayTag = i === 0 ? "오늘" : (i === 1 ? "어제" : dk.slice(5));
        last7Rows.push(`
            <div class="gcost-compare-row">
                <span class="gcost-model-name">${dayTag} <span class="gcost-compare-note">(${dk})</span></span>
                <span class="gcost-model-usd">${calls}회</span>
                <span class="gcost-model-krw">${Math.round(krw).toLocaleString()}원</span>
            </div>
        `);
    }
    const last7Html = `
        <details class="gcost-details">
            <summary class="gcost-details-summary">
                <span>최근 7일 일자별 지출</span>
                <span class="gcost-compare-note">7일 합계 ${Math.round(last7Total).toLocaleString()}원</span>
            </summary>
            <div class="gcost-compare-list" style="margin-top:4px;">${last7Rows.join("")}</div>
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

    const recentRows = logs.slice(0, 8).map((l, idx) => {
        const showCaller = l.callerLabel && l.callerLabel !== "메인 채팅" && l.callerLabel !== CATEGORY_LABELS[l.category];
        const callerTag = showCaller ? `<span class="gcost-caller-tag" title="${escapeHtml(l.callerLabel)}">${escapeHtml(l.callerLabel)}</span>` : "";
        return `
            <div class="gcost-compare-row gcost-log-row">
                <span class="gcost-model-name">
                    <span class="gcost-cat-badge cat-${escapeHtml(l.category)}">${escapeHtml(CATEGORY_LABELS[l.category] || l.category)}</span>
                    ${callerTag}
                    <span>${escapeHtml(l.modelLabel)}</span>
                </span>
                <span class="gcost-model-usd">${escapeHtml(l.time)} · ${fmtK(l.totalInput)}→${fmtK(l.outTokens + (l.thinkTokens || 0))}</span>
                <span class="gcost-model-krw">${Math.round(l.costKrw).toLocaleString()}원</span>
                <button type="button" class="gcost-log-del-btn" data-log-idx="${idx}" title="이 로그 삭제 및 통계에서 차감">×</button>
            </div>
        `;
    }).join("") || `<div class="gcost-empty-msg">최근 호출 로그가 없습니다.</div>`;

    const prevMonthSub = prevMonthTotalKrw > 0
        ? ` · 지난달 ${Math.round(prevMonthTotalKrw).toLocaleString()}원`
        : "";

    return `
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

        <div class="gcost-compare-header">
            <span class="gcost-compare-title">최근 API 호출 로그</span>
            <span class="gcost-compare-note">최근 8건 · ×로 개별 삭제</span>
        </div>
        <div class="gcost-compare-list">${recentRows}</div>
    `;
}

function buildModalSettingsHtml(settings, basePromptInfo = null, cacheRateInfo = null) {
    const presetOptions = Object.entries(PRESETS).map(([key, p]) => {
        const sel = settings.preset === key ? "selected" : "";
        return `<option value="${key}" ${sel}>${p.label}</option>`;
    }).join("") + `<option value="custom" ${settings.preset === "custom" ? "selected" : ""}>직접 입력 (Custom)</option>`;

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

    return `
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
            </div>
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

function renderCombinedModal(settings, result, defaultTab, upToIndex = null, basePromptInfo = null, cacheRateInfo = null) {
    $(".gcost-modal-overlay").remove();

    const activeShort = PRESETS[settings.preset]?.shortLabel || "직접 입력";
    let chatTabHtml = `<div class="gcost-empty-msg">현재 열려 있는 채팅 메시지가 없습니다.</div>`;
    let rangePill = "실시간 추적";

    if (result) {
        rangePill = result.maxIdx === chat.length - 1
            ? `전체 · AI ${result.aiTurnCount}턴`
            : `#${result.maxIdx}까지 · AI ${result.aiTurnCount}턴`;

        const compareRows = Object.entries(PRESETS).map(([key, preset]) => {
            let modelUsd = 0;
            result.turnRecords.forEach(t => {
                const { costUsd } = calcTurnCostUsd(
                    t.normalInput, t.cacheTokens, t.outTokens, t.thinkTokens, t.totalInput, preset
                );
                modelUsd += costUsd;
            });
            const modelKrw = Math.round(modelUsd * settings.exchangeRate).toLocaleString();
            const activeClass = settings.preset === key ? "gcost-active-row" : "";
            return `
                <div class="gcost-compare-row ${activeClass}">
                    <span class="gcost-model-name">${preset.label}</span>
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

        const rerollSub = result.sumRerollCount > 0
            ? ` · 리롤+${result.sumRerollCount}(${Math.round(result.sumRerollKrw).toLocaleString()}원)`
            : ` · ${settings.exchangeRate.toLocaleString()}원`;

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
                    <div class="gcost-card-sub" title="환율 ${settings.exchangeRate.toLocaleString()}원">$${result.sumUsd.toFixed(4)}${rerollSub}</div>
                </div>
                <div class="gcost-card">
                    <div class="gcost-card-title">다음 1턴 예상</div>
                    <div class="gcost-card-main">약 ${Math.round(result.nextTurnKrw).toLocaleString()}원</div>
                    <div class="gcost-card-sub">$${result.nextTurnUsd.toFixed(4)} · ${result.nextAvgOut.toLocaleString()}t</div>
                </div>
            </div>

            ${tierWarnHtml}

            <div class="gcost-meta-grid">
                <div class="gcost-meta-item" title="고정 프롬프트 ${(basePromptInfo?.tokens ?? settings.basePromptTokens).toLocaleString()}t (${escapeHtml(basePromptInfo?.detail || "설정값")})">
                    <span class="gcost-meta-label">현재 컨텍스트</span>
                    <span class="gcost-meta-val">${fmtK(result.runningContext)}t</span>
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

    const liveTabHtml = buildLiveStatsHtml();
    const settingsTabHtml = buildModalSettingsHtml(settings, basePromptInfo, cacheRateInfo);
    const isChatTab = defaultTab === "chat";
    const isLiveTab = defaultTab === "live";
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
                        <span class="gcost-modal-close" title="닫기">✕</span>
                    </div>
                </div>

                <div class="gcost-tabs">
                    <button type="button" class="gcost-tab-btn ${isChatTab ? "active" : ""}" data-tab="chat">현재 채팅 계산</button>
                    <button type="button" class="gcost-tab-btn ${isLiveTab ? "active" : ""}" data-tab="live">모델·부가기능 내역</button>
                    <button type="button" class="gcost-tab-btn ${isSetTab ? "active" : ""}" data-tab="settings">설정</button>
                </div>

                <div class="gcost-modal-body">
                    <div class="gcost-tab-panel ${isChatTab ? "active" : ""}" data-panel="chat">${chatTabHtml}</div>
                    <div class="gcost-tab-panel ${isLiveTab ? "active" : ""}" data-panel="live">${liveTabHtml}</div>
                    <div class="gcost-tab-panel ${isSetTab ? "active" : ""}" data-panel="settings">${settingsTabHtml}</div>
                </div>

                <div class="gcost-modal-footer">
                    ${result ? `<button type="button" id="gcost_apply_badges_btn" class="gcost-btn gcost-btn-primary">배지 일괄 적용</button>` : ""}
                    <button type="button" id="gcost_close_modal_btn" class="gcost-btn">닫기</button>
                </div>
            </div>
        </div>
    `);

    $("body").append(modalHtml);

    modalHtml.find(".gcost-tab-btn").on("click", function () {
        const target = $(this).data("tab");
        modalHtml.find(".gcost-tab-btn").removeClass("active");
        $(this).addClass("active");
        modalHtml.find(".gcost-tab-panel").removeClass("active");
        modalHtml.find(`.gcost-tab-panel[data-panel="${target}"]`).addClass("active");
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

    // 탭 2 최근 로그 개별 삭제 이벤트 (위임 바인딩)
    modalHtml.on("click", ".gcost-log-del-btn", function () {
        const idx = parseInt($(this).data("log-idx"), 10);
        if (isNaN(idx)) return;
        if (!confirm("이 호출 로그를 삭제하고 해당 날짜 통계에서도 차감할까요?")) return;
        if (deleteRecentLogByIndex(idx)) {
            modalHtml.find('.gcost-tab-panel[data-panel="live"]').html(buildLiveStatsHtml());
            if (window.toastr) toastr.info("로그를 삭제하고 통계를 갱신했습니다.");
        }
    });

    // 모달 내 설정 탭 백업 / 복원
    modalHtml.find("#gcost_modal_export_btn").on("click", () => exportCostData());
    modalHtml.find("#gcost_modal_import_btn").on("click", () => {
        triggerImportCostData(() => {
            modalHtml.find('.gcost-tab-panel[data-panel="live"]').html(buildLiveStatsHtml());
        });
    });

    modalHtml.find("#gcost_modal_save_recalc").on("click", () => {
        const newRate = parseFloat(modalHtml.find("#gcost_modal_exchange_rate").val());
        const newPreset = modalHtml.find("#gcost_modal_preset").val();
        const newCache = parseInt(modalHtml.find("#gcost_modal_cache_rate").val(), 10);
        const newBasePrompt = parseInt(modalHtml.find("#gcost_modal_base_prompt").val(), 10);
        const newDailyBudget = parseInt(modalHtml.find("#gcost_modal_daily_budget").val(), 10);
        const newMonthlyBudget = parseInt(modalHtml.find("#gcost_modal_monthly_budget").val(), 10);

        const patch = { autoBasePrompt: modalAutoBasePrompt, autoCacheRate: modalAutoCacheRate };
        if (!isNaN(newRate) && newRate > 0) patch.exchangeRate = newRate;
        if (!isNaN(newCache)) patch.cacheRate = newCache;
        if (!isNaN(newBasePrompt) && newBasePrompt >= 0) patch.basePromptTokens = newBasePrompt;
        if (!isNaN(newDailyBudget) && newDailyBudget >= 0) patch.dailyBudgetKrw = newDailyBudget;
        if (!isNaN(newMonthlyBudget) && newMonthlyBudget >= 0) patch.monthlyBudgetKrw = newMonthlyBudget;

        if (newPreset && PRESETS[newPreset]) {
            const { label, shortLabel, ...pricing } = PRESETS[newPreset];
            Object.assign(patch, { preset: newPreset, ...pricing });
        } else if (newPreset === "custom") {
            patch.preset = "custom";
        }

        updateSettings(patch);

        // 확장 설정 패널 UI도 함께 동기화
        const updated = getSettings();
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
            result.turnRecords.forEach(t => {
                const msg = chat[t.index];
                if (!msg) return;
                if (!msg.extra) msg.extra = {};
                const prev = msg.extra.gemini_cost;
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
            if (window.toastr) toastr.success("채팅 말풍선에 비용 배지를 일괄 적용했습니다.");
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
    $(".gcost-badge").remove();
    if (!settings.enabled) return;

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

        const badge = $(`
            <div class="gcost-badge" title="${escapeHtml(tooltipLines.join("\n"))}">
                ${modelTag}
                <span>${estPrefix}${turnText}</span>
                ${rerollTag}
                <span class="gcost-sep">·</span>
                <span>누적 ${totalText}</span>
                ${tierTag}
            </div>
        `);

        mesEl.append(badge);
    });
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

function bindSettingsUI() {
    const s = getSettings();

    const syncInputs = (cfg) => {
        $("#gcost_enabled").prop("checked", cfg.enabled);
        $("#gcost_intercept_fetch").prop("checked", cfg.interceptFetch);
        $("#gcost_auto_model_pricing").prop("checked", cfg.autoModelPricing);
        $("#gcost_preset").val(cfg.preset);
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

    $("#gcost_intercept_fetch").on("change", function () {
        updateSettings({ interceptFetch: $(this).is(":checked") });
    });

    $("#gcost_auto_model_pricing").on("change", function () {
        updateSettings({ autoModelPricing: $(this).is(":checked") });
    });

    $("#gcost_preset").on("change", function () {
        const val = $(this).val();
        if (PRESETS[val]) {
            const { label, shortLabel, ...pricing } = PRESETS[val];
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
        renderStatsUI();
    });

    $("#gcost_reset_all").on("click", function () {
        if (!confirm("모든 날짜의 지출 기록과 호출 로그를 완전히 삭제할까요?")) return;
        localStorage.removeItem(STATS_STORAGE_KEY);
        localStorage.removeItem(RECENT_LOGS_KEY);
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
            const observer = new MutationObserver(() => {
                injectMessageMoreButtons();
            });
            observer.observe(chatEl, { childList: true });
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
        console.log(`[Gemini Cost Calculator v${EXT_VERSION}] 로드 완료`);
    } catch (err) {
        recordErrorLog("GCOST-INIT", "확장 초기화", err);
        console.error("[Gemini Cost Calculator] 초기화 실패:", err);
    }
});
