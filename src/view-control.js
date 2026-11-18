// ════════════════════════════════════════════════════════════════════════
// view-control.js — the zoom + density dial for CortexInsight.
//
// WHY THIS IS SMALL ON PURPOSE
// "I can zoom out to make it smaller" is a parameter problem. A true frame
// zoom scales every pixel proportionally and cannot break a layout, so it
// does the whole job with one dial. Density is the narrow complement — four
// spacing values, and NORMAL is byte-for-byte today's app.
//
// It is also fully self-contained: it owns its own markup, its own state,
// and its own persistence, and touches nothing else in the renderer. If it
// is ever unwanted, delete two <link>/<script> lines and it is gone.
// ════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  var KEY_ZOOM = 'ci.view.zoom';
  var KEY_DENS = 'ci.view.density';

  // The ladder is deliberately coarse. A continuous zoom invites fiddling;
  // seven honest steps get you where you're going in one or two presses.
  var STEPS = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5];
  var DENSITIES = ['compact', 'normal', 'roomy'];
  var DENS_GLYPH = { compact: '▪', normal: '▫', roomy: '◻' };

  var zoom = 1.0;
  var density = 'normal';
  var toastEl = null;
  var toastTimer = 0;

  // ── persistence ────────────────────────────────────────────────────────
  function load() {
    try {
      var z = parseFloat(localStorage.getItem(KEY_ZOOM));
      if (isFinite(z) && z >= 0.4 && z <= 2) zoom = z;
      var d = localStorage.getItem(KEY_DENS);
      if (DENSITIES.indexOf(d) >= 0) density = d;
    } catch (e) { /* private mode / storage disabled — defaults are fine */ }
  }
  function save() {
    try {
      localStorage.setItem(KEY_ZOOM, String(zoom));
      localStorage.setItem(KEY_DENS, density);
    } catch (e) { /* never let a storage failure break the view */ }
  }

  // ── apply ──────────────────────────────────────────────────────────────
  function applyZoom() {
    // The bridge is the only sanctioned path — contextIsolation is ON and the
    // renderer never touches Electron directly. If the bridge is missing (an
    // older preload), fall back to a CSS zoom so the control still works
    // rather than silently doing nothing.
    var ok = false;
    try {
      if (window.cortex && window.cortex.ui && window.cortex.ui.setZoom) {
        window.cortex.ui.setZoom(zoom);
        ok = true;
      }
    } catch (e) { ok = false; }
    if (!ok) { try { document.body.style.zoom = String(zoom); } catch (e2) {} }
  }

  function applyDensity() {
    document.body.setAttribute('data-density', density);
  }

  function render() {
    var now = document.getElementById('vcNow');
    if (now) {
      var pct = Math.round(zoom * 100);
      now.textContent = pct + '%';
      now.classList.toggle('vc-off', pct !== 100);
      now.title = 'Zoom ' + pct + '% — click to reset to 100%  (Ctrl + / − / 0)';
    }
    var dens = document.getElementById('vcDens');
    if (dens) {
      dens.textContent = DENS_GLYPH[density];
      dens.title = 'Spacing: ' + density + ' — click to cycle';
    }
  }

  // ── the quiet confirmation ─────────────────────────────────────────────
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'vc-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('on'); }, 1100);
  }

  // ── the moves ──────────────────────────────────────────────────────────
  function nearestStep() {
    var best = 0, bestD = Infinity;
    for (var i = 0; i < STEPS.length; i++) {
      var d = Math.abs(STEPS[i] - zoom);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  function step(dir) {
    var i = Math.max(0, Math.min(STEPS.length - 1, nearestStep() + dir));
    setZoom(STEPS[i]);
  }

  function setZoom(z) {
    zoom = z;
    applyZoom(); render(); save();
    toast(Math.round(zoom * 100) + '%');
  }

  function cycleDensity() {
    density = DENSITIES[(DENSITIES.indexOf(density) + 1) % DENSITIES.length];
    applyDensity(); render(); save();
    toast('Spacing · ' + density);
  }

  // ── mount ──────────────────────────────────────────────────────────────
  function mount() {
    // Sit immediately left of the window buttons — the last thing before
    // minimise/maximise/close, which is where every OS puts view controls.
    var controls = document.querySelector('.titlebar .tb-controls');
    if (!controls || !controls.parentNode) return false;

    if (document.getElementById('tbView')) return true;   // already mounted

    var box = document.createElement('div');
    box.className = 'tb-view';
    box.id = 'tbView';
    box.innerHTML =
      '<button class="vc-step" id="vcOut" title="Zoom out  (Ctrl −)" aria-label="Zoom out">−</button>' +
      '<button class="vc-now" id="vcNow" aria-label="Reset zoom to 100 percent">100%</button>' +
      '<button class="vc-step" id="vcIn" title="Zoom in  (Ctrl +)" aria-label="Zoom in">+</button>' +
      '<button class="vc-dens" id="vcDens" aria-label="Cycle spacing density">▫</button>';
    controls.parentNode.insertBefore(box, controls);

    document.getElementById('vcOut').addEventListener('click', function () { step(-1); });
    document.getElementById('vcIn').addEventListener('click', function () { step(1); });
    document.getElementById('vcNow').addEventListener('click', function () { setZoom(1.0); });
    document.getElementById('vcDens').addEventListener('click', cycleDensity);
    return true;
  }

  function keys(e) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    // Never steal a keystroke from a field the operator is typing in.
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
      if (e.key !== '0') return;
    }
    if (e.key === '-' || e.key === '_')                   { e.preventDefault(); step(-1); }
    else if (e.key === '=' || e.key === '+')              { e.preventDefault(); step(1); }
    else if (e.key === '0')                               { e.preventDefault(); setZoom(1.0); }
  }

  function boot() {
    load();
    applyZoom();
    applyDensity();
    if (!mount()) {
      // The titlebar is static markup, but if the renderer ever rebuilds it
      // this retries once on the next frame rather than failing silently.
      requestAnimationFrame(function () { mount(); render(); });
    }
    render();
    window.addEventListener('keydown', keys, true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
