/* ドット絵 中割りツールの画面 */
import { IT } from "@common/it";
import { encodeAPNG, encodeGIF } from "./encode";
import { EASES, buildPlan as buildPlanWith, fromHex, lum, packRGB, renderPlan as renderPlanWith, toHex, type Move, type Px, type TweenOptions } from "./tween";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const $in = (id: string) => $<HTMLInputElement>(id);
const $btn = (id: string) => $<HTMLButtonElement>(id);
const toast = IT.toast;

// ================= 状態 =================
type Frame = { kind: "key" | "tween"; key?: Key; tag?: string; label: string; px: Px; edited: boolean; undo: Px[]; redo: Px[]; redoBak?: Px[] };
type Key = { id: number; name: string; raw: ImageData; px: Px | null; frame: Frame | null };
type Seg = { pair: string; n: number; ease: string };
type Rect = { x: number; y: number; w: number; h: number };
type Float = Rect & { px: Px };
type State = {
  W: number; H: number;
  keys: Key[]; segs: Seg[]; segMemo?: Map<string, Seg>; frames: Frame[];
  sel: number; baseName: string;
  selRect?: Rect | null; float?: Float | null;
};
type Prefs = {
  n: number; ease: string; loop: boolean; align: string; comps: boolean; nearColor: boolean; extras: string; prio: string; holes: boolean;
  anchor: string; bgMode: string; zoom: string; grid: boolean; onion: boolean; keyMs: number; tweenMs: number; playMode: string; cols: number; scale: string;
};

const S: State = {
  W: 0, H: 0,
  keys: [],    // { id, name, raw:{w,h,data}, px:Uint32Array, frame }
  segs: [],    // { n, ease }  i 番目 = keys[i] → keys[i+1]（ループ時は最後 → 最初）
  frames: [],  // { kind:"key"|"tween", key?, tag?, label, px, edited, undo:[], redo:[] }
  sel: 0,
  baseName: "inbetween",
};
let nextKeyId = 1;
const P = {} as Prefs; // 保存する設定（applyPrefs で埋める）

// 中割りの処理にいまのコマの大きさと設定を渡す
const tweenOpt = (): TweenOptions => ({ W: S.W, H: S.H, align: P.align, comps: P.comps, nearColor: P.nearColor, extras: P.extras, prio: P.prio, holes: P.holes });
const buildPlan = (pxA: Px, pxB: Px) => buildPlanWith(pxA, pxB, tweenOpt());
const renderPlan = (moves: Move[], t: number) => renderPlanWith(moves, t, tweenOpt());

// ================= 読み込み =================
async function fileToImageData(file: Blob): Promise<ImageData> {
  const bmp = await createImageBitmap(file);
  const c = document.createElement("canvas");
  c.width = bmp.width; c.height = bmp.height;
  const x = c.getContext("2d", { willReadFrequently: true })!;
  x.drawImage(bmp, 0, 0);
  if (bmp.close) bmp.close();
  return x.getImageData(0, 0, c.width, c.height);
}
function cropImageData(img: ImageData, sx: number, sy: number, w: number, h: number): ImageData {
  const out = new ImageData(w, h);
  for (let y = 0; y < h; y++) {
    const s = ((sy + y) * img.width + sx) * 4;
    out.data.set(img.data.subarray(s, s + w * 4), y * w * 4);
  }
  return out;
}
const natural = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

function gridOfName(name: string, w: number, h: number): [number, number] | null {
  // 拡張子を除いた名前の末尾だけを見る。割り切れて 1 コマが 4 ドット以上のときだけ（「tree_32x32」のようなコマの大きさの名前を避ける）
  const m = String(name).replace(/\.[a-z0-9]+$/i, "").match(/(?<!\d)(\d+)\s*[xX×]\s*(\d+)$/);
  if (!m) return null;
  const c = +m[1], r = +m[2];
  return c >= 1 && r >= 1 && c <= 64 && r <= 64 && c * r > 1 && w % c === 0 && h % r === 0 && w / c >= 4 && h / r >= 4 ? [c, r] : null;
}
const stripGrid = (s: string) => s.replace(/[_\-\s]*(?<!\d)\d+\s*[xX×]\s*\d+$/, "");
async function loadFiles(input: Iterable<File>, append: boolean) {
  const files = [...input].sort(natural);
  const raws: { name: string; img: ImageData }[] = [];
  let byName = false;
  try {
    for (const f of files) {
      const img = await fileToImageData(f);
      const nm = f.name.replace(/\.[^.]+$/, "");
      // 1 枚だけで、ファイル名の最後に「列x行」があれば、その数でシートとして分割する（その読み込みだけ。入力欄は変えない）
      const g = files.length === 1 && gridOfName(f.name, img.width, img.height);
      if (g) { byName = true; toast(`ファイル名から ${g[0]}×${g[1]} のシートとして分割しました`); }
      if (g || ($in("splitOn").checked && files.length === 1)) {
        const cols = g ? g[0] : clampInt($in("splitCols").value, 1, 64), rows = g ? g[1] : clampInt($in("splitRows").value, 1, 64);
        const cw = Math.floor(img.width / cols), ch = Math.floor(img.height / rows);
        if (cw < 1 || ch < 1) { toast("分割数が多すぎます"); return; }
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
          const cell = cropImageData(img, c * cw, r * ch, cw, ch);
          raws.push({ name: `${nm}_${r * cols + c + 1}`, img: cell });
        }
      } else raws.push({ name: nm, img });
    }
  } catch { toast("画像を読み込めませんでした"); return; }
  // 中身が空のコマ（分割したシートの余り）は捨てる
  const kept = raws.filter((r) => { const d = r.img.data; for (let i = 3; i < d.length; i += 4) if (d[i] >= 128) return true; return false; });
  if (!kept.length) { toast("絵のある画像が見つかりませんでした"); return; }
  if (files.length > 1 && kept.length < raws.length) toast(`透明な画像 ${raws.length - kept.length} 枚はキー絵にしませんでした`);
  // 分割に使った名前の「列x行」と、複数枚のときの末尾の連番は外す（書き出すときに付け直す）
  if (!append) {
    let b = files[0].name.replace(/\.[^.]+$/, "");
    if (byName) b = stripGrid(b);
    if (files.length > 1) b = b.replace(/[_\-\s]*\d+$/, "");
    S.keys = []; S.segs = []; S.segMemo = new Map(); S.frames = []; S.baseName = b || "inbetween";
  }
  for (const r of kept) S.keys.push({ id: nextKeyId++, name: r.name, raw: r.img, px: null, frame: null });
  const change = normalizeKeys();
  if (S.keys.length < 2) toast("キー絵を2枚以上入れると中割りを作れます");
  afterKeysChanged(change);
}

