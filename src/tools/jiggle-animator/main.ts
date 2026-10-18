// 揺れものアニメーターの画面
import { IT } from "@common/it";
import {
  TAU, simulate, prepRegion, weightAt, renderFrame,
  type Axis, type Mode, type Motion, type Region, type ScaleMode, type Source,
} from "./jiggle";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const $in = (id: string) => $<HTMLInputElement>(id);
const $sel = (id: string) => $<HTMLSelectElement>(id);
const $btn = (id: string) => $<HTMLButtonElement>(id);
const $cv = (id: string) => $<HTMLCanvasElement>(id);

type IntKey = "amp" | "cycles" | "frames" | "fps" | "pad" | "cols";
type Settings = Record<IntKey, number> & { motion: Motion; bodyMove: boolean; showWeight: boolean };

const SETTINGS_KEY = "jiggle-animator:settings";
const DEFAULTS: Settings = { motion: "hop", amp: 3, cycles: 1, bodyMove: true, frames: 8, fps: 10, pad: 4, cols: 0, showWeight: true };
// 保存値は壊れていても使えるよう、整数・範囲・選択肢を確かめてから取り込む（範囲は各スライダーと同じ）
const INT_RANGES: Record<IntKey, [number, number]> = { amp: [0, 64], cycles: [1, 4], frames: [2, 48], fps: [1, 30], pad: [0, 64], cols: [0, 48] };
const MOTIONS: readonly Motion[] = ["hop", "bounce", "sway", "land", "none"];
function loadSettings(): Settings {
  const raw = IT.store.get<unknown>(SETTINGS_KEY, {});
  const s = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const out = { ...DEFAULTS };
  for (const [k, [lo, hi]] of Object.entries(INT_RANGES) as [IntKey, [number, number]][]) {
    const v = s[k];
    if (Number.isInteger(v)) out[k] = Math.min(hi, Math.max(lo, v as number));
  }
  if (MOTIONS.includes(s.motion as Motion)) out.motion = s.motion as Motion;
  for (const k of ["bodyMove", "showWeight"] as const) { const v = s[k]; if (typeof v === "boolean") out[k] = v; }
  return out;
}
let S = loadSettings();
const saveSettings = () => IT.store.set(SETTINGS_KEY, S);

// 画像ごとの状態（保存しない）
let src: (Source & { canvas: HTMLCanvasElement }) | null = null;
let mode: Mode = "pixel";
let regions: Region[] = [];
let sel = -1;
let zoom = 1;
let frames: HTMLCanvasElement[] = [];
let frameW = 0, frameH = 0;

// ---------------------------------------------------------------- 領域
let regionSeq = 0;
function newRegion(p: Partial<Region> = {}): Region {
  regionSeq++;
  return Object.assign({
    name: "領域" + regionSeq, cx: 0, cy: 0, rx: 8, ry: 8, feather: 0.6,
    anchorOn: false, ax: 0, ay: 0,
    gain: 1, axis: "both" as Axis, freq: 2.5, damp: 0.15,
    scaleMode: "none" as ScaleMode, scaleAmt: 0.08, phase: 0, scaleSpring: true,
  }, p);
}

// ---------------------------------------------------------------- 再計算
let recomputeTimer = 0;
function scheduleRecompute(ms = 120) { clearTimeout(recomputeTimer); recomputeTimer = window.setTimeout(recompute, ms); }
let recomputeCount = 0; // テストが再計算の完了を待つのに使う
function recompute() {
  if (!src) return;
  const s = src;
  recomputeCount++;
  const t0 = performance.now();
  const pad = S.pad;
  frameW = s.w + pad * 2; frameH = s.h + pad * 2;
  const sim = simulate(regions, S, mode);
  frames = sim.list.map((fr) => {
    const c = document.createElement("canvas");
    c.width = frameW; c.height = frameH;
    c.getContext("2d")!.putImageData(renderFrame(s, regions, mode, fr, frameW, frameH, pad), 0, 0);
    return c;
  });
  buildSheet();
  const ms = Math.round(performance.now() - t0);
  const loop = S.motion !== "land";
  $("simInfo").textContent = frameW + "×" + frameH + " px × " + frames.length + " フレーム / " + S.fps + " fps / " +
    (loop ? "ループ(空回し " + sim.warm + " 回)" : "1回きり") + " / 計算 " + ms + " ms";
  setupPreviewCanvas();
  $btn("btnPng").disabled = $btn("btnJson").disabled = !frames.length;
}

