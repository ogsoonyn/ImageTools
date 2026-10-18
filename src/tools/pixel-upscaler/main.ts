/* ドット絵拡大ツールの画面 */
import { IT } from "@common/it";
import { METHODS, analyze, plan, render, type Img, type MethodId, type Scale } from "./upscale";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const $in = (id: string) => $<HTMLInputElement>(id);
const $btn = (id: string) => $<HTMLButtonElement>(id);
const $cv = (id: string) => $<HTMLCanvasElement>(id);

type Zoom = "fit" | 1 | 2 | 4;
type Bg = "checker" | "white" | "black";
type Pane = { method: MethodId; thin: boolean };
type Prefs = { scale: Scale; zoom: Zoom; bg: Bg; panes: Pane[]; width: number; inner: boolean; dotKeep: number };

const SETTINGS_KEY = "pixel-upscaler:settings";
const DEFAULTS: Prefs = {
  scale: 4, zoom: "fit", bg: "checker",
  panes: [{ method: "nearest", thin: false }, { method: "xbr", thin: true }],
  width: 1, inner: true, dotKeep: 2,
};
let prefs = loadPrefs();
function loadPrefs(): Prefs {
  // 保存された値は壊れていることもあるので、使える値か確かめてから使う
  const s = (IT.store.get<Record<string, unknown>>(SETTINGS_KEY, {}) || {}) as Record<string, unknown>, d = structuredClone(DEFAULTS);
  const pick = <T>(v: unknown, ok: readonly T[], def: T): T => (ok.includes(v as T) ? (v as T) : def);
  const int = (v: unknown, lo: number, hi: number, def: number) => (Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi ? (v as number) : def);
  const methods = METHODS.map((m) => m.id);
  const panes = Array.isArray(s.panes) ? (s.panes as unknown[]) : [];
  const p: Prefs = {
    scale: pick(s.scale, [2, 3, 4, 6, 8] as const, d.scale),
    zoom: pick(s.zoom, ["fit", 1, 2, 4] as const, d.zoom),
    bg: pick(s.bg, ["checker", "white", "black"] as const, d.bg),
    inner: typeof s.inner === "boolean" ? s.inner : d.inner,
    dotKeep: int(s.dotKeep, 0, 8, d.dotKeep),
    panes: d.panes.map((def, i) => {
      const q = (panes[i] && typeof panes[i] === "object" ? panes[i] : {}) as Record<string, unknown>;
      return { method: pick(q.method, methods, def.method), thin: typeof q.thin === "boolean" ? q.thin : def.thin };
    }),
    width: d.width,
  };
  p.width = int(s.width, 1, p.scale, d.width);
  return p;
}
const savePrefs = () => IT.store.set(SETTINGS_KEY, prefs);

// サンプル: 16×16 のスライム 2 コマ（2 コマ目はまばたき）。# が 1 ドットの輪郭
const SAMPLE_ROWS = [
  "................", "................", ".....######.....", "...##aaaaaa##...",
  "..#aaaaaaaaaa#..", ".#aaawwaaaaaaa#.", ".#aawwaaaaaaaa#.", "#aaaaaaaaaaaaaa#",
  "#aaaaeaaaaeaaaa#", "#aaaaeaaaaeaaaa#", "#aaaaaaaaaaaaaa#", "#baaaaaaaaaaaab#",
  ".#bbaaaaaaaabb#.", "..##bbbbbbbb##..", "....########....", "................",
];
const SAMPLE_BLINK: Record<number, string> = { 8: "#aaaaaaaaaaaaaa#", 9: "#aaaeeaaaaeeaaa#" };
const SAMPLE_COLORS: Record<string, [number, number, number]> = { "#": [27, 27, 47], e: [27, 27, 47], a: [79, 195, 106], b: [46, 139, 87], w: [217, 255, 224] };
function makeSample(): Img {
  const w = 32, h = 16, px = new Uint32Array(w * h);
  for (let f = 0; f < 2; f++) for (let y = 0; y < 16; y++) {
    const row = f && SAMPLE_BLINK[y] ? SAMPLE_BLINK[y] : SAMPLE_ROWS[y];
    for (let x = 0; x < 16; x++) {
      const c = SAMPLE_COLORS[row[x]];
      if (c) px[y * w + f * 16 + x] = ((255 << 24) | (c[2] << 16) | (c[1] << 8) | c[0]) >>> 0;
    }
  }
  return { px, w, h };
}