// 背景を透明にし、半透明は 0 か 255 にそろえ、全キーを同じ大きさに置き直す
// force = false のときは、大きさが変わらなければ手直し済みのキー絵をそのまま残す
// 戻り値: "size" = コマの大きさが変わった / "rebuilt" = 大きさはそのままで全キーを置き直した / null = それ以外
type KeysChange = "size" | "rebuilt" | null;
function normalizeKeys(force?: boolean): KeysChange {
  let W = 0, H = 0;
  for (const k of S.keys) { W = Math.max(W, k.raw.width); H = Math.max(H, k.raw.height); }
  const same = W === S.W && H === S.H;
  S.W = W; S.H = H;
  for (const k of S.keys) {
    if (!force && same && k.px) continue;
    const { width: w, height: h } = k.raw;
    const src = new Uint32Array(k.raw.data.buffer.slice(0));
    const bg = P.bgMode === "corner" ? src[0] : null;
    let ox = 0, oy = 0;
    if (P.anchor === "center") { ox = (W - w) >> 1; oy = (H - h) >> 1; }
    else if (P.anchor === "bottom") { ox = (W - w) >> 1; oy = H - h; }
    const px = new Uint32Array(W * H);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let c = src[y * w + x];
      if ((c >>> 24) < 128 || (bg !== null && c === bg)) c = 0; else c = (c | 0xff000000) >>> 0;
      px[(y + oy) * W + x + ox] = c;
    }
    k.px = px;
    k.frame = { kind: "key", key: k, label: "", px, edited: false, undo: [], redo: [] };
  }
  const big = W > 256 || H > 256;
  $("sizeInfo").innerHTML = S.keys.length ? `1コマ <span class="mono">${W}×${H}</span> px・キー絵 ${S.keys.length} 枚` + (big ? `<br><span class="warn">256px 角を超えているので、作り直しに時間がかかることがあります</span>` : "") : "";
  return !same ? "size" : force ? "rebuilt" : null;
}

// change は normalizeKeys の戻り値。コマの大きさが変わったら古い大きさのコマは使えないので、すぐ作り直す
function afterKeysChanged(change?: KeysChange) {
  ensureSegs();
  renderKeyList();
  renderSegList();
  rebuildPalette();
  if (change === "size") {
    const lost = S.frames.some((f) => f.kind === "tween" && f.edited);
    clearTimeout(genTimer); genTimer = 0;
    generate(false);
    if (lost) toast("絵の大きさが変わったので、手直しした中割りも作り直しました", 4000);
  } else if (change === "rebuilt") {
    // キー絵を置き直したので、コマの並びも新しいキー絵で組み直す（手直しした中割りは残す）
    clearTimeout(genTimer); genTimer = 0;
    generate(true);
  } else requestGenerate();
}

// 区間の設定はキー絵の組（id）にひも付けるので、並べ替えや削除をしても同じ組の設定が残る
function ensureSegs() {
  const count = S.keys.length < 2 ? 0 : S.keys.length - 1 + (P.loop ? 1 : 0);
  // 一度作った組の設定は覚えておき、並べ替えで組が戻ったときにも使う
  const memo = (S.segMemo = S.segMemo || new Map<string, Seg>());
  for (const sg of S.segs) memo.set(sg.pair, sg);
  S.segs = [];
  for (let i = 0; i < count; i++) {
    const [a, b] = segEnds(i), pair = a.id + ">" + b.id;
    if (!memo.has(pair)) memo.set(pair, { pair, n: P.n, ease: P.ease });
    S.segs.push(memo.get(pair)!);
  }
}

