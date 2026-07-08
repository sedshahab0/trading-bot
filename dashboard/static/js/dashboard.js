/* Trading Bot Dashboard — Frontend */

(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  let symbolChart = null;
  let dailyChart = null;
  let eventSource = null;
  let logInterval = null;
  let statusInterval = null;
  let isAuthenticated = false;
  let sseReconnectTimer = null;
  let allSignals = [];
  let activeTab = "overview";
  let isMobile = () => window.innerWidth <= 768;

  // ── Particles ──
  function initParticles() {
    const container = $("#particles");
    if (!container) return;
    for (let i = 0; i < 30; i++) {
      const p = document.createElement("div");
      p.className = "particle";
      p.style.left = `${Math.random() * 100}%`;
      p.style.top = `${Math.random() * 100}%`;
      p.style.setProperty("--dur", `${6 + Math.random() * 10}s`);
      p.style.setProperty("--delay", `${Math.random() * 8}s`);
      container.appendChild(p);
    }
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
    ind.className = `status-indicator ${info.cls}`;
    $("#statusLabel").textContent = info.label;
    $("#statusSub").textContent = info.sub;
  }

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
  }

  function formatUptime(secs) {
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    return d ? `${d}d ${h}h` : `${h}h`;
  }

  function renderEngineState(state, latest) {
    const info = $("#engineInfo");
    if (!info) return;

    const bars = state?.last_bars || {};
    const signals = state?.last_signal_at || {};
    const symbols = [...new Set([...Object.keys(bars), ...Object.keys(signals)])];

    info.innerHTML = symbols.length
      ? symbols
          .map(
            (sym) => `
        <div class="engine-row">
          <span class="sym">${sym}</span>
          <span class="val">Bar: ${bars[sym] || "—"} · Signal: ${signals[sym] || "—"}</span>
        </div>`
          )
          .join("")
      : '<div class="engine-row"><span class="val">اطلاعاتی موجود نیست</span></div>';

    const ls = $("#latestSignal");
    if (latest && ls) {
      const dir = (latest.direction || "").toUpperCase();
      ls.innerHTML = `
        <div class="sig-header">
          <strong>${latest.symbol}</strong>
          <span class="sig-badge ${dir === "BUY" ? "buy" : "sell"}">${dir}</span>
        </div>
        <div class="sig-detail">
          Entry: ${latest.entry} · SL: ${latest.sl}<br/>
          TP1: ${latest.tp1} · TP2: ${latest.tp2} · RR: ${latest.rr}
        </div>`;
    } else if (ls) {
      ls.innerHTML = '<span style="color:var(--text-muted)">سیگنالی ثبت نشده</span>';
    }
  }

  function renderStats(stats) {
    if (!stats) return;
    animateValue($("#statToday"), stats.today);
    animateValue($("#statTotal"), stats.total);
    animateValue($("#statBuy"), stats.by_direction?.BUY || 0);
    animateValue($("#statSell"), stats.by_direction?.SELL || 0);
    updateChart(stats.by_symbol || {});
  }

  function updateChart(bySymbol) {
    const canvas = $("#symbolChart");
    if (!canvas) return;
    const labels = Object.keys(bySymbol);
    const values = Object.values(bySymbol);
    const colors = ["#63ffd0", "#5b9cf6", "#a78bfa", "#fbbf24", "#f87171"];

    if (symbolChart) {
      symbolChart.data.labels = labels;
      symbolChart.data.datasets[0].data = values;
      symbolChart.update("none");
      return;
    }

    symbolChart = new Chart(canvas, {
      type: "doughnut",
      data: {
        labels,
        datasets: [
          {
            data: values,
            backgroundColor: colors.slice(0, labels.length),
            borderWidth: 0,
            hoverOffset: 6,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "65%",
        plugins: {
          legend: {
            position: "bottom",
            labels: { color: "#7a8499", font: { size: 11, family: "JetBrains Mono" }, padding: 12 },
          },
        },
        animation: { animateRotate: true, duration: 800 },
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
      renderEngineState(data.engine_state, data.latest_signal);
      renderStats(data.signal_stats);
      $("#liveTime").textContent = data.server_time?.split(" ")[1] || "--:--:--";

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

  // ── Mobile Tabs ──
  function switchTab(tab) {
    activeTab = tab;
    $$(".mobile-nav-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === tab);
    });
    if (!isMobile()) return;
    $$(".tab-section").forEach((el) => {
      el.classList.toggle("active-tab", el.dataset.tab === tab);
    });
    if (tab === "reports") refreshReports();
  }

  $$(".mobile-nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  window.addEventListener("resize", () => {
    if (!isMobile()) {
      $$(".tab-section").forEach((el) => el.classList.remove("active-tab", "hidden-tab"));
    } else {
      switchTab(activeTab);
    }
  });

  // ── Management ──
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

  // ── Reports ──
  function renderDailyChart(daily) {
    const canvas = $("#dailyChart");
    if (!canvas || !daily) return;
    const labels = daily.map((d) => d.date.slice(5));
    const totals = daily.map((d) => d.total);
    const buys = daily.map((d) => d.buy);
    const sells = daily.map((d) => d.sell);

    if (dailyChart) {
      dailyChart.data.labels = labels;
      dailyChart.data.datasets[0].data = buys;
      dailyChart.data.datasets[1].data = sells;
      dailyChart.update("none");
      return;
    }

    dailyChart = new Chart(canvas, {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "BUY", data: buys, backgroundColor: "rgba(74,222,128,0.7)", borderRadius: 4 },
          { label: "SELL", data: sells, backgroundColor: "rgba(248,113,113,0.7)", borderRadius: 4 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: "#8b95a8", font: { family: "Vazirmatn", size: 11 } } },
        },
        scales: {
          x: { stacked: true, ticks: { color: "#5c6578", font: { size: 10 } }, grid: { display: false } },
          y: { stacked: true, ticks: { color: "#5c6578", font: { size: 10 } }, grid: { color: "rgba(255,255,255,0.04)" } },
        },
        animation: { duration: 600 },
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
        $("#reportGenerated").textContent = `آخرین بروزرسانی: ${data.generated_at} · ${data.total} سیگنال`;
      }
      renderDailyChart(data.daily);
    } catch {}
  }

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
    switchTab(activeTab);
    refreshStatus();
    refreshSignals();
    refreshSystem();
    refreshLogs();
    refreshReports();

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
  initParticles();
  checkAuth();
})();
