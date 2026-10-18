/* シート仕上げの画面 */
import { IT } from "@common/it";
import {
  actionsOf, asepriteJsonOf, baseOf, bboxOf, clonePx, exportSetsOf, forgetBbox, guessGrid, hexRgb, lastGrid, layoutOf as layoutIn, line,
  pngNameOf, rgbHex, safeName,
  type Box, type ExportVar, type Frame, type Layout, type Pos, type PxObj, type SheetSet, type Variant,
} from "./sheet";
import { FDEF, FHINT, keyOut, medianCut, runFilter, sheetColors, type FilterCtx, type FilterParams, type FilterType } from "./filters";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const $in = (id: string) => $<HTMLInputElement>(id);
const $btn = (id: string) => $<HTMLButtonElement>(id);
const $sel = (id: string) => $<HTMLSelectElement>(id);
const ctx2d = (c: HTMLCanvasElement, opts?: CanvasRenderingContext2DSettings) => c.getContext("2d", opts)!;

type Tool = "pen" | "eraser" | "picker" | "fill" | "select" | "move";
type Guide = { axis: "h" | "v"; pos: number; hidden?: boolean };
type FilterPrefs = { type: FilterType; noNew: boolean; keep: boolean; scope: "sel" | "act" | "all"; v: Record<string, number | string | boolean> };
type Settings = {
  fps: number; playMode: "fps" | "dur"; loopMode: "loop" | "ping"; animZoom: number; animBg: string; edZoom: number; tool: Tool; color: string;
  mirror: boolean; onion: boolean; diff: boolean; grid: boolean; alignMode: "bottom" | "center"; skipEmpty: boolean;
  onionLoop: boolean; showGuides: boolean; guidesInAnim: boolean; guides: Guide[]; sideW: number; animH: number; stripH: number;
  exportVar: ExportVar; cellAnchor: "b" | "c" | "tl"; bgTol: number; bgMode: "outer" | "all";
  filter: FilterPrefs;
};
type ToggleKey = "mirror" | "onion" | "diff" | "grid" | "onionLoop" | "showGuides";

const SKEY = "sprite-polish:settings";
const DEF: Settings = { fps: 10, playMode: "fps", loopMode: "loop", animZoom: 0, animBg: "checker", edZoom: 0, tool: "pen", color: "#2b2b2b", mirror: false, onion: true, diff: false, grid: true, alignMode: "bottom", skipEmpty: true,
  onionLoop: true, showGuides: true, guidesInAnim: true, guides: [], sideW: 300, animH: 260, stripH: 270,
  exportVar: "rows", cellAnchor: "b", bgTol: 16, bgMode: "outer",
  filter: { type: "blur", noNew: true, keep: true, scope: "sel", v: {} } };
let S: Settings = Object.assign(structuredClone(DEF), IT.store.get<Partial<Settings>>(SKEY, {}));
S.filter = Object.assign({}, DEF.filter, S.filter || {}); S.filter.v = Object.assign({}, S.filter.v);
S.guides = Array.isArray(S.guides) ? S.guides.filter((g) => g && (g.axis === "h" || g.axis === "v") && Number.isFinite(g.pos)) : [];
const saveS = () => IT.store.set(SKEY, S);

// ---- 作業データ ----
// アクション = シートの1行。doc.frames はアクションごとにまとまった順に並べておく（regroup）
// セル上の位置 = コマ内の座標 + ずらし。px は書き換えずに作り直す（元に戻すの履歴が古い px を持つため）
type Doc = { name: string; src: HTMLCanvasElement; cw: number; ch: number; cols: number; frames: Frame[]; variants: Variant[]; tagDir: Record<string, string> };
type Snap = { frames: Frame[]; variants: Variant[]; cw: number; ch: number; cols: number; tagDir: Record<string, string>; cur: number; sel: number[] };
type Float = { img: ImageData; x: number; y: number; fid: number; T: PxObj };
let doc: Doc | null = null;
// パーツはコマの絵の上に重ねる。位置（at）が無いコマには貼らない
let shownVar = 0;     // 表示している差分の id（0 = 元の絵）
let editPart = false; // ペンなどで差分パーツの方を描く
let cur = 0, selSet = new Set<number>(), anchor = 0;
let undoStack: Snap[] = [], redoStack: Snap[] = [];
let selRect: Box | null = null;   // 範囲選択（セル座標）{x,y,w,h}
let float: Float | null = null;   // 浮いている選択範囲 { img: ImageData, x, y, fid }
let clip: ImageData | null = null; // コピーした絵 ImageData
let palette: number[][] = [];
let nextId = 1;
let isSample = false;

const pxCanvas = new WeakMap<ImageData, HTMLCanvasElement>();
function canvasOf(px: ImageData): HTMLCanvasElement {
  let c = pxCanvas.get(px);
  if (!c) { c = document.createElement("canvas"); c.width = px.width; c.height = px.height; ctx2d(c).putImageData(px, 0, 0); pxCanvas.set(px, c); }
  return c;
}
function refreshPx(px: ImageData) { const c = pxCanvas.get(px); if (c) ctx2d(c).putImageData(px, 0, 0); forgetBbox(px); }
// セル上での絵の範囲
function cellBox(f: PxObj): Box | null { const b = bboxOf(f.px); return b && { x: b.x + f.lx + f.dx, y: b.y + f.ly + f.dy, w: b.w, h: b.h }; }
function overflows(f: Frame) { const b = cellBox(f); return !!b && (b.x < 0 || b.y < 0 || b.x + b.w > doc!.cw || b.y + b.h > doc!.ch); }
function compose(f: PxObj | null | undefined, c?: HTMLCanvasElement): HTMLCanvasElement {
  c = c || document.createElement("canvas");
  c.width = doc!.cw; c.height = doc!.ch;
  const x = ctx2d(c); x.clearRect(0, 0, c.width, c.height);
  if (f) x.drawImage(canvasOf(f.px), f.lx + f.dx, f.ly + f.dy);
  return c;
}
function curVar(): Variant | null { return (doc && doc.variants.find((v) => v.id === shownVar)) || null; }
// 差分を重ねた絵（v = null なら元の絵）
function composeVar(f: PxObj | null | undefined, v: Variant | null, c?: HTMLCanvasElement): HTMLCanvasElement {
  c = compose(f, c);
  const p = v && f && v.at[f.id];
  // パーツの位置はコマのずらし (dx, dy) からの相対。コマを動かすとパーツも付いてくる
  if (p) ctx2d(c).drawImage(canvasOf(v.img), v.lx + p.x + f.dx, v.ly + p.y + f.dy);
  return c;
}
function composeShown(f: PxObj | null | undefined, c?: HTMLCanvasElement) { return composeVar(f, curVar(), c); }
const cloneAt = (at: Record<number, Pos>): Record<number, Pos> => Object.fromEntries(Object.entries(at).map(([k, p]) => [k, { ...p }]));
function newFrame(px: ImageData, extra?: Partial<Frame>): Frame { return Object.assign({ id: nextId++, px, lx: 0, ly: 0, dx: 0, dy: 0, dur: Math.round(1000 / S.fps), tag: "anim1" }, extra || {}); }

// ---- 元に戻す / やり直し ----
function snap(): Snap { const d = doc!; return { frames: d.frames.map((f) => ({ ...f })), variants: d.variants.map((v) => ({ ...v, at: cloneAt(v.at) })), cw: d.cw, ch: d.ch, cols: d.cols, tagDir: { ...d.tagDir }, cur, sel: [...selSet] }; }
function restore(s: Snap) { const d = doc!; d.frames = s.frames.map((f) => ({ ...f })); d.variants = s.variants.map((v) => ({ ...v, at: cloneAt(v.at) })); d.cw = s.cw; d.ch = s.ch; d.cols = s.cols; d.tagDir = { ...s.tagDir }; cur = s.cur; selSet = new Set(s.sel); }
// 履歴の数は絵の大きさで決める（1手ごとに全コマの絵が残ると考えて、合計がおよそ 512MB を超えないように。10〜100手）
function undoLimit() {
  let bytes = 0;
  for (const f of doc!.frames) bytes += f.px.data.length;
  for (const v of doc!.variants) bytes += v.img.data.length;
  return Math.max(10, Math.min(100, Math.floor(512e6 / Math.max(1, bytes))));
}
function commit() { if (!doc) return; undoStack.push(snap()); const n = undoLimit(); while (undoStack.length > n) undoStack.shift(); redoStack = []; syncUndo(); }
function undo() { if (!undoStack.length) return; stampFloat(); redoStack.push(snap()); restore(undoStack.pop()!); clampCur(); refreshAll(); }
function redo() { if (!redoStack.length) return; stampFloat(); undoStack.push(snap()); restore(redoStack.pop()!); clampCur(); refreshAll(); }
function syncUndo() { $btn("btnUndo").disabled = !undoStack.length; $btn("btnRedo").disabled = !redoStack.length; scheduleAutosave(); }
function clampCur() { const d = doc!; cur = Math.max(0, Math.min(d.frames.length - 1, cur)); selSet = new Set([...selSet].filter((i) => i < d.frames.length)); if (!selSet.size && d.frames.length) selSet.add(cur); }

// 絵を描き換える前に呼ぶ。履歴を積み（noCommit なら積まない）、px を複製してセル全体を覆う大きさに広げる
function beginEdit(f: PxObj, noCommit?: boolean) {
  if (!noCommit) commit();
  const w = f.px.width, h = f.px.height;
  const x0 = Math.min(f.lx, -f.dx), y0 = Math.min(f.ly, -f.dy);
  const x1 = Math.max(f.lx + w, doc!.cw - f.dx), y1 = Math.max(f.ly + h, doc!.ch - f.dy);
  if (x0 === f.lx && y0 === f.ly && x1 === f.lx + w && y1 === f.ly + h) { f.px = clonePx(f.px); return; }
  const n = new ImageData(x1 - x0, y1 - y0), ox = f.lx - x0, oy = f.ly - y0;
  for (let y = 0; y < h; y++) n.data.set(f.px.data.subarray(y * w * 4, (y + 1) * w * 4), ((y + oy) * n.width + ox) * 4);
  f.px = n; f.lx = x0; f.ly = y0;
}
// 描く先。元の絵ならコマそのもの、差分パーツなら今のコマに貼った位置で見た仮のコマ（無ければ null）
function editObj(): PxObj | null {
  const f = doc!.frames[cur];
  if (!editPart) return f;
  const v = curVar(), p = v && v.at[f.id];
  return p ? { part: v, px: v.img, lx: v.lx, ly: v.ly, dx: p.x + f.dx, dy: p.y + f.dy, id: f.id } : null;
}
function beginEditT(T: PxObj) { beginEdit(T); if (T.part) { T.part.img = T.px; T.part.lx = T.lx; T.part.ly = T.ly; } }
function noTarget() { IT.toast(curVar() ? "このコマには差分パーツが貼られていません。「このコマに貼る」を押してください" : "表示する差分を選んでください"); }
function pIndex(f: PxObj, cx: number, cy: number) {
  const x = cx - f.dx - f.lx, y = cy - f.dy - f.ly;
  if (x < 0 || y < 0 || x >= f.px.width || y >= f.px.height) return -1;
  return (y * f.px.width + x) * 4;
}
function getPx(f: PxObj, cx: number, cy: number): number[] { const i = pIndex(f, cx, cy); return i < 0 ? [0, 0, 0, 0] : [...f.px.data.subarray(i, i + 4)]; }
function setPx(f: PxObj, cx: number, cy: number, c: ArrayLike<number>) {
  if (cx < 0 || cy < 0 || cx >= doc!.cw || cy >= doc!.ch) return;
  const i = pIndex(f, cx, cy); if (i >= 0) f.px.data.set(c, i);
}