// ================= コマの組み立て =================
function segEnds(i: number): [Key, Key] { return [S.keys[i], S.keys[(i + 1) % S.keys.length]]; }
function generate(keepEdited: boolean) {
  hideBanner();
  const keep = new Map<string, Frame>();
  // 大きさの違うコマは残せない（念のため）
  if (keepEdited) for (const f of S.frames) if (f.kind === "tween" && f.edited && f.px.length === S.W * S.H) keep.set(f.tag!, f);
  const selected = S.frames[S.sel];
  const frames: Frame[] = [];
  S.keys.forEach((k, i) => {
    const kf = k.frame!;
    frames.push(kf);
    kf.label = "K" + (i + 1);
    if (i >= S.segs.length) return;
    const [a, b] = segEnds(i), seg = S.segs[i], ease = (EASES[seg.ease] || EASES.linear).f;
    let plan: Move[] | null = null;
    for (let s = 1; s <= seg.n; s++) {
      const tag = `${a.id}>${b.id}#${s}/${seg.n}`;
      const label = `${i + 1}→${(i + 1) % S.keys.length + 1} ${s}/${seg.n}`;
      if (keep.has(tag)) { const f = keep.get(tag)!; f.label = label; frames.push(f); continue; }
      plan = plan || buildPlan(a.px!, b.px!);
      frames.push({ kind: "tween", tag, label, px: renderPlan(plan, ease(s / (seg.n + 1))), edited: false, undo: [], redo: [] });
    }
  });
  S.frames = frames;
  const idx = frames.indexOf(selected);
  S.sel = idx >= 0 ? idx : Math.min(S.sel, Math.max(0, frames.length - 1));
  S.selRect = null; S.float = null;
  refreshAll();
}
let genTimer = 0;
function runGenerate() {
  genTimer = 0;
  if (S.frames.some((f) => f.kind === "tween" && f.edited)) { $("banner").hidden = false; return; }
  generate(false);
}
function requestGenerate() {
  clearTimeout(genTimer);
  genTimer = window.setTimeout(runGenerate, 60);
}
// 書き出しの直前に、待っている作り直しを済ませる（読み込み直後に保存してもコマが空にならないように）
function flushGenerate() { if (genTimer) { clearTimeout(genTimer); runGenerate(); } }
function hideBanner() { $("banner").hidden = true; }
$("btnKeep").onclick = () => generate(true);
$("btnOverwrite").onclick = () => generate(false);
$("btnLater").onclick = hideBanner;

// ================= 画面の更新 =================
function pxCanvas(px: Px, w = S.W, h = S.H): HTMLCanvasElement {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const img = new ImageData(w, h); new Uint32Array(img.data.buffer).set(px);
  c.getContext("2d")!.putImageData(img, 0, 0);
  return c;
}
function thumb(px: Px, cls?: string) {
  const c = pxCanvas(px); c.className = cls || ""; return c;
}
function renderKeyList() {
  const box = $("keyList"); box.innerHTML = "";
  if (!S.keys.length) { box.innerHTML = `<p class="empty">キー絵がありません</p>`; return; }
  S.keys.forEach((k, i) => {
    const row = document.createElement("div"); row.className = "keyrow";
    const cv = thumb(k.px!, "bg-checker");
    const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = `K${i + 1}  ${k.name}`; nm.title = k.name;
    row.append(cv, nm);
    const mk = (txt: string, title: string, fn: () => void, dis?: boolean) => { const b = document.createElement("button"); b.type = "button"; b.className = "btn btn-sm btn-ghost"; b.textContent = txt; b.title = title; b.disabled = !!dis; b.onclick = fn; row.append(b); };
    mk("↑", "前へ", () => moveKey(i, -1), i === 0);
    mk("↓", "後ろへ", () => moveKey(i, 1), i === S.keys.length - 1);
    mk("×", "このキー絵を外す", () => { S.keys.splice(i, 1); if (!S.keys.length) { S.frames = []; S.W = S.H = 0; } afterKeysChanged(normalizeKeys()); });
    box.append(row);
  });
}
function moveKey(i: number, d: number) {
  const j = i + d; [S.keys[i], S.keys[j]] = [S.keys[j], S.keys[i]];
  afterKeysChanged();
}
function renderSegList() {
  const box = $("segList"); box.innerHTML = "";
  S.segs.forEach((seg, i) => {
    const row = document.createElement("div"); row.className = "segrow";
    const tag = document.createElement("span"); tag.className = "tag"; tag.textContent = `K${i + 1}→K${(i + 1) % S.keys.length + 1}`;
    const n = document.createElement("select"); n.className = "select"; n.innerHTML = nOptions(); n.value = String(seg.n); n.setAttribute("aria-label", tag.textContent + " の中割りの枚数");
    n.onchange = () => { seg.n = +n.value; requestGenerate(); };
    const e = document.createElement("select"); e.className = "select"; e.innerHTML = easeOptions(); e.value = seg.ease; e.setAttribute("aria-label", tag.textContent + " のつなぎ方");
    e.onchange = () => { seg.ease = e.value; requestGenerate(); };
    row.append(tag, n, e); box.append(row);
  });
  if (!S.segs.length) box.innerHTML = `<p class="hint">キー絵が2枚以上になると、区間ごとに枚数とつなぎ方を変えられます。</p>`;
}
const nOptions = () => [1, 2, 3, 4, 5, 6, 7].map((v) => `<option value="${v}">${v} 枚</option>`).join("");
const easeOptions = () => Object.entries(EASES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("");

function renderTimeline() {
  const box = $("timeline"); box.innerHTML = "";
  if (!S.frames.length) { box.innerHTML = `<p class="empty">キー絵を読み込むと、ここにコマが並びます</p>`; return; }
  S.frames.forEach((f, i) => {
    const d = document.createElement("button"); d.type = "button";
    d.className = "tl" + (f.kind === "key" ? " key" : "") + (i === S.sel ? " sel" : "");
    d.append(thumb(f.px, "bg-checker"));
    const cap = document.createElement("span"); cap.className = "cap";
    cap.innerHTML = (f.edited ? `<span class="ed">✎</span> ` : "") + f.label;
    d.append(cap);
    d.title = f.kind === "key" ? "キー絵 " + f.label : "中割り " + f.label;
    d.onclick = () => selectFrame(i);
    box.append(d);
  });
  const cur = box.children[S.sel]; if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: "nearest", inline: "nearest" });
}
function updateTimelineItem(i: number) {
  const d = $("timeline").children[i], f = S.frames[i];
  if (!d || !f) return;
  d.replaceChild(thumb(f.px, "bg-checker"), d.firstChild!);
  (d.lastChild as HTMLElement).innerHTML = (f.edited ? `<span class="ed">✎</span> ` : "") + f.label;
}
function selectFrame(i: number) {
  if (!S.frames.length || drag) return; // ドラッグ中はコマを替えない
  commitFloat();
  S.sel = (i + S.frames.length) % S.frames.length;
  S.selRect = null;
  [...$("timeline").children].forEach((d, k) => d.classList.toggle("sel", k === S.sel));
  const cur = $("timeline").children[S.sel]; if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: "nearest", inline: "nearest" });
  drawEditor();
}
function refreshAll() {
  renderTimeline();
  drawEditor();
  restartPreview();
  const ok = S.frames.length > 0;
  ["btnSheet", "btnGif", "btnApng", "btnPolish"].forEach((id) => ($btn(id).disabled = !ok));
}

