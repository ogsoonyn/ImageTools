/* Aseprite シート変換の画面 */
import { IT } from "@common/it";
import { BLEND_NAMES, composite, parse, type AseDoc, type TagDirection } from "./ase";

const SAMPLE_URL = "../samples/aseprite/slime.aseprite";
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const $in = (id: string) => $<HTMLInputElement>(id);
const $sel = (id: string) => $<HTMLSelectElement>(id);
const $btn = (id: string) => $<HTMLButtonElement>(id);
const $cv = (id: string) => $<HTMLCanvasElement>(id);
const inputOf = (e: Event) => e.target as HTMLInputElement;

// ---------- settings (localStorage に保存して次回起動時に復元) ----------
// 分割（split / セルサイズ）はファイルごとに決まるので保存しない
type Layout = "h" | "v" | "grid" | "rows";
type Zoom = "fit" | 1 | 2 | 4;
type Settings = {
  layout: Layout; cols: number; scale: number; border: number; spacing: number; json: "hash" | "array";
  grid: boolean; zoom: Zoom; trim: boolean; trimPad: number; skipEmpty: boolean;
};
type SettingKey = keyof Settings;
type Opts = Settings & { split: boolean; cellW: number; cellH: number };
const SETTINGS_KEY = "aseprite-sheet-converter:settings";
const DEFAULTS: Settings = { layout: "h", cols: 4, scale: 1, border: 0, spacing: 0, json: "hash", grid: true, zoom: "fit",
  trim: true, trimPad: 0, skipEmpty: true };
const intIn = (min: number, max: number) => (v: unknown) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const isBool = (v: unknown) => typeof v === "boolean";
const VALID: Record<SettingKey, (v: unknown) => boolean> = {
  layout: (v) => ["h", "v", "grid", "rows"].includes(v as string), cols: intIn(1, 16), scale: intIn(1, 8),
  border: intIn(0, 64), spacing: intIn(0, 64), json: (v) => v === "hash" || v === "array", grid: isBool,
  zoom: (v) => ["fit", 1, 2, 4].includes(v as Zoom), trim: isBool, trimPad: intIn(0, 64), skipEmpty: isBool,
};
function loadSettings(): Partial<Settings> {
  const saved = IT.store.get<Record<string, unknown>>(SETTINGS_KEY, null);
  const out: Record<string, unknown> = {};
  if (saved && typeof saved === "object") for (const k in VALID) if (k in saved && VALID[k as SettingKey](saved[k])) out[k] = saved[k];
  return out as Partial<Settings>;
}
const savedSettings = loadSettings();

type Box = { x0: number; y0: number; x1: number; y1: number };
type Sprite = { cell: number; frame: number; ox: number; oy: number };
type Rect = { x: number; y: number; w: number; h: number };
type Cut = {
  W: number; H: number; cw: number; ch: number; nx: number; ny: number; cells: number; rect: Rect;
  boxes: (Box | null)[][]; cellHas: boolean[]; sprites: Sprite[]; excluded: number; remX: number; remY: number;
};
type SheetLayout = { fw: number; fh: number; c: number; r: number; rects: Rect[]; sw: number; sh: number };
const state: {
  doc: AseDoc | null; title: string; ext: string; isSample: boolean;
  enabled: boolean[]; frames: HTMLCanvasElement[]; sheet: HTMLCanvasElement;
  opts: Opts; userSettings: Partial<Settings>;
  frameData: Uint8ClampedArray<ArrayBuffer>[]; cut: Cut | null; L: SheetLayout | null;
  anim: { playing: boolean; seq: number[]; pos: number; timer: number };
} = {
  doc: null, title: "sprite", ext: "aseprite", isSample: false,
  enabled: [], frames: [], sheet: document.createElement("canvas"),
  opts: { ...DEFAULTS, ...savedSettings, split: false, cellW: 1, cellH: 1 },
  // ユーザーが変えた設定だけを保存する（サンプル読み込みで一時的に変わった値は保存しない）
  userSettings: { ...savedSettings },
  frameData: [], cut: null, L: null,
  anim: { playing: !matchMedia("(prefers-reduced-motion: reduce)").matches, seq: [], pos: 0, timer: 0 },
};
function saveSetting(key: SettingKey) {
  (state.userSettings as Record<string, unknown>)[key] = state.opts[key];
  IT.store.set(SETTINGS_KEY, state.userSettings);
}