// ---- 読み込み ----
function cutCells(src: HTMLCanvasElement, cols: number, rows: number, skipEmpty: boolean) {
  // 列・行は画像の幅・高さを超えない（セルが 0px にならないように）
  cols = Math.max(1, Math.min(cols, src.width)); rows = Math.max(1, Math.min(rows, src.height));
  const cw = Math.floor(src.width / cols), ch = Math.floor(src.height / rows);
  const x = ctx2d(src, { willReadFrequently: true });
  const frames: Frame[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const px = x.getImageData(c * cw, r * ch, cw, ch);
    if (skipEmpty && !bboxOf(px)) continue;
    frames.push(newFrame(px, { tag: "anim" + (r + 1) }));
  }
  return { cw, ch, frames };
}
function setDoc(name: string, src: HTMLCanvasElement, cw: number, ch: number, cols: number, frames: Frame[], variants?: Variant[]) {
  float = null; selRect = null; undoStack = []; redoStack = [];
  doc = { name, src, cw, ch, cols, frames, variants: variants || [], tagDir: {} };
  shownVar = 0; editPart = false;
  cur = 0; selSet = new Set(frames.length ? [0] : []); anchor = 0;
  $in("baseName").value = baseOf(name);
  $sel("playTag").value = "@cur";
  countPalette();
  refreshAll();
}
async function toCanvas(fileOrBlob: Blob): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(fileOrBlob);
  const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height;
  ctx2d(c, { willReadFrequently: true }).drawImage(bmp, 0, 0); if (bmp.close) bmp.close();
  return c;
}
async function loadFiles(files: File[]) {
  const img = files.find((f) => f.type.startsWith("image/"));
  const js = files.find((f) => /\.json$/i.test(f.name) || f.type === "application/json");
  if (js && !img) {
    try { const data = JSON.parse(await js.text()) as WorkFile; if (data.app === WORK_APP) { await openWork(data, js.name); return; } } catch { /* 下で案内する */ }
    IT.toast("作業ファイルではない JSON です。Aseprite の JSON はシート画像と一緒にドロップしてください"); return;
  }
  if (!img) { IT.toast("画像ファイルが見つかりませんでした"); return; }
  let src: HTMLCanvasElement;
  try { src = await toCanvas(img); } catch { IT.toast(img.name + " を読み込めませんでした"); return; }
  isSample = false; $("sampleNote").hidden = true;
  if (js) {
    try {
      const data = JSON.parse(await js.text()) as AseJson;
      if (fromJson(img.name, src, data)) { $("srcNote").textContent = img.name + "（" + src.width + "×" + src.height + "）と " + js.name + " から " + doc!.frames.length + " コマ"; return; }
    } catch { IT.toast("JSON を読めなかったので、ファイル名から分割します"); }
  }
  const g = lastGrid(img.name) || guessGrid(src);
  g[0] = Math.min(g[0], src.width); g[1] = Math.min(g[1], src.height);
  $in("gCols").value = String(g[0]); $in("gRows").value = String(g[1]);
  const r = cutCells(src, g[0], g[1], S.skipEmpty);
  setDoc(img.name, src, r.cw, r.ch, g[0], r.frames);
  $("srcNote").textContent = img.name + "（" + src.width + "×" + src.height + "）を " + g[0] + "×" + g[1] + " で分割、" + r.frames.length + " コマ" + (lastGrid(img.name) ? "" : "（ファイル名に列x行が無いので推定）");
}
// Aseprite 互換 JSON（配列形式・ハッシュ形式）
type Rect = { x: number; y: number; w: number; h: number };
type AseFrame = { frame: Rect; trimmed?: boolean; spriteSourceSize?: Rect; sourceSize?: { w: number; h: number }; duration?: number };
type AseJson = { frames?: AseFrame[] | Record<string, AseFrame>; meta?: { frameTags?: { name: string; from: number; to: number; direction?: string }[] } };
// Aseprite 互換 JSON（配列形式・ハッシュ形式）からコマを切り出す
function fromJson(name: string, src: HTMLCanvasElement, data: AseJson) {
  const list = Array.isArray(data.frames) ? data.frames : Object.values(data.frames || {});
  if (!list.length) return false;
  let cw = 0, ch = 0;
  for (const f of list) { const s = f.sourceSize || f.frame; cw = Math.max(cw, s.w); ch = Math.max(ch, s.h); }
  const x = ctx2d(src, { willReadFrequently: true });
  const frames = list.map((f) => {
    const r = f.frame, sp = f.trimmed && f.spriteSourceSize ? f.spriteSourceSize : { x: 0, y: 0 };
    return newFrame(x.getImageData(r.x, r.y, r.w, r.h), { lx: sp.x, ly: sp.y, dur: f.duration || Math.round(1000 / S.fps) });
  });
  // タグの無いコマは "default" にまとめる（1行 = 1アクション）
  frames.forEach((f) => (f.tag = "default"));
  const tagDir: Record<string, string> = {};
  for (const t of (data.meta && data.meta.frameTags) || []) {
    for (let i = t.from; i <= t.to && i < frames.length; i++) frames[i].tag = t.name;
    if (t.direction && t.direction !== "forward") tagDir[t.name] = t.direction;
  }
  const cols = Math.max(1, Math.round(src.width / cw));
  $in("gCols").value = String(cols); $in("gRows").value = String(Math.max(1, Math.round(src.height / ch)));
  setDoc(name, src, cw, ch, cols, frames);
  doc!.tagDir = tagDir;
  // コマごとの時間が FPS と合わなければ、再生も書き出しも「コマごとの時間」にする（読んで保存しただけで時間が変わらないように）
  if (frames.some((f) => f.dur !== Math.round(1000 / S.fps)) && S.playMode !== "dur") { S.playMode = "dur"; $sel("playMode").value = "dur"; saveS(); IT.toast("JSON のコマごとの時間を使って再生・書き出しします"); }
  return true;
}
$btn("btnSplit").addEventListener("click", () => {
  if (!doc) return;
  const c = Math.max(1, Math.min(256, doc.src.width, Math.round(+$in("gCols").value) || 1)), r = Math.max(1, Math.min(256, doc.src.height, Math.round(+$in("gRows").value) || 1));
  $in("gCols").value = String(c); $in("gRows").value = String(r);
  if (float) stampFloat();
  commit();
  const res = cutCells(doc.src, c, r, S.skipEmpty);
  float = null; selRect = null;
  doc.cw = res.cw; doc.ch = res.ch; doc.cols = c; doc.frames = res.frames;
  cur = 0; selSet = new Set(res.frames.length ? [0] : []);
  refreshAll();
  IT.toast(c + "×" + r + " で読み直しました（" + res.frames.length + " コマ）");
});
$in("gSkipEmpty").addEventListener("change", (e) => { S.skipEmpty = (e.target as HTMLInputElement).checked; saveS(); });

// ---- サンプル（コードで描くスライム。確認用にわざと崩してある） ----
function makeSample() {
  const cw = 32, ch = 32, cols = 8, rows = 2;
  const c = document.createElement("canvas"); c.width = cw * cols; c.height = ch * rows;
  const x = ctx2d(c, { willReadFrequently: true });
  const OUT = [34, 52, 40], BODY = [92, 186, 96], DARK = [58, 140, 70], HI = [200, 240, 190], EYE = [26, 30, 34];
  // 0〜7 = 跳ねる、8〜11 = 待機（息をするように少し伸び縮み）
  const lift = [0, 0, 2, 5, 7, 5, 2, 0, 0, 0, 0, 0], sq = [1.0, 0.86, 1.04, 1.1, 1.08, 1.06, 0.98, 0.9, 1.0, 0.96, 0.93, 0.96];
  const order = [0, 1, 2, 3, 4, 6, 5, 7, 8, 9, 10, 11]; // 6コマ目と7コマ目を入れ替えておく
  const eyes: Pos[] = [];
  order.forEach((k, slot) => {
    const img = x.createImageData(cw, ch), d = img.data;
    const a = 11 / Math.sqrt(sq[k]), b = 9 * sq[k], cx = 15.5, bottom = 29 - lift[k], cy = bottom - b;
    const inside = (px: number, py: number) => ((px - cx) / a) ** 2 + ((py - cy) / b) ** 2 <= 1 && py <= bottom;
    const put = (px: number, py: number, col: number[]) => { if (px < 0 || py < 0 || px >= cw || py >= ch) return; const i = (py * cw + px) * 4; d[i] = col[0]; d[i + 1] = col[1]; d[i + 2] = col[2]; d[i + 3] = 255; };
    for (let py = 0; py < ch; py++) for (let px = 0; px < cw; px++) {
      const p = [px + 0.5, py + 0.5] as const;
      if (!inside(...p)) continue;
      const edge = !inside(p[0] - 1, p[1]) || !inside(p[0] + 1, p[1]) || !inside(p[0], p[1] - 1) || !inside(p[0], p[1] + 1);
      put(px, py, edge ? OUT : (py > cy + b * 0.45 ? DARK : BODY));
    }
    const ey = Math.round(cy - b * 0.05);
    eyes[slot] = { x: 11 + (slot === 4 ? 2 : 0), y: ey };
    for (const ex of [11, 19]) for (let j = 0; j < 3; j++) { put(ex, ey + j, EYE); put(ex + 1, ey + j, EYE); }
    put(9, Math.round(cy - b * 0.55), HI); put(10, Math.round(cy - b * 0.6), HI); put(9, Math.round(cy - b * 0.4), HI);
    if (lift[k] >= 5) for (let px = 11; px <= 20; px++) put(px, 30, [0, 0, 0].map(() => 60)); // 影
    let ox = (slot < 8 ? slot : slot - 8) * cw;
    const oy = (slot < 8 ? 0 : 1) * ch;
    if (slot === 4) ox += 2;                 // 5コマ目を右へ 2px ずらしておく
    x.putImageData(img, ox, oy);
    if (slot === 2) { x.fillStyle = "rgb(92,186,96)"; x.fillRect(ox + 27, oy + 4, 1, 1); } // 3コマ目にゴミ点
  });
  // 目閉じの差分パーツ（両目のところを体の色で塗り、真ん中に線を引く）
  const part = new ImageData(10, 3);
  for (const px of [0, 1, 8, 9]) for (let py = 0; py < 3; py++) part.data.set([...(py === 1 ? EYE : BODY), 255], (py * 10 + px) * 4);
  return { canvas: c, eyes, part };
}
$btn("btnSample").addEventListener("click", () => {
  const smp = makeSample(), src = smp.canvas, name = "sample_slime_8x2.png";
  $in("gCols").value = "8"; $in("gRows").value = "2";
  const r = cutCells(src, 8, 2, true);
  r.frames.forEach((f) => (f.tag = f.tag === "anim1" ? "bounce" : "idle"));
  const blink: Variant = { id: nextId++, name: "目閉じ", img: smp.part, lx: 0, ly: 0, at: {} };
  r.frames.forEach((f, i) => (blink.at[f.id] = { ...smp.eyes[i] }));
  setDoc(name, src, r.cw, r.ch, 8, r.frames, [blink]);
  isSample = true; $("sampleNote").hidden = false;
  $("srcNote").textContent = "サンプル（32×32 のスライム。跳ねる 8 コマ + 待機 4 コマ、表情差分「目閉じ」付き）";
  refreshAll();
});

// ---- パレット ----
function countPalette() {
  const m = new Map<number, number>();
  if (doc) for (const f of [...doc.frames, ...doc.variants.map((v) => ({ px: v.img }))]) { const d = f.px.data; for (let i = 0; i < d.length; i += 4) if (d[i + 3]) { const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2]; m.set(k, (m.get(k) || 0) + 1); } }
  palette = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 64).map(([k]) => [(k >> 16) & 255, (k >> 8) & 255, k & 255]);
  renderPalette();
}
function renderPalette() {
  const el = $("palette"); el.textContent = "";
  if (!palette.length) { const p = document.createElement("span"); p.className = "hint"; p.textContent = "シートを読み込むと、使われている色が並びます"; el.appendChild(p); return; }
  for (const c of palette) {
    const b = document.createElement("button"), h = rgbHex(c);
    b.type = "button"; b.className = "swatch" + (h === S.color ? " on" : ""); b.style.background = h; b.title = h; b.setAttribute("aria-label", "色 " + h);
    b.addEventListener("click", () => setColor(h));
    el.appendChild(b);
  }
}
$btn("btnPal").addEventListener("click", countPalette);
function setColor(h: string) { S.color = h; saveS(); $in("color").value = h; $("colorHex").textContent = h; renderPalette(); }
$in("color").addEventListener("input", (e) => setColor((e.target as HTMLInputElement).value));

// ---- 道具と表示の切替 ----
function setTool(t: Tool) {
  if (float && t !== "select") stampFloat();
  if (t !== "select") selRect = null;
  S.tool = t; saveS();
  document.querySelectorAll<HTMLElement>("[data-tool]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tool === t)));
  const hints: Record<string, string> = { pen: "クリック・ドラッグで描く。右クリックで消す", eraser: "ドラッグで消す", picker: "クリックした所の色を拾う", fill: "同じ色でつながった所を塗る", select: "ドラッグで範囲を選ぶ。範囲の中をドラッグで移動、Enter で確定", move: "ドラッグで選んだコマをずらす" };
  $("edHint").textContent = hints[t] || "";
  $("ed").classList.toggle("t-move", t === "move");
  drawEditor();
}
document.querySelectorAll<HTMLElement>("[data-tool]").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool as Tool)));
function bindToggle(id: string, key: ToggleKey) {
  const b = $(id);
  const sync = () => b.setAttribute("aria-pressed", String(!!S[key]));
  b.addEventListener("click", () => { S[key] = !S[key]; saveS(); sync(); drawEditor(); });
  sync();
  return () => { S[key] = !S[key]; saveS(); sync(); drawEditor(); };
}
const toggleMirror = bindToggle("tMirror", "mirror"), toggleOnion = bindToggle("tOnion", "onion"), toggleDiff = bindToggle("tDiff", "diff");
bindToggle("tGrid", "grid");
bindToggle("tOnionLoop", "onionLoop");
const toggleGuides = bindToggle("tGuides", "showGuides");
$sel("edZoom").addEventListener("change", (e) => { S.edZoom = +(e.target as HTMLSelectElement).value; saveS(); drawEditor(); });