// ================= 手直し =================
type Tool = "pen" | "eraser" | "picker" | "fill" | "select";
type Point = { x: number; y: number };
const ed = $<HTMLCanvasElement>("ed"), edx = ed.getContext("2d")!;
let tool: Tool = "pen", curColor = fromHex("#222034");
const cur = (): Frame | undefined => S.frames[S.sel];
function zoomLevel() {
  if (+P.zoom) return +P.zoom;
  const avail = Math.max(64, $("edStage").clientWidth - 26);
  return Math.max(1, Math.min(24, Math.floor(Math.min(avail / S.W, 480 / S.H))));
}
function tinted(px: Px, rgb: [number, number, number]) {
  const t = new Uint32Array(px.length), c = (0x70000000 | (rgb[2] << 16) | (rgb[1] << 8) | rgb[0]) >>> 0;
  for (let i = 0; i < px.length; i++) if (px[i]) t[i] = c;
  return t;
}
function drawEditor() {
  const f = cur();
  if (!f) { ed.width = 1; ed.height = 1; $("frameInfo").textContent = ""; return; }
  const z = zoomLevel(), W = S.W, H = S.H;
  if (ed.width !== W * z || ed.height !== H * z) { ed.width = W * z; ed.height = H * z; }
  edx.imageSmoothingEnabled = false;
  edx.clearRect(0, 0, ed.width, ed.height);
  if (P.onion && S.frames.length > 1) {
    const n = S.frames.length, wrap = P.loop;
    const prev = S.sel > 0 ? S.frames[S.sel - 1] : wrap ? S.frames[n - 1] : null;
    const next = S.sel < n - 1 ? S.frames[S.sel + 1] : wrap ? S.frames[0] : null;
    if (prev) edx.drawImage(pxCanvas(tinted(prev.px, [230, 60, 60])), 0, 0, W * z, H * z);
    if (next) edx.drawImage(pxCanvas(tinted(next.px, [50, 110, 240])), 0, 0, W * z, H * z);
  }
  let px = f.px;
  if (S.float) {
    px = f.px.slice();
    const F = S.float;
    for (let y = 0; y < F.h; y++) for (let x = 0; x < F.w; x++) {
      const c = F.px[y * F.w + x], X = F.x + x, Y = F.y + y;
      if (c && X >= 0 && Y >= 0 && X < W && Y < H) px[Y * W + X] = c;
    }
  }
  edx.drawImage(pxCanvas(px), 0, 0, W * z, H * z);
  if (P.grid && z >= 6) {
    edx.strokeStyle = "rgba(128,128,128,.35)"; edx.lineWidth = 1; edx.beginPath();
    for (let x = 1; x < W; x++) { edx.moveTo(x * z + 0.5, 0); edx.lineTo(x * z + 0.5, H * z); }
    for (let y = 1; y < H; y++) { edx.moveTo(0, y * z + 0.5); edx.lineTo(W * z, y * z + 0.5); }
    edx.stroke();
  }
  const R = S.float ? { x: S.float.x, y: S.float.y, w: S.float.w, h: S.float.h } : S.selRect;
  if (R) {
    const acc = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#0d7f86";
    edx.setLineDash([4, 3]); edx.strokeStyle = acc; edx.lineWidth = 2;
    edx.strokeRect(R.x * z + 1, R.y * z + 1, R.w * z - 2, R.h * z - 2); edx.setLineDash([]);
  }
  $("frameInfo").textContent = `${S.sel + 1} / ${S.frames.length}  ${f.kind === "key" ? "キー絵 " : "中割り "}${f.label}${f.edited ? "（手直し済み）" : ""}`;
  $btn("btnUndo").disabled = !f.undo.length; $btn("btnRedo").disabled = !f.redo.length;
}
function cellAt(e: PointerEvent): Point {
  const r = ed.getBoundingClientRect();
  return { x: Math.floor((e.clientX - r.left) / r.width * S.W), y: Math.floor((e.clientY - r.top) / r.height * S.H) };
}
const inside = (p: Point) => p.x >= 0 && p.y >= 0 && p.x < S.W && p.y < S.H;
function pushUndo(f: Frame) { f.undo.push(f.px.slice()); if (f.undo.length > 60) f.undo.shift(); f.redoBak = f.redo; f.redo = []; }
// 操作のあとに呼ぶ。何も変わらなかった操作（同じ色での塗りつぶしなど）は履歴から外し、手直しの印も付けない
function afterEdit(f: Frame, fromUndo?: boolean) {
  const last = f.undo[f.undo.length - 1];
  if (!fromUndo && last && last.every((c, i) => c === f.px[i])) { f.undo.pop(); f.redo = f.redoBak || []; }
  if (f.kind === "tween") f.edited = f.undo.length > 0;
  updateTimelineItem(S.sel);
  drawEditor();
  if (f.kind === "key") { renderKeyList(); rebuildPalette(); requestGenerate(); }
}
function line(x0: number, y0: number, x1: number, y1: number, fn: (x: number, y: number) => void) {
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) { fn(x0, y0); if (x0 === x1 && y0 === y1) break; const e2 = 2 * err; if (e2 >= dy) { err += dy; x0 += sx; } if (e2 <= dx) { err += dx; y0 += sy; } }
}
function floodFill(px: Px, x: number, y: number, c: number) {
  const W = S.W, H = S.H, from = px[y * W + x];
  if (from === c) return;
  const st: [number, number][] = [[x, y]];
  while (st.length) {
    const [a, b] = st.pop()!;
    if (a < 0 || b < 0 || a >= W || b >= H || px[b * W + a] !== from) continue;
    px[b * W + a] = c;
    st.push([a + 1, b], [a - 1, b], [a, b + 1], [a, b - 1]);
  }
}
function commitFloat() {
  const F = S.float, f = cur();
  if (!F || !f) { S.float = null; return; }
  for (let y = 0; y < F.h; y++) for (let x = 0; x < F.w; x++) {
    const c = F.px[y * F.w + x], X = F.x + x, Y = F.y + y;
    if (c && X >= 0 && Y >= 0 && X < S.W && Y < S.H) f.px[Y * S.W + X] = c;
  }
  S.selRect = { x: F.x, y: F.y, w: F.w, h: F.h };
  S.float = null;
}
type Drag =
  | { mode: "paint"; lx: number; ly: number; c: number }
  | { mode: "rect"; sx: number; sy: number }
  | { mode: "move"; sx: number; sy: number; ox: number; oy: number };
