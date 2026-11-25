// Night-sky background: three layers of drifting stars (parallax on scroll), a few slow glowing
// orbs, and faint compass rings floating past. Pauses when the tab is hidden; still image if the
// viewer prefers reduced motion.
(() => {
  const c = document.getElementById("sky"); if (!c) return;
  const ctx = c.getContext("2d");
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let W, H, dpr, stars = [], orbs = [], rings = [], t0 = performance.now();
  const rnd = (a, b) => a + Math.random() * (b - a);
  function setup() {
    dpr = Math.min(2, devicePixelRatio || 1); W = innerWidth; H = innerHeight;
    c.width = W * dpr; c.height = H * dpr; c.style.width = W + "px"; c.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.round((W * H) / 9000);
    stars = Array.from({ length: n }, () => ({ x: rnd(0, W), y: rnd(0, H), z: Math.random() < 0.6 ? 0.25 : Math.random() < 0.8 ? 0.55 : 1, r: rnd(0.4, 1.4), tw: rnd(0, Math.PI * 2), vx: rnd(-0.02, 0.02), vy: rnd(-0.035, -0.008) }));
    orbs = [
      { x: W * 0.15, y: H * 0.3, r: 260, hue: "127,212,245", a: 0.07, sx: 0.00011, sy: 0.00007 },
      { x: W * 0.85, y: H * 0.7, r: 320, hue: "61,220,151", a: 0.05, sx: 0.00008, sy: 0.00012 },
      { x: W * 0.6, y: H * 0.15, r: 200, hue: "120,140,255", a: 0.05, sx: 0.00013, sy: 0.00009 },
    ];
    rings = Array.from({ length: 4 }, (_, i) => ({ x: rnd(0, W), y: rnd(0, H), r: rnd(40, 110), rot: rnd(0, 6.28), vr: rnd(-0.00012, 0.00012), vx: rnd(-0.012, 0.012), vy: rnd(-0.015, -0.004), a: rnd(0.05, 0.1) }));
  }
  function star4(x, y, r, a) { // tiny four-point sparkle
    ctx.globalAlpha = a; ctx.beginPath();
    ctx.moveTo(x, y - r * 3); ctx.lineTo(x + r * 0.6, y); ctx.lineTo(x, y + r * 3); ctx.lineTo(x - r * 0.6, y); ctx.closePath();
    ctx.moveTo(x - r * 3, y); ctx.lineTo(x, y - r * 0.6); ctx.lineTo(x + r * 3, y); ctx.lineTo(x, y + r * 0.6); ctx.closePath(); ctx.fill();
  }
  function frame(now) {
    const t = now - t0, sy = scrollY;
    ctx.clearRect(0, 0, W, H);
    for (const o of orbs) {
      const x = o.x + Math.sin(t * o.sx) * 120, y = o.y + Math.cos(t * o.sy) * 90 - sy * 0.05;
      const g = ctx.createRadialGradient(x, y, 0, x, y, o.r);
      g.addColorStop(0, `rgba(${o.hue},${o.a})`); g.addColorStop(1, `rgba(${o.hue},0)`);
      ctx.globalAlpha = 1; ctx.fillStyle = g; ctx.fillRect(x - o.r, y - o.r, o.r * 2, o.r * 2);
    }
    ctx.strokeStyle = "#7FD4F5";
    for (const g of rings) {
      g.x += g.vx; g.y += g.vy; g.rot += g.vr * 16;
      if (g.y < -150) { g.y = H + 150; g.x = rnd(0, W); }
      const y = g.y - (sy * 0.08) % (H + 300);
      ctx.globalAlpha = g.a; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(g.x, y, g.r, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([2, 7]); ctx.beginPath(); ctx.arc(g.x, y, g.r * 0.78, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      for (let k = 0; k < 4; k++) { const an = g.rot + k * Math.PI / 2; ctx.beginPath(); ctx.moveTo(g.x + Math.cos(an) * g.r * 0.86, y + Math.sin(an) * g.r * 0.86); ctx.lineTo(g.x + Math.cos(an) * g.r * 1.1, y + Math.sin(an) * g.r * 1.1); ctx.stroke(); }
    }
    ctx.fillStyle = "#DDF3FF";
    for (const s of stars) {
      s.x += s.vx * s.z; s.y += s.vy * s.z;
      if (s.y < -10) { s.y = H + 10; s.x = rnd(0, W); } if (s.x < -10) s.x = W + 10; if (s.x > W + 10) s.x = -10;
      const y = ((s.y - sy * 0.15 * s.z) % H + H) % H;
      const a = (0.35 + 0.45 * Math.sin(t * 0.0012 + s.tw)) * (0.4 + s.z * 0.6);
      if (s.z === 1 && s.r > 1.1) star4(s.x, y, s.r * 0.8, a);
      else { ctx.globalAlpha = a; ctx.beginPath(); ctx.arc(s.x, y, s.r * s.z, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.globalAlpha = 1;
    if (!still && !document.hidden) requestAnimationFrame(frame);
  }
  setup(); addEventListener("resize", setup);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !still) requestAnimationFrame(frame); });
  requestAnimationFrame(frame);
})();
