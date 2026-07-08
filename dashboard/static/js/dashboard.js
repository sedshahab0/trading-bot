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
  let resourceHistoryChart = null;
  let cpuSparkChart = null;
  let ramSparkChart = null;
  let diskSparkChart = null;
  let netSparkChart = null;
  let eventSource = null;
  let logInterval = null;
  let statusInterval = null;
  let monitorInterval = null;
  let isAuthenticated = false;
  let sseReconnectTimer = null;
  let allSignals = [];
  let allTelegramEntries = [];
  let activePage = "home";
  let lastEngineState = null;
  let lastProcesses = [];
  const controlActivity = [];
  const MAX_ACTIVITY = 20;
  let lastSignalStatsKey = null;
  let symbolsDraft = [];
  let symbolsPool = [];
  let symbolsEnabled = new Set();
  let lastEngineStateForSymbols = null;

  const SYMBOL_PRESETS = [
    "EUR/USD", "GBP/USD", "USD/JPY", "XAU/USD", "USD/CHF",
    "AUD/USD", "USD/CAD", "NZD/USD", "EUR/GBP", "BTC/USD",
    "XAG/USD", "EUR/JPY",
  ];
  const MAX_SYMBOLS = 12;
  const resourceHistory = {
    labels: [],
    cpu: [],
    ram: [],
    disk: [],
    net: [],
    max: 30,
  };

  const PAGE_META = {
    home: { title: "داشبورد", sub: "نمای کلی ربات" },
    monitor: { title: "مانیتورینگ", sub: "منابع سرور، موتور تحلیل و سلامت سیستم" },
    control: { title: "کنترل ربات", sub: "مدیریت PM2، نوتیفیکیشن و عملیات موتور" },
    signals: { title: "سیگنال‌ها", sub: "ردیابی ارسال، خطا و کیفیت هر سیگنال" },
    reports: { title: "گزارش‌ها", sub: "تحلیل عملکرد، تلگرام و خروجی Excel" },
    telegram: { title: "تلگرام", sub: "لاگ کامل ارسال سیگنال‌ها به تلگرام" },
    settings: { title: "تنظیمات", sub: "سازماندهی نمادها، موتور و کانال‌های ارسال" },
    logs: { title: "لاگ‌ها", sub: "مشاهده زنده لاگ‌ها" },
  };

  /** Bump minor (2.1→2.2) for feature releases; major (2→3) for big rewrites. */
  let dashboardVersion = { label: "v2.6", full: "2.6.0", major: 2, minor: 6, patch: 0 };
  let signalsSummary = null;

  const NAV_ICONS = {
    home: '<path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
    control: '<circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83"/>',
    signals: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
    reports: '<path d="M18 20V10M12 20V4M6 20v-6"/>',
    telegram: '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/>',
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
        { page: "reports", label: "گزارش‌ها", icon: "reports" },
        { page: "telegram", label: "تلگرام", icon: "telegram" },
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
    status: 8000,
    system: 5000,
    signals: 20000,
    logs: 3000,
    report: 90000,
    bootstrap: 10000,
    telegram: 30000,
  };

  const PERSIST_KEYS = new Set(["status", "system", "signals:30:all:all", "report:7", "report:30", "telegram:30"]);

  const PAGE_NEEDS = {
    home: ["status", "report:7"],
    monitor: ["status", "system"],
    control: ["status"],
    signals: ["signals"],
    reports: [],
    telegram: ["telegram"],
    settings: ["status"],
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

    set(key, data, ts = Date.now()) {
      this._mem.set(key, { data, ts });
      if (PERSIST_KEYS.has(key)) {
        try {
          sessionStorage.setItem(`tc:${key}`, JSON.stringify({ data, ts }));
        } catch {}
      }
    },

    delete(key) {
      this._mem.delete(key);
      try {
        sessionStorage.removeItem(`tc:${key}`);
      } catch {}
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
      return Boolean(e && Date.now() - e.ts < ttl * 8);
    },

    hydrate() {
      PERSIST_KEYS.forEach((key) => {
        try {
          const raw = sessionStorage.getItem(`tc:${key}`);
          if (!raw) return;
          const { data, ts } = JSON.parse(raw);
          if (Date.now() - ts < 300000) this._mem.set(key, { data, ts });
        } catch {}
      });
    },

    onRevalidate(key, fn) {
      if (!this._revalidate.has(key)) this._revalidate.set(key, new Set());
      this._revalidate.get(key).add(fn);
    },

    _emitRevalidate(key, data) {
      this._revalidate.get(key)?.forEach((fn) => {
        try {
          fn(data);
        } catch {}
      });
    },

    async load(key, fetcher, ttl, { force = false } = {}) {
      if (!force && this.isFresh(key, ttl)) return this.get(key);

      const stale = !force && this.canServeStale(key, ttl) ? this.get(key) : null;

      if (this._inflight.has(key)) {
        if (stale) return stale;
        return this._inflight.get(key);
      }

      const task = Promise.resolve()
        .then(fetcher)
        .then((data) => {
          this.set(key, data);
          this._inflight.delete(key);
          this._emitRevalidate(key, data);
          return data;
        })
        .catch((err) => {
          this._inflight.delete(key);
          if (stale) return stale;
          throw err;
        });

      this._inflight.set(key, task);

      if (stale) {
        task.then((data) => {
          if (data) this._emitRevalidate(key, data);
        });
        return stale;
      }

      return task;
    },
  };

  function invalidateCache(...keys) {
    keys.forEach((k) => DataCache.delete(k));
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
    $("#loginOverlay").classList.remove("hidden");
    $("#dashboard").classList.add("hidden");
    stopStreams();
  }

  function showDashboard() {
    DataCache.hydrate();
    applyPageFromCache(activePage);
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

  function applyStatusData(data) {
    if (!data) return;
    updateStatusBanner(data.overall);
    renderProcesses(data.all_processes || data.processes);
    applyControlPage(data);
    renderHomeProcesses(data.processes);
    renderMonitorProcesses(data.processes);
    renderEngineState(data.engine_state);
    renderLatestSignal(data.latest_signal);
    renderStats(data.signal_stats, data);
    renderHomeSecondary(data);
    const time = data.server_time || "";
    if ($("#liveTime")) $("#liveTime").textContent = time.split(" ")[1] || "--:--:--";
    if ($("#heroUpdated")) $("#heroUpdated").textContent = time ? `بروزرسانی ${time}` : "";

    const cfg = data.config || {};
    if ($("#cfgSymbols")) $("#cfgSymbols").value = cfg.symbols || "";
    if ($("#cfgMinScore")) $("#cfgMinScore").value = cfg.min_score || "5";
    if ($("#cfgPoll")) $("#cfgPoll").value = cfg.poll_seconds || "30";
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
    if ($("#cfgMinScore")) $("#cfgMinScore").value = minScore;
    if ($("#cfgMinScoreRange")) $("#cfgMinScoreRange").value = minScore;
    if ($("#settingsScoreDisplay")) $("#settingsScoreDisplay").textContent = minScore;
    if ($("#cfgPoll")) $("#cfgPoll").value = poll;
    if ($("#cfgPollRange")) $("#cfgPollRange").value = poll;
    if ($("#settingsPollDisplay")) $("#settingsPollDisplay").textContent = `${poll}s`;
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
      toast("نمادها ذخیره شد — برای اعمال کامل ربات را ری‌استارت کنید");
      logControlActivity(`نمادها بروز شد: ${enabled.join(", ")}`, "ok");
      invalidateCache("status", "bootstrap");
      await fetchStatus({ force: true });
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

  function applyReportData(data, days = 30) {
    if (!data) return;
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
    feed.innerHTML = filtered.length
      ? filtered.map((e, i) => {
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
      invalidateCache("telegram:30", "telegram:7", "status", "bootstrap");
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
      invalidateCache("telegram:30", "telegram:7", "status", "bootstrap");
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
          x: { stacked: true, ticks: { color: "#5c6578", font: { size: 10 } }, grid: { display: false } },
          y: { stacked: true, beginAtZero: true, ticks: { color: "#5c6578", stepSize: 1 }, grid: { color: "rgba(255,255,255,0.04)" } },
        },
        plugins: { legend: { position: "bottom", labels: { color: "#8b95a8", font: CHART_FONT } } },
      },
    });
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
      applyReportData(payload.report_30, 30);
    }
    if (payload.telegram) {
      DataCache.set("telegram:30", payload.telegram);
      applyTelegramData({ summary: payload.telegram, entries: [] });
    }
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
        if (sys) updateSystem(sys);
        if (status) {
          renderEngineState(status.engine_state);
          renderMonitorProcesses(status.processes);
        }
        requestAnimationFrame(() => {
          refreshMonitorLiveCharts({ recreate: true });
          setTimeout(() => refreshMonitorLiveCharts(), 400);
        });
        break;
      }
      case "control": {
        const status = DataCache.get("status");
        if (status) {
          applyStatusData(status);
        }
        break;
      }
      case "signals": {
        const { days, delivery, direction, outcome } = getSignalsFilterParams();
        const cached = DataCache.get(signalsCacheKey(days, delivery, direction, outcome));
        if (cached) applySignalsPayload(cached);
        break;
      }
      case "reports": {
        const days = Number($("#reportDays")?.value || 30);
        const report = DataCache.get(reportCacheKey(days));
        if (report) applyReportData(report, days);
        break;
      }
      case "telegram": {
        const days = Number($("#telegramDays")?.value || 30);
        const status = $("#telegramStatus")?.value || "all";
        const cached = DataCache.get(telegramCacheKey(days, status));
        if (cached) applyTelegramData(cached);
        break;
      }
      case "settings": {
        const status = DataCache.get("status");
        if (status) applySettingsPage(status);
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
    const data = await DataCache.load("status", () => api("/api/status"), CACHE_TTL.status, { force });
    applyStatusData(data);
    return data;
  }

  async function fetchSystem({ force = false } = {}) {
    const data = await DataCache.load("system", () => api("/api/system"), CACHE_TTL.system, { force });
    updateSystem(data);
    return data;
  }

  async function fetchSignals({ force = false } = {}) {
    const { days, delivery, direction, outcome } = getSignalsFilterParams();
    const key = signalsCacheKey(days, delivery, direction, outcome);
    const data = await DataCache.load(
      key,
      () => api(`/api/signals?days=${days}&delivery=${delivery}&direction=${direction}&outcome=${outcome}&limit=100`),
      CACHE_TTL.signals,
      { force }
    );
    applySignalsPayload(data);
    return data;
  }

  async function fetchReport(days = 30, { force = false } = {}) {
    const key = reportCacheKey(days);
    const data = await DataCache.load(
      key,
      () => api(`/api/reports/summary?days=${days}`),
      CACHE_TTL.report,
      { force }
    );
    applyReportData(data, days);
    return data;
  }

  async function fetchTelegram({ force = false } = {}) {
    const days = Number($("#telegramDays")?.value || 30);
    const status = $("#telegramStatus")?.value || "all";
    const key = telegramCacheKey(days, status);
    const data = await DataCache.load(
      key,
      () => api(`/api/telegram/log?days=${days}&limit=200&status=${status}`),
      CACHE_TTL.telegram,
      { force }
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
    const data = await DataCache.load("bootstrap", () => api("/api/bootstrap"), CACHE_TTL.bootstrap, { force });
    applyBootstrap(data);
    return data;
  }

  async function ensurePageData(page, { force = false } = {}) {
    const needs = PAGE_NEEDS[page] || [];
    const tasks = [];

    if (needs.includes("status")) tasks.push(fetchStatus({ force }));
    if (needs.includes("system")) tasks.push(fetchSystem({ force }));
    if (needs.includes("signals")) tasks.push(fetchSignals({ force }));
    if (needs.includes("report:7")) tasks.push(fetchReport(7, { force }));
    if (page === "reports") {
      const days = Number($("#reportDays")?.value || 30);
      tasks.push(fetchReport(days, { force }));
    }
    if (page === "telegram") tasks.push(fetchTelegram({ force }));
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
    dashboardVersion = {
      label: info.label || `v${info.major}.${info.minor}`,
      full: info.full || `${info.major}.${info.minor}.${info.patch || 0}`,
      major: info.major,
      minor: info.minor,
      patch: info.patch || 0,
    };
    const label = dashboardVersion.label;
    const full = `v${dashboardVersion.full}`;
    if ($("#sidebarVersion")) $("#sidebarVersion").textContent = label;
    if ($("#sidebarVersionFull")) {
      $("#sidebarVersionFull").textContent = full;
      $("#sidebarVersionFull").title = `نسخه ${full}${info.released ? ` · ${info.released}` : ""}`;
    }
    if ($("#loginVersion")) $("#loginVersion").textContent = label;
    document.title = `TradeChi ${label} — Dashboard`;
  }

  async function loadVersion() {
    try {
      const res = await fetch("/api/version");
      if (res.ok) applyVersion(await res.json());
    } catch {}
  }

  // ── Dynamic expandable sidebar ──
  function getNavGroupState(id) {
    try {
      const raw = localStorage.getItem("tc:nav-groups");
      const map = raw ? JSON.parse(raw) : {};
      const group = NAV_GROUPS.find((g) => g.id === id);
      return map[id] ?? group?.defaultOpen ?? true;
    } catch {
      return true;
    }
  }

  function setNavGroupState(id, open) {
    try {
      const raw = localStorage.getItem("tc:nav-groups");
      const map = raw ? JSON.parse(raw) : {};
      map[id] = open;
      localStorage.setItem("tc:nav-groups", JSON.stringify(map));
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
    localStorage.setItem("tc:sidebar-collapsed", collapsed ? "1" : "0");
  }

  function initSidebarCollapse() {
    const btn = $("#sidebarCollapseBtn");
    if (!btn) return;

    setSidebarCollapsed(localStorage.getItem("tc:sidebar-collapsed") === "1");

    btn.addEventListener("click", () => {
      const collapsed = !$("#sidebar")?.classList.contains("collapsed");
      setSidebarCollapsed(collapsed);
    });
  }

  // ── Page Navigation ──
  function switchPage(page, { revalidate = true } = {}) {
    activePage = page;
    const meta = PAGE_META[page] || PAGE_META.home;
    if ($("#pageTitle")) $("#pageTitle").textContent = meta.title;
    if ($("#pageSub")) $("#pageSub").textContent = meta.sub;
    $$(".nav-item[data-page]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.page === page);
    });
    $$(".page").forEach((p) => p.classList.toggle("active", p.id === `page-${page}`));
    closeSidebar();

    applyPageFromCache(page);

    if (page === "signals") {
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

    if (page === "monitor") {
      const sys = DataCache.get("system");
      if (sys && !resourceHistory.labels.length) pushResourceHistory(sys);
      requestAnimationFrame(() => {
        refreshMonitorLiveCharts({ recreate: true });
        setTimeout(() => refreshMonitorLiveCharts(), 400);
      });
    }

    if (revalidate) ensurePageData(page).catch(() => {});
    syncLogPolling();
    syncMonitorPolling();
  }

  function syncMonitorPolling() {
    clearInterval(monitorInterval);
    monitorInterval = null;
    if (activePage === "monitor" && isAuthenticated) {
      fetchSystem({ force: true }).catch(() => {});
      monitorInterval = setInterval(() => fetchSystem().catch(() => {}), 5000);
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

  function healthFromPct(pct) {
    if (pct >= 75) return { cls: "good", label: "عالی" };
    if (pct >= 50) return { cls: "warn", label: "متوسط" };
    return { cls: "bad", label: "ضعیف" };
  }

  function computeHealthScore(sys, procs) {
    if (!sys) return 0;
    const cpuScore = Math.max(0, 100 - sys.cpu.total);
    const ramScore = Math.max(0, 100 - sys.ram.used_pct);
    const diskScore = Math.max(0, 100 - sys.disk.used_pct);
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
              pointRadius: resourceHistory.labels.length <= 2 ? 3 : 0,
              pointHoverRadius: 4,
              borderWidth: 2,
            },
            {
              label: "RAM",
              data: [...resourceHistory.ram],
              borderColor: "#63ffd0",
              backgroundColor: "rgba(99,255,208,0.06)",
              fill: true,
              tension: 0.35,
              pointRadius: resourceHistory.labels.length <= 2 ? 3 : 0,
              pointHoverRadius: 4,
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
              beginAtZero: true,
              max: 100,
              ticks: { color: "#5a6478", callback: (v) => `${v}%`, font: CHART_FONT },
              grid: { color: "rgba(255,255,255,0.04)" },
            },
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: "rgba(8,12,24,0.95)",
              titleFont: CHART_FONT,
              bodyFont: CHART_FONT,
              callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y}%` },
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
  }

  function updateMonitorHero(sys, procs) {
    if (!sys) return;
    const score = computeHealthScore(sys, procs || lastProcesses);
    const health = healthFromPct(score);
    setGaugeArc($("#monitorScoreArc"), score, 327);
    const arc = $("#monitorScoreArc");
    if (arc) arc.className = `score-fill ${health.cls}`;
    const scoreNum = $("#monitorScoreNum");
    if (scoreNum) scoreNum.textContent = score;
    if ($("#monHealthScore")) $("#monHealthScore").textContent = `${score}%`;
    if ($("#monHost")) $("#monHost").textContent = sys.hostname;
    if ($("#monUptime")) $("#monUptime").textContent = formatUptime(sys.uptime_secs);
    if ($("#monBotRam")) $("#monBotRam").textContent = `${sys.ram.bot_mb} MB`;
    if ($("#monitorHostTitle")) $("#monitorHostTitle").textContent = sys.hostname;
    if ($("#monitorHostSub")) $("#monitorHostSub").textContent = `CPU ${sys.cpu.total}% · RAM ${sys.ram.used_pct}% · Disk ${sys.disk.used_pct}%`;
    if ($("#monitorHealthLabel")) $("#monitorHealthLabel").textContent = health.label;
    const dot = $("#monitorHealthDot");
    if (dot) dot.className = `status-indicator ${health.cls === "good" ? "running" : health.cls === "warn" ? "partial" : "stopped"}`;
    const pill = $("#monitorHealthPill");
    if (pill) pill.className = `status-pill health-${health.cls}`;
  }

  function updateSystem(sys) {
    if (!sys) return;
    animateValue($("#cpuValue"), `${sys.cpu.total}%`);
    animateValue($("#ramValue"), `${sys.ram.used_pct}%`);
    animateValue($("#diskValue"), `${sys.disk.used_pct}%`);

    setGaugeArc($("#cpuGaugeArc"), sys.cpu.total);
    setGaugeArc($("#ramGaugeArc"), sys.ram.used_pct);
    setGaugeArc($("#diskGaugeArc"), sys.disk.used_pct);

    $("#cpuBot").textContent = `${sys.cpu.bot}%`;
    $("#ramTotal").textContent = sys.ram.total_gb;
    $("#ramBot").textContent = sys.ram.bot_mb;
    $("#diskFree").textContent = sys.disk.free_gb;

    const down = sys.network.down_kbps;
    const up = sys.network.up_kbps;
    $("#netValue").textContent = `${Math.max(down, up).toFixed(1)} KB/s`;
    $("#netDown").textContent = `${down} KB/s`;
    $("#netUp").textContent = `${up} KB/s`;
    $("#netDownBar").style.width = `${Math.min(down / 5, 100)}%`;
    $("#netUpBar").style.width = `${Math.min(up / 5, 100)}%`;

    $("#hostTag").textContent = sys.hostname;
    if ($("#heroUptime")) $("#heroUptime").textContent = formatUptime(sys.uptime_secs);

    pushResourceHistory(sys);
    updateMonitorHero(sys, lastProcesses);
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
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: "#8b95a8", font: CHART_FONT } } },
    };
  }

  function renderDirectionChart(buy, sell) {
    const canvas = $("#directionChart");
    if (!canvas) return;
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
          legend: { position: "bottom", labels: { color: "#8b95a8", font: CHART_FONT, padding: 16 } },
        },
      },
    });
  }

  function renderSymbolBarChart(bySymbol) {
    const canvas = $("#symbolBarChart");
    if (!canvas) return;
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
          x: { stacked: true, ticks: { color: "#5c6578", font: { size: 10 } }, grid: { display: false } },
          y: { stacked: true, beginAtZero: true, ticks: { color: "#5c6578", stepSize: 1 }, grid: { color: "rgba(255,255,255,0.04)" } },
        },
        plugins: { legend: { position: "bottom", labels: { color: "#8b95a8", font: CHART_FONT, boxWidth: 10 } } },
      },
    });
  }

  function renderSignalDirChart(byDirection) {
    const canvas = $("#signalDirChart");
    if (!canvas) return;
    const buy = byDirection.BUY || 0;
    const sell = byDirection.SELL || 0;
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
          legend: { position: "bottom", labels: { color: "#8b95a8", font: CHART_FONT, padding: 16 } },
        },
      },
    });
  }

  function renderSignals(signals) {
    const feed = $("#signalFeed");
    if (!feed || !signals) return;
    const q = ($("#signalSearch")?.value || "").trim().toUpperCase();
    const filtered = q
      ? signals.filter((s) => (s.symbol || "").toUpperCase().includes(q))
      : signals;

    if ($("#sigFeedCount")) {
      const total = signalsSummary?.total ?? signals.length;
      $("#sigFeedCount").textContent = filtered.length === total
        ? `${total} سیگنال`
        : `${filtered.length} از ${total} سیگنال`;
    }

    if (!filtered.length) {
      feed.innerHTML = '<p class="signals-empty">سیگنالی با این فیلتر یافت نشد</p>';
      return;
    }

    feed.innerHTML = filtered
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
      await fetchReport(days, { force });
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
          x: { ticks: { color: "#5c6578", font: { size: 10 } }, grid: { display: false } },
          y: { beginAtZero: true, ticks: { color: "#5c6578", font: { size: 10 }, stepSize: 1 }, grid: { color: "rgba(255,255,255,0.04)" } },
        },
        animation: { duration: 700 },
      },
    });
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
      const msg = data.message || "انجام شد";
      toast(msg);
      logControlActivity(msg, "ok");
      invalidateCache("status", "system", "bootstrap", "report:7", "report:30", "telegram:30");
      await fetchStatus({ force: true });
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
      mgmt(btn.dataset.mgmt, { confirmMsg: btn.dataset.confirm || null, btn });
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

  $("#telegramSearch")?.addEventListener("input", () => renderTelegramFeed(allTelegramEntries));
  $("#telegramStatus")?.addEventListener("change", () => refreshTelegram({ force: true }));
  $("#telegramDays")?.addEventListener("change", () => refreshTelegram({ force: true }));

  $("#signalSearch")?.addEventListener("input", () => renderSignals(allSignals));
  $("#signalDays")?.addEventListener("change", () => refreshSignals({ force: true }));
  $("#signalDelivery")?.addEventListener("change", () => refreshSignals({ force: true }));
  $("#signalDirection")?.addEventListener("change", () => refreshSignals({ force: true }));
  $("#signalOutcome")?.addEventListener("change", () => refreshSignals({ force: true }));

  $("#btnTelegramTest")?.addEventListener("click", (e) => sendTelegramTest(e.currentTarget));
  $("#homeBtnSymbols")?.addEventListener("click", openSymbolsModal);
  $("#homeBtnTelegramTest")?.addEventListener("click", (e) => sendTelegramTest(e.currentTarget));
  $("#homeBtnPauseNotif")?.addEventListener("click", () => mgmt("pause_notifications", { confirmMsg: "ارسال نوتیفیکیشن متوقف شود؟" }));
  $("#homeBtnResumeNotif")?.addEventListener("click", () => mgmt("resume_notifications"));

  $("#telegramFeed")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-retry-symbol]");
    if (btn) retryTelegramSend(btn);
  });

  async function refreshSystem({ force = false } = {}) {
    try {
      await fetchSystem({ force });
    } catch {}
  }

  $("#cfgMinScoreRange")?.addEventListener("input", (e) => {
    const v = e.target.value;
    if ($("#cfgMinScore")) $("#cfgMinScore").value = v;
    if ($("#settingsScoreDisplay")) $("#settingsScoreDisplay").textContent = v;
    if ($("#settingsMinScore")) $("#settingsMinScore").textContent = v;
  });

  $("#cfgPollRange")?.addEventListener("input", (e) => {
    const v = e.target.value;
    if ($("#cfgPoll")) $("#cfgPoll").value = v;
    if ($("#settingsPollDisplay")) $("#settingsPollDisplay").textContent = `${v}s`;
    if ($("#settingsPollVal")) $("#settingsPollVal").textContent = `${v}s`;
  });

  // ── Config Save ──
  $("#btnSaveConfig")?.addEventListener("click", async () => {
    try {
      const symbolsVal = $("#cfgSymbols")?.value || formatSymbolsString(getEnabledSymbols());
      await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({
          SYMBOLS: symbolsVal,
          MIN_SCORE: $("#cfgMinScore")?.value || $("#cfgMinScoreRange")?.value || "5",
          POLL_SECONDS: $("#cfgPoll")?.value || $("#cfgPollRange")?.value || "30",
          FACEBOOK_ENABLE: $("#cfgFacebook").checked ? "1" : "0",
          ENGINE_DEBUG: $("#cfgDebug").checked ? "1" : "0",
        }),
      });
      toast("تنظیمات ذخیره شد");
      invalidateCache("status", "bootstrap");
      fetchStatus({ force: true });
    } catch (err) {
      toast(err.message, "error");
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
    eventSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        updateStatusBanner(data.overall);
        renderProcesses(data.all_processes || data.processes);
        renderHomeProcesses(data.processes);
        renderMonitorProcesses(data.processes);
        updateSystem(data.system);
        if (data.server_time) $("#liveTime").textContent = data.server_time;

        if (data.signal_stats) {
          renderStats(data.signal_stats);
        }
        if (data.latest_signal !== undefined) {
          renderLatestSignal(data.latest_signal);
        }

        DataCache.set("system", data.system);
        const statusCached = DataCache.get("status");
        if (statusCached) {
          DataCache.set("status", {
            ...statusCached,
            overall: data.overall,
            processes: data.processes,
            signal_stats: data.signal_stats || statusCached.signal_stats,
            latest_signal: data.latest_signal !== undefined ? data.latest_signal : statusCached.latest_signal,
          });
        }
      } catch {}
    };
    eventSource.onerror = async () => {
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

    fetchBootstrap().catch(() => {
      fetchStatus({ force: true }).catch(() => {});
      fetchSystem({ force: true }).catch(() => {});
      fetchSignals({ force: true }).catch(() => {});
      fetchReport(7, { force: true }).catch(() => {});
      fetchReport(30, { force: true }).catch(() => {});
    });

    statusInterval = setInterval(() => fetchStatus().catch(() => {}), 15000);
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
    logInterval = null;
    monitorInterval = null;
  }

  // Background cache refresh hooks
  DataCache.onRevalidate("status", applyStatusData);
  DataCache.onRevalidate("system", updateSystem);
  DataCache.onRevalidate("telegram:30", applyTelegramData);

  // ── Init ──
  loadVersion();
  renderSidebarNav();
  initSidebarCollapse();
  renderControlActivity();
  checkAuth();
})();