let drag: Drag | null = null;
ed.addEventListener("pointerdown", (e) => {
  const f = cur(); if (!f || e.button > 0) return;
  ed.setPointerCapture(e.pointerId);
  const p = cellAt(e);
  if (tool === "picker") {
    if (inside(p) && f.px[p.y * S.W + p.x]) { setColor(f.px[p.y * S.W + p.x]); setTool("pen"); }
    return;
  }
  if (tool === "select") {
    const R = S.selRect;
    if (R && p.x >= R.x && p.y >= R.y && p.x < R.x + R.w && p.y < R.y + R.h) {
      pushUndo(f);
      const F: Float = { x: R.x, y: R.y, w: R.w, h: R.h, px: new Uint32Array(R.w * R.h) };
      for (let y = 0; y < R.h; y++) for (let x = 0; x < R.w; x++) {
        const X = R.x + x, Y = R.y + y;
        if (X < 0 || Y < 0 || X >= S.W || Y >= S.H) continue;
        F.px[y * R.w + x] = f.px[Y * S.W + X]; f.px[Y * S.W + X] = 0;
      }
      S.float = F;
      drag = { mode: "move", sx: p.x, sy: p.y, ox: R.x, oy: R.y };
    } else {
      S.selRect = null;
      const d = { mode: "rect", sx: clampInt(p.x, 0, S.W - 1), sy: clampInt(p.y, 0, S.H - 1) } as const;
      drag = d;
      S.selRect = { x: d.sx, y: d.sy, w: 1, h: 1 };
    }
    drawEditor(); return;
  }
  if (!inside(p)) return;
  pushUndo(f);
  if (tool === "fill") { floodFill(f.px, p.x, p.y, curColor); afterEdit(f); return; }
  const c = tool === "eraser" ? 0 : curColor;
  f.px[p.y * S.W + p.x] = c;
  drag = { mode: "paint", lx: p.x, ly: p.y, c };
  drawEditor();
});
ed.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const f = cur()!, p = cellAt(e), d = drag;
  if (d.mode === "paint") {
    line(d.lx, d.ly, p.x, p.y, (x, y) => { if (inside({ x, y })) f.px[y * S.W + x] = d.c; });
    d.lx = p.x; d.ly = p.y; drawEditor();
  } else if (d.mode === "rect") {
    const x = clampInt(p.x, 0, S.W - 1), y = clampInt(p.y, 0, S.H - 1);
    S.selRect = { x: Math.min(x, d.sx), y: Math.min(y, d.sy), w: Math.abs(x - d.sx) + 1, h: Math.abs(y - d.sy) + 1 };
    drawEditor();
  } else if (d.mode === "move") {
    S.float!.x = d.ox + p.x - d.sx; S.float!.y = d.oy + p.y - d.sy; drawEditor();
  }
});
const endDrag = () => {
  if (!drag) return;
  const f = cur()!, mode = drag.mode; drag = null;
  if (mode === "paint") afterEdit(f);
  else if (mode === "move") { commitFloat(); afterEdit(f); }
};
ed.addEventListener("pointerup", endDrag);
ed.addEventListener("pointercancel", endDrag);

