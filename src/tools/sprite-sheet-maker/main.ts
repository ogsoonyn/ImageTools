/* スプライトシート作成の画面 */
import { IT } from "@common/it";
import { changedBox, commonPrefix, contentBoxOf, gridFromName, hexToRgb, keyOutPixels, type BgMode, type KeyOpts, type LumColor, type Rect } from "./keyout";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const $in = (id: string) => $<HTMLInputElement>(id);
const $sl = (id: string) => $<HTMLSelectElement>(id);
const $btn = (id: string) => $<HTMLButtonElement>(id);
const toast = IT.toast;
const ctx2d = (c: HTMLCanvasElement, opts?: CanvasRenderingContext2DSettings) => c.getContext("2d", opts) as CanvasRenderingContext2D;

// コマ: {id, name, src: canvas(元画像), w, h}
type Cache = { key: string; cell: HTMLCanvasElement; box: Rect | null | undefined };
type Frame = {
  id: number; name: string; src: HTMLCanvasElement; w: number; h: number; dx: number; dy: number;
  fileName?: string; cache?: Cache; overflow?: boolean;
};
type Layout = { W: number; H: number; cols: number; rows: number; cw: number; ch: number; rects: Rect[]; sheet?: true };
type Anchor = "bottom" | "top" | "left" | "right" | "center" | "none";
type Group = { anchor: Anchor; w: number; h: number; bx: number; by: number; bw: number; bh: number };

let frames: Frame[] = [];
let sel = -1;
let nextId = 1, pasteSeq = 1;
let crop: Rect | null = null;     // {x, y, w, h}（元画像の座標。全コマ共通）
let layout: Layout | null = null; // 直近に組んだシートの配置
let usedSample = false;

// ---- 読み込み ----
async function fileToCanvas(blob: Blob) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement("canvas");
  c.width = bmp.width; c.height = bmp.height;
  // 重複チェックやスポイトで画素を読むので、読み出し向けのコンテキストにしておく
  ctx2d(c, { willReadFrequently: true }).drawImage(bmp, 0, 0);
  bmp.close();
  return c;
}
function sameImage(a: HTMLCanvasElement | undefined, b: HTMLCanvasElement | undefined) {
  if (!a || !b || a.width !== b.width || a.height !== b.height) return false;
  const da = ctx2d(a, { willReadFrequently: true }).getImageData(0, 0, a.width, a.height).data;
  const db = ctx2d(b, { willReadFrequently: true }).getImageData(0, 0, b.width, b.height).data;
  for (let i = 0; i < da.length; i += 4) if (da[i] !== db[i] || da[i + 1] !== db[i + 1] || da[i + 2] !== db[i + 2] || da[i + 3] !== db[i + 3]) return false;
  return true;
}
// 旧キー抜きツールの URL（?mode=keyout）から来たか
const FROM_KEYOUT = new URLSearchParams(location.search).get("mode") === "keyout";
async function addImages(list: File[], { fromPaste = false } = {}) {
  // まとめて入れた連番はファイル名の自然順に並べる（colon9 → colon10）
  if (!fromPaste && list.length > 1) list = [...list].sort((a, b) => (a.name || "").localeCompare(b.name || "", undefined, { numeric: true, sensitivity: "base" }));
  const fresh = !frames.length || usedSample;
  const added: Frame[] = [];
  for (const f of list) {
    try {
      const src = await fileToCanvas(f);
      const generic = !f.name || /^image\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name);
      const name = fromPaste || generic ? "paste_" + String(pasteSeq++).padStart(3, "0") : f.name.replace(/\.[^.]+$/, "");
      added.push({ id: nextId++, name, src, w: src.width, h: src.height, dx: 0, dy: 0, fileName: f.name || "" });
    } catch {
      toast((f.name || "画像") + " を読み込めませんでした");
    }
  }
  if (!added.length) return;
  // 自分の画像を入れたらサンプルは片付けてボタンも隠す（混ざって出力されるのを防ぐ）
  if (usedSample) { frames = []; sel = -1; crop = null; usedSample = false; restorePrefsAfterSample(); }
  $("sampleRow").hidden = true;
  if (fresh && !fromPaste) {
    // 最初に入れた画像の名前から出力ファイル名を決める。「列x行」付きの1枚はできあがったシートとみなす。
    // 旧キー抜きツールの URL から来たときは、旧ツールと同じく1枚ならいつもシートとして扱う
    const grid = added.length === 1 ? gridFromName(added[0].fileName!) : null;
    if (grid || (added.length === 1 && FROM_KEYOUT)) {
      $in("srcCols").value = String(grid ? grid.cols : 1); $in("srcRows").value = String(grid ? grid.rows : 1); $in("srcCount").value = "0";
      setSheetMode(true);
      toast(grid ? "ファイル名から " + grid.cols + "x" + grid.rows + " のシートとして読み込みました（透過だけ行います）" : "1枚のシートとして読み込みました。分割数を指定してください", 3500);
    } else if (added.length > 1) setSheetMode(false);
    const pref = added.length === 1 ? added[0].name : commonPrefix(added.map((f) => f.name)).replace(/[_\-\s.]*\d*$/, "");
    if (pref) $in("baseName").value = pref;
  }
  const insertAt = $in("insertAfterSel").checked && sel >= 0 ? sel + 1 : frames.length;
  const prev = frames[insertAt - 1];
  if (added.length === 1 && prev && sameImage(prev.src, added[0].src)) toast("直前のコマと同じ画像です（追加はしました）", 3000);
  frames.splice(insertAt, 0, ...added);
  sel = insertAt + added.length - 1;
  if (!crop) setCrop(fullRect());
  else clampCrop();
  flash();
  refreshAll();
  if (added.length === 1 && fromPaste) toast((sel + 1) + " コマ目を追加しました");
}
function flash() {
  const z = $("drop"); z.classList.add("flash");
  setTimeout(() => z.classList.remove("flash"), 300);
}

IT.initDrop({
  zone: "drop",
  input: "fileInput",
  accept: (f) => f.type.startsWith("image/"),
  onFiles: (files) => addImages(files),
  emptyMessage: "画像ファイルが見つかりませんでした",
});
$("drop").addEventListener("click", () => $in("fileInput").click());
$("drop").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $in("fileInput").click(); } });

const isTag = (t: EventTarget | null, ...tags: string[]) => !!t && tags.includes((t as Element).tagName);
// クリップボード貼り付け（ページのどこにフォーカスがあっても受ける。入力欄での文字の貼り付けは邪魔しない）
document.addEventListener("paste", (e) => {
  const items = [...(e.clipboardData ? e.clipboardData.items : [])];
  const files = items.filter((it) => it.kind === "file" && it.type.startsWith("image/")).map((it) => it.getAsFile()).filter((f): f is File => !!f);
  if (!files.length) {
    if (!isTag(e.target, "INPUT", "TEXTAREA")) toast("クリップボードに画像がありません");
    return;
  }
  e.preventDefault();
  // Windows のスクショは image/png 1 つ。ブラウザによっては同じ画像が複数形式で入るので 1 枚にする
  addImages([files[0]], { fromPaste: true });
});