// ---------------------------------------------------------------- スプライトシート
let sheetCols = 1, sheetRows = 1;
function buildSheet() {
  const N = frames.length;
  sheetCols = S.cols > 0 ? Math.min(S.cols, N) : N;
  sheetRows = Math.ceil(N / sheetCols);
  const c = $cv("sheet");
  c.width = sheetCols * frameW; c.height = sheetRows * frameH;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, c.width, c.height);
  frames.forEach((f, i) => g.drawImage(f, (i % sheetCols) * frameW, Math.floor(i / sheetCols) * frameH));
  const z = mode === "pixel" ? Math.max(1, Math.min(4, Math.floor(zoom / 2) || 1)) : Math.min(1, zoom);
  c.style.width = c.width * z + "px"; c.style.height = c.height * z + "px";
  c.classList.toggle("pixelated", mode === "pixel");
  const txt = c.width + "×" + c.height + " px(" + sheetCols + "列 × " + sheetRows + "行、1コマ " + frameW + "×" + frameH + ")";
  $("sheetSize").textContent = txt + " → " + sheetName() + ".png";
  $("sheetInfo").textContent = txt;
}
function baseName() { return (src ? src.name : "sprite").replace(/\.[^.]+$/, "") + "_jiggle"; }
// 出力ファイル名。末尾に _列x行 を付ける（Anim-Editor がファイル名から分割数を読む形式）
function sheetName() { return baseName() + "_" + sheetCols + "x" + sheetRows; }
function asepriteJson() {
  const dur = Math.round(1000 / Math.max(1, S.fps));
  const stem = baseName();
  return {
    frames: frames.map((_, i) => ({
      filename: stem + " " + i + ".png",
      frame: { x: (i % sheetCols) * frameW, y: Math.floor(i / sheetCols) * frameH, w: frameW, h: frameH },
      rotated: false, trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: frameW, h: frameH },
      sourceSize: { w: frameW, h: frameH }, duration: dur,
    })),
    meta: {
      app: "https://www.aseprite.org/", version: "1.3",
      image: sheetName() + ".png", format: "RGBA8888",
      size: { w: sheetCols * frameW, h: sheetRows * frameH }, scale: "1",
      frameTags: [{ name: "jiggle", from: 0, to: Math.max(0, frames.length - 1), direction: "forward", color: "#000000ff" }],
      layers: [], slices: [],
    },
  };
}

// ---------------------------------------------------------------- プレビュー再生
let playing = true, playStart = performance.now(), pausedFrame = 0, lastDrawn = -1;
function setupPreviewCanvas() {
  const c = $cv("preview");
  c.width = Math.max(1, Math.round(frameW * zoom)); c.height = Math.max(1, Math.round(frameH * zoom));
  lastDrawn = -1;
}
function currentFrameIndex() {
  if (!frames.length) return 0;
  if (!playing) return pausedFrame % frames.length;
  return Math.floor((performance.now() - playStart) / 1000 * S.fps) % frames.length;
}
function tick() {
  if (frames.length) {
    const i = currentFrameIndex();
    if (i !== lastDrawn) {
      const c = $cv("preview"), g = c.getContext("2d")!;
      g.imageSmoothingEnabled = mode !== "pixel";
      g.clearRect(0, 0, c.width, c.height);
      g.drawImage(frames[i], 0, 0, c.width, c.height);
      $("frameNo").textContent = (i + 1) + " / " + frames.length;
      lastDrawn = i;
    }
  }
  requestAnimationFrame(tick);
}
$("btnPlay").addEventListener("click", () => {
  if (playing) { pausedFrame = currentFrameIndex(); playing = false; }
  else { playing = true; playStart = performance.now() - pausedFrame / S.fps * 1000; }
  $("btnPlay").textContent = playing ? "一時停止" : "再生";
  $("btnPlay").setAttribute("aria-pressed", String(playing));
  lastDrawn = -1;
});
function stepFrame(delta: number) {
  if (playing || !frames.length) return;
  pausedFrame = (pausedFrame + delta + frames.length) % frames.length; lastDrawn = -1;
}
// 停止中はクリックか左右キーでコマ送り
$("preview").addEventListener("click", () => stepFrame(1));
$("preview").addEventListener("keydown", (e) => {
  if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); stepFrame(e.key === "ArrowRight" ? 1 : -1); }
});

