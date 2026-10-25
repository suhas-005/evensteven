import { format } from './split.js';

export const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const raf = (fn) => requestAnimationFrame(fn);

// ---------- dot matrix ----------
export function dotMatrix(container) {
  if (reducedMotion()) return () => {};
  const c = document.createElement('canvas'); c.className = 'fx-dots'; container.prepend(c);
  const ctx = c.getContext('2d'); let w = 0, h = 0, dpr = 1, dots = [], id = 0, t0 = performance.now(), lastDraw = 0;
  const ptr = { x: -1e9, y: -1e9 };
  const SP = 22, R = 1.5, PR = 180, PUSH = 0.35, MAXS = 2.2, AMP = 3;
  function size() { dpr = Math.min(2, devicePixelRatio || 1); w = innerWidth; h = innerHeight; c.width = w * dpr; c.height = h * dpr; c.style.width = w + 'px'; c.style.height = h + 'px'; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dots = []; for (let y = SP / 2; y < h; y += SP) for (let x = SP / 2; x < w; x += SP) dots.push({ x, y }); }
  function frame(now) {
    id = raf(frame); if (now - lastDraw < 33) return; lastDraw = now;
    const t = (now - t0) / 1000; ctx.clearRect(0, 0, w, h);
    for (const d of dots) {
      const wx = Math.sin(t * 0.8 + d.y * 0.02) * AMP, wy = Math.cos(t * 0.6 + d.x * 0.02) * AMP;
      let x = d.x + wx, y = d.y + wy, s = 1, a = 0.15;
      const dx = x - ptr.x, dy = y - ptr.y, dist = Math.hypot(dx, dy);
      if (dist < PR) { const k = 1 - dist / PR; x += (dx / (dist || 1)) * k * PR * PUSH; y += (dy / (dist || 1)) * k * PR * PUSH; s = 1 + (MAXS - 1) * k; a = 0.15 + 0.85 * k; }
      ctx.fillStyle = `rgba(255,255,255,${a})`; ctx.beginPath(); ctx.arc(x, y, R * s, 0, Math.PI * 2); ctx.fill();
    }
    const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.75);
    g.addColorStop(0, 'rgba(10,10,10,0)'); g.addColorStop(1, 'rgba(10,10,10,0.9)'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  }
  const move = (e) => { const p = e.touches ? e.touches[0] : e; ptr.x = p.clientX; ptr.y = p.clientY; };
  const leave = () => { ptr.x = -1e9; ptr.y = -1e9; };
  const out = (e) => { if (e.relatedTarget === null) leave(); };
  const vis = () => { cancelAnimationFrame(id); if (!document.hidden) id = raf(frame); };
  addEventListener('resize', size); addEventListener('pointermove', move); addEventListener('touchmove', move, { passive: true }); addEventListener('pointerleave', leave); document.addEventListener('visibilitychange', vis); addEventListener('pointerup', leave); addEventListener('pointercancel', leave); addEventListener('touchend', leave); document.addEventListener('pointerout', out);
  size(); id = raf(frame);
  return () => { cancelAnimationFrame(id); removeEventListener('resize', size); removeEventListener('pointermove', move); removeEventListener('touchmove', move); removeEventListener('pointerleave', leave); document.removeEventListener('visibilitychange', vis); removeEventListener('pointerup', leave); removeEventListener('pointercancel', leave); removeEventListener('touchend', leave); document.removeEventListener('pointerout', out); c.remove(); };
}

// ---------- orbital ring ----------
export function orbitalRing(container) {
  const el = document.createElement('div'); el.className = 'orbital'; el.setAttribute('role', 'status'); el.setAttribute('aria-label', 'Reading receipt');
  el.innerHTML = '<span class="ring outer"></span><span class="ring inner"></span><span class="p p1"></span><span class="p p2"></span><span class="p p3"></span>';
  container.appendChild(el);
  return () => el.remove();
}

// ---------- odometer ----------
export function planDigits(fromStr, toStr) {
  const out = []; const fd = fromStr.replace(/\D/g, ''); let fi = fd.length - 1;
  for (let i = toStr.length - 1; i >= 0; i--) {
    const ch = toStr[i];
    if (/\d/.test(ch)) { out.unshift({ ch, from: fi >= 0 ? Number(fd[fi]) : 0, to: Number(ch), static: false }); fi--; }
    else out.unshift({ ch, from: 0, to: 0, static: true });
  }
  return out;
}