type Frame = { on: boolean; cols: number; rows: number };
const state: {
  img: Img | null; name: string; isSample: boolean; palette: number[]; outline: Set<number>;
  frame: Frame; results: ((Img & { note: string }) | null)[];
} = {
  img: null, name: "sample", isSample: true, palette: [], outline: new Set(),
  frame: { on: true, cols: 2, rows: 1 }, results: [null, null],
};

// ---- 入力 ----
function setImage(img: Img, name: string, isSample: boolean) {
  for (let i = 0; i < img.px.length; i++) if ((img.px[i] >>> 24) === 0) img.px[i] = 0;
  state.img = img; state.name = name; state.isSample = isSample;
  const a = analyze(img);
  state.palette = a.palette;
  state.outline = new Set(a.auto != null ? [a.auto] : []);
  const cv = $cv("srcView");
  cv.width = img.w; cv.height = img.h;
  cv.getContext("2d")!.putImageData(toImageData(img), 0, 0);
  const z = Math.max(1, Math.min(8, Math.floor(240 / Math.max(img.w, img.h))));
  cv.style.width = img.w * z + "px";
  $("srcInfo").textContent = `${name}  ${img.w}×${img.h}px  ${a.palette.length}色`;
  const g = isSample ? [2, 1] : gridOfName(name, img.w, img.h);
  state.frame = g && g[0] <= img.w && g[1] <= img.h ? { on: true, cols: g[0], rows: g[1] } : { on: false, cols: 1, rows: 1 };
  syncFrameUi();
  renderSwatches();
  schedule();
}
function toImageData({ px, w, h }: Img) {
  return new ImageData(new Uint8ClampedArray(px.buffer.slice(px.byteOffset, px.byteOffset + px.byteLength) as ArrayBuffer), w, h);
}
// ファイル名の最後の「数字x数字」を列x行として読む（各 1〜64。ImageTools のシート出力は末尾に _列x行 が付く）
function gridOfName(name: string, w: number, h: number): [number, number] | null {
  // 拡張子を除いた名前の末尾だけを見る。割り切れて 1 コマが 4 ドット以上のときだけ（「tree_32x32」のようなコマの大きさの名前を避ける）
  const m = String(name).replace(/\.[a-z0-9]+$/i, "").match(/(?<!\d)(\d+)\s*[xX×]\s*(\d+)$/);
  if (!m) return null;
  const c = +m[1], r = +m[2];
  return c >= 1 && r >= 1 && c <= 64 && r <= 64 && c * r > 1 && w % c === 0 && h % r === 0 && w / c >= 4 && h / r >= 4 ? [c, r] : null;
}
const stripGrid = (s: string) => s.replace(/[_\-\s]*(?<!\d)\d+\s*[xX×]\s*\d+$/, "");
// 保存名の末尾にも _列x行 を残す（コマごとに拡大したときだけ。分割数を読むツールがそのまま使えるように）
function gridSuffix() {
  const f = state.frame;
  return f.on && f.cols <= 64 && f.rows <= 64 ? `_${f.cols}x${f.rows}` : "";
}
function loadFile(file: File) {
  const url = URL.createObjectURL(file);
  const im = new Image();
  im.onload = () => {
    URL.revokeObjectURL(url);
    const w = im.naturalWidth, h = im.naturalHeight;
    if (w * h > 1024 * 1024) { IT.toast("画像が大きすぎます（1024×1024 ドットまで）"); return; }
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const ctx = cv.getContext("2d")!;
    ctx.drawImage(im, 0, 0);
    const d = ctx.getImageData(0, 0, w, h).data;
    setImage({ px: new Uint32Array(d.buffer.slice(0)), w, h }, file.name.replace(/\.[^.]+$/, ""), false);
    if (state.frame.on) IT.toast(`ファイル名から ${state.frame.cols}×${state.frame.rows} コマのシートとして読みました`);
  };
  im.onerror = () => { URL.revokeObjectURL(url); IT.toast("画像を読み込めませんでした。PNG などの画像ファイルを選んでください"); };
  im.src = url;
}
IT.initDrop({ zone: "drop", input: "fileInput", accept: (f) => f.type.startsWith("image/"), onFiles: (fs) => loadFile(fs[0]), emptyMessage: "画像ファイルが見つかりませんでした" });
document.addEventListener("paste", (e) => {
  const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith("image/"));
  if (f) { e.preventDefault(); loadFile(f); }
});
$("btnSample").addEventListener("click", () => setImage(makeSample(), "sample", true));