// ---------------------------------------------------------------- 編集キャンバス
const editor = $cv("editor");
let weightCanvas: HTMLCanvasElement | null = null;
function cssVar(name: string) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function zoomOptions() {
  return mode === "pixel" ? [1, 2, 3, 4, 6, 8, 12, 16] : [0.25, 0.5, 0.75, 1, 1.5, 2];
}
function autoZoom() {
  if (!src) return 1;
  const m = Math.max(src.w, src.h) + S.pad * 2;
  if (mode === "pixel") return Math.max(1, Math.min(16, Math.floor(380 / m)));
  const opts = zoomOptions().filter((z) => z * m <= 420);
  return opts.length ? opts[opts.length - 1] : 0.25;
}
function fillZoomSelect() {
  const s = $sel("zoom");
  s.innerHTML = "";
  for (const z of zoomOptions()) {
    const o = document.createElement("option");
    o.value = String(z); o.textContent = "×" + z;
    s.appendChild(o);
  }
  if (!zoomOptions().includes(zoom)) zoom = autoZoom();
  s.value = String(zoom);
}
$sel("zoom").addEventListener("change", () => { zoom = +$sel("zoom").value; setupEditor(); setupPreviewCanvas(); buildSheet(); });

function setupEditor() {
  if (!src) return;
  editor.width = Math.round(src.w * zoom); editor.height = Math.round(src.h * zoom);
  drawEditor();
}
function buildWeightCanvas() {
  if (!src) return;
  const c = document.createElement("canvas");
  c.width = src.w; c.height = src.h;
  const img = new ImageData(src.w, src.h), d = img.data;
  const Rs = regions.map((r) => prepRegion(r, null));
  const ac = cssVar("--accent") || "#0d7f86";
  const m = ac.match(/^#([0-9a-f]{6})$/i);
  const [cr, cg, cb] = m ? [0, 2, 4].map((k) => parseInt(m[1].slice(k, k + 2), 16)) : [13, 127, 134];
  for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) {
    let w = 0;
    for (const R of Rs) w += weightAt(R, x + 0.5, y + 0.5);
    if (w <= 0) continue;
    const o = (y * src.w + x) * 4;
    d[o] = cr; d[o + 1] = cg; d[o + 2] = cb; d[o + 3] = Math.min(1, w) * 90;
  }
  c.getContext("2d")!.putImageData(img, 0, 0);
  weightCanvas = c;
}
type HandleType = "center" | "rx" | "ry" | "anchor";
function handlesOf(r: Region) {
  const h: { type: HandleType; x: number; y: number }[] = [
    { type: "center", x: r.cx, y: r.cy },
    { type: "rx", x: r.cx + r.rx, y: r.cy },
    { type: "ry", x: r.cx, y: r.cy + r.ry },
  ];
  if (r.anchorOn) h.push({ type: "anchor", x: r.ax, y: r.ay });
  return h;
}
function drawEditor() {
  if (!src) return;
  const g = editor.getContext("2d")!, Z = zoom;
  g.clearRect(0, 0, editor.width, editor.height);
  g.imageSmoothingEnabled = mode !== "pixel";
  g.drawImage(src.canvas, 0, 0, editor.width, editor.height);
  if (S.showWeight && weightCanvas) {
    g.imageSmoothingEnabled = mode !== "pixel";
    g.drawImage(weightCanvas, 0, 0, editor.width, editor.height);
  }
  const accent = cssVar("--accent") || "#0d7f86", fg = cssVar("--fg") || "#1b2329", bg = cssVar("--panel") || "#fff";
  regions.forEach((r, i) => {
    const on = i === sel;
    g.save();
    g.lineWidth = on ? 2 : 1.25;
    g.strokeStyle = on ? accent : fg;
    g.globalAlpha = on ? 1 : 0.55;
    g.beginPath(); g.ellipse(r.cx * Z, r.cy * Z, r.rx * Z, r.ry * Z, 0, 0, TAU); g.stroke();
    // ぼかしの内側の境界
    const k = 1 - r.feather;
    if (k > 0.02) {
      g.setLineDash([4, 4]); g.lineWidth = 1;
      g.beginPath(); g.ellipse(r.cx * Z, r.cy * Z, r.rx * Z * k, r.ry * Z * k, 0, 0, TAU); g.stroke();
      g.setLineDash([]);
    }
    if (r.anchorOn) {
      g.setLineDash([2, 3]);
      g.beginPath(); g.moveTo(r.ax * Z, r.ay * Z); g.lineTo(r.cx * Z, r.cy * Z); g.stroke();
      g.setLineDash([]);
    }
    if (on) {
      for (const h of handlesOf(r)) {
        const x = h.x * Z, y = h.y * Z, s = 5;
        g.fillStyle = h.type === "center" ? accent : bg;
        g.strokeStyle = accent; g.lineWidth = 2;
        g.beginPath();
        if (h.type === "center") g.arc(x, y, s, 0, TAU);
        else if (h.type === "anchor") { g.moveTo(x, y - s - 1); g.lineTo(x + s + 1, y); g.lineTo(x, y + s + 1); g.lineTo(x - s - 1, y); g.closePath(); }
        else g.rect(x - s, y - s, s * 2, s * 2);
        g.fill(); g.stroke();
      }
    }
    // 名前ラベル
    g.globalAlpha = on ? 1 : 0.7;
    g.font = "600 11px " + (cssVar("--font-body") || "sans-serif");
    const label = r.name, tw = g.measureText(label).width;
    const lx = Math.max(2, Math.min(editor.width - tw - 8, r.cx * Z - tw / 2 - 3));
    const ly = Math.max(2, r.cy * Z - r.ry * Z - 18);
    g.fillStyle = on ? accent : fg; g.fillRect(lx, ly, tw + 6, 15);
    g.fillStyle = on ? (cssVar("--accent-fg") || "#fff") : bg;
    g.fillText(label, lx + 3, ly + 11);
    g.restore();
  });
}