export function odometer(el, toMinor, currency, { signed = false } = {}) {
  const prev = Number(el.dataset.v ?? 0); el.dataset.v = String(toMinor); const gen = (Number(el.dataset.g) || 0) + 1; el.dataset.g = String(gen);
  const sign = signed && toMinor > 0 ? '+' : ''; const toStr = sign + format(toMinor, currency); const fromStr = format(prev, currency);
  if (reducedMotion() || prev === toMinor || !el.isConnected) { el.textContent = toStr; el.removeAttribute('aria-label'); return; }
  const plan = planDigits(fromStr, toStr); el.textContent = ''; el.classList.add('odo'); el.setAttribute('aria-label', toStr);
  const wrap = document.createElement('span'); wrap.setAttribute('aria-hidden', 'true'); wrap.style.display = 'inline-flex'; el.appendChild(wrap);
  for (const d of plan) {
    if (d.static) { const s = document.createElement('span'); s.textContent = d.ch; wrap.appendChild(s); continue; }
    const col = document.createElement('span'); col.className = 'odo-col';
    const strip = document.createElement('span'); strip.className = 'odo-strip';
    const steps = (d.to - d.from + 10) % 10; const seq = []; for (let k = 0; k <= steps; k++) seq.push((d.from + k) % 10);
    strip.textContent = seq.join('\n'); col.appendChild(strip); wrap.appendChild(col);
    raf(() => { strip.style.transform = `translateY(-${steps * 1.5}em)`; });
  }
  setTimeout(() => { if (el.dataset.g === String(gen)) { el.textContent = toStr; el.removeAttribute('aria-label'); el.classList.remove('odo'); } }, 560);
}

// ---------- reveal rows ----------
export function revealRow(tr, { onToggle } = {}) {
  const fine = typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches;
  if (fine) {
    const still = reducedMotion();
    const move = (e) => { if (still) return; const r = tr.getBoundingClientRect(); const px = (e.clientX - r.left) / r.width - 0.5, py = (e.clientY - r.top) / r.height - 0.5;
      tr.style.setProperty('--rx', `${(-py * 12).toFixed(2)}deg`); tr.style.setProperty('--ry', `${(px * 12).toFixed(2)}deg`); tr.style.setProperty('--gx', `${(px + 0.5) * 100}%`); };
    const leave = () => { tr.style.removeProperty('--rx'); tr.style.removeProperty('--ry'); };
    tr.addEventListener('pointermove', move); tr.addEventListener('pointerleave', leave); tr.classList.add('reveal');
    return () => { tr.removeEventListener('pointermove', move); tr.removeEventListener('pointerleave', leave); leave(); tr.style.removeProperty('--gx'); tr.classList.remove('reveal'); };
  }
  const tap = (e) => { if (e.target.closest('a')) return; if (!tr.classList.contains('open')) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); tr.classList.add('open'); onToggle?.(true); } };
  tr.addEventListener('click', tap, true); tr.classList.add('reveal', 'touch');
  return () => { tr.removeEventListener('click', tap, true); tr.classList.remove('reveal', 'touch'); };
}

// ---------- shooting stars ----------
export function shootingStars(container) {
  if (reducedMotion()) return () => {};
  const c = document.createElement('canvas'); c.className = 'fx-stars'; container.prepend(c); const ctx = c.getContext('2d');
  let w, h, id = 0, last = 0, io = null; const stars = []; const meteors = []; const ANG = (42 * Math.PI) / 180;
  function size() { const r = container.getBoundingClientRect(); const dpr = Math.min(2, devicePixelRatio || 1); w = Math.max(1, r.width); h = Math.max(1, r.height); c.width = w * dpr; c.height = h * dpr; c.style.width = w + 'px'; c.style.height = h + 'px'; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); stars.length = 0; for (let i = 0; i < 60; i++) stars.push({ x: Math.random() * w, y: Math.random() * h, r: 0.6 + Math.random() * 1.6, p: Math.random() * 6 }); }
  function frame(now) {
    ctx.clearRect(0, 0, w, h);
    for (const s of stars) { const a = 0.4 + 0.6 * Math.abs(Math.sin(now / 900 + s.p)); ctx.fillStyle = `rgba(255,255,255,${a})`; ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill(); }
    if (now - last > 2200 && meteors.length < 2) { last = now; meteors.push({ x: Math.random() * w * 0.6, y: -10, v: 14 + Math.random() * 8, len: 90 + Math.random() * 90 }); }
    for (let i = meteors.length - 1; i >= 0; i--) { const m = meteors[i]; m.x += Math.cos(ANG) * m.v; m.y += Math.sin(ANG) * m.v;
      const tx = m.x - Math.cos(ANG) * m.len, ty = m.y - Math.sin(ANG) * m.len; const g = ctx.createLinearGradient(tx, ty, m.x, m.y); g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(255,255,255,0.9)');
      ctx.strokeStyle = g; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(m.x, m.y); ctx.stroke(); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(m.x, m.y, 2, 0, Math.PI * 2); ctx.fill();
      if (m.x > w + m.len || m.y > h + m.len) meteors.splice(i, 1); }
    id = raf(frame);
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(size) : null;
  if (ro) ro.observe(container); else addEventListener('resize', size);
  size(); id = raf(frame);
  if (typeof IntersectionObserver === 'function') {
    io = new IntersectionObserver((es) => { const on = es[es.length - 1].isIntersecting; cancelAnimationFrame(id); id = 0; if (on) id = raf(frame); });
    io.observe(container);
  }
  return () => { cancelAnimationFrame(id); if (io) io.disconnect(); if (ro) ro.disconnect(); else removeEventListener('resize', size); c.remove(); };
}
