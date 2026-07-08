/* Trading Bot Dashboard — Frontend */

(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  let symbolChart = null;
  let dailyChart = null;
  let directionChart = null;
  let symbolBarChart = null;
  let homeSparkline = null;
  let eventSource = null;
  let logInterval = null;
  let statusInterval = null;
  let isAuthenticated = false;
  let sseReconnectTimer = null;
  let allSignals = [];
  let activePage = "home";

  const PAGE_META = {
    home: { title: "داشبورد", sub: "نمای کلی ربات" },
    monitor: { title: "مانیتورینگ", sub: "منابع سرور و موتور" },
    control: { title: "کنترل ربات", sub: "مدیریت PM2 و عملیات" },
    signals: { title: "سیگنال‌ها", sub: "تاریخچه سیگنال‌های ارسالی" },
    reports: { title: "گزارش‌ها", sub: "تحلیل عملکرد و خروجی Excel" },
    settings: { title: "تنظیمات", sub: "پیکربندی ربات" },
    logs: { title: "لاگ‌ها", sub: "مشاهده زنده لاگ‌ها" },
  };

  const CHART_FONT = { family: "Vazirmatn", size: 11 };
  const CHART_COLORS = ["#63ffd0", "#5b9cf6", "#a78bfa", "#fbbf24", "#f87171"];

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
      refreshStatus();
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

  async function refreshHomeExtras() {
    try {
      const data = await api("/api/reports/summary?days=7");
      renderHomeSparkline(data.daily);
    } catch {}
  }

  // ── Page Navigation ──
  function switchPage(page) {
    activePage = page;
    const meta = PAGE_META[page] || PAGE_META.home;
    if ($("#pageTitle")) $("#pageTitle").textContent = meta.title;
    if ($("#pageSub")) $("#pageSub").textContent = meta.sub;
    $$(".nav-item[data-page]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.page === page);
    });
    $$(".page").forEach((p) => p.classList.toggle("active", p.id === `page-${page}`));
    closeSidebar();
    if (page === "reports") setTimeout(refreshReports, 100);
    if (page === "logs") refreshLogs();
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
  });

  $("#menuToggle")?.addEventListener("click", openSidebar);
  $("#sidebarOverlay")?.addEventListener("click", closeSidebar);

  $$("[data-goto]").forEach((btn) => {
    btn.addEventListener("click", () => switchPage(btn.dataset.goto));
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

  function updateSystem(sys) {
    if (!sys) return;
    animateValue($("#cpuValue"), `${sys.cpu.total}%`);
    $("#cpuBar").style.width = `${sys.cpu.total}%`;
    $("#cpuBot").textContent = `${sys.cpu.bot}%`;

    animateValue($("#ramValue"), `${sys.ram.used_pct}%`);
    $("#ramBar").style.width = `${sys.ram.used_pct}%`;
    $("#ramTotal").textContent = sys.ram.total_gb;
    $("#ramBot").textContent = sys.ram.bot_mb;

    animateValue($("#diskValue"), `${sys.disk.used_pct}%`);
    $("#diskBar").style.width = `${sys.disk.used_pct}%`;
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
  }

  function formatUptime(secs) {
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    return d ? `${d}d ${h}h` : `${h}h`;
  }

  function renderEngineState(state) {
    const info = $("#engineInfo");
    if (!info) return;
    const bars = state?.last_bars || {};
    const signals = state?.last_signal_at || {};
    const symbols = [...new Set([...Object.keys(bars), ...Object.keys(signals)])];
    info.innerHTML = symbols.length
      ? symbols.map((sym) => `
        <div class="engine-row">
          <span class="sym">${sym}</span>
          <span class="val">Bar: ${bars[sym] || "—"} · Signal: ${signals[sym] || "—"}</span>
        </div>`).join("")
      : '<div class="engine-row"><span class="val">اطلاعاتی موجود نیست</span></div>';
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

  async function refreshLogs() {
    const process = $("#logSelect")?.value || "signal-engine";
    try {
      const { lines } = await api(`/api/logs?process=${process}&lines=60`);
      const body = $("#terminalBody");
      if (body) {
        body.innerHTML = lines.map(colorizeLog).join("\n");
        body.scrollTop = body.scrollHeight;
      }
    } catch {}
  }

  async function refreshStatus() {
    try {
      const data = await api("/api/status");
      updateStatusBanner(data.overall);
      renderProcesses(data.processes);
      renderHomeProcesses(data.processes);
      renderEngineState(data.engine_state);
      renderLatestSignal(data.latest_signal);
      renderStats(data.signal_stats);
      const time = data.server_time || "";
      $("#liveTime").textContent = time.split(" ")[1] || "--:--:--";
      if ($("#heroUpdated")) $("#heroUpdated").textContent = time ? `بروزرسانی ${time}` : "";

      const cfg = data.config || {};
      $("#cfgSymbols").value = cfg.symbols || "";
      $("#cfgMinScore").value = cfg.min_score || "5";
      $("#cfgPoll").value = cfg.poll_seconds || "30";
      $("#cfgFacebook").checked = cfg.facebook_enable;
      $("#cfgDebug").checked = cfg.engine_debug;
      if ($("#debugStatus")) {
        $("#debugStatus").textContent = cfg.engine_debug ? "روشن" : "خاموش";
      }
    } catch {}
  }

  async function refreshSignals() {
    try {
      const { signals } = await api("/api/signals?limit=50");
      allSignals = signals;
      renderSignals(signals);
    } catch {}
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

  async function refreshReports() {
    const days = $("#reportDays")?.value || 30;
    try {
      const data = await api(`/api/reports/summary?days=${days}`);
      if ($("#rptAvg")) $("#rptAvg").textContent = data.avg_per_day;
      if ($("#rptTop")) $("#rptTop").textContent = data.top_symbol;
      if ($("#rptRatio")) $("#rptRatio").textContent = data.buy_sell_ratio;
      if ($("#rptRestarts")) $("#rptRestarts").textContent = data.total_restarts;
      if ($("#reportGenerated")) {
        $("#reportGenerated").textContent = `بروزرسانی: ${data.generated_at} · ${data.total} سیگنال در ${days} روز`;
      }
      renderDailyChart(data.daily);
      renderDirectionChart(data.by_direction?.BUY || 0, data.by_direction?.SELL || 0);
      renderSymbolBarChart(data.by_symbol || {});
    } catch {}
  }
  async function mgmt(action) {
    try {
      const data = await api("/api/management", {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      toast(data.message || "انجام شد");
      refreshStatus();
      if (action === "toggle_debug") refreshReports();
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

  $("#reportDays")?.addEventListener("change", refreshReports);

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

  $("#signalSearch")?.addEventListener("input", () => renderSignals(allSignals));

  async function refreshSystem() {
    try {
      const sys = await api("/api/system");
      updateSystem(sys);
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
    } catch (err) {
      toast(err.message, "error");
    }
  });

  $("#logSelect")?.addEventListener("change", refreshLogs);

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
        updateSystem(data.system);
        if (data.server_time) $("#liveTime").textContent = data.server_time;
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
    switchPage(activePage);
    refreshStatus();
    refreshSignals();
    refreshSystem();
    refreshLogs();
    refreshReports();
    refreshHomeExtras();
    statusInterval = setInterval(refreshStatus, 10000);
    logInterval = setInterval(refreshLogs, 5000);
    connectSSE();
  }

  function stopStreams() {
    eventSource?.close();
    eventSource = null;
    clearTimeout(sseReconnectTimer);
    clearInterval(statusInterval);
    clearInterval(logInterval);
  }

  // ── Init ──
  checkAuth();
})();
