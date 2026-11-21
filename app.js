'use strict';

(() => {
  // =====================================================================
  //  Konfiguration
  // =====================================================================
  const MAX_PREVIEW = 1600;        // längste Kante der Vorschau in px
  const MAX_AREA = 16_000_000;     // Obergrenze (Safari-Canvas-Limit ~16,7 MP)
  const HISTORY_LIMIT = 40;
  const THUMB_SIZE = 180;

  const ADJUSTMENTS = [
    { group: 'Licht', items: [
      ['exposure', 'Belichtung', -100, 100],
      ['brightness', 'Helligkeit', -100, 100],
      ['contrast', 'Kontrast', -100, 100],
      ['highlights', 'Lichter', -100, 100],
      ['shadows', 'Tiefen', -100, 100],
    ] },
    { group: 'Farbe', items: [
      ['temperature', 'Farbtemperatur', -100, 100],
      ['tint', 'Tönung', -100, 100],
      ['saturation', 'Sättigung', -100, 100],
      ['vibrance', 'Dynamik', -100, 100],
      ['hue', 'Farbton', -180, 180],
    ] },
    { group: 'Effekte', items: [
      ['sharpen', 'Schärfen', 0, 100],
      ['blur', 'Weichzeichnen', 0, 100],
      ['vignette', 'Vignette', -100, 100],
      ['grain', 'Körnung', 0, 100],
      ['fade', 'Verblassen', 0, 100],
      ['grayscale', 'Schwarzweiß', 0, 100],
      ['sepia', 'Sepia', 0, 100],
    ] },
  ];
  const ADJ_META = Object.fromEntries(ADJUSTMENTS.flatMap(g => g.items.map(([id, label, min, max]) => [id, { label, min, max }])));
  const DEFAULTS = Object.fromEntries(Object.keys(ADJ_META).map(id => [id, 0]));

  const PRESETS = [
    { name: 'Original', adj: {} },
    { name: 'Lebendig', adj: { contrast: 15, vibrance: 45, saturation: 10, sharpen: 10 } },
    { name: 'Warm', adj: { temperature: 35, vibrance: 12, exposure: 4, shadows: 8 } },
    { name: 'Kühl', adj: { temperature: -35, tint: -5, contrast: 8, highlights: -10 } },
    { name: 'Vintage', adj: { sepia: 35, fade: 35, contrast: -10, vignette: 35, grain: 25, temperature: 15 } },
    { name: 'Drama', adj: { contrast: 45, highlights: -35, shadows: 25, saturation: -15, vignette: 40, sharpen: 30 } },
    { name: 'Schwarzweiß', adj: { grayscale: 100, contrast: 20 } },
    { name: 'Noir', adj: { grayscale: 100, contrast: 60, exposure: -10, vignette: 50, grain: 20 } },
    { name: 'Verblasst', adj: { fade: 50, saturation: -25, contrast: -15, exposure: 5 } },
    { name: 'Sonnig', adj: { exposure: 10, temperature: 25, shadows: 25, vibrance: 25 } },
    { name: 'Analog', adj: { fade: 20, grain: 35, contrast: 10, temperature: 8, tint: 6, saturation: -10 } },
    { name: 'Pop', adj: { saturation: 40, contrast: 25, vibrance: 20, sharpen: 20 } },
  ];

  const RATIOS = [
    ['Frei', null], ['Original', 'orig'], ['1:1', 1], ['4:3', 4 / 3], ['3:4', 3 / 4],
    ['16:9', 16 / 9], ['9:16', 9 / 16], ['3:2', 3 / 2], ['2:3', 2 / 3],
  ];

  // =====================================================================
  //  Bildverarbeitung
  // =====================================================================
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  /** Horizontaler Box-Blur, alle vier Kanäle in einem Durchlauf. */
  function blurH(src, dst, w, h, r) {
    const inv = 1 / (2 * r + 1);
    const last = w - 1;
    for (let y = 0; y < h; y++) {
      const row = y * w * 4;
      let sr = 0, sg = 0, sb = 0, sa = 0;
      for (let k = -r; k <= r; k++) {
        const j = row + clamp(k, 0, last) * 4;
        sr += src[j]; sg += src[j + 1]; sb += src[j + 2]; sa += src[j + 3];
      }
      for (let x = 0; x < w; x++) {
        const o = row + x * 4;
        dst[o] = sr * inv; dst[o + 1] = sg * inv; dst[o + 2] = sb * inv; dst[o + 3] = sa * inv;
        const ad = row + (x + r + 1 > last ? last : x + r + 1) * 4;
        const su = row + (x - r < 0 ? 0 : x - r) * 4;
        sr += src[ad] - src[su]; sg += src[ad + 1] - src[su + 1];
        sb += src[ad + 2] - src[su + 2]; sa += src[ad + 3] - src[su + 3];
      }
    }
  }

  /** Vertikaler Box-Blur – zeilenweise mit Spaltensummen (cache-freundlich). */
  function blurV(src, dst, w, h, r) {
    const inv = 1 / (2 * r + 1);
    const stride = w * 4;
    const last = h - 1;
    const acc = new Float32Array(stride);
    for (let k = -r; k <= r; k++) {
      const row = clamp(k, 0, last) * stride;
      for (let i = 0; i < stride; i++) acc[i] += src[row + i];
    }
    for (let y = 0; y < h; y++) {
      const o = y * stride;
      const ad = (y + r + 1 > last ? last : y + r + 1) * stride;
      const su = (y - r < 0 ? 0 : y - r) * stride;
      for (let i = 0; i < stride; i++) {
        dst[o + i] = acc[i] * inv;
        acc[i] += src[ad + i] - src[su + i];
      }
    }
  }

  /** Mehrfacher Box-Blur ≈ Gauß. Gibt ein neues Array zurück, src bleibt unverändert. */
  function boxBlur(src, w, h, r, passes) {
    const out = new Uint8ClampedArray(src.length);
    const tmp = new Uint8ClampedArray(src.length);
    blurH(src, tmp, w, h, r);
    blurV(tmp, out, w, h, r);
    for (let p = 1; p < passes; p++) {
      blurH(out, tmp, w, h, r);
      blurV(tmp, out, w, h, r);
    }
    return out;
  }

  function hueMatrix(deg) {
    const a = (deg * Math.PI) / 180;
    const c = Math.cos(a), s = Math.sin(a);
    return [
      0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
      0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283,
      0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
    ];
  }

  /** Deterministisches Rauschen, damit die Körnung beim Schieben nicht flackert. */
  function noise(x, y) {
    let n = Math.imul(x, 374761393) + Math.imul(y, 668265263);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    n ^= n >>> 16;
    return (n & 0xffff) / 65535 - 0.5;
  }

  /**
   * Wendet alle Anpassungen auf RGBA-Pixel an.
   * Alle Radien sind relativ zur Bildgröße, damit Vorschau und Export gleich aussehen.
   */
  function processPixels(src, w, h, a) {
    const longEdge = Math.max(w, h);
    let data = src;

    if (a.blur > 0) {
      const r = Math.max(1, Math.round((a.blur / 100) * longEdge * 0.012));
      data = boxBlur(data, w, h, r, 3);
    }

    if (a.sharpen > 0) {
      const r = Math.max(1, Math.round(longEdge / 1400));
      const soft = boxBlur(data, w, h, r, 1);
      const amt = (a.sharpen / 100) * 2;
      const sharp = new Uint8ClampedArray(data.length);
      for (let i = 0; i < data.length; i += 4) {
        sharp[i] = data[i] + (data[i] - soft[i]) * amt;
        sharp[i + 1] = data[i + 1] + (data[i + 1] - soft[i + 1]) * amt;
        sharp[i + 2] = data[i + 2] + (data[i + 2] - soft[i + 2]) * amt;
        sharp[i + 3] = data[i + 3];
      }
      data = sharp;
    }

    const out = new Uint8ClampedArray(data.length);

    const exp = Math.pow(2, (a.exposure / 100) * 1.5);
    const bright = a.brightness * 0.8;
    const cv = a.contrast * 1.28;
    const cf = (259 * (cv + 255)) / (255 * (259 - cv));
    const hl = a.highlights / 100, sh = a.shadows / 100;
    const doTone = hl !== 0 || sh !== 0;
    const temp = a.temperature * 0.35;
    const tint = a.tint * 0.3;
    const sat = 1 + a.saturation / 100;
    const vib = a.vibrance / 100;
    const hm = a.hue ? hueMatrix(a.hue) : null;
    const sep = a.sepia / 100;
    const gray = a.grayscale / 100;
    const fade = a.fade / 100;
    const fadeLift = fade * 45, fadeScale = 1 - fade * 0.32;
    const vig = a.vignette / 100;
    const grain = (a.grain / 100) * 70;
    const cx = w / 2, cy = h / 2;
    // Vignette: Stärke als Funktion des quadrierten Abstands (0 … 2) vorberechnen
    const VIG_SCALE = 2048;
    let vigLut = null;
    if (vig) {
      vigLut = new Float32Array(2 * VIG_SCALE + 2);
      for (let i = 0; i < vigLut.length; i++) {
        const d = Math.sqrt(i / VIG_SCALE) / Math.SQRT2;
        const t = clamp((d - 0.3) / 0.7, 0, 1);
        vigLut[i] = t * t * (3 - 2 * t) * vig;
      }
    }
    const grainScale = Math.max(1, longEdge / 1600); // Korngröße skaliert mit Auflösung

    for (let y = 0; y < h; y++) {
      const dy = (y - cy) / cy;
      const dy2 = dy * dy;
      const gy = Math.floor(y / grainScale);
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        let r = data[i], g = data[i + 1], b = data[i + 2];

        if (exp !== 1) { r *= exp; g *= exp; b *= exp; }
        if (bright) { r += bright; g += bright; b += bright; }
        if (cf !== 1) {
          r = (r - 128) * cf + 128;
          g = (g - 128) * cf + 128;
          b = (b - 128) * cf + 128;
        }
        if (doTone) {
          const L = clamp((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255, 0, 1);
          const d = (sh * (1 - L) * (1 - L) + hl * L * L) * 90;
          r += d; g += d; b += d;
        }
        if (temp) { r += temp; g += temp * 0.15; b -= temp; }
        if (tint) { g -= tint; r += tint * 0.35; b += tint * 0.35; }

        if (sat !== 1 || vib) {
          const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          let f = sat;
          if (vib) {
            const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
            const s = clamp((mx - mn) / 255, 0, 1);
            f *= 1 + vib * (1 - s) * 1.2;
          }
          r = L + (r - L) * f;
          g = L + (g - L) * f;
          b = L + (b - L) * f;
        }

        if (hm) {
          const nr = hm[0] * r + hm[1] * g + hm[2] * b;
          const ng = hm[3] * r + hm[4] * g + hm[5] * b;
          const nb = hm[6] * r + hm[7] * g + hm[8] * b;
          r = nr; g = ng; b = nb;
        }

        if (sep) {
          const sr = 0.393 * r + 0.769 * g + 0.189 * b;
          const sg = 0.349 * r + 0.686 * g + 0.168 * b;
          const sb = 0.272 * r + 0.534 * g + 0.131 * b;
          r += (sr - r) * sep; g += (sg - g) * sep; b += (sb - b) * sep;
        }

        if (gray) {
          const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          r += (L - r) * gray; g += (L - g) * gray; b += (L - b) * gray;
        }

        if (fade) {
          r = fadeLift + r * fadeScale;
          g = fadeLift + g * fadeScale;
          b = fadeLift + b * fadeScale;
        }

        if (vig) {
          const dx = (x - cx) / cx;
          const t = vigLut[((dx * dx + dy2) * VIG_SCALE) | 0];
          if (t > 0) {
            const k = 1 - t * 0.85;
            r *= k; g *= k; b *= k;
          } else if (t < 0) {
            const k = -t * 0.85;
            r += (255 - r) * k; g += (255 - g) * k; b += (255 - b) * k;
          }
        }

        if (grain) {
          const n = noise(Math.floor(x / grainScale), gy) * grain;
          r += n; g += n; b += n;
        }

        out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = data[i + 3];
      }
    }
    return out;
  }

  // =====================================================================
  //  Canvas-Hilfen
  // =====================================================================
  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  function ctx2d(c) {
    return c.getContext('2d', { willReadFrequently: true });
  }

  /** Hochwertiges Skalieren (schrittweise halbieren beim Verkleinern). */
  function scaleCanvas(src, w, h) {
    let cur = src;
    while (cur.width / 2 >= w && cur.height / 2 >= h) {
      const half = makeCanvas(Math.round(cur.width / 2), Math.round(cur.height / 2));
      const hx = half.getContext('2d');
      hx.imageSmoothingQuality = 'high';
      hx.drawImage(cur, 0, 0, half.width, half.height);
      cur = half;
    }
    const out = makeCanvas(w, h);
    const ox = out.getContext('2d');
    ox.imageSmoothingQuality = 'high';
    ox.drawImage(cur, 0, 0, w, h);
    return out;
  }

  function cloneCanvas(src) {
    const c = makeCanvas(src.width, src.height);
    c.getContext('2d').drawImage(src, 0, 0);
    return c;
  }

  function fitSize(w, h, maxEdge) {
    const s = Math.min(1, maxEdge / Math.max(w, h));
    return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
  }

  // =====================================================================
  //  Zustand
  // =====================================================================
  const state = {
    base: null,         // aktuelles Bild (Geometrie: Zuschnitt, Drehung …) – wird nie verändert, nur ersetzt
    original: null,     // ursprünglich geladenes Bild
    adj: { ...DEFAULTS },
    preset: null,       // { index, strength } oder null
    history: [],
    hIndex: -1,
    previewSrc: null,   // ImageData der verkleinerten Vorschau
    previewLow: null,   // halbe Auflösung für flüssiges Schieben bei teuren Effekten
    lastRenderMs: 0,
    thumbSrc: null,
    thumbsDirty: true,
    showOriginal: false,
    tab: 'adjust',
    crop: { x: 0, y: 0, w: 1, h: 1, ratio: null, ratioKey: 'Frei' },
    fileName: 'foto',
    resizeLocked: true,
  };

  // =====================================================================
  //  DOM
  // =====================================================================
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  const canvas = $('#canvas');
  const ctx = ctx2d(canvas);
  const stage = $('#stage');
  const fileInput = $('#fileInput');
  const cropLayer = $('#cropLayer');
  const cropBox = $('#cropBox');
  const histCanvas = $('#histogram');
  const sliderEls = {};

  // ---------- Toast & Busy ----------
  let toastTimer;
  function toast(msg, isError = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('error', isError);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
  }

  function setBusy(on, text = 'Wird verarbeitet …') {
    $('#busyText').textContent = text;
    $('#busy').hidden = !on;
  }

  /** Lässt den Browser einmal zeichnen, bevor schwere Arbeit beginnt. */
  const nextFrame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));

  // =====================================================================
  //  Regler aufbauen
  // =====================================================================
  function buildSliders() {
    const root = $('#sliders');
    for (const group of ADJUSTMENTS) {
      const g = document.createElement('div');
      g.className = 'slider-group';
      g.innerHTML = `<h3>${group.group}</h3>`;
      for (const [id, label, min, max] of group.items) {
        const row = document.createElement('div');
        row.className = 'slider-row';
        row.innerHTML = `
          <div class="slider-head">
            <label for="adj-${id}" title="Doppelklick zum Zurücksetzen">${label}</label>
            <output title="Klicken zum Zurücksetzen">0</output>
          </div>
          <input type="range" id="adj-${id}" min="${min}" max="${max}" step="1" value="0">`;
        const input = $('input', row);
        const out = $('output', row);
        input.addEventListener('input', () => {
          state.adj[id] = Number(input.value);
          state.preset = null;
          syncSlider(id);
          syncPresetUI();
          scheduleRender(true);
        });
        input.addEventListener('change', () => { render(); commit(); });
        const reset = () => {
          if (state.adj[id] === 0) return;
          state.adj[id] = 0;
          state.preset = null;
          syncSlider(id);
          syncPresetUI();
          scheduleRender();
          commit();
        };
        out.addEventListener('click', reset);
        $('label', row).addEventListener('dblclick', reset);
        sliderEls[id] = { row, input, out };
        g.appendChild(row);
      }
      root.appendChild(g);
    }
  }

  function paintTrack(input) {
    const min = Number(input.min), max = Number(input.max), v = Number(input.value);
    const center = ((clamp(0, min, max) - min) / (max - min)) * 100;
    const pos = ((v - min) / (max - min)) * 100;
    const from = Math.min(center, pos), to = Math.max(center, pos);
    input.style.setProperty('--track',
      `linear-gradient(to right, var(--track-bg) 0 ${from}%, var(--accent) ${from}% ${to}%, var(--track-bg) ${to}% 100%)`);
  }

  function syncSlider(id) {
    const el = sliderEls[id];
    const v = state.adj[id];
    el.input.value = v;
    el.out.textContent = v > 0 && ADJ_META[id].min < 0 ? `+${v}` : String(v);
    el.row.classList.toggle('changed', v !== 0);
    paintTrack(el.input);
  }

  function syncAllSliders() {
    for (const id of Object.keys(sliderEls)) syncSlider(id);
  }

  // =====================================================================
  //  Filter / Presets
  // =====================================================================
  const presetCanvases = [];

  function buildPresets() {
    const root = $('#presets');
    PRESETS.forEach((p, i) => {
      const btn = document.createElement('button');
      btn.className = 'preset';
      btn.type = 'button';
      const c = makeCanvas(THUMB_SIZE, THUMB_SIZE);
      presetCanvases.push(c);
      btn.append(c, document.createTextNode(p.name));
      btn.addEventListener('click', () => applyPreset(i, state.preset?.index === i ? state.preset.strength : 100));
      root.appendChild(btn);
    });

    const strength = $('#presetStrength');
    paintTrack(strength);
    strength.addEventListener('input', () => {
      paintTrack(strength);
      $('#presetStrengthOut').textContent = strength.value;
      if (state.preset) applyPreset(state.preset.index, Number(strength.value), false, true);
    });
    strength.addEventListener('change', () => { render(); commit(); });
  }

  function presetAdj(index, strength) {
    const p = PRESETS[index].adj;
    const adj = { ...DEFAULTS };
    for (const k of Object.keys(p)) adj[k] = Math.round(p[k] * strength / 100);
    return adj;
  }

  function applyPreset(index, strength = 100, doCommit = true, fast = false) {
    state.adj = presetAdj(index, strength);
    state.preset = index === 0 ? null : { index, strength };
    syncAllSliders();
    syncPresetUI();
    scheduleRender(fast);
    if (doCommit) commit();
  }

  function syncPresetUI() {
    const active = state.preset ? state.preset.index : (isDefaultAdj() ? 0 : -1);
    $$('.preset').forEach((b, i) => b.classList.toggle('active', i === active));
    const strength = $('#presetStrength');
    const row = $('#presetStrengthRow');
    row.style.visibility = state.preset ? 'visible' : 'hidden';
    if (state.preset) {
      strength.value = state.preset.strength;
      $('#presetStrengthOut').textContent = state.preset.strength;
      paintTrack(strength);
    }
  }

  function isDefaultAdj() {
    return Object.keys(DEFAULTS).every(k => state.adj[k] === 0);
  }

  function renderThumbs() {
    if (!state.thumbSrc) return;
    const { width: w, height: h, data } = state.thumbSrc;
    PRESETS.forEach((p, i) => {
      const out = processPixels(data, w, h, presetAdj(i, 100));
      const c = presetCanvases[i];
      c.width = w;
      c.height = h;
      c.getContext('2d').putImageData(new ImageData(out, w, h), 0, 0);
    });
    state.thumbsDirty = false;
  }

  // =====================================================================
  //  Rendering
  // =====================================================================
  let renderQueued = false;
  let queuedFast = false;
  let refineTimer = 0;
  const lowCanvas = makeCanvas(1, 1);

  /**
   * fast = true: während des Schiebens. Ist die volle Vorschau zu langsam,
   * wird zuerst in halber Auflösung gerechnet und kurz danach scharf nachgezeichnet.
   */
  function scheduleRender(fast = false) {
    queuedFast = renderQueued ? queuedFast && fast : fast;
    clearTimeout(refineTimer);
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      const useLow = queuedFast && state.lastRenderMs > 45 && state.previewLow;
      render(useLow);
      if (useLow) refineTimer = setTimeout(() => render(false), 220);
    });
  }

  function render(low = false) {
    if (!state.previewSrc) return;
    clearTimeout(refineTimer);
    const src = low ? state.previewLow : state.previewSrc;
    const { width: w, height: h, data } = src;
    const t0 = performance.now();
    const pixels = state.showOriginal || isDefaultAdj() ? data : processPixels(data, w, h, state.adj);
    if (low) {
      lowCanvas.width = w;
      lowCanvas.height = h;
      lowCanvas.getContext('2d').putImageData(new ImageData(pixels, w, h), 0, 0);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(lowCanvas, 0, 0, canvas.width, canvas.height);
    } else {
      ctx.putImageData(new ImageData(pixels, w, h), 0, 0);
      state.lastRenderMs = performance.now() - t0;
    }
    drawHistogram(pixels);
  }

  function drawHistogram(px) {
    const bins = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    const step = px.length > 4_000_000 ? 16 : 8; // jedes 2./4. Pixel reicht
    for (let i = 0; i < px.length; i += step) {
      if (px[i + 3] === 0) continue;
      bins[0][px[i]]++; bins[1][px[i + 1]]++; bins[2][px[i + 2]]++;
    }
    let max = 1;
    for (const b of bins) for (let i = 2; i < 254; i++) if (b[i] > max) max = b[i];

    const hc = histCanvas.getContext('2d');
    const W = histCanvas.width, H = histCanvas.height;
    hc.clearRect(0, 0, W, H);
    hc.globalCompositeOperation = 'lighter';
    const colors = ['rgba(255,80,80,.55)', 'rgba(80,220,120,.55)', 'rgba(90,140,255,.6)'];
    bins.forEach((b, ci) => {
      hc.fillStyle = colors[ci];
      hc.beginPath();
      hc.moveTo(0, H);
      for (let i = 0; i < 256; i++) {
        const v = Math.min(1, b[i] / max);
        hc.lineTo((i / 255) * W, H - Math.sqrt(v) * (H - 4));
      }
      hc.lineTo(W, H);
      hc.closePath();
      hc.fill();
    });
    hc.globalCompositeOperation = 'source-over';
  }

  /** Muss aufgerufen werden, wenn sich state.base geändert hat. */
  function rebuildPreview() {
    const b = state.base;
    const [pw, ph] = fitSize(b.width, b.height, MAX_PREVIEW);
    const prev = pw === b.width && ph === b.height ? b : scaleCanvas(b, pw, ph);
    state.previewSrc = ctx2d(prev).getImageData(0, 0, pw, ph);
    const low = scaleCanvas(prev, Math.max(1, Math.round(pw / 2)), Math.max(1, Math.round(ph / 2)));
    state.previewLow = ctx2d(low).getImageData(0, 0, low.width, low.height);
    state.lastRenderMs = 0;
    canvas.width = pw;
    canvas.height = ph;

    // quadratisch zugeschnittene Miniatur für die Filtervorschau
    const s = Math.min(b.width, b.height);
    const sq = makeCanvas(s, s);
    sq.getContext('2d').drawImage(b, (b.width - s) / 2, (b.height - s) / 2, s, s, 0, 0, s, s);
    const t = s > THUMB_SIZE ? scaleCanvas(sq, THUMB_SIZE, THUMB_SIZE) : sq;
    state.thumbSrc = ctx2d(t).getImageData(0, 0, t.width, t.height);
    state.thumbsDirty = true;
    if (state.tab === 'filters') renderThumbs();

    updateSizeInfo();
    render();
    requestAnimationFrame(updateOverlays);
  }

  // =====================================================================
  //  Verlauf (Rückgängig / Wiederholen)
  // =====================================================================
  function snapshot() {
    return { base: state.base, adj: { ...state.adj }, preset: state.preset ? { ...state.preset } : null };
  }

  function sameEntry(a, b) {
    return a && b && a.base === b.base && Object.keys(DEFAULTS).every(k => a.adj[k] === b.adj[k]);
  }

  function commit() {
    if (!state.base) return;
    const snap = snapshot();
    if (sameEntry(snap, state.history[state.hIndex])) return;
    state.history = state.history.slice(0, state.hIndex + 1);
    state.history.push(snap);
    if (state.history.length > HISTORY_LIMIT) state.history.shift();
    state.hIndex = state.history.length - 1;
    updateButtons();
  }

  /** Retusche-Schritte verändern state.base direkt; im Verlauf liegen nur die betroffenen Ausschnitte. */
  function commitPatch(patch) {
    state.history = state.history.slice(0, state.hIndex + 1);
    state.history.push({ ...snapshot(), patch });
    if (state.history.length > HISTORY_LIMIT) state.history.shift();
    state.hIndex = state.history.length - 1;
    updateButtons();
  }

  function applyPatch(entry, forward) {
    const { x, y, before, after } = entry.patch;
    entry.base.getContext('2d').putImageData(forward ? after : before, x, y);
  }

  function restore(entry, pixelsChanged = false) {
    const baseChanged = entry.base !== state.base || pixelsChanged;
    state.base = entry.base;
    state.adj = { ...entry.adj };
    state.preset = entry.preset ? { ...entry.preset } : null;
    syncAllSliders();
    syncPresetUI();
    if (baseChanged) {
      if (!pixelsChanged) resetCropRect();
      rebuildPreview();
    } else {
      scheduleRender();
    }
    updateButtons();
  }

  function undo() {
    if (state.hIndex <= 0) return;
    const cur = state.history[state.hIndex];
    if (cur.patch) applyPatch(cur, false);
    state.hIndex--;
    restore(state.history[state.hIndex], !!cur.patch);
  }

  function redo() {
    if (state.hIndex >= state.history.length - 1) return;
    state.hIndex++;
    const next = state.history[state.hIndex];
    if (next.patch) applyPatch(next, true);
    restore(next, !!next.patch);
  }

  function updateButtons() {
    const has = !!state.base;
    $('#btnUndo').disabled = !has || state.hIndex <= 0;
    $('#btnRedo').disabled = !has || state.hIndex >= state.history.length - 1;
    $('#btnCompare').disabled = !has;
    $('#btnResetAll').disabled = !has;
    $('#btnExport').disabled = !has;
    document.body.classList.toggle('no-image', !has);
  }

  // =====================================================================
  //  Laden
  // =====================================================================
  async function decodeFile(file) {
    if ('createImageBitmap' in window) {
      try {
        return await createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch { /* Fallback unten */ }
    }
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
      img.src = url;
    });
  }

  async function loadFile(file) {
    if (!file) return;
    if (file.type && !file.type.startsWith('image/')) {
      toast('Diese Datei ist kein Bild.', true);
      return;
    }
    setBusy(true, 'Foto wird geladen …');
    await nextFrame();
    try {
      const img = await decodeFile(file);
      const name = (file.name || 'foto').replace(/\.[^.]+$/, '') || 'foto';
      setImage(img, img.width, img.height, name);
    } catch {
      toast('Das Bild konnte nicht geöffnet werden. Unterstützt werden z. B. JPEG, PNG, WebP und GIF.', true);
    } finally {
      setBusy(false);
    }
  }

  function setImage(source, w, h, name) {
    let tw = w, th = h, scaled = false;
    if (w * h > MAX_AREA) {
      const s = Math.sqrt(MAX_AREA / (w * h));
      tw = Math.floor(w * s);
      th = Math.floor(h * s);
      scaled = true;
    }
    const base = makeCanvas(tw, th);
    const bg = base.getContext('2d');
    bg.imageSmoothingQuality = 'high';
    bg.drawImage(source, 0, 0, tw, th);
    if (source.close) source.close();

    state.original = base;
    state.base = cloneCanvas(base);
    state.adj = { ...DEFAULTS };
    state.preset = null;
    state.fileName = name;
    state.history = [];
    state.hIndex = -1;

    $('#emptyState').hidden = true;
    canvas.hidden = false;
    syncAllSliders();
    syncPresetUI();
    resetCropRect();
    rebuildPreview();
    commit();
    updateButtons();
    if (scaled) toast(`Großes Bild wurde auf ${tw} × ${th} px verkleinert.`);
  }

  /** Erzeugt ein Beispielfoto (Sonnenuntergang am See), damit man ohne eigenes Bild loslegen kann. */
  function makeSample() {
    const W = 1800, H = 1200;
    const c = makeCanvas(W, H);
    const g = c.getContext('2d');
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const horizon = H * 0.64;

    const sky = g.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, '#1b2a55');
    sky.addColorStop(0.45, '#6b4a7a');
    sky.addColorStop(0.75, '#e2725b');
    sky.addColorStop(1, '#f7c46c');
    g.fillStyle = sky;
    g.fillRect(0, 0, W, horizon);

    // Sonne
    const sx = W * 0.66, sy = horizon - 70;
    const glow = g.createRadialGradient(sx, sy, 10, sx, sy, 420);
    glow.addColorStop(0, 'rgba(255,236,180,0.95)');
    glow.addColorStop(0.15, 'rgba(255,200,120,0.6)');
    glow.addColorStop(1, 'rgba(255,160,90,0)');
    g.fillStyle = glow;
    g.fillRect(0, 0, W, horizon);
    g.fillStyle = '#fff3d1';
    g.beginPath();
    g.arc(sx, sy, 62, 0, Math.PI * 2);
    g.fill();

    // Wolkenbänder
    g.globalAlpha = 0.35;
    for (let i = 0; i < 9; i++) {
      const y = 120 + rnd() * horizon * 0.55;
      const x = rnd() * W;
      const cw = 300 + rnd() * 500;
      const grad = g.createLinearGradient(x - cw, 0, x + cw, 0);
      grad.addColorStop(0, 'rgba(255,190,170,0)');
      grad.addColorStop(0.5, i % 2 ? 'rgba(255,190,170,1)' : 'rgba(120,80,130,1)');
      grad.addColorStop(1, 'rgba(255,190,170,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.ellipse(x, y, cw, 10 + rnd() * 16, 0, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;

    // Bergketten
    const ridge = (baseY, amp, color, rough) => {
      g.fillStyle = color;
      g.beginPath();
      g.moveTo(0, horizon + 2);
      let y = baseY;
      for (let x = 0; x <= W; x += 12) {
        y += (rnd() - 0.5) * rough;
        y = clamp(y, baseY - amp, baseY + amp * 0.3);
        g.lineTo(x, y);
      }
      g.lineTo(W, horizon + 2);
      g.closePath();
      g.fill();
    };
    ridge(horizon - 190, 120, '#6d4766', 34);
    ridge(horizon - 110, 90, '#47304e', 30);
    ridge(horizon - 50, 50, '#2a1f35', 22);

    // See mit Spiegelung
    g.fillStyle = '#1a1428';
    g.fillRect(0, horizon, W, H - horizon);
    g.save();
    g.translate(0, horizon * 2);
    g.scale(1, -1);
    g.globalAlpha = 0.55;
    g.drawImage(c, 0, 0, W, horizon, 0, 0, W, horizon);
    g.restore();
    g.globalAlpha = 1;
    const water = g.createLinearGradient(0, horizon, 0, H);
    water.addColorStop(0, 'rgba(40,30,60,0.35)');
    water.addColorStop(1, 'rgba(10,8,20,0.9)');
    g.fillStyle = water;
    g.fillRect(0, horizon, W, H - horizon);
    for (let i = 0; i < 260; i++) {
      const y = horizon + 4 + Math.pow(rnd(), 1.6) * (H - horizon);
      const spread = 40 + (y - horizon) * 0.5;
      const x = sx + (rnd() - 0.5) * spread * 2;
      g.fillStyle = `rgba(255,${200 + rnd() * 40 | 0},140,${0.15 + rnd() * 0.45})`;
      g.fillRect(x, y, 10 + rnd() * 60, 1.5 + rnd() * 2);
    }

    // Ufer mit Tannen
    g.fillStyle = '#0c0a12';
    g.beginPath();
    g.moveTo(0, H);
    g.lineTo(0, H - 150);
    g.quadraticCurveTo(W * 0.18, H - 190, W * 0.38, H - 110);
    g.quadraticCurveTo(W * 0.5, H - 70, W * 0.55, H);
    g.closePath();
    g.fill();
    for (let i = 0; i < 26; i++) {
      const x = rnd() * W * 0.42;
      const t = H - 150 + (x / (W * 0.42)) * 50;
      const th = 90 + rnd() * 170;
      const tw = th * 0.32;
      g.beginPath();
      g.moveTo(x, t - th);
      g.lineTo(x + tw / 2, t + 10);
      g.lineTo(x - tw / 2, t + 10);
      g.closePath();
      g.fill();
    }

    // leichtes Rauschen für einen fotografischen Look
    const id = g.getImageData(0, 0, W, H);
    for (let i = 0; i < id.data.length; i += 4) {
      const n = (rnd() - 0.5) * 8;
      id.data[i] += n; id.data[i + 1] += n; id.data[i + 2] += n;
    }
    g.putImageData(id, 0, 0);
    return c;
  }

  // =====================================================================
  //  Geometrie: Drehen, Spiegeln, Zuschneiden, Größe
  // =====================================================================
  function replaceBase(next) {
    state.base = next;
    resetCropRect();
    rebuildPreview();
    commit();
  }

  function rotate(dir) {
    const b = state.base;
    const c = makeCanvas(b.height, b.width);
    const g = c.getContext('2d');
    g.translate(c.width / 2, c.height / 2);
    g.rotate((dir * Math.PI) / 2);
    g.drawImage(b, -b.width / 2, -b.height / 2);
    replaceBase(c);
  }

  function flip(horizontal) {
    const b = state.base;
    const c = makeCanvas(b.width, b.height);
    const g = c.getContext('2d');
    if (horizontal) { g.translate(b.width, 0); g.scale(-1, 1); }
    else { g.translate(0, b.height); g.scale(1, -1); }
    g.drawImage(b, 0, 0);
    replaceBase(c);
  }

  function applyCrop() {
    const b = state.base;
    const { x, y, w, h } = state.crop;
    const px = Math.round(x * b.width), py = Math.round(y * b.height);
    const pw = Math.max(1, Math.min(b.width - px, Math.round(w * b.width)));
    const ph = Math.max(1, Math.min(b.height - py, Math.round(h * b.height)));
    if (pw === b.width && ph === b.height) {
      toast('Ziehe zuerst an den Ecken, um einen Ausschnitt zu wählen.');
      return;
    }
    const c = makeCanvas(pw, ph);
    c.getContext('2d').drawImage(b, px, py, pw, ph, 0, 0, pw, ph);
    replaceBase(c);
    toast(`Zugeschnitten auf ${pw} × ${ph} px`);
  }

  async function applyResize() {
    const w = Math.round(Number($('#resizeW').value));
    const h = Math.round(Number($('#resizeH').value));
    const b = state.base;
    if (!(w >= 1 && h >= 1 && w <= 16384 && h <= 16384)) {
      toast('Bitte eine Größe zwischen 1 und 16384 px eingeben.', true);
      return;
    }
    if (w * h > MAX_AREA) {
      toast('Das Bild wäre zu groß (max. ca. 16 Megapixel).', true);
      return;
    }
    if (w === b.width && h === b.height) return;
    setBusy(true);
    await nextFrame();
    replaceBase(scaleCanvas(b, w, h));
    setBusy(false);
    toast(`Größe geändert auf ${w} × ${h} px`);
  }

  function updateSizeInfo() {
    const b = state.base;
    if (!b) return;
    const o = state.original;
    $('#resizeW').value = b.width;
    $('#resizeH').value = b.height;
    $('#sizeInfo').textContent = `Aktuell ${b.width} × ${b.height} px · Original ${o.width} × ${o.height} px`;
  }

  // ---------- Zuschneide-Rahmen ----------
  function resetCropRect() {
    setRatio(state.crop.ratioKey, false);
  }

  function setRatio(key, rerender = true) {
    const entry = RATIOS.find(r => r[0] === key) || RATIOS[0];
    state.crop.ratioKey = entry[0];
    const b = state.base;
    let ratio = entry[1];
    if (ratio === 'orig' && b) ratio = b.width / b.height;
    state.crop.ratio = ratio;
    if (!b || !ratio) {
      Object.assign(state.crop, { x: 0, y: 0, w: 1, h: 1 });
    } else {
      const imgRatio = b.width / b.height;
      let w = 1, h = 1;
      if (ratio > imgRatio) h = imgRatio / ratio; else w = ratio / imgRatio;
      Object.assign(state.crop, { x: (1 - w) / 2, y: (1 - h) / 2, w, h });
    }
    $$('.chip').forEach(c => c.classList.toggle('active', c.dataset.key === state.crop.ratioKey));
    if (rerender) updateOverlays();
  }

  function updateOverlays() {
    updateRetouchLayer();
    if (state.tab !== 'crop' || !state.base || canvas.hidden) {
      cropLayer.hidden = true;
      return;
    }
    const c = canvas.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    cropLayer.hidden = false;
    Object.assign(cropLayer.style, {
      left: `${c.left - s.left}px`, top: `${c.top - s.top}px`,
      width: `${c.width}px`, height: `${c.height}px`,
    });
    const { x, y, w, h } = state.crop;
    Object.assign(cropBox.style, {
      left: `${x * c.width}px`, top: `${y * c.height}px`,
      width: `${w * c.width}px`, height: `${h * c.height}px`,
    });
    $('#cropSize').textContent = `${Math.round(w * state.base.width)} × ${Math.round(h * state.base.height)}`;
  }

  function initCropInteraction() {
    let drag = null;
    const MIN = 24;

    cropBox.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      const L = cropLayer.getBoundingClientRect();
      const handle = e.target.dataset.h || 'move';
      drag = {
        handle,
        px: e.clientX, py: e.clientY,
        W: L.width, H: L.height,
        start: { x: state.crop.x * L.width, y: state.crop.y * L.height, w: state.crop.w * L.width, h: state.crop.h * L.height },
      };
      cropBox.setPointerCapture(e.pointerId);
    });

    cropBox.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = e.clientX - drag.px, dy = e.clientY - drag.py;
      const { W, H, start: s, handle } = drag;
      let r;
      if (handle === 'move') {
        r = { x: clamp(s.x + dx, 0, W - s.w), y: clamp(s.y + dy, 0, H - s.h), w: s.w, h: s.h };
      } else {
        const hx = handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0;
        const hy = handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0;
        // Ankerpunkt = gegenüberliegende Kante bzw. Mitte
        const ax = hx === 1 ? s.x : hx === -1 ? s.x + s.w : s.x + s.w / 2;
        const ay = hy === 1 ? s.y : hy === -1 ? s.y + s.h : s.y + s.h / 2;
        const ex = clamp((hx === 1 ? s.x + s.w : s.x) + dx, 0, W);
        const ey = clamp((hy === 1 ? s.y + s.h : s.y) + dy, 0, H);
        let w = hx ? Math.max(MIN, hx * (ex - ax)) : s.w;
        let h = hy ? Math.max(MIN, hy * (ey - ay)) : s.h;
        const maxW = hx === 1 ? W - ax : hx === -1 ? ax : 2 * Math.min(ax, W - ax);
        const maxH = hy === 1 ? H - ay : hy === -1 ? ay : 2 * Math.min(ay, H - ay);
        const ratio = state.crop.ratio;
        if (ratio) {
          if (hx && hy) w = Math.max(w, h * ratio);
          else if (hy) w = h * ratio;
          w = Math.min(w, maxW, maxH * ratio);
          h = w / ratio;
        } else {
          w = Math.min(w, maxW);
          h = Math.min(h, maxH);
        }
        r = {
          x: hx === 1 ? ax : hx === -1 ? ax - w : ax - w / 2,
          y: hy === 1 ? ay : hy === -1 ? ay - h : ay - h / 2,
          w, h,
        };
      }
      Object.assign(state.crop, { x: r.x / W, y: r.y / H, w: r.w / W, h: r.h / H });
      updateOverlays();
    });

    const end = () => { drag = null; };
    cropBox.addEventListener('pointerup', end);
    cropBox.addEventListener('pointercancel', end);
  }

  // =====================================================================
  //  Retusche: Fleckenentferner (Reparaturpinsel)
  // =====================================================================
  /**
   * Entfernt den übermalten Bereich:
   * 1. Um die Maske herum wird ein Kontextring gebildet.
   * 2. In der Umgebung wird die Stelle gesucht, deren Ring dem Zielring am ähnlichsten ist.
   * 3. Deren Struktur wird übernommen; der Farb-/Helligkeitsunterschied am Rand wird
   *    per Laplace-Interpolation (wie beim Poisson-Blending) glatt ins Innere verteilt.
   * Arbeitet direkt auf state.base und gibt einen Patch für den Verlauf zurück.
   */
  function healStroke(points, radius) {
    const b = state.base;
    const W = b.width, H = b.height;
    const R = Math.max(1.5, radius);
    const band = Math.max(3, Math.round(R * 0.6));
    const reach = R + band;

    // Pinselstempel entlang des Strichs
    const stamps = [];
    const spacing = Math.max(1, R / 4);
    points.forEach((p, i) => {
      if (i === 0) { stamps.push(p); return; }
      const q = points[i - 1];
      const steps = Math.ceil(Math.hypot(p.x - q.x, p.y - q.y) / spacing);
      for (let k = 1; k <= steps; k++) stamps.push({ x: q.x + (p.x - q.x) * k / steps, y: q.y + (p.y - q.y) * k / steps });
    });

    let mx0 = Infinity, my0 = Infinity, mx1 = -Infinity, my1 = -Infinity;
    for (const st of stamps) {
      mx0 = Math.min(mx0, st.x - R); my0 = Math.min(my0, st.y - R);
      mx1 = Math.max(mx1, st.x + R); my1 = Math.max(my1, st.y + R);
    }
    const pad = band + 2;
    const rx0 = clamp(Math.floor(mx0 - pad), 0, W), ry0 = clamp(Math.floor(my0 - pad), 0, H);
    const rx1 = clamp(Math.ceil(mx1 + pad), 0, W), ry1 = clamp(Math.ceil(my1 + pad), 0, H);
    const rw = rx1 - rx0, rh = ry1 - ry0;
    if (rw < 2 || rh < 2) return null;
    const n = rw * rh;

    // Abstandsfeld zur Pinselspur → Maske (innen) und Kontextring (außen)
    const dist = new Float32Array(n).fill(Infinity);
    for (const st of stamps) {
      const ya = Math.max(ry0, Math.floor(st.y - reach)), yb = Math.min(ry1 - 1, Math.ceil(st.y + reach));
      const xa = Math.max(rx0, Math.floor(st.x - reach)), xb = Math.min(rx1 - 1, Math.ceil(st.x + reach));
      for (let y = ya; y <= yb; y++) {
        const dy = y + 0.5 - st.y;
        for (let x = xa; x <= xb; x++) {
          const dx = x + 0.5 - st.x;
          const d = Math.sqrt(dx * dx + dy * dy);
          const i = (y - ry0) * rw + (x - rx0);
          if (d < dist[i]) dist[i] = d;
        }
      }
    }
    const inMask = new Uint8Array(n);
    const maskList = [], ringList = [];
    for (let i = 0; i < n; i++) {
      if (dist[i] <= R) { inMask[i] = 1; maskList.push(i); }
      else if (dist[i] <= reach) ringList.push(i);
    }
    if (!maskList.length) return null;

    // Randpixel (außerhalb, direkt neben der Maske) und Nachbarn für die Laplace-Iteration
    const isBound = new Uint8Array(n);
    const boundList = [];
    const nbs = new Int32Array(maskList.length * 4).fill(-1);
    maskList.forEach((i, k) => {
      const x = i % rw, y = (i / rw) | 0;
      const cand = [x > 0 ? i - 1 : -1, x < rw - 1 ? i + 1 : -1, y > 0 ? i - rw : -1, y < rh - 1 ? i + rw : -1];
      cand.forEach((j, c) => {
        if (j < 0) return;
        nbs[k * 4 + c] = j;
        if (!inMask[j] && !isBound[j]) { isBound[j] = 1; boundList.push(j); }
      });
    });

    // Suchbereich lesen
    const extW = mx1 - mx0 + band, extH = my1 - my0 + band;
    const S = Math.max(extW, extH);
    const maxOff = Math.ceil(S * 3.3) + 2;
    const ax0 = clamp(rx0 - maxOff, 0, W), ay0 = clamp(ry0 - maxOff, 0, H);
    const ax1 = clamp(rx1 + maxOff, 0, W), ay1 = clamp(ry1 + maxOff, 0, H);
    const aw = ax1 - ax0;
    const src = b.getContext('2d').getImageData(ax0, ay0, aw, ay1 - ay0).data;
    const at = i => (((ry0 + ((i / rw) | 0)) - ay0) * aw + (rx0 + (i % rw)) - ax0) * 4; // Region-Index → src-Index

    // Kontextring für den Vergleich ausdünnen
    const ringStep = Math.max(1, Math.floor(ringList.length / 700));
    const samples = [];
    for (let k = 0; k < ringList.length; k += ringStep) samples.push(at(ringList[k]));

    const score = (ox, oy) => {
      if (Math.abs(ox) < extW && Math.abs(oy) < extH) return Infinity;           // überlappt den Fleck
      if (rx0 + ox < ax0 || ry0 + oy < ay0 || rx1 + ox > ax1 || ry1 + oy > ay1) return Infinity;
      const off = (oy * aw + ox) * 4;
      let sum = 0, eT = 0, eS = 0;
      for (const t of samples) {
        const u = t + off;
        const dr = src[t] - src[u], dg = src[t + 1] - src[u + 1], db = src[t + 2] - src[u + 2];
        sum += dr * dr + dg * dg + db * db;
        // Strukturstärke (Gradient) von Ziel und Quelle
        eT += Math.abs(src[t + 1] - src[t + 5]) + Math.abs(src[t + 1] - src[t + 1 + aw * 4]);
        eS += Math.abs(src[u + 1] - src[u + 5]) + Math.abs(src[u + 1] - src[u + 1 + aw * 4]);
      }
      const k = samples.length;
      const texDiff = (eT - eS) / k;
      return sum / k + 10 * texDiff * texDiff; // glatte Quelle für strukturierte Umgebung bestrafen
    };

    let best = { s: Infinity, ox: 0, oy: 0 };
    if (samples.length) {
      [1.1, 1.6, 2.3, 3.2].forEach((f, ring) => {
        for (let a = 0; a < 16; a++) {
          const ang = (a / 16) * Math.PI * 2 + ring * 0.2;
          const ox = Math.round(Math.cos(ang) * S * f), oy = Math.round(Math.sin(ang) * S * f);
          const sc = score(ox, oy) * (1 + 0.06 * ring); // nähere Quellen leicht bevorzugen
          if (sc < best.s) best = { s: sc, ox, oy };
        }
      });
      // Feinsuche um den besten Kandidaten
      for (let step = Math.max(1, Math.round(S * 0.25)); isFinite(best.s); step = Math.floor(step / 2)) {
        const c = best;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const sc = score(c.ox + dx * step, c.oy + dy * step);
          if (sc < best.s) best = { s: sc, ox: c.ox + dx * step, oy: c.oy + dy * step };
        }
        if (step === 1) break;
      }
    }
    const hasSrc = isFinite(best.s);
    const off = hasSrc ? (best.oy * aw + best.ox) * 4 : 0;
    const srcVal = (si, c) => (hasSrc ? src[si + off + c] : 0);

    // Randdifferenz Ziel − Quelle, über eine kleine Umgebung gemittelt (ohne Maskenpixel),
    // damit feine kontrastreiche Strukturen am Rand nicht als Fleck ins Innere verlaufen
    const D = new Float32Array(n * 3);
    const win = Math.max(1, Math.min(3, Math.round(R / 6)));
    for (const j of boundList) {
      const jx = j % rw, jy = (j / rw) | 0;
      let cnt = 0, s0 = 0, s1 = 0, s2 = 0;
      for (let yy = Math.max(0, jy - win); yy <= Math.min(rh - 1, jy + win); yy++) {
        for (let xx = Math.max(0, jx - win); xx <= Math.min(rw - 1, jx + win); xx++) {
          const k = yy * rw + xx;
          if (inMask[k]) continue;
          const t = at(k);
          s0 += src[t] - srcVal(t, 0); s1 += src[t + 1] - srcVal(t, 1); s2 += src[t + 2] - srcVal(t, 2);
          cnt++;
        }
      }
      D[j * 3] = s0 / cnt; D[j * 3 + 1] = s1 / cnt; D[j * 3 + 2] = s2 / cnt;
    }

    // Startwert: inverse Distanzgewichtung der Randdifferenz (Shepard)
    const bStep = Math.max(1, Math.floor(boundList.length / 64));
    const bs = [];
    for (let k = 0; k < boundList.length; k += bStep) bs.push(boundList[k]);
    for (const i of maskList) {
      const x = i % rw, y = (i / rw) | 0;
      let ws = 0, s0 = 0, s1 = 0, s2 = 0;
      for (const j of bs) {
        const dx = (j % rw) - x, dy = ((j / rw) | 0) - y;
        const w = 1 / (dx * dx + dy * dy + 0.5);
        ws += w; s0 += w * D[j * 3]; s1 += w * D[j * 3 + 1]; s2 += w * D[j * 3 + 2];
      }
      D[i * 3] = s0 / ws; D[i * 3 + 1] = s1 / ws; D[i * 3 + 2] = s2 / ws;
    }

    // Laplace glätten (Gauß-Seidel)
    const iters = clamp(Math.round(Math.sqrt(maskList.length) * 1.5), 30, 160);
    for (let it = 0; it < iters; it++) {
      for (let k = 0; k < maskList.length; k++) {
        const i = maskList[k];
        let cnt = 0, s0 = 0, s1 = 0, s2 = 0;
        for (let c = 0; c < 4; c++) {
          const j = nbs[k * 4 + c];
          if (j < 0) continue;
          cnt++; s0 += D[j * 3]; s1 += D[j * 3 + 1]; s2 += D[j * 3 + 2];
        }
        if (cnt) { D[i * 3] = s0 / cnt; D[i * 3 + 1] = s1 / cnt; D[i * 3 + 2] = s2 / cnt; }
      }
    }

    // Ergebnis zusammensetzen, Kante 1,5 px weich auslaufen lassen
    const ctxB = b.getContext('2d');
    const before = ctxB.getImageData(rx0, ry0, rw, rh);
    const after = new ImageData(new Uint8ClampedArray(before.data), rw, rh);
    const out = after.data;
    for (const i of maskList) {
      const t = at(i), o = i * 4;
      const a = clamp((R - dist[i]) / 1.5, 0, 1);
      for (let c = 0; c < 3; c++) {
        const healed = srcVal(t, c) + D[i * 3 + c];
        out[o + c] = before.data[o + c] + (healed - before.data[o + c]) * a;
      }
    }
    ctxB.putImageData(after, rx0, ry0);
    return { x: rx0, y: ry0, before, after };
  }

  // ---------- Pinsel-Interaktion ----------
  const retouchLayer = $('#retouchLayer');
  const strokeCanvas = $('#strokeCanvas');
  const brushCursor = $('#brushCursor');

  function brushRadius() {
    return Number($('#brushSize').value) / 2;
  }

  function updateRetouchLayer() {
    if (state.tab !== 'retouch' || !state.base || canvas.hidden) {
      retouchLayer.hidden = true;
      return;
    }
    const c = canvas.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    retouchLayer.hidden = false;
    Object.assign(retouchLayer.style, {
      left: `${c.left - s.left}px`, top: `${c.top - s.top}px`,
      width: `${c.width}px`, height: `${c.height}px`,
    });
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(c.width * dpr), h = Math.round(c.height * dpr);
    if (strokeCanvas.width !== w || strokeCanvas.height !== h) {
      strokeCanvas.width = w;
      strokeCanvas.height = h;
    }
  }

  function initRetouch() {
    const size = $('#brushSize');
    const syncSize = () => {
      $('#brushSizeOut').textContent = size.value;
      paintTrack(size);
      const d = Number(size.value);
      brushCursor.style.width = brushCursor.style.height = `${d}px`;
    };
    size.addEventListener('input', syncSize);
    syncSize();

    let stroke = null;
    let busy = false;
    const local = e => {
      const r = retouchLayer.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top, W: r.width, H: r.height };
    };
    const moveCursor = p => {
      brushCursor.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)`;
    };
    const drawSegment = (a, b) => {
      const g = strokeCanvas.getContext('2d');
      const dpr = strokeCanvas.width / a.W;
      g.strokeStyle = g.fillStyle = '#ff8a4c';
      g.lineCap = g.lineJoin = 'round';
      g.lineWidth = brushRadius() * 2 * dpr;
      g.beginPath();
      g.moveTo(a.x * dpr, a.y * dpr);
      g.lineTo(b.x * dpr, b.y * dpr);
      g.stroke();
    };

    retouchLayer.addEventListener('pointerdown', e => {
      if (e.button !== 0 || busy) return;
      e.preventDefault();
      retouchLayer.setPointerCapture(e.pointerId);
      const p = local(e);
      stroke = [p];
      moveCursor(p);
      drawSegment(p, p);
    });

    retouchLayer.addEventListener('pointermove', e => {
      const p = local(e);
      brushCursor.hidden = false;
      moveCursor(p);
      if (!stroke) return;
      const last = stroke[stroke.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) < 1.5) return;
      stroke.push(p);
      drawSegment(last, p);
    });

    retouchLayer.addEventListener('pointerleave', () => { if (!stroke) brushCursor.hidden = true; });

    const finish = async () => {
      if (!stroke) return;
      const pts = stroke;
      stroke = null;
      busy = true;
      const b = state.base;
      const scale = b.width / pts[0].W;
      const basePts = pts.map(p => ({ x: clamp(p.x * scale, 0, b.width), y: clamp(p.y * scale, 0, b.height) }));
      const radius = brushRadius() * scale;
      const big = radius * radius * pts.length > 400_000;
      if (big) { setBusy(true, 'Fleck wird entfernt …'); await nextFrame(); }
      try {
        const patch = healStroke(basePts, radius);
        if (patch) {
          commitPatch(patch);
          rebuildPreview();
        }
      } finally {
        strokeCanvas.getContext('2d').clearRect(0, 0, strokeCanvas.width, strokeCanvas.height);
        if (big) setBusy(false);
        busy = false;
      }
    };
    retouchLayer.addEventListener('pointerup', finish);
    retouchLayer.addEventListener('pointercancel', () => {
      stroke = null;
      strokeCanvas.getContext('2d').clearRect(0, 0, strokeCanvas.width, strokeCanvas.height);
    });

    // [ und ] ändern die Pinselgröße
    window.addEventListener('keydown', e => {
      if (state.tab !== 'retouch' || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== 'range') return;
      if (e.key === '[' || e.key === ']') {
        size.value = Number(size.value) + (e.key === ']' ? 4 : -4);
        syncSize();
      }
    });
  }

  // =====================================================================
  //  Export
  // =====================================================================
  const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

  function openExport() {
    if (!state.base) return;
    $('#exportName').value = `${state.fileName}-bearbeitet`;
    syncExportForm();
    $('#exportDialog').showModal();
  }

  function syncExportForm() {
    const fmt = $('#exportFormat').value;
    const q = $('#exportQuality');
    $('#qualityField').hidden = fmt === 'image/png';
    $('#exportQualityOut').textContent = `${q.value} %`;
    paintTrack(q);
    $('#exportInfo').textContent = `${state.base.width} × ${state.base.height} px · .${EXT[fmt]}`;
  }

  async function doExport() {
    const fmt = $('#exportFormat').value;
    const quality = Number($('#exportQuality').value) / 100;
    const name = ($('#exportName').value.trim() || 'foto').replace(/[\\/:*?"<>|]+/g, '_');
    setBusy(true, 'Foto wird exportiert …');
    await nextFrame();
    try {
      const b = state.base;
      let out = b;
      if (!isDefaultAdj()) {
        const id = ctx2d(b).getImageData(0, 0, b.width, b.height);
        const px = processPixels(id.data, b.width, b.height, state.adj);
        out = makeCanvas(b.width, b.height);
        out.getContext('2d').putImageData(new ImageData(px, b.width, b.height), 0, 0);
      }
      if (fmt === 'image/jpeg') {
        // JPEG kennt keine Transparenz → auf Weiß legen
        const flat = makeCanvas(out.width, out.height);
        const fg = flat.getContext('2d');
        fg.fillStyle = '#fff';
        fg.fillRect(0, 0, flat.width, flat.height);
        fg.drawImage(out, 0, 0);
        out = flat;
      }
      const blob = await new Promise(res => out.toBlob(res, fmt, quality));
      if (!blob) throw new Error('toBlob');
      const actualExt = EXT[blob.type] || EXT[fmt];
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name}.${actualExt}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      const kb = blob.size / 1024;
      const size = kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`;
      toast(blob.type !== fmt
        ? `Dein Browser unterstützt dieses Format nicht – als PNG gespeichert (${size}).`
        : `Gespeichert: ${a.download} (${size})`);
    } catch {
      toast('Export fehlgeschlagen.', true);
    } finally {
      setBusy(false);
    }
  }

  // =====================================================================
  //  Tabs
  // =====================================================================
  function setTab(tab) {
    state.tab = tab;
    $$('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.tab === tab)));
    $$('.tab-panel').forEach(p => { p.hidden = p.dataset.panel !== tab; });
    if (tab === 'filters' && state.thumbsDirty) renderThumbs();
    updateOverlays();
  }

  // =====================================================================
  //  Vergleich (Vorher/Nachher)
  // =====================================================================
  function setCompare(on) {
    if (!state.base || state.showOriginal === on) return;
    state.showOriginal = on;
    $('#compareBadge').hidden = !on;
    $('#btnCompare').classList.toggle('active', on);
    render();
  }

  // =====================================================================
  //  Ereignisse
  // =====================================================================
  function bindEvents() {
    const open = () => fileInput.click();
    $('#btnOpen').addEventListener('click', open);
    $('#btnOpen2').addEventListener('click', open);
    fileInput.addEventListener('change', () => {
      loadFile(fileInput.files[0]);
      fileInput.value = '';
    });
    $('#btnSample').addEventListener('click', () => {
      const c = makeSample();
      setImage(c, c.width, c.height, 'beispiel');
    });

    $('#btnUndo').addEventListener('click', undo);
    $('#btnRedo').addEventListener('click', redo);
    $('#btnResetAll').addEventListener('click', () => {
      if (state.hIndex === 0 && isDefaultAdj()) return;
      state.base = cloneCanvas(state.original);
      state.adj = { ...DEFAULTS };
      state.preset = null;
      syncAllSliders();
      syncPresetUI();
      resetCropRect();
      rebuildPreview();
      commit();
      toast('Original wiederhergestellt – mit „Rückgängig“ zurückholen.');
    });
    $('#btnResetAdj').addEventListener('click', () => {
      if (isDefaultAdj()) return;
      state.adj = { ...DEFAULTS };
      state.preset = null;
      syncAllSliders();
      syncPresetUI();
      scheduleRender();
      commit();
    });

    const cmp = $('#btnCompare');
    cmp.addEventListener('pointerdown', e => { e.preventDefault(); cmp.setPointerCapture(e.pointerId); setCompare(true); });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(ev => cmp.addEventListener(ev, () => setCompare(false)));

    $('#btnExport').addEventListener('click', openExport);
    $('#exportFormat').addEventListener('change', syncExportForm);
    $('#exportQuality').addEventListener('input', syncExportForm);
    $('#exportDialog').addEventListener('close', () => {
      if ($('#exportDialog').returnValue === 'ok') doExport();
    });

    $$('.tab').forEach(t => t.addEventListener('click', () => setTab(t.dataset.tab)));

    // Seitenverhältnisse
    const ratios = $('#ratios');
    for (const [key] of RATIOS) {
      const b = document.createElement('button');
      b.className = 'chip';
      b.type = 'button';
      b.textContent = key;
      b.dataset.key = key;
      b.addEventListener('click', () => setRatio(key));
      ratios.appendChild(b);
    }
    $('#btnCropApply').addEventListener('click', applyCrop);
    $('#btnCropReset').addEventListener('click', () => setRatio('Frei'));
    $('#btnRotL').addEventListener('click', () => rotate(-1));
    $('#btnRotR').addEventListener('click', () => rotate(1));
    $('#btnFlipH').addEventListener('click', () => flip(true));
    $('#btnFlipV').addEventListener('click', () => flip(false));

    // Größe ändern
    const rw = $('#resizeW'), rh = $('#resizeH'), lock = $('#resizeLock');
    lock.addEventListener('click', () => {
      state.resizeLocked = !state.resizeLocked;
      lock.setAttribute('aria-pressed', String(state.resizeLocked));
    });
    rw.addEventListener('input', () => {
      if (state.resizeLocked && state.base && rw.value) rh.value = Math.max(1, Math.round(rw.value * state.base.height / state.base.width));
    });
    rh.addEventListener('input', () => {
      if (state.resizeLocked && state.base && rh.value) rw.value = Math.max(1, Math.round(rh.value * state.base.width / state.base.height));
    });
    $('#btnResize').addEventListener('click', applyResize);
    [rw, rh].forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') applyResize(); }));

    // Drag & Drop
    let dragDepth = 0;
    const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
    window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
    window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
    window.addEventListener('drop', e => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      document.body.classList.remove('dragging');
      loadFile(e.dataTransfer.files[0]);
    });

    // Einfügen aus der Zwischenablage
    window.addEventListener('paste', e => {
      const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
      if (item) {
        e.preventDefault();
        const f = item.getAsFile();
        loadFile(new File([f], 'eingefuegt.png', { type: f.type }));
      }
    });

    // Tastatur
    window.addEventListener('keydown', e => {
      const inField = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== 'range';
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === 'o') { e.preventDefault(); open(); return; }
      if (mod && key === 's') { e.preventDefault(); openExport(); return; }
      if (inField || $('#exportDialog').open) return;
      if (mod && key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
      else if (!mod && key === 'v' && !e.repeat) setCompare(true);
      else if (!mod && key === 'enter' && state.tab === 'crop' && state.base) applyCrop();
    });
    window.addEventListener('keyup', e => { if (e.key.toLowerCase() === 'v') setCompare(false); });
    window.addEventListener('blur', () => setCompare(false));

    new ResizeObserver(() => updateOverlays()).observe(stage);
  }

  // =====================================================================
  //  Start
  // =====================================================================
  buildSliders();
  buildPresets();
  syncAllSliders();
  syncPresetUI();
  bindEvents();
  initCropInteraction();
  initRetouch();
  updateButtons();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // für Tests/Debugging
  window.__fotolabor = { state, processPixels, loadFile };
})();