// 同じアクションの中で i の前（d = -1）・後（d = 1）のコマ。端では設定に従ってループするか、無し（-1）
function neighbor(i: number, d: number) {
  const t = doc!.frames[i].tag, idx: number[] = [];
  doc!.frames.forEach((f, k) => { if (f.tag === t) idx.push(k); });
  const p = idx.indexOf(i) + d;
  if (p >= 0 && p < idx.length) return idx[p];
  return S.onionLoop && idx.length > 1 ? idx[(p + idx.length) % idx.length] : -1;
}
// 基準ライン（セルの上端・左端からのドット数の位置に線を引く）
function drawGuides(ctx: CanvasRenderingContext2D, z: number, w: number, h: number) {
  if (!S.showGuides) return;
  ctx.save(); ctx.lineWidth = z >= 8 ? 2 : 1;
  const off = z >= 8 ? 0 : 0.5;
  for (const g of S.guides) {
    if (g.hidden) continue;
    ctx.strokeStyle = g.axis === "h" ? "rgba(0,184,217,.95)" : "rgba(255,139,0,.95)";
    ctx.beginPath();
    if (g.axis === "h") { const y = Math.round(g.pos * z) + off; ctx.moveTo(0, y); ctx.lineTo(w, y); }
    else { const x = Math.round(g.pos * z) + off; ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    ctx.stroke();
  }
  ctx.restore();
}

// ---- ドット編集の表示 ----
const ed = $<HTMLCanvasElement>("ed"), ectx = ctx2d(ed);
let edZ = 8;
const work = document.createElement("canvas"), tintC = document.createElement("canvas");
ctx2d(work, { willReadFrequently: true }); // ドットの色を読む（スポイト・差分表示）ので先に指定しておく
// 浮いている選択範囲を、合成した絵の上に重ねる
function drawFloat(c: HTMLCanvasElement, fl: Float) { const t = document.createElement("canvas"); t.width = fl.img.width; t.height = fl.img.height; ctx2d(t).putImageData(fl.img, 0, 0); ctx2d(c).drawImage(t, fl.x, fl.y); }
function tinted(f: Frame, rgb: string) {
  composeShown(f, tintC);
  const x = ctx2d(tintC);
  x.globalCompositeOperation = "source-in"; x.fillStyle = rgb; x.fillRect(0, 0, tintC.width, tintC.height); x.globalCompositeOperation = "source-over";
  return tintC;
}
function drawEditor() {
  if (!doc || !doc.frames.length) { ed.width = 256; ed.height = 128; ectx.clearRect(0, 0, 256, 128); $("edTitle").textContent = ""; return; }
  const { cw, ch } = doc;
  edZ = S.edZoom || Math.max(1, Math.min(48, Math.floor(Math.min(Math.max(240, $("edStage").clientWidth - 26) / cw, Math.max(240, window.innerHeight * 0.75) / ch))));
  if (ed.width !== cw * edZ || ed.height !== ch * edZ) { ed.width = cw * edZ; ed.height = ch * edZ; }
  ectx.imageSmoothingEnabled = false;
  ectx.clearRect(0, 0, ed.width, ed.height);
  const f = doc.frames[cur];
  if (S.onion) {
    ectx.globalAlpha = 0.3;
    const p = neighbor(cur, -1), n = neighbor(cur, 1);
    if (p >= 0 && p !== cur) ectx.drawImage(tinted(doc.frames[p], "#e5484d"), 0, 0, ed.width, ed.height);
    if (n >= 0 && n !== cur && n !== p) ectx.drawImage(tinted(doc.frames[n], "#3e7bfa"), 0, 0, ed.width, ed.height);
    ectx.globalAlpha = 1;
  }
  const pv = filterPreview(f);
  composeShown(pv || f, work);
  if (float && float.fid === f.id) drawFloat(work, float);
  ectx.drawImage(work, 0, 0, ed.width, ed.height);
  const prev = neighbor(cur, -1);
  if (S.diff && prev >= 0 && prev !== cur) {
    const a = ctx2d(work).getImageData(0, 0, cw, ch).data, b = ctx2d(composeShown(doc.frames[prev])).getImageData(0, 0, cw, ch).data;
    ectx.fillStyle = "rgba(255,0,200,.5)";
    for (let i = 0, p = 0; i < a.length; i += 4, p++) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) ectx.fillRect((p % cw) * edZ, Math.floor(p / cw) * edZ, edZ, edZ);
  }
  const css = getComputedStyle(document.documentElement);
  if (S.grid && edZ >= 6) {
    ectx.strokeStyle = "rgba(128,128,128,.28)"; ectx.lineWidth = 1; ectx.beginPath();
    for (let i = 1; i < cw; i++) { ectx.moveTo(i * edZ + 0.5, 0); ectx.lineTo(i * edZ + 0.5, ed.height); }
    for (let i = 1; i < ch; i++) { ectx.moveTo(0, i * edZ + 0.5); ectx.lineTo(ed.width, i * edZ + 0.5); }
    ectx.stroke();
  }
  drawGuides(ectx, edZ, ed.width, ed.height);
  if (S.mirror) { ectx.strokeStyle = css.getPropertyValue("--warn"); ectx.setLineDash([4, 4]); ectx.beginPath(); ectx.moveTo(ed.width / 2 + 0.5, 0); ectx.lineTo(ed.width / 2 + 0.5, ed.height); ectx.stroke(); ectx.setLineDash([]); }
  // 差分パーツを描いているときは、パーツの範囲を点線で示す
  const v = curVar(), vp = v && v.at[f.id];
  if (editPart && v && vp) {
    const b = bboxOf(v.img) || { x: 0, y: 0, w: v.img.width, h: v.img.height };
    ectx.strokeStyle = "rgba(255,139,0,.9)"; ectx.setLineDash([3, 3]); ectx.lineWidth = 1;
    ectx.strokeRect((v.lx + vp.x + f.dx + b.x) * edZ + 0.5, (v.ly + vp.y + f.dy + b.y) * edZ + 0.5, b.w * edZ - 1, b.h * edZ - 1); ectx.setLineDash([]);
  }
  const r = float && float.fid === f.id ? { x: float.x, y: float.y, w: float.img.width, h: float.img.height } : selRect;
  if (r && S.tool === "select") {
    ectx.lineWidth = 1; ectx.strokeStyle = "#000"; ectx.strokeRect(r.x * edZ + 0.5, r.y * edZ + 0.5, r.w * edZ - 1, r.h * edZ - 1);
    ectx.setLineDash([4, 4]); ectx.strokeStyle = "#fff"; ectx.strokeRect(r.x * edZ + 0.5, r.y * edZ + 0.5, r.w * edZ - 1, r.h * edZ - 1); ectx.setLineDash([]);
  }
  $("edTitle").textContent = "#" + (cur + 1) + "  " + cw + "×" + ch + (v ? "  差分: " + v.name + (editPart ? "（パーツを描いています）" : "") : "") + (pv ? "  フィルタのプレビュー中" : "");
}

// ---- ドット編集の操作 ----
type Drag =
  | { kind: "paint"; f: PxObj; c: number[]; x: number; y: number }
  | { kind: "float"; sx: number; sy: number; fx: number; fy: number }
  | { kind: "rect"; sx: number; sy: number }
  | { kind: "move"; sx: number; sy: number; base: [Frame, number, number][]; keepRedo: Snap[] }
  | { kind: "movePart"; sx: number; sy: number; base: [Pos, number, number][]; keepRedo: Snap[] };
let drag: Drag | null = null;
function cellAt(e: PointerEvent): [number, number] {
  const r = ed.getBoundingClientRect();
  return [Math.floor((e.clientX - r.left) * doc!.cw / r.width), Math.floor((e.clientY - r.top) * doc!.ch / r.height)];
}
function plot(f: PxObj, x: number, y: number, c: number[]) { setPx(f, x, y, c); if (S.mirror) setPx(f, doc!.cw - 1 - x, y, c); }
function flood(f: PxObj, x: number, y: number, c: number[]) {
  const { cw, ch } = doc!;
  if (x < 0 || y < 0 || x >= cw || y >= ch) return;
  const t = getPx(f, x, y);
  if (t.every((v, i) => v === c[i])) return;
  const seen = new Uint8Array(cw * ch), st: [number, number][] = [[x, y]];
  while (st.length) {
    const [px, py] = st.pop()!;
    if (px < 0 || py < 0 || px >= cw || py >= ch || seen[py * cw + px]) continue;
    seen[py * cw + px] = 1;
    const v = getPx(f, px, py);
    if (v[0] !== t[0] || v[1] !== t[1] || v[2] !== t[2] || v[3] !== t[3]) continue;
    setPx(f, px, py, c);
    st.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
  }
}
const inRect = (r: Box | null, x: number, y: number) => r && x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
// 選択範囲を浮かせる（元の場所は透明にする）
function liftSelection() {
  const f = editObj();
  if (!f) { noTarget(); return false; }
  const sr = selRect!;
  beginEditT(f);
  const img = new ImageData(sr.w, sr.h);
  for (let y = 0; y < sr.h; y++) for (let x = 0; x < sr.w; x++) {
    const cx = sr.x + x, cy = sr.y + y;
    img.data.set(getPx(f, cx, cy), (y * sr.w + x) * 4);
    setPx(f, cx, cy, [0, 0, 0, 0]);
  }
  refreshPx(f.px);
  float = { img, x: sr.x, y: sr.y, fid: f.id, T: f };
  return true;
}
// 浮いている絵を下のコマへ置く（透明なドットは下を残す）
function stampFloat() {
  if (!float) return;
  const f = float.T;
  if (f) {
    const { img } = float;
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      if (img.data[i + 3]) setPx(f, float.x + x, float.y + y, img.data.subarray(i, i + 4));
    }
    refreshPx(f.px);
    selRect = { x: float.x, y: float.y, w: img.width, h: img.height };
  }
  float = null;
  renderStrip(); drawEditor();
}
ed.addEventListener("contextmenu", (e) => e.preventDefault());
ed.addEventListener("pointerdown", (e) => {
  if (!doc || !doc.frames.length) return;
  e.preventDefault();
  ed.setPointerCapture(e.pointerId);
  const [x, y] = cellAt(e), t = S.tool;
  if (t === "picker") { const c = shownAt(x, y); if (c[3]) setColor(rgbHex(c)); return; }
  if (t === "move") {
    const keepRedo = redoStack;
    commit();
    const targets = selSet.has(cur) ? [...selSet] : [cur];
    const v = curVar();
    if (editPart && v) {
      const base = targets.map((i) => v.at[doc!.frames[i].id]).filter(Boolean).map((p): [Pos, number, number] => [p, p.x, p.y]);
      if (!base.length) { drag = null; undoStack.pop(); redoStack = keepRedo; syncUndo(); noTarget(); }
      else drag = { kind: "movePart", sx: x, sy: y, base, keepRedo };
    } else drag = { kind: "move", sx: x, sy: y, base: targets.map((i): [Frame, number, number] => [doc!.frames[i], doc!.frames[i].dx, doc!.frames[i].dy]), keepRedo };
    drawEditor(); return;
  }
  const f = editObj();
  if (!f) { noTarget(); return; }
  if (t === "pen" || t === "eraser") {
    const c = t === "eraser" || e.button === 2 ? [0, 0, 0, 0] : hexRgb(S.color);
    beginEditT(f); plot(f, x, y, c); refreshPx(f.px);
    drag = { kind: "paint", f, c, x, y };
  } else if (t === "fill") {
    beginEditT(f); flood(f, x, y, e.button === 2 ? [0, 0, 0, 0] : hexRgb(S.color)); refreshPx(f.px); afterEdit(); return;
  } else if (t === "select") {
    const r = float ? { x: float.x, y: float.y, w: float.img.width, h: float.img.height } : selRect;
    if (inRect(r, x, y)) {
      if (!float && !liftSelection()) return;
      drag = { kind: "float", sx: x, sy: y, fx: float!.x, fy: float!.y };
    } else {
      stampFloat(); selRect = null;
      drag = { kind: "rect", sx: x, sy: y };
    }
  }
  drawEditor();
});
ed.addEventListener("pointermove", (e) => {
  if (!doc || !doc.frames.length) return;
  const [x, y] = cellAt(e);
  $("edPos").textContent = x >= 0 && y >= 0 && x < doc.cw && y < doc.ch ? "x " + x + "  y " + y + "  " + (() => { const c = shownAt(x, y); return c[3] ? rgbHex(c) : "透明"; })() : "—";
  if (!drag) return;
  if (drag.kind === "paint") { const d = drag; line(d.x, d.y, x, y, (px, py) => plot(d.f, px, py, d.c)); d.x = x; d.y = y; refreshPx(d.f.px); }
  else if (drag.kind === "float") { float!.x = drag.fx + x - drag.sx; float!.y = drag.fy + y - drag.sy; }
  else if (drag.kind === "rect") {
    const cx = (v: number, m: number) => Math.max(0, Math.min(m - 1, v));
    const x0 = cx(Math.min(drag.sx, x), doc.cw), x1 = cx(Math.max(drag.sx, x), doc.cw), y0 = cx(Math.min(drag.sy, y), doc.ch), y1 = cx(Math.max(drag.sy, y), doc.ch);
    selRect = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  } else if (drag.kind === "move") { for (const [f, dx, dy] of drag.base) { f.dx = dx + x - drag.sx; f.dy = dy + y - drag.sy; } syncFrameInputs(); }
  else if (drag.kind === "movePart") { for (const [p, px, py] of drag.base) { p.x = px + x - drag.sx; p.y = py + y - drag.sy; } syncVarUi(); }
  drawEditor();
});
const endDrag = () => {
  if (!drag) return;
  const k = drag.kind, d = drag; drag = null;
  // 動かすツールでクリックしただけ（何も動いていない）なら、積んだ履歴を取り消す
  const unmoved = d.kind === "move" ? d.base.every(([o, bx, by]) => o === undefined || (o.dx === bx && o.dy === by))
    : d.kind === "movePart" ? d.base.every(([o, bx, by]) => o === undefined || (o.x === bx && o.y === by)) : false;
  if ((d.kind === "move" || d.kind === "movePart") && unmoved) { undoStack.pop(); redoStack = d.keepRedo || []; syncUndo(); drawEditor(); return; }
  if (k === "paint" || k === "move" || k === "movePart") afterEdit();
  else drawEditor();
};
ed.addEventListener("pointerup", endDrag);
ed.addEventListener("pointercancel", endDrag);
ed.addEventListener("pointerleave", () => { if (!drag) $("edPos").textContent = "—"; });
function afterEdit() { renderStrip(); drawEditor(); syncFrameInputs(); syncVarUi(); syncUndo(); }
// 画面に出ている絵（差分・浮いた選択範囲込み）のドットの色
function shownAt(x: number, y: number): number[] {
  if (x < 0 || y < 0 || x >= doc!.cw || y >= doc!.ch) return [0, 0, 0, 0];
  return [...ctx2d(work).getImageData(x, y, 1, 1).data];
}