// ---------- file loading ----------
async function loadBuffer(buf: ArrayBuffer | Blob, name: string, isSample: boolean) {
  try {
    if (buf instanceof Blob) buf = await buf.arrayBuffer();
    const doc = await parse(buf);
    state.doc = doc; state.isSample = isSample;
    const m = /^(.*?)(?:\.(ase|aseprite))?$/i.exec(name)!;
    state.title = m[1] || "sprite"; state.ext = (m[2] || "aseprite").toLowerCase();
    state.enabled = doc.layers.map((l) => l.visible);
    if (!("cols" in state.userSettings)) state.opts.cols = Math.min(Math.max(1, Math.ceil(Math.sqrt(doc.frames.length))), 16);
    $in("cols").value = String(state.opts.cols); $("cols-val").textContent = String(state.opts.cols);
    // セルサイズは読み込みごとにキャンバス全体へ戻す（サンプルだけは分割の例として 32×32 にする）
    Object.assign(state.opts, isSample
      ? { split: true, cellW: 32, cellH: 32, layout: "rows" }
      : { split: false, cellW: doc.header.width, cellH: doc.header.height });
    $sel("anim-cell").value = "";
    syncCutInputs();
    state.anim.pos = 0;
    renderInfo(); renderLayers(); renderTagSelect(); rebuild();
    setNote("");
  } catch (e) {
    setNote(name + " を読み込めませんでした: " + (e as Error).message, true);
    IT.toast(name + " を読み込めませんでした");
  }
}
// サンプルは samples/ から fetch する（file:// では fetch できないためボタンを無効化）
if (location.protocol === "file:") {
  $btn("load-sample").disabled = true;
  $("sample-note").textContent = "ローカルファイルとして開いているためサンプルは使えません（Webサーバー経由で開くと使えます）";
}
$("load-sample").addEventListener("click", async () => {
  const b = $btn("load-sample"); b.disabled = true; $("sample-note").textContent = "";
  try {
    const r = await fetch(SAMPLE_URL);
    if (!r.ok) throw new Error("HTTP " + r.status);
    await loadBuffer(await r.arrayBuffer(), "slime.aseprite", true);
    b.disabled = false;
  } catch (e) {
    $("sample-note").textContent = "サンプルを読み込めませんでした（" + (e as Error).message + "）";
  }
});
IT.initDrop({
  zone: "drop",
  input: "file-input",
  accept: (f) => /\.(ase|aseprite)$/i.test(f.name),
  onFiles: (files) => loadBuffer(files[0], files[0].name, false),
  emptyMessage: ".ase / .aseprite ファイルが見つかりませんでした",
});

// ---------- info / layers ----------
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string | null, text?: string | null): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n;
}
function renderInfo() {
  const d = state.doc!, h = d.header;
  $("file-name").textContent = state.title + "." + state.ext;
  $("sample-badge").hidden = !state.isSample;
  const total = d.frames.reduce((a, f) => a + f.duration, 0);
  const rows = [
    ["キャンバス", h.width + " × " + h.height + " px"],
    ["フレーム", d.frames.length + " 枚 / 合計 " + total + " ms"],
    ["カラーモード", d.depthName + (h.depth === 8 ? "（透明色 #" + h.transparentIndex + "）" : "")],
    ["レイヤー", d.layers.length + " 枚"],
    ["スライス", d.slices.length ? d.slices.map((s) => s.name).join(", ") : "なし"],
  ];
  const dl = $("file-info"); dl.replaceChildren();
  for (const [k, v] of rows) { dl.append(el("dt", "text-muted", k), el("dd", "num min-w-0 break-words", v)); }
  const tl = $("tag-list"); tl.replaceChildren();
  for (const t of d.tags) {
    const b = el("span", "badge-outline");
    const dot = el("span"); dot.style.cssText = "width:8px;height:8px;border-radius:2px;background:" + t.color.slice(0, 7);
    b.append(dot, document.createTextNode(t.name + " " + t.from + "–" + t.to + " " + dirLabel(t.direction)));
    tl.append(b);
  }
  const w = $("warnings"); w.hidden = !d.warnings.length; w.textContent = d.warnings.join(" ");
}
function dirLabel(d: TagDirection) { return ({ forward: "→", reverse: "←", pingpong: "⇄", pingpong_reverse: "⇆" } as Record<string, string>)[d] || ""; }