function setTool(t: Tool) {
  if (t !== "select") { commitFloat(); S.selRect = null; }
  tool = t;
  document.querySelectorAll<HTMLElement>("#tools [data-tool]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.tool === t ? "true" : "false"));
  ed.classList.toggle("t-select", t === "select");
  drawEditor();
}
document.querySelectorAll<HTMLElement>("#tools [data-tool]").forEach((b) => (b.onclick = () => setTool(b.dataset.tool as Tool)));
function setColor(c: number) {
  curColor = c; $in("curColor").value = toHex(c);
  document.querySelectorAll<HTMLElement>("#palette .sw").forEach((s) => s.classList.toggle("on", +s.dataset.c! === c));
}
$("curColor").addEventListener("input", (e) => setColor(fromHex((e.target as HTMLInputElement).value)));
function rebuildPalette() {
  const set = new Set<number>();
  for (const k of S.keys) for (const c of k.px!) if (c) { set.add(c); if (set.size >= 256) break; }
  const list = [...set].sort((a, b) => lum(a) - lum(b));
  const box = $("palette"); box.innerHTML = "";
  for (const c of list) {
    const b = document.createElement("button"); b.type = "button"; b.className = "sw"; b.style.background = toHex(c);
    b.dataset.c = String(c); b.title = toHex(c); b.setAttribute("aria-label", "色 " + toHex(c));
    b.onclick = () => { setColor(c); if (tool === "eraser" || tool === "picker") setTool("pen"); };
    box.append(b);
  }
  if (list.length && !set.has(curColor)) setColor(list[0]); else setColor(curColor);
}
function undo(redo: boolean) {
  const f = cur(); if (!f) return;
  commitFloat();
  const from = redo ? f.redo : f.undo, to = redo ? f.undo : f.redo;
  if (!from.length) return;
  to.push(f.px.slice()); f.px.set(from.pop()!);
  S.selRect = null;
  afterEdit(f, true);
}
$("btnUndo").onclick = () => undo(false);
$("btnRedo").onclick = () => undo(true);

// キー操作（入力欄にフォーカスがあるときは使わない）
document.addEventListener("keydown", (e) => {
  const tag = (e.target as HTMLElement | null)?.tagName || "";
  if (/INPUT|SELECT|TEXTAREA/.test(tag) || drag) return; // ドラッグ中のキーは無視する
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); undo(e.shiftKey); return; }
  if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); undo(true); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "ArrowLeft") { e.preventDefault(); selectFrame(S.sel - 1); }
  else if (e.key === "ArrowRight") { e.preventDefault(); selectFrame(S.sel + 1); }
  else if (e.key === "Escape") { commitFloat(); S.selRect = null; drawEditor(); }
  else if ((e.key === "Delete" || e.key === "Backspace") && S.selRect && cur()) {
    e.preventDefault();
    const f = cur()!, R = S.selRect; pushUndo(f);
    for (let y = R.y; y < R.y + R.h; y++) for (let x = R.x; x < R.x + R.w; x++) if (x >= 0 && y >= 0 && x < S.W && y < S.H) f.px[y * S.W + x] = 0;
    afterEdit(f);
  }
  else if (k === "b" || k === "p") setTool("pen");
  else if (k === "e") setTool("eraser");
  else if (k === "i") setTool("picker");
  else if (k === "g") setTool("fill");
  else if (k === "m") setTool("select");
});
window.addEventListener("resize", () => { if (!+P.zoom) drawEditor(); });

// ================= プレビュー =================
const pv = $<HTMLCanvasElement>("pv"), pvx = pv.getContext("2d")!;
let playing = true, pvTimer = 0, pvPos = 0;
function playOrder() {
  const n = S.frames.length, o = [...Array(n).keys()];
  if (P.playMode === "pingpong" && n > 2) for (let i = n - 2; i >= 1; i--) o.push(i);
  return o;
}
const durOf = (f: Frame) => clampInt(f.kind === "key" ? P.keyMs : P.tweenMs, 16, 5000);
function drawPreview(i: number) {
  const f = S.frames[i]; if (!f) return;
  const s = Math.max(1, Math.min(8, Math.floor(260 / Math.max(S.W, S.H))));
  if (pv.width !== S.W * s || pv.height !== S.H * s) { pv.width = S.W * s; pv.height = S.H * s; }
  pvx.imageSmoothingEnabled = false; pvx.clearRect(0, 0, pv.width, pv.height);
  pvx.drawImage(pxCanvas(f.px), 0, 0, pv.width, pv.height);
}
function tick() {
  const order = playOrder(); if (!order.length) return;
  pvPos %= order.length;
  const i = order[pvPos];
  drawPreview(i);
  pvPos++;
  if (playing) pvTimer = window.setTimeout(tick, durOf(S.frames[i]));
}
function restartPreview() {
  clearTimeout(pvTimer); pvPos = 0;
  if (!S.frames.length) { pv.width = 1; pv.height = 1; return; }
  if (playing) tick(); else drawPreview(S.sel);
}
$("btnPlay").onclick = () => {
  playing = !playing; $("btnPlay").textContent = playing ? "停止" : "再生";
  clearTimeout(pvTimer);
  if (playing) tick(); else drawPreview(S.sel);
};

