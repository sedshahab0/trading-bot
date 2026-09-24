/* TradeChi — Motion layer
   GSAP micro-interactions, Three.js scenes, command palette and Chart.js theming.
   dashboard.js owns data + state; this file only listens to its events
   (tc:login, tc:dashboard, tc:page) and decorates the DOM. */

(() => {
  "use strict";

  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const finePointer = window.matchMedia?.("(pointer: fine)").matches;
  const hasGsap = () => typeof window.gsap !== "undefined" && !reduceMotion;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  if (hasGsap()) {
    document.documentElement.classList.add("motion-ready");
    // UI tweens should finish on wall-clock time even if frames are throttled
    gsap.ticker.lagSmoothing(0);
  }

  /* ───────────────────────── Chart.js theme ───────────────────────── */
  function toRgba(color, alpha) {
    if (typeof color !== "string") return color;
    if (color.startsWith("#")) {
      const hex = color.length === 4 ? color.replace(/#(.)(.)(.)/, "#$1$1$2$2$3$3") : color;
      const n = parseInt(hex.slice(1, 7), 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
    }
    const m = color.match(/rgba?\(([^)]+)\)/);
    if (m) {
      const [r, g, b] = m[1].split(",").map((x) => x.trim());
      return `rgba(${r},${g},${b},${alpha})`;
    }
    return color;
  }

  if (window.Chart) {
    const C = window.Chart;
    C.defaults.font.family = "Vazirmatn, system-ui, sans-serif";
    C.defaults.color = "#8b93a5";
    C.defaults.borderColor = "rgba(255,255,255,0.055)";
    Object.assign(C.defaults.plugins.tooltip, {
      backgroundColor: "rgba(14,16,22,0.96)",
      borderColor: "rgba(255,255,255,0.1)",
      borderWidth: 1,
      padding: 11,
      cornerRadius: 11,
      titleColor: "#eef1f7",
      bodyColor: "#c3cad8",
      titleFont: { weight: "700", size: 12 },
      bodyFont: { size: 11 },
      boxPadding: 5,
      usePointStyle: true,
      caretSize: 5,
    });
    C.defaults.plugins.legend.labels.usePointStyle = true;
    C.defaults.plugins.legend.labels.pointStyle = "circle";
    C.defaults.plugins.legend.labels.boxWidth = 7;
    C.defaults.plugins.legend.labels.boxHeight = 7;
    C.defaults.elements.line.tension = 0.4;
    C.defaults.elements.line.borderWidth = 2;
    C.defaults.elements.point.radius = 0;
    C.defaults.elements.point.hoverRadius = 5;
    C.defaults.elements.point.hoverBorderWidth = 2;
    C.defaults.elements.bar.borderRadius = 6;
    C.defaults.elements.arc.borderWidth = 0;
    C.defaults.elements.arc.hoverOffset = 6;

    // Vertical gradient fills for filled line series — derived from each series' own colour.
    C.register({
      id: "tcGradient",
      beforeDatasetsDraw(chart) {
        const { ctx, chartArea } = chart;
        if (!chartArea) return;
        chart.data.datasets.forEach((ds, i) => {
          const meta = chart.getDatasetMeta(i);
          if (meta.type !== "line" || !ds.fill || meta.hidden) return;
          const base = typeof ds.borderColor === "string" ? ds.borderColor : null;
          if (!base) return;
          const key = `${chartArea.top}:${chartArea.bottom}:${base}`;
          if (ds._tcGradKey === key && typeof ds.backgroundColor !== "string") return;
          const g = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
          g.addColorStop(0, toRgba(base, 0.3));
          g.addColorStop(0.65, toRgba(base, 0.06));
          g.addColorStop(1, toRgba(base, 0));
          ds.backgroundColor = g;
          ds._tcGradKey = key;
          if (meta.dataset?.options) meta.dataset.options.backgroundColor = g;
        });
      },
    });

    // Soft glow under line strokes.
    C.register({
      id: "tcGlow",
      beforeDatasetDraw(chart, args) {
        if (args.meta.type !== "line") return;
        const ds = chart.data.datasets[args.index];
        const c = typeof ds.borderColor === "string" ? ds.borderColor : null;
        if (!c) return;
        chart.ctx.save();
        chart.ctx.shadowColor = toRgba(c, 0.55);
        chart.ctx.shadowBlur = 10;
        chart.ctx.shadowOffsetY = 4;
      },
      afterDatasetDraw(chart, args) {
        if (args.meta.type !== "line") return;
        chart.ctx.restore();
      },
    });
  }

  /* ───────────────────────── Count-up numbers ───────────────────────── */
  const NUM_RE = /^([^\d\-]*?)(-?\d[\d,]*(?:\.\d+)?)(.*)$/s;
  const countTweens = new WeakMap();

  function countTo(el, text) {
    const target = String(text);
    const m = target.match(NUM_RE);
    const prev = (el.textContent || "").match(NUM_RE);
    if (!hasGsap() || !m || document.hidden) {
      el.textContent = target;
      return;
    }
    const to = parseFloat(m[2].replace(/,/g, ""));
    let from = prev && prev[1] === m[1] && prev[3] === m[3] ? parseFloat(prev[2].replace(/,/g, "")) : 0;
    if (!Number.isFinite(to) || !Number.isFinite(from) || from === to) {
      el.textContent = target;
      return;
    }
    const decimals = (m[2].split(".")[1] || "").length;
    const grouped = m[2].includes(",");
    countTweens.get(el)?.kill();
    const state = { v: from };
    const tween = gsap.to(state, {
      v: to,
      duration: Math.min(1.4, 0.5 + Math.log10(Math.abs(to - from) + 1) * 0.25),
      ease: "power3.out",
      onUpdate() {
        let s = state.v.toFixed(decimals);
        if (grouped) s = Number(s).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
        el.textContent = `${m[1]}${s}${m[3]}`;
      },
      onComplete() {
        el.textContent = target;
      },
    });
    countTweens.set(el, tween);
    const host = el.closest(".kpi-card, .stat-cell, .hero-stat, .gauge-card");
    if (host && from !== 0) {
      host.classList.remove("value-tick");
      void host.offsetWidth;
      host.classList.add("value-tick");
    }
  }

  window.TCMotion = { countTo };

  /* ───────────────────────── Three.js: login market scene ───────────────────────── */
  const Login = {
    running: false,
    ready: false,
    raf: 0,
    init() {
      if (this.ready) return true;
      const canvas = $("#loginThreeCanvas");
      if (!canvas || !window.THREE) return false;
      const T = window.THREE;
      let renderer;
      try {
        renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
      } catch {
        return false;
      }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
      renderer.setClearColor(0x000000, 0);

      const scene = new T.Scene();
      scene.fog = new T.FogExp2(0x06070a, 0.0115);
      const camera = new T.PerspectiveCamera(48, 1, 0.1, 400);
      camera.position.set(0, 16, 74);
      const lookAt = new T.Vector3(0, 4, 0);

      const world = new T.Group();
      scene.add(world);

      /* dotted terrain */
      const COLS = 120, ROWS = 56, W = 260, D = 150;
      const tGeo = new T.PlaneGeometry(W, D, COLS - 1, ROWS - 1);
      tGeo.rotateX(-Math.PI / 2);
      const tPos = tGeo.attributes.position;
      const base = new Float32Array(tPos.array);
      const tCol = new Float32Array(tPos.count * 3);
      const cGold = new T.Color("#f4b740"), cIris = new T.Color("#6c8cff"), cTmp = new T.Color();
      for (let i = 0; i < tPos.count; i++) {
        const u = (base[i * 3] + W / 2) / W;
        cTmp.copy(cIris).lerp(cGold, clamp(u * 1.2 - 0.1, 0, 1));
        tCol[i * 3] = cTmp.r; tCol[i * 3 + 1] = cTmp.g; tCol[i * 3 + 2] = cTmp.b;
      }
      tGeo.setAttribute("color", new T.BufferAttribute(tCol, 3));
      const dot = document.createElement("canvas");
      dot.width = dot.height = 32;
      const dctx = dot.getContext("2d");
      const grd = dctx.createRadialGradient(16, 16, 0, 16, 16, 16);
      grd.addColorStop(0, "rgba(255,255,255,1)");
      grd.addColorStop(0.35, "rgba(255,255,255,0.6)");
      grd.addColorStop(1, "rgba(255,255,255,0)");
      dctx.fillStyle = grd;
      dctx.fillRect(0, 0, 32, 32);
      const dotTex = new T.CanvasTexture(dot);
      const terrain = new T.Points(tGeo, new T.PointsMaterial({
        size: 0.9, map: dotTex, vertexColors: true, transparent: true, opacity: 0.55,
        depthWrite: false, blending: T.AdditiveBlending,
      }));
      terrain.position.set(0, -14, -30);
      world.add(terrain);

      /* candles */
      const N = 34, SPACING = 2.4;
      const bodyGeo = new T.BoxGeometry(1.35, 1, 1.35);
      const wickGeo = new T.BoxGeometry(0.16, 1, 0.16);
      const bodyMat = new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.92 });
      const wickMat = new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 });
      const bodies = new T.InstancedMesh(bodyGeo, bodyMat, N);
      const wicks = new T.InstancedMesh(wickGeo, wickMat, N);
      const glowMat = new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, blending: T.AdditiveBlending, depthWrite: false });
      const glows = new T.InstancedMesh(new T.BoxGeometry(2.6, 1, 2.6), glowMat, N);
      const chart = new T.Group();
      chart.add(glows, wicks, bodies);
      world.add(chart);

      const cBuy = new T.Color("#2ee6a6"), cSell = new T.Color("#ff5c7a");
      const candles = [];
      let last = 0;
      const nextCandle = () => {
        const open = last;
        const trend = Math.sin(performance.now() / 7000) * 5;
        const close = clamp(open + (Math.random() - 0.5) * 5 + (trend - open) * 0.12, -12, 12);
        const hi = Math.max(open, close) + Math.random() * 2.2;
        const lo = Math.min(open, close) - Math.random() * 2.2;
        last = close;
        return { open, close, hi, lo, born: performance.now() };
      };
      for (let i = 0; i < N; i++) candles.push(nextCandle());

      /* price line through closes */
      const linePts = new Float32Array(N * 3);
      const lineGeo = new T.BufferGeometry();
      lineGeo.setAttribute("position", new T.BufferAttribute(linePts, 3));
      const line = new T.Line(lineGeo, new T.LineBasicMaterial({ color: 0xffd98a, transparent: true, opacity: 0.85 }));
      chart.add(line);

      const headSpriteMat = new T.SpriteMaterial({ map: dotTex, color: 0xffd98a, transparent: true, blending: T.AdditiveBlending, depthWrite: false });
      const head = new T.Sprite(headSpriteMat);
      head.scale.set(6, 6, 1);
      chart.add(head);
      const headCore = new T.Sprite(new T.SpriteMaterial({ map: dotTex, color: 0xffffff, transparent: true, depthWrite: false }));
      headCore.scale.set(1.6, 1.6, 1);
      chart.add(headCore);

      /* dust */
      const DUST = 420;
      const dGeo = new T.BufferGeometry();
      const dPos = new Float32Array(DUST * 3);
      for (let i = 0; i < DUST; i++) {
        dPos[i * 3] = (Math.random() - 0.5) * 220;
        dPos[i * 3 + 1] = Math.random() * 70 - 12;
        dPos[i * 3 + 2] = (Math.random() - 0.5) * 140 - 20;
      }
      dGeo.setAttribute("position", new T.BufferAttribute(dPos, 3));
      const dust = new T.Points(dGeo, new T.PointsMaterial({ size: 0.55, map: dotTex, color: 0xffe2a8, transparent: true, opacity: 0.35, depthWrite: false, blending: T.AdditiveBlending }));
      world.add(dust);

      const m4 = new T.Matrix4(), q = new T.Quaternion(), s3 = new T.Vector3(), p3 = new T.Vector3();
      let offset = 0;

      const layoutCandles = (now) => {
        const x0 = -((N - 1) * SPACING) / 2;
        for (let i = 0; i < N; i++) {
          const c = candles[i];
          const x = x0 + i * SPACING - offset;
          const grow = clamp((now - c.born) / 600, 0, 1);
          const e = 1 - Math.pow(1 - grow, 3);
          const h = Math.max(0.25, Math.abs(c.close - c.open)) * e;
          const mid = (c.open + c.close) / 2;
          const up = c.close >= c.open;
          p3.set(x, mid, 0); s3.set(1, h, 1);
          m4.compose(p3, q, s3); bodies.setMatrixAt(i, m4);
          s3.set(1, h + 0.6, 1); m4.compose(p3, q, s3); glows.setMatrixAt(i, m4);
          p3.set(x, (c.hi + c.lo) / 2, 0); s3.set(1, (c.hi - c.lo) * e, 1);
          m4.compose(p3, q, s3); wicks.setMatrixAt(i, m4);
          const col = up ? cBuy : cSell;
          bodies.setColorAt(i, col); wicks.setColorAt(i, col); glows.setColorAt(i, col);
          linePts[i * 3] = x; linePts[i * 3 + 1] = c.close; linePts[i * 3 + 2] = 0.9;
        }
        bodies.instanceMatrix.needsUpdate = wicks.instanceMatrix.needsUpdate = glows.instanceMatrix.needsUpdate = true;
        if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
        if (wicks.instanceColor) wicks.instanceColor.needsUpdate = true;
        if (glows.instanceColor) glows.instanceColor.needsUpdate = true;
        lineGeo.attributes.position.needsUpdate = true;
        const lastC = candles[N - 1];
        head.position.set(x0 + (N - 1) * SPACING - offset, lastC.close, 1);
        headCore.position.copy(head.position);
      };

      /* layout: centre the chart inside the showcase column */
      const resize = () => {
        const w = canvas.clientWidth || window.innerWidth;
        const h = canvas.clientHeight || window.innerHeight;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        const panel = $(".login-panel");
        const panelW = window.innerWidth > 1024 && panel ? panel.getBoundingClientRect().width : 0;
        const dist = camera.position.distanceTo(lookAt);
        const visibleW = 2 * Math.tan((camera.fov * Math.PI) / 360) * dist * camera.aspect;
        const showcaseFrac = (w - panelW) / w;
        const chartW = (N - 1) * SPACING;
        const scale = clamp((visibleW * showcaseFrac * 0.72) / chartW, 0.5, 1.2);
        chart.scale.setScalar(scale);
        // RTL: panel sits on the right, so shift the chart to the centre of the remaining left area
        chart.position.x = -(panelW / w) * visibleW * 0.5;
        chart.position.y = w < 1024 ? 12 : 22;
        terrain.position.x = chart.position.x * 0.6;
      };
      window.addEventListener("resize", resize);
      resize();

      let mx = 0, my = 0, cx = 0, cy = 0;
      $("#loginOverlay")?.addEventListener("pointermove", (e) => {
        mx = (e.clientX / window.innerWidth - 0.5) * 2;
        my = (e.clientY / window.innerHeight - 0.5) * 2;
      });

      const t0 = performance.now();
      let lastTick = t0;
      const frame = (now) => {
        if (!this.running) return;
        this.raf = requestAnimationFrame(frame);
        const dt = Math.min(64, now - lastTick);
        lastTick = now;
        const t = (now - t0) / 1000;

        // terrain waves
        const arr = tPos.array;
        for (let i = 0; i < tPos.count; i++) {
          const x = base[i * 3], z = base[i * 3 + 2];
          arr[i * 3 + 1] = Math.sin(x * 0.045 + t * 0.7) * 2.6 + Math.cos(z * 0.06 + t * 0.5) * 2.2 + Math.sin((x + z) * 0.02 + t * 0.3) * 3.2;
        }
        tPos.needsUpdate = true;

        // march candles leftwards; recycle on the right
        if (!reduceMotion) offset += dt * 0.0026;
        if (offset >= SPACING) {
          offset -= SPACING;
          candles.shift();
          candles.push(nextCandle());
        }
        layoutCandles(now);
        const pulse = 1 + Math.sin(t * 3.2) * 0.18;
        head.scale.set(6 * pulse, 6 * pulse, 1);

        dust.rotation.y = t * 0.012;
        cx += (mx - cx) * 0.04;
        cy += (my - cy) * 0.04;
        camera.position.x = cx * 7;
        camera.position.y = 16 - cy * 4;
        camera.lookAt(lookAt);
        chart.rotation.y = cx * 0.08;
        renderer.render(scene, camera);
      };

      this.start = () => {
        if (this.running) return;
        this.running = true;
        resize();
        lastTick = performance.now();
        this.raf = requestAnimationFrame(frame);
      };
      this.stop = () => {
        this.running = false;
        cancelAnimationFrame(this.raf);
      };
      layoutCandles(performance.now() + 1000);
      this.ready = true;
      return true;
    },
    start() {},
    stop() {},
  };

  /* ───────────────────────── Three.js: home hero wave ───────────────────────── */
  const Hero = {
    ready: false,
    running: false,
    visible: true,
    init() {
      if (this.ready) return true;
      const canvas = $("#heroThreeCanvas");
      if (!canvas || !window.THREE) return false;
      const T = window.THREE;
      let renderer;
      try {
        renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true });
      } catch {
        return false;
      }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      const scene = new T.Scene();
      const camera = new T.PerspectiveCamera(40, 2, 0.1, 200);
      camera.position.set(0, 14, 46);
      camera.lookAt(0, -2, 0);

      const COLS = 90, ROWS = 26, W = 120, D = 34;
      const g = new T.PlaneGeometry(W, D, COLS - 1, ROWS - 1);
      g.rotateX(-Math.PI / 2);
      const pos = g.attributes.position;
      const base = new Float32Array(pos.array);
      const col = new Float32Array(pos.count * 3);
      const a = new T.Color("#6c8cff"), b = new T.Color("#f4b740"), tmp = new T.Color();
      for (let i = 0; i < pos.count; i++) {
        tmp.copy(a).lerp(b, (base[i * 3] + W / 2) / W);
        col[i * 3] = tmp.r; col[i * 3 + 1] = tmp.g; col[i * 3 + 2] = tmp.b;
      }
      g.setAttribute("color", new T.BufferAttribute(col, 3));
      const pts = new T.Points(g, new T.PointsMaterial({ size: 0.34, vertexColors: true, transparent: true, opacity: 0.9, blending: T.AdditiveBlending, depthWrite: false }));
      pts.position.x = -18;
      scene.add(pts);

      const resize = () => {
        const w = canvas.clientWidth, h = canvas.clientHeight;
        if (!w || !h) return;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      new ResizeObserver(resize).observe(canvas);
      resize();

      let mx = 0, cx = 0;
      canvas.parentElement?.addEventListener("pointermove", (e) => {
        const r = canvas.getBoundingClientRect();
        mx = (e.clientX - r.left) / r.width - 0.5;
      });
      new IntersectionObserver(([en]) => { this.visible = en.isIntersecting; if (this.visible) this.kick(); }).observe(canvas);

      const t0 = performance.now();
      const frame = (now) => {
        if (!this.running || !this.visible || document.hidden) { this.raf = 0; return; }
        this.raf = requestAnimationFrame(frame);
        const t = (now - t0) / 1000;
        const arr = pos.array;
        for (let i = 0; i < pos.count; i++) {
          const x = base[i * 3], z = base[i * 3 + 2];
          arr[i * 3 + 1] = Math.sin(x * 0.09 + t * 1.1) * 1.6 + Math.cos(z * 0.2 + t * 0.8) * 1.1 + Math.sin((x - z) * 0.05 + t * 0.4) * 1.8;
        }
        pos.needsUpdate = true;
        cx += (mx - cx) * 0.05;
        pts.rotation.y = cx * 0.25;
        renderer.render(scene, camera);
      };
      this.kick = () => {
        if (this.running && this.visible && !this.raf && !document.hidden) this.raf = requestAnimationFrame(frame);
      };
      this.ready = true;
      if (reduceMotion) { this.running = true; frame(performance.now()); this.running = false; }
      return true;
    },
    start() {
      if (!this.init() || reduceMotion) return;
      this.running = true;
      this.kick?.();
    },
    stop() { this.running = false; },
  };
  document.addEventListener("visibilitychange", () => { if (!document.hidden) Hero.kick?.(); });

  /* ───────────────────────── Login choreography ───────────────────────── */
  let loginVisible = false;

  function playLoginIntro() {
    loginVisible = true;
    if (Login.init()) Login.start();
    else window.addEventListener("load", () => { if (loginVisible && Login.init()) Login.start(); }, { once: true });
    if (!hasGsap()) return;
    const tl = gsap.timeline({ defaults: { ease: "power3.out" } });
    tl.fromTo("#loginThreeCanvas", { opacity: 0 }, { opacity: 1, duration: 1.6, ease: "power1.out" }, 0)
      .fromTo(".login-panel", { xPercent: 12, opacity: 0 }, { xPercent: 0, opacity: 1, duration: 0.9 }, 0.05)
      .fromTo("[data-login-in]", { y: 22, opacity: 0 }, { y: 0, opacity: 1, duration: 0.7, stagger: 0.07 }, 0.25)
      .fromTo(".showcase-title .line > span", { yPercent: 110 }, { yPercent: 0, duration: 1, stagger: 0.12, ease: "expo.out" }, 0.4)
      .fromTo(".showcase-kicker, .showcase-sub", { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.8, stagger: 0.1 }, 0.55)
      .fromTo(".showcase-features li", { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.7, stagger: 0.09 }, 0.75)
      .fromTo(".ticker", { opacity: 0 }, { opacity: 1, duration: 1 }, 0.9);
    setTimeout(() => $("#loginUsername")?.focus({ preventScroll: true }), 650);
  }

  function revealDashboard() {
    const wasLogin = loginVisible;
    loginVisible = false;
    Login.stop();
    const shell = $("#dashboard");
    if (!hasGsap() || !shell) return;
    if (wasLogin) {
      const btn = $("#loginSubmit")?.getBoundingClientRect();
      const x = btn ? btn.left + btn.width / 2 : window.innerWidth / 2;
      const y = btn ? btn.top + btn.height / 2 : window.innerHeight / 2;
      gsap.fromTo(shell, { clipPath: `circle(0px at ${x}px ${y}px)` }, {
        clipPath: `circle(${Math.hypot(window.innerWidth, window.innerHeight)}px at ${x}px ${y}px)`,
        duration: 1.05, ease: "expo.inOut", clearProps: "clipPath",
      });
    }
    gsap.fromTo(".sidebar .nav-item, .sidebar-brand, .sidebar-search, .sidebar-status", { x: 18, opacity: 0 }, {
      x: 0, opacity: 1, duration: 0.6, stagger: 0.03, delay: wasLogin ? 0.35 : 0.05, ease: "power3.out", clearProps: "transform,opacity",
    });
    gsap.fromTo(".topbar > *", { y: -10, opacity: 0 }, { y: 0, opacity: 1, duration: 0.6, stagger: 0.05, delay: wasLogin ? 0.45 : 0.1, ease: "power3.out", clearProps: "transform,opacity" });
  }

  function initLoginUx() {
    const pw = $("#loginPassword");
    const hint = $("#capsHint");
    const caps = (e) => { if (hint && e.getModifierState) hint.hidden = !e.getModifierState("CapsLock"); };
    pw?.addEventListener("keydown", caps);
    pw?.addEventListener("keyup", caps);
    pw?.addEventListener("blur", () => { if (hint) hint.hidden = true; });
    // shake the whole panel on error
    const box = $("#loginErrorBox");
    if (box && hasGsap()) {
      new MutationObserver(() => {
        if (box.classList.contains("active")) gsap.fromTo(".login-form", { x: -10 }, { x: 0, duration: 0.6, ease: "elastic.out(1, 0.3)" });
      }).observe(box, { attributes: true, attributeFilter: ["class"] });
    }
  }

  /* ───────────────────────── Page transitions ───────────────────────── */
  let currentPage = null;
  const pending = new Set();
  const revealIO = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (!en.isIntersecting) return;
      revealIO.unobserve(en.target);
      pending.delete(en.target);
      gsap.to(en.target, { y: 0, opacity: 1, duration: 0.7, ease: "power3.out", clearProps: "transform,opacity" });
    });
  }, { rootMargin: "0px 0px -8% 0px" }) : null;

  function animatePage(page) {
    const el = $(`#page-${page}`);
    if (!el) return;
    runRouteProgress();
    moveNavIndicator(true);
    if (page === "home") {
      if (window.THREE) Hero.start();
      else window.addEventListener("load", () => { if (currentPage === "home") Hero.start(); }, { once: true });
    } else Hero.stop();
    if (!hasGsap()) return;
    pending.forEach((n) => { revealIO?.unobserve(n); gsap.set(n, { clearProps: "transform,opacity" }); });
    pending.clear();
    const kids = Array.from(el.children).filter((k) => k.offsetParent !== null || k.classList.contains("save-dock"));
    const vh = window.innerHeight;
    const now = [], later = [];
    kids.forEach((k) => (k.getBoundingClientRect().top < vh * 0.95 ? now : later).push(k));
    gsap.fromTo(now, { y: 18, opacity: 0 }, { y: 0, opacity: 1, duration: 0.65, stagger: 0.055, ease: "power3.out", clearProps: "transform,opacity" });
    if (revealIO) {
      later.forEach((k) => {
        gsap.set(k, { y: 26, opacity: 0 });
        pending.add(k);
        revealIO.observe(k);
      });
    }
    // headline shimmer in
    const title = $("#pageTitle");
    if (title && currentPage !== page) gsap.fromTo(title, { y: 8, opacity: 0 }, { y: 0, opacity: 1, duration: 0.45, ease: "power2.out" });
    currentPage = page;
    if (page === "settings") syncRanges();
  }

  function runRouteProgress() {
    const bar = $("#routeProgress");
    if (!bar || !hasGsap()) return;
    gsap.killTweensOf(bar);
    gsap.timeline()
      .set(bar, { scaleX: 0, opacity: 1, transformOrigin: "right" })
      .to(bar, { scaleX: 0.7, duration: 0.35, ease: "power2.out" })
      .to(bar, { scaleX: 1, duration: 0.25, ease: "power1.in" })
      .to(bar, { opacity: 0, duration: 0.3 }, "+=0.05");
  }

  /* ───────────────────────── Sidebar active indicator ───────────────────────── */
  function moveNavIndicator(animate) {
    const nav = $("#sidebarNav");
    if (!nav) return;
    let ind = nav.querySelector(".nav-indicator");
    if (!ind) {
      ind = document.createElement("div");
      ind.className = "nav-indicator";
      nav.prepend(ind);
    }
    const active = nav.querySelector(".nav-item.active");
    if (!active || active.offsetParent === null) {
      ind.style.opacity = "0";
      return;
    }
    const top = active.offsetTop;
    const h = active.offsetHeight;
    if (hasGsap() && animate && ind.style.opacity === "1") {
      gsap.to(ind, { y: top, height: h, duration: 0.55, ease: "expo.out" });
    } else {
      if (window.gsap) gsap.set(ind, { y: top, height: h });
      else { ind.style.transform = `translateY(${top}px)`; ind.style.height = `${h}px`; }
      ind.style.opacity = "1";
    }
  }

  function watchNav() {
    const nav = $("#sidebarNav");
    if (!nav) return;
    new MutationObserver(() => {
      if (!nav.querySelector(".nav-indicator")) moveNavIndicator(false);
    }).observe(nav, { childList: true });
    nav.addEventListener("click", (e) => {
      if (e.target.closest("[data-group-toggle]")) requestAnimationFrame(() => moveNavIndicator(false));
    });
    new ResizeObserver(() => moveNavIndicator(false)).observe(nav);
  }

  /* ───────────────────────── Pointer effects ───────────────────────── */
  const SPOT_SEL = ".spot, .panel, .gauge-card, .quick-btn, .fb-ready-card, .cfg-chip";
  function initPointerFx() {
    if (!finePointer) return;
    document.body.classList.add("has-pointer");
    const glow = $("#cursorGlow");
    let gx = window.innerWidth / 2, gy = window.innerHeight / 2, tx = gx, ty = gy, glowRaf = 0;
    const glowLoop = () => {
      gx += (tx - gx) * 0.12; gy += (ty - gy) * 0.12;
      if (glow) glow.style.transform = `translate3d(${gx}px, ${gy}px, 0)`;
      glowRaf = Math.abs(tx - gx) + Math.abs(ty - gy) > 0.5 ? requestAnimationFrame(glowLoop) : 0;
    };

    document.addEventListener("pointermove", (e) => {
      tx = e.clientX; ty = e.clientY;
      if (!glowRaf && !reduceMotion) glowRaf = requestAnimationFrame(glowLoop);
      const host = e.target.closest?.(SPOT_SEL);
      if (host) {
        if (!host.classList.contains("spot") && !host.matches(".mgmt-card, .log-proc-card")) host.classList.add("spot");
        const r = host.getBoundingClientRect();
        host.style.setProperty("--mx", `${e.clientX - r.left}px`);
        host.style.setProperty("--my", `${e.clientY - r.top}px`);
      }
    }, { passive: true });

    if (!hasGsap()) return;

    // 3D tilt on KPI + gauge cards
    const tiltSel = ".kpi-card, .gauge-card, .ctrl-quick-btn";
    document.addEventListener("pointermove", (e) => {
      const card = e.target.closest?.(tiltSel);
      if (!card) return;
      const r = card.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      gsap.to(card, { rotateY: px * 7, rotateX: -py * 7, transformPerspective: 900, duration: 0.5, ease: "power2.out", overwrite: "auto" });
    }, { passive: true });
    document.addEventListener("pointerout", (e) => {
      const card = e.target.closest?.(tiltSel);
      if (card && !card.contains(e.relatedTarget)) gsap.to(card, { rotateY: 0, rotateX: 0, duration: 0.7, ease: "elastic.out(1, 0.5)", clearProps: "transform" });
    });

    // magnetic
    document.addEventListener("pointermove", (e) => {
      const m = e.target.closest?.(".magnetic");
      if (!m || m.disabled) return;
      const r = m.getBoundingClientRect();
      gsap.to(m, { x: (e.clientX - r.left - r.width / 2) * 0.18, y: (e.clientY - r.top - r.height / 2) * 0.25, duration: 0.4, ease: "power3.out" });
    }, { passive: true });
    document.addEventListener("pointerout", (e) => {
      const m = e.target.closest?.(".magnetic");
      if (m && !m.contains(e.relatedTarget)) gsap.to(m, { x: 0, y: 0, duration: 0.8, ease: "elastic.out(1, 0.4)" });
    });
  }

  function initRipples() {
    const sel = ".btn, .quick-btn, .power-btn, .ctrl-quick-btn, .login-submit, .sig-page-btn, .cfg-chip-action";
    document.addEventListener("pointerdown", (e) => {
      const b = e.target.closest?.(sel);
      if (!b || b.disabled || reduceMotion) return;
      const r = b.getBoundingClientRect();
      const size = Math.max(r.width, r.height) * 2.2;
      const ink = document.createElement("span");
      ink.className = "ripple";
      ink.style.width = ink.style.height = `${size}px`;
      ink.style.left = `${e.clientX - r.left - size / 2}px`;
      ink.style.top = `${e.clientY - r.top - size / 2}px`;
      b.appendChild(ink);
      setTimeout(() => ink.remove(), 700);
    });
  }

  /* ───────────────────────── Small reactive bits ───────────────────────── */
  function syncRanges() {
    $$(".settings-range").forEach((r) => {
      const min = +r.min || 0, max = +r.max || 100;
      r.style.setProperty("--fill", `${((+r.value - min) / (max - min)) * 100}%`);
    });
  }

  function initReactive() {
    document.addEventListener("input", (e) => { if (e.target.matches?.(".settings-range")) syncRanges(); });
    // Health ring follows the number rendered by dashboard.js
    const hs = $("#homeHealthScore");
    if (hs) {
      const apply = () => {
        const n = parseFloat(hs.textContent);
        hs.parentElement.style.setProperty("--p", Number.isFinite(n) ? clamp(n, 0, 100) : 0);
      };
      new MutationObserver(apply).observe(hs, { childList: true, characterData: true, subtree: true });
      apply();
    }
    // Score rings on signal cards pick a tone from their value
    const feed = $("#signalFeed");
    if (feed) {
      new MutationObserver(() => {
        $$(".signal-score-ring", feed).forEach((ring) => {
          const v = parseFloat(ring.textContent);
          if (!Number.isFinite(v)) return;
          const pct = v <= 20 ? (v / 20) * 100 : clamp(v, 0, 100);
          ring.style.background = `radial-gradient(circle, #141821 58%, transparent 60%), conic-gradient(var(--tone) 0 ${pct}%, rgba(255,255,255,0.08) 0)`;
          ring.style.setProperty("--tone", pct >= 70 ? "var(--buy)" : pct >= 45 ? "var(--gold)" : "var(--sell)");
        });
      }).observe(feed, { childList: true });
    }
    // Settings tabs: smooth scroll + scroll-spy
    const tabs = $$("#settingsTabs .settings-tab");
    tabs.forEach((t) => t.addEventListener("click", (e) => {
      e.preventDefault();
      $(t.getAttribute("href"))?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    }));
    if (tabs.length && "IntersectionObserver" in window) {
      const map = new Map(tabs.map((t) => [$(t.getAttribute("href")), t]));
      const io = new IntersectionObserver((entries) => {
        entries.forEach((en) => {
          if (!en.isIntersecting) return;
          tabs.forEach((t) => t.classList.remove("active"));
          map.get(en.target)?.classList.add("active");
        });
      }, { rootMargin: "-30% 0px -60% 0px" });
      map.forEach((_, sec) => sec && io.observe(sec));
    }
    // Copy CLI snippets
    document.addEventListener("click", (e) => {
      const code = e.target.closest?.(".snippet-code");
      if (!code) return;
      navigator.clipboard?.writeText(code.textContent.trim()).then(() => {
        code.dataset.copied = "1";
        const prev = code.style.color;
        code.style.color = "var(--gold)";
        setTimeout(() => { code.style.color = prev; }, 700);
      }).catch(() => {});
    });
    // Mirror sidebar search to palette
    $("#sidebarSearch")?.addEventListener("click", () => Palette.open());
    $("#cmdkTrigger")?.addEventListener("click", () => Palette.open());
  }

  /* ───────────────────────── Command palette ───────────────────────── */
  const NAV_ICON = {
    home: '<path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
    control: '<circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.2 4.2l2.8 2.8M17 17l2.8 2.8"/>',
    signals: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
    simulation: '<path d="M3 3v18h18"/><path d="M7 15l3-3 3 2 5-7"/>',
    reports: '<path d="M18 20V10M12 20V4M6 20v-6"/>',
    telegram: '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/>',
    facebook: '<path d="M14 8h3V3h-3c-3.3 0-6 2.7-6 6v3H5v5h3v4h5v-4h4l1-5h-5V9c0-.6.4-1 1-1z"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>',
    logs: '<polyline points="4 17 10 11 4 5"/><path d="M12 19h8"/>',
    play: '<polygon points="6 4 20 12 6 20 6 4"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/>',
    send: '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/>',
    sidebar: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/>',
    logout: '<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/>',
  };
  const GO_KEYS = { h: "home", m: "monitor", c: "control", s: "signals", i: "simulation", r: "reports", t: "telegram", f: "facebook", e: "settings", l: "logs" };
  const KEY_OF = Object.fromEntries(Object.entries(GO_KEYS).map(([k, v]) => [v, k]));

  const Palette = {
    items: [],
    active: 0,
    build() {
      const pages = window.TCNav?.pages?.() || {};
      const pageItems = Object.entries(pages).map(([key, meta]) => ({
        group: "صفحه‌ها", icon: NAV_ICON[key] || NAV_ICON.home, label: meta.title, sub: meta.sub,
        hint: `G ${KEY_OF[key]?.toUpperCase() || ""}`, terms: `${meta.title} ${meta.sub} ${key} ${meta.path}`,
        run: () => window.TCNav.go(key),
      }));
      const click = (sel) => () => $(sel)?.click();
      const actions = [
        { icon: NAV_ICON.layers, label: "مدیریت نمادها", sub: "افزودن، حذف و انتخاب نمادهای ردیابی", terms: "symbols نماد", run: click("#homeBtnSymbols") },
        { icon: NAV_ICON.send, label: "تست ارسال تلگرام", sub: "ارسال یک پیام آزمایشی به کانال", terms: "telegram test تلگرام", run: click("#homeBtnTelegramTest") },
        { icon: NAV_ICON.play, label: "روشن کردن همه‌ی سرویس‌ها", sub: "PM2 start all", terms: "start روشن", run: click("#btnStartAll") },
        { icon: NAV_ICON.stop, label: "توقف همه‌ی سرویس‌ها", sub: "PM2 stop all", terms: "stop توقف", run: click("#btnStopAll") },
        { icon: NAV_ICON.sidebar, label: "جمع/باز کردن منو", sub: "تغییر عرض سایدبار", terms: "sidebar menu منو", run: click("#sidebarCollapseBtn") },
        { icon: NAV_ICON.logout, label: "خروج از حساب", sub: "پایان نشست فعلی", terms: "logout خروج", run: click("#btnLogout") },
      ].map((a) => ({ ...a, group: "فرمان‌ها", hint: "" }));
      return [...pageItems, ...actions];
    },
    render(q = "") {
      const list = $("#cmdkList");
      if (!list) return;
      const needle = q.trim().toLowerCase();
      const all = this.build();
      const score = (i) => (i.label.toLowerCase().includes(needle) ? 0 : i.terms.toLowerCase().includes(needle) ? 1 : 2);
      this.items = needle
        ? all.filter((i) => `${i.label} ${i.sub} ${i.terms}`.toLowerCase().includes(needle)).sort((x, y) => score(x) - score(y))
        : all;
      this.active = clamp(this.active, 0, Math.max(0, this.items.length - 1));
      if (!this.items.length) {
        list.innerHTML = '<div class="cmdk-empty">نتیجه‌ای پیدا نشد</div>';
        return;
      }
      let lastGroup = "";
      list.innerHTML = this.items.map((it, i) => {
        const head = it.group !== lastGroup ? `<div class="cmdk-group">${it.group}</div>` : "";
        lastGroup = it.group;
        return `${head}<button type="button" class="cmdk-item${i === this.active ? " active" : ""}" data-i="${i}" role="option" aria-selected="${i === this.active}">
          <span class="ci-ic"><svg viewBox="0 0 24 24">${it.icon}</svg></span>
          <span class="ci-txt"><span>${it.label}</span><small>${it.sub || ""}</small></span>
          <span class="ci-key">${it.hint || ""}</span>
        </button>`;
      }).join("");
    },
    setActive(i) {
      this.active = clamp(i, 0, this.items.length - 1);
      $$("#cmdkList .cmdk-item").forEach((b) => {
        const on = +b.dataset.i === this.active;
        b.classList.toggle("active", on);
        b.setAttribute("aria-selected", on);
        if (on) b.scrollIntoView({ block: "nearest" });
      });
    },
    open() {
      if ($("#dashboard")?.classList.contains("hidden")) return;
      const ov = $("#cmdkOverlay");
      const input = $("#cmdkInput");
      if (!ov || !input) return;
      this.active = 0;
      input.value = "";
      this.render();
      ov.classList.add("open");
      ov.setAttribute("aria-hidden", "false");
      setTimeout(() => input.focus(), 20);
      if (hasGsap()) gsap.fromTo("#cmdkList .cmdk-item", { opacity: 0, x: 10 }, { opacity: 1, x: 0, duration: 0.35, stagger: 0.015, ease: "power2.out", clearProps: "all" });
    },
    close() {
      const ov = $("#cmdkOverlay");
      ov?.classList.remove("open");
      ov?.setAttribute("aria-hidden", "true");
    },
    run(i) {
      const it = this.items[i];
      this.close();
      if (it) setTimeout(() => it.run(), 60);
    },
    init() {
      const ov = $("#cmdkOverlay");
      const input = $("#cmdkInput");
      if (!ov || !input) return;
      input.addEventListener("input", () => { this.active = 0; this.render(input.value); });
      input.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") { e.preventDefault(); this.setActive(this.active + 1); }
        else if (e.key === "ArrowUp") { e.preventDefault(); this.setActive(this.active - 1); }
        else if (e.key === "Enter") { e.preventDefault(); this.run(this.active); }
        else if (e.key === "Escape") { e.preventDefault(); this.close(); }
      });
      ov.addEventListener("click", (e) => {
        const b = e.target.closest(".cmdk-item");
        if (b) this.run(+b.dataset.i);
        else if (e.target === ov) this.close();
      });
      ov.addEventListener("pointermove", (e) => {
        const b = e.target.closest(".cmdk-item");
        if (b && +b.dataset.i !== this.active) this.setActive(+b.dataset.i);
      });

      let goArmed = 0;
      document.addEventListener("keydown", (e) => {
        const typing = e.target.closest?.("input, textarea, select, [contenteditable]");
        if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K" || e.code === "KeyK")) {
          e.preventDefault();
          ov.classList.contains("open") ? this.close() : this.open();
          return;
        }
        if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
        if ($("#dashboard")?.classList.contains("hidden")) return;
        if (e.key === "/" ) { e.preventDefault(); this.open(); return; }
        const k = (e.code || "").replace("Key", "").toLowerCase();
        if (k === "g") { goArmed = Date.now(); return; }
        if (goArmed && Date.now() - goArmed < 900 && GO_KEYS[k]) {
          goArmed = 0;
          window.TCNav?.go(GO_KEYS[k]);
        }
      });
    },
  };

  /* ───────────────────────── Boot ───────────────────────── */
  document.addEventListener("tc:login", playLoginIntro);
  document.addEventListener("tc:dashboard", (e) => {
    revealDashboard();
    requestAnimationFrame(() => {
      moveNavIndicator(false);
      animatePage(e.detail?.page || window.TCNav?.current?.() || "home");
    });
  });
  document.addEventListener("tc:page", (e) => animatePage(e.detail?.page));

  document.addEventListener("DOMContentLoaded", () => {
    initLoginUx();
    initPointerFx();
    initRipples();
    initReactive();
    watchNav();
    Palette.init();
    // three.js is deferred; if the login is already on screen when it arrives, start the scene
    const overlay = $("#loginOverlay");
    if (overlay && !overlay.classList.contains("hidden") && !document.body.classList.contains("auth-pending")) {
      if (Login.init()) Login.start();
    }
  });
})();