// ---- コマ一覧（1行 = 1アクション） ----
function selected() { return [...selSet].sort((a, b) => a - b); }
function actions() { return actionsOf(doc!.frames); }
// アクションごとにまとまった順に並べ直す（アクションの順は最初に出てくる順）
function regroup() {
  const d = doc!;
  const curF = d.frames[cur], sel = [...selSet].map((i) => d.frames[i]);
  d.frames = actions().flatMap((n) => d.frames.filter((f) => f.tag === n));
  cur = Math.max(0, d.frames.indexOf(curF));
  selSet = new Set(sel.map((f) => d.frames.indexOf(f)).filter((i) => i >= 0));
}
function selectFrame(i: number, e?: MouseEvent) {
  if (!doc) return;
  if (float) stampFloat();
  selRect = null;
  i = Math.max(0, Math.min(doc.frames.length - 1, i));
  if (e && e.shiftKey) { selSet = new Set(); for (let k = Math.min(anchor, i); k <= Math.max(anchor, i); k++) selSet.add(k); }
  else if (e && (e.ctrlKey || e.metaKey)) { if (selSet.has(i) && selSet.size > 1) selSet.delete(i); else selSet.add(i); anchor = i; }
  else { selSet = new Set([i]); anchor = i; }
  cur = i;
  renderStrip(); drawEditor(); syncFrameInputs();
}
function selectAction(name: string) {
  if (float) stampFloat();
  selRect = null;
  const idx = doc!.frames.map((f, i) => (f.tag === name ? i : -1)).filter((i) => i >= 0);
  selSet = new Set(idx); cur = anchor = idx[0];
  renderStrip(); drawEditor(); syncFrameInputs();
}
// 選んだコマをまとめて to の位置（並べ替え前の番号）の前へ動かす。tag を渡すとそのアクションへ移す
function moveSel(idx: number[], to: number, tag?: string) {
  const d = doc!;
  const moving = idx.map((i) => d.frames[i]);
  const rest = d.frames.filter((_, i) => !idx.includes(i));
  let at = to - idx.filter((i) => i < to).length;
  at = Math.max(0, Math.min(rest.length, at));
  commit();
  const curF = moving.includes(d.frames[cur]) ? d.frames[cur] : moving[0];
  const moved = tag ? moving.map((f) => (f.tag === tag ? f : { ...f, tag })) : moving;
  rest.splice(at, 0, ...moved);
  d.frames = rest;
  selSet = new Set(moved.map((f) => d.frames.indexOf(f)));
  cur = d.frames.indexOf(moved[moving.indexOf(curF)]);
  refreshAll();
}
let dragFrom: number | null = null;
const isFrameDrag = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("text/x-frame");
function dropTargets(el: HTMLElement, onDrop: (from: number, idx: number[]) => void) {
  el.addEventListener("dragover", (e) => { if (isFrameDrag(e)) { e.preventDefault(); el.classList.add("drag-over"); } });
  el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
  el.addEventListener("drop", (e) => {
    el.classList.remove("drag-over");
    if (dragFrom === null) return;
    e.preventDefault(); e.stopPropagation();
    const from = dragFrom, idx = selSet.has(from) ? selected() : [from];
    onDrop(from, idx);
  });
}
// 中のスクロールだけで見える位置へ寄せる（ページ全体はスクロールさせない）
function revealIn(box: HTMLElement, el: HTMLElement, horiz: boolean) {
  const pos = horiz ? el.offsetLeft : el.offsetTop, size = horiz ? el.offsetWidth : el.offsetHeight;
  const view = horiz ? box.clientWidth : box.clientHeight, sc = horiz ? "scrollLeft" : "scrollTop";
  if (pos < box[sc]) box[sc] = Math.max(0, pos - 4);
  else if (pos + size > box[sc] + view) box[sc] = pos + size - view + 4;
}
function renderStrip() {
  const strip = $("strip");
  const keep: { top: number; left: Record<string, number> } = { top: strip.scrollTop, left: {} };
  strip.querySelectorAll<HTMLElement>(".act-frames").forEach((r) => (keep.left[r.dataset.tag!] = r.scrollLeft));
  strip.textContent = "";
  const n = doc ? doc.frames.length : 0;
  $("countBadge").textContent = String(n);
  ["opLeft", "opRight", "opDup", "opEmpty", "opFlipH", "opFlipV", "opDel", "btnTag", "btnNewAct", "btnAlign", "btnPng", "btnJson", "btnToUpscale", "btnToInbetween"].forEach((id) => ($btn(id).disabled = !n));
  $btn("btnSplit").disabled = !doc;
  if (!doc || !n) { const d = document.createElement("p"); d.className = "hint"; d.textContent = doc ? "コマがありません。分割を見直してください" : "シートを読み込むか、サンプルを読み込んでください"; strip.appendChild(d); return; }
  const D = doc;
  const s = Math.min(76 / D.cw, 56 / D.ch), k = s >= 2 ? Math.floor(s) : s; // 縦横比を保ったまま枠に収める
  let curRow: HTMLElement | null = null, curThumb: HTMLElement | null = null;
  for (const name of actions()) {
    const row = document.createElement("div"); row.className = "act-row";
    const count = D.frames.filter((f) => f.tag === name).length;
    const head = document.createElement("div");
    head.className = "act-head" + (D.frames[cur].tag === name ? " on" : "");
    head.title = "クリックでこの行のコマを全部選ぶ";
    const nm = document.createElement("span"); nm.className = "name"; nm.textContent = name;
    const ct = document.createElement("span"); ct.className = "hint mono"; ct.textContent = count + " コマ";
    head.append(nm, ct);
    head.addEventListener("click", () => selectAction(name));
    dropTargets(head, (from, idx) => moveSel(idx, D.frames.findIndex((f) => f.tag === name), name));
    const frames = document.createElement("div"); frames.className = "act-frames"; frames.dataset.tag = name; frames.style.position = "relative";
    D.frames.forEach((f, i) => {
      if (f.tag !== name) return;
      const el = document.createElement("div");
      el.className = "thumb" + (selSet.has(i) ? " sel" : "") + (i === cur ? " cur" : "");
      el.draggable = true; el.dataset.i = String(i);
      el.setAttribute("role", "option"); el.setAttribute("aria-selected", String(selSet.has(i)));
      const box = document.createElement("div"); box.className = "img bg-checker";
      const c = composeShown(previewOf(f));
      c.style.width = D.cw * k + "px"; c.style.height = D.ch * k + "px";
      box.appendChild(c);
      const meta = document.createElement("div"); meta.className = "meta";
      const a = document.createElement("span"); a.className = "mono"; a.textContent = "#" + (i + 1);
      const b = document.createElement("span"); b.className = "mono text-muted"; b.textContent = f.dur + "ms";
      meta.append(a, b);
      const flags = document.createElement("div"); flags.className = "flags";
      const badge = (cls: string, txt: string, title?: string) => { const s = document.createElement("span"); s.className = "badge " + cls; s.textContent = txt; if (title) s.title = title; flags.appendChild(s); };
      if (f.dx || f.dy) badge("badge-soft mono", f.dx + "," + f.dy, "ずらし");
      const cv = curVar();
      if (cv && cv.at[f.id]) badge("badge-var", "差分", "差分「" + cv.name + "」を貼っています");
      if (overflows(f)) badge("badge-warn", "はみ出し", "絵の一部がセルの外に出ています。書き出すと切れます");
      el.append(box, meta, flags);
      el.addEventListener("click", (e) => selectFrame(i, e));
      el.addEventListener("dragstart", (e) => { dragFrom = i; e.dataTransfer!.setData("text/x-frame", String(i)); e.dataTransfer!.effectAllowed = "move"; el.classList.add("dragging"); });
      el.addEventListener("dragend", () => { el.classList.remove("dragging"); dragFrom = null; });
      // 右へ動かすときは落とした先の後ろ、左へは前に入れる。別の行へ落とすとそのアクションに移る
      dropTargets(el, (from, idx) => { if (!idx.includes(i)) moveSel(idx, i > from ? i + 1 : i, name); });
      frames.appendChild(el);
      if (i === cur) { curRow = row; curThumb = el; }
    });
    const end = document.createElement("div"); end.className = "act-end"; end.textContent = "＋"; end.title = "ここへ落とすと行の最後に入ります";
    dropTargets(end, (from, idx) => moveSel(idx, D.frames.map((f) => f.tag).lastIndexOf(name) + 1, name));
    frames.appendChild(end);
    row.append(head, frames);
    strip.appendChild(row);
  }
  strip.scrollTop = keep.top;
  strip.querySelectorAll<HTMLElement>(".act-frames").forEach((r) => { if (keep.left[r.dataset.tag!] !== undefined) r.scrollLeft = keep.left[r.dataset.tag!]; });
  // forEach の中で代入しているので、ここでは型を付け直す
  const thumb = curThumb as HTMLElement | null, thumbRow = curRow as HTMLElement | null;
  if (thumb && thumbRow) { revealIn(thumb.parentElement!, thumb, true); revealIn(strip, thumbRow, false); }
}
// 前へ / 後ろへは同じアクションの中だけで動かす
function sameAction(s: number[]) { const t = doc!.frames[s[0]].tag; if (s.every((i) => doc!.frames[i].tag === t)) return t; IT.toast("同じアクションのコマを選んでください"); return null; }
$btn("opLeft").addEventListener("click", () => { const s = selected(), t = sameAction(s); if (t && s[0] > 0 && doc!.frames[s[0] - 1].tag === t) moveSel(s, s[0] - 1); });
$btn("opRight").addEventListener("click", () => { const s = selected(), t = sameAction(s), e = s[s.length - 1]; if (t && e < doc!.frames.length - 1 && doc!.frames[e + 1].tag === t) moveSel(s, e + 2); });
function insertAfterSel(make: (fs: Frame[]) => Frame[]) {
  const s = selected(), at = s[s.length - 1] + 1;
  commit();
  const add = make(s.map((i) => doc!.frames[i]));
  doc!.frames.splice(at, 0, ...add);
  selSet = new Set(add.map((_, k) => at + k)); cur = at; anchor = at;
  refreshAll();
}
function flipped(f: Frame, h: boolean) {
  // セル上の見た目を反転する（ずらしごと反転させるため、セルに描いてから反転）
  const c = compose(f), o = document.createElement("canvas"); o.width = c.width; o.height = c.height;
  const x = ctx2d(o); x.translate(h ? o.width : 0, h ? 0 : o.height); x.scale(h ? -1 : 1, h ? 1 : -1); x.drawImage(c, 0, 0);
  return newFrame(x.getImageData(0, 0, o.width, o.height), { dur: f.dur, tag: f.tag });
}
// 複製したコマには差分パーツの位置も写す
$btn("opDup").addEventListener("click", () => insertAfterSel((fs) => fs.map((f) => {
  const g = { ...f, id: nextId++ };
  for (const v of doc!.variants) if (v.at[f.id]) v.at[g.id] = { ...v.at[f.id] };
  return g;
})));
$btn("opEmpty").addEventListener("click", () => insertAfterSel((fs) => [newFrame(new ImageData(doc!.cw, doc!.ch), { dur: fs[fs.length - 1].dur, tag: fs[fs.length - 1].tag })]));
$btn("opFlipH").addEventListener("click", () => insertAfterSel((fs) => fs.map((f) => flipped(f, true))));
$btn("opFlipV").addEventListener("click", () => insertAfterSel((fs) => fs.map((f) => flipped(f, false))));
function deleteSel() {
  const d = doc!;
  if (d.frames.length <= selSet.size) { IT.toast("すべてのコマは消せません"); return; }
  const s = selected();
  if (float) stampFloat();
  commit();
  d.frames = d.frames.filter((_, i) => !selSet.has(i));
  cur = Math.min(s[0], d.frames.length - 1); selSet = new Set([cur]); anchor = cur;
  float = null; selRect = null;
  refreshAll();
}
$btn("opDel").addEventListener("click", deleteSel);