// ================= 書き出し =================
function scaled(px: Px, s: number): Px {
  const W = S.W, H = S.H;
  if (s === 1) return px;
  const out = new Uint32Array(W * s * H * s);
  for (let y = 0; y < H * s; y++) for (let x = 0; x < W * s; x++) out[y * W * s + x] = px[((y / s) | 0) * W + ((x / s) | 0)];
  return out;
}
function sheetOf(s: number) {
  const n = S.frames.length, cols = Math.min(clampInt(P.cols, 1, 64), n), rows = Math.ceil(n / cols);
  const c = document.createElement("canvas"); c.width = cols * S.W * s; c.height = rows * S.H * s;
  const x = c.getContext("2d")!; x.imageSmoothingEnabled = false;
  S.frames.forEach((f, i) => x.drawImage(pxCanvas(f.px), (i % cols) * S.W * s, Math.floor(i / cols) * S.H * s, S.W * s, S.H * s));
  return { c, cols, rows, name: `${S.baseName}_inbetween${rows <= 64 ? `_${cols}x${rows}` : ""}.png` };
}
function saveSheet() {
  const sh = sheetOf(+P.scale);
  IT.canvasToBlob(sh.c).then((b) => IT.saveFile(sh.name, b), () => toast("PNGを作成できませんでした"));
}
// 仕上げツールへは等倍のシートと、表示時間・アクション名を入れた Aseprite 互換 JSON（Array）を渡す
function openInPolish() {
  const sh = sheetOf(1), W = S.W, H = S.H, n = S.frames.length;
  const frames = S.frames.map((f, i) => ({
    filename: `${S.baseName} ${i}.png`, frame: { x: (i % sh.cols) * W, y: Math.floor(i / sh.cols) * H, w: W, h: H },
    rotated: false, trimmed: false, spriteSourceSize: { x: 0, y: 0, w: W, h: H }, sourceSize: { w: W, h: H }, duration: durOf(f),
  }));
  const json = { frames, meta: { app: "https://www.aseprite.org/", version: "1.3", image: sh.name, format: "RGBA8888", size: { w: sh.c.width, h: sh.c.height }, scale: "1",
    frameTags: [{ name: S.baseName, from: 0, to: n - 1, direction: "forward", color: "#000000ff" }], layers: [], slices: [] } };
  IT.openIn("sprite-polish", IT.canvasToBlob(sh.c).then((b) => [new File([b], sh.name, { type: "image/png" }), new File([JSON.stringify(json)], sh.name.replace(/\.png$/, ".json"), { type: "application/json" })]));
}

function animFrames() {
  // 往復でも同じコマは1回だけ拡大する（大きな倍率でメモリを使いすぎないように）
  const s = +P.scale, order = playOrder(), cache = new Map<number, Px>();
  const get = (i: number) => cache.get(i) || cache.set(i, scaled(S.frames[i].px, s)).get(i)!;
  return { list: order.map(get), delays: order.map((i) => durOf(S.frames[i])), w: S.W * s, h: S.H * s };
}
$("btnSheet").onclick = () => { flushGenerate(); if (S.frames.length) saveSheet(); };
$("btnPolish").onclick = () => { flushGenerate(); if (S.frames.length) openInPolish(); };
$("btnGif").onclick = () => {
  flushGenerate();
  if (!S.frames.length) return;
  const a = animFrames();
  IT.saveFile(`${S.baseName}_inbetween.gif`, new Blob([encodeGIF(a.list, a.w, a.h, a.delays)], { type: "image/gif" }));
};
$("btnApng").onclick = async () => {
  flushGenerate();
  if (!S.frames.length) return;
  if (typeof CompressionStream === "undefined") { toast("このブラウザでは APNG を作れません"); return; }
  const a = animFrames();
  try { IT.saveFile(`${S.baseName}_inbetween_anim.png`, await encodeAPNG(a.list, a.w, a.h, a.delays)); }
  catch { toast("APNGを作成できませんでした"); }
};

// ================= サンプル =================
// 32×32 のスライム（待機 → つぶれ → 跳ね上がり）をその場で描く
function sampleSlime(cx: number, cy: number, rx: number, ry: number): ImageData {
  const W = 32, img = new ImageData(W, W), px = new Uint32Array(img.data.buffer);
  const O = packRGB(34, 32, 52), B = packRGB(106, 190, 48), D = packRGB(55, 148, 110), L = packRGB(203, 240, 160);
  const ins = (x: number, y: number) => ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1;
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    if (!ins(x, y)) continue;
    let c = y + 0.5 > cy + ry * 0.4 ? D : B;
    if (!ins(x - 1, y) || !ins(x + 1, y) || !ins(x, y - 1) || !ins(x, y + 1)) c = O;
    else if (((x + 0.5 - (cx - rx * 0.45)) / (rx * 0.22)) ** 2 + ((y + 0.5 - (cy - ry * 0.45)) / (ry * 0.2)) ** 2 <= 1) c = L;
    px[y * W + x] = c;
  }
  for (const sx of [-1, 1]) {
    const ex = Math.round(cx + sx * rx * 0.35 - 0.5), ey = Math.round(cy - ry * 0.1 - 0.5);
    px[ey * W + ex] = O; px[(ey + 1) * W + ex] = O;
  }
  return img;
}
function loadSample() {
  S.keys = []; S.segs = []; S.segMemo = new Map(); S.frames = []; S.baseName = "sample_slime";
  const shapes: [string, number, number, number, number][] = [["待機", 16, 23, 9, 7], ["つぶれ", 16, 26.5, 11.5, 4], ["跳ね上がり", 16, 13, 7, 10]];
  shapes.forEach(([nm, ...a]) =>
    S.keys.push({ id: nextKeyId++, name: "見本_" + nm, raw: sampleSlime(...a), px: null, frame: null }));
  afterKeysChanged(normalizeKeys());
}
$("btnSample").onclick = loadSample;

