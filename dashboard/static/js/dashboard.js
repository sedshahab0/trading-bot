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
  let homeSparkline = null;
  let resourceHistoryChart = null;
  let cpuSparkChart = null;
  let ramSparkChart = null;
  let diskSparkChart = null;
  let netSparkChart = null;
  let eventSource = null;
  let logInterval = null;
  let statusInterval = null;
  let isAuthenticated = false;
  let sseReconnectTimer = null;
  let allSignals = [];
  let allTelegramEntries = [];
  let activePage = "home";
  let lastEngineState = null;
  let lastProcesses = [];
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
    control: { title: "کنترل ربات", sub: "مدیریت PM2 و عملیات" },
    signals: { title: "سیگنال‌ها", sub: "تاریخچه سیگنال‌های ارسالی" },
    reports: { title: "گزارش‌ها", sub: "تحلیل عملکرد، تلگرام و خروجی Excel" },
    telegram: { title: "تلگرام", sub: "لاگ کامل ارسال سیگنال‌ها به تلگرام" },
    settings: { title: "تنظیمات", sub: "پیکربندی ربات" },
    logs: { title: "لاگ‌ها", sub: "مشاهده زنده لاگ‌ها" },
  };

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

  const PERSIST_KEYS = new Set(["status", "system", "signals", "report:7", "report:30", "telegram:30"]);

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
    try {
      const data = await api("/api/control", {
        method: "POST",
        body: JSON.stringify({ action, process }),
      });
      const labels = { start: "راه‌اندازی", stop: "توقف", restart: "ری‌استارت" };
      toast(`${labels[action]} انجام شد`);
      invalidateCache("status", "system", "bootstrap");
      fetchStatus({ force: true });
      fetchSystem({ force: true });
      return data;
    } catch (err) {
      toast(err.message, "error");
    }
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
    renderProcesses(data.processes);
    renderHomeProcesses(data.processes);
    renderMonitorProcesses(data.processes);
    renderEngineState(data.engine_state);
    renderLatestSignal(data.latest_signal);
    renderStats(data.signal_stats);
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
  }

  function applySignalsList(signals) {
    if (!signals) return;
    allSignals = signals;
    renderSignals(signals);
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
          </div>
        </article>`;
        }).join("")
      : '<p class="telegram-empty">موردی یافت نشد</p>';
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
    if (payload.status) {
      DataCache.set("status", payload.status);
      applyStatusData(payload.status);
    }
    if (payload.system) {
      DataCache.set("system", payload.system);
      updateSystem(payload.system);
    }
    if (payload.signals) {
      DataCache.set("signals", payload.signals);
      applySignalsList(payload.signals);
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
          updateSparkCharts();
          renderResourceHistoryChart();
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
        const signals = DataCache.get("signals");
        if (signals) applySignalsList(signals);
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
        const cached = DataCache.get(telegramCacheKey(days));
        if (cached) applyTelegramData(cached);
        break;
      }
      case "settings": {
        const status = DataCache.get("status");
        if (status) applyStatusData(status);
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
    const data = await DataCache.load(
      "signals",
      async () => (await api("/api/signals?limit=50")).signals,
      CACHE_TTL.signals,
      { force }
    );
    applySignalsList(data);
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
    const key = telegramCacheKey(days);
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

    if (revalidate) ensurePageData(page).catch(() => {});
    syncLogPolling();
  }

  function openSidebar() {
    $("#sidebar")?.classList.add("open");
    $("#sidebarOverlay")?.classList.add("open");
  }

  function closeSidebar() {
    $("#sidebar")?.classList.remove("open");
    $("#sidebarOverlay")?.classList.remove("open");
  }

  $$(".nav-item[data-page]").forEach((btn) => {
    btn.addEventListener("click", () => switchPage(btn.dataset.page));
    btn.addEventListener("mouseenter", () => prefetchPage(btn.dataset.page));
    btn.addEventListener("focus", () => prefetchPage(btn.dataset.page));
  });

  $("#menuToggle")?.addEventListener("click", openSidebar);
  $("#sidebarOverlay")?.addEventListener("click", closeSidebar);

  $$("[data-goto]").forEach((btn) => {
    btn.addEventListener("click", () => switchPage(btn.dataset.goto));
    btn.addEventListener("mouseenter", () => prefetchPage(btn.dataset.goto));
  });

  function renderProcesses(procs) {
    const container = $("#processCards");
    if (!container) return;
    container.innerHTML = procs
      .map(
        (p) => `
      <div class="process-card">
        <div class="process-dot ${p.status}"></div>
        <div class="process-info">
          <div class="process-name">${p.name}</div>
          <div class="process-meta">
            ${p.status === "online" ? `PID ${p.pid} · ${p.memory_mb} MB · CPU ${p.cpu}%` : "متوقف"}
            ${p.restarts ? ` · ${p.restarts} restart` : ""}
          </div>
        </div>
        <div class="process-actions">
          <button class="btn-icon" title="Start" onclick="window._ctrl('start','${p.name}')">▶</button>
          <button class="btn-icon" title="Stop" onclick="window._ctrl('stop','${p.name}')">■</button>
          <button class="btn-icon" title="Restart" onclick="window._ctrl('restart','${p.name}')">↻</button>
        </div>
      </div>`
      )
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
    if (!sys) return;
    const label = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    resourceHistory.labels.push(label);
    resourceHistory.cpu.push(sys.cpu.total);
    resourceHistory.ram.push(sys.ram.used_pct);
    resourceHistory.net.push(Math.max(sys.network.down_kbps, sys.network.up_kbps));
    resourceHistory.disk.push(sys.disk.used_pct);
    if (resourceHistory.labels.length > resourceHistory.max) {
      resourceHistory.labels.shift();
      resourceHistory.cpu.shift();
      resourceHistory.ram.shift();
      resourceHistory.net.shift();
      resourceHistory.disk.shift();
    }
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
    if (!canvas) return;
    if (resourceHistoryChart) {
      resourceHistoryChart.data.labels = resourceHistory.labels;
      resourceHistoryChart.data.datasets[0].data = resourceHistory.cpu;
      resourceHistoryChart.data.datasets[1].data = resourceHistory.ram;
      resourceHistoryChart.update("none");
      return;
    }
    resourceHistoryChart = new Chart(canvas, {
      type: "line",
      data: {
        labels: resourceHistory.labels,
        datasets: [
          {
            label: "CPU",
            data: resourceHistory.cpu,
            borderColor: "#5b9cf6",
            backgroundColor: "rgba(91,156,246,0.08)",
            fill: true,
            tension: 0.35,
            pointRadius: 0,
            pointHoverRadius: 4,
            borderWidth: 2,
          },
          {
            label: "RAM",
            data: resourceHistory.ram,
            borderColor: "#63ffd0",
            backgroundColor: "rgba(99,255,208,0.06)",
            fill: true,
            tension: 0.35,
            pointRadius: 0,
            pointHoverRadius: 4,
            borderWidth: 2,
          },
        ],
      },
      options: {
        ...chartDefaults(),
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
      updateSparkCharts();
      renderResourceHistoryChart();
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

  function renderStats(stats) {
    if (!stats) return;
    const set = (id, v) => { const el = $(id); if (el) animateValue(el, v); };
    set("#statToday", stats.today);
    set("#statTotal", stats.total);
    set("#statBuy", stats.by_direction?.BUY || 0);
    set("#statSell", stats.by_direction?.SELL || 0);
    set("#kpiToday", stats.today);
    set("#kpiTotal", stats.total);
    set("#kpiBuy", stats.by_direction?.BUY || 0);
    set("#kpiSell", stats.by_direction?.SELL || 0);
    set("#sigToday", stats.today);
    set("#sigTotal", stats.total);
    updateChart(stats.by_symbol || {});
    renderSymbolLegend(stats.by_symbol || {});
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

  function renderSignals(signals) {
    const feed = $("#signalFeed");
    if (!feed || !signals) return;
    const q = ($("#signalSearch")?.value || "").trim().toUpperCase();
    const filtered = q
      ? signals.filter((s) => (s.symbol || "").toUpperCase().includes(q))
      : signals;
    feed.innerHTML = filtered.length
      ? filtered
          .map(
            (s, i) => {
              const dir = (s.direction || "").toUpperCase();
              return `
        <div class="signal-item" style="animation-delay:${i * 0.05}s">
          <span class="time">${s.timestamp || ""}</span>
          <div>
            <span class="sym">${s.symbol}</span>
            <span class="sig-badge ${dir === "BUY" ? "buy" : "sell"}" style="margin-right:0.5rem">${dir}</span>
          </div>
          <span class="entry-info">E:${s.entry} SL:${s.sl}</span>
        </div>`;
            }
          )
          .join("")
      : '<p style="color:var(--text-muted);text-align:center;padding:1rem">سیگنالی یافت نشد</p>';
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

  async function mgmt(action) {
    try {
      const data = await api("/api/management", {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      toast(data.message || "انجام شد");
      invalidateCache("status", "system", "bootstrap", "report:7", "report:30", "telegram:30");
      fetchStatus({ force: true });
      fetchSystem({ force: true });
      if (action === "toggle_debug") refreshReports({ force: true });
    } catch (err) {
      toast(err.message, "error");
    }
  }

  $("#btnRestartAll")?.addEventListener("click", () => mgmt("restart_all"));
  $("#btnPauseNotif")?.addEventListener("click", () => mgmt("pause_notifications"));
  $("#btnResumeNotif")?.addEventListener("click", () => mgmt("resume_notifications"));
  $("#btnResetCooldown")?.addEventListener("click", () => mgmt("reset_cooldowns"));
  $("#btnFlushLogs")?.addEventListener("click", () => {
    if (confirm("لاگ‌های PM2 پاک شوند؟")) mgmt("flush_logs");
  });
  $("#btnToggleDebug")?.addEventListener("click", () => mgmt("toggle_debug"));

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

  async function refreshSystem({ force = false } = {}) {
    try {
      await fetchSystem({ force });
    } catch {}
  }

  // ── Config Save ──
  $("#btnSaveConfig")?.addEventListener("click", async () => {
    try {
      await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({
          SYMBOLS: $("#cfgSymbols").value,
          MIN_SCORE: $("#cfgMinScore").value,
          POLL_SECONDS: $("#cfgPoll").value,
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
        renderProcesses(data.processes);
        renderHomeProcesses(data.processes);
        renderMonitorProcesses(data.processes);
        updateSystem(data.system);
        if (data.server_time) $("#liveTime").textContent = data.server_time;

        DataCache.set("system", data.system);
        const statusCached = DataCache.get("status");
        if (statusCached) {
          DataCache.set("status", {
            ...statusCached,
            overall: data.overall,
            processes: data.processes,
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
    logInterval = null;
  }

  // Background cache refresh hooks
  DataCache.onRevalidate("status", applyStatusData);
  DataCache.onRevalidate("system", updateSystem);
  DataCache.onRevalidate("signals", applySignalsList);
  DataCache.onRevalidate("telegram:30", applyTelegramData);

  // ── Init ──
  checkAuth();
})();