// ---- 選んだコマの設定 ----
function syncFrameInputs() {
  const n = doc ? doc.frames.length : 0;
  ["fDx", "fDy", "fDur", "fTag"].forEach((id) => ($in(id).disabled = !n));
  if (!doc || !n) { $("selInfo").textContent = ""; return; }
  const f = doc.frames[cur];
  if (document.activeElement !== $("fDx")) $in("fDx").value = String(f.dx);
  if (document.activeElement !== $("fDy")) $in("fDy").value = String(f.dy);
  if (document.activeElement !== $("fDur")) $in("fDur").value = String(f.dur);
  if (document.activeElement !== $("fTag")) $in("fTag").value = f.tag;
  $("selInfo").textContent = "#" + (cur + 1) + (selSet.size > 1 ? "（" + selSet.size + " コマ選択中）" : "");
}
function applyToSel(fn: (f: Frame) => void) { commit(); for (const i of selected()) fn(doc!.frames[i]); renderStrip(); drawEditor(); syncFrameInputs(); }
// ずらしは「今のコマの値との差」を選んだコマ全部に足す
for (const [id, k] of [["fDx", "dx"], ["fDy", "dy"]] as const) $in(id).addEventListener("change", (e) => {
  const v = Math.round(+(e.target as HTMLInputElement).value || 0), d = v - doc!.frames[cur][k];
  if (d) applyToSel((f) => (f[k] += d));
});
$in("fDur").addEventListener("change", (e) => { const v = Math.max(1, Math.min(10000, Math.round(+(e.target as HTMLInputElement).value || 1))); applyToSel((f) => (f.dur = v)); });
// 選んだコマのアクションの名前を変える（同じアクションのコマ全部）
$btn("btnTag").addEventListener("click", () => {
  const d = doc!;
  const t = $in("fTag").value.trim(), old = d.frames[cur].tag;
  if (!t) { IT.toast("アクション名を入れてください"); $in("fTag").focus(); return; }
  if (t === old) return;
  if (actions().includes(t)) { IT.toast("「" + t + "」はもうあります。コマをその行へドラッグすると移せます"); return; }
  commit();
  d.frames = d.frames.map((f) => (f.tag === old ? { ...f, tag: t } : f));
  if (d.tagDir && d.tagDir[old]) { d.tagDir = { ...d.tagDir, [t]: d.tagDir[old] }; delete d.tagDir[old]; }
  refreshAll();
});
$in("fTag").addEventListener("keydown", (e) => { if (e.key === "Enter") $btn("btnTag").click(); });
$btn("btnNewAct").addEventListener("click", () => {
  const names = actions(); let k = names.length + 1;
  while (names.includes("anim" + k)) k++;
  moveSel(selected(), doc!.frames.length, "anim" + k);
  IT.toast("新しい行「anim" + k + "」を作りました。右の欄で名前を変えられます");
});
function syncTags() {
  const sel = $sel("playTag"), keep = sel.value;
  const tags = doc ? actions() : [];
  sel.textContent = "";
  const add = (v: string, t: string) => { const o = document.createElement("option"); o.value = v; o.textContent = t; sel.appendChild(o); };
  add("@cur", "選んだコマのアクション"); add("@all", "全コマ");
  for (const t of tags) add(t, "アクション: " + t);
  sel.value = keep === "@all" || tags.includes(keep) ? keep : "@cur";
}
$sel("alignMode").addEventListener("change", (e) => { S.alignMode = (e.target as HTMLSelectElement).value as Settings["alignMode"]; saveS(); });
$btn("btnAlign").addEventListener("click", () => {
  const d = doc!;
  const idx = $sel("alignScope").value === "all" ? d.frames.map((_, i) => i) : selected();
  const items = idx.map((i) => [d.frames[i], cellBox(d.frames[i])] as const).filter((p): p is readonly [Frame, Box] => !!p[1]);
  if (!items.length) { IT.toast("絵のあるコマがありません"); return; }
  const mw = Math.max(...items.map((p) => p[1].w)), mh = Math.max(...items.map((p) => p[1].h));
  const bx = Math.floor((d.cw - mw) / 2), by = Math.floor((d.ch - mh) / 2);
  commit();
  for (const [f, b] of items) {
    const tx = bx + Math.floor((mw - b.w) / 2);
    const ty = S.alignMode === "bottom" ? by + mh - b.h : by + Math.floor((mh - b.h) / 2);
    f.dx += tx - b.x; f.dy += ty - b.y;
  }
  renderStrip(); drawEditor(); syncFrameInputs();
  IT.toast(items.length + " コマを" + (S.alignMode === "bottom" ? "下端" : "中央") + "で揃えました");
});

// ---- アニメ確認 ----
const anim = $<HTMLCanvasElement>("anim"), actx = ctx2d(anim);
let playing = true, playIdx = 0, playDir = 1, acc = 0, last = 0;
const animWork = document.createElement("canvas");
function playList() {
  if (!doc || !doc.frames.length) return [];
  const D = doc;
  const v = $sel("playTag").value, t = v === "@cur" ? D.frames[cur].tag : v;
  return D.frames.map((f, i) => i).filter((i) => v === "@all" || D.frames[i].tag === t);
}
let lastList = "";
function tick(ts: number) {
  const list = playList();
  const key = list.join(","); if (key !== lastList) { lastList = key; playIdx = 0; acc = 0; playDir = 1; }
  if (doc && list.length) {
    if (playing) {
      acc += Math.min(250, ts - (last || ts));
      for (let guard = 0; guard < 60; guard++) {
        const f = doc.frames[list[playIdx % list.length]];
        const d = S.playMode === "dur" ? f.dur : 1000 / S.fps;
        if (acc < d) break;
        acc -= d;
        if (S.loopMode === "ping" && list.length > 1) { if (playIdx + playDir >= list.length || playIdx + playDir < 0) playDir = -playDir; playIdx += playDir; }
        else playIdx = (playIdx + 1) % list.length;
      }
    }
    playIdx = Math.max(0, Math.min(list.length - 1, playIdx));
    const i = playing ? list[playIdx] : cur;
    const st = $("animStage");
    const z = S.animZoom || Math.max(1, Math.min(32, Math.floor(Math.min((st.clientWidth - 22) / doc.cw, (st.clientHeight - 22) / doc.ch))));
    if (anim.width !== doc.cw * z || anim.height !== doc.ch * z) { anim.width = doc.cw * z; anim.height = doc.ch * z; }
    actx.imageSmoothingEnabled = false; actx.clearRect(0, 0, anim.width, anim.height);
    composeShown(previewOf(doc.frames[i]), animWork);
    if (float && float.fid === doc.frames[i].id) drawFloat(animWork, float);
    actx.drawImage(animWork, 0, 0, anim.width, anim.height);
    if (S.guidesInAnim) drawGuides(actx, z, anim.width, anim.height);
    $("animPos").textContent = "#" + (i + 1) + " / " + doc.frames.length;
  }
  last = ts;
  requestAnimationFrame(tick);
}
function togglePlay() { playing = !playing; $("btnPlay").textContent = playing ? "停止" : "再生"; if (!playing) $("animPos").textContent = ""; }
$btn("btnPlay").addEventListener("click", togglePlay);
$in("fps").addEventListener("change", (e) => { const t = e.target as HTMLInputElement; S.fps = Math.max(1, Math.min(60, Math.round(+t.value || 10))); t.value = String(S.fps); saveS(); });
$sel("playMode").addEventListener("change", (e) => { S.playMode = (e.target as HTMLSelectElement).value as Settings["playMode"]; saveS(); });
$sel("loopMode").addEventListener("change", (e) => { S.loopMode = (e.target as HTMLSelectElement).value as Settings["loopMode"]; playDir = 1; saveS(); });
$sel("playTag").addEventListener("change", () => { playIdx = 0; acc = 0; });
$sel("animZoom").addEventListener("change", (e) => { S.animZoom = +(e.target as HTMLSelectElement).value; saveS(); });
function syncAnimBg() { const st = $("animStage"); st.className = "anim-stage resizable " + (S.animBg === "checker" ? "bg-checker" : "bg-" + S.animBg); }
$sel("animBg").addEventListener("change", (e) => { S.animBg = (e.target as HTMLSelectElement).value; saveS(); syncAnimBg(); });

// ---- 書き出し ----
// 書き出すシートの一覧。シート = { suffix, rows: [{ name, items: [{ f, v }] }] }。1アクション = 1行
function exportSets(): SheetSet[] { return exportSetsOf(doc!.frames, doc!.variants, S.exportVar); }
// 列数は一番長い行のコマ数
function layoutOf(set: SheetSet): Layout { return layoutIn(set, doc!.cw, doc!.ch); }
// 末尾に _列x行 を付ける（Anim-Editor がファイル名の最後の「数字x数字」を分割数として読む。各64まで）
function pngName(set?: SheetSet) { set = set || exportSets()[0]; return pngNameOf($in("baseName").value, set, doc!.cw, doc!.ch); }
function syncOut() {
  $sel("exportVar").disabled = !doc || !doc.variants.length;
  if (!doc || !doc.frames.length) { $("outInfo").textContent = ""; $("pngPreview").textContent = ""; return; }
  const sets = exportSets();
  $("outInfo").textContent = sets.map((s) => { const l = layoutOf(s); return l.cols + " 列 × " + l.rows + " 行（" + l.W + "×" + l.H + "px）"; }).join(" / ");
  $("pngPreview").textContent = sets.map((s) => pngName(s)).join("\n");
  $("pngPreview").style.whiteSpace = "pre-line";
}
$in("baseName").addEventListener("input", syncOut);
$sel("exportVar").addEventListener("change", (e) => { S.exportVar = (e.target as HTMLSelectElement).value as ExportVar; saveS(); syncOut(); });
function renderSheet(set: SheetSet) {
  const { W, H } = layoutOf(set);
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const x = ctx2d(c, { willReadFrequently: true }); // 作業ファイルを開いたときは「この分割で読み直す」の元画像になる
  set.rows.forEach((row, r) => row.items.forEach((it, i) => x.drawImage(composeVar(it.f, it.v), i * doc!.cw, r * doc!.ch)));
  return c;
}
function asepriteJson(set?: SheetSet) {
  set = set || exportSets()[0];
  return asepriteJsonOf(set, doc!.cw, doc!.ch, pngName(set), (f) => (S.playMode === "dur" ? f.dur : Math.round(1000 / S.fps)), doc!.tagDir);
}
$btn("btnPng").addEventListener("click", async () => {
  if (float) stampFloat();
  const bad = doc!.frames.filter(overflows).length;
  try {
    for (const set of exportSets()) if (!(await IT.saveFile(pngName(set), await IT.canvasToBlob(renderSheet(set))))) break;
    if (bad) IT.toast(bad + " コマがセルからはみ出していて、はみ出した所は切れています", 4000);
  } catch { IT.toast("PNGを作成できませんでした"); }
});
$btn("btnJson").addEventListener("click", async () => {
  if (float) stampFloat();
  for (const set of exportSets())
    if (!(await IT.saveFile(pngName(set).replace(/\.png$/, ".json"), new Blob([JSON.stringify(asepriteJson(set), null, 2)], { type: "application/json" })))) break;
});