function renderLayers() {
  const d = state.doc!, ul = $("layer-list"); ul.replaceChildren();
  for (let i = d.layers.length - 1; i >= 0; i--) {
    const L = d.layers[i];
    const li = el("li", "flex items-center gap-2 min-w-0 rounded px-1 py-0.5");
    li.style.paddingLeft = (4 + L.childLevel * 16) + "px";
    const cb = el("input", "toggle"); cb.type = "checkbox"; cb.id = "layer-" + i;
    cb.checked = state.enabled[i]; cb.disabled = L.reference;
    cb.addEventListener("change", () => { state.enabled[i] = cb.checked; rebuild(); renderLayerDim(); });
    const lab = el("label", "flex-1 min-w-0 truncate text-[13px] cursor-pointer");
    lab.htmlFor = cb.id;
    lab.textContent = (L.type === 1 ? "▾ " : "") + L.name;
    li.append(cb, lab);
    const meta: string[] = [];
    if (L.type === 1) meta.push("グループ");
    if (L.type === 2) meta.push("タイル");
    if (L.reference) meta.push("参照");
    if (L.type !== 1 && L.blendMode) meta.push(BLEND_NAMES[L.blendMode] || "?");
    if (L.type !== 1 && L.opacity < 255) meta.push(Math.round(L.opacity / 2.55) + "%");
    if (meta.length) li.append(el("span", "badge-outline shrink-0", meta.join(" · ")));
    li.dataset.index = String(i);
    ul.append(li);
  }
  renderLayerDim();
}
function renderLayerDim() {
  const L = state.doc!.layers;
  for (const li of $("layer-list").children as HTMLCollectionOf<HTMLElement>) {
    const i = +li.dataset.index!;
    let on = true;
    for (let k = L[i].parent; k >= 0; k = L[k].parent) if (!state.enabled[k]) on = false;
    li.style.opacity = on ? "1" : ".45";
  }
}
$("layers-reset").addEventListener("click", () => {
  if (!state.doc) return;
  state.enabled = state.doc.layers.map((l) => l.visible); renderLayers(); rebuild();
});