// ---- 倍率・コマ ----
const closestBtn = (e: Event, sel: string) => (e.target as Element).closest<HTMLButtonElement>(sel);
function syncScaleUi() {
  for (const b of $("scaleBtns").children) b.setAttribute("aria-pressed", String(+(b as HTMLElement).dataset.s! === prefs.scale));
  $in("lineWidth").max = String(prefs.scale);
  if (prefs.width > prefs.scale) prefs.width = prefs.scale;
  $in("lineWidth").value = String(prefs.width);
  $("widthVal").textContent = prefs.width + "px";
}
$("scaleBtns").addEventListener("click", (e) => {
  const b = closestBtn(e, "button[data-s]");
  if (!b) return;
  prefs.scale = +b.dataset.s! as Scale; savePrefs(); syncScaleUi(); schedule();
});
function syncFrameUi() {
  const f = state.frame;
  $in("frameOn").checked = f.on;
  $in("cols").value = String(f.cols); $in("rows").value = String(f.rows);
  $in("cols").disabled = $in("rows").disabled = !f.on;
  syncCellInfo();
}
function syncCellInfo() {
  const f = state.frame, img = state.img;
  if (img && f.on) {
    const cw = Math.floor(img.w / f.cols), ch = Math.floor(img.h / f.rows);
    const rest = img.w % f.cols || img.h % f.rows;
    $("cellInfo").textContent = `1コマ ${cw}×${ch}px` + (rest ? "（割り切れない端は切り捨てます）" : "");
  } else $("cellInfo").textContent = "隣のコマの色が境目ににじまないよう、1コマずつ別々に拡大します。";
}
$in("frameOn").addEventListener("change", () => { state.frame.on = $in("frameOn").checked; syncFrameUi(); schedule(); });
for (const id of ["cols", "rows"] as const) {
  const el = $in(id);
  const read = () => {
    const v = Math.max(1, Math.min(256, Math.floor(+el.value || 1)));
    state.frame[id] = Math.min(v, id === "cols" ? state.img!.w : state.img!.h);
  };
  // 入力中は欄を書き換えない（消して打ち直す途中で値が変わらないように）。確定したら丸めた値を書き戻す
  el.addEventListener("input", () => { if (el.value === "") return; read(); syncCellInfo(); schedule(); });
  el.addEventListener("change", () => { read(); syncFrameUi(); schedule(); });
}

// ---- 輪郭 ----
const hex = (c: number) => "#" + [c & 255, (c >>> 8) & 255, (c >>> 16) & 255].map((v) => v.toString(16).padStart(2, "0")).join("");
function renderSwatches() {
  const box = $("swatches");
  box.textContent = "";
  const shown = state.palette.slice(0, 64);
  for (const c of shown) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "sw"; b.style.background = hex(c);
    b.title = hex(c); b.setAttribute("aria-label", "輪郭の色 " + hex(c));
    b.setAttribute("aria-pressed", String(state.outline.has(c)));
    b.addEventListener("click", () => {
      if (state.outline.has(c)) state.outline.delete(c); else state.outline.add(c);
      b.setAttribute("aria-pressed", String(state.outline.has(c)));
      updatePalInfo(); schedule();
    });
    box.appendChild(b);
  }
  updatePalInfo();
}
function updatePalInfo() {
  const n = state.outline.size, more = state.palette.length > 64 ? `（多い順に64色まで表示）` : "";
  $("palInfo").textContent = (n ? `${n}色を輪郭として扱います` : "輪郭の色が選ばれていません") + more;
}
$("btnAutoOutline").addEventListener("click", () => {
  const a = analyze(state.img!);
  state.outline = new Set(a.auto != null ? [a.auto] : []);
  renderSwatches(); schedule();
});
$in("lineWidth").addEventListener("input", () => { prefs.width = +$in("lineWidth").value; $("widthVal").textContent = prefs.width + "px"; savePrefs(); schedule(); });
$in("innerOn").addEventListener("change", () => { prefs.inner = $in("innerOn").checked; savePrefs(); schedule(); });
$in("dotKeep").addEventListener("input", () => { prefs.dotKeep = +$in("dotKeep").value; syncDotUi(); savePrefs(); schedule(); });
function syncDotUi() { $("dotVal").textContent = prefs.dotKeep ? `${prefs.dotKeep}ドット以下` : "なし"; }