// ================= 入力の受付 =================
IT.initDrop({ zone: "drop", input: "fileInput", accept: (f) => f.type.startsWith("image/") || /\.(png|gif|bmp|webp|jpe?g)$/i.test(f.name), onFiles: (files) => loadFiles(files, false), emptyMessage: "画像ファイルが見つかりませんでした" });
$("addInput").addEventListener("change", (e) => { const t = e.target as HTMLInputElement, fs = [...(t.files || [])]; t.value = ""; if (fs.length) loadFiles(fs, true); });

// ================= 設定の記憶 =================
// IT.store の pixel-inbetween:settings に 1 オブジェクトで保存する（読み込んだ絵・分割数・区間ごとの設定は保存しない）
const PREFS_KEY = "pixel-inbetween:settings";
const PREF_DEFAULTS: Prefs = { n: 3, ease: "linear", loop: true, align: "centroid", comps: true, nearColor: true, extras: "merge", prio: "edge", holes: true, anchor: "center", bgMode: "alpha", zoom: "0", grid: true, onion: true, keyMs: 160, tweenMs: 80, playMode: "loop", cols: 8, scale: "1" };
type PrefKey = keyof Prefs;
const PREF_KEYS = Object.keys(PREF_DEFAULTS) as PrefKey[];
const CHECKS: PrefKey[] = ["loop", "comps", "nearColor", "holes", "grid", "onion"];
// 保存済みの値は型を確かめずにそのまま入れる（移行前と同じ）ので、書き込みは緩い型で行う
const PW = P as Record<PrefKey, unknown>;
let restoring = false;
function clampInt(v: unknown, lo: number, hi: number) { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo; }
function applyPrefs(p: Partial<Record<PrefKey, unknown>>) {
  restoring = true;
  for (const k of PREF_KEYS) {
    const v = p[k] !== undefined ? p[k] : PREF_DEFAULTS[k];
    PW[k] = v;
    const el = document.getElementById(k) as HTMLInputElement | HTMLSelectElement | null; if (!el) continue;
    if (CHECKS.includes(k)) (el as HTMLInputElement).checked = !!v; else el.value = String(v);
    if (!CHECKS.includes(k) && el.tagName === "SELECT" && el.value !== String(v)) { el.value = String(PREF_DEFAULTS[k]); PW[k] = PREF_DEFAULTS[k]; }
  }
  restoring = false;
}
function savePrefs() { if (!restoring) IT.store.set(PREFS_KEY, { ...P }); }
$("n").innerHTML = nOptions(); $("ease").innerHTML = easeOptions();
// 設定が変わったときの反映先
type Effect = "none" | "segs" | "gen" | "keys" | "draw" | "pv";
const EFFECT: Record<PrefKey, Effect> = {
  n: "none", ease: "none", loop: "segs", align: "gen", comps: "gen", nearColor: "gen", extras: "gen", prio: "gen", holes: "gen",
  anchor: "keys", bgMode: "keys", zoom: "draw", grid: "draw", onion: "draw", keyMs: "pv", tweenMs: "pv", playMode: "pv", cols: "none", scale: "none",
};
for (const k of PREF_KEYS) {
  const el = $<HTMLInputElement>(k);
  el.addEventListener("change", () => {
    if (CHECKS.includes(k)) PW[k] = el.checked;
    else if (k === "keyMs" || k === "tweenMs" || k === "cols") { P[k] = clampInt(el.value, +el.min || 1, +el.max || 9999); el.value = String(P[k]); }
    else if (k === "n") P[k] = +el.value;
    else PW[k] = el.value;
    savePrefs();
    applyEffect(EFFECT[k]);
  });
}
function applyEffect(kind: Effect) {
  if (kind === "gen") requestGenerate();
  else if (kind === "segs") { ensureSegs(); renderSegList(); requestGenerate(); }
  else if (kind === "keys") { if (S.keys.length) afterKeysChanged(normalizeKeys(true)); }
  else if (kind === "draw") drawEditor();
  else if (kind === "pv") restartPreview();
}
$("btnApplyAll").onclick = () => { S.segs.forEach((s) => { s.n = P.n; s.ease = P.ease; }); renderSegList(); requestGenerate(); };
$("btnResetPrefs").onclick = () => {
  const before = P.anchor + "/" + P.bgMode;
  applyPrefs(PREF_DEFAULTS); IT.store.remove(PREFS_KEY);
  if (S.keys.length && before !== P.anchor + "/" + P.bgMode) afterKeysChanged(normalizeKeys(true));
  else { ensureSegs(); renderSegList(); requestGenerate(); }
  drawEditor(); restartPreview();
  toast("設定をリセットしました");
};
{ const saved = IT.store.get<Record<string, unknown>>(PREFS_KEY); applyPrefs(saved && typeof saved === "object" ? saved : {}); }

// テストから中の状態を見られるようにする（単体 HTML だった頃のグローバル変数と同じ名前）
Object.assign(window, { IT, S, P, loadFiles, gridOfName, buildPlan, renderPlan, packRGB, animFrames, encodeGIF, encodeAPNG });

setTool("pen");
loadSample();
// シート仕上げの「中割りツールで開く」から開かれたときは、渡されたコマをキー絵にする（届くまではサンプルのまま）
IT.receive((files) => loadFiles(files, false));