// ---------- cutting (split into cells + shared trim) ----------
function composeFrames() {
  const d = state.doc!, { width: W, height: H } = d.header;
  state.frameData = [];
  state.frames = d.frames.map((_f, i) => {
    const px = composite(d, i, state.enabled);
    state.frameData.push(px);
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    cv.getContext("2d")!.putImageData(new ImageData(px, W, H), 0, 0);
    return cv;
  });
}
function computeCut() {
  const d = state.doc!, { width: W, height: H } = d.header, o = state.opts, nf = d.frames.length;
  let cw = W, ch = H;
  if (o.split) { cw = Math.max(1, Math.min(W, o.cellW | 0)); ch = Math.max(1, Math.min(H, o.cellH | 0)); }
  const nx = Math.floor(W / cw), ny = Math.floor(H / ch), cells = nx * ny;
  const boxes: (Box | null)[][] = []; let U: Box | null = null;
  for (let c = 0; c < cells; c++) {
    const ox = (c % nx) * cw, oy = Math.floor(c / nx) * ch; boxes.push([]);
    for (let f = 0; f < nf; f++) {
      const px = state.frameData[f]; let x0 = cw, y0 = ch, x1 = -1, y1 = -1;
      for (let y = 0; y < ch; y++) {
        let k = ((oy + y) * W + ox) * 4 + 3;
        for (let x = 0; x < cw; x++, k += 4) {
          if (px[k]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y; }
        }
      }
      const b = x1 < 0 ? null : { x0, y0, x1, y1 };
      boxes[c].push(b);
      if (b) {
        if (!U) U = { ...b };
        else { U.x0 = Math.min(U.x0, b.x0); U.y0 = Math.min(U.y0, b.y0); U.x1 = Math.max(U.x1, b.x1); U.y1 = Math.max(U.y1, b.y1); }
      }
    }
  }
  let rect: Rect = { x: 0, y: 0, w: cw, h: ch };
  if (o.trim && U) {
    const p = o.trimPad, x = Math.max(0, U.x0 - p), y = Math.max(0, U.y0 - p);
    rect = { x, y, w: Math.min(cw, U.x1 + 1 + p) - x, h: Math.min(ch, U.y1 + 1 + p) - y };
  }
  // セル順（各セルのフレームが連続）に並べる
  const sprites: Sprite[] = []; let excluded = 0;
  for (let c = 0; c < cells; c++) for (let f = 0; f < nf; f++) {
    if (o.skipEmpty && !boxes[c][f]) { excluded++; continue; }
    sprites.push({ cell: c, frame: f, ox: (c % nx) * cw, oy: Math.floor(c / nx) * ch });
  }
  const cellHas = boxes.map((row) => row.some(Boolean));
  state.cut = { W, H, cw, ch, nx, ny, cells, rect, boxes, cellHas, sprites, excluded, remX: W - nx * cw, remY: H - ny * ch };
}
function renderCutSummary() {
  const C = state.cut!, o = state.opts, box = $("trim-summary"); box.replaceChildren();
  const line = (t: string, cls?: string) => box.append(el("div", cls || "", t));
  if (o.split) line("セル: " + C.nx + " 列 × " + C.ny + " 行 = " + C.cells + " 個（" + C.cw + " × " + C.ch + " px）");
  else line("分割なし（キャンバス " + C.W + " × " + C.H + " px）");
  const R = C.rect, trimmed = R.w !== C.cw || R.h !== C.ch;
  if (o.trim) line(trimmed ? "切り詰め後: " + R.w + " × " + R.h + " px（セル内 x " + R.x + ", y " + R.y + " から）" : "切り詰め: 余白なし（" + R.w + " × " + R.h + " px のまま）");
  line("スプライト: " + C.sprites.length + " 枚" + (C.excluded ? "（空 " + C.excluded + " 枚を除外）" : ""));
  const rem: string[] = [];
  if (C.remX) rem.push("右端 " + C.remX + " px");
  if (C.remY) rem.push("下端 " + C.remY + " px");
  if (rem.length) line(rem.join("・") + " はセルに収まらないため使われません。", "text-amber");
  if (!C.sprites.length) line("書き出すスプライトがありません。レイヤーの表示か分割の設定を確認してください。", "danger");
  $("split-row").hidden = !o.split;
  $("trim-row").hidden = !o.trim;
}