// ドラッグ操作
type Pos = { cx: number; cy: number; x: number; y: number; tol: number };
let drag: { type: HandleType | "move"; start: Pos; orig: Region } | null = null;
function eventPos(e: PointerEvent): Pos {
  const rect = editor.getBoundingClientRect();
  const sx = editor.width / rect.width, sy = editor.height / rect.height;
  const cx = (e.clientX - rect.left) * sx, cy = (e.clientY - rect.top) * sy;
  return { cx, cy, x: cx / zoom, y: cy / zoom, tol: 9 * sx };
}
function hitTest(p: Pos): { i: number; type: HandleType | "move" } | null {
  const order = sel >= 0 ? [sel, ...regions.map((_, i) => i).filter((i) => i !== sel)] : regions.map((_, i) => i);
  if (sel >= 0) {
    // 小さい領域ではハンドル同士が重なるので、いちばん近いハンドルを選ぶ
    let best: { type: HandleType } | null = null, bestD = p.tol;
    for (const h of handlesOf(regions[sel])) {
      const d = Math.hypot(h.x * zoom - p.cx, h.y * zoom - p.cy);
      if (d <= bestD) { best = h; bestD = d; }
    }
    if (best) return { i: sel, type: best.type };
  }
  for (const i of order) {
    const r = regions[i], nx = (p.x - r.cx) / r.rx, ny = (p.y - r.cy) / r.ry;
    if (nx * nx + ny * ny <= 1) return { i, type: "move" };
  }
  return null;
}
const snap = (v: number) => Math.round(v * 2) / 2;
editor.addEventListener("pointerdown", (e) => {
  if (!src) return;
  const p = eventPos(e), h = hitTest(p);
  if (!h) return;
  if (h.i !== sel) { sel = h.i; renderRegionUI(); }
  const r = regions[h.i];
  drag = { type: h.type, start: p, orig: { ...r } };
  editor.setPointerCapture(e.pointerId);
  drawEditor();
  e.preventDefault();
});
editor.addEventListener("pointermove", (e) => {
  if (!src) return;
  const p = eventPos(e);
  if (!drag) {
    const h = hitTest(p);
    editor.style.cursor = !h ? "default" : h.type === "rx" ? "ew-resize" : h.type === "ry" ? "ns-resize" : h.type === "anchor" ? "crosshair" : "move";
    return;
  }
  const r = regions[sel], o = drag.orig, dx = p.x - drag.start.x, dy = p.y - drag.start.y;
  if (drag.type === "center" || drag.type === "move") {
    r.cx = snap(o.cx + dx); r.cy = snap(o.cy + dy);
    r.ax = snap(o.ax + dx); r.ay = snap(o.ay + dy);
  } else if (drag.type === "rx") r.rx = Math.max(1, snap(o.rx + dx));
  else if (drag.type === "ry") r.ry = Math.max(1, snap(o.ry + dy));
  else if (drag.type === "anchor") { r.ax = snap(p.x); r.ay = snap(p.y); }
  syncRegionNums();
  buildWeightCanvas();
  drawEditor();
  scheduleRecompute(160);
});
const endDrag = () => { if (drag) { drag = null; scheduleRecompute(0); } };
editor.addEventListener("pointerup", endDrag);
editor.addEventListener("pointercancel", endDrag);

