/* Trading Bot Dashboard — Frontend */

(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  let symbolChart = null;
  let dailyChart = null;
  let directionChart = null;
  let symbolBarChart = null;
  let telegramReportChart = null;
  let signalDailyChart = null;
  let signalDirChart = null;
  let homeSparkline = null;
  let hourlyHeatmapChart = null;
  let resourceHistoryChart = null;
  let cpuSparkChart = null;
  let ramSparkChart = null;
  let diskSparkChart = null;
  let netSparkChart = null;
  let simulationEquityChart = null;
  let eventSource = null;
  let logInterval = null;
  let statusInterval = null;
  let monitorInterval = null;
  let facebookInterval = null;
  let isAuthenticated = false;
  let mgmtBusy = false;
  let sseReconnectTimer = null;
  let allSignals = [];
  let signalPage = 1;
  let allTelegramEntries = [];
  let telegramPage = 1;
  let simulationPage = 1;
  let activePage = "home";
  let lastEngineState = null;
  let lastProcesses = [];
  const controlActivity = [];
  const MAX_ACTIVITY = 20;
  let lastSignalStatsKey = null;
  let symbolsDraft = [];
  let symbolsPool = [];
  let symbolsEnabled = new Set();
  const reportPayloadCache = new Map();
  const analyticsPayloadCache = new Map();
  let lastEngineStateForSymbols = null;
  const ACTIVE_PAGE_KEY = "tc:active-page";

  const SYMBOL_PRESETS = [
    "EUR/USD", "GBP/USD", "USD/JPY", "XAU/USD", "USD/CHF",
    "AUD/USD", "USD/CAD", "NZD/USD", "EUR/GBP", "BTC/USD",
    "XAG/USD", "EUR/JPY",
  ];
  const MAX_SYMBOLS = 12;
  const SIGNALS_PAGE_SIZE = 10;
  const resourceHistory = {
    labels: [],
    cpu: [],
    ram: [],
    disk: [],
    net: [],
    max: 120,
  };

  let lastOverallStatus = null;
  let lastSignalNotifKey = null;
  function safeLocalStorageGet(key, fallback = null) {
    try {
      return localStorage.getItem(key);
    } catch {
      return fallback;
    }
  }

  function safeLocalStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }

  function safeSessionStorageGet(key, fallback = null) {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return fallback;
    }
  }

  function safeSessionStorageSet(key, value) {
    try {
      sessionStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }

  function chartFont(size = 11) {
    return {
      family: CHART_FONT.family,
      size: isMobileViewport() ? Math.max(8, size - 2) : size,
    };
  }

  function isMobileViewport() {
    return window.matchMedia && window.matchMedia("(max-width: 768px)").matches;
  }

  async function logClientEvent(event, detail = {}) {
    try {
      await fetch("/api/client-log", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event, detail }),
        keepalive: true,
      });
    } catch {}
  }

  function reportClientError(scope, err, extra = {}) {
    const message = err?.message || String(err);
    const detail = {
      scope,
      message,
      stack: err?.stack || "",
      ua: navigator.userAgent,
      dpr: window.devicePixelRatio || 1,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      ...extra,
    };
    console.error(`[${scope}]`, err);
    logClientEvent("client-error", detail);
  }

  function destroyReportCharts() {
    [dailyChart, directionChart, symbolBarChart, telegramReportChart, hourlyHeatmapChart].forEach((chart) => {
      try {
        chart?.destroy();
      } catch {}
    });
    dailyChart = null;
    directionChart = null;
    symbolBarChart = null;
    telegramReportChart = null;
    hourlyHeatmapChart = null;
  }

  function rebuildReportCharts(days = 30) {
    const report = reportPayloadCache.get(days);
    const analytics = analyticsPayloadCache.get(days);
    if (!report && !analytics) return;
    const dims = {
      daily: $("#dailyChart") ? { w: $("#dailyChart").clientWidth, h: $("#dailyChart").clientHeight } : null,
      direction: $("#directionChart") ? { w: $("#directionChart").clientWidth, h: $("#directionChart").clientHeight } : null,
      symbol: $("#symbolBarChart") ? { w: $("#symbolBarChart").clientWidth, h: $("#symbolBarChart").clientHeight } : null,
      telegram: $("#telegramReportChart") ? { w: $("#telegramReportChart").clientWidth, h: $("#telegramReportChart").clientHeight } : null,
      heatmap: $("#hourlyHeatmapChart") ? { w: $("#hourlyHeatmapChart").clientWidth, h: $("#hourlyHeatmapChart").clientHeight } : null,
    };
    logClientEvent("report-rebuild", { days, dims, viewport: { w: window.innerWidth, h: window.innerHeight } });
    destroyReportCharts();
    if (report) applyReportData(report, days);
    if (analytics) applyAnalyticsPayload(analytics, days);
    resizeReportCharts();
  }

  function clearDashboardCache() {
    DataCache.clear();
    try {
      Object.keys(sessionStorage)
        .filter((k) => k.startsWith("tc:"))
        .forEach((k) => sessionStorage.removeItem(k));
    } catch {}
    try {
      Object.keys(localStorage)
        .filter((k) => k.startsWith("tc:"))
        .forEach((k) => localStorage.removeItem(k));
    } catch {}
  }

  let browserNotifEnabled = safeLocalStorageGet("tc:browser-notif", "0") === "1";
  const firedAlertKeys = new Set();
  const settingsDraft = {
    active: false,
    minScore: null,
    pollSeconds: null,
  };
  let facebookPayload = null;
  let facebookPreviewSignalId = null;
  let facebookPreviewTemplates = null;
  function normalizePage(page) {
    return PAGE_META[page] ? page : "home";
  }

  function resetTelegramPage() {
    telegramPage = 1;
  }

  const PAGE_META = {
    home: { title: "داشبورد", sub: "نمای کلی ربات" },
    monitor: { title: "مانیتورینگ", sub: "منابع سرور، موتور تحلیل و سلامت سیستم" },
    control: { title: "کنترل ربات", sub: "مدیریت PM2، نوتیفیکیشن و عملیات موتور" },
    signals: { title: "سیگنال‌ها", sub: "ردیابی ارسال، خطا و کیفیت هر سیگنال" },
    simulation: { title: "شبیه‌ساز", sub: "بازده فرضی سیگنال‌ها روی قیمت واقعی بازار" },
    reports: { title: "گزارش‌ها", sub: "تحلیل عملکرد، تلگرام و خروجی Excel" },
    telegram: { title: "تلگرام", sub: "لاگ کامل ارسال سیگنال‌ها به تلگرام" },
    facebook: { title: "فیسبوک", sub: "مدیریت گروه‌ها، پیام‌ها و انتشار سیگنال" },
    settings: { title: "تنظیمات", sub: "سازماندهی نمادها، موتور و کانال‌های ارسال" },
    logs: { title: "لاگ‌ها", sub: "مشاهده زنده لاگ‌ها" },
  };

  /** Bump minor (2.1→2.2) for feature releases; major (2→3) for big rewrites. */
  activePage = normalizePage(safeSessionStorageGet(ACTIVE_PAGE_KEY, activePage));
  let dashboardVersion = { label: "v2.26", full: "2.26.0", major: 2, minor: 26, patch: 0 };
  let signalsSummary = null;

  const NAV_ICONS = {
    home: '<path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
    control: '<circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83"/>',
    signals: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
    simulation: '<path d="M3 3v18h18"/><path d="M7 15l3-3 3 2 5-7"/><circle cx="18" cy="7" r="1"/>',
    reports: '<path d="M18 20V10M12 20V4M6 20v-6"/>',
    telegram: '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/>',
    facebook: '<path d="M14 8h3V3h-3c-3.3 0-6 2.7-6 6v3H5v5h3v4h5v-4h4l1-5h-5V9c0-.6.4-1 1-1z"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>',
    logs: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
    tools: '<path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/>',
    analytics: '<path d="M3 3v18h18"/><path d="M7 16l4-4 4 4 5-6"/>',
  };

  /** Sidebar nav config — add groups/items here for new features. */
  const NAV_GROUPS = [
    {
      id: "main",
      label: "اصلی",
      defaultOpen: true,
      items: [
        { page: "home", label: "داشبورد", icon: "home" },
        { page: "monitor", label: "مانیتورینگ", icon: "monitor" },
      ],
    },
    {
      id: "bot",
      label: "ربات",
      defaultOpen: true,
      items: [
        { page: "control", label: "کنترل ربات", icon: "control" },
        { page: "signals", label: "سیگنال‌ها", icon: "signals" },
        { page: "simulation", label: "شبیه‌ساز عملکرد", icon: "simulation", badge: "جدید" },
        { page: "reports", label: "گزارش‌ها", icon: "reports" },
        { page: "telegram", label: "تلگرام", icon: "telegram" },
        { page: "facebook", label: "فیسبوک", icon: "facebook" },
      ],
    },
    {
      id: "system",
      label: "سیستم",
      defaultOpen: true,
      items: [
        { page: "settings", label: "تنظیمات", icon: "settings" },
        { page: "logs", label: "لاگ‌ها", icon: "logs" },
      ],
    },
    {
      id: "upcoming",
      label: "امکانات جدید",
      defaultOpen: false,
      items: [
        { page: null, label: "تحلیل پیشرفته", icon: "analytics", disabled: true, badge: "به‌زودی" },
        { page: null, label: "ابزارها", icon: "tools", disabled: true, badge: "به‌زودی" },
      ],
    },
  ];

  const CHART_FONT = { family: "Vazirmatn", size: 11 };
  const CHART_COLORS = ["#63ffd0", "#5b9cf6", "#a78bfa", "#fbbf24", "#f87171"];

  // ── Smart Cache (stale-while-revalidate + session persist) ──
  const CACHE_TTL = {
    status: 15000,
    system: 8000,
    signals: 45000,
    logs: 8000,
    report: 120000,
    bootstrap: 30000,
    telegram: 60000,
    ops: 120000,
    uptime: 30000,
    cooldowns: 30000,
    audit: 60000,
    analytics: 120000,
    facebook: 15000,
    simulation: 30000,
  };

  const PERSIST_PREFIXES = ["status", "system", "signals:", "report:", "telegram:", "ops", "cooldowns", "uptime", "bootstrap", "analytics:"];
  const PERSIST_MAX_AGE_MS = 600000;

  let bootstrapInflight = null;
  let bootstrapCompletedAt = 0;
  let sseConnected = false;
  let lastStatusFingerprint = null;
  const BOOTSTRAP_COALESCE_MS = 20000;

  let strategyPendingFile = null;
  let strategyLastUploadId = null;
  let strategySelectedId = null;

  const PAGE_NEEDS = {
    home: ["status", "report:7"],
    monitor: ["status", "system", "uptime"],
    control: ["status", "cooldowns"],
    signals: ["signals"],
    simulation: ["simulation"],
    reports: ["report", "analytics"],
    telegram: ["telegram"],
    facebook: ["facebook"],
    settings: ["status", "ops", "audit"],
    logs: ["logs"],
  };

  const DataCache = {
    _mem: new Map(),
    _inflight: new Map(),
    _revalidate: new Map(),

    get(key) {
      return this._mem.get(key)?.data ?? null;
    },

    getEntry(key) {
      return this._mem.get(key);
    },

    shouldPersist(key) {
      return PERSIST_PREFIXES.some((p) => key === p || key.startsWith(p));
    },

    set(key, data, ts = Date.now()) {
      this._mem.set(key, { data, ts });
      if (this.shouldPersist(key)) {
        try {
          sessionStorage.setItem(`tc:${key}`, JSON.stringify({ data, ts }));
        } catch {
          try {
            Object.keys(sessionStorage)
              .filter((k) => k.startsWith("tc:"))
              .slice(0, 8)
              .forEach((k) => sessionStorage.removeItem(k));
            sessionStorage.setItem(`tc:${key}`, JSON.stringify({ data, ts }));
          } catch {}
        }
      }
    },

    delete(key) {
      this._mem.delete(key);
      try {
        sessionStorage.removeItem(`tc:${key}`);
      } catch {}
    },

    deletePrefix(prefix) {
      [...this._mem.keys()].forEach((k) => {
        if (k.startsWith(prefix)) this.delete(k);
      });
    },

    clear() {
      this._mem.clear();
      try {
        Object.keys(sessionStorage)
          .filter((k) => k.startsWith("tc:"))
          .forEach((k) => sessionStorage.removeItem(k));
      } catch {}
    },

    isFresh(key, ttl) {
      const e = this.getEntry(key);
      return Boolean(e && Date.now() - e.ts < ttl);
    },

    canServeStale(key, ttl) {
      const e = this.getEntry(key);
      return Boolean(e && Date.now() - e.ts < ttl * 12);
    },

    hydrate() {
      try {
        Object.keys(sessionStorage)
          .filter((k) => k.startsWith("tc:"))
          .forEach((storageKey) => {
            const key = storageKey.slice(3);
            const raw = sessionStorage.getItem(storageKey);
            if (!raw) return;
            const { data, ts } = JSON.parse(raw);
            if (Date.now() - ts < PERSIST_MAX_AGE_MS) {
              this._mem.set(key, { data, ts });
            }
          });
      } catch {}
    },

    onRevalidate(key, fn) {
      if (!this._revalidate.has(key)) this._revalidate.set(key, new Set());
      this._revalidate.get(key).add(fn);
    },

    onRevalidatePrefix(prefix, fn) {
      if (!this._revalidate.has(`prefix:${prefix}`)) this._revalidate.set(`prefix:${prefix}`, new Set());
      this._revalidate.get(`prefix:${prefix}`).add(fn);
    },

    _emitRevalidate(key, data) {
      this._revalidate.get(key)?.forEach((fn) => {
        try {
          fn(data);
        } catch {}
      });
      PERSIST_PREFIXES.forEach((prefix) => {
        if (key.startsWith(prefix)) {
          this._revalidate.get(`prefix:${prefix}`)?.forEach((fn) => {
            try {
              fn(data, key);
            } catch {}
          });
        }
      });
    },

    async load(key, fetcher, ttl, { force = false, onStale = null } = {}) {
      const cached = this.get(key);
      const entry = this.getEntry(key);

      if (!force && cached && this.isFresh(key, ttl)) {
        return cached;
      }

      const stale = !force && this.canServeStale(key, ttl) ? cached : null;
      if (stale && onStale) {
        try {
          onStale(stale, true);
        } catch {}
      }

      if (this._inflight.has(key)) {
        if (stale) return stale;
        return this._inflight.get(key);
      }

      const task = Promise.resolve()
        .then(fetcher)
        .then((data) => {
          this.set(key, data);
          this._inflight.delete(key);
          if (onStale) {
            try {
              onStale(data, false);
            } catch {}
          } else {
            this._emitRevalidate(key, data);
          }
          return data;
        })
        .catch((err) => {
          this._inflight.delete(key);
          if (stale) return stale;
          throw err;
        });

      this._inflight.set(key, task);

      if (stale) {
        task.catch(() => {});
        return stale;
      }

      return task;
    },
  };

  function invalidateCache(...keys) {
    keys.forEach((k) => {
      if (k.endsWith("*")) {
        DataCache.deletePrefix(k.slice(0, -1));
      } else {
        DataCache.delete(k);
      }
    });
    bootstrapCompletedAt = 0;
  }

  function isBootstrapFresh() {
    return bootstrapCompletedAt && Date.now() - bootstrapCompletedAt < BOOTSTRAP_COALESCE_MS;
  }

  async function waitForBootstrap(timeoutMs = 1500) {
    if (!bootstrapInflight) return;
    try {
      await Promise.race([
        bootstrapInflight,
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    } catch {}
  }

  function applyAnalyticsPayload(payload, days = 30) {
    if (!payload) return;
    analyticsPayloadCache.set(days, payload);
    logClientEvent("analytics-apply", {
      days,
      symbols: payload.symbols?.symbols?.length || 0,
      hourly: payload.hourly?.hours?.length || 0,
      viewport: { w: window.innerWidth, h: window.innerHeight },
    });
    renderSymbolReportTable(
      payload.symbols?.symbols,
      payload.symbols?.generated_at ? `بروزرسانی ${payload.symbols.generated_at}` : null
    );
    renderHourlyHeatmap(payload.hourly?.hours || []);
  }

  function applyAllCachedData() {
    const status = DataCache.get("status");
    if (status) applyStatusData(status);
    const sys = DataCache.get("system");
    if (sys) updateSystem(sys);
    const report7 = DataCache.get("report:7");
    if (report7) applyReportData(report7, 7);
    const report30 = DataCache.get("report:30");
    if (report30) applyReportData(report30, 30);
    const sig = DataCache.get(signalsCacheKey(30, "all", "all", "all"));
    if (sig) applySignalsPayload(sig);
    const tg = DataCache.get("telegram:30:all");
    if (tg) applyTelegramData(tg);
    const analytics30 = DataCache.get("analytics:30");
    if (analytics30) applyAnalyticsPayload(analytics30, 30);
    const ops = DataCache.get("ops");
    if (ops) applyOpsConfig(ops);
    const cooldowns = DataCache.get("cooldowns");
    if (cooldowns) renderCooldownPanel(cooldowns);
    const uptime = DataCache.get("uptime");
    if (uptime) renderUptimeHistory(uptime);
    applyPageFromCache(activePage);
  }

  function prefetchAfterBootstrap() {
    const jobs = [
      fetchTelegram({ force: false }).catch(() => {}),
      fetchOpsConfig({ force: false }).catch(() => {}),
      fetchCooldowns({ force: false }).catch(() => {}),
      fetchUptimeHistory({ force: false }).catch(() => {}),
      fetchReport(30, { force: false }).catch(() => {}),
      fetchReportAnalytics(30, { force: false }).catch(() => {}),
    ];
    Promise.allSettled(jobs);
  }

  function reportCacheKey(days = 30) {
    return `report:${days}`;
  }

  function signalsCacheKey(days = 30, delivery = "all", direction = "all", outcome = "all") {
    return `signals:${days}:${delivery}:${direction}:${outcome}`;
  }

  function telegramCacheKey(days = 30, status = "all") {
    return `telegram:${days}:${status}`;
  }

  function logsCacheKey(process) {
    return `logs:${process}`;
  }

  // ── Toast ──
  function toast(msg, type = "success") {
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = msg;
    $("#toastContainer").appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  // ── API ──
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...opts.headers },
      ...opts,
    });
    if (res.status === 401) {
      // Only kick out if user was previously logged in (avoids false logouts)
      if (isAuthenticated && !path.includes("/api/auth/login")) {
        isAuthenticated = false;
        showLogin();
      }
      throw new Error("Unauthorized");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Request failed");
    return data;
  }

  async function authFetch(path, opts = {}) {
    return fetch(path, { credentials: "same-origin", ...opts });
  }

  // ── Auth ──
  function showLogin() {
    document.body.classList.remove("auth-pending");
    $("#loginOverlay").classList.remove("hidden");
    $("#dashboard").classList.add("hidden");
    stopStreams();
  }

  function showDashboard() {
    document.body.classList.remove("auth-pending");
    DataCache.hydrate();
    applyAllCachedData();
    $("#loginOverlay").classList.add("hidden");
    $("#dashboard").classList.remove("hidden");
    startStreams();
  }

  async function checkAuth() {
    try {
      const res = await authFetch("/api/auth/check");
      const { authenticated } = await res.json();
      if (authenticated) {
        isAuthenticated = true;
        showDashboard();
      } else {
        isAuthenticated = false;
        showLogin();
      }
    } catch {
      isAuthenticated = false;
      showLogin();
    }
  }

  $("#loginForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = $("#loginUsername").value.trim();
    const password = $("#loginPassword").value;
    const submitBtn = $("#loginSubmit");
    const submitText = submitBtn?.querySelector(".login-submit-text");
    const submitLoader = submitBtn?.querySelector(".login-submit-loader");

    submitBtn.disabled = true;
    submitText?.classList.add("hidden");
    submitLoader?.classList.remove("hidden");
    $("#loginError").textContent = "";

    try {
      await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      isAuthenticated = true;
      showDashboard();
    } catch {
      $("#loginError").textContent = "نام کاربری یا رمز عبور اشتباه است";
    } finally {
      submitBtn.disabled = false;
      submitText?.classList.remove("hidden");
      submitLoader?.classList.add("hidden");
    }
  });

  $("#togglePassword")?.addEventListener("click", () => {
    const input = $("#loginPassword");
    if (!input) return;
    const isPassword = input.type === "password";
    input.type = isPassword ? "text" : "password";
  });

  $("#btnLogout")?.addEventListener("click", async () => {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch {}
    isAuthenticated = false;
    DataCache.clear();
    showLogin();
  });

  // ── Control ──
  async function control(action, process = "all") {
    const labels = { start: "راه‌اندازی", stop: "توقف", restart: "ری‌استارت" };
    const label = labels[action] || action;
    const target = process === "all" ? "همه فرآیندها" : process;
    try {
      setControlBusy(true);
      const data = await api("/api/control", {
        method: "POST",
        body: JSON.stringify({ action, process }),
      });
      toast(`${label} ${target} انجام شد`);
      logControlActivity(`${label} ${target}`, "ok");
      invalidateCache("status", "system", "bootstrap");
      await fetchStatus({ force: true });
      return data;
    } catch (err) {
      logControlActivity(`${label} ${target}: ${err.message}`, "err");
      toast(err.message, "error");
    } finally {
      setControlBusy(false);
    }
  }

  function setControlBusy(busy) {
    mgmtBusy = busy;
    $$(".ctrl-quick-btn, .mgmt-card[data-mgmt], .btn-icon").forEach((el) => {
      if (el.matches(".btn-icon")) el.disabled = busy;
      else el.disabled = busy;
    });
  }

  $("#btnStartAll")?.addEventListener("click", () => control("start", "all"));
  $("#btnStopAll")?.addEventListener("click", () => control("stop", "all"));

  // ── Status Labels ──
  const STATUS_FA = {
    running: { label: "ربات در حال اجراست", sub: "همه سرویس‌ها فعال هستند", cls: "running" },
    stopped: { label: "ربات متوقف است", sub: "هیچ سرویسی در حال اجرا نیست", cls: "stopped" },
    partial: { label: "اجرای جزئی", sub: "برخی سرویس‌ها فعال و برخی متوقف هستند", cls: "partial" },
    unknown: { label: "وضعیت نامشخص", sub: "", cls: "" },
  };

  function animateValue(el, newVal) {
    if (!el) return;
    el.style.transform = "scale(1.1)";
    el.textContent = newVal;
    setTimeout(() => (el.style.transform = "scale(1)"), 200);
  }

  /** Accept "YYYY-MM-DD HH:MM:SS" or "HH:MM:SS" from status/SSE. */
  function formatServerTime(raw) {
    if (!raw) return "--:--:--";
    const text = String(raw).trim();
    if (!text) return "--:--:--";
    const space = text.indexOf(" ");
    return space >= 0 ? text.slice(space + 1) : text;
  }

  function updateLiveClock(raw) {
    if ($("#liveTime")) $("#liveTime").textContent = formatServerTime(raw);
    if ($("#heroUpdated")) {
      $("#heroUpdated").textContent = raw ? `بروزرسانی ${raw}` : "—";
    }
  }

  function setText(sel, val) {
    const el = $(sel);
    if (el) el.textContent = val ?? "—";
  }

  function setBarWidth(sel, pct) {
    const el = $(sel);
    if (el) el.style.width = `${pct}%`;
  }

  /** Stable counter display — no scale animation, tabular nums, skip if unchanged. */
  function setStableCounter(el, newVal) {
    if (!el) return;
    const text = String(newVal ?? 0);
    if (el.textContent === text) return;
    el.textContent = text;
  }

  function updateStatusBanner(overall) {
    const info = STATUS_FA[overall] || STATUS_FA.unknown;
    const ind = $("#statusIndicator");
    if (ind) ind.className = `status-indicator ${info.cls}`;
    if ($("#statusLabel")) $("#statusLabel").textContent = info.label;
    if ($("#statusSub")) $("#statusSub").textContent = info.sub;
    if ($("#heroStatusText")) $("#heroStatusText").textContent = info.label;
    const dot = document.querySelector(".sidebar-status-dot");
    if (dot) dot.className = `sidebar-status-dot ${info.cls}`;
    if ($("#sidebarStatusText")) $("#sidebarStatusText").textContent = info.label;
  }

  function renderHomeProcesses(procs) {
    const el = $("#homeProcesses");
    if (!el || !procs) return;
    el.innerHTML = procs.map((p) => `
      <div class="service-chip">
        <span class="name">${p.name}</span>
        <span class="dot ${p.status === "online" ? "online" : "stopped"}"></span>
      </div>`).join("");
  }

  function renderHomeSecondary(data) {
    const el = $("#homeRecentSignals");
    if (el) {
      const recent = Array.isArray(data?.recent_signals) ? data.recent_signals : [];
      if (!recent.length) {
        el.innerHTML = '<p class="panel-empty">هنوز سیگنالی ثبت نشده.</p>';
      } else {
        el.innerHTML = recent
          .map((s) => {
            const dir = (s.direction || "").toUpperCase();
            const meta = OUTCOME_META[s.outcome] || OUTCOME_META.open;
            const time = s.timestamp ? String(s.timestamp).split(" ")[1] || s.timestamp : "—";
            return `<article class="home-recent-item">
              <span class="home-recent-symbol">${esc(s.symbol || "?")}</span>
              <span class="sig-dir-badge ${dir === "BUY" ? "buy" : "sell"}">${dir || "—"}</span>
              <span class="outcome-badge ${meta.cls}">${meta.label}</span>
              <span class="home-recent-time">${esc(time)}</span>
            </article>`;
          })
          .join("");
      }
    }

    const oc = data?.outcome_summary || {};
    const sys = DataCache.get("system");
    const procs = data?.processes || [];
    const score = computeHealthScore(sys, procs);
    const health = healthFromPct(score);
    const healthEl = $("#homeHealthScore");
    const healthLbl = $("#homeHealthLabel");
    if (healthEl) {
      healthEl.textContent = `${score}%`;
      healthEl.className = `home-health-num health-${health.cls}`;
    }
    if (healthLbl) healthLbl.textContent = health.label;

    if ($("#homeTodayWins")) $("#homeTodayWins").textContent = String(oc.today_wins ?? 0);
    if ($("#homeTodayLosses")) $("#homeTodayLosses").textContent = String(oc.today_losses ?? 0);
    if ($("#homeOpenSignals")) $("#homeOpenSignals").textContent = String(oc.open ?? 0);
  }

  function applyHomeKpis(data) {
    const oc = data?.outcome_summary || {};
    const delivery = data?.delivery_summary || {};
    const winEl = $("#kpiWinRate");
    const delEl = $("#kpiDeliveryRate");
    if (winEl) {
      winEl.textContent = oc.win_rate != null ? `${oc.win_rate}%` : "—";
    }
    if (delEl) {
      delEl.textContent = delivery.rate != null ? `${delivery.rate}%` : "—";
    }
  }

  function renderLatestSignal(latest) {
    const ls = $("#latestSignal");
    if (!ls) return;
    if (!latest) {
      ls.className = "signal-ticket empty";
      ls.textContent = "هنوز سیگنالی ثبت نشده";
      return;
    }
    ls.className = "signal-ticket";
    const dir = (latest.direction || "").toUpperCase();
    const isBuy = dir === "BUY";
    ls.innerHTML = `
      <div class="ticket-header">
        <span class="ticket-symbol">${latest.symbol}</span>
        <span class="ticket-dir ${isBuy ? "buy" : "sell"}">${dir}</span>
      </div>
      <div class="ticket-grid">
        <div class="ticket-field"><label>Entry</label><span class="accent">${latest.entry}</span></div>
        <div class="ticket-field"><label>Stop Loss</label><span>${latest.sl}</span></div>
        <div class="ticket-field"><label>TP1</label><span>${latest.tp1}</span></div>
        <div class="ticket-field"><label>TP2</label><span>${latest.tp2 || "—"}</span></div>
        <div class="ticket-field full"><label>Risk / Reward</label><span>${latest.rr || "—"}${latest.basis ? " · " + (latest.basis.length > 36 ? latest.basis.slice(0, 36) + "…" : latest.basis) : ""}</span></div>
      </div>`;
  }

  function renderSymbolHealth(state) {
    const el = $("#symbolHealth");
    if (!el) return;
    const bars = state?.last_bars || {};
    const signals = state?.last_signal_at || {};
    const symbols = [...new Set([...Object.keys(bars), ...Object.keys(signals)])];
    if (!symbols.length) {
      el.innerHTML = '<p style="color:var(--text-dim);font-size:var(--text-xs);text-align:center;padding:0.5rem">—</p>';
      return;
    }
    el.innerHTML = symbols.map((sym) => {
      const barTime = bars[sym] || "—";
      const sigTime = signals[sym] || "—";
      const pct = barTime !== "—" ? 85 : 30;
      return `
        <div class="health-row">
          <span class="health-sym">${sym}</span>
          <div class="health-info">
            <div class="health-bar-label"><span>آخرین Bar</span><span>${barTime !== "—" ? "فعال" : "—"}</span></div>
            <div class="health-bar"><div class="health-bar-fill" style="width:${pct}%"></div></div>
          </div>
          <span class="health-signal-time">${sigTime !== "—" ? sigTime.split(" ")[1] || sigTime : "—"}</span>
        </div>`;
    }).join("");
  }

  function renderSymbolLegend(bySymbol) {
    const el = $("#symbolLegend");
    if (!el) return;
    const total = Object.values(bySymbol).reduce((a, b) => a + b, 0) || 1;
    const colors = CHART_COLORS;
    el.innerHTML = Object.entries(bySymbol).map(([sym, count], i) => `
      <div class="legend-item">
        <span class="legend-dot" style="background:${colors[i % colors.length]}"></span>
        ${sym} <strong>${count}</strong> (${Math.round(count / total * 100)}%)
      </div>`).join("");
  }

  function renderHomeSparkline(daily) {
    const canvas = $("#homeSparkline");
    if (!canvas || !daily) return;
    const labels = daily.map((d) => d.date.slice(5));
    const totals = daily.map((d) => d.total);
    if (homeSparkline) {
      homeSparkline.data.labels = labels;
      homeSparkline.data.datasets[0].data = totals;
      homeSparkline.update("none");
      return;
    }
    homeSparkline = new Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: [{
          data: totals,
          borderColor: "#63ffd0",
          backgroundColor: "rgba(99,255,208,0.1)",
          fill: true,
          tension: 0.45,
          pointRadius: 0,
          pointHoverRadius: 4,
          borderWidth: 2,
        }],
      },
      options: {
        ...chartDefaults(),
        plugins: { legend: { display: false } },
        scales: {
          x: { display: false },
          y: { display: false, beginAtZero: true },
        },
        interaction: { intersect: false, mode: "index" },
      },
    });
  }

  function statusFingerprint(data) {
    if (!data) return "";
    const cfg = data.config || {};
    const procs = (data.processes || [])
      .map((p) => `${p.name}:${p.status}`)
      .join(",");
    return [
      data.overall,
      data.server_time,
      cfg.notifications_paused,
      cfg.min_score,
      cfg.poll_seconds,
      cfg.symbols,
      cfg.facebook_enable,
      cfg.engine_debug,
      procs,
      data.signal_stats?.today,
      data.signal_stats?.total,
      data.outcome_summary?.win_rate,
      data.delivery_summary?.rate,
      (data.recent_signals || []).length,
      data.latest_signal?.timestamp,
    ].join("|");
  }

  function mergeStatusConfig(configPatch) {
    const status = DataCache.get("status") || {};
    const merged = {
      ...status,
      config: { ...(status.config || {}), ...configPatch },
    };
    DataCache.set("status", merged);
    return merged;
  }

  function getLiveSettingsValue() {
    return {
      min_score: String($("#cfgMinScoreRange")?.value || $("#cfgMinScore")?.value || "5"),
      poll_seconds: String($("#cfgPollRange")?.value || $("#cfgPoll")?.value || "30"),
    };
  }

  function markSettingsDraft() {
    settingsDraft.active = true;
    const live = getLiveSettingsValue();
    settingsDraft.minScore = live.min_score;
    settingsDraft.pollSeconds = live.poll_seconds;
    safeSessionStorageSet("tc:settings-draft", JSON.stringify(settingsDraft));
  }

  function clearSettingsDraft() {
    settingsDraft.active = false;
    settingsDraft.minScore = null;
    settingsDraft.pollSeconds = null;
    try {
      sessionStorage.removeItem("tc:settings-draft");
    } catch {}
  }

  function loadSettingsDraft() {
    const raw = safeSessionStorageGet("tc:settings-draft", "");
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return;
      settingsDraft.active = !!parsed.active;
      settingsDraft.minScore = parsed.minScore ?? null;
      settingsDraft.pollSeconds = parsed.pollSeconds ?? null;
    } catch {}
  }

  function applySettingsFieldValue(idRange, idHidden, idDisplay, value, suffix = "") {
    if ($(idRange)) $(idRange).value = value;
    if ($(idHidden)) $(idHidden).value = value;
    if ($(idDisplay)) $(idDisplay).textContent = `${value}${suffix}`;
  }

  function readConfigFromForm() {
    const live = getLiveSettingsValue();
    return {
      symbols: $("#cfgSymbols")?.value || formatSymbolsString(getEnabledSymbols()),
      min_score: live.min_score,
      poll_seconds: live.poll_seconds,
      facebook_enable: !!$("#cfgFacebook")?.checked,
      engine_debug: !!$("#cfgDebug")?.checked,
    };
  }

  function applyConfigToDashboard(configPatch, statusBase = null) {
    const base = statusBase || DataCache.get("status") || {};
    const merged = {
      ...base,
      config: { ...(base.config || {}), ...configPatch },
    };
    DataCache.set("status", merged);
    applySettingsPage(merged);
    applyControlPage(merged);
    if ($("#cfgSymbols")) $("#cfgSymbols").value = merged.config.symbols || "";
    if ($("#cfgFacebook")) $("#cfgFacebook").checked = !!merged.config.facebook_enable;
    if ($("#cfgDebug")) $("#cfgDebug").checked = !!merged.config.engine_debug;
    if ($("#debugStatus")) {
      $("#debugStatus").textContent = merged.config.engine_debug ? "روشن" : "خاموش";
    }
  }

  function applyStatusData(data) {
    if (!data) return;
    const fp = statusFingerprint(data);
    if (fp && fp === lastStatusFingerprint) return;
    lastStatusFingerprint = fp;
    updateStatusBanner(data.overall);
    renderProcesses(data.all_processes || data.processes);
    applyControlPage(data);
    renderHomeProcesses(data.processes);
    renderMonitorProcesses(data.processes);
    renderEngineState(data.engine_state);
    renderLatestSignal(data.latest_signal);
    renderStats(data.signal_stats, data);
    renderHomeSecondary(data);
    updateLiveClock(data.server_time);

    const cfg = data.config || {};
    if ($("#cfgSymbols")) $("#cfgSymbols").value = cfg.symbols || "";
    if (!settingsDraft.active) {
      if ($("#cfgMinScore")) $("#cfgMinScore").value = cfg.min_score || "5";
      if ($("#cfgPoll")) $("#cfgPoll").value = cfg.poll_seconds || "30";
    }
    if ($("#cfgFacebook")) $("#cfgFacebook").checked = cfg.facebook_enable;
    if ($("#cfgDebug")) $("#cfgDebug").checked = cfg.engine_debug;
    if ($("#debugStatus")) $("#debugStatus").textContent = cfg.engine_debug ? "روشن" : "خاموش";
    applySettingsPage(data);
  }

  function applySettingsPage(data) {
    if (!data) return;
    const cfg = data.config || {};
    const symbols = parseSymbolsString(cfg.symbols || "");
    const info = STATUS_FA[data.overall] || STATUS_FA.unknown;

    if ($("#settingsStatusDot")) $("#settingsStatusDot").className = `status-indicator ${info.cls}`;
    if ($("#settingsStatusLabel")) $("#settingsStatusLabel").textContent = info.label;
    if ($("#settingsUpdated")) {
      $("#settingsUpdated").textContent = data.server_time ? `بروزرسانی ${data.server_time}` : "—";
    }
    if ($("#settingsSymCount")) $("#settingsSymCount").textContent = symbols.length;
    if ($("#settingsMinScore")) $("#settingsMinScore").textContent = cfg.min_score || "5";
    if ($("#settingsPollVal")) $("#settingsPollVal").textContent = `${cfg.poll_seconds || "30"}s`;

    const minScore = cfg.min_score || "5";
    const poll = cfg.poll_seconds || "30";

    const keepDraft = settingsDraft.active;
    const scoreValue = keepDraft && settingsDraft.minScore != null ? settingsDraft.minScore : minScore;
    const pollValue = keepDraft && settingsDraft.pollSeconds != null ? settingsDraft.pollSeconds : poll;

    applySettingsFieldValue("#cfgMinScoreRange", "#cfgMinScore", "#settingsScoreDisplay", scoreValue);
    applySettingsFieldValue("#cfgPollRange", "#cfgPoll", "#settingsPollDisplay", pollValue, "s");
    if (!keepDraft) clearSettingsDraft();
    if ($("#settingsProvider")) $("#settingsProvider").textContent = cfg.data_provider || "—";

    if ($("#settingsTelegramBadge")) {
      const tgOk = cfg.telegram_configured;
      $("#settingsTelegramBadge").textContent = tgOk ? "متصل" : "تنظیم نشده";
      $("#settingsTelegramBadge").className = `settings-status-badge ${tgOk ? "ok" : "bad"}`;
    }
    if ($("#settingsTelegramDesc")) {
      $("#settingsTelegramDesc").textContent = cfg.telegram_configured
        ? "توکن تلگرام در .env تنظیم شده"
        : "TELEGRAM_BOT_TOKEN تنظیم نشده";
    }
    if ($("#settingsNotifBadge")) {
      const paused = cfg.notifications_paused;
      $("#settingsNotifBadge").textContent = paused ? "متوقف" : "فعال";
      $("#settingsNotifBadge").className = `settings-status-badge ${paused ? "warn" : "ok"}`;
    }

    renderSettingsSymbolsCard(symbols);
  }

  function renderSettingsSymbolsCard(symbols) {
    const el = $("#settingsSymbolsCard");
    if (!el) return;
    if (!symbols.length) {
      el.innerHTML = '<p class="sym-preview-empty">هیچ نمادی انتخاب نشده — «انتخاب و مدیریت نمادها» را بزنید</p>';
      return;
    }
    el.innerHTML = symbols
      .map((sym) => {
        const cat = symbolCategory(sym);
        return `<button type="button" class="sym-preview-chip ${cat}" data-open-symbols title="ویرایش نمادها"><span class="sym-dot"></span>${esc(sym)}</button>`;
      })
      .join("");
    el.querySelectorAll("[data-open-symbols]").forEach((btn) => {
      btn.addEventListener("click", openSymbolsModal);
    });
  }

  function applyControlPage(data) {
    if (!data) return;
    const cfg = data.config || {};
    const info = STATUS_FA[data.overall] || STATUS_FA.unknown;

    if ($("#ctrlStatusDot")) $("#ctrlStatusDot").className = `status-indicator ${info.cls}`;
    if ($("#ctrlStatusLabel")) $("#ctrlStatusLabel").textContent = info.label;
    if ($("#ctrlStatusSub")) $("#ctrlStatusSub").textContent = info.sub || "مدیریت PM2، نوتیفیکیشن و عملیات موتور";
    if ($("#ctrlUpdated")) $("#ctrlUpdated").textContent = data.server_time ? `بروزرسانی ${data.server_time}` : "—";

    const chips = [];
    chips.push({
      cls: cfg.notifications_paused ? "warn" : "ok",
      text: cfg.notifications_paused ? "نوتیفیکیشن متوقف" : "نوتیفیکیشن فعال",
    });
    chips.push({
      cls: cfg.engine_debug ? "info" : "",
      text: cfg.engine_debug ? "Debug روشن" : "Debug خاموش",
    });
    chips.push({
      cls: cfg.telegram_configured ? "ok" : "bad",
      text: cfg.telegram_configured ? "تلگرام متصل" : "تلگرام تنظیم نشده",
    });
    if (data.engine_state?.startup_sent) chips.push({ cls: "info", text: "Startup ارسال شده" });

    const chipsEl = $("#controlStatusChips");
    if (chipsEl) {
      chipsEl.innerHTML = chips.map((c) => `<span class="ctrl-chip ${c.cls}">${c.text}</span>`).join("");
    }

    const cfgBar = $("#controlConfigBar");
    if (cfgBar) {
      const symList = parseSymbolsString(cfg.symbols || "");
      const symDisplay = symList.length ? symList.join(", ") : "—";
      cfgBar.innerHTML = [
        {
          lbl: "نمادها",
          val: symDisplay,
          action: true,
          hint: symList.length ? `${symList.length} نماد — کلیک برای مدیریت` : "کلیک برای افزودن",
        },
        { lbl: "حداقل امتیاز", val: cfg.min_score || "—" },
        { lbl: "فاصله بررسی", val: `${cfg.poll_seconds || "—"}s` },
        { lbl: "Provider", val: cfg.data_provider || "—" },
        { lbl: "Facebook", val: cfg.facebook_enable ? "فعال" : "غیرفعال" },
      ]
        .map((c) =>
          c.action
            ? `<button type="button" class="cfg-chip cfg-chip-action" id="cfgSymbolsChip" data-open-symbols>
                <span class="cfg-chip-lbl">${c.lbl}</span>
                <span class="cfg-chip-val">${esc(c.val)}</span>
                <span class="cfg-chip-action-hint">${c.hint}</span>
               </button>`
            : `<div class="cfg-chip"><span class="cfg-chip-lbl">${c.lbl}</span><span class="cfg-chip-val">${esc(String(c.val))}</span></div>`
        )
        .join("");
      $("#cfgSymbolsChip")?.addEventListener("click", openSymbolsModal);
    }

    lastEngineStateForSymbols = data.engine_state || null;
    renderSymbolsPreview(parseSymbolsString(cfg.symbols || ""), lastEngineStateForSymbols);
    fetchCooldowns().catch(() => {});

    if ($("#btnPauseNotif")) $("#btnPauseNotif").classList.toggle("active-state", !!cfg.notifications_paused);
    if ($("#btnResumeNotif")) $("#btnResumeNotif").classList.toggle("active-state", !cfg.notifications_paused);
    if ($("#btnToggleDebug")) $("#btnToggleDebug").classList.toggle("active-state", !!cfg.engine_debug);
  }

  function parseSymbolsString(raw) {
    if (!raw) return [];
    return raw
      .split(/[,;\n]+/)
      .map((s) => normalizeSymbolInput(s))
      .filter(Boolean);
  }

  function formatSymbolsString(list) {
    return list.join(",");
  }

  function normalizeSymbolInput(raw) {
    let s = String(raw || "").trim().toUpperCase().replace(/\s+/g, "");
    if (!s) return "";
    if (s.includes("/")) {
      const [a, b] = s.split("/");
      return a && b ? `${a}/${b}` : "";
    }
    if (s.length === 6) return `${s.slice(0, 3)}/${s.slice(3)}`;
    if (s.endsWith("USD") && s.length > 3) return `${s.slice(0, -3)}/USD`;
    if (s.startsWith("XAU") || s.startsWith("XAG")) {
      return s.length === 6 ? `${s.slice(0, 3)}/${s.slice(3)}` : s.replace(/(.{3})(.{3})/, "$1/$2");
    }
    return s;
  }

  function symbolCategory(sym) {
    const u = sym.toUpperCase();
    if (u.includes("XAU") || u.includes("XAG")) return "metal";
    if (u.includes("BTC") || u.includes("ETH")) return "crypto";
    return "forex";
  }

  function renderSymbolsPreview(symbols, engineState) {
    const el = $("#symbolsPreview");
    if (!el) return;
    if (!symbols.length) {
      el.innerHTML = '<p class="sym-preview-empty">نمادی تنظیم نشده — «مدیریت نمادها» را بزنید</p>';
      return;
    }
    el.innerHTML = symbols
      .map((sym) => {
        const cat = symbolCategory(sym);
        return `<button type="button" class="sym-preview-chip ${cat}" data-open-symbols title="مدیریت نمادها">
          <span class="sym-dot"></span>${esc(sym)}
        </button>`;
      })
      .join("");
    el.querySelectorAll("[data-open-symbols]").forEach((btn) => {
      btn.addEventListener("click", openSymbolsModal);
    });
  }

  function getEnabledSymbols() {
    return symbolsPool.filter((s) => symbolsEnabled.has(s));
  }

  function renderSymbolsPresets() {
    const el = $("#symbolsPresets");
    if (!el) return;
    el.innerHTML = SYMBOL_PRESETS.map((sym) => {
      const inPool = symbolsPool.includes(sym);
      const enabled = symbolsEnabled.has(sym);
      return `<button type="button" class="sym-preset-btn${inPool ? " added" : ""}" data-preset="${esc(sym)}">${inPool ? (enabled ? "✓ " : "○ ") : "+ "}${esc(sym)}</button>`;
    }).join("");
    el.querySelectorAll("[data-preset]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const sym = btn.dataset.preset;
        if (symbolsPool.includes(sym)) {
          toggleSymbolEnabled(sym, !symbolsEnabled.has(sym));
        } else {
          addSymbolToDraft(sym, { enabled: true });
        }
      });
    });
  }

  function renderSymbolsModalLists() {
    const listEl = $("#symbolsActiveList");
    const emptyEl = $("#symbolsEmptyHint");
    const countEl = $("#symbolsActiveCount");
    const enabledCount = getEnabledSymbols().length;
    if (countEl) countEl.textContent = `${enabledCount}/${symbolsPool.length}`;

    if (!listEl) return;

    if (!symbolsPool.length) {
      listEl.innerHTML = "";
      if (emptyEl) emptyEl.hidden = false;
    } else {
      if (emptyEl) emptyEl.hidden = true;
      listEl.innerHTML = symbolsPool
        .map((sym) => {
          const enabled = symbolsEnabled.has(sym);
          const cat = symbolCategory(sym);
          const counts = signalsSummary?.by_symbol || {};
          const count = counts[sym] ?? counts[sym.replace("/", "")] ?? 0;
          const countBadge = count ? `<span class="sym-signal-count" title="تعداد سیگنال">${count}</span>` : "";
          return `
        <div class="sym-track-row ${enabled ? "enabled" : "disabled"}">
          <input type="checkbox" class="sym-track-check" data-toggle="${esc(sym)}" ${enabled ? "checked" : ""} aria-label="ردیابی ${esc(sym)}" />
          <span class="sym-track-name">${esc(sym)}</span>
          ${countBadge}
          <span class="sym-track-cat ${cat}">${cat === "metal" ? "Metal" : cat === "crypto" ? "Crypto" : "Forex"}</span>
          <button type="button" class="sym-tag-remove" data-remove="${esc(sym)}" aria-label="حذف ${esc(sym)}">×</button>
        </div>`;
        })
        .join("");
      listEl.querySelectorAll("[data-toggle]").forEach((cb) => {
        cb.addEventListener("change", () => toggleSymbolEnabled(cb.dataset.toggle, cb.checked));
      });
      listEl.querySelectorAll("[data-remove]").forEach((btn) => {
        btn.addEventListener("click", () => removeSymbolFromDraft(btn.dataset.remove));
      });
    }

    const engineEl = $("#symbolsEngineList");
    if (engineEl) {
      const bars = lastEngineStateForSymbols?.last_bars || {};
      const signals = lastEngineStateForSymbols?.last_signal_at || {};
      const tracked = getEnabledSymbols();
      if (!tracked.length) {
        engineEl.innerHTML = '<p class="sym-hint">حداقل یک نماد را تیک بزنید تا ردیابی شود.</p>';
      } else {
        engineEl.innerHTML = tracked
          .map((sym) => {
            const key = Object.keys(signals).find((k) => k.replace("/", "") === sym.replace("/", "")) || sym;
            const sigTime = signals[key] || signals[sym] || null;
            const barTime = bars[key] || bars[sym] || null;
            const active = Boolean(sigTime || barTime);
            const meta = sigTime
              ? `آخرین سیگنال: ${esc(String(sigTime).split(" ")[1] || sigTime)}`
              : barTime
                ? `آخرین bar: ${esc(String(barTime))}`
                : "هنوز فعالیتی ثبت نشده";
            return `
            <div class="sym-engine-row">
              <span class="sym-name">${esc(sym)}</span>
              <span class="sym-meta">${meta}</span>
              <span class="sym-status ${active ? "ok" : "idle"}">${active ? "فعال" : "منتظر"}</span>
            </div>`;
          })
          .join("");
      }
    }

    renderSymbolsPresets();
    renderSettingsSymbolsCard(getEnabledSymbols());
    if ($("#settingsSymCount")) $("#settingsSymCount").textContent = enabledCount;
  }

  function toggleSymbolEnabled(sym, enabled) {
    if (enabled) symbolsEnabled.add(sym);
    else symbolsEnabled.delete(sym);
    renderSymbolsModalLists();
  }

  function openSymbolsModal() {
    const cfg = DataCache.get("status")?.config || {};
    const active = parseSymbolsString(cfg.symbols || $("#cfgSymbols")?.value || "");
    symbolsPool = [...active];
    symbolsEnabled = new Set(active);
    SYMBOL_PRESETS.forEach((sym) => {
      if (!symbolsPool.includes(sym)) symbolsPool.push(sym);
    });
    symbolsDraft = getEnabledSymbols();
    renderSymbolsModalLists();
    const overlay = $("#symbolsModalOverlay");
    if (overlay) {
      overlay.classList.add("open");
      overlay.setAttribute("aria-hidden", "false");
      document.body.style.overflow = "hidden";
      setTimeout(() => $("#symbolAddInput")?.focus(), 120);
    }
  }

  function closeSymbolsModal() {
    const overlay = $("#symbolsModalOverlay");
    if (overlay) {
      overlay.classList.remove("open");
      overlay.setAttribute("aria-hidden", "true");
      document.body.style.overflow = "";
    }
    const input = $("#symbolAddInput");
    if (input) input.value = "";
  }

  function addSymbolToDraft(raw, { enabled = true } = {}) {
    const sym = normalizeSymbolInput(raw);
    if (!sym) {
      toast("فرمت نماد نامعتبر است", "error");
      return false;
    }
    if (symbolsPool.includes(sym)) {
      if (enabled) symbolsEnabled.add(sym);
      renderSymbolsModalLists();
      return true;
    }
    if (symbolsPool.length >= MAX_SYMBOLS) {
      toast(`حداکثر ${MAX_SYMBOLS} نماد در لیست مجاز است`, "error");
      return false;
    }
    symbolsPool.push(sym);
    if (enabled) symbolsEnabled.add(sym);
    renderSymbolsModalLists();
    return true;
  }

  function removeSymbolFromDraft(sym) {
    symbolsPool = symbolsPool.filter((s) => s !== sym);
    symbolsEnabled.delete(sym);
    renderSymbolsModalLists();
  }

  async function saveSymbolsDraft() {
    const enabled = getEnabledSymbols();
    if (!enabled.length) {
      toast("حداقل یک نماد باید تیک خورده باشد", "error");
      return;
    }
    symbolsDraft = enabled;
    const btn = $("#symbolsModalSave");
    try {
      if (btn) btn.classList.add("loading");
      const value = formatSymbolsString(enabled);
      await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ SYMBOLS: value }),
      });
      if ($("#cfgSymbols")) $("#cfgSymbols").value = value;
      lastStatusFingerprint = null;
      invalidateCache("status", "bootstrap");
      applyConfigToDashboard({ symbols: value });
      await fetchStatus({ force: true });
      toast("نمادها ذخیره شد — برای اعمال کامل ربات را ری‌استارت کنید");
      logControlActivity(`نمادها بروز شد: ${enabled.join(", ")}`, "ok");
      closeSymbolsModal();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      if (btn) btn.classList.remove("loading");
    }
  }

  function logControlActivity(message, type = "ok") {
    const time = new Date().toLocaleTimeString("fa-IR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    controlActivity.unshift({ time, message, type });
    if (controlActivity.length > MAX_ACTIVITY) controlActivity.pop();
    renderControlActivity();
  }

  function renderControlActivity() {
    const el = $("#controlActivity");
    if (!el) return;
    if (!controlActivity.length) {
      el.innerHTML = '<li class="control-activity-empty">هنوز عملیاتی ثبت نشده</li>';
      return;
    }
    el.innerHTML = controlActivity
      .map(
        (a) => `
      <li>
        <span class="activity-time">${a.time}</span>
        <span class="activity-msg ${a.type}">${a.message}</span>
      </li>`
      )
      .join("");
  }

  function getSignalsFilterParams() {
    return {
      days: Number($("#signalDays")?.value || 30),
      delivery: $("#signalDelivery")?.value || "all",
      direction: $("#signalDirection")?.value || "all",
      outcome: $("#signalOutcome")?.value || "all",
    };
  }

  function resetSignalPage() {
    signalPage = 1;
  }

  function applySignalsPayload(payload) {
    if (!payload) return;
    const list = Array.isArray(payload) ? payload : payload.signals;
    const summary = Array.isArray(payload) ? null : payload.summary;
    if (list) {
      allSignals = list;
      renderSignals(list);
    }
    if (summary) {
      signalsSummary = summary;
      applySignalsPage(summary);
    }
  }

  function formatDuration(secs) {
    if (secs == null || secs <= 0) return "آماده";
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (h) return `${h}h ${m}m`;
    return `${m}m`;
  }

  function renderCooldownPanel(payload) {
    const list = $("#cooldownList");
    const meta = $("#cooldownMeta");
    if (!list || !payload) return;
    const rows = payload.symbols || [];
    const cooldownH = Math.round((payload.cooldown_seconds || 14400) / 3600);
    if (meta) meta.textContent = payload.generated_at ? `Cooldown ${cooldownH}h · ${payload.generated_at}` : `Cooldown ${cooldownH}h`;
    if (!rows.length) {
      list.innerHTML = '<p class="panel-empty">نمادی برای ردیابی تنظیم نشده</p>';
      return;
    }
    list.innerHTML = rows
      .map((row) => {
        const ready = row.ready;
        const pct = row.cooldown_seconds
          ? Math.max(0, Math.min(100, 100 - (row.remaining_seconds / row.cooldown_seconds) * 100))
          : 100;
        return `<div class="cooldown-row ${ready ? "ready" : "waiting"}">
          <div class="cooldown-row-head">
            <span class="cooldown-symbol">${esc(row.symbol)}</span>
            <span class="cooldown-badge ${ready ? "ready" : "wait"}">${ready ? "آماده" : formatDuration(row.remaining_seconds)}</span>
          </div>
          <div class="cooldown-bar"><span style="width:${ready ? 100 : pct}%"></span></div>
          <span class="cooldown-last">${row.last_signal_at ? `آخرین: ${esc(row.last_signal_at)}` : "هنوز سیگنالی نداده"}</span>
        </div>`;
      })
      .join("");
  }

  async function fetchCooldowns({ force = false } = {}) {
    if (!force && isBootstrapFresh() && DataCache.get("cooldowns")) {
      renderCooldownPanel(DataCache.get("cooldowns"));
      return DataCache.get("cooldowns");
    }
    const data = await DataCache.load(
      "cooldowns",
      () => api("/api/analytics/cooldowns"),
      CACHE_TTL.cooldowns,
      { force, onStale: (d) => renderCooldownPanel(d) }
    );
    renderCooldownPanel(data);
    return data;
  }

  function renderSymbolReportTable(rows, meta) {
    const body = $("#symbolReportBody");
    if ($("#symbolReportMeta") && meta) $("#symbolReportMeta").textContent = meta;
    if (!body) return;
    if (!rows?.length) {
      body.innerHTML = '<tr><td colspan="8" class="panel-empty">داده‌ای یافت نشد</td></tr>';
      return;
    }
    body.innerHTML = rows
      .map(
        (r) => `<tr>
          <td class="sym-cell">${esc(r.symbol)}</td>
          <td>${r.total}</td>
          <td class="buy-cell">${r.buy}</td>
          <td class="sell-cell">${r.sell}</td>
          <td class="win-cell">${r.wins}</td>
          <td class="loss-cell">${r.losses}</td>
          <td>${r.win_rate != null ? `${r.win_rate}%` : "—"}</td>
          <td>${r.delivery_rate != null ? `${r.delivery_rate}%` : "—"}</td>
        </tr>`
      )
      .join("");
  }

  function renderHourlyHeatmap(hours) {
    const canvas = $("#hourlyHeatmapChart");
    if (!canvas || !hours) return;
    prepareChartCanvas(canvas);
    try {
      const labels = hours.map((h) => h.label);
      const totals = hours.map((h) => h.total);
      const buys = hours.map((h) => h.buy);
      const sells = hours.map((h) => h.sell);
      if (hourlyHeatmapChart) {
        hourlyHeatmapChart.data.labels = labels;
        hourlyHeatmapChart.data.datasets[0].data = totals;
        hourlyHeatmapChart.data.datasets[1].data = buys;
        hourlyHeatmapChart.data.datasets[2].data = sells;
        hourlyHeatmapChart.update("none");
        return;
      }
      hourlyHeatmapChart = new Chart(canvas, {
        type: "bar",
        data: {
          labels,
          datasets: [
            { label: "کل", data: totals, backgroundColor: "rgba(99,255,208,0.55)", borderRadius: 4 },
            { label: "BUY", data: buys, backgroundColor: "rgba(74,222,128,0.65)", borderRadius: 4 },
            { label: "SELL", data: sells, backgroundColor: "rgba(248,113,113,0.65)", borderRadius: 4 },
          ],
        },
        options: {
          ...chartDefaults(),
          scales: {
            x: { ticks: { color: "#5c6578", font: { size: 9 }, maxRotation: 0 }, grid: { display: false } },
            y: { beginAtZero: true, ticks: { color: "#5c6578", stepSize: 1 }, grid: { color: "rgba(255,255,255,0.04)" } },
          },
          plugins: { legend: { position: "bottom", rtl: false, textDirection: "ltr", labels: { color: "#8b95a8", font: chartFont(9), boxWidth: 10 } } },
        },
      });
      logClientEvent("chart-created", {
        chart: "hourlyHeatmap",
        dims: { canvas: { w: canvas.clientWidth, h: canvas.clientHeight }, box: canvas.parentElement?.clientWidth ? { w: canvas.parentElement.clientWidth, h: canvas.parentElement.clientHeight } : null },
        devicePixelRatio: window.devicePixelRatio || 1,
      });
    } catch (err) {
      reportClientError("renderHourlyHeatmap", err, { hasChart: !!window.Chart, canvas: { w: canvas.clientWidth, h: canvas.clientHeight } });
    }
  }

  async function fetchReportAnalytics(days = 30, { force = false } = {}) {
    const key = `analytics:${days}`;
    if (!force && days === 30 && isBootstrapFresh() && DataCache.get(key)) {
      const cached = DataCache.get(key);
      applyAnalyticsPayload(cached, days);
      return cached;
    }
    await waitForBootstrap();
    const data = await DataCache.load(
      key,
      async () => {
        const [symbols, hourly] = await Promise.all([
          api(`/api/analytics/symbols?days=${days}`),
          api(`/api/analytics/hourly?days=${days}`),
        ]);
        return { symbols, hourly };
      },
      CACHE_TTL.analytics,
      {
        force,
        onStale: (payload) => applyAnalyticsPayload(payload, days),
      }
    );
    applyAnalyticsPayload(data, days);
    return data;
  }

  function renderUptimeHistory(payload) {
    const el = $("#uptimeHistory");
    if (!el) return;
    const rows = payload?.processes || [];
    if ($("#uptimeHistoryMeta") && payload?.generated_at) {
      $("#uptimeHistoryMeta").textContent = payload.generated_at;
    }
    if (!rows.length) {
      el.innerHTML = '<p class="panel-empty">داده PM2 در دسترس نیست</p>';
      return;
    }
    el.innerHTML = rows
      .map(
        (p) => `<div class="uptime-row">
          <div class="uptime-row-head">
            <span class="uptime-name">${esc(p.name)}</span>
            <span class="uptime-badge">${p.restarts_24h ?? 0} restart / 24h</span>
          </div>
          <div class="uptime-meta">Uptime: ${esc(p.uptime_human || "—")} · Total restarts: ${p.restarts_total ?? 0}</div>
          ${p.events_24h?.length ? `<div class="uptime-events">${p.events_24h.map((e) => `<span>${esc(e)}</span>`).join("")}</div>` : ""}
        </div>`
      )
      .join("");
  }

  async function fetchUptimeHistory({ force = false } = {}) {
    if (!force && isBootstrapFresh() && DataCache.get("uptime")) {
      renderUptimeHistory(DataCache.get("uptime"));
      return DataCache.get("uptime");
    }
    const data = await DataCache.load(
      "uptime",
      () => api("/api/ops/uptime"),
      CACHE_TTL.uptime,
      { force, onStale: (d) => renderUptimeHistory(d) }
    );
    renderUptimeHistory(data);
    return data;
  }

  function applyOpsConfig(cfg) {
    if (!cfg) return;
    if ($("#opsAlertCpu")) $("#opsAlertCpu").value = cfg.alert_cpu_threshold ?? 90;
    if ($("#opsAlertRam")) $("#opsAlertRam").value = cfg.alert_ram_threshold ?? 90;
    if ($("#opsAlertDisk")) $("#opsAlertDisk").value = cfg.alert_disk_threshold ?? 92;
    if ($("#opsWebhookDiscord")) $("#opsWebhookDiscord").value = cfg.webhook_discord_url || "";
    if ($("#opsWebhookSlack")) $("#opsWebhookSlack").value = cfg.webhook_slack_url || "";
    if ($("#opsWebhookOnSignal")) $("#opsWebhookOnSignal").checked = !!cfg.webhook_on_signal;
    if ($("#opsMaintenanceEnabled")) $("#opsMaintenanceEnabled").checked = !!cfg.maintenance_enabled;
    if ($("#opsMaintenanceWindow")) $("#opsMaintenanceWindow").value = cfg.maintenance_window || "22:00-06:00";
    if ($("#opsBrowserNotif")) $("#opsBrowserNotif").checked = browserNotifEnabled;
  }

  async function fetchOpsConfig({ force = false } = {}) {
    if (!force && isBootstrapFresh() && DataCache.get("ops")) {
      applyOpsConfig(DataCache.get("ops"));
      return DataCache.get("ops");
    }
    const data = await DataCache.load(
      "ops",
      () => api("/api/ops/config"),
      CACHE_TTL.ops,
      { force, onStale: (d) => applyOpsConfig(d) }
    );
    applyOpsConfig(data);
    return data;
  }

  async function saveOpsConfig() {
    const payload = {
      alert_cpu_threshold: Number($("#opsAlertCpu")?.value || 90),
      alert_ram_threshold: Number($("#opsAlertRam")?.value || 90),
      alert_disk_threshold: Number($("#opsAlertDisk")?.value || 92),
      webhook_discord_url: $("#opsWebhookDiscord")?.value?.trim() || "",
      webhook_slack_url: $("#opsWebhookSlack")?.value?.trim() || "",
      webhook_on_signal: $("#opsWebhookOnSignal")?.checked,
      maintenance_enabled: $("#opsMaintenanceEnabled")?.checked,
      maintenance_window: $("#opsMaintenanceWindow")?.value?.trim() || "22:00-06:00",
    };
    browserNotifEnabled = !!$("#opsBrowserNotif")?.checked;
    safeLocalStorageSet("tc:browser-notif", browserNotifEnabled ? "1" : "0");
    if (browserNotifEnabled) await requestBrowserNotifPermission();
    const data = await api("/api/ops/config", { method: "PATCH", body: JSON.stringify(payload) });
    applyOpsConfig(data.config);
    invalidateCache("ops", "status", "system");
    toast("تنظیمات عملیات ذخیره شد");
  }

  function renderAuditLog(entries) {
    const el = $("#auditLog");
    if (!el) return;
    if (!entries?.length) {
      el.innerHTML = '<p class="panel-empty">هنوز رویدادی ثبت نشده</p>';
      return;
    }
    el.innerHTML = entries
      .map(
        (e) => `<div class="audit-row">
          <span class="audit-ts">${esc(e.ts || "")}</span>
          <span class="audit-user">${esc(e.user || "—")}</span>
          <span class="audit-action">${esc(e.action || "")}</span>
          <span class="audit-detail">${esc(e.detail || "")}</span>
        </div>`
      )
      .join("");
  }

  async function fetchAuditLog({ force = false } = {}) {
    const data = await DataCache.load("audit", () => api("/api/audit?limit=80"), CACHE_TTL.logs, { force });
    renderAuditLog(data.entries || []);
    return data;
  }

  async function openChangelogModal() {
    try {
      const res = await fetch("/api/changelog");
      const data = await res.json();
      const current = data.current || {};
      if ($("#changelogCurrent")) {
        $("#changelogCurrent").textContent = `${current.label || ""} · ${current.released || ""}`;
      }
      const body = $("#changelogBody");
      if (body) {
        const history = data.history || [];
        body.innerHTML = history.length
          ? history
              .map(
                (h) => `<article class="changelog-item">
                  <div class="changelog-head"><strong>${esc(h.label || h.version || "")}</strong><span>${esc(h.date || "")}</span></div>
                  <p>${esc(h.title || "")}</p>
                </article>`
              )
              .join("")
          : '<p class="panel-empty">تاریخچه‌ای موجود نیست</p>';
      }
      $("#changelogModalOverlay")?.classList.add("open");
      $("#changelogModalOverlay")?.setAttribute("aria-hidden", "false");
    } catch {
      toast("خطا در بارگذاری changelog", "error");
    }
  }

  function closeChangelogModal() {
    $("#changelogModalOverlay")?.classList.remove("open");
    $("#changelogModalOverlay")?.setAttribute("aria-hidden", "true");
  }

  async function requestBrowserNotifPermission() {
    if (!("Notification" in window)) {
      toast("مرورگر از نوتیفیکیشن پشتیبانی نمی‌کند", "error");
      return false;
    }
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") return false;
    const perm = await Notification.requestPermission();
    return perm === "granted";
  }

  function pushBrowserNotification(title, body, tag = "tradechi") {
    if (!browserNotifEnabled || !("Notification" in window) || Notification.permission !== "granted") return;
    try {
      new Notification(title, { body, tag, icon: "/static/favicon.ico" });
    } catch {}
  }

  function handleResourceAlerts(sys) {
    const alerts = sys?.alerts || [];
    alerts.forEach((a) => {
      const key = `${a.type}:${a.threshold}:${Math.floor(Date.now() / 300000)}`;
      if (firedAlertKeys.has(key)) return;
      firedAlertKeys.add(key);
      toast(a.message, "error");
      pushBrowserNotification("TradeChi Alert", a.message, `alert-${a.type}`);
    });
    if (firedAlertKeys.size > 50) firedAlertKeys.clear();
  }

  function handleLiveNotifications(data) {
    if (!data) return;
    if (data.overall !== lastOverallStatus) {
      if (lastOverallStatus && data.overall === "stopped") {
        toast("موتور ربات متوقف شد", "error");
        pushBrowserNotification("TradeChi", "Engine stopped", "engine-down");
      }
      lastOverallStatus = data.overall;
    }
    const sig = data.latest_signal;
    if (sig && typeof sig === "object") {
      const key = `${sig.symbol}:${sig.timestamp}:${sig.direction}`;
      if (lastSignalNotifKey && key !== lastSignalNotifKey) {
        const dir = (sig.direction || "").toUpperCase();
        const msg = `${dir} ${sig.symbol || "?"}`;
        pushBrowserNotification("سیگنال جدید", msg, `signal-${key}`);
      }
      lastSignalNotifKey = key;
    }
    if (data.uptime_history) renderUptimeHistory(data.uptime_history);
  }

  function applyReportData(data, days = 30) {
    if (!data) return;
    reportPayloadCache.set(days, data);
    logClientEvent("report-apply", {
      days,
      total: data.total ?? null,
      daily: data.daily?.length || 0,
      bySymbol: data.by_symbol ? Object.keys(data.by_symbol).length : 0,
      byDirection: data.by_direction ? Object.keys(data.by_direction).length : 0,
      viewport: { w: window.innerWidth, h: window.innerHeight },
    });
    if (days === 7) {
      renderHomeSparkline(data.daily);
      return;
    }
    if ($("#rptAvg")) $("#rptAvg").textContent = data.avg_per_day;
    if ($("#rptTop")) $("#rptTop").textContent = data.top_symbol;
    if ($("#rptRatio")) $("#rptRatio").textContent = data.buy_sell_ratio;
    if ($("#rptRestarts")) $("#rptRestarts").textContent = data.total_restarts;
    const tg = data.telegram || {};
    if ($("#rptTgSent")) $("#rptTgSent").textContent = tg.signals_sent ?? "—";
    if ($("#rptTgRate")) $("#rptTgRate").textContent = tg.success_rate != null ? `${tg.success_rate}%` : "—";
    if ($("#reportGenerated")) {
      $("#reportGenerated").textContent = `بروزرسانی: ${data.generated_at} · ${data.total} سیگنال · ${tg.signals_sent ?? 0} تلگرام در ${days} روز`;
    }
    renderDailyChart(data.daily);
    renderDirectionChart(data.by_direction?.BUY || 0, data.by_direction?.SELL || 0);
    renderSymbolBarChart(data.by_symbol || {});
    renderTelegramReportChart(tg.daily || []);
  }

  function applyTelegramData(payload) {
    if (!payload) return;
    const summary = payload.summary || payload;
    const entries = payload.entries || [];
    allTelegramEntries = entries;
    renderTelegramPage(summary, entries);
  }

  function renderTelegramPage(summary, entries) {
    const configured = summary.telegram_configured !== false;
    const paused = summary.notifications_paused;
    const label = !configured ? "تلگرام تنظیم نشده" : paused ? "نوتیفیکیشن متوقف" : "تلگرام فعال";
    const cls = !configured ? "stopped" : paused ? "partial" : "running";
    if ($("#tgStatusLabel")) $("#tgStatusLabel").textContent = label;
    if ($("#tgStatusDot")) $("#tgStatusDot").className = `status-indicator ${cls}`;
    if ($("#tgUpdated")) $("#tgUpdated").textContent = summary.generated_at ? `بروزرسانی ${summary.generated_at}` : "—";
    if ($("#tgSub")) {
      $("#tgSub").textContent = configured
        ? "تاریخچه کامل سیگنال‌های ارسال‌شده و خطاهای تلگرام"
        : "توکن تلگرام در .env تنظیم نشده";
    }
    if ($("#tgOkTotal")) $("#tgOkTotal").textContent = summary.signals_sent ?? 0;
    if ($("#tgFailTotal")) $("#tgFailTotal").textContent = summary.failed ?? 0;
    if ($("#tgRateTotal")) $("#tgRateTotal").textContent = `${summary.success_rate ?? 0}%`;
    if ($("#tgTodayOk")) $("#tgTodayOk").textContent = summary.today_ok ?? 0;
    if ($("#tgTodayFail")) $("#tgTodayFail").textContent = summary.today_failed ?? 0;
    const topSym = summary.by_symbol && Object.keys(summary.by_symbol).length
      ? Object.entries(summary.by_symbol).sort((a, b) => b[1] - a[1])[0][0]
      : "—";
    if ($("#tgTopSymbol")) $("#tgTopSymbol").textContent = topSym;
    renderTelegramFeed(entries);
  }

  function renderTelegramFeed(entries) {
    const feed = $("#telegramFeed");
    if (!feed) return;
    const q = ($("#telegramSearch")?.value || "").trim().toUpperCase();
    const filtered = q
      ? entries.filter((e) => (e.symbol || "").toUpperCase().includes(q) || (e.detail || "").toUpperCase().includes(q))
      : entries;
    const totalPages = Math.max(1, Math.ceil(filtered.length / 10));
    telegramPage = Math.min(Math.max(1, telegramPage), totalPages);
    const start = (telegramPage - 1) * 10;
    const pageEntries = filtered.slice(start, start + 10);

    if ($("#tgFeedCount")) {
      const pageStart = filtered.length ? start + 1 : 0;
      const pageEnd = Math.min(start + 10, filtered.length);
      $("#tgFeedCount").textContent = filtered.length
        ? `${pageStart}-${pageEnd} از ${filtered.length}`
        : "0 مورد";
    }

    feed.innerHTML = pageEntries.length
      ? pageEntries.map((e, i) => {
          const ok = e.ok;
          const dir = (e.direction || "").toUpperCase();
          const retryBtn = !ok
            ? `<button type="button" class="btn btn-sm tg-retry-btn" data-retry-symbol="${esc(e.symbol || "")}" data-retry-ts="${esc(e.timestamp || "")}" data-retry-dir="${esc(dir)}" data-retry-entry="${esc(String(e.entry || ""))}">↻ ارسال مجدد</button>`
            : "";
          return `
        <article class="telegram-item ${ok ? "ok" : "failed"}" style="animation-delay:${i * 0.03}s">
          <div class="tg-item-head">
            <span class="tg-badge ${ok ? "ok" : "failed"}">${ok ? "✓ ارسال موفق" : "✗ خطا"}</span>
            <span class="tg-time">${e.timestamp || "—"}</span>
          </div>
          <div class="tg-item-body">
            <div class="tg-item-main">
              <span class="tg-symbol">${e.symbol || "—"}</span>
              ${dir ? `<span class="sig-badge ${dir === "BUY" ? "buy" : "sell"}">${dir}</span>` : ""}
              ${e.score != null ? `<span class="tg-score">score ${e.score}</span>` : ""}
            </div>
            <p class="tg-detail">${esc(e.detail || (ok ? "ارسال موفق" : "ارسال ناموفق"))}</p>
            ${e.entry ? `<span class="tg-meta">Entry: ${e.entry}</span>` : ""}
            ${e.error ? `<span class="tg-error">${esc(e.error)}</span>` : ""}
            ${retryBtn}
          </div>
        </article>`;
        }).join("")
      : '<p class="telegram-empty">موردی یافت نشد</p>';
    renderTelegramPagination(filtered.length, totalPages);
  }

  function renderTelegramPagination(totalItems, totalPages) {
    const nav = $("#telegramPagination");
    if (!nav) return;
    if (totalItems <= 10 || totalPages <= 1) {
      nav.innerHTML = "";
      nav.hidden = true;
      return;
    }
    nav.hidden = false;
    const pages = [];
    for (let p = 1; p <= totalPages; p += 1) {
      if (p === 1 || p === totalPages || Math.abs(p - telegramPage) <= 1) {
        pages.push(p);
      } else if (pages[pages.length - 1] !== "...") {
        pages.push("...");
      }
    }
    nav.innerHTML = `
      <button type="button" class="sig-page-btn prev" data-telegram-page="${telegramPage - 1}" ${telegramPage <= 1 ? "disabled" : ""}>قبلی</button>
      <div class="sig-page-list">
        ${pages.map((p) => p === "..."
          ? '<span class="sig-page-ellipsis">...</span>'
          : `<button type="button" class="sig-page-btn num ${p === telegramPage ? "active" : ""}" data-telegram-page="${p}" aria-current="${p === telegramPage ? "page" : "false"}">${p}</button>`
        ).join("")}
      </div>
      <button type="button" class="sig-page-btn next" data-telegram-page="${telegramPage + 1}" ${telegramPage >= totalPages ? "disabled" : ""}>بعدی</button>
      <span class="sig-page-summary">صفحه ${telegramPage} از ${totalPages}</span>
    `;
  }

  async function retryTelegramSend(btn) {
    if (!btn || btn.classList.contains("loading")) return;
    const payload = {
      symbol: btn.dataset.retrySymbol,
      timestamp: btn.dataset.retryTs,
      direction: btn.dataset.retryDir,
      entry: btn.dataset.retryEntry || undefined,
    };
    try {
      btn.classList.add("loading");
      btn.disabled = true;
      const data = await api("/api/telegram/retry", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      toast(data.message || "ارسال مجدد انجام شد");
      invalidateCache("telegram:*", "status", "bootstrap");
      await fetchTelegram({ force: true });
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.classList.remove("loading");
      btn.disabled = false;
    }
  }

  async function sendTelegramTest(btn) {
    if (btn?.classList.contains("loading")) return;
    try {
      btn?.classList.add("loading");
      const data = await api("/api/telegram/test", { method: "POST", body: "{}" });
      toast(data.message || "پیام تست ارسال شد");
      invalidateCache("telegram:*", "status", "bootstrap");
      if (activePage === "telegram") await fetchTelegram({ force: true });
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn?.classList.remove("loading");
    }
  }

  function renderTelegramReportChart(daily) {
    const canvas = $("#telegramReportChart");
    if (!canvas || !daily) return;
    prepareChartCanvas(canvas);
    try {
      const labels = daily.map((d) => d.date.slice(5));
      const ok = daily.map((d) => d.ok || 0);
      const failed = daily.map((d) => d.failed || 0);
      if (telegramReportChart) {
        telegramReportChart.data.labels = labels;
        telegramReportChart.data.datasets[0].data = ok;
        telegramReportChart.data.datasets[1].data = failed;
        telegramReportChart.update("none");
        return;
      }
      telegramReportChart = new Chart(canvas, {
        type: "bar",
        data: {
          labels,
          datasets: [
            { label: "موفق", data: ok, backgroundColor: "rgba(74,222,128,0.75)", borderRadius: 4 },
            { label: "ناموفق", data: failed, backgroundColor: "rgba(248,113,113,0.75)", borderRadius: 4 },
          ],
        },
        options: {
          ...chartDefaults(),
          scales: {
          x: { stacked: true, ticks: { color: "#5c6578", font: chartFont(9) }, grid: { display: false } },
          y: { stacked: true, beginAtZero: true, ticks: { color: "#5c6578", stepSize: 1, font: chartFont(9) }, grid: { color: "rgba(255,255,255,0.04)" } },
        },
        plugins: { legend: { position: "bottom", rtl: false, textDirection: "ltr", labels: { color: "#8b95a8", font: chartFont(9) } } },
      },
      });
      logClientEvent("chart-created", {
        chart: "telegramReport",
        dims: { canvas: { w: canvas.clientWidth, h: canvas.clientHeight }, box: canvas.parentElement?.clientWidth ? { w: canvas.parentElement.clientWidth, h: canvas.parentElement.clientHeight } : null },
        devicePixelRatio: window.devicePixelRatio || 1,
      });
    } catch (err) {
      reportClientError("renderTelegramReportChart", err, { hasChart: !!window.Chart, canvas: { w: canvas.clientWidth, h: canvas.clientHeight } });
    }
  }

  function applyBootstrap(payload) {
    if (!payload) return;
    if (payload.version) applyVersion(payload.version);
    if (payload.status) {
      DataCache.set("status", payload.status);
      applyStatusData(payload.status);
    }
    if (payload.system) {
      DataCache.set("system", payload.system);
      updateSystem(payload.system);
    } else {
      syncMonitorHero();
    }
    if (payload.signals) {
      const sigKey = signalsCacheKey(30, "all", "all", "all");
      DataCache.set(sigKey, payload.signals);
      applySignalsPayload(payload.signals);
    }
    if (payload.report_7) {
      DataCache.set("report:7", payload.report_7);
      applyReportData(payload.report_7, 7);
    }
    if (payload.report_30) {
      DataCache.set("report:30", payload.report_30);
    }
    if (payload.telegram) {
      const tgPayload = payload.telegram.entries
        ? payload.telegram
        : { summary: payload.telegram, entries: [] };
      DataCache.set("telegram:30:all", tgPayload);
      applyTelegramData(tgPayload);
    }
    if (payload.ops) {
      DataCache.set("ops", payload.ops);
      applyOpsConfig(payload.ops);
    }
    if (payload.cooldowns) {
      DataCache.set("cooldowns", payload.cooldowns);
      renderCooldownPanel(payload.cooldowns);
    }
    if (payload.uptime) {
      DataCache.set("uptime", payload.uptime);
      renderUptimeHistory(payload.uptime);
    }
    if (payload.analytics_30) {
      DataCache.set("analytics:30", payload.analytics_30);
      if (activePage === "reports" && Number($("#reportDays")?.value || 30) === 30) {
        applyAnalyticsPayload(payload.analytics_30, 30);
      }
    }
    DataCache.set("bootstrap", payload);
    bootstrapCompletedAt = Date.now();
  }

  function applyPageFromCache(page) {
    switch (page) {
      case "home": {
        const status = DataCache.get("status");
        const report = DataCache.get("report:7");
        if (status) applyStatusData(status);
        if (report) applyReportData(report, 7);
        break;
      }
      case "monitor": {
        const status = DataCache.get("status");
        const sys = DataCache.get("system");
        const uptime = DataCache.get("uptime");
        if (status) {
          renderEngineState(status.engine_state);
          renderMonitorProcesses(status.processes);
        }
        if (sys) updateSystem(sys);
        else syncMonitorHero();
        if (uptime) renderUptimeHistory(uptime);
        requestAnimationFrame(() => {
          refreshMonitorLiveCharts({ recreate: true });
          setTimeout(() => refreshMonitorLiveCharts(), 400);
        });
        break;
      }
      case "control": {
        const status = DataCache.get("status");
        const cooldowns = DataCache.get("cooldowns");
        if (status) applyStatusData(status);
        if (cooldowns) renderCooldownPanel(cooldowns);
        break;
      }
      case "signals": {
        const { days, delivery, direction, outcome } = getSignalsFilterParams();
        const cached = DataCache.get(signalsCacheKey(days, delivery, direction, outcome));
        if (cached) applySignalsPayload(cached);
        break;
      }
      case "simulation": {
        const days = Number($("#simDays")?.value || 30);
        const symbol = $("#simSymbol")?.value || "all";
        const status = $("#simStatus")?.value || "all";
        const cached = DataCache.get(`simulation:${days}:${symbol}:${status}:${simulationPage}`);
        if (cached) renderSimulation(cached);
        break;
      }
      case "reports": {
        const days = Number($("#reportDays")?.value || 30);
        const report = DataCache.get(reportCacheKey(days));
        const analytics = DataCache.get(`analytics:${days}`);
        if (report) applyReportData(report, days);
        if (analytics) {
          renderSymbolReportTable(analytics.symbols?.symbols, analytics.symbols?.generated_at ? `بروزرسانی ${analytics.symbols.generated_at}` : null);
          renderHourlyHeatmap(analytics.hourly?.hours || []);
        }
        requestAnimationFrame(() => {
          rebuildReportCharts(days);
          setTimeout(() => rebuildReportCharts(days), 120);
          setTimeout(() => rebuildReportCharts(days), 300);
        });
        break;
      }
      case "telegram": {
        const days = Number($("#telegramDays")?.value || 30);
        const status = $("#telegramStatus")?.value || "all";
        const cached = DataCache.get(telegramCacheKey(days, status));
        if (cached) applyTelegramData(cached);
        break;
      }
      case "facebook": {
        const cached = DataCache.get("facebook");
        if (cached) renderFacebook(cached);
        break;
      }
      case "settings": {
        const status = DataCache.get("status");
        const ops = DataCache.get("ops");
        const audit = DataCache.get("audit");
        if (status) applySettingsPage(status);
        if (ops) applyOpsConfig(ops);
        if (audit) renderAuditLog(audit.entries || []);
        fetchStrategy().catch(() => {});
        break;
      }
      case "logs": {
        const process = $("#logSelect")?.value || "signal-engine";
        const cached = DataCache.get(logsCacheKey(process));
        if (cached) applyLogs(cached);
        break;
      }
      default:
        break;
    }
  }

  function applyLogs(lines) {
    const body = $("#terminalBody");
    if (!body || !lines) return;
    body.innerHTML = lines.map(colorizeLog).join("\n");
    body.scrollTop = body.scrollHeight;
  }

  async function fetchStatus({ force = false } = {}) {
    if (!force && isBootstrapFresh() && DataCache.get("status")) {
      const cached = DataCache.get("status");
      applyStatusData(cached);
      return cached;
    }
    await waitForBootstrap();
    const data = await DataCache.load(
      "status",
      () => api("/api/status"),
      CACHE_TTL.status,
      { force, onStale: (d) => applyStatusData(d) }
    );
    applyStatusData(data);
    return data;
  }

  async function fetchSystem({ force = false } = {}) {
    if (!force && isBootstrapFresh() && DataCache.get("system")) {
      const cached = DataCache.get("system");
      updateSystem(cached);
      return cached;
    }
    await waitForBootstrap();
    const data = await DataCache.load(
      "system",
      () => api("/api/system"),
      CACHE_TTL.system,
      { force, onStale: (d) => updateSystem(d) }
    );
    updateSystem(data);
    return data;
  }

  async function fetchSignals({ force = false } = {}) {
    const { days, delivery, direction, outcome } = getSignalsFilterParams();
    const key = signalsCacheKey(days, delivery, direction, outcome);
    if (!force && days === 30 && delivery === "all" && direction === "all" && outcome === "all" && isBootstrapFresh()) {
      const cached = DataCache.get(key);
      if (cached) {
        applySignalsPayload(cached);
        return cached;
      }
    }
    await waitForBootstrap();
    const data = await DataCache.load(
      key,
      () => api(`/api/signals?days=${days}&delivery=${delivery}&direction=${direction}&outcome=${outcome}&limit=100`),
      CACHE_TTL.signals,
      { force, onStale: (d) => applySignalsPayload(d) }
    );
    applySignalsPayload(data);
    return data;
  }

  async function fetchReport(days = 30, { force = false } = {}) {
    const key = reportCacheKey(days);
    if (!force && isBootstrapFresh() && DataCache.get(key)) {
      const cached = DataCache.get(key);
      applyReportData(cached, days);
      return cached;
    }
    await waitForBootstrap();
    const data = await DataCache.load(
      key,
      () => api(`/api/reports/summary?days=${days}`),
      CACHE_TTL.report,
      { force, onStale: (d) => applyReportData(d, days) }
    );
    applyReportData(data, days);
    return data;
  }

  function setFacebookReadyCard(selector, ok, text) {
    const card = $(selector);
    if (!card) return;
    card.classList.toggle("ok", !!ok);
    card.classList.toggle("bad", !ok);
    const value = card.querySelector("span:last-child");
    if (value) value.textContent = text;
  }

  function setFacebookSessionState(state, detail = "", cookies = null) {
    const panel = $(".facebook-session-panel");
    const title = $("#fbSessionStateTitle");
    const description = $("#fbSessionStateDetail");
    if (!panel || !title || !description) return;
    const states = {
      missing: ["سشن اضافه نشده", "ابتدا فایل JSON کوکی‌های فیسبوک را انتخاب کنید."],
      untested: ["فایل دریافت شد؛ نیازمند تست", cookies ? `${cookies} کوکی ذخیره شده است. اکنون اتصال حساب را تست کنید.` : "برای تأیید اعتبار کوکی‌ها، تست اتصال را اجرا کنید."],
      testing: ["در حال تست اتصال", "مرورگر امن سرور در حال بررسی ورود به حساب فیسبوک است..."],
      connected: ["حساب متصل است", cookies ? `ورود با ${cookies} کوکی فعال تأیید شد.` : "ورود به حساب فیسبوک با موفقیت تأیید شد."],
      failed: ["اتصال تأیید نشد", "سشن منقضی یا نامعتبر است؛ فایل تازه‌ای بارگذاری و دوباره تست کنید."],
    };
    const selected = states[state] || states.untested;
    panel.dataset.sessionState = state;
    title.textContent = selected[0];
    description.textContent = detail || selected[1];
  }

  function setFacebookButtonBusy(button, busy, busyLabel) {
    if (!button) return;
    const label = button.querySelector(".fb-button-label");
    if (!button.dataset.idleLabel && label) button.dataset.idleLabel = label.textContent;
    button.classList.toggle("loading", busy);
    button.disabled = busy;
    button.setAttribute("aria-busy", busy ? "true" : "false");
    if (label) label.textContent = busy ? busyLabel : button.dataset.idleLabel;
  }

  function renderFacebook(data) {
    if (!data) return;
    facebookPayload = data;
    const status = data.status || {};
    const groups = data.groups || [];
    const groupQuery = ($("#fbGroupSearch")?.value || "").trim().toLowerCase();
    const shownGroups = groupQuery
      ? groups.filter((group) => `${group.name} ${group.url}`.toLowerCase().includes(groupQuery))
      : groups;
    const jobs = data.jobs || [];
    const activeGroups = groups.filter((group) => group.enabled);
    const sessionStatus = data.session_status || {};
    const sessionState = status.session_file ? (sessionStatus.state || "untested") : "missing";
    setFacebookSessionState(sessionState, "", sessionStatus.cookies);
    const testButton = $("#btnFbTestSession");
    if (testButton && !testButton.classList.contains("loading")) testButton.disabled = !status.session_file;
    if ($("#fbStatusDot")) $("#fbStatusDot").className = `status-indicator ${status.ready ? "running" : "stopped"}`;
    if ($("#fbStatusLabel")) $("#fbStatusLabel").textContent = status.ready ? "آماده ارسال" : "نیاز به تکمیل";
    if ($("#fbSessionMeta")) $("#fbSessionMeta").textContent = data.session_updated ? `سشن: ${data.session_updated}` : "سشن تنظیم نشده";
    if ($("#fbAutoPost")) $("#fbAutoPost").checked = !!data.auto_post;
    if ($("#fbModeText")) $("#fbModeText").textContent = data.auto_post ? "ارسال خودکار" : "تأیید دستی";
    setFacebookReadyCard("#fbReadyChrome", status.chrome && status.selenium, status.chrome && status.selenium ? "فعال و آماده" : "نیاز به نصب");
    setFacebookReadyCard("#fbReadySession", status.session_file, status.session_file ? "بارگذاری شده" : "تنظیم نشده");
    setFacebookReadyCard("#fbReadyGroups", activeGroups.length > 0, `${activeGroups.length} گروه فعال`);
    setFacebookReadyCard("#fbReadyPoster", status.ready, status.ready ? "آماده انتشار" : "پیکربندی ناقص");

    const groupsList = $("#fbGroupsList");
    if (groupsList) {
      groupsList.innerHTML = shownGroups.length
        ? shownGroups.map((group) => `
          <article class="facebook-group-card ${group.enabled ? "" : "disabled"}">
            <div class="facebook-group-main">
              <span class="facebook-group-avatar">${esc((group.name || "F").slice(0, 1).toUpperCase())}</span>
              <div><strong>${esc(group.name)}</strong><a href="${esc(group.url)}" target="_blank" rel="noopener">مشاهده گروه</a></div>
            </div>
            <div class="facebook-group-meta"><span>${esc(group.language)}</span><span>قالب ${esc(group.template)}</span></div>
            <div class="facebook-group-actions">
              <label class="switch compact" title="فعال یا غیرفعال"><input type="checkbox" data-fb-toggle="${esc(group.id)}" ${group.enabled ? "checked" : ""}/><span class="switch-track"></span></label>
              <button class="icon-btn" data-fb-edit="${esc(group.id)}" aria-label="ویرایش ${esc(group.name)}"><svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L8 18l-4 1 1-4z"/></svg></button>
              <button class="icon-btn danger" data-fb-delete="${esc(group.id)}" aria-label="حذف ${esc(group.name)}"><svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6M10 11v6M14 11v6"/></svg></button>
            </div>
          </article>`).join("")
        : `<div class="facebook-empty"><strong>${groupQuery ? "گروهی با این جستجو پیدا نشد" : "هنوز گروهی اضافه نشده"}</strong><span>${groupQuery ? "عبارت جستجو را تغییر دهید." : "اولین گروه مقصد را اضافه کنید تا مسیر انتشار آماده شود."}</span></div>`;
    }

    const jobsList = $("#fbJobsList");
    if (jobsList) {
      jobsList.innerHTML = jobs.length
        ? jobs.map((job) => `
          <article class="facebook-job-card">
            <div class="facebook-job-signal"><span class="signal-direction ${(job.direction || "").toLowerCase()}">${esc(job.direction || "—")}</span><strong>${esc(job.symbol || "—")}</strong><span>${esc(job.received_at || job.timestamp || "")}</span></div>
            <div class="facebook-job-levels"><span>Entry <strong>${esc(job.entry || "—")}</strong></span><span>SL <strong>${esc(job.sl || "—")}</strong></span><span>TP <strong>${esc(job.tp1 || "—")}</strong></span></div>
            <div class="facebook-job-actions"><button class="btn btn-secondary btn-compact" data-fb-preview="${esc(job.signal_id || "")}">پیش‌نمایش و تأیید</button><button class="icon-btn danger" data-fb-job-delete="${esc(job.signal_id || "")}" aria-label="حذف از صف"><svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6"/></svg></button></div>
          </article>`).join("")
        : '<div class="facebook-empty"><strong>صف پیام خالی است</strong><span>با تولید سیگنال جدید، پیام آماده تأیید اینجا نمایش داده می‌شود.</span></div>';
    }
  }

  async function fetchFacebook({ force = false } = {}) {
    const data = await DataCache.load(
      "facebook",
      () => api("/api/facebook"),
      CACHE_TTL.facebook,
      { force, onStale: renderFacebook }
    );
    renderFacebook(data);
    return data;
  }

  const SIM_STATUS = {
    open: { label: "باز", cls: "open" },
    tp1: { label: "TP1", cls: "win" },
    tp1_sl: { label: "TP1 سپس SL", cls: "expired" },
    tp2: { label: "TP2", cls: "win strong" },
    sl: { label: "Stop Loss", cls: "loss" },
    expired: { label: "منقضی", cls: "expired" },
    invalid: { label: "سطوح نامعتبر", cls: "loss" },
  };

  function renderSimulation(data) {
    if (!data) return;
    const summary = data.summary || {};
    const trades = data.trades || [];
    const totalR = Number(summary.total_r || 0);
    if ($("#simTotalR")) $("#simTotalR").textContent = `${totalR > 0 ? "+" : ""}${totalR.toFixed(2)}R`;
    if ($("#simScoreCard")) $("#simScoreCard").className = `simulation-score ${totalR > 0 ? "positive" : totalR < 0 ? "negative" : ""}`;
    if ($("#simVerdict")) $("#simVerdict").textContent = summary.closed < 5 ? "داده بیشتری لازم است" : totalR > 0 ? "بازده مثبت" : totalR < 0 ? "بازده منفی" : "خنثی";
    if ($("#simWinRate")) $("#simWinRate").textContent = summary.win_rate == null ? "—" : `${summary.win_rate}%`;
    if ($("#simWinLoss")) $("#simWinLoss").textContent = `${summary.wins || 0}W / ${summary.losses || 0}L`;
    if ($("#simProfitFactor")) $("#simProfitFactor").textContent = summary.profit_factor == null ? "—" : summary.profit_factor >= 999 ? "∞" : summary.profit_factor;
    if ($("#simAvgR")) $("#simAvgR").textContent = summary.avg_r == null ? "—" : `${summary.avg_r > 0 ? "+" : ""}${summary.avg_r}R`;
    if ($("#simDrawdown")) $("#simDrawdown").textContent = `${summary.max_drawdown_r || 0}R`;
    if ($("#simClosedCount")) $("#simClosedCount").textContent = `${summary.closed || 0} بسته‌شده`;
    if ($("#simTradeCount")) $("#simTradeCount").textContent = `${summary.total || 0} سیگنال`;
    if ($("#simAmbiguous")) $("#simAmbiguous").textContent = `${summary.ambiguous || 0} مورد مبهم`;
    if ($("#simUpdated")) $("#simUpdated").textContent = data.generated_at ? `بروزرسانی ${new Date(data.generated_at).toLocaleTimeString("fa-IR", { hour: "2-digit", minute: "2-digit" })}` : "—";
    const confidence = Number(summary.confidence_score || 0);
    if ($("#simConfidenceScore")) $("#simConfidenceScore").textContent = `${confidence}%`;
    if ($("#simConfidenceBar")) $("#simConfidenceBar").style.width = `${confidence}%`;
    if ($("#simWinRateCI")) {
      const ci = summary.win_rate_ci95;
      $("#simWinRateCI").textContent = Array.isArray(ci) ? `${ci[0]}٪ تا ${ci[1]}٪` : "—";
    }
    if ($("#simDeterministic")) $("#simDeterministic").textContent = `${summary.deterministic_rate ?? 0}%`;
    if ($("#simLossStreak")) $("#simLossStreak").textContent = `${summary.max_losing_streak || 0} معامله`;
    if ($("#simAlgorithmVersion")) $("#simAlgorithmVersion").textContent = `v${data.method?.algorithm_version || "—"}`;
    if ($("#simConfidencePanel")) $("#simConfidencePanel").dataset.grade = summary.sample_grade || "low";
    if ($("#simConfidenceNote")) {
      const gradeText = { high: "نمونه آماری قوی", medium: "نمونه آماری متوسط", low: "نمونه هنوز کوچک است" };
      $("#simConfidenceNote").textContent = `${gradeText[summary.sample_grade] || gradeText.low} · ${summary.verified_rate ?? 0}٪ با موتور M5 نسخه جدید ارزیابی شده · هزینه اسپرد و کمیسیون در نتایج لحاظ نشده است.`;
    }

    const symbolSelect = $("#simSymbol");
    if (symbolSelect) {
      const current = symbolSelect.value || "all";
      const symbols = data.available_symbols || [...new Set((data.by_symbol || []).map((row) => row.symbol))];
      symbolSelect.innerHTML = '<option value="all">همه نمادها</option>' + symbols.map((symbol) => `<option value="${esc(symbol)}">${esc(symbol)}</option>`).join("");
      symbolSelect.value = symbols.includes(current) ? current : "all";
    }

    const symbolCards = $("#simSymbolCards");
    if (symbolCards) {
      symbolCards.innerHTML = (data.by_symbol || []).length
        ? data.by_symbol.map((row) => `<div class="sim-symbol-row"><div><strong>${esc(row.symbol)}</strong><span>${row.closed} از ${row.total} بسته</span></div><span class="sim-symbol-rate">${row.win_rate == null ? "—" : `${row.win_rate}%`}</span><b class="${row.r >= 0 ? "positive" : "negative"}">${row.r > 0 ? "+" : ""}${row.r}R</b></div>`).join("")
        : '<div class="facebook-empty"><strong>هنوز نتیجه‌ای ثبت نشده</strong><span>موتور با دریافت کندل بعدی نتایج را محاسبه می‌کند.</span></div>';
    }

    const body = $("#simTradeBody");
    if (body) {
      body.innerHTML = trades.length
        ? trades.map((trade) => {
            const meta = SIM_STATUS[trade.status] || SIM_STATUS.open;
            const r = trade.r_multiple;
            return `<tr>
              <td data-label="زمان"><span class="sim-time">${esc(String(trade.signal_time || "").replace("T", " ").slice(0, 16))}</span></td>
              <td data-label="نماد"><strong>${esc(trade.symbol)}</strong></td>
              <td data-label="جهت"><span class="signal-direction ${String(trade.direction).toLowerCase()}">${esc(trade.direction)}</span></td>
              <td data-label="Entry">${fmtPrice(trade.entry)}</td>
              <td data-label="SL">${fmtPrice(trade.sl)}</td>
              <td data-label="TP"><span class="sim-targets">${fmtPrice(trade.tp1)} / ${fmtPrice(trade.tp2)}</span></td>
              <td data-label="نتیجه"><span class="sim-outcome ${meta.cls}">${meta.label}${trade.ambiguous ? " · مبهم" : ""}</span></td>
              <td data-label="R"><strong class="${r > 0 ? "positive" : r < 0 ? "negative" : ""}">${r == null ? "—" : `${r > 0 ? "+" : ""}${Number(r).toFixed(2)}R`}</strong></td>
              <td data-label="MFE / MAE"><span class="sim-excursion">+${Number(trade.mfe_r || 0).toFixed(1)} / -${Number(trade.mae_r || 0).toFixed(1)}</span></td>
            </tr>`;
          }).join("")
        : '<tr><td colspan="9"><div class="facebook-empty"><strong>داده شبیه‌سازی هنوز آماده نیست</strong><span>بعد از دریافت کندل جدید، نتیجه سیگنال‌ها در این بخش ظاهر می‌شود.</span></div></td></tr>';
    }
    const pagination = data.pagination || {};
    simulationPage = Number(pagination.page || 1);
    if ($("#simPageInfo")) $("#simPageInfo").textContent = `صفحه ${simulationPage} از ${pagination.pages || 1} · ${pagination.total || 0} معامله`;
    if ($("#btnSimPrev")) $("#btnSimPrev").disabled = !pagination.has_prev;
    if ($("#btnSimNext")) $("#btnSimNext").disabled = !pagination.has_next;
    if ($("#simPagination")) $("#simPagination").classList.toggle("hidden", (pagination.pages || 1) <= 1);

    const equity = data.equity || [];
    const canvas = $("#simulationEquityChart");
    const empty = $("#simulationEquityEmpty");
    if (empty) empty.classList.toggle("hidden", equity.length > 0);
    if (canvas) canvas.classList.toggle("hidden", equity.length === 0);
    if (simulationEquityChart) simulationEquityChart.destroy();
    simulationEquityChart = null;
    if (canvas && equity.length && window.Chart) {
      simulationEquityChart = new Chart(canvas, {
        type: "line",
        data: {
          labels: equity.map((point) => String(point.time || "").slice(5, 16).replace("T", " ")),
          datasets: [{
            label: "Equity (R)",
            data: equity.map((point) => point.value),
            borderColor: totalR >= 0 ? "#63ffd0" : "#f87171",
            backgroundColor: totalR >= 0 ? "rgba(99,255,208,.09)" : "rgba(248,113,113,.09)",
            fill: true,
            tension: .25,
            pointRadius: equity.length > 35 ? 0 : 2.5,
          }],
        },
        options: {
          ...chartDefaults(),
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: { ticks: { color: "#657086", maxTicksLimit: 8, font: chartFont(9) }, grid: { display: false } },
            y: { ticks: { color: "#657086", callback: (value) => `${value}R`, font: chartFont(9) }, grid: { color: "rgba(255,255,255,.045)" } },
          },
          plugins: { legend: { display: false } },
        },
      });
    }
  }

  async function fetchSimulation({ force = false } = {}) {
    const days = Number($("#simDays")?.value || 30);
    const symbol = $("#simSymbol")?.value || "all";
    const status = $("#simStatus")?.value || "all";
    const key = `simulation:${days}:${symbol}:${status}:${simulationPage}`;
    const data = await DataCache.load(
      key,
      () => api(`/api/simulation?days=${days}&symbol=${encodeURIComponent(symbol)}&status=${status}&page=${simulationPage}&per_page=20`),
      CACHE_TTL.simulation,
      { force, onStale: renderSimulation }
    );
    renderSimulation(data);
    return data;
  }

  async function fetchTelegram({ force = false } = {}) {
    const days = Number($("#telegramDays")?.value || 30);
    const status = $("#telegramStatus")?.value || "all";
    const key = telegramCacheKey(days, status);
    if (!force && days === 30 && status === "all" && isBootstrapFresh()) {
      const cached = DataCache.get(key);
      if (cached?.entries?.length) {
        applyTelegramData(cached);
        return cached;
      }
    }
    await waitForBootstrap();
    const data = await DataCache.load(
      key,
      () => api(`/api/telegram/log?days=${days}&limit=500&status=${status}`),
      CACHE_TTL.telegram,
      { force, onStale: (d) => applyTelegramData(d) }
    );
    applyTelegramData(data);
    return data;
  }

  const _emitRevalidateOrig = DataCache._emitRevalidate.bind(DataCache);
  DataCache._emitRevalidate = function (key, data) {
    if (key.startsWith("report:")) {
      applyReportData(data, Number(key.split(":")[1] || 30));
    } else if (key.startsWith("telegram:")) {
      applyTelegramData(data);
    } else if (key.startsWith("signals:")) {
      applySignalsPayload(data);
    } else if (key === "facebook") {
      renderFacebook(data);
    } else if (key.startsWith("simulation:")) {
      renderSimulation(data);
    }
    _emitRevalidateOrig(key, data);
  };

  async function fetchLogs({ force = false } = {}) {
    const process = $("#logSelect")?.value || "signal-engine";
    const key = logsCacheKey(process);
    const data = await DataCache.load(
      key,
      async () => (await api(`/api/logs?process=${process}&lines=60`)).lines,
      CACHE_TTL.logs,
      { force }
    );
    applyLogs(data);
    return data;
  }

  async function fetchBootstrap({ force = false } = {}) {
    if (!force && isBootstrapFresh() && DataCache.get("bootstrap")) {
      return DataCache.get("bootstrap");
    }
    if (bootstrapInflight && !force) return bootstrapInflight;

    const run = async () => {
      const data = await DataCache.load(
        "bootstrap",
        () => api("/api/bootstrap"),
        CACHE_TTL.bootstrap,
        { force, onStale: (d) => applyBootstrap(d) }
      );
      applyBootstrap(data);
      prefetchAfterBootstrap();
      return data;
    };

    bootstrapInflight = run().finally(() => {
      bootstrapInflight = null;
    });
    return bootstrapInflight;
  }

  async function ensurePageData(page, { force = false } = {}) {
    const needs = PAGE_NEEDS[page] || [];
    applyPageFromCache(page);

    const tasks = [];
    if (needs.includes("status")) tasks.push(fetchStatus({ force }));
    if (needs.includes("system")) tasks.push(fetchSystem({ force }));
    if (needs.includes("signals")) tasks.push(fetchSignals({ force }));
    if (needs.includes("cooldowns")) tasks.push(fetchCooldowns({ force }));
    if (needs.includes("uptime")) tasks.push(fetchUptimeHistory({ force }));
    if (needs.includes("ops")) tasks.push(fetchOpsConfig({ force }));
    if (needs.includes("audit")) tasks.push(fetchAuditLog({ force }));
    if (needs.includes("report:7")) tasks.push(fetchReport(7, { force }));
    if (page === "reports" || needs.includes("report")) {
      const days = Number($("#reportDays")?.value || 30);
      tasks.push(fetchReport(days, { force }));
      tasks.push(fetchReportAnalytics(days, { force }));
    }
    if (page === "telegram" || needs.includes("telegram")) tasks.push(fetchTelegram({ force }));
    if (needs.includes("facebook")) tasks.push(fetchFacebook({ force: page === "facebook" ? true : force }));
    if (needs.includes("simulation")) tasks.push(fetchSimulation({ force }));
    if (needs.includes("logs")) tasks.push(fetchLogs({ force }));

    await Promise.allSettled(tasks);
  }

  function prefetchPage(page) {
    ensurePageData(page).catch(() => {});
  }

  async function refreshHomeExtras({ force = false } = {}) {
    try {
      await fetchReport(7, { force });
    } catch {}
  }

  // ── Version display ──
  function applyVersion(info) {
    if (!info) return;
    const nextFull = info.full || `${info.major}.${info.minor}.${info.patch || 0}`;
    const nextBuild = info.revision || info.build || "nogit";
    const nextKey = `${nextFull}@${nextBuild}`;
    const storedKey = safeLocalStorageGet("tc:build-version", "");
    if (storedKey && storedKey !== nextKey) {
      clearDashboardCache();
      safeLocalStorageSet("tc:build-version", nextKey);
      location.reload();
      return;
    }
    dashboardVersion = {
      label: info.label || `v${info.major}.${info.minor}`,
      full: nextFull,
      revision: nextBuild,
      major: info.major,
      minor: info.minor,
      patch: info.patch || 0,
    };
    const label = dashboardVersion.label;
    const full = dashboardVersion.revision && dashboardVersion.revision !== "nogit"
      ? `v${dashboardVersion.full} · ${dashboardVersion.revision}`
      : `v${dashboardVersion.full}`;
    if ($("#sidebarVersion")) $("#sidebarVersion").textContent = label;
    if ($("#sidebarVersionFull")) {
      $("#sidebarVersionFull").textContent = full;
      $("#sidebarVersionFull").title = `نسخه ${full}${info.released ? ` · ${info.released}` : ""}`;
    }
    if ($("#loginVersion")) $("#loginVersion").textContent = label;
    document.title = `TradeChi ${label} — Dashboard`;
    safeLocalStorageSet("tc:build-version", nextKey);
  }

  window.addEventListener("error", (event) => {
    reportClientError("window.error", event.error || new Error(event.message || "window error"), {
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason instanceof Error ? event.reason : new Error(String(event.reason || "unhandled rejection"));
    reportClientError("unhandledrejection", reason);
  });

  async function loadVersion() {
    try {
      const res = await fetch("/api/version");
      if (res.ok) applyVersion(await res.json());
    } catch {}
  }

  // ── Dynamic expandable sidebar ──
  function prepareChartCanvas(canvas) {
    if (!canvas) return;
    canvas.setAttribute("dir", "ltr");
    canvas.style.direction = "ltr";
    canvas.style.unicodeBidi = "isolate";
  }

  function getNavGroupState(id) {
    try {
      const raw = safeLocalStorageGet("tc:nav-groups");
      const map = raw ? JSON.parse(raw) : {};
      const group = NAV_GROUPS.find((g) => g.id === id);
      return map[id] ?? group?.defaultOpen ?? true;
    } catch {
      return true;
    }
  }

  function setNavGroupState(id, open) {
    try {
      const raw = safeLocalStorageGet("tc:nav-groups");
      const map = raw ? JSON.parse(raw) : {};
      map[id] = open;
      safeLocalStorageSet("tc:nav-groups", JSON.stringify(map));
    } catch {}
  }

  function renderSidebarNav() {
    const nav = $("#sidebarNav");
    if (!nav) return;
    nav.innerHTML = NAV_GROUPS.map((group) => {
      const open = getNavGroupState(group.id);
      const itemsHtml = group.items
        .map((item) => {
          const disabled = item.disabled || !item.page;
          const active = item.page && item.page === activePage;
          const badge = item.badge
            ? `<span class="nav-item-badge${item.badge === "به‌زودی" ? " soon" : ""}">${item.badge}</span>`
            : "";
          return `
            <button type="button"
              class="nav-item${active ? " active" : ""}${disabled ? " disabled" : ""}"
              data-page="${item.page || ""}"
              ${disabled ? "disabled aria-disabled=\"true\"" : ""}
              title="${item.label}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${NAV_ICONS[item.icon] || NAV_ICONS.home}</svg>
              <span>${item.label}</span>
              ${badge}
            </button>`;
        })
        .join("");
      return `
        <div class="nav-group${open ? "" : " collapsed"}" data-group="${group.id}">
          <button type="button" class="nav-group-toggle" data-group-toggle="${group.id}" aria-expanded="${open}">
            <span class="nav-group-toggle-label">${group.label}</span>
            <svg class="nav-group-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          <div class="nav-group-items">${itemsHtml}</div>
        </div>`;
    }).join("");

    nav.querySelectorAll("[data-group-toggle]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.groupToggle;
        const groupEl = nav.querySelector(`[data-group="${id}"]`);
        const willOpen = groupEl?.classList.contains("collapsed");
        groupEl?.classList.toggle("collapsed", !willOpen);
        btn.setAttribute("aria-expanded", String(willOpen));
        setNavGroupState(id, willOpen);
      });
    });

    nav.querySelectorAll(".nav-item[data-page]").forEach((btn) => {
      if (!btn.dataset.page) return;
      btn.addEventListener("click", () => switchPage(btn.dataset.page));
      btn.addEventListener("mouseenter", () => prefetchPage(btn.dataset.page));
    });
  }

  function setSidebarCollapsed(collapsed) {
    const sidebar = $("#sidebar");
    const shell = $("#dashboard");
    sidebar?.classList.toggle("collapsed", collapsed);
    shell?.classList.toggle("sidebar-collapsed", collapsed);
    safeLocalStorageSet("tc:sidebar-collapsed", collapsed ? "1" : "0");
  }

  function initSidebarCollapse() {
    const btn = $("#sidebarCollapseBtn");
    if (!btn) return;

    setSidebarCollapsed(safeLocalStorageGet("tc:sidebar-collapsed", "0") === "1");

    btn.addEventListener("click", () => {
      const collapsed = !$("#sidebar")?.classList.contains("collapsed");
      setSidebarCollapsed(collapsed);
    });
  }

  // ── Page Navigation ──
  function switchPage(page, { revalidate = true } = {}) {
    activePage = normalizePage(page);
    safeSessionStorageSet(ACTIVE_PAGE_KEY, activePage);
    const meta = PAGE_META[activePage] || PAGE_META.home;
    if ($("#pageTitle")) $("#pageTitle").textContent = meta.title;
    if ($("#pageSub")) $("#pageSub").textContent = meta.sub;
    $$(".nav-item[data-page]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.page === activePage);
    });
    $$(".page").forEach((p) => p.classList.toggle("active", p.id === `page-${activePage}`));
    closeSidebar();

    applyPageFromCache(activePage);

    if (activePage === "signals") {
      requestAnimationFrame(() => {
        if (signalsSummary) {
          renderSignalDailyChart(signalsSummary.daily || []);
          renderSignalDirChart(signalsSummary.by_direction || {});
        } else {
          signalDailyChart?.resize();
          signalDirChart?.resize();
        }
      });
    }

    if (activePage === "monitor") {
      const sys = DataCache.get("system");
      if (sys && !resourceHistory.labels.length) pushResourceHistory(sys);
      syncMonitorHero(sys);
      requestAnimationFrame(() => {
        refreshMonitorLiveCharts({ recreate: true });
        setTimeout(() => refreshMonitorLiveCharts(), 400);
      });
    }
    if (activePage === "simulation") {
      requestAnimationFrame(() => simulationEquityChart?.resize());
    }

    if (revalidate) ensurePageData(activePage).catch(() => {});
    syncLogPolling();
    syncMonitorPolling();
    syncFacebookPolling();
  }

  function syncMonitorPolling() {
    clearInterval(monitorInterval);
    monitorInterval = null;
    if (activePage === "monitor" && isAuthenticated) {
      fetchSystem().catch(() => {});
      monitorInterval = setInterval(() => fetchSystem().catch(() => {}), sseConnected ? 10000 : 5000);
    }
  }

  function syncFacebookPolling() {
    clearInterval(facebookInterval);
    facebookInterval = null;
    if (activePage === "facebook" && isAuthenticated) {
      facebookInterval = setInterval(() => fetchFacebook({ force: true }).catch(() => {}), 15000);
    }
  }

  function openSidebar() {
    $("#sidebar")?.classList.add("open");
    $("#sidebarOverlay")?.classList.add("open");
  }

  function closeSidebar() {
    $("#sidebar")?.classList.remove("open");
    $("#sidebarOverlay")?.classList.remove("open");
  }

  $("#menuToggle")?.addEventListener("click", openSidebar);
  $("#sidebarOverlay")?.addEventListener("click", closeSidebar);

  $$("[data-goto]").forEach((btn) => {
    btn.addEventListener("click", () => switchPage(btn.dataset.goto));
    btn.addEventListener("mouseenter", () => prefetchPage(btn.dataset.goto));
  });

  function renderProcesses(procs) {
    const container = $("#processCards");
    if (!container || !procs) return;
    const labels = {
      "signal-engine": "موتور سیگنال",
      "signal-server": "سرور MT5/Facebook",
      dashboard: "داشبورد",
    };
    container.innerHTML = procs
      .map((p) => {
        const online = p.status === "online";
        const controllable = p.controllable !== false;
        const badgeCls = p.status === "online" ? "online" : p.status === "stopped" ? "stopped" : "not_found";
        const badgeText = online ? "Online" : p.status === "stopped" ? "Stopped" : p.status;
        return `
      <div class="process-card v2${controllable ? "" : " readonly"}">
        <div class="process-head">
          <div class="process-dot ${online ? "online" : p.status === "stopped" ? "stopped" : "unknown"}"></div>
          <div class="process-info">
            <div class="process-name">${p.name}</div>
            <div class="process-meta">${labels[p.name] || p.name}</div>
          </div>
          <span class="process-badge ${badgeCls}">${badgeText}</span>
        </div>
        <div class="process-stats">
          <span class="process-stat">PID <strong>${online ? p.pid : "—"}</strong></span>
          <span class="process-stat">RAM <strong>${online ? `${p.memory_mb} MB` : "—"}</strong></span>
          <span class="process-stat">CPU <strong>${online ? `${p.cpu}%` : "—"}</strong></span>
          <span class="process-stat">Uptime <strong>${p.uptime_human || "—"}</strong></span>
          <span class="process-stat">Restarts <strong>${p.restarts ?? 0}</strong></span>
        </div>
        ${
          controllable
            ? `<div class="process-actions">
          <button class="btn-icon" title="Start" ${online ? "disabled" : ""} onclick="window._ctrl('start','${p.name}')">▶</button>
          <button class="btn-icon danger" title="Stop" ${!online ? "disabled" : ""} onclick="window._ctrl('stop','${p.name}')">■</button>
          <button class="btn-icon" title="Restart" onclick="window._ctrl('restart','${p.name}')">↻</button>
        </div>`
            : ""
        }
      </div>`;
      })
      .join("");
  }

  window._ctrl = (action, process) => control(action, process);

  function setGaugeArc(el, pct, max = 214) {
    if (!el) return;
    const clamped = Math.max(0, Math.min(100, pct));
    el.style.strokeDashoffset = String(max - (max * clamped) / 100);
  }

  function setElementClass(el, className) {
    if (!el) return;
    if (el instanceof SVGElement) {
      el.setAttribute("class", className);
      return;
    }
    el.className = className;
  }

  function healthFromPct(pct) {
    if (pct >= 75) return { cls: "good", label: "عالی" };
    if (pct >= 50) return { cls: "warn", label: "متوسط" };
    return { cls: "bad", label: "ضعیف" };
  }

  function computeHealthScore(sys, procs) {
    if (!sys?.cpu || !sys?.ram || !sys?.disk) return 0;
    const cpuScore = Math.max(0, 100 - (sys.cpu.total ?? 0));
    const ramScore = Math.max(0, 100 - (sys.ram.used_pct ?? 0));
    const diskScore = Math.max(0, 100 - (sys.disk.used_pct ?? 0));
    const procScore = procs?.length
      ? (procs.filter((p) => p.status === "online").length / procs.length) * 100
      : 50;
    return Math.round(cpuScore * 0.3 + ramScore * 0.3 + diskScore * 0.2 + procScore * 0.2);
  }

  function parseAgeMinutes(value) {
    if (!value || value === "—") return null;
    const normalized = String(value).replace(" UTC", "Z").replace("+00:00", "Z");
    const ts = Date.parse(normalized);
    if (Number.isNaN(ts)) return null;
    return Math.max(0, Math.floor((Date.now() - ts) / 60000));
  }

  function freshnessMeta(ageMin) {
    if (ageMin === null) return { cls: "idle", label: "بدون داده", pct: 8 };
    if (ageMin <= 15) return { cls: "ok", label: "فعال", pct: Math.max(20, 100 - ageMin * 2) };
    if (ageMin <= 60) return { cls: "warn", label: "تأخیر", pct: Math.max(15, 70 - ageMin) };
    return { cls: "bad", label: "منقضی", pct: Math.max(8, 30 - Math.min(ageMin, 120) / 4) };
  }

  function formatAge(ageMin) {
    if (ageMin === null) return "—";
    if (ageMin < 60) return `${ageMin}m ago`;
    const h = Math.floor(ageMin / 60);
    const m = ageMin % 60;
    return m ? `${h}h ${m}m ago` : `${h}h ago`;
  }

  function pushResourceHistory(sys) {
    if (!sys?.cpu || !sys?.ram) return;
    const label = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const cpu = Number(sys.cpu.total);
    const ram = Number(sys.ram.used_pct);
    if (Number.isNaN(cpu) || Number.isNaN(ram)) return;

    const lastIdx = resourceHistory.labels.length - 1;
    if (lastIdx >= 0 && resourceHistory.labels[lastIdx] === label) {
      resourceHistory.cpu[lastIdx] = cpu;
      resourceHistory.ram[lastIdx] = ram;
      resourceHistory.net[lastIdx] = Math.max(sys.network?.down_kbps || 0, sys.network?.up_kbps || 0);
      resourceHistory.disk[lastIdx] = Number(sys.disk?.used_pct) || 0;
      return;
    }

    resourceHistory.labels.push(label);
    resourceHistory.cpu.push(cpu);
    resourceHistory.ram.push(ram);
    resourceHistory.net.push(Math.max(sys.network?.down_kbps || 0, sys.network?.up_kbps || 0));
    resourceHistory.disk.push(Number(sys.disk?.used_pct) || 0);
    if (resourceHistory.labels.length > resourceHistory.max) {
      resourceHistory.labels.shift();
      resourceHistory.cpu.shift();
      resourceHistory.ram.shift();
      resourceHistory.net.shift();
      resourceHistory.disk.shift();
    }
  }

  function destroyResourceHistoryChart() {
    if (resourceHistoryChart) {
      resourceHistoryChart.destroy();
      resourceHistoryChart = null;
    }
  }

  function updateResourceChartEmptyState() {
    const box = $(".chart-box.monitor-chart");
    const hint = $("#resourceChartEmpty");
    const hasData = resourceHistory.labels.length > 0;
    box?.classList.toggle("has-data", hasData);
    if (hint) hint.hidden = hasData;
  }

  function refreshMonitorLiveCharts({ recreate = false } = {}) {
    const canvas = $("#resourceHistoryChart");
    if (!canvas) return;

    const tooSmall = canvas.offsetWidth < 16 || canvas.offsetHeight < 16;
    if (recreate || tooSmall) destroyResourceHistoryChart();

    updateSparkCharts();
    renderResourceHistoryChart();

    resourceHistoryChart?.resize();
    resourceHistoryChart?.update("none");
    [cpuSparkChart, ramSparkChart, diskSparkChart, netSparkChart].forEach((c) => c?.resize());
    updateResourceChartEmptyState();
  }

  function sparkOptions(color) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: { x: { display: false }, y: { display: false, beginAtZero: true } },
      elements: { point: { radius: 0 }, line: { borderWidth: 1.5, tension: 0.4 } },
      animation: { duration: 400 },
    };
  }

  function ensureSparkChart(key, canvasId, color, bg) {
    const canvas = $(canvasId);
    if (!canvas) return null;
    const existing = { cpuSparkChart, ramSparkChart, diskSparkChart, netSparkChart }[key];
    if (existing) return existing;
    const chart = new Chart(canvas, {
      type: "line",
      data: {
        labels: resourceHistory.labels,
        datasets: [{ data: [], borderColor: color, backgroundColor: bg, fill: true }],
      },
      options: sparkOptions(color),
    });
    if (key === "cpuSparkChart") cpuSparkChart = chart;
    if (key === "ramSparkChart") ramSparkChart = chart;
    if (key === "diskSparkChart") diskSparkChart = chart;
    if (key === "netSparkChart") netSparkChart = chart;
    return chart;
  }

  function updateSparkCharts() {
    const configs = [
      { key: "cpuSparkChart", id: "#cpuSpark", color: "#5b9cf6", bg: "rgba(91,156,246,0.12)", data: resourceHistory.cpu },
      { key: "ramSparkChart", id: "#ramSpark", color: "#63ffd0", bg: "rgba(99,255,208,0.1)", data: resourceHistory.ram },
      { key: "diskSparkChart", id: "#diskSpark", color: "#fbbf24", bg: "rgba(251,191,36,0.1)", data: resourceHistory.disk || [] },
      { key: "netSparkChart", id: "#netSpark", color: "#a78bfa", bg: "rgba(167,139,250,0.1)", data: resourceHistory.net },
    ];
    configs.forEach(({ key, id, color, bg, data }) => {
      let chart = { cpuSparkChart, ramSparkChart, diskSparkChart, netSparkChart }[key];
      if (!chart) chart = ensureSparkChart(key, id, color, bg);
      if (!chart) return;
      chart.data.labels = resourceHistory.labels;
      chart.data.datasets[0].data = data;
      chart.update("none");
    });
  }

  function renderResourceHistoryChart() {
    const canvas = $("#resourceHistoryChart");
    if (!canvas || typeof Chart === "undefined") return;

    try {
      if (resourceHistoryChart) {
        resourceHistoryChart.data.labels = [...resourceHistory.labels];
        resourceHistoryChart.data.datasets[0].data = [...resourceHistory.cpu];
        resourceHistoryChart.data.datasets[1].data = [...resourceHistory.ram];
        resourceHistoryChart.data.datasets[2].data = [...resourceHistory.disk];
        resourceHistoryChart.data.datasets[3].data = [...resourceHistory.net];
        resourceHistoryChart.update("none");
        updateResourceChartEmptyState();
        return;
      }

      resourceHistoryChart = new Chart(canvas, {
        type: "line",
        data: {
          labels: [...resourceHistory.labels],
          datasets: [
            {
              label: "CPU",
              data: [...resourceHistory.cpu],
              borderColor: "#5b9cf6",
              backgroundColor: "rgba(91,156,246,0.08)",
              fill: true,
              tension: 0.35,
              yAxisID: "y",
              pointRadius: resourceHistory.labels.length <= 2 ? 3 : 0,
              borderWidth: 2,
            },
            {
              label: "RAM",
              data: [...resourceHistory.ram],
              borderColor: "#63ffd0",
              backgroundColor: "rgba(99,255,208,0.06)",
              fill: true,
              tension: 0.35,
              yAxisID: "y",
              pointRadius: resourceHistory.labels.length <= 2 ? 3 : 0,
              borderWidth: 2,
            },
            {
              label: "Disk",
              data: [...resourceHistory.disk],
              borderColor: "#fbbf24",
              backgroundColor: "rgba(251,191,36,0.06)",
              fill: false,
              tension: 0.35,
              yAxisID: "y",
              pointRadius: 0,
              borderWidth: 2,
            },
            {
              label: "Net KB/s",
              data: [...resourceHistory.net],
              borderColor: "#a78bfa",
              backgroundColor: "rgba(167,139,250,0.06)",
              fill: false,
              tension: 0.35,
              yAxisID: "y1",
              pointRadius: 0,
              borderWidth: 2,
            },
          ],
        },
        options: {
          ...chartDefaults(),
          animation: { duration: 350 },
          interaction: { intersect: false, mode: "index" },
          scales: {
            x: {
              ticks: { color: "#5a6478", maxTicksLimit: 8, font: CHART_FONT },
              grid: { color: "rgba(255,255,255,0.04)" },
            },
            y: {
              type: "linear",
              position: "right",
              beginAtZero: true,
              max: 100,
              ticks: { color: "#5a6478", callback: (v) => `${v}%`, font: CHART_FONT },
              grid: { color: "rgba(255,255,255,0.04)" },
            },
            y1: {
              type: "linear",
              position: "left",
              beginAtZero: true,
              ticks: { color: "#8b7fd6", font: CHART_FONT },
              grid: { drawOnChartArea: false },
            },
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: "rgba(8,12,24,0.95)",
              titleFont: CHART_FONT,
              bodyFont: CHART_FONT,
            },
          },
        },
      });
      updateResourceChartEmptyState();
    } catch {
      destroyResourceHistoryChart();
    }
  }

  function renderMonitorProcesses(procs) {
    const el = $("#monitorProcesses");
    if (!el) return;
    lastProcesses = procs || lastProcesses;
    if (!lastProcesses.length) {
      el.innerHTML = '<p style="color:var(--text-dim);font-size:var(--text-xs);text-align:center;padding:1rem">—</p>';
      return;
    }
    el.innerHTML = lastProcesses.map((p) => {
      const online = p.status === "online";
      const cpuW = Math.min(p.cpu || 0, 100);
      const memW = Math.min((p.memory_mb || 0) / 512 * 100, 100);
      return `
        <div class="mon-proc">
          <span class="mon-proc-dot ${online ? "online" : p.status === "stopped" ? "stopped" : "unknown"}"></span>
          <div class="mon-proc-info">
            <div class="mon-proc-name">${p.name}</div>
            <div class="mon-proc-meta">${online ? `PID ${p.pid} · ${p.uptime_human || "—"}` : "متوقف"}${p.restarts ? ` · ${p.restarts} restart` : ""}</div>
          </div>
          <div class="mon-proc-bars">
            <div class="mon-proc-bar-row"><div class="mon-proc-bar"><div class="mon-proc-bar-fill cpu" style="width:${cpuW}%"></div></div><span>${p.cpu || 0}%</span></div>
            <div class="mon-proc-bar-row"><div class="mon-proc-bar"><div class="mon-proc-bar-fill mem" style="width:${memW}%"></div></div><span>${p.memory_mb || 0}M</span></div>
          </div>
        </div>`;
    }).join("");
    syncMonitorHero(null, lastProcesses);
  }

  function syncMonitorHero(sys = null, procs = null) {
    const payload = sys || DataCache.get("system");
    if (!payload) return;
    try {
      updateMonitorHero(payload, procs || lastProcesses);
    } catch {}
  }

  function updateMonitorHero(sys, procs) {
    if (!sys?.cpu || !sys?.ram || !sys?.disk) return;
    const score = computeHealthScore(sys, procs || lastProcesses);
    const health = healthFromPct(score);
    setText("#monHost", sys.hostname || "—");
    setText("#monUptime", formatUptime(sys.uptime_secs ?? 0));
    setText("#monBotRam", `${sys.ram.bot_mb ?? 0} MB`);
    if ($("#monHealthScore")) $("#monHealthScore").textContent = `${score}%`;
    const scoreNum = $("#monitorScoreNum");
    if (scoreNum) scoreNum.textContent = String(score);
    if ($("#monitorHostTitle")) $("#monitorHostTitle").textContent = sys.hostname || "سرور";
    if ($("#monitorHostSub")) {
      $("#monitorHostSub").textContent = `CPU ${sys.cpu.total ?? 0}% · RAM ${sys.ram.used_pct ?? 0}% · Disk ${sys.disk.used_pct ?? 0}%`;
    }
    if ($("#monitorHealthLabel")) $("#monitorHealthLabel").textContent = health.label;
    const dot = $("#monitorHealthDot");
    if (dot) setElementClass(dot, `status-indicator ${health.cls === "good" ? "running" : health.cls === "warn" ? "partial" : "stopped"}`);
    const pill = $("#monitorHealthPill");
    if (pill) setElementClass(pill, `status-pill health-${health.cls}`);
    setGaugeArc($("#monitorScoreArc"), score, 327);
    const arc = $("#monitorScoreArc");
    if (arc) setElementClass(arc, `score-fill ${health.cls}`);
  }

  function updateSystem(sys) {
    if (!sys?.cpu || !sys?.ram || !sys?.disk) return;
    setStableCounter($("#cpuValue"), `${sys.cpu.total ?? 0}%`);
    setStableCounter($("#ramValue"), `${sys.ram.used_pct ?? 0}%`);
    setStableCounter($("#diskValue"), `${sys.disk.used_pct ?? 0}%`);

    setGaugeArc($("#cpuGaugeArc"), sys.cpu.total ?? 0);
    setGaugeArc($("#ramGaugeArc"), sys.ram.used_pct ?? 0);
    setGaugeArc($("#diskGaugeArc"), sys.disk.used_pct ?? 0);

    setText("#cpuBot", `${sys.cpu.bot ?? 0}%`);
    setText("#ramTotal", String(sys.ram.total_gb ?? 0));
    setText("#ramBot", String(sys.ram.bot_mb ?? 0));
    setText("#diskFree", String(sys.disk.free_gb ?? 0));

    const down = Number(sys.network?.down_kbps ?? 0);
    const up = Number(sys.network?.up_kbps ?? 0);
    setStableCounter($("#netValue"), `${Math.max(down, up).toFixed(1)} KB/s`);
    setText("#netDown", `${down} KB/s`);
    setText("#netUp", `${up} KB/s`);
    setBarWidth("#netDownBar", Math.min(down / 5, 100));
    setBarWidth("#netUpBar", Math.min(up / 5, 100));

    setText("#hostTag", sys.hostname || "—");
    if ($("#heroUptime")) $("#heroUptime").textContent = formatUptime(sys.uptime_secs ?? 0);

    pushResourceHistory(sys);
    handleResourceAlerts(sys);
    if (sys.ops) applyOpsConfig(sys.ops);
    syncMonitorHero(sys, lastProcesses);
    if ($("#monitorSyncTime")) {
      $("#monitorSyncTime").textContent = `آخرین بروزرسانی: ${new Date().toLocaleTimeString("fa-IR")}`;
    }
    if (activePage === "monitor") {
      refreshMonitorLiveCharts();
    }
    if (activePage === "home") {
      const status = DataCache.get("status");
      if (status) renderHomeSecondary(status);
    }
  }

  function formatUptime(secs) {
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    return d ? `${d}d ${h}h` : `${h}h`;
  }

  function renderEngineState(state) {
    lastEngineState = state;
    const info = $("#engineInfo");
    if (!info) return;

    const bars = state?.last_bars || {};
    const signals = state?.last_signal_at || {};
    const symbols = [...new Set([...Object.keys(bars), ...Object.keys(signals)])];

    if ($("#engineUpdatedAt")) {
      $("#engineUpdatedAt").textContent = state?.updated_at
        ? `Engine sync: ${state.updated_at}`
        : "Engine sync: —";
    }

    const summary = { ok: 0, warn: 0, bad: 0 };
    symbols.forEach((sym) => {
      const barAge = parseAgeMinutes(bars[sym]);
      const meta = freshnessMeta(barAge);
      summary[meta.cls === "idle" ? "bad" : meta.cls] += 1;
    });

    const chips = $("#engineSummaryChips");
    if (chips) {
      chips.innerHTML = symbols.length
        ? `
          <span class="engine-chip ok"><span class="dot"></span>${summary.ok} فعال</span>
          <span class="engine-chip warn"><span class="dot"></span>${summary.warn} تأخیر</span>
          <span class="engine-chip bad"><span class="dot"></span>${summary.bad} مشکل</span>
          <span class="engine-chip"><span class="dot" style="background:var(--accent)"></span>${symbols.length} نماد</span>`
        : "";
    }

    info.innerHTML = symbols.length
      ? symbols.map((sym) => {
          const barVal = bars[sym] || "—";
          const sigVal = signals[sym] || "—";
          const barAge = parseAgeMinutes(barVal);
          const sigAge = parseAgeMinutes(sigVal);
          const barMeta = freshnessMeta(barAge);
          const sigMeta = freshnessMeta(sigAge);
          const overall = barMeta.cls === "bad" || sigMeta.cls === "bad"
            ? "bad"
            : barMeta.cls === "warn" || sigMeta.cls === "warn"
              ? "warn"
              : barMeta.cls === "idle"
                ? "idle"
                : "ok";
          const badgeLabel = { ok: "فعال", warn: "تأخیر", bad: "منقضی", idle: "بدون داده" }[overall];
          return `
            <article class="engine-card ${overall}">
              <div class="engine-card-head">
                <span class="engine-card-sym">${sym}</span>
                <span class="engine-card-badge ${overall}">${badgeLabel}</span>
              </div>
              <div class="engine-card-rows">
                <div class="engine-card-row">
                  <div class="engine-card-row-label"><span>آخرین Bar</span><span>${formatAge(barAge)}</span></div>
                  <div class="engine-card-row-val">${barVal}</div>
                  <div class="engine-card-row-bar"><div class="engine-card-row-bar-fill ${barMeta.cls === "idle" ? "bad" : barMeta.cls}" style="width:${barMeta.pct}%"></div></div>
                </div>
                <div class="engine-card-row">
                  <div class="engine-card-row-label"><span>آخرین Signal</span><span>${formatAge(sigAge)}</span></div>
                  <div class="engine-card-row-val">${sigVal}</div>
                  <div class="engine-card-row-bar"><div class="engine-card-row-bar-fill ${sigMeta.cls === "idle" ? "bad" : sigMeta.cls}" style="width:${sigMeta.pct}%"></div></div>
                </div>
              </div>
            </article>`;
        }).join("")
      : '<div class="engine-cards-empty">اطلاعات موتور تحلیل در دسترس نیست — ربات را روشن کنید</div>';

    renderSymbolHealth(state);
  }

  function renderStats(stats, statusData) {
    if (!stats) return;
    const setCounter = (id, v) => setStableCounter($(id), v);
    setCounter("#kpiToday", stats.today);
    setCounter("#kpiTotal", stats.total);
    setCounter("#kpiBuy", stats.by_direction?.BUY || 0);
    setCounter("#kpiSell", stats.by_direction?.SELL || 0);
    setCounter("#statToday", stats.today);
    setCounter("#statTotal", stats.total);
    setCounter("#statBuy", stats.by_direction?.BUY || 0);
    setCounter("#statSell", stats.by_direction?.SELL || 0);
    if (activePage === "signals") {
      setStableCounter($("#sigToday"), stats.today);
      setStableCounter($("#sigTotal"), stats.total);
    }
    if (statusData) applyHomeKpis(statusData);
    updateChart(stats.by_symbol || {});
    renderSymbolLegend(stats.by_symbol || {});

    const statsKey = `${stats.today}:${stats.total}:${stats.by_direction?.BUY || 0}:${stats.by_direction?.SELL || 0}`;
    if (statsKey !== lastSignalStatsKey) {
      lastSignalStatsKey = statsKey;
      if (activePage === "home") {
        invalidateCache("report:7");
        fetchReport(7, { force: true }).catch(() => {});
      }
    }
  }

  function updateChart(bySymbol) {
    const canvas = $("#symbolChart");
    if (!canvas) return;
    prepareChartCanvas(canvas);
    const labels = Object.keys(bySymbol);
    const values = Object.values(bySymbol);

    if (symbolChart) {
      symbolChart.data.labels = labels;
      symbolChart.data.datasets[0].data = values;
      symbolChart.data.datasets[0].backgroundColor = CHART_COLORS.slice(0, labels.length);
      symbolChart.update("none");
      renderSymbolLegend(bySymbol);
      return;
    }

    symbolChart = new Chart(canvas, {
      type: "doughnut",
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: CHART_COLORS.slice(0, labels.length),
          borderWidth: 0,
          hoverOffset: 10,
          spacing: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "72%",
        plugins: { legend: { display: false } },
        animation: { animateRotate: true, duration: 900, easing: "easeOutQuart" },
      },
    });
    renderSymbolLegend(bySymbol);
  }

  function chartDefaults() {
    const dpr = window.devicePixelRatio || 1;
    return {
      responsive: true,
      maintainAspectRatio: false,
      devicePixelRatio: isMobileViewport() ? Math.min(dpr, 1.5) : Math.min(dpr, 2),
      plugins: { legend: { rtl: false, textDirection: "ltr", labels: { color: "#8b95a8", font: chartFont(10) } } },
      animation: isMobileViewport() ? false : { duration: 300 },
    };
  }

  function renderDirectionChart(buy, sell) {
    const canvas = $("#directionChart");
    if (!canvas) return;
    prepareChartCanvas(canvas);
    const data = [buy, sell];
    if (directionChart) {
      directionChart.data.datasets[0].data = data;
      directionChart.update("none");
      return;
    }
    directionChart = new Chart(canvas, {
      type: "doughnut",
      data: {
        labels: ["BUY", "SELL"],
        datasets: [{
          data,
          backgroundColor: ["rgba(74,222,128,0.85)", "rgba(248,113,113,0.85)"],
          borderWidth: 0,
          hoverOffset: 8,
        }],
      },
      options: {
        ...chartDefaults(),
        cutout: "62%",
        plugins: {
          legend: { position: "bottom", rtl: false, textDirection: "ltr", labels: { color: "#8b95a8", font: chartFont(9), padding: isMobileViewport() ? 8 : 16 } },
        },
      },
    });
  }

  function renderSymbolBarChart(bySymbol) {
    const canvas = $("#symbolBarChart");
    if (!canvas) return;
    prepareChartCanvas(canvas);
    const labels = Object.keys(bySymbol);
    const values = Object.values(bySymbol);
    if (symbolBarChart) {
      symbolBarChart.data.labels = labels;
      symbolBarChart.data.datasets[0].data = values;
      symbolBarChart.update("none");
      return;
    }
    symbolBarChart = new Chart(canvas, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: "Signals",
          data: values,
          backgroundColor: CHART_COLORS.slice(0, labels.length).map((c) => c + "cc"),
          borderRadius: 6,
          borderSkipped: false,
        }],
      },
      options: {
        ...chartDefaults(),
        indexAxis: "y",
        scales: {
          x: { ticks: { color: "#5c6578", font: { size: 10 } }, grid: { color: "rgba(255,255,255,0.04)" } },
          y: { ticks: { color: "#8b95a8", font: { family: "JetBrains Mono", size: 11 } }, grid: { display: false } },
        },
        plugins: { legend: { display: false } },
      },
    });
    logClientEvent("chart-created", {
      chart: "symbolBar",
      dims: {
        canvas: { w: canvas.clientWidth, h: canvas.clientHeight },
        box: canvas.parentElement ? { w: canvas.parentElement.clientWidth, h: canvas.parentElement.clientHeight } : null,
      },
      devicePixelRatio: window.devicePixelRatio || 1,
    });
  }

  function fmtPrice(v) {
    if (v == null || v === "") return "—";
    const n = Number(v);
    if (Number.isNaN(n)) return String(v);
    if (n >= 1000) return n.toFixed(2);
    if (n >= 100) return n.toFixed(3);
    if (n >= 10) return n.toFixed(4);
    return n.toFixed(5);
  }

  const DELIVERY_META = {
    sent: { label: "✓ ارسال شد", cls: "sent", icon: "✓" },
    failed: { label: "✗ خطای ارسال", cls: "failed", icon: "✗" },
    unsent: { label: "؟ بدون تأیید", cls: "unsent", icon: "?" },
  };

  const OUTCOME_META = {
    tp1: { label: "TP1 ✓", cls: "outcome-win" },
    tp2: { label: "TP2 ✓", cls: "outcome-win" },
    sl: { label: "SL ✗", cls: "outcome-loss" },
    open: { label: "باز", cls: "outcome-open" },
    expired: { label: "منقضی", cls: "outcome-expired" },
  };

  function applySignalsPage(summary) {
    if (!summary) return;
    if ($("#sigSentTotal")) $("#sigSentTotal").textContent = summary.sent ?? 0;
    if ($("#sigFailedTotal")) $("#sigFailedTotal").textContent = summary.failed ?? 0;
    if ($("#sigUnsentTotal")) $("#sigUnsentTotal").textContent = summary.unsent ?? 0;
    if ($("#sigRateTotal")) $("#sigRateTotal").textContent = `${summary.delivery_rate ?? 0}%`;
    if ($("#sigToday")) $("#sigToday").textContent = summary.today ?? 0;
    if ($("#sigTotal")) $("#sigTotal").textContent = summary.total ?? 0;
    if ($("#sigHeroUpdated")) {
      $("#sigHeroUpdated").textContent = summary.generated_at ? `بروزرسانی ${summary.generated_at}` : "—";
    }
    const dir = summary.by_direction || {};
    if ($("#sigBuyCount")) $("#sigBuyCount").textContent = dir.BUY ?? 0;
    if ($("#sigSellCount")) $("#sigSellCount").textContent = dir.SELL ?? 0;
    if ($("#sigDupCount")) $("#sigDupCount").textContent = summary.duplicates ?? 0;
    if ($("#sigTopSymbol")) {
      const top = summary.by_symbol
        ? Object.entries(summary.by_symbol).sort((a, b) => b[1] - a[1])[0]
        : null;
      $("#sigTopSymbol").textContent = top ? top[0] : "—";
    }
    const oc = summary.outcomes || {};
    if ($("#sigWinRate")) $("#sigWinRate").textContent = oc.win_rate != null ? `${oc.win_rate}%` : "—";
    if ($("#sigWinsCount")) $("#sigWinsCount").textContent = oc.wins ?? 0;
    if ($("#sigLossCount")) $("#sigLossCount").textContent = oc.losses ?? 0;
    if ($("#sigOpenCount")) $("#sigOpenCount").textContent = oc.open ?? 0;
    renderSignalDailyChart(summary.daily || []);
    renderSignalDirChart(dir);
  }

  function renderSignalDailyChart(daily) {
    const canvas = $("#signalDailyChart");
    if (!canvas) return;
    prepareChartCanvas(canvas);
    setSignalChartState("#signalDailyChart", "#signalDailyEmpty", !!daily?.length);
    if (!daily?.length) {
      if (signalDailyChart) {
        signalDailyChart.data.labels = [];
        signalDailyChart.data.datasets.forEach((d) => (d.data = []));
        signalDailyChart.update("none");
      }
      return;
    }
    const labels = daily.map((d) => d.date.slice(5));
    const sent = daily.map((d) => d.sent || 0);
    const failed = daily.map((d) => d.failed || 0);
    const unsent = daily.map((d) => d.unsent || 0);

    if (signalDailyChart) {
      signalDailyChart.data.labels = labels;
      signalDailyChart.data.datasets[0].data = sent;
      signalDailyChart.data.datasets[1].data = failed;
      signalDailyChart.data.datasets[2].data = unsent;
      signalDailyChart.update("none");
      return;
    }

    signalDailyChart = new Chart(canvas, {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "ارسال موفق", data: sent, backgroundColor: "rgba(74,222,128,0.75)", borderRadius: 4, stack: "s" },
          { label: "خطا", data: failed, backgroundColor: "rgba(248,113,113,0.75)", borderRadius: 4, stack: "s" },
          { label: "بدون تأیید", data: unsent, backgroundColor: "rgba(251,191,36,0.65)", borderRadius: 4, stack: "s" },
        ],
      },
      options: {
        ...chartDefaults(),
        scales: {
          x: { stacked: true, ticks: { color: "#5c6578", font: chartFont(9) }, grid: { display: false } },
          y: { stacked: true, beginAtZero: true, ticks: { color: "#5c6578", stepSize: 1, font: chartFont(9) }, grid: { color: "rgba(255,255,255,0.04)" } },
        },
        plugins: { legend: { position: "bottom", rtl: false, textDirection: "ltr", labels: { color: "#8b95a8", font: chartFont(9), boxWidth: 10 } } },
      },
    });
  }

  function renderSignalDirChart(byDirection) {
    const canvas = $("#signalDirChart");
    if (!canvas) return;
    prepareChartCanvas(canvas);
    const buy = byDirection.BUY || 0;
    const sell = byDirection.SELL || 0;
    setSignalChartState("#signalDirChart", "#signalDirEmpty", !!(buy || sell));
    if (!buy && !sell) {
      if (signalDirChart) {
        signalDirChart.data.datasets[0].data = [0, 0];
        signalDirChart.update("none");
      }
      return;
    }
    if (signalDirChart) {
      signalDirChart.data.datasets[0].data = [buy, sell];
      signalDirChart.update("none");
      return;
    }
    signalDirChart = new Chart(canvas, {
      type: "doughnut",
      data: {
        labels: ["BUY", "SELL"],
        datasets: [{
          data: [buy, sell],
          backgroundColor: ["rgba(74,222,128,0.85)", "rgba(248,113,113,0.85)"],
          borderWidth: 0,
          hoverOffset: 8,
        }],
      },
      options: {
        ...chartDefaults(),
        cutout: "62%",
        plugins: {
          legend: { position: "bottom", rtl: false, textDirection: "ltr", labels: { color: "#8b95a8", font: chartFont(9), padding: isMobileViewport() ? 8 : 16 } },
        },
      },
    });
    logClientEvent("chart-created", {
      chart: "direction",
      dims: {
        canvas: { w: canvas.clientWidth, h: canvas.clientHeight },
        box: canvas.parentElement ? { w: canvas.parentElement.clientWidth, h: canvas.parentElement.clientHeight } : null,
      },
      devicePixelRatio: window.devicePixelRatio || 1,
    });
  }

  function resizeReportCharts() {
    [dailyChart, directionChart, symbolBarChart, telegramReportChart, hourlyHeatmapChart].forEach((chart) => {
      if (!chart) return;
      chart.resize();
      chart.update("none");
    });
  }

  function setSignalChartState(canvasSel, hintSel, hasData) {
    const canvas = $(canvasSel);
    const box = canvas?.closest(".chart-box");
    const hint = $(hintSel);
    if (box) box.classList.toggle("has-data", hasData);
    if (canvas) canvas.setAttribute("aria-hidden", hasData ? "false" : "true");
    if (hint) hint.textContent = hasData ? "" : "داده‌ای برای نمایش وجود ندارد";
  }

  function renderSignalPagination(totalItems, totalPages) {
    const nav = $("#signalPagination");
    if (!nav) return;
    if (totalItems <= SIGNALS_PAGE_SIZE || totalPages <= 1) {
      nav.innerHTML = "";
      nav.hidden = true;
      return;
    }
    nav.hidden = false;
    const pages = [];
    for (let p = 1; p <= totalPages; p += 1) {
      if (p === 1 || p === totalPages || Math.abs(p - signalPage) <= 1) {
        pages.push(p);
      } else if (pages[pages.length - 1] !== "...") {
        pages.push("...");
      }
    }
    nav.innerHTML = `
      <button type="button" class="sig-page-btn prev" data-signal-page="${signalPage - 1}" ${signalPage <= 1 ? "disabled" : ""}>قبلی</button>
      <div class="sig-page-list">
        ${pages.map((p) => p === "..."
          ? '<span class="sig-page-ellipsis">...</span>'
          : `<button type="button" class="sig-page-btn num ${p === signalPage ? "active" : ""}" data-signal-page="${p}" aria-current="${p === signalPage ? "page" : "false"}">${p}</button>`
        ).join("")}
      </div>
      <button type="button" class="sig-page-btn next" data-signal-page="${signalPage + 1}" ${signalPage >= totalPages ? "disabled" : ""}>بعدی</button>
      <span class="sig-page-summary">صفحه ${signalPage} از ${totalPages}</span>
    `;
  }

  function renderSignals(signals) {
    const feed = $("#signalFeed");
    if (!feed || !signals) return;
    const q = ($("#signalSearch")?.value || "").trim().toUpperCase();
    const filtered = q
      ? signals.filter((s) => (s.symbol || "").toUpperCase().includes(q))
      : signals;
    const total = signalsSummary?.total ?? signals.length;
    const totalPages = Math.max(1, Math.ceil(filtered.length / SIGNALS_PAGE_SIZE));
    signalPage = Math.min(Math.max(1, signalPage), totalPages);
    const start = (signalPage - 1) * SIGNALS_PAGE_SIZE;
    const pageSignals = filtered.slice(start, start + SIGNALS_PAGE_SIZE);

    if ($("#sigFeedCount")) {
      const total = signalsSummary?.total ?? signals.length;
      $("#sigFeedCount").textContent = filtered.length === total
        ? `${total} سیگنال`
        : `${filtered.length} از ${total} سیگنال`;
    }

    if ($("#sigFeedCount")) {
      const pageStart = filtered.length ? start + 1 : 0;
      const pageEnd = Math.min(start + SIGNALS_PAGE_SIZE, filtered.length);
      $("#sigFeedCount").textContent = filtered.length === total
        ? `${pageStart}-${pageEnd} از ${total} سیگنال`
        : `${pageStart}-${pageEnd} از ${filtered.length} / کل ${total}`;
    }

    if (!filtered.length) {
      renderSignalPagination(0, 1);
      feed.innerHTML = '<p class="signals-empty">سیگنالی با این فیلتر یافت نشد</p>';
      return;
    }

    feed.innerHTML = pageSignals
      .map((s, i) => {
        const dir = (s.direction || "").toUpperCase();
        const isBuy = dir === "BUY";
        const delivery = s.delivery_status || "unsent";
        const meta = DELIVERY_META[delivery] || DELIVERY_META.unsent;
        const outcomeMeta = OUTCOME_META[s.outcome] || OUTCOME_META.open;
        const cardCls = s.duplicate ? `${meta.cls} duplicate` : meta.cls;
        const dupBadge = s.duplicate
          ? '<span class="delivery-badge duplicate">⚠ تکراری</span>'
          : "";
        const score = s.score != null && s.score !== "" ? s.score : "—";
        const basis = s.basis
          ? `<div class="signal-basis">${esc(s.basis.length > 120 ? s.basis.slice(0, 120) + "…" : s.basis)}</div>`
          : "";
        const tgNote = s.telegram_detail
          ? `<div class="signal-tg-note">${esc(s.telegram_detail)}</div>`
          : "";

        return `
        <article class="signal-card ${cardCls}" style="animation-delay:${Math.min(i * 0.04, 0.8)}s">
          <div class="signal-card-icon" aria-hidden="true">${meta.icon}</div>
          <div class="signal-card-main">
            <div class="signal-card-head">
              <span class="signal-card-symbol">${esc(s.symbol || "?")}</span>
              <span class="sig-dir-badge ${isBuy ? "buy" : "sell"}">${dir || "—"}</span>
              <span class="delivery-badge ${meta.cls}">${meta.label}</span>
              <span class="outcome-badge ${outcomeMeta.cls}">${outcomeMeta.label}</span>
              ${dupBadge}
              <span class="signal-card-time">${esc(s.timestamp || "")}</span>
            </div>
            <div class="signal-levels">
              <div class="signal-lvl entry"><label>Entry</label><span>${fmtPrice(s.entry)}</span></div>
              <div class="signal-lvl sl"><label>SL</label><span>${fmtPrice(s.sl)}</span></div>
              <div class="signal-lvl tp"><label>TP1</label><span>${fmtPrice(s.tp1)}</span></div>
              <div class="signal-lvl"><label>RR</label><span>${s.rr != null && s.rr !== "" ? esc(String(s.rr)) : "—"}</span></div>
            </div>
            ${basis}
            ${tgNote}
          </div>
          <div class="signal-card-side">
            <div class="signal-score-ring" title="امتیاز سیگنال">${esc(String(score))}</div>
          </div>
        </article>`;
      })
      .join("");
    renderSignalPagination(filtered.length, totalPages);
  }

  function colorizeLog(line) {
    if (/ERROR|Exception|Failed/i.test(line)) return `<span class="log-err">${esc(line)}</span>`;
    if (/WARN/i.test(line)) return `<span class="log-warn">${esc(line)}</span>`;
    if (/INFO|Signal sent|Signal saved/i.test(line)) return `<span class="log-info">${esc(line)}</span>`;
    return esc(line);
  }

  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  async function refreshLogs({ force = false } = {}) {
    try {
      await fetchLogs({ force });
    } catch {}
  }

  async function refreshStatus({ force = false } = {}) {
    try {
      await fetchStatus({ force });
    } catch {}
  }

  async function refreshSignals({ force = false } = {}) {
    try {
      await fetchSignals({ force });
    } catch {}
  }

  async function refreshReports({ force = false } = {}) {
    const days = Number($("#reportDays")?.value || 30);
    try {
      await Promise.all([fetchReport(days, { force }), fetchReportAnalytics(days, { force })]);
    } catch {}
  }

  async function refreshTelegram({ force = false } = {}) {
    try {
      await fetchTelegram({ force });
    } catch {}
  }

  async function refreshSystem({ force = false } = {}) {
    try {
      await fetchSystem({ force });
    } catch {}
  }

  function syncLogPolling() {
    clearInterval(logInterval);
    logInterval = null;
    if (activePage === "logs" && isAuthenticated) {
      fetchLogs().catch(() => {});
      logInterval = setInterval(() => fetchLogs().catch(() => {}), 5000);
    }
  }

  // ── Reports ──
  function renderDailyChart(daily) {
    const canvas = $("#dailyChart");
    if (!canvas || !daily) return;
    prepareChartCanvas(canvas);
    try {
      const labels = daily.map((d) => d.date.slice(5));
      const buys = daily.map((d) => d.buy);
      const sells = daily.map((d) => d.sell);
      const totals = daily.map((d) => d.total);

      if (dailyChart) {
        dailyChart.data.labels = labels;
        dailyChart.data.datasets[0].data = totals;
        dailyChart.data.datasets[1].data = buys;
        dailyChart.data.datasets[2].data = sells;
        dailyChart.update("none");
        return;
      }

      dailyChart = new Chart(canvas, {
        type: "line",
        data: {
          labels,
          datasets: [
            {
              label: "کل",
              data: totals,
              borderColor: "#63ffd0",
              backgroundColor: "rgba(99,255,208,0.08)",
              fill: true,
              tension: 0.4,
              pointRadius: 4,
              pointHoverRadius: 6,
            },
            {
              label: "BUY",
              data: buys,
              borderColor: "#4ade80",
              backgroundColor: "transparent",
              tension: 0.4,
              pointRadius: 3,
            },
            {
              label: "SELL",
              data: sells,
              borderColor: "#f87171",
              backgroundColor: "transparent",
              tension: 0.4,
              pointRadius: 3,
            },
          ],
        },
        options: {
          ...chartDefaults(),
          interaction: { mode: "index", intersect: false },
          scales: {
            x: { ticks: { color: "#5c6578", font: chartFont(9) }, grid: { display: false } },
            y: { beginAtZero: true, ticks: { color: "#5c6578", font: chartFont(9), stepSize: 1 }, grid: { color: "rgba(255,255,255,0.04)" } },
          },
          animation: { duration: 700 },
        },
      });
      logClientEvent("chart-created", {
        chart: "daily",
        dims: { canvas: { w: canvas.clientWidth, h: canvas.clientHeight }, box: canvas.parentElement?.clientWidth ? { w: canvas.parentElement.clientWidth, h: canvas.parentElement.clientHeight } : null },
        devicePixelRatio: window.devicePixelRatio || 1,
      });
    } catch (err) {
      reportClientError("renderDailyChart", err, { hasChart: !!window.Chart, canvas: { w: canvas.clientWidth, h: canvas.clientHeight } });
    }
  }

  async function mgmt(action, { confirmMsg = null, btn = null } = {}) {
    if (mgmtBusy) return;
    if (confirmMsg && !confirm(confirmMsg)) return;
    try {
      if (btn) btn.classList.add("loading");
      setControlBusy(true);
      const data = await api("/api/management", {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      if (data.ok === false) {
        throw new Error(data.error || "عملیات ناموفق بود");
      }
      const msg = data.message || "انجام شد";
      toast(msg);
      logControlActivity(msg, "ok");
      invalidateCache("status", "system", "bootstrap", "report:*", "telegram:*", "cooldowns");
      lastStatusFingerprint = null;
      await fetchStatus({ force: true });
      applyControlPage(DataCache.get("status"));
      if (action === "toggle_debug") refreshReports({ force: true });
      if (action === "restart_dashboard") {
        setTimeout(() => window.location.reload(), 1500);
      }
    } catch (err) {
      logControlActivity(err.message, "err");
      toast(err.message, "error");
    } finally {
      if (btn) btn.classList.remove("loading");
      setControlBusy(false);
    }
  }

  $$(".mgmt-card[data-mgmt]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.mgmt;
      const confirmMsg =
        btn.dataset.confirm ||
        (action === "pause_notifications" ? "ارسال نوتیفیکیشن و موتور سیگنال متوقف شوند؟" : null);
      mgmt(action, { confirmMsg, btn });
    });
  });

  $("#ctrlStartAll")?.addEventListener("click", () => control("start", "all"));
  $("#ctrlStopAll")?.addEventListener("click", () => {
    if (confirm("همه فرآیندهای ربات متوقف شوند؟")) control("stop", "all");
  });
  $("#ctrlRestartAll")?.addEventListener("click", () => {
    if (confirm("signal-engine و signal-server ری‌استارت شوند؟")) mgmt("restart_all");
  });

  $("#btnRefreshProcesses")?.addEventListener("click", () => fetchStatus({ force: true }));
  $("#btnClearActivity")?.addEventListener("click", () => {
    controlActivity.length = 0;
    renderControlActivity();
  });

  $("#btnManageSymbols")?.addEventListener("click", openSymbolsModal);
  $("#btnSettingsSymbols")?.addEventListener("click", openSymbolsModal);
  $("#symbolsSelectAll")?.addEventListener("click", () => {
    symbolsPool.forEach((s) => symbolsEnabled.add(s));
    renderSymbolsModalLists();
  });
  $("#symbolsSelectNone")?.addEventListener("click", () => {
    symbolsEnabled.clear();
    renderSymbolsModalLists();
  });
  $("#symbolsModalClose")?.addEventListener("click", closeSymbolsModal);
  $("#symbolsModalCancel")?.addEventListener("click", closeSymbolsModal);
  $("#symbolsModalOverlay")?.addEventListener("click", (e) => {
    if (e.target === $("#symbolsModalOverlay")) closeSymbolsModal();
  });
  $("#symbolsModalSave")?.addEventListener("click", saveSymbolsDraft);
  $("#symbolAddBtn")?.addEventListener("click", () => {
    const input = $("#symbolAddInput");
    if (addSymbolToDraft(input?.value || "")) input.value = "";
  });
  $("#symbolAddInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const input = $("#symbolAddInput");
      if (addSymbolToDraft(input?.value || "")) input.value = "";
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("#symbolsModalOverlay")?.classList.contains("open")) {
      closeSymbolsModal();
    }
  });

  $("#reportDays")?.addEventListener("change", () => refreshReports({ force: true }));
  ["#simDays", "#simSymbol", "#simStatus"].forEach((selector) => {
    $(selector)?.addEventListener("change", () => {
      simulationPage = 1;
      fetchSimulation({ force: true }).catch((error) => toast(error.message, "error"));
    });
  });
  $("#btnSimRefresh")?.addEventListener("click", () => fetchSimulation({ force: true }).catch((error) => toast(error.message, "error")));
  $("#btnSimPrev")?.addEventListener("click", () => {
    if (simulationPage <= 1) return;
    simulationPage -= 1;
    fetchSimulation({ force: true }).catch((error) => toast(error.message, "error"));
  });
  $("#btnSimNext")?.addEventListener("click", () => {
    simulationPage += 1;
    fetchSimulation({ force: true }).catch((error) => {
      simulationPage = Math.max(1, simulationPage - 1);
      toast(error.message, "error");
    });
  });

  async function downloadExport(url) {
    try {
      const res = await authFetch(url);
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = res.headers.get("Content-Disposition")?.match(/filename=(.+)/)?.[1] || "export";
      a.click();
      URL.revokeObjectURL(a.href);
      toast("فایل دانلود شد");
    } catch {
      toast("خطا در دانلود", "error");
    }
  }

  $("#btnExportExcel")?.addEventListener("click", () => {
    const days = $("#reportDays")?.value || 30;
    downloadExport(`/api/export/signals.xlsx?days=${days}`);
  });

  $("#btnExportCsv")?.addEventListener("click", () => {
    const days = $("#reportDays")?.value || 30;
    downloadExport(`/api/export/signals.csv?days=${days}`);
  });

  $("#btnExportTelegram")?.addEventListener("click", () => {
    const days = $("#telegramDays")?.value || 30;
    downloadExport(`/api/export/telegram.csv?days=${days}`);
  });

  $("#telegramSearch")?.addEventListener("input", () => {
    resetTelegramPage();
    renderTelegramFeed(allTelegramEntries);
  });
  $("#telegramStatus")?.addEventListener("change", () => {
    resetTelegramPage();
    refreshTelegram({ force: true });
  });
  $("#telegramDays")?.addEventListener("change", () => {
    resetTelegramPage();
    refreshTelegram({ force: true });
  });

  $("#signalSearch")?.addEventListener("input", () => {
    resetSignalPage();
    renderSignals(allSignals);
  });
  $("#signalDays")?.addEventListener("change", () => {
    resetSignalPage();
    refreshSignals({ force: true });
  });
  $("#signalDelivery")?.addEventListener("change", () => {
    resetSignalPage();
    refreshSignals({ force: true });
  });
  $("#signalDirection")?.addEventListener("change", () => {
    resetSignalPage();
    refreshSignals({ force: true });
  });
  $("#signalOutcome")?.addEventListener("change", () => {
    resetSignalPage();
    refreshSignals({ force: true });
  });
  $("#signalPagination")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-signal-page]");
    if (!btn || btn.disabled) return;
    signalPage = Number(btn.dataset.signalPage || 1);
    renderSignals(allSignals);
    $("#signalFeed")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("#telegramPagination")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-telegram-page]");
    if (!btn || btn.disabled) return;
    telegramPage = Number(btn.dataset.telegramPage || 1);
    renderTelegramFeed(allTelegramEntries);
    $("#telegramFeed")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  $("#btnTelegramTest")?.addEventListener("click", (e) => sendTelegramTest(e.currentTarget));
  $("#homeBtnSymbols")?.addEventListener("click", openSymbolsModal);
  $("#homeBtnTelegramTest")?.addEventListener("click", (e) => sendTelegramTest(e.currentTarget));
  $("#homeBtnPauseNotif")?.addEventListener("click", () => mgmt("pause_notifications", { confirmMsg: "ارسال نوتیفیکیشن متوقف شود؟" }));
  $("#homeBtnResumeNotif")?.addEventListener("click", () => mgmt("resume_notifications"));

  $("#btnExportMetrics")?.addEventListener("click", () => downloadExport("/api/export/metrics.csv"));
  $("#btnSaveOps")?.addEventListener("click", () => saveOpsConfig().catch((e) => toast(e.message, "error")));
  $("#btnWhatsNew")?.addEventListener("click", openChangelogModal);
  $("#sidebarVersionFull")?.addEventListener("click", openChangelogModal);
  $("#changelogModalClose")?.addEventListener("click", closeChangelogModal);
  $("#changelogModalOverlay")?.addEventListener("click", (e) => {
    if (e.target === $("#changelogModalOverlay")) closeChangelogModal();
  });
  $("#btnRefreshAudit")?.addEventListener("click", () => fetchAuditLog({ force: true }));
  $("#btnConfigBackup")?.addEventListener("click", async () => {
    try {
      const data = await api("/api/config/backup");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `tradechi-config-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast("پشتیبان دانلود شد");
      fetchAuditLog({ force: true }).catch(() => {});
    } catch (err) {
      toast(err.message, "error");
    }
  });
  $("#configRestoreFile")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      if (!confirm("تنظیمات از فایل بازیابی شود؟")) return;
      const data = await api("/api/config/restore", { method: "POST", body: JSON.stringify(payload) });
      toast(`بازیابی شد: ${(data.restored || []).join(", ")}`);
      invalidateCache("status", "bootstrap", "ops", "audit");
      await fetchStatus({ force: true });
      await fetchOpsConfig({ force: true });
    } catch (err) {
      toast(err.message || "فایل نامعتبر", "error");
    } finally {
      e.target.value = "";
    }
  });

  $("#telegramFeed")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-retry-symbol]");
    if (btn) retryTelegramSend(btn);
  });

  async function refreshSystem({ force = false } = {}) {
    try {
      await fetchSystem({ force });
    } catch {}
  }

  $("#cfgMinScoreRange")?.addEventListener("pointerdown", markSettingsDraft);
  $("#cfgMinScoreRange")?.addEventListener("focus", markSettingsDraft);
  $("#cfgMinScoreRange")?.addEventListener("input", (e) => {
    const v = e.target.value;
    applySettingsFieldValue("#cfgMinScoreRange", "#cfgMinScore", "#settingsScoreDisplay", v);
    if ($("#settingsMinScore")) $("#settingsMinScore").textContent = v;
    markSettingsDraft();
  });

  $("#cfgPollRange")?.addEventListener("pointerdown", markSettingsDraft);
  $("#cfgPollRange")?.addEventListener("focus", markSettingsDraft);
  $("#cfgPollRange")?.addEventListener("input", (e) => {
    const v = e.target.value;
    applySettingsFieldValue("#cfgPollRange", "#cfgPoll", "#settingsPollDisplay", v, "s");
    if ($("#settingsPollVal")) $("#settingsPollVal").textContent = `${v}s`;
    markSettingsDraft();
  });

  async function fetchStrategy({ force = false } = {}) {
    const data = await DataCache.load(
      "strategy",
      () => api("/api/strategy"),
      60000,
      { force, onStale: (d) => renderStrategyPanel(d) }
    );
    if (!strategySelectedId && data?.active_id) {
      strategySelectedId = data.active_id;
    }
    renderStrategyPanel(data);
    if (strategySelectedId) {
      fetchStrategyDetail(strategySelectedId).catch(() => {});
    }
    return data;
  }

  function formatBytes(n) {
    if (!n) return "0 B";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  }

  function formatWinRate(rate) {
    return rate != null ? `${rate}%` : "—";
  }

  function winRateBadgeClass(rate) {
    if (rate == null) return "";
    if (rate >= 60) return "win-good";
    if (rate >= 45) return "win-warn";
    return "win-bad";
  }

  function renderStrategyKpis(perf, container) {
    if (!container || !perf) return;
    const items = [
      ["سیگنال", perf.signals ?? 0],
      ["Win Rate", formatWinRate(perf.win_rate)],
      ["برد", perf.wins ?? 0],
      ["باخت", perf.losses ?? 0],
      ["باز", perf.open ?? 0],
      ["میانگین Score", perf.avg_score ?? "—"],
      ["BUY", perf.buy ?? 0],
      ["SELL", perf.sell ?? 0],
      ["تلگرام", perf.delivery_rate != null ? `${perf.delivery_rate}%` : "—"],
      ["فعال (ساعت)", perf.active_hours ?? 0],
    ];
    container.innerHTML = items
      .map(
        ([lbl, val]) =>
          `<div class="strategy-kpi"><span class="strategy-kpi-lbl">${lbl}</span><span class="strategy-kpi-val">${esc(String(val))}</span></div>`
      )
      .join("");
  }

  function renderStrategyComparison(payload) {
    const wrap = $("#strategyPerfSummary");
    const grid = $("#strategyCompareGrid");
    const meta = $("#strategyPerfMeta");
    if (!wrap || !grid) return;
    const summary = payload?.performance_summary;
    const comparison = summary?.comparison || [];
    if (!comparison.length) {
      wrap.classList.add("hidden");
      return;
    }
    wrap.classList.remove("hidden");
    const bestId = summary?.best_win_rate_id;
    if (meta) {
      const tracked = summary?.tracked_signals ?? 0;
      meta.textContent = `${comparison.length} نسخه · ${tracked} سیگنال ثبت‌شده`;
    }
    grid.innerHTML = comparison
      .map((row) => {
        const winCls = row.win_rate != null ? "" : " muted";
        const badges = [
          row.is_active ? "active" : "",
          row.id === bestId && row.win_rate != null ? "best" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return `<article class="strategy-compare-card ${badges}" data-strategy-select="${esc(row.id)}">
          <div class="strategy-compare-name">${esc(row.original_name || row.id)}${row.version ? ` <small>v${esc(row.version)}</small>` : ""}</div>
          <div class="strategy-compare-win${winCls}">${formatWinRate(row.win_rate)}</div>
          <div class="strategy-compare-meta">${row.signals ?? 0} sig · ${row.wins ?? 0}W/${row.losses ?? 0}L${row.is_active ? " · فعال" : ""}</div>
        </article>`;
      })
      .join("");
    grid.querySelectorAll("[data-strategy-select]").forEach((el) => {
      el.addEventListener("click", () => selectStrategyVersion(el.dataset.strategySelect));
    });
  }

  async function selectStrategyVersion(entryId) {
    if (!entryId) return;
    strategySelectedId = entryId;
    const payload = DataCache.get("strategy");
    if (payload) renderStrategyPanel(payload);
    await fetchStrategyDetail(entryId).catch((e) => toast(e.message, "error"));
  }

  async function fetchStrategyDetail(entryId) {
    const data = await api(`/api/strategy/performance?id=${encodeURIComponent(entryId)}`);
    renderStrategyDetail(data);
    return data;
  }

  function renderStrategyDetail(data) {
    const panel = $("#strategyDetail");
    if (!panel || !data?.entry) return;
    panel.classList.remove("hidden");
    const entry = data.entry;
    const perf = data.performance || {};
    if ($("#strategyDetailTitle")) {
      $("#strategyDetailTitle").textContent = entry.original_name || entry.stored_name || "نسخه";
    }
    if ($("#strategyDetailSub")) {
      const parts = [
        entry.version ? `v${entry.version}` : null,
        entry.applied_at ? `فعال از ${entry.applied_at}` : "هرگز فعال نشده",
        perf.activations ? `${perf.activations} بار فعال‌سازی` : null,
      ].filter(Boolean);
      $("#strategyDetailSub").textContent = parts.join(" · ");
    }
    renderStrategyKpis(perf, $("#strategyDetailKpis"));
    const periodsEl = $("#strategyDetailPeriods");
    if (periodsEl) {
      const periods = data.periods || [];
      periodsEl.innerHTML = periods.length
        ? periods
            .map(
              (p) => `<div class="strategy-period-row${p.is_active ? " active-period" : ""}">
              <span class="strategy-period-meta">${esc(p.started_at || "—")}${p.ended_at ? ` → ${esc(p.ended_at)}` : " → now"}</span>
              <span class="strategy-period-stats">${p.stats?.signals ?? 0} sig · ${formatWinRate(p.stats?.win_rate)} · ${p.duration_hours ?? 0}h</span>
            </div>`
            )
            .join("")
        : '<p class="panel-empty">این نسخه هنوز فعال نشده — پس از فعال‌سازی آمار جمع می‌شود.</p>';
    }
    const sigEl = $("#strategyDetailSignals");
    if (sigEl) {
      const recent = data.recent_signals || [];
      sigEl.innerHTML = recent.length
        ? recent
            .map((s) => {
              const dir = (s.direction || "").toUpperCase();
              const meta = OUTCOME_META[s.outcome] || OUTCOME_META.open;
              const time = s.timestamp ? String(s.timestamp).split(" ")[1] || s.timestamp : "—";
              return `<div class="strategy-signal-row">
                <span class="strategy-signal-time">${esc(time)}</span>
                <span class="strategy-signal-symbol">${esc(s.symbol || "?")}</span>
                <span class="sig-dir-badge ${dir === "BUY" ? "buy" : "sell"}">${dir || "—"}</span>
                <span class="outcome-badge ${meta.cls}">${meta.label}</span>
                <span>${s.score ?? "—"}</span>
              </div>`;
            })
            .join("")
        : '<p class="panel-empty">سیگنالی در دوره فعال بودن این نسخه ثبت نشده.</p>';
    }
  }

  function renderStrategyPanel(payload) {
    const currentEl = $("#strategyCurrent");
    const historyEl = $("#strategyHistory");
    if (!currentEl || !historyEl) return;

    const active = payload?.active;
    const activeId = payload?.active_id;
    const activePerf = payload?.performance_summary?.active;

    if (!active && !(payload?.history || []).length) {
      currentEl.innerHTML = '<p class="panel-empty">هنوز استراتژی فعالی ثبت نشده — فایل .mq5 را آپلود کنید</p>';
    } else if (active) {
      const perfLine = activePerf?.signals
        ? `<div class="strategy-stat"><span class="strategy-stat-lbl">عملکرد فعال</span><span class="strategy-stat-val">${formatWinRate(activePerf.win_rate)} · ${activePerf.signals} sig · ${activePerf.wins ?? 0}W/${activePerf.losses ?? 0}L</span></div>`
        : `<div class="strategy-stat"><span class="strategy-stat-lbl">عملکرد فعال</span><span class="strategy-stat-val">در انتظار سیگنال</span></div>`;
      currentEl.innerHTML = `
        <div class="strategy-stat"><span class="strategy-stat-lbl">فایل فعال</span><span class="strategy-stat-val">${esc(active.original_name || "—")}</span></div>
        <div class="strategy-stat"><span class="strategy-stat-lbl">نسخه / Inputs</span><span class="strategy-stat-val">${esc(active.version || "—")} · ${active.input_count ?? "—"}</span></div>
        <div class="strategy-stat"><span class="strategy-stat-lbl">آخرین اعمال</span><span class="strategy-stat-val">${esc(active.applied_at || active.uploaded_at || "—")}</span></div>
        ${perfLine}`;
    } else {
      currentEl.innerHTML = '<p class="panel-empty">فایل آپلود شده ولی هنوز فعال نشده — «فعال‌سازی روی ربات» را بزنید</p>';
    }

    renderStrategyComparison(payload);

    const rows = payload?.history || [];
    if (!rows.length) {
      historyEl.innerHTML = '<p class="panel-empty">هنوز فایلی آپلود نشده</p>';
    } else {
      historyEl.innerHTML = rows
        .map((row) => {
          const isActive = row.id === activeId;
          const isSelected = row.id === strategySelectedId;
          const perf = row.performance || {};
          const winCls = winRateBadgeClass(perf.win_rate);
          const applied = row.applied_at ? "اعمال‌شده" : "آپلود فقط";
          return `<div class="strategy-history-row${isActive ? " active" : ""}${isSelected ? " selected" : ""}" data-strategy-select="${esc(row.id)}">
            <div>
              <strong>${esc(row.original_name || row.stored_name)}</strong>
              <div class="strategy-history-meta">${esc(row.uploaded_at || "")} · ${formatBytes(row.size_bytes)} · ${esc(row.uploaded_by || "")}${row.version ? ` · v${esc(row.version)}` : ""} · ${applied}</div>
              <div class="strategy-history-badges">
                ${isActive ? '<span class="strategy-badge active-badge">فعال</span>' : ""}
                <span class="strategy-badge ${winCls}">WR ${formatWinRate(perf.win_rate)}</span>
                <span class="strategy-badge">${perf.signals ?? 0} sig</span>
                <span class="strategy-badge">${perf.wins ?? 0}W / ${perf.losses ?? 0}L</span>
                ${perf.avg_score != null ? `<span class="strategy-badge">score ${perf.avg_score}</span>` : ""}
              </div>
            </div>
            <div class="strategy-history-actions">
              <button type="button" class="btn btn-sm btn-ghost" data-strategy-apply="${esc(row.id)}">فعال</button>
              <button type="button" class="btn btn-sm btn-ghost" data-strategy-dl="${esc(row.id)}">⬇</button>
            </div>
          </div>`;
        })
        .join("");
      historyEl.querySelectorAll("[data-strategy-select]").forEach((row) => {
        row.addEventListener("click", (e) => {
          if (e.target.closest("[data-strategy-apply], [data-strategy-dl]")) return;
          selectStrategyVersion(row.dataset.strategySelect);
        });
      });
      historyEl.querySelectorAll("[data-strategy-apply]").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          applyStrategy(btn.dataset.strategyApply);
        });
      });
      historyEl.querySelectorAll("[data-strategy-dl]").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          downloadExport(`/api/strategy/download?id=${encodeURIComponent(btn.dataset.strategyDl)}`);
        });
      });
    }

    if (strategySelectedId) {
      const stillExists = rows.some((r) => r.id === strategySelectedId);
      if (!stillExists) {
        strategySelectedId = null;
        $("#strategyDetail")?.classList.add("hidden");
      }
    }

    const applyBtn = $("#btnStrategyApply");
    if (applyBtn) {
      const targetId = strategyLastUploadId || activeId || rows[0]?.id;
      applyBtn.disabled = !targetId;
      applyBtn.dataset.strategyId = targetId || "";
    }
  }

  function setStrategyPendingFile(file) {
    strategyPendingFile = file || null;
    const picked = $("#strategyFilePicked");
    const nameEl = $("#strategyPickedName");
    const uploadBtn = $("#btnStrategyUpload");
    if (!file) {
      picked?.classList.add("hidden");
      if (uploadBtn) uploadBtn.disabled = true;
      const input = $("#strategyFileInput");
      if (input) input.value = "";
      return;
    }
    if (!/\.mq5$/i.test(file.name)) {
      toast("فقط فایل .mq5 مجاز است", "error");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast("حداکثر اندازه ۲ مگابایت", "error");
      return;
    }
    if (nameEl) nameEl.textContent = file.name;
    picked?.classList.remove("hidden");
    if (uploadBtn) uploadBtn.disabled = false;
  }

  async function uploadStrategy() {
    if (!strategyPendingFile) {
      toast("ابتدا فایل را انتخاب کنید", "error");
      return;
    }
    const btn = $("#btnStrategyUpload");
    const form = new FormData();
    form.append("file", strategyPendingFile);
    try {
      if (btn) btn.classList.add("loading");
      btn && (btn.disabled = true);
      const res = await authFetch("/api/strategy/upload", { method: "POST", body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "آپلود ناموفق");
      strategyLastUploadId = data.entry?.id || null;
      DataCache.set("strategy", data.strategy || data);
      renderStrategyPanel(data.strategy || data);
      setStrategyPendingFile(null);
      toast("استراتژی آپلود شد — برای اعمال روی ربات «فعال‌سازی» را بزنید");
      logControlActivity(`استراتژی آپلود: ${data.entry?.original_name || "?"}`, "ok");
      invalidateCache("status", "bootstrap");
      await fetchAuditLog({ force: true }).catch(() => {});
    } catch (err) {
      toast(err.message, "error");
    } finally {
      if (btn) {
        btn.classList.remove("loading");
        btn.disabled = !strategyPendingFile;
      }
    }
  }

  async function applyStrategy(entryId) {
    const id = entryId || strategyLastUploadId || $("#btnStrategyApply")?.dataset.strategyId;
    if (!id) {
      toast("نسخه‌ای برای فعال‌سازی وجود ندارد", "error");
      return;
    }
    if (!confirm("استراتژی جدید روی ربات فعال شود؟ signal-engine ری‌استارت می‌شود.")) return;
    const btn = $("#btnStrategyApply");
    try {
      if (btn) btn.classList.add("loading");
      const data = await api("/api/strategy/apply", {
        method: "POST",
        body: JSON.stringify({ id, restart_engine: true }),
      });
      DataCache.set("strategy", data.strategy);
      renderStrategyPanel(data.strategy);
      strategyLastUploadId = null;
      if (data.entry?.id) {
        strategySelectedId = data.entry.id;
        await fetchStrategyDetail(data.entry.id).catch(() => {});
      }
      lastStatusFingerprint = null;
      invalidateCache("status", "bootstrap");
      await fetchStatus({ force: true });
      let msg = "استراتژی فعال شد";
      if (data.min_score_synced) msg += ` — MIN_SCORE=${data.min_score_synced}`;
      if (data.restart_skipped) msg += " — موتور متوقف ماند (نوتیفیکیشن pause)";
      else if (data.restart_engine === false) msg += " (ری‌استارت موتور ناموفق بود)";
      toast(msg);
      logControlActivity(`استراتژی فعال: ${data.entry?.original_name || id}`, "ok");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      if (btn) btn.classList.remove("loading");
    }
  }

  function initStrategyUpload() {
    const zone = $("#strategyDropZone");
    const input = $("#strategyFileInput");
    if (!zone || !input) return;

    $("#btnStrategyBrowse")?.addEventListener("click", () => input.click());
    $("#btnStrategyClear")?.addEventListener("click", () => setStrategyPendingFile(null));
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file) setStrategyPendingFile(file);
    });

    ["dragenter", "dragover"].forEach((ev) => {
      zone.addEventListener(ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.add("dragover");
      });
    });
    ["dragleave", "drop"].forEach((ev) => {
      zone.addEventListener(ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.remove("dragover");
      });
    });
    zone.addEventListener("drop", (e) => {
      const file = e.dataTransfer?.files?.[0];
      if (file) setStrategyPendingFile(file);
    });

    $("#btnStrategyUpload")?.addEventListener("click", () => uploadStrategy());
    $("#btnStrategyApply")?.addEventListener("click", () => applyStrategy());
    $("#btnStrategyDownload")?.addEventListener("click", () => downloadExport("/api/strategy/download?active=1"));
    $("#btnStrategyRefresh")?.addEventListener("click", () => fetchStrategy({ force: true }).catch((e) => toast(e.message, "error")));
    $("#btnStrategyDetailClose")?.addEventListener("click", () => {
      strategySelectedId = null;
      $("#strategyDetail")?.classList.add("hidden");
      const payload = DataCache.get("strategy");
      if (payload) renderStrategyPanel(payload);
    });
  }

  // ── Facebook Operations ──
  function closeFacebookGroupModal() {
    $("#fbGroupModal")?.classList.remove("open");
    $("#fbGroupModal")?.setAttribute("aria-hidden", "true");
  }

  function closeFacebookPreviewModal() {
    $("#fbPreviewModal")?.classList.remove("open");
    $("#fbPreviewModal")?.setAttribute("aria-hidden", "true");
  }

  $("#btnFbAddGroup")?.addEventListener("click", () => {
    $("#fbGroupForm")?.reset();
    if ($("#fbGroupId")) $("#fbGroupId").value = "";
    if ($("#fbGroupModalTitle")) $("#fbGroupModalTitle").textContent = "افزودن گروه فیسبوک";
    if ($("#fbGroupError")) $("#fbGroupError").textContent = "";
    $("#fbGroupModal")?.classList.add("open");
    $("#fbGroupModal")?.setAttribute("aria-hidden", "false");
    setTimeout(() => $("#fbGroupName")?.focus(), 80);
  });
  $$("[data-fb-close]").forEach((button) => button.addEventListener("click", closeFacebookGroupModal));
  $$("[data-fb-preview-close]").forEach((button) => button.addEventListener("click", closeFacebookPreviewModal));

  $("#fbGroupForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = event.submitter;
    try {
      submit?.classList.add("loading");
      const groupId = $("#fbGroupId")?.value || "";
      await api(groupId ? `/api/facebook/groups/${groupId}` : "/api/facebook/groups", {
        method: groupId ? "PATCH" : "POST",
        body: JSON.stringify({
          name: $("#fbGroupName")?.value,
          url: $("#fbGroupUrl")?.value,
          language: $("#fbGroupLanguage")?.value,
          template: $("#fbGroupTemplate")?.value,
          enabled: true,
        }),
      });
      closeFacebookGroupModal();
      invalidateCache("facebook");
      await fetchFacebook({ force: true });
      toast(groupId ? "تغییرات گروه ذخیره شد" : "گروه فیسبوک اضافه شد");
    } catch (error) {
      if ($("#fbGroupError")) $("#fbGroupError").textContent = error.message;
    } finally {
      submit?.classList.remove("loading");
    }
  });

  $("#fbGroupsList")?.addEventListener("change", async (event) => {
    const input = event.target.closest("[data-fb-toggle]");
    if (!input) return;
    try {
      await api(`/api/facebook/groups/${input.dataset.fbToggle}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: input.checked }),
      });
      invalidateCache("facebook");
      await fetchFacebook({ force: true });
    } catch (error) {
      input.checked = !input.checked;
      toast(error.message, "error");
    }
  });

  $("#fbGroupsList")?.addEventListener("click", async (event) => {
    const editButton = event.target.closest("[data-fb-edit]");
    if (editButton) {
      const group = (facebookPayload?.groups || []).find((item) => item.id === editButton.dataset.fbEdit);
      if (!group) return;
      if ($("#fbGroupId")) $("#fbGroupId").value = group.id;
      if ($("#fbGroupName")) $("#fbGroupName").value = group.name;
      if ($("#fbGroupUrl")) $("#fbGroupUrl").value = group.url;
      if ($("#fbGroupLanguage")) $("#fbGroupLanguage").value = group.language;
      if ($("#fbGroupTemplate")) $("#fbGroupTemplate").value = group.template;
      if ($("#fbGroupModalTitle")) $("#fbGroupModalTitle").textContent = "ویرایش گروه فیسبوک";
      if ($("#fbGroupError")) $("#fbGroupError").textContent = "";
      $("#fbGroupModal")?.classList.add("open");
      $("#fbGroupModal")?.setAttribute("aria-hidden", "false");
      return;
    }
    const button = event.target.closest("[data-fb-delete]");
    if (!button || !confirm("این گروه از مقصدهای فیسبوک حذف شود؟")) return;
    try {
      await api(`/api/facebook/groups/${button.dataset.fbDelete}`, { method: "DELETE" });
      invalidateCache("facebook");
      await fetchFacebook({ force: true });
      toast("گروه حذف شد");
    } catch (error) {
      toast(error.message, "error");
    }
  });

  $("#fbGroupSearch")?.addEventListener("input", () => renderFacebook(facebookPayload));

  async function setAllFacebookGroups(enabled) {
    try {
      await api("/api/facebook/groups/bulk", { method: "PATCH", body: JSON.stringify({ enabled }) });
      invalidateCache("facebook");
      await fetchFacebook({ force: true });
      toast(enabled ? "همه گروه‌ها فعال شدند" : "همه گروه‌ها متوقف شدند");
    } catch (error) {
      toast(error.message, "error");
    }
  }
  $("#btnFbEnableAll")?.addEventListener("click", () => setAllFacebookGroups(true));
  $("#btnFbDisableAll")?.addEventListener("click", () => setAllFacebookGroups(false));

  $("#btnFbSessionUpload")?.addEventListener("click", () => $("#fbSessionFile")?.click());
  $("#fbSessionFile")?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    const button = $("#btnFbSessionUpload");
    try {
      setFacebookButtonBusy(button, true, "در حال بارگذاری...");
      setFacebookSessionState("testing", "فایل در حال اعتبارسنجی و ذخیره امن روی سرور است.");
      const response = await authFetch("/api/facebook/session", { method: "POST", body: form });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "آپلود سشن ناموفق بود");
      invalidateCache("facebook");
      await fetchFacebook({ force: true });
      setFacebookSessionState("untested", "", data.cookies);
      toast(`سشن فیسبوک با ${data.cookies} کوکی ذخیره شد`);
    } catch (error) {
      setFacebookSessionState("failed", error.message);
      toast(error.message, "error");
    } finally {
      setFacebookButtonBusy(button, false);
      event.target.value = "";
    }
  });

  $("#btnFbTestSession")?.addEventListener("click", async () => {
    const button = $("#btnFbTestSession");
    if (!button || button.disabled || button.classList.contains("loading")) return;
    try {
      setFacebookButtonBusy(button, true, "در حال بررسی ورود...");
      setFacebookSessionState("testing");
      const result = await api("/api/facebook/session/test", { method: "POST" });
      setFacebookSessionState("connected", "", result.cookies);
      toast(`اتصال حساب تأیید شد · ${result.cookies} کوکی فعال`);
      invalidateCache("facebook");
      await fetchFacebook({ force: true });
    } catch (error) {
      setFacebookSessionState("failed", error.message);
      toast(`تست اتصال ناموفق: ${error.message}`, "error");
    } finally {
      setFacebookButtonBusy(button, false);
    }
  });

  $("#fbAutoPost")?.addEventListener("change", async (event) => {
    const enabled = event.target.checked;
    try {
      await api("/api/facebook/mode", { method: "PATCH", body: JSON.stringify({ auto_post: enabled }) });
      if ($("#fbModeText")) $("#fbModeText").textContent = enabled ? "ارسال خودکار" : "تأیید دستی";
      invalidateCache("facebook");
      toast(enabled ? "ارسال خودکار فعال شد" : "تأیید دستی فعال شد");
    } catch (error) {
      event.target.checked = !enabled;
      toast(error.message, "error");
    }
  });

  function showFacebookPreviewTemplate(key) {
    if (!facebookPreviewTemplates) return;
    const [language, template] = key.split(":");
    const message = facebookPreviewTemplates?.[language]?.[template] || "";
    if ($("#fbMessagePreview")) $("#fbMessagePreview").textContent = message;
    $$("#fbPreviewTabs [data-fb-template]").forEach((button) => button.classList.toggle("active", button.dataset.fbTemplate === key));
  }

  $("#fbJobsList")?.addEventListener("click", async (event) => {
    const deleteButton = event.target.closest("[data-fb-job-delete]");
    if (deleteButton) {
      if (!confirm("این پیام از صف تأیید حذف شود؟")) return;
      try {
        await api(`/api/facebook/jobs/${deleteButton.dataset.fbJobDelete}`, { method: "DELETE" });
        invalidateCache("facebook");
        await fetchFacebook({ force: true });
        toast("پیام از صف حذف شد");
      } catch (error) {
        toast(error.message, "error");
      }
      return;
    }
    const button = event.target.closest("[data-fb-preview]");
    if (!button) return;
    try {
      button.classList.add("loading");
      const data = await api(`/api/facebook/jobs/${button.dataset.fbPreview}/preview`);
      facebookPreviewSignalId = button.dataset.fbPreview;
      facebookPreviewTemplates = data.templates;
      if ($("#fbPreviewSignal")) $("#fbPreviewSignal").textContent = `${data.signal.symbol} ${data.signal.direction} · ${data.signal.entry}`;
      const configured = (facebookPayload?.groups || []).filter((group) => group.enabled);
      const keys = [...new Set((configured.length ? configured : [
        { language: "English", template: "1" },
        { language: "Persian", template: "1" },
        { language: "Russian", template: "1" },
      ]).map((group) => `${group.language}:${group.template}`))];
      if ($("#fbPreviewTabs")) $("#fbPreviewTabs").innerHTML = keys.map((key) => {
        const [language, template] = key.split(":");
        return `<button type="button" data-fb-template="${esc(key)}">${esc(language)} · ${esc(template)}</button>`;
      }).join("");
      showFacebookPreviewTemplate(keys[0]);
      $("#fbPreviewModal")?.classList.add("open");
      $("#fbPreviewModal")?.setAttribute("aria-hidden", "false");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      button.classList.remove("loading");
    }
  });

  $("#fbPreviewTabs")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-fb-template]");
    if (button) showFacebookPreviewTemplate(button.dataset.fbTemplate);
  });

  $("#btnFbApproveSend")?.addEventListener("click", async () => {
    if (!facebookPreviewSignalId || !confirm("این پیام به تمام گروه‌های فعال ارسال شود؟")) return;
    const button = $("#btnFbApproveSend");
    try {
      button?.classList.add("loading");
      await api(`/api/facebook/jobs/${facebookPreviewSignalId}/send`, { method: "POST" });
      closeFacebookPreviewModal();
      toast("ارسال فیسبوک در صف اجرا قرار گرفت");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      button?.classList.remove("loading");
    }
  });

  $("#btnFbDryRun")?.addEventListener("click", async () => {
    if (!facebookPreviewSignalId) return;
    const button = $("#btnFbDryRun");
    try {
      button?.classList.add("loading");
      await api(`/api/facebook/jobs/${facebookPreviewSignalId}/dry-run`, { method: "POST" });
      toast("اجرای آزمایشی موفق بود؛ هیچ پیامی منتشر نشد");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      button?.classList.remove("loading");
    }
  });

  $("#btnFbLogs")?.addEventListener("click", async (event) => {
    event.preventDefault();
    try {
      const data = await api("/api/facebook/logs?lines=100");
      const entries = data.entries || [];
      if ($("#fbLogView")) {
        $("#fbLogView").textContent = entries.length
          ? entries.map((entry) => `[${entry.source}] ${entry.line}`).join("\n")
          : "هنوز لاگی ثبت نشده است.";
      }
    } catch (error) {
      toast(error.message, "error");
    }
  });

  $("#btnFbRefresh")?.addEventListener("click", () => fetchFacebook({ force: true }).catch((error) => toast(error.message, "error")));

  // ── Config Save ──
  $("#btnSaveConfig")?.addEventListener("click", async () => {
    const btn = $("#btnSaveConfig");
    try {
      if (btn) btn.classList.add("loading");
      const formCfg = readConfigFromForm();
      const result = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({
          SYMBOLS: formCfg.symbols,
          MIN_SCORE: formCfg.min_score,
          POLL_SECONDS: formCfg.poll_seconds,
          FACEBOOK_ENABLE: formCfg.facebook_enable ? "1" : "0",
          ENGINE_DEBUG: formCfg.engine_debug ? "1" : "0",
        }),
      });
      const savedCfg = result.config
        ? {
            symbols: result.config.SYMBOLS ?? formCfg.symbols,
            min_score: result.config.MIN_SCORE ?? formCfg.min_score,
            poll_seconds: result.config.POLL_SECONDS ?? formCfg.poll_seconds,
            facebook_enable: (result.config.FACEBOOK_ENABLE ?? (formCfg.facebook_enable ? "1" : "0")) === "1",
            engine_debug: (result.config.ENGINE_DEBUG ?? (formCfg.engine_debug ? "1" : "0")) === "1",
          }
        : formCfg;
      clearSettingsDraft();
      lastStatusFingerprint = null;
      invalidateCache("status", "bootstrap");
      applyConfigToDashboard(savedCfg);
      await fetchStatus({ force: true });
      const restart = result.engine_restart || {};
      if (restart.skipped) {
        toast("تنظیمات ذخیره شد و هنگام ادامه نوتیفیکیشن اعمال می‌شود");
      } else if (restart.ok === false) {
        toast("تنظیمات ذخیره شد، اما ری‌استارت خودکار موتور ناموفق بود", "error");
      } else {
        toast("تنظیمات ذخیره و روی موتور اعمال شد");
      }
      logControlActivity(
        `تنظیمات ذخیره و اعمال شد: min_score=${savedCfg.min_score}, poll=${savedCfg.poll_seconds}s`,
        restart.ok === false ? "error" : "ok"
      );
    } catch (err) {
      toast(err.message, "error");
    } finally {
      if (btn) btn.classList.remove("loading");
    }
  });

  $("#logSelect")?.addEventListener("change", () => {
    invalidateCache(logsCacheKey($("#logSelect")?.value || "signal-engine"));
    refreshLogs({ force: true });
  });

  // ── SSE Stream ──
  function connectSSE() {
    if (!isAuthenticated) return;
    eventSource?.close();
    eventSource = new EventSource("/api/stream", { withCredentials: true });
    eventSource.onopen = () => {
      sseConnected = true;
      if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = setInterval(() => fetchStatus().catch(() => {}), 45000);
      }
      syncMonitorPolling();
    };
    eventSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.processes) renderMonitorProcesses(data.processes);
        if (data.system) {
          DataCache.set("system", data.system);
          updateSystem(data.system);
        } else {
          syncMonitorHero();
        }
        if (data.server_time) updateLiveClock(data.server_time);
        handleLiveNotifications(data);
        if (data.uptime_history) {
          DataCache.set("uptime", data.uptime_history);
          renderUptimeHistory(data.uptime_history);
        }

        const prev = DataCache.get("status") || {};
        const merged = {
          ...prev,
          overall: data.overall,
          processes: data.processes,
          all_processes: data.all_processes || data.processes,
          signal_stats: data.signal_stats || prev.signal_stats,
          latest_signal: data.latest_signal !== undefined ? data.latest_signal : prev.latest_signal,
          server_time: data.server_time || prev.server_time,
        };
        DataCache.set("status", merged);
        applyStatusData(merged);
      } catch {}
    };
    eventSource.onerror = async () => {
      sseConnected = false;
      syncMonitorPolling();
      eventSource?.close();
      eventSource = null;
      if (!isAuthenticated) return;
      try {
        const res = await authFetch("/api/auth/check");
        const { authenticated } = await res.json();
        if (authenticated) {
          clearTimeout(sseReconnectTimer);
          sseReconnectTimer = setTimeout(connectSSE, 5000);
        } else {
          isAuthenticated = false;
          showLogin();
        }
      } catch {
        clearTimeout(sseReconnectTimer);
        sseReconnectTimer = setTimeout(connectSSE, 5000);
      }
    };
  }

  function startStreams() {
    stopStreams();
    switchPage(activePage, { revalidate: false });
    if (activePage === "facebook") {
      fetchFacebook({ force: true }).catch((error) => {
        toast(error.message || "بارگذاری اطلاعات فیسبوک ناموفق بود", "error");
      });
    }

    fetchBootstrap().catch(() => {
      fetchStatus({ force: true }).catch(() => {});
      fetchSystem({ force: true }).catch(() => {});
    });

    statusInterval = setInterval(() => {
      if (!sseConnected) fetchStatus().catch(() => {});
    }, sseConnected ? 45000 : 20000);
    syncLogPolling();
    connectSSE();
  }

  function stopStreams() {
    eventSource?.close();
    eventSource = null;
    clearTimeout(sseReconnectTimer);
    clearInterval(statusInterval);
    clearInterval(logInterval);
    clearInterval(monitorInterval);
    clearInterval(facebookInterval);
    logInterval = null;
    monitorInterval = null;
    facebookInterval = null;
  }

  // Background cache refresh hooks
  DataCache.onRevalidate("status", applyStatusData);
  DataCache.onRevalidate("system", updateSystem);
  DataCache.onRevalidate("telegram:30", applyTelegramData);

  // ── Init ──
  loadSettingsDraft();
  loadVersion();
  renderSidebarNav();
  initSidebarCollapse();
  renderControlActivity();
  initStrategyUpload();
  checkAuth();
})();