// ---------- sheet ----------
function layoutSheet() {
  const o = state.opts, C = state.cut!, n = C.sprites.length;
  const fw = C.rect.w * o.scale, fh = C.rect.h * o.scale;
  const pos: [number, number][] = []; let c: number, r: number;
  if (o.layout === "rows") {
    const rowOf = new Map<number, number>();
    C.sprites.forEach((s) => { if (!rowOf.has(s.cell)) rowOf.set(s.cell, rowOf.size); });
    c = Math.max(1, state.doc!.frames.length); r = Math.max(1, rowOf.size);
    C.sprites.forEach((s) => pos.push([s.frame, rowOf.get(s.cell)!]));
  } else {
    c = o.layout === "h" ? Math.max(1, n) : o.layout === "v" ? 1 : Math.max(1, Math.min(o.cols, n));
    r = Math.max(1, Math.ceil(n / c));
    for (let i = 0; i < n; i++) pos.push([i % c, Math.floor(i / c)]);
  }
  const rects = pos.map(([cx, cy]) => ({ x: o.border + cx * (fw + o.spacing), y: o.border + cy * (fh + o.spacing), w: fw, h: fh }));
  state.L = { fw, fh, c, r, rects, sw: n ? o.border * 2 + c * fw + (c - 1) * o.spacing : 0, sh: n ? o.border * 2 + r * fh + (r - 1) * o.spacing : 0 };
}
function buildSheet() {
  const L = state.L!, C = state.cut!, R = C.rect, cv = state.sheet;
  cv.width = Math.max(1, L.sw); cv.height = Math.max(1, L.sh);
  const ctx = cv.getContext("2d")!; ctx.imageSmoothingEnabled = false; ctx.clearRect(0, 0, cv.width, cv.height);
  C.sprites.forEach((s, i) => {
    const d = L.rects[i];
    ctx.drawImage(state.frames[s.frame], s.ox + R.x, s.oy + R.y, R.w, R.h, d.x, d.y, d.w, d.h);
  });
  $("sheet-size").textContent = C.sprites.length
    ? L.sw + " × " + L.sh + " px ・ " + L.c + "列 × " + L.r + "行 ・ 1枚 " + L.fw + " × " + L.fh + " px"
    : "スプライトなし";
}
function zoomValue() {
  const z = state.opts.zoom;
  if (z !== "fit") return +z;
  // 入れ物は max-h-[60vh] なので、幅と高さの両方に収まる倍率にする
  const availW = $("sheet-scroll").clientWidth - 2;
  const availH = Math.floor(window.innerHeight * 0.6) - 2;
  const fit = Math.min(availW / state.sheet.width, availH / state.sheet.height);
  return Math.max(1, Math.min(16, Math.floor(fit) || 1));
}
function drawView() {
  if (!state.doc) return;
  const z = zoomValue(), L = state.L!, cv = $cv("sheet-view");
  cv.width = state.sheet.width * z; cv.height = state.sheet.height * z;
  const ctx = cv.getContext("2d")!; ctx.imageSmoothingEnabled = false;
  ctx.drawImage(state.sheet, 0, 0, cv.width, cv.height);
  if (state.opts.grid) {
    const cs = getComputedStyle(document.documentElement);
    const amber = cs.getPropertyValue("--amber").trim() || "#c97f00";
    ctx.lineWidth = 1; ctx.strokeStyle = amber;
    ctx.font = "600 10px " + cs.getPropertyValue("--font-mono");
    ctx.textBaseline = "top";
    L.rects.forEach((r, i) => {
      ctx.strokeRect(r.x * z + .5, r.y * z + .5, r.w * z - 1, r.h * z - 1);
      if (r.w * z >= 18 && r.h * z >= 14) {
        const label = String(i), tw = ctx.measureText(label).width + 6;
        ctx.fillStyle = amber; ctx.fillRect(r.x * z, r.y * z, tw, 13);
        ctx.fillStyle = "#1b1300"; ctx.fillText(label, r.x * z + 3, r.y * z + 2);
      }
    });
  }
  document.querySelectorAll<HTMLElement>("[data-zoom]").forEach((b) => b.classList.toggle("is-active", b.dataset.zoom === String(state.opts.zoom)));
}