// ---------------------------------------------------------------- 領域 UI
type RangeKey = "feather" | "gain" | "freq" | "damp" | "scaleAmt" | "phase";
const R_RANGES: Record<string, RangeKey> = { rFeather: "feather", rGain: "gain", rFreq: "freq", rDamp: "damp", rScaleAmt: "scaleAmt", rPhase: "phase" };
const R_FMT: Record<RangeKey, (v: number) => string> = {
  feather: (v) => Math.round(v * 100) + "%", gain: (v) => "×" + (+v).toFixed(1), freq: (v) => (+v).toFixed(1) + "回",
  damp: (v) => (+v).toFixed(2), scaleAmt: (v) => Math.round(v * 100) + "%", phase: (v) => v + "°",
};
function syncRegionNums() {
  const r = regions[sel];
  if (!r) return;
  $in("rCx").value = String(r.cx); $in("rCy").value = String(r.cy); $in("rRx").value = String(r.rx); $in("rRy").value = String(r.ry);
  $in("rAx").value = String(r.ax); $in("rAy").value = String(r.ay);
  $in("rAx").disabled = $in("rAy").disabled = !r.anchorOn;
}
function renderRegionUI() {
  const list = $("regionList");
  list.innerHTML = "";
  regions.forEach((r, i) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "btn btn-sm"; b.textContent = r.name;
    b.setAttribute("aria-pressed", String(i === sel));
    b.addEventListener("click", () => { sel = i; renderRegionUI(); drawEditor(); });
    list.appendChild(b);
  });
  const r = regions[sel];
  $("regionEmpty").hidden = !!r;
  $("regionParams").hidden = !r;
  if (!r) return;
  $in("rName").value = r.name;
  syncRegionNums();
  for (const [id, k] of Object.entries(R_RANGES)) { $in(id).value = String(r[k]); $(id + "Out").textContent = R_FMT[k](r[k]); }
  $sel("rAxis").value = r.axis;
  $sel("rScaleMode").value = r.scaleMode;
  $in("rAnchorOn").checked = r.anchorOn;
  $in("rScaleSpring").checked = r.scaleSpring;
}
function onRegionEdit(redrawList = false) {
  buildWeightCanvas(); drawEditor(); scheduleRecompute();
  if (redrawList) renderRegionUI();
}
for (const [id, k] of Object.entries(R_RANGES)) {
  $in(id).addEventListener("input", () => {
    const r = regions[sel]; if (!r) return;
    r[k] = +$in(id).value; $(id + "Out").textContent = R_FMT[k](r[k]);
    onRegionEdit();
  });
}
for (const [id, k] of [["rCx", "cx"], ["rCy", "cy"], ["rRx", "rx"], ["rRy", "ry"], ["rAx", "ax"], ["rAy", "ay"]] as const) {
  $in(id).addEventListener("change", () => {
    const r = regions[sel]; if (!r) return;
    let v = +$in(id).value;
    if (!isFinite(v)) { syncRegionNums(); return; }
    if (k === "rx" || k === "ry") v = Math.max(1, v);
    if (k === "cx") { r.ax += v - r.cx; } if (k === "cy") { r.ay += v - r.cy; }
    r[k] = v; syncRegionNums(); onRegionEdit();
  });
}
$in("rName").addEventListener("input", () => {
  const r = regions[sel]; if (!r) return;
  r.name = $in("rName").value || "領域";
  drawEditor();
  const b = $("regionList").children[sel]; if (b) b.textContent = r.name;
});
$sel("rAxis").addEventListener("change", () => { const r = regions[sel]; if (r) { r.axis = $sel("rAxis").value as Axis; onRegionEdit(); } });
$sel("rScaleMode").addEventListener("change", () => { const r = regions[sel]; if (r) { r.scaleMode = $sel("rScaleMode").value as ScaleMode; onRegionEdit(); } });
$in("rScaleSpring").addEventListener("change", () => { const r = regions[sel]; if (r) { r.scaleSpring = $in("rScaleSpring").checked; onRegionEdit(); } });
$in("rAnchorOn").addEventListener("change", () => {
  const r = regions[sel]; if (!r) return;
  r.anchorOn = $in("rAnchorOn").checked;
  if (r.anchorOn && Math.hypot(r.ax - r.cx, r.ay - r.cy) < 1) { r.ax = r.cx; r.ay = snap(r.cy - r.ry); }
  syncRegionNums(); onRegionEdit();
});
$("btnDel").addEventListener("click", () => {
  if (sel < 0) return;
  const name = regions[sel].name;
  regions.splice(sel, 1);
  sel = Math.min(sel, regions.length - 1);
  renderRegionUI(); onRegionEdit();
  IT.toast(name + " を削除しました");
});
$("btnAdd").addEventListener("click", () => {
  if (!src) return;
  const rr = Math.max(2, Math.round(Math.min(src.w, src.h) / 5));
  const r = newRegion({ cx: snap(src.w / 2), cy: snap(src.h / 2), rx: rr, ry: rr, ax: snap(src.w / 2), ay: snap(src.h / 2 - rr) });
  regions.push(r); sel = regions.length - 1;
  renderRegionUI(); onRegionEdit();
});