// ---- コマ一覧 ----
function renderStrip() {
  const strip = $("strip");
  strip.textContent = "";
  $("countBadge").textContent = String(frames.length);
  $btn("btnClear").disabled = $btn("btnReverse").disabled = !frames.length;
  if (!frames.length) {
    const d = document.createElement("div");
    d.className = "strip-empty";
    d.textContent = "スクリーンショットを撮って、このページで Ctrl+V を押すとコマが増えていきます";
    strip.appendChild(d);
    return;
  }
  const base = frames[0];
  frames.forEach((f, i) => {
    const el = document.createElement("div");
    el.className = "thumb" + (i === sel ? " sel" : "");
    el.draggable = true;
    el.dataset.i = String(i);
    el.setAttribute("role", "option");
    el.setAttribute("aria-selected", String(i === sel));
    const box = document.createElement("div");
    box.className = "img bg-checker";
    const c = document.createElement("canvas");
    const s = Math.min(1, 120 / f.w, 72 / f.h);
    c.width = Math.max(1, Math.round(f.w * s)); c.height = Math.max(1, Math.round(f.h * s));
    const x = ctx2d(c); x.imageSmoothingQuality = "high"; x.drawImage(f.src, 0, 0, c.width, c.height);
    box.appendChild(c);
    const meta = document.createElement("div");
    meta.className = "meta";
    const odd = f.w !== base.w || f.h !== base.h;
    meta.innerHTML = '<span class="num mono"></span><span class="mono text-muted"></span>';
    const [num, size] = meta.children as HTMLCollectionOf<HTMLElement>;
    num.textContent = "#" + (i + 1);
    size.textContent = f.w + "×" + f.h;
    if (odd) { size.className = "badge badge-warn"; size.title = "1コマ目とサイズが違います"; }
    const name = document.createElement("div");
    name.className = "text-xs text-muted mono";
    name.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    name.textContent = f.name; name.title = f.name;
    const ops = document.createElement("div");
    ops.className = "ops";
    const mk = (op: string, label: string, title: string, fn: () => void, dis?: boolean) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "btn btn-sm"; b.textContent = label; b.title = title; b.disabled = !!dis;
      b.dataset.op = op;
      b.setAttribute("aria-label", "#" + (i + 1) + " を" + title.replace(/^このコマを/, ""));
      b.addEventListener("click", (e) => { e.stopPropagation(); fn(); restoreFocus(op); });
      ops.appendChild(b);
    };
    mk("prev", "◀", "前へ移動", () => move(i, i - 1), i === 0);
    mk("next", "▶", "後ろへ移動", () => move(i, i + 1), i === frames.length - 1);
    mk("del", "✕", "このコマを削除", () => removeAt(i));
    const flags = document.createElement("div");
    flags.className = "flags";
    if (f.dx || f.dy) { const b = document.createElement("span"); b.className = "badge badge-soft mono"; b.textContent = "ずらし " + f.dx + "," + f.dy; flags.appendChild(b); }
    if (f.overflow) { const b = document.createElement("span"); b.className = "badge badge-warn"; b.textContent = "はみ出し"; b.title = "揃えた結果、絵の一部がセルの外に出ています"; flags.appendChild(b); }
    el.append(box, meta, name, flags, ops);
    el.addEventListener("click", () => select(i));
    // ドラッグ並べ替え（ファイルのドロップとは dataTransfer の種類で区別する）
    el.addEventListener("dragstart", (e) => { e.dataTransfer!.setData("text/x-frame", String(i)); e.dataTransfer!.effectAllowed = "move"; el.classList.add("dragging"); });
    el.addEventListener("dragend", () => el.classList.remove("dragging"));
    el.addEventListener("dragover", (e) => { if ([...e.dataTransfer!.types].includes("text/x-frame")) { e.preventDefault(); el.classList.add("drag-over"); } });
    el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
    el.addEventListener("drop", (e) => {
      const from = e.dataTransfer!.getData("text/x-frame");
      el.classList.remove("drag-over");
      if (from === "") return;
      e.preventDefault();
      move(+from, i);
    });
    strip.appendChild(el);
  });
  const selEl = strip.children[sel];
  if (selEl) selEl.scrollIntoView({ block: "nearest", inline: "nearest" });
}
// ボタン操作で一覧を作り直したあと、移動先（削除なら次のコマ）の同じボタンにフォーカスを戻す
function restoreFocus(op: string) {
  const strip = $("strip");
  const b = strip.querySelector<HTMLElement>('.thumb[data-i="' + sel + '"] button[data-op="' + op + '"]:not(:disabled)')
    || strip.querySelector<HTMLElement>('.thumb[data-i="' + sel + '"] button:not(:disabled)');
  (b || strip).focus();
}
function select(i: number) {
  if (!frames.length) return;
  sel = Math.max(0, Math.min(frames.length - 1, i));
  renderStrip(); drawCrop(); syncNudgeUi();
}
function move(from: number, to: number) {
  if (to < 0 || to >= frames.length || from === to) return;
  const [f] = frames.splice(from, 1);
  frames.splice(to, 0, f);
  sel = to;
  refreshAll();
}
function removeAt(i: number) {
  frames.splice(i, 1);
  // 選択中より前のコマを消したら、同じコマを選んだままにする
  if (i < sel || sel >= frames.length) sel = Math.max(frames.length ? 0 : -1, sel - 1);
  if (!frames.length) { crop = null; resetSheetMode(); }
  else clampCrop(); // 一番大きいコマを消すと、範囲が残りのコマの外に出ることがある
  syncCropInputs();
  refreshAll();
}
let clearArmed = 0;
$("btnClear").addEventListener("click", () => {
  const b = $("btnClear");
  if (!clearArmed) {
    b.textContent = "もう一度押すと全削除"; b.classList.add("danger");
    clearArmed = window.setTimeout(() => { clearArmed = 0; b.textContent = "すべて削除"; b.classList.remove("danger"); }, 3000);
    return;
  }
  clearTimeout(clearArmed); clearArmed = 0; b.textContent = "すべて削除"; b.classList.remove("danger");
  frames = []; sel = -1; crop = null; resetSheetMode(); syncCropInputs(); refreshAll();
  toast("すべてのコマを削除しました");
});
$("btnReverse").addEventListener("click", () => { frames.reverse(); if (sel >= 0) sel = frames.length - 1 - sel; refreshAll(); });

document.addEventListener("keydown", (e) => {
  if (isTag(e.target, "INPUT", "SELECT", "TEXTAREA", "BUTTON")) return;
  if (e.ctrlKey || e.metaKey || !frames.length || sel < 0) return;
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    const d = e.key === "ArrowLeft" ? -1 : 1;
    e.preventDefault();
    if (e.altKey) move(sel, sel + d); else select(sel + d);
  } else if (e.key === "Delete") {
    e.preventDefault(); removeAt(sel);
  }
});

// ---- トリミング範囲 ----
function maxSize() {
  return { w: Math.max(1, ...frames.map((f) => f.w)), h: Math.max(1, ...frames.map((f) => f.h)) };
}
function fullRect(): Rect { const m = maxSize(); return { x: 0, y: 0, w: m.w, h: m.h }; }
function clampCrop() {
  if (!crop) return;
  const m = maxSize();
  crop.w = Math.max(1, Math.min(Math.round(crop.w), m.w));
  crop.h = Math.max(1, Math.min(Math.round(crop.h), m.h));
  crop.x = Math.max(0, Math.min(Math.round(crop.x), m.w - crop.w));
  crop.y = Math.max(0, Math.min(Math.round(crop.y), m.h - crop.h));
}
function setCrop(r: Rect) { crop = { ...r }; clampCrop(); syncCropInputs(); }
function syncCropInputs() {
  const r = crop || { x: "", y: "", w: "", h: "" };
  $in("cropX").value = String(r.x); $in("cropY").value = String(r.y); $in("cropW").value = String(r.w); $in("cropH").value = String(r.h);
}
function effectiveCrop() { return $in("useCrop").checked && crop ? crop : fullRect(); }
["cropX", "cropY", "cropW", "cropH"].forEach((id) => $(id).addEventListener("change", () => {
  if (!frames.length) return;
  setCrop({ x: +$in("cropX").value || 0, y: +$in("cropY").value || 0, w: +$in("cropW").value || 1, h: +$in("cropH").value || 1 });
  drawCrop(); rebuild();
}));
$("useCrop").addEventListener("change", () => { $("cropInputs").style.opacity = $in("useCrop").checked ? "" : ".5"; drawCrop(); rebuild(); });
$("btnFullCrop").addEventListener("click", () => { if (!frames.length) return; setCrop(fullRect()); drawCrop(); rebuild(); });