// ---------- JSON ----------
function buildJSON() {
  const d = state.doc!, L = state.L!, C = state.cut!, R = C.rect, s = state.opts.scale;
  const split = C.cells > 1, multi = d.frames.length > 1;
  const name = (sp: Sprite) => state.title + (split ? " cell" + sp.cell : "") + (multi ? " " + sp.frame : "") + "." + state.ext;
  const trimmed = R.w !== C.cw || R.h !== C.ch;
  const entries = C.sprites.map((sp, i) => {
    const r = L.rects[i];
    return [name(sp), {
      frame: { x: r.x, y: r.y, w: r.w, h: r.h }, rotated: false, trimmed,
      spriteSourceSize: { x: R.x * s, y: R.y * s, w: R.w * s, h: R.h * s },
      sourceSize: { w: C.cw * s, h: C.ch * s }, duration: d.frames[sp.frame].duration,
    }] as const;
  });
  const frames = state.opts.json === "array"
    ? entries.map(([filename, v]) => Object.assign({ filename }, v))
    : Object.fromEntries(entries);
  const Ls = d.layers;
  const layers = Ls.map((l) => {
    const o: Record<string, unknown> = { name: l.name };
    if (l.parent >= 0) o.group = Ls[l.parent].name;
    if (l.type !== 1) { o.opacity = l.opacity; o.blendMode = BLEND_NAMES[l.blendMode] || "normal"; }
    if (l.color) o.color = l.color;
    if (l.data) o.data = l.data;
    return o;
  });
  // タグのフレーム番号を、シート内のスプライト番号に付け替える（スプライトはセルごとに連続して並ぶ）
  const idx = new Map<string, number>(); C.sprites.forEach((sp, i) => idx.set(sp.cell + ":" + sp.frame, i));
  const span = (cell: number, from: number, to: number): [number, number] | null => {
    let a = -1, b = -1;
    for (let f = from; f <= to; f++) { const i = idx.get(cell + ":" + f); if (i != null) { if (a < 0) a = i; b = i; } }
    return a < 0 ? null : [a, b];
  };
  const frameTags: Record<string, unknown>[] = [];
  for (let c = 0; c < C.cells; c++) {
    if (split) {
      const all = span(c, 0, d.frames.length - 1);
      if (all) frameTags.push({ name: "cell" + c, from: all[0], to: all[1], direction: "forward", color: "#000000ff" });
    }
    for (const t of d.tags) {
      const sp = span(c, t.from, t.to); if (!sp) continue;
      const o: Record<string, unknown> = { name: (split ? "cell" + c + "/" : "") + t.name, from: sp[0], to: sp[1], direction: t.direction, color: t.color };
      if (t.repeat > 0) o.repeat = String(t.repeat);
      if (t.data) o.data = t.data;
      frameTags.push(o);
    }
  }
  const slices = d.slices.map((sl) => {
    const o: Record<string, unknown> = { name: sl.name, color: sl.color };
    if (sl.data) o.data = sl.data;
    o.keys = sl.keys;
    return o;
  });
  return {
    frames,
    meta: {
      app: "https://www.aseprite.org/", version: "1.3",
      image: outBase() + ".png", format: "RGBA8888",
      size: { w: L.sw, h: L.sh }, scale: String(s),
      frameTags, layers, slices,
    },
  };
}
// 出力ファイル名: 元の名前 + _列数x行数
function outBase() { return state.title + "_" + state.L!.c + "x" + state.L!.r; }
function jsonText() { return JSON.stringify(buildJSON(), null, 2); }
function renderJSON() {
  const t = jsonText(); $<HTMLTextAreaElement>("json-out").value = t;
  $("json-size").textContent = (new Blob([t]).size / 1024).toFixed(1) + " KB";
}

// ---------- animation ----------
function renderTagSelect() {
  const d = state.doc!, s = $sel("anim-tag"); s.replaceChildren();
  const all = el("option", null, "全フレーム（0–" + (d.frames.length - 1) + "）"); all.value = "-1"; s.append(all);
  d.tags.forEach((t, i) => { const o = el("option", null, t.name + "（" + t.from + "–" + t.to + " " + dirLabel(t.direction) + "）"); o.value = String(i); s.append(o); });
  s.value = d.tags.length ? "0" : "-1";
  buildSeq();
}
function renderCellSelect() {
  const C = state.cut!, s = $sel("anim-cell"), prev = s.value;
  s.replaceChildren();
  for (let c = 0; c < C.cells; c++) {
    const o = el("option", null, "セル " + c + (C.cellHas[c] ? "" : "（空）")); o.value = String(c); s.append(o);
  }
  const first = C.cellHas.indexOf(true);
  s.value = prev !== "" && +prev < C.cells ? prev : String(Math.max(0, first));
  s.hidden = C.cells <= 1;
}
function buildSeq() {
  const d = state.doc!, ti = +$sel("anim-tag").value, t = d.tags[ti];
  const from = t ? t.from : 0, to = t ? Math.min(t.to, d.frames.length - 1) : d.frames.length - 1, dir = t ? t.direction : "forward";
  const fwd: number[] = []; for (let i = from; i <= to; i++) fwd.push(i);
  const rev = fwd.slice().reverse();
  state.anim.seq = dir === "reverse" ? rev
    : dir === "pingpong" ? fwd.concat(fwd.slice(1, -1).reverse())
    : dir === "pingpong_reverse" ? rev.concat(rev.slice(1, -1).reverse())
    : fwd;
  state.anim.pos = 0;
}
function drawAnimFrame() {
  const a = state.anim, fi = a.seq[a.pos % a.seq.length], cv = $cv("anim-view"), f = state.frames[fi], C = state.cut;
  if (!f || !C) return;
  const cell = Math.min(+$sel("anim-cell").value || 0, C.cells - 1), R = C.rect;
  const ox = (cell % C.nx) * C.cw + R.x, oy = Math.floor(cell / C.nx) * C.ch + R.y;
  const box = cv.parentElement!.clientWidth - 2;
  const z = Math.max(1, Math.floor(box / Math.max(R.w, R.h)));
  cv.width = R.w * z; cv.height = R.h * z;
  const ctx = cv.getContext("2d")!; ctx.imageSmoothingEnabled = false;
  ctx.drawImage(f, ox, oy, R.w, R.h, 0, 0, cv.width, cv.height);
  const empty = !C.boxes[cell][fi];
  $("anim-frame").textContent = "#" + fi + " ・ " + state.doc!.frames[fi].duration + " ms" + (empty ? " ・ 空" : "");
}
function tick() {
  clearTimeout(state.anim.timer);
  if (!state.doc) return;
  drawAnimFrame();
  if (!state.anim.playing) return;
  const fi = state.anim.seq[state.anim.pos % state.anim.seq.length];
  state.anim.timer = window.setTimeout(() => { state.anim.pos = (state.anim.pos + 1) % state.anim.seq.length; tick(); },
    Math.max(16, state.doc.frames[fi].duration || 100));
}
function syncPlayBtn() {
  const b = $("anim-play"); b.textContent = state.anim.playing ? "一時停止" : "再生";
}
$("anim-play").addEventListener("click", () => { state.anim.playing = !state.anim.playing; syncPlayBtn(); tick(); });
$("anim-tag").addEventListener("change", () => { buildSeq(); tick(); });
$("anim-cell").addEventListener("change", () => tick());