// ---------------------------------------------------------------- 全体設定 UI
const G_RANGES: readonly IntKey[] = ["amp", "cycles", "frames", "fps", "pad", "cols"];
const G_FMT: Record<IntKey, (v: number) => string> = {
  amp: (v) => v + "px", cycles: (v) => v + "回", frames: (v) => v + "枚", fps: (v) => v + "fps", pad: (v) => v + "px",
  cols: (v) => (+v === 0 ? "1行" : v + "列"),
};
function applySettingsToUI() {
  for (const k of G_RANGES) { $in(k).value = String(S[k]); $(k + "Out").textContent = G_FMT[k](S[k]); }
  $sel("motion").value = S.motion;
  $in("bodyMove").checked = S.bodyMove;
  $in("showWeight").checked = S.showWeight;
  $in("cycles").disabled = S.motion === "land"; // 「動かない」では拡縮の回数として使う
}
for (const k of G_RANGES) {
  $in(k).addEventListener("input", () => {
    S[k] = +$in(k).value; $(k + "Out").textContent = G_FMT[k](S[k]); saveSettings();
    if (k === "cols") { buildSheet(); return; }
    if (k === "fps") { playStart = performance.now(); }
    if (k === "pad") { setupEditor(); }
    scheduleRecompute();
  });
}
$sel("motion").addEventListener("change", () => { S.motion = $sel("motion").value as Motion; applySettingsToUI(); saveSettings(); scheduleRecompute(0); });
$in("bodyMove").addEventListener("change", () => { S.bodyMove = $in("bodyMove").checked; saveSettings(); scheduleRecompute(0); });
$in("showWeight").addEventListener("change", () => { S.showWeight = $in("showWeight").checked; saveSettings(); drawEditor(); });

function setMode(m: Mode, quiet?: boolean) {
  mode = m;
  $("modePixel").setAttribute("aria-pressed", String(m === "pixel"));
  $("modeSmooth").setAttribute("aria-pressed", String(m === "smooth"));
  $("modeHint").textContent = m === "pixel"
    ? "最近傍で取り、揺れ幅を整数ピクセルに丸めます。新しい色は増えません。"
    : "バイリニア補間でなめらかに変形します。揺れ幅も小数のまま使います。";
  editor.classList.toggle("pixelated", m === "pixel");
  $("preview").classList.toggle("pixelated", m === "pixel");
  zoom = autoZoom();
  fillZoomSelect();
  setupEditor();
  if (!quiet) scheduleRecompute(0);
}
$("modePixel").addEventListener("click", () => setMode("pixel"));
$("modeSmooth").addEventListener("click", () => setMode("smooth"));

// ---------------------------------------------------------------- 入力
function setSource(name: string, canvas: HTMLCanvasElement, presetRegions: Region[] | null, presetMode: Mode | null) {
  const g = canvas.getContext("2d")!;
  src = { name, w: canvas.width, h: canvas.height, data: g.getImageData(0, 0, canvas.width, canvas.height).data, canvas };
  regions = presetRegions || [];
  sel = regions.length ? 0 : -1;
  $("srcNote").textContent = name + "(" + src.w + "×" + src.h + ")";
  $btn("btnAdd").disabled = false;
  setMode(presetMode || (Math.max(src.w, src.h) <= 256 ? "pixel" : "smooth"), true);
  buildWeightCanvas();
  renderRegionUI();
  drawEditor();
  recompute();
}
async function loadFile(file: File) {
  try {
    const bmp = await createImageBitmap(file);
    if (bmp.width * bmp.height > 2048 * 2048) { bmp.close(); IT.toast("画像が大きすぎます(2048×2048 まで)"); return; }
    const c = document.createElement("canvas");
    c.width = bmp.width; c.height = bmp.height;
    c.getContext("2d")!.drawImage(bmp, 0, 0);
    bmp.close();
    regionSeq = 0;
    setSource(file.name, c, null, null);
    $("sampleButtons").hidden = true; // 作業中の画像を誤って差し替えないよう、読み込み後はサンプルを出さない
    IT.toast("「領域を追加」で揺らす範囲を置いてください");
  } catch {
    IT.toast(file.name + " を読み込めませんでした");
  }
}
IT.initDrop({
  zone: "drop", input: "fileInput",
  accept: (f) => f.type.startsWith("image/"),
  onFiles: (files) => loadFile(files[0]),
  emptyMessage: "画像ファイルが見つかりませんでした",
});