// 全コマを 1 コマ目と見比べ、色が変わったピクセルを囲む矩形を求める
$("btnAutoCrop").addEventListener("click", () => {
  if (frames.length < 2) { toast("2コマ以上あるときに使えます"); return; }
  const m = maxSize();
  const read = (f: Frame) => {
    const c = document.createElement("canvas"); c.width = m.w; c.height = m.h;
    const x = ctx2d(c, { willReadFrequently: true }); x.drawImage(f.src, 0, 0);
    return x.getImageData(0, 0, m.w, m.h).data;
  };
  // 2 コマ目以降は 1 枚ずつ読んで比べる（全部を同時に持たない）
  const rest = function* () { for (let k = 1; k < frames.length; k++) yield read(frames[k]); };
  const b = changedBox(read(frames[0]), rest(), m.w, m.h);
  if (!b) { toast("全コマが同じ画像のため、範囲を検出できませんでした"); return; }
  const { x0, y0, x1, y1 } = b;
  const pad = Math.max(0, +$in("autoMargin").value || 0);
  setCrop({ x: x0 - pad, y: y0 - pad, w: x1 - x0 + 1 + pad * 2, h: y1 - y0 + 1 + pad * 2 });
  $in("useCrop").checked = true; $("cropInputs").style.opacity = "";
  drawCrop(); rebuild();
  toast("変化のある範囲を選択しました（" + crop!.w + "×" + crop!.h + "）");
});

const cc = $<HTMLCanvasElement>("cropCanvas");
const cctx = ctx2d(cc);
function cssScale() { const r = cc.getBoundingClientRect(); return r.width ? cc.width / r.width : 1; }
// トリミング範囲のプレビューに出すコマ（シートとして扱うときは書き出す 1 コマ目）
function viewIndex() { return isSheet() ? 0 : sel; }
function drawCrop() {
  const f = frames[viewIndex()];
  $("cropTitle").textContent = f ? "（#" + (viewIndex() + 1) + " を表示中）" : "";
  if (!f) {
    cc.width = 480; cc.height = 270;
    cctx.clearRect(0, 0, cc.width, cc.height);
    cctx.fillStyle = "rgba(127,127,127,.25)"; cctx.fillRect(0, 0, cc.width, cc.height);
    $("cropInfo").textContent = "";
    return;
  }
  const m = maxSize();
  if (cc.width !== m.w || cc.height !== m.h) { cc.width = m.w; cc.height = m.h; }
  cctx.clearRect(0, 0, cc.width, cc.height);
  cctx.drawImage(f.src, 0, 0);
  const r = effectiveCrop();
  const on = $in("useCrop").checked && !isSheet();
  if (on) {
    cctx.fillStyle = "rgba(0,0,0,.5)";
    cctx.beginPath();
    cctx.rect(0, 0, cc.width, cc.height);
    cctx.rect(r.x, r.y, r.w, r.h);
    cctx.fill("evenodd");
    const k = cssScale();
    const lw = Math.max(1, 2 * k);
    cctx.lineWidth = lw;
    cctx.strokeStyle = "#ffffff"; cctx.strokeRect(r.x + lw / 2, r.y + lw / 2, r.w - lw, r.h - lw);
    cctx.setLineDash([6 * k, 4 * k]); cctx.strokeStyle = "#0d7f86"; cctx.strokeRect(r.x + lw / 2, r.y + lw / 2, r.w - lw, r.h - lw); cctx.setLineDash([]);
    const hs = 10 * k;
    cctx.fillStyle = "#ffffff"; cctx.strokeStyle = "#0d7f86"; cctx.lineWidth = Math.max(1, k);
    for (const [hx, hy] of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]]) {
      cctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs); cctx.strokeRect(hx - hs / 2, hy - hs / 2, hs, hs);
    }
  }
  $("cropInfo").textContent = on ? "x " + r.x + "  y " + r.y + "  " + r.w + "×" + r.h : "全体 " + r.w + "×" + r.h;
}
type Pt = { x: number; y: number };
type HitMode = "nw" | "ne" | "sw" | "se" | "move" | "new";
let drag: { mode: HitMode; start: Pt; rect: Rect } | null = null;
function ptr(e: PointerEvent): Pt {
  const b = cc.getBoundingClientRect();
  return { x: (e.clientX - b.left) * (cc.width / b.width), y: (e.clientY - b.top) * (cc.height / b.height) };
}
function hitTest(p: Pt): HitMode {
  if (!crop || !$in("useCrop").checked) return "new";
  const k = cssScale() * 12, r = crop;
  const corners = { nw: [r.x, r.y], ne: [r.x + r.w, r.y], sw: [r.x, r.y + r.h], se: [r.x + r.w, r.y + r.h] } as const;
  for (const [name, [hx, hy]] of Object.entries(corners)) if (Math.abs(p.x - hx) <= k && Math.abs(p.y - hy) <= k) return name as HitMode;
  if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) return "move";
  return "new";
}
const CURSORS: Record<HitMode, string> = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", move: "move", new: "crosshair" };
cc.addEventListener("pointermove", (e) => {
  if (!frames.length) return;
  const p = ptr(e);
  if (!drag) { cc.style.cursor = pickMode ? "copy" : isSheet() ? "" : CURSORS[hitTest(p)]; return; }
  const m = maxSize(), s = drag.start, r0 = drag.rect;
  const cx = Math.max(0, Math.min(m.w, p.x)), cy = Math.max(0, Math.min(m.h, p.y));
  let r: Rect;
  if (drag.mode === "move") {
    r = { x: r0.x + (p.x - s.x), y: r0.y + (p.y - s.y), w: r0.w, h: r0.h };
  } else {
    // new は始点を固定点に、四隅は対角を固定点にして引き伸ばす
    const ax = drag.mode === "new" ? s.x : drag.mode.includes("w") ? r0.x + r0.w : r0.x;
    const ay = drag.mode === "new" ? s.y : drag.mode.includes("n") ? r0.y + r0.h : r0.y;
    r = { x: Math.min(ax, cx), y: Math.min(ay, cy), w: Math.abs(cx - ax), h: Math.abs(cy - ay) };
    if (r.w < 1 || r.h < 1) return;
  }
  setCrop(r); drawCrop();
});
cc.addEventListener("pointerdown", (e) => {
  if (!frames.length || e.button !== 0) return;
  const p = ptr(e);
  if (pickMode) {
    const f = frames[viewIndex()], px = Math.floor(p.x), py = Math.floor(p.y);
    if (f && px >= 0 && py >= 0 && px < f.w && py < f.h) {
      const v = ctx2d(f.src, { willReadFrequently: true }).getImageData(px, py, 1, 1).data;
      $in("keyColor").value = "#" + [v[0], v[1], v[2]].map((n) => n.toString(16).padStart(2, "0")).join("");
      $in("keyManual").checked = true;
      if ($sl("bgMode").value === "none") $sl("bgMode").value = "flood";
      syncBgUi(); savePrefs(); rebuild();
      toast("消す色を " + $in("keyColor").value.toUpperCase() + " にしました");
    }
    setPick(false);
    return;
  }
  if (isSheet()) return;
  const mode = hitTest(p);
  if (!$in("useCrop").checked) { $in("useCrop").checked = true; $("cropInputs").style.opacity = ""; }
  drag = { mode, start: p, rect: crop ? { ...crop } : fullRect() };
  cc.setPointerCapture(e.pointerId);
});
const endDrag = () => { if (drag) { drag = null; rebuild(); } };
cc.addEventListener("pointerup", endDrag);
cc.addEventListener("pointercancel", endDrag);
window.addEventListener("resize", () => drawCrop());