// ---------- controls ----------
function rebuild() { if (!state.doc) return; composeFrames(); recut(); }
function recut() {
  if (!state.doc) return;
  computeCut(); renderCutSummary(); renderCellSelect(); relayout(); tick();
}
function relayout() {
  if (!state.doc) return;
  layoutSheet(); buildSheet(); drawView(); renderJSON();
  $("out-name").textContent = outBase() + ".png / .json";
  document.querySelectorAll<HTMLElement>("[data-layout]").forEach((b) => b.classList.toggle("is-active", b.dataset.layout === state.opts.layout));
  $("cols-row").hidden = state.opts.layout !== "grid";
  $("rows-note").hidden = state.opts.layout !== "rows";
}
// 保存対象の設定を画面の入力欄・ボタンに反映する（起動時とリセット時）
function syncSettingInputs() {
  const o = state.opts;
  $in("cols").value = String(o.cols); $("cols-val").textContent = String(o.cols);
  $in("scale").value = String(o.scale); $("scale-val").textContent = o.scale + "×";
  $in("border").value = String(o.border); $in("spacing").value = String(o.spacing);
  $sel("json-format").value = o.json; $in("show-grid").checked = o.grid;
  $in("trim-on").checked = o.trim; $in("trim-pad").value = String(o.trimPad); $in("skip-empty").checked = o.skipEmpty;
  document.querySelectorAll<HTMLElement>("[data-layout]").forEach((b) => b.classList.toggle("is-active", b.dataset.layout === o.layout));
  document.querySelectorAll<HTMLElement>("[data-zoom]").forEach((b) => b.classList.toggle("is-active", b.dataset.zoom === String(o.zoom)));
  $("cols-row").hidden = o.layout !== "grid";
  $("rows-note").hidden = o.layout !== "rows";
  $("split-row").hidden = !o.split;
  $("trim-row").hidden = !o.trim;
}
function syncCutInputs() {
  const o = state.opts;
  $in("split-on").checked = o.split; $in("cell-w").value = String(o.cellW); $in("cell-h").value = String(o.cellH);
  $in("trim-on").checked = o.trim; $in("trim-pad").value = String(o.trimPad); $in("skip-empty").checked = o.skipEmpty;
}
$("split-on").addEventListener("change", (e) => { state.opts.split = inputOf(e).checked; recut(); });
let cutT = 0;
const cellInput = (id: string, key: "cellW" | "cellH") => $(id).addEventListener("input", (e) => {
  const v = parseInt(inputOf(e).value, 10);
  if (!(v >= 1)) return;
  state.opts[key] = v; clearTimeout(cutT); cutT = window.setTimeout(recut, 150);
});
cellInput("cell-w", "cellW"); cellInput("cell-h", "cellH");
$("trim-on").addEventListener("change", (e) => { state.opts.trim = inputOf(e).checked; saveSetting("trim"); recut(); });
$("trim-pad").addEventListener("input", (e) => { state.opts.trimPad = Math.max(0, Math.min(64, parseInt(inputOf(e).value, 10) || 0)); saveSetting("trimPad"); recut(); });
$("skip-empty").addEventListener("change", (e) => { state.opts.skipEmpty = inputOf(e).checked; saveSetting("skipEmpty"); recut(); });
document.querySelectorAll<HTMLElement>("[data-layout]").forEach((b) => b.addEventListener("click", () => {
  state.opts.layout = b.dataset.layout as Layout; saveSetting("layout"); syncSettingInputs(); relayout();
}));
document.querySelectorAll<HTMLElement>("[data-zoom]").forEach((b) => b.addEventListener("click", () => {
  state.opts.zoom = b.dataset.zoom === "fit" ? "fit" : (+b.dataset.zoom! as Zoom); saveSetting("zoom"); syncSettingInputs(); drawView();
}));
$("cols").addEventListener("input", (e) => {
  state.opts.cols = +inputOf(e).value; $("cols-val").textContent = inputOf(e).value; saveSetting("cols"); relayout();
});
$("scale").addEventListener("input", (e) => { state.opts.scale = +inputOf(e).value; $("scale-val").textContent = inputOf(e).value + "×"; saveSetting("scale"); relayout(); });
const intInput = (id: string, key: "border" | "spacing") => $(id).addEventListener("input", (e) => {
  const v = Math.max(0, Math.min(64, parseInt(inputOf(e).value, 10) || 0)); state.opts[key] = v; saveSetting(key); relayout();
});
intInput("border", "border"); intInput("spacing", "spacing");
$("json-format").addEventListener("change", (e) => { state.opts.json = (e.target as HTMLSelectElement).value as Settings["json"]; saveSetting("json"); if (state.doc) renderJSON(); });
$("show-grid").addEventListener("change", (e) => { state.opts.grid = inputOf(e).checked; saveSetting("grid"); drawView(); });
$("reset-settings").addEventListener("click", () => {
  IT.store.remove(SETTINGS_KEY);
  Object.assign(state.opts, DEFAULTS);
  state.userSettings = {};
  if (state.doc) state.opts.cols = Math.min(Math.max(1, Math.ceil(Math.sqrt(state.doc.frames.length))), 16);
  syncSettingInputs(); recut();
  IT.toast("設定をリセットしました");
});
let rz = 0; addEventListener("resize", () => { clearTimeout(rz); rz = window.setTimeout(() => { drawView(); drawAnimFrame(); }, 120); });