// ---------------------------------------------------------------- サンプル（自作の汎用図形）
function samplePixel() {
  const W = 48, H = 52, c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d")!, img = g.createImageData(W, H), d = img.data;
  const hex = (h: string) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
  const set = (x: number, y: number, col: string) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const o = (y * W + x) * 4, [r, gg, b] = hex(col); d[o] = r; d[o + 1] = gg; d[o + 2] = b; d[o + 3] = 255; };
  const inEll = (x: number, y: number, cx: number, cy: number, rx: number, ry: number) => ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1;
  type Fn = (x: number, y: number) => boolean;
  const mask = (fn: Fn) => { const m: [number, number][] = []; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (fn(x, y)) m.push([x, y]); return m; };
  const drawShape = (fn: Fn, fill: string, line: string, shade: ((x: number, y: number) => string | null) | null) => {
    const m = mask(fn), has = (x: number, y: number) => fn(x, y) && x >= 0 && y >= 0 && x < W && y < H;
    for (const [x, y] of m) {
      const edge = !has(x - 1, y) || !has(x + 1, y) || !has(x, y - 1) || !has(x, y + 1);
      set(x, y, edge ? line : (shade && shade(x, y)) || fill);
    }
  };
  // 芽（茎と2枚の葉）
  for (let y = 12; y <= 22; y++) { set(23, y, "#2f5a1a"); set(24, y, "#4a8a2c"); set(25, y, "#2f5a1a"); }
  drawShape((x, y) => inEll(x, y, 29.5, 11.5, 5, 2.8), "#7cc444", "#2f5a1a", (x, y) => (y <= 10 && x <= 30 ? "#a8e070" : null));
  drawShape((x, y) => inEll(x, y, 18.5, 14, 4.2, 2.4), "#6ab238", "#2f5a1a", null);
  // 本体（スライム）
  drawShape((x, y) => inEll(x, y, 24, 36, 17, 14) && y <= 46, "#3fb8a6", "#1d4b55", (x, y) => {
    if (inEll(x, y, 17.5, 29, 4.5, 2.6)) return "#c9f4e8";
    if (inEll(x, y, 19, 31, 7, 4.5)) return "#7ad8c4";
    if (y >= 42) return "#2a8a82";
    return null;
  });
  // 目と口
  for (const ex of [18, 28]) for (let y = 34; y <= 36; y++) { set(ex, y, "#0f2a30"); set(ex + 1, y, "#0f2a30"); }
  set(19, 34, "#ffffff"); set(29, 34, "#ffffff");
  for (let x = 22; x <= 25; x++) set(x, 39, "#1d4b55");
  g.putImageData(img, 0, 0);
  regionSeq = 2;
  return {
    canvas: c,
    regions: [
      newRegion({ name: "本体", cx: 24, cy: 34, rx: 21, ry: 18, feather: 0.75, anchorOn: true, ax: 24, ay: 49, gain: 1.2, axis: "y", freq: 2, damp: 0.18, scaleMode: "pulse", scaleAmt: 0.06, phase: 90, scaleSpring: true }),
      newRegion({ name: "芽", cx: 24, cy: 12, rx: 11, ry: 9, feather: 0.6, anchorOn: true, ax: 24, ay: 22, gain: 1.6, axis: "both", freq: 1.6, damp: 0.1, scaleMode: "none" }),
    ],
  };
}
function sampleSmooth() {
  const W = 240, H = 240, c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d")!;
  // 皿
  g.fillStyle = "#e8e3dc"; g.beginPath(); g.ellipse(120, 206, 100, 18, 0, 0, TAU); g.fill();
  g.fillStyle = "#cfc8bf"; g.beginPath(); g.ellipse(120, 204, 84, 12, 0, 0, TAU); g.fill();
  // ゼリー
  const grad = g.createLinearGradient(0, 70, 0, 205);
  grad.addColorStop(0, "#ffb3c7"); grad.addColorStop(1, "#e2557f");
  g.fillStyle = grad;
  g.beginPath();
  g.moveTo(52, 202); g.bezierCurveTo(50, 150, 62, 86, 120, 82); g.bezierCurveTo(178, 86, 190, 150, 188, 202);
  g.quadraticCurveTo(120, 214, 52, 202); g.fill();
  g.fillStyle = "rgba(255,255,255,.55)";
  g.beginPath(); g.ellipse(90, 118, 10, 26, -0.35, 0, TAU); g.fill();
  // さくらんぼ
  g.strokeStyle = "#5d7d2a"; g.lineWidth = 4; g.lineCap = "round";
  g.beginPath(); g.moveTo(120, 72); g.quadraticCurveTo(126, 40, 146, 24); g.stroke();
  const cg = g.createRadialGradient(112, 62, 3, 120, 70, 18);
  cg.addColorStop(0, "#ff8a8a"); cg.addColorStop(1, "#b0122e");
  g.fillStyle = cg; g.beginPath(); g.arc(120, 72, 16, 0, TAU); g.fill();
  regionSeq = 2;
  return {
    canvas: c,
    regions: [
      newRegion({ name: "ゼリー", cx: 120, cy: 140, rx: 82, ry: 76, feather: 0.8, anchorOn: true, ax: 120, ay: 206, gain: 1.4, axis: "both", freq: 2, damp: 0.12, scaleMode: "pulse", scaleAmt: 0.05, phase: 90 }),
      newRegion({ name: "さくらんぼ", cx: 122, cy: 52, rx: 40, ry: 44, feather: 0.7, anchorOn: true, ax: 120, ay: 96, gain: 1.5, axis: "both", freq: 1.5, damp: 0.08, scaleMode: "none" }),
    ],
  };
}
// サンプルはファイルを読まずにその場で描く
$("btnSample").addEventListener("click", () => {
  if ($sel("sampleKind").value === "smooth") {
    const s = sampleSmooth();
    // 大きい絵向けに振れ幅と余白を広げる。画面には出すが保存はしない（ほかの設定を変えたときに一緒に保存される）
    if (S.amp < 8) { S.amp = 10; S.pad = Math.max(S.pad, 12); applySettingsToUI(); IT.toast("サンプルに合わせて振れ幅と余白を広げました"); }
    setSource("sample_jelly.png", s.canvas, s.regions, "smooth");
  } else {
    const s = samplePixel();
    setSource("sample_slime.png", s.canvas, s.regions, "pixel");
  }
});