// ---- 左右の結果 ----
for (let i = 0; i < 2; i++) {
  const sel = $<HTMLSelectElement>("m" + i);
  for (const m of METHODS) sel.add(new Option(m.label, m.id));
  sel.addEventListener("change", () => { prefs.panes[i].method = sel.value as MethodId; savePrefs(); schedule(); });
  $in("t" + i).addEventListener("change", () => { prefs.panes[i].thin = $in("t" + i).checked; savePrefs(); schedule(); });
  $("d" + i).addEventListener("click", () => savePane(i));
}
function syncPaneUi() {
  for (let i = 0; i < 2; i++) { $<HTMLSelectElement>("m" + i).value = prefs.panes[i].method; $in("t" + i).checked = prefs.panes[i].thin; }
}

let timer = 0;
let renderCount = 0; // 再計算の回数（テストで待ち合わせに使う）
function schedule() {
  clearTimeout(timer);
  $("busy").hidden = false;
  timer = window.setTimeout(run, 30);
}
function run() {
  const img = state.img;
  if (!img) return;
  const f = state.frame.on ? { cols: state.frame.cols, rows: state.frame.rows } : null;
  const outW = (f ? Math.floor(img.w / f.cols) * f.cols : img.w) * prefs.scale;
  const outH = (f ? Math.floor(img.h / f.rows) * f.rows : img.h) * prefs.scale;
  if (outW * outH > 4096 * 4096) {
    $("busy").hidden = true;
    IT.toast(`出力が ${outW}×${outH}px になり大きすぎます。倍率を下げてください`);
    return;
  }
  const thin = { outline: state.outline, palette: state.palette, width: prefs.width, inner: prefs.inner, dotKeep: prefs.dotKeep };
  for (let i = 0; i < 2; i++) {
    const p = prefs.panes[i], t0 = performance.now();
    let r;
    try {
      r = render(img, { method: p.method, scale: prefs.scale, frame: f, thin: p.thin ? thin : null });
    } catch (e) {
      console.error(e);
      IT.toast("処理できませんでした（" + (e as Error).message + "）");
      state.results[i] = null;
      $cv("c" + i).width = 1; $cv("c" + i).height = 1;
      $btn("d" + i).disabled = true;
      continue;
    }
    const ms = Math.round(performance.now() - t0);
    state.results[i] = r;
    $btn("d" + i).disabled = false;
    const cv = $cv("c" + i);
    cv.width = r.w; cv.height = r.h;
    cv.getContext("2d")!.putImageData(toImageData(r), 0, 0);
    $("s" + i).textContent = `${r.w}×${r.h}px  ${ms}ms`;
    const notes = [r.note];
    if (p.thin && !state.outline.size) notes.push("輪郭の色が選ばれていないため、細くしていません");
    const n = notes.filter(Boolean).join("。");
    $("n" + i).textContent = n; $("n" + i).hidden = !n;
  }
  $("busy").hidden = true;
  renderCount++;
  applyZoom();
}