// ---------- saving ----------
function setNote(msg: string, isErr?: boolean) { const n = $("save-note"); n.textContent = msg; n.style.color = isErr ? "var(--danger)" : ""; }
$("save-png").addEventListener("click", async () => {
  if (!state.doc) return;
  try { await IT.saveFile(outBase() + ".png", await IT.canvasToBlob(state.sheet)); }
  catch { IT.toast("PNGを作成できませんでした"); }
});
$("save-json").addEventListener("click", () => {
  if (state.doc) IT.saveFile(outBase() + ".json", new Blob([jsonText()], { type: "application/json" }));
});
$("open-polish").addEventListener("click", () => {
  if (!state.doc) return;
  const n = outBase();
  IT.openIn("sprite-polish", IT.canvasToBlob(state.sheet).then((b) => [new File([b], n + ".png", { type: "image/png" }), new File([jsonText()], n + ".json", { type: "application/json" })]));
});
$("copy-json").addEventListener("click", async () => {
  if (!state.doc) return;
  const t = jsonText();
  try { await navigator.clipboard.writeText(t); IT.toast("JSONをクリップボードにコピーしました"); }
  catch { const ta = $<HTMLTextAreaElement>("json-out"); ta.focus(); ta.select(); IT.toast("自動コピーできなかったため、JSONを選択状態にしました。Ctrl+C でコピーしてください", 4000); }
});

// ---------- boot ----------
syncSettingInputs();
syncPlayBtn();