// ---- シート組み立て ----
const sheet = $<HTMLCanvasElement>("sheet");
const sctx = ctx2d(sheet);
function opts() {
  return {
    cols: Math.max(0, Math.floor(+$in("cols").value || 0)),
    spacing: Math.max(0, Math.floor(+$in("spacing").value || 0)),
    margin: Math.max(0, Math.floor(+$in("margin").value || 0)),
    scale: Math.max(1, +$in("scale").value || 100) / 100,
    smooth: $sl("smoothing").value === "smooth",
    mult4: $in("mult4").checked,
    pot: $in("pot").checked,
  };
}
// ---- 1枚のシートとして扱う（並べ替えずに透過だけ） ----
function isSheet() { return $in("sheetMode").checked && frames.length > 0; }
function setSheetMode(on: boolean) { $in("sheetMode").checked = on; syncSheetUi(); }
function resetSheetMode() { $in("srcCols").value = "1"; $in("srcRows").value = "1"; $in("srcCount").value = "0"; setSheetMode(false); }
function syncSheetUi() {
  const on = $in("sheetMode").checked;
  $("sheetOpts").hidden = !on;
  ["cropSec", "alignSec", "layoutSec"].forEach((id) => { $(id).hidden = on; });
}
$("sheetMode").addEventListener("change", () => { syncSheetUi(); refreshAll(); });
["srcCols", "srcRows", "srcCount"].forEach((id) => $(id).addEventListener("input", scheduleRebuild));
function rebuildSheet(ko: KeyOpts | null) {
  const f = frames[0];
  if (frames.some((g) => g.overflow)) { frames.forEach((g) => { g.overflow = false; }); renderStrip(); }
  const e = keyedCell(f, { x: 0, y: 0, w: f.w, h: f.h }, ko);
  const int = (id: string, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.floor(+$in(id).value || 0)));
  const cols = int("srcCols", 1, 128), rows = int("srcRows", 1, 128);
  const cw = Math.max(1, Math.floor(f.w / cols)), ch = Math.max(1, Math.floor(f.h / rows));
  let count = int("srcCount", 0, 16384);
  if (count <= 0 || count > cols * rows) count = cols * rows;
  sheet.width = f.w; sheet.height = f.h;
  sctx.clearRect(0, 0, f.w, f.h);
  sctx.drawImage(e.cell, 0, 0);
  const rects: Rect[] = [];
  for (let i = 0; i < count; i++) rects.push({ x: (i % cols) * cw, y: Math.floor(i / cols) * ch, w: cw, h: ch });
  layout = { W: f.w, H: f.h, cols, rows, cw, ch, rects, sheet: true };
  sheet.classList.add("pixel");
  const ok = f.w % cols === 0 && f.h % rows === 0;
  $("srcCellInfo").textContent = "1コマ = " + cw + "×" + ch + " px" + (ok ? "" : "（画像 " + f.w + "×" + f.h + " が割り切れません。分割数を確認してください）");
  $("srcCellInfo").classList.toggle("warn", !ok);
  $("sheetInfo").textContent = f.w + "×" + f.h + "（" + cols + "列×" + rows + "行、1コマ " + cw + "×" + ch + "）";
  $("outNote").textContent = pngName() + " / " + pngName().replace(/\.png$/, ".json");
  $("srcNote").textContent = "シートとして読み込み中（" + f.w + "×" + f.h + "）" + (frames.length > 1 ? "。シートとして扱うのは 1 コマ目だけです" : "");
  $("animInfo").textContent = Math.round(1000 / Math.max(10, +$in("duration").value || 100) * 10) / 10 + " fps / " + count + " コマ";
}
function setOutputDisabled(on: boolean) { $btn("btnPng").disabled = $btn("btnJson").disabled = $btn("btnPolish").disabled = on; }
function rebuild() {
  const n = frames.length;
  setOutputDisabled(!n);
  if (!n) {
    layout = null; sheet.width = sheet.height = 1; sctx.clearRect(0, 0, 1, 1);
    $("sheetInfo").textContent = ""; $("outNote").textContent = ""; $("srcNote").textContent = "まだコマがありません";
    return;
  }
  const ko = keyOpts();
  if (isSheet()) { rebuildSheet(ko); return; }
  const o = opts(), r = effectiveCrop();
  // 等倍で切り出して背景を抜いた結果（コマごとにキャッシュ）
  const entries = frames.map((f) => keyedCell(f, r, ko));
  const g = groupBox(entries, r, alignOpts(!!ko));
  // dw, dh は絵を描く大きさ、cw, ch はセルの大きさ（4の倍数に切り上げたときは絵をセルの中央に置く）
  const dw = Math.max(1, Math.round(g.w * o.scale)), dh = Math.max(1, Math.round(g.h * o.scale));
  const cw = o.mult4 ? Math.ceil(dw / 4) * 4 : dw, ch = o.mult4 ? Math.ceil(dh / 4) * 4 : dh;
  const cols = Math.min(n, o.cols || Math.ceil(Math.sqrt(n)));
  const rows = Math.ceil(n / cols);
  let W = o.margin * 2 + cols * cw + (cols - 1) * o.spacing;
  let H = o.margin * 2 + rows * ch + (rows - 1) * o.spacing;
  if (o.pot) { W = 2 ** Math.ceil(Math.log2(W)); H = 2 ** Math.ceil(Math.log2(H)); }
  if (W * H > 16384 * 16384 || W > 32767 || H > 32767) {
    // 古い配置で書き出さないよう、保存できない状態にしておく
    layout = null; sheet.width = sheet.height = 1;
    setOutputDisabled(true);
    $("sheetInfo").textContent = W + "×" + H + " は大きすぎます。倍率か範囲を小さくしてください";
    $("outNote").textContent = "";
    return;
  }
  sheet.width = W; sheet.height = H;
  sctx.clearRect(0, 0, W, H);
  sctx.imageSmoothingEnabled = o.smooth; sctx.imageSmoothingQuality = "high";
  let overflowChanged = false;
  const rects = frames.map((f, i) => {
    const x = o.margin + (i % cols) * (cw + o.spacing), y = o.margin + Math.floor(i / cols) * (ch + o.spacing);
    // セルの中に揃えて描いてから、倍率をかけて配置する（範囲が元画像からはみ出す部分は透明）
    const placed = placeCell(entries[i], f, g);
    if (!!f.overflow !== placed.overflow) { f.overflow = placed.overflow; overflowChanged = true; }
    sctx.drawImage(placed.canvas, 0, 0, g.w, g.h, x + Math.floor((cw - dw) / 2), y + Math.floor((ch - dh) / 2), dw, dh);
    return { x, y, w: cw, h: ch };
  });
  if (overflowChanged) renderStrip();
  layout = { W, H, cols, rows, cw, ch, rects };
  sheet.classList.toggle("pixel", !o.smooth);
  $("sheetInfo").textContent = W + "×" + H + "（" + cols + "列×" + rows + "行、1コマ " + cw + "×" + ch + "）"
    + (W * H > 4096 * 4096 ? " ※Safari では表示・保存できない大きさです" : "");
  $("outNote").textContent = pngName() + " / " + pngName().replace(/\.png$/, ".json");
  const sizes = new Set(frames.map((f) => f.w + "×" + f.h));
  $("srcNote").textContent = n + " コマ" + (sizes.size > 1 ? "（サイズ違いが混在しています）" : "（" + [...sizes][0] + "）");
  $("animInfo").textContent = Math.round(1000 / Math.max(10, +$in("duration").value || 100) * 10) / 10 + " fps / " + n + " コマ";
}
// ---- 背景の透過 ----
// 切り出しと背景の透過はコマごとに結果を持っておき、範囲か透過の設定が変わったときだけ作り直す。
// 揃え・微調整・並べ方の変更は描き直すだけで済む
function keyedCell(f: Frame, r: Rect, ko: KeyOpts | null): Cache {
  const key = [r.x, r.y, r.w, r.h].join(",") + "|" + JSON.stringify(ko);
  if (f.cache && f.cache.key === key) return f.cache;
  const c = document.createElement("canvas");
  c.width = r.w; c.height = r.h;
  ctx2d(c, { willReadFrequently: true }).drawImage(f.src, -r.x, -r.y);
  if (ko) keyOut(c, ko);
  f.cache = { key, cell: c, box: undefined };
  return f.cache;
}
// 透過の設定。何も透過しないときは null（このとき位置の揃えは使えない）
function keyOpts(): KeyOpts | null {
  const mode = $sl("bgMode").value as BgMode, lum = $in("lum").checked;
  if (mode === "none" && !lum) return null;
  const black = +$in("blackPt").value;
  return {
    mode, auto: $in("keyAuto").checked, key: hexToRgb($in("keyColor").value), tol: +$in("tol").value, soft: +$in("soft").value, unblend: $in("unblend").checked,
    lum: lum ? { black, white: Math.max(+$in("whitePt").value, black + 1), color: $sl("lumColor").value as LumColor } : null,
  };
}
function keyOut(c: HTMLCanvasElement, o: KeyOpts) {
  const x = ctx2d(c, { willReadFrequently: true });
  const img = x.getImageData(0, 0, c.width, c.height);
  keyOutPixels(img.data, c.width, c.height, o);
  x.putImageData(img, 0, 0);
}
function syncBgUi() {
  const mode = $sl("bgMode").value;
  $("keyOpts").hidden = mode === "none";
  $("lumOpts").hidden = !$in("lum").checked;
  $("blackPtV").textContent = $in("blackPt").value; $("whitePtV").textContent = $in("whitePt").value;
  $("tolV").textContent = $in("tol").value; $("softV").textContent = $in("soft").value;
  $("keyHex").textContent = $in("keyColor").value.toUpperCase();
  $("bgHint").textContent = mode === "flood"
    ? "範囲の外周から背景色でつながった部分だけを消します。キャラ内部の同じ色は残ります。"
    : "範囲内で指定色に近い画素をすべて消します。単色背景（グリーンバックなど）向けです。";
}
let pickMode = false;
function setPick(on: boolean) { pickMode = on; $("btnPick").setAttribute("aria-pressed", String(on)); cc.style.cursor = on ? "copy" : ""; }
$("btnPick").addEventListener("click", () => { if (!frames.length) { toast("先にコマを追加してください"); return; } setPick(!pickMode); if (pickMode) toast("トリミング範囲のプレビューで色をクリックしてください"); });
let rebuildQueued = false;
// 連続した入力（スライダーやドラッグ）は描画ごとに 1 回へまとめる
function scheduleRebuild() { if (rebuildQueued) return; rebuildQueued = true; requestAnimationFrame(() => { rebuildQueued = false; rebuild(); }); }
// 1 回の操作で複数のリスナーが走っても再構築は 1 回にする（同じタスクの終わりに実行）
let rebuildSoon = false;
function requestRebuild() { if (rebuildSoon) return; rebuildSoon = true; queueMicrotask(() => { rebuildSoon = false; rebuild(); }); }
["tol", "soft", "keyColor", "blackPt", "whitePt"].forEach((id) => $(id).addEventListener("input", () => { syncBgUi(); scheduleRebuild(); }));
$("keyColor").addEventListener("input", () => { $in("keyManual").checked = true; });
["bgMode", "keyAuto", "keyManual", "lum"].forEach((id) => $(id).addEventListener("change", () => { syncBgUi(); syncAlignUi(); savePrefs(); requestRebuild(); }));