// ---- ほかのツールで開く ----
$btn("btnToUpscale").addEventListener("click", () => {
  if (!doc || !doc.frames.length) return;
  if (float) stampFloat();
  const set = exportSets()[0], name = pngName(set);
  IT.openIn("pixel-upscaler", IT.canvasToBlob(renderSheet(set)).then((b) => [new File([b], name, { type: "image/png" })]));
});
// 選んだコマのアクションの各コマを 1 枚ずつのキー絵として渡す（中割りツールはファイル名の順に並べる）
$btn("btnToInbetween").addEventListener("click", () => {
  if (!doc || !doc.frames.length) return;
  if (float) stampFloat();
  const act = doc.frames[cur].tag, list = doc.frames.filter((f) => f.tag === act);
  const base = safeName(baseOf($in("baseName").value.trim() + ".png") + "_" + act);
  const width = String(list.length).length;
  IT.openIn("pixel-inbetween", Promise.all(list.map((f, i) => IT.canvasToBlob(composeShown(f))
    .then((b) => new File([b], base + "_" + String(i + 1).padStart(width, "0") + ".png", { type: "image/png" })))));
});

// ---- 表情差分 ----
function syncVarUi() {
  const sel = $sel("varSel"), vs = doc ? doc.variants : [];
  if (doc && !curVar()) { shownVar = 0; editPart = false; }
  sel.textContent = "";
  const add = (v: number, t: string) => { const o = document.createElement("option"); o.value = String(v); o.textContent = t; sel.appendChild(o); };
  add(0, "元の絵"); for (const v of vs) add(v.id, "差分: " + v.name);
  sel.value = String(shownVar);
  const v = curVar(), f = doc && doc.frames[cur], p = v && f && v.at[f.id];
  $("tEditPart").setAttribute("aria-pressed", String(editPart));
  ["tEditPart", "varPlace", "varPlaceAct", "varRename", "varDelete"].forEach((id) => ($btn(id).disabled = !v));
  $btn("varUnplace").disabled = !p;
  $in("varX").disabled = $in("varY").disabled = !p;
  $btn("varFromSel").disabled = $btn("varFromFile").disabled = !f;
  if (p) { if (document.activeElement !== $("varX")) $in("varX").value = String(p.x); if (document.activeElement !== $("varY")) $in("varY").value = String(p.y); }
  else $in("varX").value = $in("varY").value = "";
  if (v && document.activeElement !== $("varName")) $in("varName").value = v.name;
  $("varInfo").textContent = v ? Object.keys(v.at).filter((id) => doc!.frames.some((g) => String(g.id) === id)).length + " コマに貼付" : vs.length ? vs.length + " 件" : "";
}
function showVar(id: string) { if (float) stampFloat(); shownVar = +id; if (!curVar()) editPart = false; renderStrip(); drawEditor(); syncVarUi(); }
$sel("varSel").addEventListener("change", (e) => showVar((e.target as HTMLSelectElement).value));
function toggleEditPart() {
  if (!curVar()) { IT.toast("先に表示する差分を選んでください"); return; }
  if (float) stampFloat();
  editPart = !editPart; selRect = null;
  IT.toast(editPart ? "差分パーツを描きます（P で元の絵に戻る）" : "元の絵を描きます");
  drawEditor(); syncVarUi();
}
$btn("tEditPart").addEventListener("click", toggleEditPart);
// 前のコマ（同じアクション → それ以外の順）の位置を引き継ぐ
function inheritPos(v: Variant, i: number): Pos {
  const fr = doc!.frames;
  for (let k = i - 1; k >= 0; k--) if (v.at[fr[k].id]) return { ...v.at[fr[k].id] };
  for (let k = i + 1; k < fr.length; k++) if (v.at[fr[k].id]) return { ...v.at[fr[k].id] };
  return { x: 0, y: 0 };
}
$btn("varPlace").addEventListener("click", () => {
  const v = curVar()!; commit();
  for (const i of selected()) if (!v.at[doc!.frames[i].id]) v.at[doc!.frames[i].id] = inheritPos(v, i);
  afterEdit();
});
$btn("varPlaceAct").addEventListener("click", () => {
  const d = doc!, v = curVar()!, t = d.frames[cur].tag; commit();
  d.frames.forEach((f, i) => { if (f.tag === t && !v.at[f.id]) v.at[f.id] = v.at[d.frames[cur].id] ? { ...v.at[d.frames[cur].id] } : inheritPos(v, i); });
  afterEdit();
});
$btn("varUnplace").addEventListener("click", () => { const v = curVar()!; commit(); for (const i of selected()) delete v.at[doc!.frames[i].id]; afterEdit(); });
for (const [id, k] of [["varX", "x"], ["varY", "y"]] as const) $in(id).addEventListener("change", (e) => {
  const v = curVar(), p = v && v.at[doc!.frames[cur].id]; if (!v || !p) return;
  const d = Math.round(+(e.target as HTMLInputElement).value || 0) - p[k]; if (!d) return;
  commit(); for (const i of selected()) { const q = v.at[doc!.frames[i].id]; if (q) q[k] += d; } afterEdit();
});
function uniqVarName(n: string) { const names = doc!.variants.map((v) => v.name); let k = n, i = 2; while (names.includes(k)) k = n + i++; return k; }
function addVariant(img: ImageData, x: number, y: number) {
  const d = doc!;
  commit();
  const v: Variant = { id: nextId++, name: uniqVarName($in("varName").value.trim() && !curVar() ? $in("varName").value.trim() : "差分" + (d.variants.length + 1)), img, lx: 0, ly: 0, at: {} };
  const f = d.frames[cur];
  v.at[f.id] = { x: x - f.dx, y: y - f.dy };
  d.variants.push(v);
  shownVar = v.id; editPart = true; selRect = null;
  if (S.tool === "select" || S.tool === "move") setTool("pen");
  countPalette(); refreshAll();
  IT.toast("差分「" + v.name + "」を作りました。そのまま描くとパーツに入ります");
}
$btn("varFromSel").addEventListener("click", () => {
  if (float) stampFloat();
  if (!selRect) { setTool("select"); IT.toast("範囲選択で、差分にしたい所（目や口など）を囲んでから押してください"); return; }
  const r = selRect, img = ctx2d(composeVar(doc!.frames[cur], null)).getImageData(r.x, r.y, r.w, r.h);
  addVariant(img, r.x, r.y);
});
$btn("varFromFile").addEventListener("click", () => $in("partFile").click());
$in("partFile").addEventListener("change", async (e) => {
  const t = e.target as HTMLInputElement, file = t.files![0]; t.value = "";
  if (!file) return;
  try { const c = await toCanvas(file); addVariant(ctx2d(c).getImageData(0, 0, c.width, c.height), 0, 0); }
  catch { IT.toast(file.name + " を読み込めませんでした"); }
});
$btn("varRename").addEventListener("click", () => {
  const d = doc!, v = curVar()!, n = $in("varName").value.trim();
  if (!n || n === v.name) return;
  if (d.variants.some((w) => w !== v && w.name === n)) { IT.toast("「" + n + "」はもうあります"); return; }
  commit(); d.variants = d.variants.map((w) => (w === v ? { ...w, name: n } : w)); afterEdit(); syncOut();
});
$in("varName").addEventListener("keydown", (e) => { if (e.key === "Enter" && curVar()) $btn("varRename").click(); });
let delArmed = 0;
$btn("varDelete").addEventListener("click", () => {
  const d = doc!, v = curVar()!;
  if (Date.now() - delArmed > 3000) { delArmed = Date.now(); IT.toast("もう一度押すと差分「" + v.name + "」を削除します（元に戻すで戻せます）"); return; }
  delArmed = 0; commit(); d.variants = d.variants.filter((w) => w !== v); shownVar = 0; editPart = false; refreshAll();
});

// ---- キー操作 ----
function isTyping(el: EventTarget | null): boolean {
  const e = el as HTMLElement | null;
  if (!e || !e.tagName) return false;
  if (e.tagName === "TEXTAREA" || e.isContentEditable) return true;
  return e.tagName === "INPUT" && !/^(checkbox|radio|range|button|color|file)$/.test((e as HTMLInputElement).type);
}
// プルダウンやボタンを使ったあとにフォーカスを残さない（ショートカットがそのまま効くように）
document.addEventListener("change", (e) => { const t = e.target as HTMLElement; if (t.tagName === "SELECT" || (t.tagName === "INPUT" && !isTyping(t))) t.blur(); });
document.addEventListener("click", (e) => { const t = e.target as Element; const b = t.closest && t.closest("button"); if (b && e.detail > 0) b.blur(); });
// フォーカスのあるスライダー・チェック・ボタンなどは、矢印・スペース・Enter をその部品に任せる
const ownsKey = (el: EventTarget | null, k: string) => { const e = el as Element | null; return !!e && !!e.matches && e.matches("select, button, summary, input:not([type=text]):not([type=number]):not([type=search])") && /^(Arrow|Enter$| $)/.test(k); };
document.addEventListener("keydown", (e) => {
  if (isTyping(e.target) || ownsKey(e.target, e.key)) return;
  if (!doc || !doc.frames.length) return;
  const D = doc;
  const mod = e.ctrlKey || e.metaKey, k = e.key;
  if (mod && (k === "z" || k === "Z")) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (mod && (k === "y" || k === "Y")) { e.preventDefault(); redo(); return; }
  if (mod && (k === "c" || k === "C")) { e.preventDefault(); copySel(); return; }
  if (mod && (k === "v" || k === "V")) { e.preventDefault(); pasteClip(); return; }
  if (mod && (k === "a" || k === "A")) { e.preventDefault(); setTool("select"); selRect = { x: 0, y: 0, w: D.cw, h: D.ch }; drawEditor(); return; }
  if (mod) return;
  const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (arrows[k]) {
    e.preventDefault();
    const [ax, ay] = arrows[k].map((v) => v * (e.shiftKey ? 8 : 1));
    if (float) { float.x += ax; float.y += ay; drawEditor(); return; }
    if (S.tool === "select" && selRect) { if (liftSelection()) { float!.x += ax; float!.y += ay; drawEditor(); syncUndo(); } return; }
    const v = curVar();
    if (editPart && v) {
      const ps = selected().map((i) => v.at[D.frames[i].id]).filter(Boolean);
      if (!ps.length) { noTarget(); return; }
      commit(); for (const p of ps) { p.x += ax; p.y += ay; } afterEdit(); return;
    }
    applyToSel((f) => { f.dx += ax; f.dy += ay; });
    return;
  }
  const map: Record<string, Tool> = { b: "pen", e: "eraser", i: "picker", g: "fill", m: "select", v: "move" };
  const lk = k.toLowerCase();
  if (map[lk]) { setTool(map[lk]); return; }
  if (lk === "x") toggleMirror();
  else if (lk === "o") toggleOnion();
  else if (lk === "d") toggleDiff();
  else if (lk === "l") toggleGuides();
  else if (lk === "p") toggleEditPart();
  else if (k === " ") { e.preventDefault(); togglePlay(); }
  else if (k === "," || k === "[") selectFrame(cur - 1);
  else if (k === "." || k === "]") selectFrame(cur + 1);
  else if (k === "Enter") { if (float) stampFloat(); }
  else if (k === "Escape") { if (float) stampFloat(); selRect = null; drawEditor(); }
  else if (k === "Delete" || k === "Backspace") {
    e.preventDefault();
    if (float) { float = null; selRect = null; afterEdit(); }
    else if (selRect && S.tool === "select") { const f = editObj(); if (!f) { noTarget(); return; } const sr = selRect; beginEditT(f); for (let y = 0; y < sr.h; y++) for (let x = 0; x < sr.w; x++) setPx(f, sr.x + x, sr.y + y, [0, 0, 0, 0]); refreshPx(f.px); afterEdit(); }
  }
});
function copySel() {
  const f = doc!.frames[cur];
  let c: ImageData;
  if (float) c = new ImageData(new Uint8ClampedArray(float.img.data), float.img.width, float.img.height);
  else { const r = selRect || { x: 0, y: 0, w: doc!.cw, h: doc!.ch }; c = ctx2d(composeShown(f)).getImageData(r.x, r.y, r.w, r.h); }
  clip = c;
  IT.toast("コピーしました（" + c.width + "×" + c.height + "）");
}
function pasteClip() {
  if (!clip) { IT.toast("先に Ctrl+C でコピーしてください"); return; }
  if (float) stampFloat();
  const f = editObj();
  if (!f) { noTarget(); return; }
  beginEditT(f);
  const x = selRect ? selRect.x : 0, y = selRect ? selRect.y : 0;
  setTool("select");
  float = { img: new ImageData(new Uint8ClampedArray(clip.data), clip.width, clip.height), x, y, fid: f.id, T: f };
  drawEditor(); syncUndo();
  IT.toast("貼り付けました。ドラッグか矢印で動かし、Enter で確定");
}