// ---------------------------------------------------------------- 出力・リセット
$("btnPng").addEventListener("click", async () => {
  if (!frames.length) return;
  try { await IT.saveFile(sheetName() + ".png", await IT.canvasToBlob($cv("sheet"))); }
  catch { IT.toast("PNGを作成できませんでした"); }
});
$("btnJson").addEventListener("click", () => {
  if (!frames.length) return;
  IT.saveFile(sheetName() + ".json", new Blob([JSON.stringify(asepriteJson(), null, 2)], { type: "application/json" }));
});
$("btnResetPrefs").addEventListener("click", () => {
  S = { ...DEFAULTS }; IT.store.remove(SETTINGS_KEY);
  applySettingsToUI(); setupEditor(); scheduleRecompute(0);
  IT.toast("設定をリセットしました");
});
// テーマが変わったら枠線などの色を描き直す
new MutationObserver(() => { buildWeightCanvas(); drawEditor(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
try { matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { buildWeightCanvas(); drawEditor(); }); } catch { /* 古いブラウザ */ }

// テストから中の状態を見られるようにする（単体 HTML だった頃のグローバル変数と同じ名前）
Object.assign(window, { newRegion, prepRegion, weightAt, simulate: () => simulate(regions, S, mode) });
Object.defineProperty(window, "recomputeCount", { get: () => recomputeCount });
Object.defineProperty(window, "frames", { get: () => frames });
Object.defineProperty(window, "src", { get: () => src });
Object.defineProperty(window, "S", { get: () => S, set: (v: Settings) => { S = v; } });
Object.defineProperty(window, "regions", { get: () => regions, set: (v: Region[]) => { regions = v; } });

applySettingsToUI();
{ const s = samplePixel(); setSource("sample_slime.png", s.canvas, s.regions, "pixel"); }
requestAnimationFrame(tick);