// ---- 位置の揃えと微調整 ----
// コマ整列ツールと同じ揃え方: 全コマの絵の最大幅・最大高さの枠をセル中央に置き、
// 各コマの絵はその枠の中で選んだ端に揃える（もう一方の向きは中央）。「中央」は上下左右とも中央
type AlignOpts = { anchor: Anchor; fit: boolean; pad: number };
function alignOpts(keyed: boolean): AlignOpts {
  const anchor = $in("anchor").value as Anchor;
  const fit = keyed && anchor !== "none" && $sl("cellMode").value === "fit";
  return { anchor: keyed ? anchor : "none", fit, pad: fit ? Math.max(0, Math.floor(+$in("cellPad").value || 0)) : 0 };
}
// 不透明な画素（α > 16）を囲む矩形。ぼかしで残ったごく薄い画素は無視する
function contentBox(c: HTMLCanvasElement) {
  return contentBoxOf(ctx2d(c, { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data, c.width, c.height);
}
const boxOf = (e: Cache) => (e.box === undefined ? (e.box = contentBox(e.cell)) : e.box);
// セルの大きさ（等倍）と、揃えの基準になる枠を決める。揃えないときはトリミング範囲がそのままセルになる
function groupBox(entries: Cache[], r: Rect, al: AlignOpts): Group {
  const g: Group = { anchor: "none", w: r.w, h: r.h, bx: 0, by: 0, bw: r.w, bh: r.h };
  if (al.anchor === "none") return g;
  const boxes = entries.map(boxOf).filter((b): b is Rect => !!b);
  if (!boxes.length) return g;
  g.anchor = al.anchor;
  g.bw = Math.max(...boxes.map((b) => b.w)); g.bh = Math.max(...boxes.map((b) => b.h));
  if (al.fit) { g.w = g.bw + al.pad * 2; g.h = g.bh + al.pad * 2; }
  g.bx = Math.floor((g.w - g.bw) / 2); g.by = Math.floor((g.h - g.bh) / 2);
  return g;
}
const placedCanvas = document.createElement("canvas");
// 絵を揃えの枠の中に置き、コマごとのずれ（dx, dy）を足して描く
function placeCell(entry: Cache, f: Frame, g: Group) {
  const cell = entry.cell, w = g.w, h = g.h, out = placedCanvas;
  if (out.width !== w || out.height !== h) { out.width = w; out.height = h; }
  const x = ctx2d(out);
  x.clearRect(0, 0, w, h);
  let ox = 0, oy = 0;
  const box = g.anchor === "none" ? null : entry.box;
  if (box) {
    const a = g.anchor;
    const tx = a === "left" ? g.bx : a === "right" ? g.bx + g.bw - box.w : g.bx + Math.floor((g.bw - box.w) / 2);
    const ty = a === "top" ? g.by : a === "bottom" ? g.by + g.bh - box.h : g.by + Math.floor((g.bh - box.h) / 2);
    ox = tx - box.x; oy = ty - box.y;
  }
  ox += f.dx || 0; oy += f.dy || 0;
  x.drawImage(cell, ox, oy);
  let overflow = false;
  if (ox || oy || w !== cell.width || h !== cell.height) {
    const b = box || boxOf(entry);
    if (b) overflow = b.x + ox < 0 || b.y + oy < 0 || b.x + b.w + ox > w || b.y + b.h + oy > h;
  }
  return { canvas: out, overflow };
}
const anchorButtons = () => document.querySelectorAll<HTMLButtonElement>("#anchorSeg button");
function syncAlignUi() {
  const keyed = $sl("bgMode").value !== "none" || $in("lum").checked, anchor = $in("anchor").value;
  anchorButtons().forEach((b) => { b.disabled = !keyed; b.setAttribute("aria-pressed", String(b.dataset.anchor === anchor)); });
  $sl("cellMode").disabled = !keyed || anchor === "none";
  $in("cellPad").disabled = $sl("cellMode").disabled || $sl("cellMode").value !== "fit";
  $("alignHint").textContent = !keyed
    ? "背景の透過をオンにすると使えます（絵の範囲が分からないため）。コマごとの微調整は使えます。"
    : anchor === "none"
      ? "トリミング範囲の位置のまま並べます。"
      : "コマどうしを選んだ端に揃え（もう一方の向きは中央）、揃えたまとまり全体をセルの真ん中に置きます。「中央」は上下左右とも中央です。「絵に合わせて詰める」では、セルを一番大きい絵＋余白の大きさにします。";
}
anchorButtons().forEach((b) => b.addEventListener("click", () => {
  $in("anchor").value = b.dataset.anchor!;
  $("anchor").dispatchEvent(new Event("change"));
}));
["anchor", "cellMode"].forEach((id) => $(id).addEventListener("change", syncAlignUi));
function syncNudgeUi() {
  const f = frames[sel];
  $("nudgeTitle").textContent = f ? "コマごとの微調整（#" + (sel + 1) + "）" : "コマごとの微調整";
  $in("dx").value = String(f ? f.dx : 0); $in("dy").value = String(f ? f.dy : 0);
  $in("dx").disabled = $in("dy").disabled = $btn("btnNudgeReset").disabled = !f || isSheet();
  $btn("btnNudgeResetAll").disabled = !frames.some((g) => g.dx || g.dy);
}
function nudge(dx: number, dy: number, absolute?: boolean) {
  const f = frames[sel];
  if (!f || isSheet()) return;
  if (absolute) { f.dx = dx; f.dy = dy; } else { f.dx += dx; f.dy += dy; }
  syncNudgeUi(); renderStripSoon(); scheduleRebuild();
}
let stripQueued = false;
function renderStripSoon() { if (stripQueued) return; stripQueued = true; requestAnimationFrame(() => { stripQueued = false; renderStrip(); }); }
["dx", "dy"].forEach((id) => $(id).addEventListener("change", () => nudge(Math.round(+$in("dx").value || 0), Math.round(+$in("dy").value || 0), true)));
$("btnNudgeReset").addEventListener("click", () => nudge(0, 0, true));
$("btnNudgeResetAll").addEventListener("click", () => { frames.forEach((f) => { f.dx = 0; f.dy = 0; }); syncNudgeUi(); renderStrip(); rebuild(); toast("全コマのずれを戻しました"); });
$("cellPad").addEventListener("input", scheduleRebuild);

function refreshAll() { renderStrip(); drawCrop(); rebuild(); syncNudgeUi(); }

// ---- アニメ確認 ----
const anim = $<HTMLCanvasElement>("animCanvas"), actx = ctx2d(anim);
let playing = true, animFrame = 0, lastT = 0;
function setPlaying(on: boolean) { playing = on; $("btnPlay").textContent = playing ? "一時停止" : "再生"; }
$("btnPlay").addEventListener("click", () => setPlaying(!playing));
// 微調整: 窓のドラッグ量（表示上の px）を元画像の px に直して dx, dy に足す
let nudgeDrag: { x: number; y: number; dx: number; dy: number; k: number } | null = null;
anim.addEventListener("pointerdown", (e) => {
  if (!frames[sel] || !layout || layout.sheet || e.button !== 0) return;
  setPlaying(false);
  const b = anim.getBoundingClientRect();
  nudgeDrag = { x: e.clientX, y: e.clientY, dx: frames[sel].dx, dy: frames[sel].dy, k: anim.width / b.width / opts().scale };
  anim.setPointerCapture(e.pointerId); anim.style.cursor = "grabbing";
});
anim.addEventListener("pointermove", (e) => {
  if (!nudgeDrag) return;
  const nx = nudgeDrag.dx + Math.round((e.clientX - nudgeDrag.x) * nudgeDrag.k), ny = nudgeDrag.dy + Math.round((e.clientY - nudgeDrag.y) * nudgeDrag.k);
  if (nx !== frames[sel].dx || ny !== frames[sel].dy) nudge(nx, ny, true);
});
const endNudge = () => { nudgeDrag = null; anim.style.cursor = ""; };
anim.addEventListener("pointerup", endNudge);
anim.addEventListener("pointercancel", endNudge);
const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
anim.addEventListener("keydown", (e) => {
  const d = ARROWS[e.key];
  if (!d || !frames[sel] || isSheet()) return;
  e.preventDefault(); e.stopPropagation();
  setPlaying(false);
  const k = e.shiftKey ? 10 : 1;
  nudge(d[0] * k, d[1] * k);
});
type PreviewBg = "checker" | "black" | "gray" | "white";
const BG_COLORS: Record<PreviewBg, string | null> = { checker: null, black: "#000", gray: "#6b7378", white: "#fff" };
const bgSegButtons = () => document.querySelectorAll<HTMLButtonElement>("#bgSeg button");
function syncPreviewBg() {
  const v = $in("previewBg").value;
  const bg = BG_COLORS.hasOwnProperty(v) ? v : "checker";
  bgSegButtons().forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.bg === bg)));
  ["sheetStage", "animStage"].forEach((id) => { const el = $(id); el.classList.remove("bg-checker", "bg-black", "bg-gray", "bg-white"); el.classList.add("bg-" + bg); });
}
bgSegButtons().forEach((b) => b.addEventListener("click", () => {
  $in("previewBg").value = b.dataset.bg!;
  $("previewBg").dispatchEvent(new Event("change"));
}));
$("previewBg").addEventListener("change", syncPreviewBg);
function tick(t: number) {
  if (layout && layout.rects.length) {
    const dur = Math.max(10, +$in("duration").value || 100);
    if (playing && t - lastT >= dur) { lastT = t; animFrame = (animFrame + 1) % layout.rects.length; }
    const N = layout.rects.length;
    if (!playing && sel >= 0 && !layout.sheet) animFrame = sel;
    animFrame %= N;
    const r = layout.rects[animFrame];
    if (anim.width !== r.w || anim.height !== r.h) { anim.width = r.w; anim.height = r.h; }
    actx.clearRect(0, 0, r.w, r.h);
    // 加算合成の確認は背景色の上に描く（市松のときは背景が透明なので通常と同じ見え方）
    const bg = BG_COLORS[$in("previewBg").value as PreviewBg];
    if ($in("additive").checked && bg) { actx.fillStyle = bg; actx.fillRect(0, 0, r.w, r.h); actx.globalCompositeOperation = "lighter"; }
    if (!playing && $in("onion").checked && N > 1) {
      const pr = layout.rects[(animFrame - 1 + N) % N];
      actx.globalAlpha = 0.35; actx.drawImage(sheet, pr.x, pr.y, pr.w, pr.h, 0, 0, r.w, r.h); actx.globalAlpha = 1;
    }
    actx.drawImage(sheet, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    actx.globalCompositeOperation = "source-over";
    anim.classList.toggle("pixel", !opts().smooth);
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---- 書き出し ----
function pngName() {
  const base = $in("baseName").value.trim().replace(/\.png$/i, "").replace(/[_\-\s]*\d+\s*[xX×]\s*\d+$/, "") || "sprite_sheet";
  return base + "_" + layout!.cols + "x" + layout!.rows + ".png";
}
// Aseprite 互換（--format json-hash / json-array 相当）。他ツールと同じ構造
function asepriteJson(fmt: string) {
  const L = layout!;
  const dur = Math.max(10, Math.round(+$in("duration").value || 100));
  const used = new Set<string>();
  const uniq = (n: string) => { let k = n, i = 1; while (used.has(k)) k = n.replace(/\.png$/, "") + "_" + (i++) + ".png"; used.add(k); return k; };
  const entries = L.rects.map((r, i) => [uniq((L.sheet ? frames[0].name.replace(/[_\-\s]*\d+\s*[xX×]\s*\d+$/, "") + " " + i : frames[i].name) + ".png"), {
    frame: { x: r.x, y: r.y, w: r.w, h: r.h }, rotated: false, trimmed: false,
    spriteSourceSize: { x: 0, y: 0, w: r.w, h: r.h },
    sourceSize: { w: r.w, h: r.h }, duration: dur,
  }] as const);
  return {
    frames: fmt === "array" ? entries.map(([filename, v]) => Object.assign({ filename }, v)) : Object.fromEntries(entries),
    meta: {
      app: "https://www.aseprite.org/", version: "1.3",
      image: pngName(), format: "RGBA8888",
      size: { w: L.W, h: L.H }, scale: "1",
      frameTags: [], layers: [], slices: [],
    },
  };
}
$("btnPng").addEventListener("click", () => {
  if (!layout) return;
  const n = pngName();
  IT.canvasToBlob(sheet).then((b) => IT.saveFile(n, b), () => toast("PNGを作成できませんでした"));
});
$("btnJson").addEventListener("click", () => {
  if (!layout) return;
  IT.saveFile(pngName().replace(/\.png$/, ".json"), new Blob([JSON.stringify(asepriteJson($sl("jsonFormat").value), null, 2)], { type: "application/json" }));
});
$("btnPolish").addEventListener("click", () => {
  if (!layout) return;
  const n = pngName();
  IT.openIn("sprite-polish", IT.canvasToBlob(sheet).then((b) => [new File([b], n, { type: "image/png" }), new File([JSON.stringify(asepriteJson("array"))], n.replace(/\.png$/, ".json"), { type: "application/json" })]));
});

// ---- サンプル（架空のゲーム画面をコードで描く。スライムが跳ねる 6 コマ） ----
function drawSampleFrame(i: number, n: number) {
  const lw = 160, lh = 90, Z = 3;
  const lo = document.createElement("canvas"); lo.width = lw; lo.height = lh;
  const g = ctx2d(lo);
  g.fillStyle = "#7ec4ec"; g.fillRect(0, 0, lw, lh);
  g.fillStyle = "#ffffff"; [[18, 14, 16], [96, 20, 22], [130, 10, 12]].forEach(([x, y, w]) => { g.fillRect(x, y, w, 4); g.fillRect(x + 3, y - 2, w - 6, 2); });
  g.fillStyle = "#4d9a3c"; g.fillRect(0, 66, lw, 4);
  g.fillStyle = "#8a5a32"; g.fillRect(0, 70, lw, 20);
  g.fillStyle = "#6f4527"; for (let x = 4; x < lw; x += 12) g.fillRect(x, 76 + (x % 3) * 3, 4, 2);
  // HUD（動かない部分）
  g.fillStyle = "rgba(0,0,0,.55)"; g.fillRect(4, 4, 46, 9);
  g.fillStyle = "#ff5a5a"; g.fillRect(6, 6, 30, 5);
  g.fillStyle = "#ffd84a"; g.fillRect(lw - 22, 4, 18, 9);
  g.fillStyle = "#6b4b00"; g.fillRect(lw - 19, 7, 3, 3); g.fillRect(lw - 14, 7, 8, 3);
  // スライム（ジャンプ + 着地のつぶれ）
  const t = i / n;
  const hop = Math.sin(t * Math.PI);
  const squash = i === 0 ? 0.75 : i === n - 1 ? 0.9 : 1 + hop * 0.1;
  const sw = Math.round(22 / Math.sqrt(squash)), sh = Math.round(16 * squash);
  const cx = 80, by = 66 - Math.round(hop * 18);
  g.fillStyle = "rgba(0,0,0,.25)"; g.fillRect(cx - 10 + Math.round(hop * 3), 66, 20 - Math.round(hop * 6), 2);
  g.fillStyle = "#2f6fd6";
  for (let y = 0; y < sh; y++) {
    const k = y / sh, half = Math.round((sw / 2) * Math.sqrt(Math.min(1, 1.15 - Math.pow(1 - k, 2) * 1.15 + 0.15)));
    g.fillRect(cx - half, by - sh + y, half * 2, 1);
  }
  g.fillStyle = "#7fb2ff"; g.fillRect(cx - Math.round(sw / 4), by - sh + 3, 3, 2);
  g.fillStyle = "#10203c"; g.fillRect(cx - 5, by - Math.round(sh * 0.55), 2, 3); g.fillRect(cx + 3, by - Math.round(sh * 0.55), 2, 3);
  const c = document.createElement("canvas"); c.width = lw * Z; c.height = lh * Z;
  const x = ctx2d(c, { willReadFrequently: true }); x.imageSmoothingEnabled = false; x.drawImage(lo, 0, 0, c.width, c.height);
  return c;
}
// エフェクトのサンプル（マゼンタ背景の連番）は samples/ から fetch する（file:// では読めない）
const EFFECT_SAMPLE_DIR = "../samples/keyout/";
const EFFECT_SAMPLE_FILES = ["colon183", "colon184", "colon185", "colon186", "colon187", "colon188", "colon189", "colon190", "colon191"];
let prefsBeforeSample: Prefs | null = null; // エフェクトのサンプルで透過の設定を変える前の設定
function restorePrefsAfterSample() {
  if (!prefsBeforeSample) return;
  const p = prefsBeforeSample; prefsBeforeSample = null;
  applyPrefs(p); savePrefs();
}
async function loadEffectSample() {
  const list = await Promise.all(EFFECT_SAMPLE_FILES.map(async (name): Promise<Frame> => {
    const r = await fetch(EFFECT_SAMPLE_DIR + name + ".png");
    if (!r.ok) throw new Error(name + ".png: HTTP " + r.status);
    const src = await fileToCanvas(await r.blob());
    return { id: nextId++, name, src, w: src.width, h: src.height, dx: 0, dy: 0 };
  }));
  frames = list;
  if (!prefsBeforeSample) prefsBeforeSample = readPrefs();
  // マゼンタをキーカラーとして抜く
  $sl("bgMode").value = "all"; $in("keyManual").checked = true; $in("keyColor").value = "#ff00ff";
  $in("tol").value = "32"; $in("soft").value = "16"; $in("unblend").checked = true;
  syncBgUi(); syncAlignUi();
}
function loadScreenSample() {
  restorePrefsAfterSample();
  const n = 6;
  frames = [];
  for (let i = 0; i < n; i++) {
    const src = drawSampleFrame(i, n);
    frames.push({ id: nextId++, name: "sample_" + String(i + 1).padStart(2, "0"), src, w: src.width, h: src.height, dx: 0, dy: 0 });
  }
  $in("scale").value = "100"; $sl("smoothing").value = "nearest";
}
$("btnSample").addEventListener("click", async () => {
  const b = $btn("btnSample"), effect = $sl("sampleKind").value === "effect";
  $("sampleNote").textContent = "";
  if (effect && location.protocol === "file:") { $("sampleNote").textContent = "ローカルファイルとして開いているため、このサンプルは読み込めません（Webサーバー経由で開くと使えます）"; return; }
  b.disabled = true;
  try {
    if (effect) await loadEffectSample(); else loadScreenSample();
  } catch (e) {
    $("sampleNote").textContent = "サンプルを読み込めませんでした（" + (e as Error).message + "）";
    return;
  } finally { b.disabled = false; }
  usedSample = true; sel = 0; setCrop(fullRect()); setSheetMode(false);
  $in("baseName").value = effect ? "colon_sheet" : "screenshot_sheet";
  refreshAll();
  toast(effect ? "サンプルを読み込みました。マゼンタを透過しています" : "サンプルを読み込みました。「変化のある範囲を検出」と背景の透過を試せます");
});

// ---- 設定の記憶（コマ・トリミング範囲・ファイル名・シートとして扱うかは保存しない） ----
type Prefs = Record<string, unknown>;
const PREFS_KEY = "sprite-sheet-maker:settings";
const PREF_IDS = ["cols", "spacing", "margin", "scale", "smoothing", "mult4", "pot", "duration", "jsonFormat", "autoMargin", "insertAfterSel", "bgMode", "keyAuto", "keyColor", "tol", "soft", "unblend", "lum", "blackPt", "whitePt", "lumColor", "anchor", "cellMode", "cellPad", "onion", "additive", "previewBg"];
const PREF_DEFAULTS: Prefs = { cols: 0, spacing: 0, margin: 0, scale: 100, smoothing: "nearest", mult4: false, pot: false, duration: 100, jsonFormat: "hash", autoMargin: 4, insertAfterSel: false, bgMode: "none", keyAuto: true, keyColor: "#00ff00", tol: 24, soft: 8, unblend: false, lum: false, blackPt: 0, whitePt: 255, lumColor: "unpremul", anchor: "bottom", cellMode: "crop", cellPad: 0, onion: true, additive: false, previewBg: "checker" };
// 旧「Keyout Sprite Packer」の URL から来たとき（?mode=keyout）の初めの透過の設定。保存した設定があればそちらを使う
// 旧ツールは隣のコマへのにじみ防止にセルの内側へ 1px の余白を付けていたので、コマの間隔を 1px にする
const KEYOUT_PRESET: Prefs = { bgMode: "all", keyAuto: false, keyColor: "#ff00ff", tol: 32, soft: 16, unblend: true, spacing: 1 };
// 旧「スクショ スプライトシート」の設定は項目が同じなので引き継ぐ（新しい設定がまだ無いときだけ）
const OLD_SCREENSHOT_PREFS_KEY = "screenshot-sprite-sheet:settings";
let restoringPrefs = false;
// 設定の項目は input（数値・チェック・ラジオ・色・hidden）か select。select は type で分けてから select として扱う
const prefEl = (id: string) => $<HTMLInputElement>(id);
function readPrefs(): Prefs {
  const o: Prefs = {};
  PREF_IDS.forEach((id) => { const el = prefEl(id); o[id] = el.type === "checkbox" || el.type === "radio" ? el.checked : el.type === "number" ? +el.value : el.value; });
  return o;
}
function applyPrefs(p: Prefs) {
  restoringPrefs = true;
  // 壊れた値・範囲外の値は項目ごとに捨てて、いまの値のまま使う
  PREF_IDS.forEach((id) => {
    if (!(id in p)) return;
    const el = prefEl(id), v = p[id];
    if (el.type === "checkbox") { if (typeof v === "boolean") el.checked = v; }
    else if (el.type === "radio") { if (typeof v === "boolean") { el.checked = v; if (id === "keyAuto") $in("keyManual").checked = !v; } }
    else if (id === "anchor") { if (["bottom", "top", "left", "right", "center", "none"].includes(v as string)) el.value = v as string; }
    else if (id === "previewBg") { if (Object.keys(BG_COLORS).includes(v as string)) el.value = v as string; }
    else if (el.tagName === "SELECT") { if ([...(el as unknown as HTMLSelectElement).options].some((o) => o.value === String(v))) el.value = v as string; }
    else if (el.type === "color") { if (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v)) el.value = v.toLowerCase(); }
    else {
      const n = Number(v);
      if (typeof v !== "boolean" && String(v).trim() !== "" && Number.isInteger(n) && n >= +el.min && (el.max === "" || n <= +el.max)) el.value = String(n);
    }
  });
  restoringPrefs = false;
  syncBgUi(); syncAlignUi(); syncPreviewBg();
  rebuild();
}
function savePrefs() { if (!restoringPrefs) IT.store.set(PREFS_KEY, readPrefs()); }
PREF_IDS.forEach((id) => $(id).addEventListener("change", () => { savePrefs(); requestRebuild(); }));
["cols", "spacing", "margin", "scale", "duration", "baseName"].forEach((id) => $(id).addEventListener("input", scheduleRebuild));
syncBgUi(); syncAlignUi(); syncSheetUi();
$("btnResetPrefs").addEventListener("click", () => { applyPrefs(PREF_DEFAULTS); IT.store.remove(PREFS_KEY); toast("設定をリセットしました"); });
{
  const fromKeyout = FROM_KEYOUT;
  if (fromKeyout && location.protocol !== "file:") $sl("sampleKind").value = "effect";
  const saved = IT.store.get<Prefs>(PREFS_KEY);
  const old = IT.store.get<Prefs>(OLD_SCREENSHOT_PREFS_KEY);
  if (saved && typeof saved === "object") applyPrefs(saved);
  else if (fromKeyout) applyPrefs(KEYOUT_PRESET);
  else if (old && typeof old === "object") {
    // 旧形式（横・縦を別々に指定）の揃え方は、近い揃え方に読み替える
    if (!("anchor" in old) && ("alignH" in old || "alignV" in old)) {
      const h = old.alignH, v = old.alignV;
      old.anchor = h === "none" && v === "none" ? "none" : v === "bottom" || v === "top" ? v : h === "left" || h === "right" ? h : "center";
    }
    applyPrefs(old);
  }
}

// テストから中の状態を見られるようにする（単体 HTML だった頃のグローバル変数・関数と同じ名前）
Object.assign(window, { groupBox, effectiveCrop, alignOpts, asepriteJson, pngName, setCrop, isSheet });
for (const [name, get] of Object.entries({ frames: () => frames, sel: () => sel, crop: () => crop, layout: () => layout })) {
  Object.defineProperty(window, name, { get, configurable: true });
}

refreshAll();