// ---- 全体の更新 ----
function refreshAll() {
  if (doc && doc.frames.length) { clampCur(); regroup(); }
  renderStrip(); drawEditor(); syncFrameInputs(); syncTags(); syncVarUi(); syncOut(); syncUndo();
  $btn("btnWorkSave").disabled = !doc || !doc.frames.length;
  if (doc) { $in("cellW").value = String(doc.cw); $in("cellH").value = String(doc.ch); }
}
$btn("btnUndo").addEventListener("click", undo);
$btn("btnRedo").addEventListener("click", redo);
$btn("btnResetPrefs").addEventListener("click", () => {
  IT.store.remove(SKEY); S = structuredClone(DEF); applySettings(); IT.toast("設定をリセットしました");
});
function applySettings() {
  $in("fps").value = String(S.fps); $sel("playMode").value = S.playMode; $sel("loopMode").value = S.loopMode; $sel("animZoom").value = String(S.animZoom); $sel("animBg").value = S.animBg;
  $sel("edZoom").value = String(S.edZoom); $sel("alignMode").value = S.alignMode; $in("gSkipEmpty").checked = S.skipEmpty;
  ([["tMirror", "mirror"], ["tOnion", "onion"], ["tDiff", "diff"], ["tGrid", "grid"], ["tOnionLoop", "onionLoop"], ["tGuides", "showGuides"]] as const).forEach(([id, k]) => $(id).setAttribute("aria-pressed", String(!!S[k])));
  $in("guidesInAnim").checked = S.guidesInAnim;
  $sel("exportVar").value = S.exportVar; $sel("cellAnchor").value = S.cellAnchor; $in("bgTol").value = String(S.bgTol); $("bgTolV").textContent = String(S.bgTol); $sel("bgMode").value = S.bgMode;
  applySizes(); renderGuides(); renderFilterUi();
  setColor(S.color); syncAnimBg(); setTool(S.tool);
}
// ---- 基準ライン ----
function renderGuides() {
  const box = $("guideList"); box.textContent = "";
  if (!S.guides.length) { const p = document.createElement("p"); p.className = "hint"; p.textContent = "まだありません。「＋ 横線」で足場（足元）の高さ、「＋ 縦線」で中心などの目安を引けます"; box.appendChild(p); }
  S.guides.forEach((g, i) => {
    const row = document.createElement("div"); row.className = "guide-row";
    const sw = document.createElement("span"); sw.className = "swatch-line"; sw.style.background = g.axis === "h" ? "rgb(0,184,217)" : "rgb(255,139,0)";
    const lb = document.createElement("span"); lb.className = "text-sm"; lb.textContent = g.axis === "h" ? "横線 上から" : "縦線 左から";
    const inp = document.createElement("input"); inp.type = "number"; inp.className = "input"; inp.step = "1"; inp.min = "0"; inp.value = String(g.pos);
    inp.setAttribute("aria-label", (g.axis === "h" ? "横線" : "縦線") + " " + (i + 1) + " の位置");
    inp.addEventListener("input", () => { const v = Math.round(+inp.value); if (Number.isFinite(v)) { g.pos = v; saveS(); drawEditor(); } });
    const unit = document.createElement("span"); unit.className = "hint"; unit.textContent = "ドット";
    const vis = document.createElement("button"); vis.type = "button"; vis.className = "btn btn-sm btn-ghost"; vis.textContent = g.hidden ? "表示" : "隠す";
    vis.addEventListener("click", () => { g.hidden = !g.hidden; saveS(); renderGuides(); drawEditor(); });
    const del = document.createElement("button"); del.type = "button"; del.className = "btn btn-sm btn-ghost"; del.textContent = "✕"; del.title = "この線を消す"; del.setAttribute("aria-label", "この線を消す");
    del.addEventListener("click", () => { S.guides.splice(i, 1); saveS(); renderGuides(); drawEditor(); });
    row.append(sw, lb, inp, unit, vis, del);
    box.appendChild(row);
  });
}
function addGuide(axis: "h" | "v") {
  const size = doc ? (axis === "h" ? doc.ch : doc.cw) : 32;
  S.guides.push({ axis, pos: axis === "h" ? size - Math.max(1, Math.round(size / 8)) : Math.floor(size / 2) });
  S.showGuides = true; saveS(); applySettings();
  const ins = $("guideList").querySelectorAll("input"); if (ins.length) ins[ins.length - 1].focus();
}
$btn("btnGuideH").addEventListener("click", () => addGuide("h"));
$btn("btnGuideV").addEventListener("click", () => addGuide("v"));
$in("guidesInAnim").addEventListener("change", (e) => { S.guidesInAnim = (e.target as HTMLInputElement).checked; saveS(); });

// ---- 領域の大きさ（境目のドラッグと、高さのつまみ） ----
function applySizes() {
  document.querySelector<HTMLElement>(".work")!.style.setProperty("--side-w", S.sideW + "px");
  $("animStage").style.height = S.animH + "px";
  $("strip").style.height = S.stripH + "px";
}
(() => {
  const sp = $("splitter"), work = document.querySelector<HTMLElement>(".work")!;
  let start: { x: number; w: number } | null = null;
  sp.addEventListener("pointerdown", (e) => { e.preventDefault(); sp.setPointerCapture(e.pointerId); sp.classList.add("on"); start = { x: e.clientX, w: S.sideW }; });
  sp.addEventListener("pointermove", (e) => {
    if (!start) return;
    const max = Math.max(240, work.clientWidth - 320);
    S.sideW = Math.round(Math.max(220, Math.min(max, start.w - (e.clientX - start.x))));
    applySizes(); if (!S.edZoom) drawEditor();
  });
  const end = () => { if (!start) return; start = null; sp.classList.remove("on"); saveS(); };
  sp.addEventListener("pointerup", end); sp.addEventListener("pointercancel", end);
  sp.addEventListener("dblclick", () => { S.sideW = DEF.sideW; applySizes(); saveS(); if (!S.edZoom) drawEditor(); });
  // アニメ確認の下の境目で高さを変える
  const hs = $("animSplit");
  let hst: { y: number; h: number } | null = null;
  hs.addEventListener("pointerdown", (e) => { e.preventDefault(); hs.setPointerCapture(e.pointerId); hs.classList.add("on"); hst = { y: e.clientY, h: $("animStage").getBoundingClientRect().height }; });
  hs.addEventListener("pointermove", (e) => { if (!hst) return; S.animH = Math.round(Math.max(120, Math.min(2000, hst.h + e.clientY - hst.y))); applySizes(); });
  const hend = () => { if (!hst) return; hst = null; hs.classList.remove("on"); saveS(); };
  hs.addEventListener("pointerup", hend); hs.addEventListener("pointercancel", hend);
  hs.addEventListener("dblclick", () => { S.animH = DEF.animH; applySizes(); saveS(); });
  // 高さのつまみで変えた大きさを覚える
  let t = 0;
  const ro = new ResizeObserver(() => {
    clearTimeout(t);
    t = window.setTimeout(() => {
      const a = Math.round($("animStage").getBoundingClientRect().height), s = Math.round($("strip").getBoundingClientRect().height);
      if (a && s && (a !== S.animH || s !== S.stripH)) { S.animH = a; S.stripH = s; saveS(); }
    }, 200);
  });
  ro.observe($("animStage")); ro.observe($("strip"));
})();

// ---- フィルタ ----
function fVal(k: string): number | string | boolean | undefined {
  const d = FDEF[S.filter.type];
  const p = d.params.find((q) => q[0] === k), c = (d.colors || []).find((q) => q[0] === k);
  const v = S.filter.v[S.filter.type + "." + k];
  return v !== undefined ? v : p ? p[5] : c ? c[2] : k === "diag" ? false : undefined;
}
function setFVal(k: string, v: number | string | boolean) { S.filter.v[S.filter.type + "." + k] = v; saveS(); refreshPreview(); }
function renderFilterUi() {
  const sel = $sel("fType");
  if (!sel.options.length) for (const [k, d] of Object.entries(FDEF)) { const o = document.createElement("option"); o.value = k; o.textContent = d.label; sel.appendChild(o); }
  if (!FDEF[S.filter.type]) S.filter.type = "blur";
  sel.value = S.filter.type;
  const d = FDEF[S.filter.type], box = $("fParams"); box.textContent = "";
  for (const [k, name, min, max, step] of d.params) {
    const row = document.createElement("label"); row.className = "prm";
    const n = document.createElement("span"); n.textContent = name;
    const r = document.createElement("input"); r.type = "range"; r.className = "range"; r.min = String(min); r.max = String(max); r.step = String(step); r.value = String(fVal(k));
    const val = document.createElement("span"); val.className = "val"; val.textContent = String(fVal(k));
    r.addEventListener("input", () => { val.textContent = r.value; setFVal(k, +r.value); });
    row.append(n, r, val); box.appendChild(row);
  }
  for (const [k, name] of d.colors || []) {
    const row = document.createElement("div"); row.className = "row";
    const n = document.createElement("span"); n.className = "text-sm"; n.style.width = "64px"; n.textContent = name;
    const c = document.createElement("input"); c.type = "color"; c.value = String(fVal(k)); c.setAttribute("aria-label", name);
    c.style.cssText = "width:34px;height:26px;padding:0;border:1px solid var(--line);border-radius:6px;background:var(--bg)";
    const hx = document.createElement("span"); hx.className = "mono text-xs"; hx.textContent = String(fVal(k));
    c.addEventListener("input", () => { hx.textContent = c.value; setFVal(k, c.value); });
    const b = document.createElement("button"); b.type = "button"; b.className = "btn btn-sm btn-ghost"; b.textContent = "描く色"; b.title = "今の描く色を入れる";
    b.addEventListener("click", () => { c.value = S.color; hx.textContent = S.color; setFVal(k, S.color); });
    row.append(n, c, hx, b); box.appendChild(row);
  }
  if (d.diag) {
    const row = document.createElement("label"); row.className = "row text-sm";
    const c = document.createElement("input"); c.type = "checkbox"; c.className = "checkbox"; c.checked = !!fVal("diag");
    c.addEventListener("change", () => setFVal("diag", c.checked));
    row.append(c, document.createTextNode(" 斜めも（8方向）")); box.appendChild(row);
  }
  $("fNoNewRow").hidden = !d.noNew; $("fKeepRow").hidden = !d.keep;
  $in("fNoNew").checked = S.filter.noNew; $in("fKeep").checked = S.filter.keep; $sel("fScope").value = S.filter.scope;
  $("fHint").textContent = FHINT[S.filter.type] + " 欄を開いている間は、掛ける範囲のコマをドット編集・アニメ確認・コマ一覧でプレビューします。";
  pvCache = null;
}
$sel("fType").addEventListener("change", (e) => { S.filter.type = (e.target as HTMLSelectElement).value as FilterType; saveS(); renderFilterUi(); refreshPreview(); });
$in("fNoNew").addEventListener("change", (e) => { S.filter.noNew = (e.target as HTMLInputElement).checked; saveS(); refreshPreview(); });
$in("fKeep").addEventListener("change", (e) => { S.filter.keep = (e.target as HTMLInputElement).checked; saveS(); refreshPreview(); });
$sel("fScope").addEventListener("change", (e) => { S.filter.scope = (e.target as HTMLSelectElement).value as FilterPrefs["scope"]; saveS(); refreshPreview(); });
$in("fPreview").addEventListener("change", refreshPreview);
$("filterBox").addEventListener("toggle", refreshPreview);