// ---- 表示 ----
function applyZoom() {
  for (const b of $("zoomBtns").children) b.setAttribute("aria-pressed", String((b as HTMLElement).dataset.z === String(prefs.zoom)));
  for (const b of $("bgBtns").children) b.setAttribute("aria-pressed", String((b as HTMLElement).dataset.bg === prefs.bg));
  for (let i = 0; i < 2; i++) {
    const v = $("v" + i), cv = $cv("c" + i), r = state.results[i];
    v.classList.toggle("fit", prefs.zoom === "fit");
    v.classList.toggle("bg-checker", prefs.bg === "checker");
    v.classList.toggle("bg-white", prefs.bg === "white");
    v.classList.toggle("bg-black", prefs.bg === "black");
    if (!r) continue;
    if (prefs.zoom === "fit") {
      // 枠に収まる最大の整数倍（収まらなければ縮小）
      const bw = Math.max(1, v.clientWidth - 24), bh = Math.max(1, v.clientHeight - 24);
      const k = Math.min(bw / r.w, bh / r.h);
      const z = k >= 1 ? Math.floor(k) : k;
      cv.style.width = r.w * z + "px"; cv.style.height = r.h * z + "px";
    } else {
      const z = +prefs.zoom / (window.devicePixelRatio || 1);
      cv.style.width = r.w * z + "px"; cv.style.height = r.h * z + "px";
    }
  }
}
$("zoomBtns").addEventListener("click", (e) => {
  const b = closestBtn(e, "button[data-z]");
  if (!b) return;
  prefs.zoom = b.dataset.z === "fit" ? "fit" : (+b.dataset.z! as Zoom); savePrefs(); applyZoom();
});
$("bgBtns").addEventListener("click", (e) => {
  const b = closestBtn(e, "button[data-bg]");
  if (!b) return;
  prefs.bg = b.dataset.bg as Bg; savePrefs(); applyZoom();
});
window.addEventListener("resize", () => { if (prefs.zoom === "fit") applyZoom(); });

// 左右のスクロールを連動させ、ドラッグで動かせるようにする
for (let i = 0; i < 2; i++) {
  const v = $("v" + i), o = $("v" + (1 - i));
  v.addEventListener("scroll", () => {
    if (o.scrollLeft !== v.scrollLeft) o.scrollLeft = v.scrollLeft;
    if (o.scrollTop !== v.scrollTop) o.scrollTop = v.scrollTop;
  });
  let drag: { x: number; y: number; l: number; t: number } | null = null;
  v.addEventListener("pointerdown", (e) => {
    if (prefs.zoom === "fit" || e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, l: v.scrollLeft, t: v.scrollTop };
    v.setPointerCapture(e.pointerId); v.classList.add("dragging");
  });
  v.addEventListener("pointermove", (e) => {
    if (!drag) return;
    v.scrollLeft = drag.l - (e.clientX - drag.x); v.scrollTop = drag.t - (e.clientY - drag.y);
  });
  const end = () => { drag = null; v.classList.remove("dragging"); };
  v.addEventListener("pointerup", end); v.addEventListener("pointercancel", end);
}

// ---- 保存 ----
async function savePane(i: number) {
  const r = state.results[i];
  if (!r) return;
  const p = prefs.panes[i], cv = $cv("c" + i);
  // 列x行は付け直すので、コマごとに拡大したときだけ元の名前から外す
  const stem = (gridSuffix() && stripGrid(state.name)) || state.name;
  const name = `${stem}_x${prefs.scale}_${p.method}${p.thin ? "_thin" : ""}${gridSuffix()}.png`;
  try { await IT.saveFile(name, await IT.canvasToBlob(cv)); }
  catch { IT.toast("PNG を作れませんでした"); }
}

$("btnResetPrefs").addEventListener("click", () => {
  prefs = structuredClone(DEFAULTS); savePrefs();
  syncAll(); applyZoom(); schedule();
  IT.toast("設定をリセットしました");
});
function syncAll() {
  syncScaleUi(); syncPaneUi(); syncDotUi();
  $in("innerOn").checked = prefs.inner; $in("dotKeep").value = String(prefs.dotKeep);
}

// テストから中の状態を見られるようにする（単体 HTML だった頃のグローバル変数と同じ名前）
Object.assign(window, { state, PU: { METHODS, render, analyze, plan } });
Object.defineProperty(window, "renderCount", { get: () => renderCount });

syncAll();
setImage(makeSample(), "sample", true);
// シート仕上げの「拡大ツールで開く」から開かれたときは、渡されたシートを読む（届くまではサンプルのまま）
IT.receive((files) => loadFile(files[0]));