function filterTargets() {
  const d = doc!, sc = S.filter.scope, t = d.frames[cur].tag;
  return d.frames.filter((f, i) => (sc === "all" ? true : sc === "act" ? f.tag === t : selSet.has(i)));
}
function filterParams(): FilterParams {
  const F: FilterParams = { type: S.filter.type, noNew: S.filter.noNew, keep: S.filter.keep };
  const d = FDEF[F.type], put = F as Record<string, unknown>;
  for (const p of d.params) put[p[0]] = +fVal(p[0])!;
  for (const c of d.colors || []) put[c[0]] = fVal(c[0]);
  if (d.diag) F.diag = !!fVal("diag");
  return F;
}
function filterCtx(F: FilterParams, targets: Frame[]): FilterCtx {
  const all = sheetColors([...doc!.frames.map((f) => f.px), ...doc!.variants.map((v) => v.img)]);
  return { pal: all, post: F.type === "posterize" ? medianCut(sheetColors(targets.map((f) => f.px)), F.n!) : null };
}
// プレビュー: フィルタ欄が開いている間、掛ける範囲のコマは掛けた絵を仮のコマにして返す
// （ドット編集・アニメ確認・コマ一覧のどれにも出す）。設定かコマの絵が変わったら作り直す
let pvCache: { key: string; ctx: FilterCtx; frames: Map<number, { px: ImageData; img: ImageData; P: number }> } | null = null;
function filterPreview(f: Frame | null | undefined): Frame | null {
  if (!f || !doc || !$in("fPreview").checked || !$<HTMLDetailsElement>("filterBox").open) return null;
  const targets = filterTargets();
  if (!targets.includes(f)) return null;
  const F = filterParams(), key = JSON.stringify(F) + "|" + targets.map((t) => t.id).join(",");
  if (!pvCache || pvCache.key !== key) pvCache = { key, ctx: filterCtx(F, targets), frames: new Map() };
  let e = pvCache.frames.get(f.id);
  if (!e || e.px !== f.px) {
    const r = runFilter(f.px, F, pvCache.ctx);
    e = { px: f.px, img: r.img, P: r.P };
    pvCache.frames.set(f.id, e);
  }
  return { ...f, px: e.img, lx: f.lx - e.P, ly: f.ly - e.P };
}
function previewOf(f: Frame) { return filterPreview(f) || f; }
let pvStripTimer = 0;
function refreshPreview() { pvCache = null; drawEditor(); clearTimeout(pvStripTimer); pvStripTimer = window.setTimeout(renderStrip, 150); }
$btn("btnFilter").addEventListener("click", () => {
  if (!doc || !doc.frames.length) return;
  if (float) stampFloat();
  const targets = filterTargets(), F = filterParams(), ctx = filterCtx(F, targets);
  commit();
  for (const f of targets) { const r = runFilter(f.px, F, ctx); f.px = r.img; f.lx -= r.P; f.ly -= r.P; }
  pvCache = null;
  if (F.type === "posterize" || F.type === "replace" || !F.noNew) countPalette();
  refreshAll();
  IT.toast(targets.length + " コマに「" + FDEF[F.type].label + "」を掛けました（元に戻すで戻せます）");
});

// ---- セルの大きさ ----
$sel("cellAnchor").addEventListener("change", (e) => { S.cellAnchor = (e.target as HTMLSelectElement).value as Settings["cellAnchor"]; saveS(); });
$btn("btnCell").addEventListener("click", () => {
  const d = doc!;
  const nw = Math.max(1, Math.min(1024, Math.round(+$in("cellW").value || d.cw))), nh = Math.max(1, Math.min(1024, Math.round(+$in("cellH").value || d.ch)));
  if (nw === d.cw && nh === d.ch) return;
  const a = S.cellAnchor, ox = a === "tl" ? 0 : Math.floor((nw - d.cw) / 2), oy = a === "tl" ? 0 : a === "b" ? nh - d.ch : Math.floor((nh - d.ch) / 2);
  if (float) stampFloat();
  commit();
  selRect = null;
  for (const f of d.frames) { f.dx += ox; f.dy += oy; }
  d.cw = nw; d.ch = nh;
  refreshAll();
  IT.toast("セルを " + nw + "×" + nh + " にしました");
});

// ---- 背景を透過 ----
$in("bgKey").addEventListener("input", (e) => { $("bgKeyHex").textContent = (e.target as HTMLInputElement).value; });
$in("bgTol").addEventListener("input", (e) => { S.bgTol = +(e.target as HTMLInputElement).value; $("bgTolV").textContent = String(S.bgTol); saveS(); });
$sel("bgMode").addEventListener("change", (e) => { S.bgMode = (e.target as HTMLSelectElement).value as Settings["bgMode"]; saveS(); });
$btn("btnBgPick").addEventListener("click", () => {
  if (!doc || !doc.frames.length) return;
  const c = ctx2d(compose(doc.frames[0])).getImageData(0, 0, 1, 1).data;
  if (!c[3]) { IT.toast("左上はもう透明です"); return; }
  $in("bgKey").value = rgbHex(c); $("bgKeyHex").textContent = rgbHex(c);
});
$btn("btnBg").addEventListener("click", () => {
  if (!doc || !doc.frames.length) return;
  if (float) stampFloat();
  const key = hexRgb($in("bgKey").value), outer = S.bgMode === "outer";
  commit();
  // セルごとに見るため、絵をセルいっぱいに広げてから透過する
  for (const f of doc.frames) {
    beginEdit(f, true);
    f.px = keyOut(f.px, key, S.bgTol, outer);
  }
  countPalette(); refreshAll();
  IT.toast("全コマの背景を透過しました（元に戻すで戻せます）");
});

// ---- 作業の保存・読込 ----
const WORK_APP = "imagetools-sprite-polish", WORK_KEY = "sprite-polish:work";
type WorkFile = {
  app: string; version: number; name: string; cw: number; ch: number; tagDir: Record<string, string>; savedAt: string;
  frames: { png: string; lx: number; ly: number; dx: number; dy: number; dur: number; tag: string }[];
  variants?: { name: string; png: string; lx: number; ly: number; at?: [number, number, number][] }[];
};
function serializeWork(): WorkFile {
  const d = doc!;
  return {
    app: WORK_APP, version: 2, name: d.name, cw: d.cw, ch: d.ch, tagDir: d.tagDir || {}, savedAt: new Date().toISOString(),
    frames: d.frames.map((f) => ({ png: canvasOf(f.px).toDataURL(), lx: f.lx, ly: f.ly, dx: f.dx, dy: f.dy, dur: f.dur, tag: f.tag })),
    variants: d.variants.map((v) => ({
      name: v.name, png: canvasOf(v.img).toDataURL(), lx: v.lx, ly: v.ly,
      at: d.frames.map((f, i): [number, number, number] | null => (v.at[f.id] ? [i, v.at[f.id].x, v.at[f.id].y] : null)).filter((a): a is [number, number, number] => !!a),
    })),
  };
}
function pngToPx(url: string): Promise<ImageData> {
  return new Promise((res, rej) => {
    if (!/^data:image\//.test(String(url))) { rej(new Error("画像のデータではありません")); return; }
    const im = new Image();
    im.onload = () => { const c = document.createElement("canvas"); c.width = im.width; c.height = im.height; const x = ctx2d(c, { willReadFrequently: true }); x.drawImage(im, 0, 0); res(x.getImageData(0, 0, c.width, c.height)); };
    im.onerror = () => rej(new Error("画像を読めません"));
    im.src = url;
  });
}
async function openWork(data: WorkFile, label?: string) {
  try {
    const frames: Frame[] = [];
    for (const f of data.frames) frames.push(newFrame(await pngToPx(f.png), { lx: f.lx | 0, ly: f.ly | 0, dx: f.dx | 0, dy: f.dy | 0, dur: f.dur || 100, tag: String(f.tag || "anim1") }));
    const variants: Variant[] = [];
    for (const v of data.variants || []) {
      const at: Record<number, Pos> = {};
      // 版 1 はパーツの位置をセルの中の位置で持っていた
      const rel = (data.version | 0) >= 2;
      for (const [i, x, y] of v.at || []) if (frames[i]) at[frames[i].id] = rel ? { x, y } : { x: x - frames[i].dx, y: y - frames[i].dy };
      variants.push({ id: nextId++, name: String(v.name), img: await pngToPx(v.png), lx: v.lx | 0, ly: v.ly | 0, at });
    }
    isSample = false; $("sampleNote").hidden = true;
    const tmp = { cw: data.cw, ch: data.ch, frames, variants } as Doc;
    // 「この分割で読み直す」用の元画像は、開いた時点の絵を並べたシートにする
    const prevDoc = doc; doc = tmp;
    let src: HTMLCanvasElement, l: Layout;
    try {
      const set: SheetSet = { suffix: "", rows: actions().map((n) => ({ name: n, items: frames.filter((f) => f.tag === n).map((f) => ({ f, v: null })) })) };
      src = renderSheet(set); l = layoutOf(set);
    } finally { doc = prevDoc; }
    $in("gCols").value = String(l.cols); $in("gRows").value = String(l.rows);
    setDoc(data.name || "work.png", src, data.cw, data.ch, l.cols, frames, variants);
    doc!.tagDir = data.tagDir && typeof data.tagDir === "object" ? data.tagDir : {};
    $("srcNote").textContent = (label || "作業ファイル") + " から " + frames.length + " コマ" + (variants.length ? "・差分 " + variants.length + " 件" : "") + "を開きました";
  } catch { IT.toast("作業ファイルを開けませんでした"); }
}
$btn("btnWorkSave").addEventListener("click", () => {
  if (float) stampFloat();
  IT.saveFile(baseOf($in("baseName").value || "sprite_sheet") + ".polish.json", new Blob([JSON.stringify(serializeWork())], { type: "application/json" }));
});
let autoTimer = 0, autoWarned = false;
function scheduleAutosave() {
  // 何も直していないうち・起動時のサンプルを触っただけのときは残さない（前回の作業を上書きしないように）
  if (!doc || !undoStack.length || isSample) return;
  clearTimeout(autoTimer);
  autoTimer = window.setTimeout(() => {
    if (!IT.store.set(WORK_KEY, serializeWork()) && !autoWarned) { autoWarned = true; IT.toast("シートが大きく、ブラウザに自動では残せません。「作業を保存」を使ってください", 4000); }
    syncRestoreBtn();
  }, 1500);
}
function syncRestoreBtn() {
  const w = IT.store.get<WorkFile>(WORK_KEY, null), b = $btn("btnWorkRestore");
  b.hidden = !(w && w.app === WORK_APP);
  if (w && !b.hidden && w.savedAt) b.title = "自動で残した作業（" + new Date(w.savedAt).toLocaleString() + "）";
}
$btn("btnWorkRestore").addEventListener("click", () => { const w = IT.store.get<WorkFile>(WORK_KEY, null); if (w) openWork(w, "前回の作業"); });

IT.initDrop({
  zone: "drop", input: "fileInput",
  accept: (f) => f.type.startsWith("image/") || /\.json$/i.test(f.name),
  onFiles: loadFiles, emptyMessage: "画像ファイルが見つかりませんでした",
});
window.addEventListener("resize", () => { if (!S.edZoom) drawEditor(); });

// テストから中の状態を見られるようにする（単体 HTML だった頃のグローバル変数と同じ名前）
Object.assign(window, {
  IT, DEF, WORK_KEY, actions, asepriteJson, cellBox, compose, composeShown, composeVar, exportSets, filterPreview, getPx, layoutOf,
  neighbor, pngName, serializeWork, sheetColors,
});
// 再代入される変数は、そのときの値を返す（selRect はテストから書き換えもする）
for (const [name, get] of Object.entries({ S: () => S, doc: () => doc, cur: () => cur, isSample: () => isSample, undoStack: () => undoStack, redoStack: () => redoStack }))
  Object.defineProperty(window, name, { get, configurable: true });
Object.defineProperty(window, "selRect", { get: () => selRect, set: (v: Box | null) => { selRect = v; }, configurable: true });

applySettings();
refreshAll();
syncRestoreBtn();
// 他のツールの「仕上げツールで開く」から開かれたときは、サンプルの代わりに渡されたシートを読む
const sampleIfEmpty = () => { if (!doc) $btn("btnSample").click(); };
if (!IT.receive((files) => loadFiles(files).then(sampleIfEmpty), sampleIfEmpty)) $btn("btnSample").click();
requestAnimationFrame(tick);
