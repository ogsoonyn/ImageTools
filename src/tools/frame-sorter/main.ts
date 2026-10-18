/* コマ整列ツールの画面 */
import { IT } from "@common/it";
import { dilate, foreground, hexToRgb, labelComponents, readOrder, rgbToHex, uniqNames, type DetMode } from "./detect";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const $in = (id: string) => $<HTMLInputElement>(id);
const $sel = (id: string) => $<HTMLSelectElement>(id);
const $btn = (id: string) => $<HTMLButtonElement>(id);
const toast = IT.toast;
const PALETTE = ["#e4572e", "#17a3a0", "#d9a400", "#5f9e2f", "#8e5bd6", "#e0479e", "#1f8fd6", "#f08a24"];
const mk = (w: number, h: number) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };

// ---- 状態 ----
// frames: id -> {id,x,y,w,h,labels}（元画像上の矩形。labels は自動検出の塊ID集合で、null なら矩形内のコマ画素すべて）
// groups: [{id,name,color,ids:[frameId...]}]（1アニメ = 1グループ。すべてのコマはどれか1つのグループに属する）
type Frame = { id: number; x: number; y: number; w: number; h: number; labels: number[] | null };
type Group = { id: number; name: string; color: string; ids: number[] };
type Tool = "select" | "add" | "pick";
type BgOut = "clear" | "keep";
type Anchor = "bottom" | "top" | "left" | "right" | "center";
type DetParams = { det: DetMode; bgColor: string; tol: string; gap: string };
type SegAttr = "det" | "bgout" | "anchor" | "tool";
const S: {
  src: HTMLCanvasElement | null; W: number; H: number; data: Uint8ClampedArray | null; name: string;
  fg: Uint8Array | null; label: Int32Array | null; compCount: number; dropped: number; detParams?: DetParams;
  frames: Map<number, Frame>; groups: Group[]; nextId: number; nextG: number;
  sel: Set<number>; activeG: number | null;
  tool: Tool; det: DetMode; bgout: BgOut; anchor: Anchor;
  undo: string[]; redo: string[];
} = {
  src: null, W: 0, H: 0, data: null, name: "",
  fg: null, label: null, compCount: 0, dropped: 0,
  frames: new Map(), groups: [], nextId: 1, nextG: 1,
  sel: new Set(), activeG: null,
  tool: "select", det: "color", bgout: "clear", anchor: "bottom",
  undo: [], redo: [],
};
type Cell = { x: number; y: number; w: number; h: number };
type Placed = { id: number; group: Group; cell: Cell; x: number; y: number };
type Tag = { name: string; from: number; to: number; color: string; cw: number; ch: number };
type Layout = { W: number; H: number; rects: Placed[]; tags: Tag[]; overflow: number; uniform: [number, number] | null };
let layout: Layout | null = null;            // シート配置の計算結果
const sheet = mk(1, 1);       // 書き出し用シート
const cutCache = new Map<number, { key: string; canvas: HTMLCanvasElement }>();   // frameId -> {key, canvas}
let detectCount = 0, buildCount = 0; // テスト用の処理回数

// ---- 画像の読み込み ----
async function loadFile(file: File) {
  try {
    const bmp = await createImageBitmap(file);
    setSource(bmp, file.name);
    bmp.close && bmp.close();
  } catch { toast(file.name + " を読み込めませんでした"); }
}
const isImage = (f: File) => f.type.startsWith("image/") || /\.(bmp|png|jpe?g|webp|gif)$/i.test(f.name);
const isJson = (f: File) => /\.json$/i.test(f.name) || f.type === "application/json";
// 画像と一緒に Aseprite 互換 JSON があれば、絵から見つける代わりに JSON のコマ区切りとアクション（frameTags）で読む
async function loadFiles(files: File[]) {
  const img = files.find(isImage), js = files.find(isJson);
  if (!img) { toast(js ? "JSON はシート画像と一緒にドロップしてください" : "画像ファイルが見つかりませんでした"); return; }
  let data: unknown = null;
  if (js) { try { data = JSON.parse(await js.text()); } catch { toast("JSON を読めなかったので、絵から自動で見つけます"); } }
  await loadFile(img);
  if (data && S.src && S.name === img.name) {
    if (fromAseprite(data)) $("srcNote").textContent = img.name + "（" + S.W + "×" + S.H + "）と " + js!.name + " から " + S.frames.size + " コマ・" + S.groups.length + " アニメ（検出の設定を変えると絵から見つけ直します）";
    else toast("JSON にコマが無かったので、絵から自動で見つけました");
  }
}
type AseRect = { x: number; y: number; w: number; h: number };
type AseJson = { frames?: { frame?: AseRect }[] | Record<string, { frame?: AseRect }>; meta?: { frameTags?: { name?: string; from?: number; to?: number }[] } };
// JSON の各コマの矩形を、その中のコマ画素の範囲まで詰めて 1 コマにする。frameTags ごとに 1 アニメ、どのタグにも入らないコマは最後にまとめる
// タグが入れ子・重なりのとき（Aseprite 変換の「セル」と「セル/タグ」など）は、コマを一番狭いタグに入れる（同じ幅なら後のタグ）
function fromAseprite(raw: unknown): boolean {
  const data = raw as AseJson;
  const list = Array.isArray(data.frames) ? data.frames : Object.values(data.frames || {});
  const ids = list.map((e) => {
    const r = e && e.frame;
    if (!r || ![r.x, r.y, r.w, r.h].every(Number.isFinite)) return null;
    const x = Math.max(0, r.x | 0), y = Math.max(0, r.y | 0), x2 = Math.min(S.W, (r.x | 0) + (r.w | 0)), y2 = Math.min(S.H, (r.y | 0) + (r.h | 0));
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    for (let yy = y; yy < y2; yy++) for (let xx = x; xx < x2; xx++) {
      if (S.fg![yy * S.W + xx]) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0) y0 = yy; if (yy > y1) y1 = yy; }
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  });
  if (!ids.some(Boolean)) return false;
  pushUndo(); // 元に戻すと、絵から見つけた結果に戻る
  S.frames = new Map(); S.nextId = 1; S.nextG = 1; S.sel.clear(); S.dropped = 0;
  const fid = ids.map((r) => { if (!r) return null; const id = S.nextId++; S.frames.set(id, { id, ...r, labels: null }); return id; });
  const tags = ((data.meta && data.meta.frameTags) || []).map((t) => ({ name: String((t && t.name) || ""), from: Math.max(0, t.from! | 0), to: Math.min(fid.length - 1, t.to! | 0) }));
  const tagOf = fid.map((_, i) => {
    let best = -1;
    tags.forEach((t, k) => { if (t.from <= i && i <= t.to && (best < 0 || t.to - t.from <= tags[best].to - tags[best].from)) best = k; });
    return best;
  });
  const groups: Group[] = [];
  tags.forEach((t, k) => {
    const g = fid.filter((id, i): id is number => id != null && tagOf[i] === k);
    if (g.length) groups.push(newGroup(g, t.name || undefined));
  });
  const rest = fid.filter((id, i): id is number => id != null && tagOf[i] < 0);
  if (rest.length) groups.push(newGroup(rest));
  S.groups = groups; S.activeG = groups[0] ? groups[0].id : null;
  refresh();
  return true;
}
function setSource(img: HTMLCanvasElement | ImageBitmap, name: string) {
  const W = img.width, H = img.height;
  const c = mk(W, H), ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  S.src = c; S.W = W; S.H = H; S.name = name;
  S.data = ctx.getImageData(0, 0, W, H).data;
  const v = $<HTMLCanvasElement>("srcView"); v.width = W; v.height = H; v.getContext("2d")!.drawImage(c, 0, 0);
  // 四隅が透明なら「透明部分」で検出、そうでなければ左上の色を背景色にする
  const d = S.data, corners = [0, W - 1, (H - 1) * W, H * W - 1];
  const transparent = corners.some((i) => d[i * 4 + 3] < 128);
  setSeg("detSeg", "det", transparent ? "alpha" : "color");
  if (!transparent) $in("bgColor").value = rgbToHex(d[0], d[1], d[2]);
  $in("baseName").value = (name.replace(/\.[^.]+$/, "") || "sprite_sheet") + "_sheet";
  $("srcNote").textContent = name + "（" + W + "×" + H + "）";
  S.undo = []; S.redo = [];
  syncLabels(); sizeOverlay();
  runDetect(false);
}

// ---- コマ検出 ----
function computeFg() {
  return foreground(S.data!, S.W, S.H, S.det, +$in("tol").value, $in("bgColor").value);
}
// 検出結果（S.fg / S.label）を決める設定。元に戻すときはこの値から塊の番号を作り直す（同じ入力なら同じ番号になる）
const detParamsNow = (): DetParams => ({ det: S.det, bgColor: $in("bgColor").value, tol: $in("tol").value, gap: $in("gap").value });
function buildMaps(p: DetParams) {
  const { W, H } = S;
  S.fg = computeFg();
  const r = Math.ceil(+p.gap / 2);
  const mask = r > 0 ? dilate(S.fg, W, H, r) : S.fg;
  const res = labelComponents(mask, S.fg, W, H);
  S.label = res.lab; S.detParams = p; cutCache.clear();
  return res.boxes;
}
function runDetect(withUndo = true) {
  if (!S.src) return;
  if (withUndo && S.frames.size) pushUndo();
  const boxes = buildMaps(detParamsNow());
  const minSize = +$in("minSize").value;
  S.frames = new Map(); S.nextId = 1; S.sel.clear();
  boxes.forEach((b, k) => {
    const id = S.nextId++;
    S.frames.set(id, { id, x: b.x0, y: b.y0, w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1, labels: [k] });
  });
  // 枠の中に収まる小さな塊を先に取り込んでから、残った小さすぎる塊をゴミとして捨てる
  absorbNested();
  let dropped = 0;
  for (const f of [...S.frames.values()]) if (f.w < minSize && f.h < minSize) { S.frames.delete(f.id); dropped++; }
  S.dropped = dropped;
  autoGroup();
  detectCount++;
  refresh();
}

// 他のコマの矩形にすっぽり収まる小さな塊（煙の切れ端など）は、そのコマの一部とみなしてまとめる
function absorbNested() {
  const list = [...S.frames.values()].sort((a, b) => b.w * b.h - a.w * a.h);
  for (let i = list.length - 1; i >= 0; i--) {
    const f = list[i];
    const host = list.find((o) => o !== f && S.frames.has(o.id) && o.w * o.h > f.w * f.h * 2 &&
      f.x >= o.x && f.y >= o.y && f.x + f.w <= o.x + o.w && f.y + f.h <= o.y + o.h);
    if (host) { host.labels!.push(...f.labels!); S.frames.delete(f.id); }
  }
}

// ---- 並び順（読む順の推定は detect.ts） ----
function newGroup(ids: number[], name?: string): Group {
  const n = S.nextG++;
  return { id: n, name: name || "anim" + n, color: PALETTE[(n - 1) % PALETTE.length], ids };
}
function autoGroup() {
  const mode = $sel("autoMode").value, list = [...S.frames.values()];
  S.nextG = 1;
  const order = readOrder(list, mode === "rows" || mode === "all-rows");
  if (mode === "rows" || mode === "cols") S.groups = order.map((b) => newGroup(b.map((f) => f.id)));
  else S.groups = list.length ? [newGroup(order.flat().map((f) => f.id))] : [];
  S.activeG = S.groups[0] ? S.groups[0].id : null;
}

// ---- 元に戻す / やり直す ----
type Snapshot = { frames: Frame[]; groups: Group[]; nextId: number; nextG: number; activeG: number | null; det?: DetParams; dropped?: number };
function snapshot() {
  return JSON.stringify({ frames: [...S.frames.values()], groups: S.groups, nextId: S.nextId, nextG: S.nextG, activeG: S.activeG, det: S.detParams, dropped: S.dropped });
}
function restore(json: string) {
  const o = JSON.parse(json) as Snapshot;
  // 検出時の設定が今と違えば、設定を戻して塊の番号を作り直す（コマの labels はその番号を指している）
  const p = o.det, cur = S.detParams;
  if (p && (!cur || p.det !== cur.det || p.bgColor !== cur.bgColor || p.tol !== cur.tol || p.gap !== cur.gap)) {
    clearTimeout(detTimer);
    setSeg("detSeg", "det", p.det); $in("bgColor").value = p.bgColor; $in("tol").value = p.tol; $in("gap").value = p.gap;
    syncLabels(); savePrefs();
    buildMaps(p);
  }
  S.frames = new Map(o.frames.map((f) => [f.id, f])); S.groups = o.groups; S.nextId = o.nextId; S.nextG = o.nextG; S.activeG = o.activeG;
  S.dropped = o.dropped || 0;
  S.sel.clear(); refresh();
}
function pushUndo() { S.undo.push(snapshot()); if (S.undo.length > 100) S.undo.shift(); S.redo = []; }
function undo() { if (drag || !S.undo.length) return; S.redo.push(snapshot()); restore(S.undo.pop()!); }
function redo() { if (drag || !S.redo.length) return; S.undo.push(snapshot()); restore(S.redo.pop()!); }

// ---- 編集操作 ----
function groupOf(id: number) { return S.groups.find((g) => g.ids.includes(id)); }
function orderedSel() { return S.groups.flatMap((g) => g.ids.filter((id) => S.sel.has(id))); }
function pruneGroups() {
  S.groups = S.groups.filter((g) => g.ids.length);
  if (!S.groups.some((g) => g.id === S.activeG)) S.activeG = S.groups[0] ? S.groups[0].id : null;
}
function removeIds(ids: number[]) { const set = new Set(ids); S.groups.forEach((g) => { g.ids = g.ids.filter((id) => !set.has(id)); }); }
function mergeSel() {
  const ids = orderedSel();
  if (ids.length < 2) { toast("結合するコマを2つ以上選んでください"); return; }
  pushUndo();
  const fs = ids.map((id) => S.frames.get(id)!);
  const x0 = Math.min(...fs.map((f) => f.x)), y0 = Math.min(...fs.map((f) => f.y));
  const x1 = Math.max(...fs.map((f) => f.x + f.w)), y1 = Math.max(...fs.map((f) => f.y + f.h));
  const labels = fs.some((f) => !f.labels) ? null : [...new Set(fs.flatMap((f) => f.labels!))];
  const keep = fs[0];
  Object.assign(keep, { x: x0, y: y0, w: x1 - x0, h: y1 - y0, labels });
  removeIds(ids.slice(1)); ids.slice(1).forEach((id) => S.frames.delete(id));
  pruneGroups(); S.sel = new Set([keep.id]); refresh();
}
function deleteSel() {
  const ids = orderedSel(); if (!ids.length) return;
  pushUndo(); removeIds(ids); ids.forEach((id) => S.frames.delete(id)); pruneGroups(); S.sel.clear(); refresh();
}
function newGroupFromSel() {
  const ids = orderedSel(); if (!ids.length) { toast("新しいアニメにするコマを選んでください"); return; }
  pushUndo();
  const at = S.groups.indexOf(groupOf(ids[0])!);
  removeIds(ids);
  const g = newGroup(ids);
  S.groups.splice(at + 1, 0, g); pruneGroups(); S.activeG = g.id; refresh();
  toast(ids.length + " コマを新しいアニメ「" + g.name + "」に切り出しました");
}
function moveIds(ids: number[], gid: number, beforeId: number | null) {
  pushUndo();
  removeIds(ids);
  const g = S.groups.find((x) => x.id === gid)!;
  let at = beforeId == null ? g.ids.length : g.ids.indexOf(beforeId);
  if (at < 0) at = g.ids.length;
  g.ids.splice(at, 0, ...ids);
  pruneGroups(); refresh();
}
function addFrame(x: number, y: number, w: number, h: number) {
  // 描いた矩形をコマ画素の範囲まで詰める（何もなければ描いたまま）
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
    if (S.fg![yy * S.W + xx]) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0) y0 = yy; if (yy > y1) y1 = yy; }
  }
  if (x1 >= 0) { x = x0; y = y0; w = x1 - x0 + 1; h = y1 - y0 + 1; }
  pushUndo();
  const id = S.nextId++;
  S.frames.set(id, { id, x, y, w, h, labels: null });
  let g = S.groups.find((gg) => gg.id === S.activeG);
  if (!g) { g = newGroup([]); S.groups.push(g); S.activeG = g.id; }
  g.ids.push(id);
  S.sel = new Set([id]); refresh();
}

// ---- コマの切り出し ----
function cutKey(f: Frame) {
  return [f.x, f.y, f.w, f.h, f.labels ? f.labels.join(",") : "*", S.bgout, S.det, $in("bgColor").value, $in("tol").value, $in("soft").value, $in("unblend").checked].join("|");
}
function cutFrame(f: Frame) {
  const key = cutKey(f), c0 = cutCache.get(f.id);
  if (c0 && c0.key === key) return c0.canvas;
  const { W } = S, data = S.data!, fg = S.fg!, label = S.label!, c = mk(f.w, f.h), ctx = c.getContext("2d")!;
  const img = ctx.createImageData(f.w, f.h), d = img.data;
  const set = f.labels ? new Set(f.labels) : null;
  const [kr, kg, kb] = hexToRgb($in("bgColor").value), tol = +$in("tol").value, soft = +$in("soft").value, unblend = $in("unblend").checked;
  const keep = S.bgout === "keep";
  for (let yy = 0; yy < f.h; yy++) for (let xx = 0; xx < f.w; xx++) {
    const i = (f.y + yy) * W + f.x + xx, j = i * 4, o = (yy * f.w + xx) * 4;
    const member = fg[i] && (!set || set.has(label[i]));
    if (!member) {
      if (keep && S.det === "color") { d[o] = kr; d[o + 1] = kg; d[o + 2] = kb; d[o + 3] = 255; }
      continue;
    }
    let r = data[j], g = data[j + 1], b = data[j + 2], a = data[j + 3] / 255;
    if (!keep && S.det === "color" && soft > 0) {
      const dist = Math.max(Math.abs(r - kr), Math.abs(g - kg), Math.abs(b - kb));
      if (dist < tol + soft) {
        const t = Math.max(0.001, (dist - tol) / soft);
        if (unblend) { r = (r - kr * (1 - t)) / t; g = (g - kg * (1 - t)) / t; b = (b - kb * (1 - t)) / t; }
        a *= t;
      }
    }
    d[o] = r < 0 ? 0 : r > 255 ? 255 : r; d[o + 1] = g < 0 ? 0 : g > 255 ? 255 : g; d[o + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
    d[o + 3] = Math.round(a * 255);
  }
  ctx.putImageData(img, 0, 0);
  cutCache.set(f.id, { key, canvas: c });
  return c;
}

// ---- シート配置 ----
function computeLayout(): Layout | null {
  const pad = Math.max(0, +$in("pad").value | 0), maxCols = Math.max(0, +$in("maxCols").value | 0);
  const mode = $sel("cellMode").value, m4 = $in("mult4").checked;
  const groups = S.groups.filter((g) => g.ids.length);
  const r4 = (v: number) => (m4 ? Math.ceil(v / 4) * 4 : v);
  const sizeOf = (ids: number[]): [number, number] => {
    const fs = ids.map((id) => S.frames.get(id)!);
    return [r4(Math.max(...fs.map((f) => f.w)) + pad * 2), r4(Math.max(...fs.map((f) => f.h)) + pad * 2)];
  };
  const all = groups.flatMap((g) => g.ids);
  if (!all.length) return null;
  const uni: [number, number] = mode === "fixed" ? [r4(Math.max(1, +$in("cellW").value | 0)), r4(Math.max(1, +$in("cellH").value | 0))] : sizeOf(all);
  const rects: Placed[] = [], tags: Tag[] = [];
  let y = 0, W = 0, overflow = 0;
  for (const g of groups) {
    const [cw, ch] = mode === "group" ? sizeOf(g.ids) : uni;
    const n = g.ids.length, cols = maxCols > 0 ? Math.min(maxCols, n) : n;
    tags.push({ name: g.name, from: rects.length, to: rects.length + n - 1, color: g.color, cw, ch });
    // アニメ内の最大のコマを囲む枠をセル中央に置き、各コマはその枠の中で選んだ端に揃える
    const fs = g.ids.map((id) => S.frames.get(id)!);
    const bw = Math.max(...fs.map((f) => f.w)), bh = Math.max(...fs.map((f) => f.h));
    g.ids.forEach((id, i) => {
      const f = S.frames.get(id)!, cx = (i % cols) * cw, cy = y + Math.floor(i / cols) * ch;
      const bx = cx + Math.floor((cw - bw) / 2), by = cy + Math.floor((ch - bh) / 2), a = S.anchor;
      const x = a === "left" ? bx : a === "right" ? bx + bw - f.w : bx + Math.floor((bw - f.w) / 2);
      const yy = a === "top" ? by : a === "bottom" ? by + bh - f.h : by + Math.floor((bh - f.h) / 2);
      if (f.w > cw - pad * 2 || f.h > ch - pad * 2) overflow++;
      rects.push({ id, group: g, cell: { x: cx, y: cy, w: cw, h: ch }, x, y: yy });
    });
    W = Math.max(W, cols * cw);
    y += Math.ceil(n / cols) * ch;
  }
  return { W, H: y, rects, tags, overflow, uniform: mode !== "group" ? uni : null };
}
function buildSheet() {
  layout = computeLayout();
  if (!layout) { sheet.width = sheet.height = 1; drawSheetView(); updateStats(); return; }
  sheet.width = layout.W; sheet.height = layout.H;
  const c = sheet.getContext("2d")!;
  c.clearRect(0, 0, layout.W, layout.H);
  if (S.bgout === "keep" && S.det === "color") { c.fillStyle = $in("bgColor").value; c.fillRect(0, 0, layout.W, layout.H); }
  for (const r of layout.rects) {
    const f = S.frames.get(r.id)!;
    c.save(); c.beginPath(); c.rect(r.cell.x, r.cell.y, r.cell.w, r.cell.h); c.clip();
    c.drawImage(cutFrame(f), r.x, r.y); c.restore();
  }
  buildCount++;
  drawSheetView(); updateStats();
}
function drawSheetView() {
  const v = $<HTMLCanvasElement>("sheetView"); v.width = sheet.width; v.height = sheet.height;
  const c = v.getContext("2d")!; c.drawImage(sheet, 0, 0);
  if (layout && $in("showGrid").checked) {
    c.save(); c.lineWidth = 1; c.setLineDash([4, 3]);
    layout.rects.forEach((r) => { c.strokeStyle = r.group.color; c.strokeRect(r.cell.x + .5, r.cell.y + .5, r.cell.w - 1, r.cell.h - 1); });
    c.restore();
  }
}
function updateStats() {
  const has = !!layout;
  $("stCount").textContent = has ? String(layout!.rects.length) : "–";
  $("stGroups").textContent = has ? String(layout!.tags.length) : "–";
  $("stCell").textContent = !has ? "–" : layout!.uniform ? layout!.uniform[0] + "×" + layout!.uniform[1] : "アニメごと";
  $("stSheet").textContent = has ? layout!.W + "×" + layout!.H : "–";
  const w: string[] = [];
  if (has && layout!.overflow) w.push(layout!.overflow + " コマがセルからはみ出しています（はみ出た部分は切れます）");
  $("stWarn").textContent = w.join(" / "); $("stWarn").hidden = !w.length;
  $btn("btnPng").disabled = $btn("btnJson").disabled = $btn("btnPolish").disabled = !has;
  $("pngPreview").textContent = has ? pngName() : "";
}

// ---- 元画像ビュー（枠の表示と操作） ----
const ovl = $<HTMLCanvasElement>("ovl"), octx = ovl.getContext("2d")!;
type Edges = { l: boolean; r: boolean; t: boolean; b: boolean };
type Drag =
  | { kind: "marquee" | "add"; x0: number; y0: number; x1: number; y1: number; add?: boolean }
  | { kind: "resize"; f: Frame; ed: Edges; orig: Frame; x0: number; y0: number; pushed: boolean };
let drag: Drag | null = null;
function sizeOverlay() {
  const v = $("srcView"), dpr = window.devicePixelRatio || 1;
  const w = v.clientWidth, h = v.clientHeight;
  ovl.style.width = w + "px"; ovl.style.height = h + "px";
  // 大きい画像を拡大表示したときにキャンバスが巨大にならないよう、画素数に上限を設けて解像度を落とす
  const k = Math.min(dpr, Math.sqrt(16e6 / Math.max(1, w * h)));
  ovl.width = Math.max(1, Math.round(w * k)); ovl.height = Math.max(1, Math.round(h * k));
  drawOverlay();
}
function applyZoom() {
  const z = $sel("zoom").value, wrap = $("srcWrap"), v = $("srcView");
  wrap.classList.toggle("fit", z === "fit");
  wrap.classList.toggle("pixel", z !== "fit" && +z >= 1);
  v.style.width = z === "fit" ? "" : Math.round(S.W * +z) + "px";
  v.style.height = z === "fit" ? "" : Math.round(S.H * +z) + "px";
  sizeOverlay();
}
new ResizeObserver(sizeOverlay).observe($("srcView"));
function drawOverlay() {
  const c = octx, sx = ovl.width / Math.max(1, S.W), dpr = ovl.width / Math.max(1, ovl.clientWidth); // CSS 1px あたりのキャンバス画素数
  c.clearRect(0, 0, ovl.width, ovl.height);
  if (!S.src) return;
  c.font = "bold " + Math.round(11 * dpr) + "px " + getComputedStyle(document.body).fontFamily;
  c.textBaseline = "top";
  S.groups.forEach((g, gi) => g.ids.forEach((id, i) => {
    const f = S.frames.get(id)!, sel = S.sel.has(id);
    const x = f.x * sx, y = f.y * sx, w = f.w * sx, h = f.h * sx;
    if (sel) { c.fillStyle = g.color + "55"; c.fillRect(x, y, w, h); }
    c.lineWidth = (sel ? 2.5 : 1.25) * dpr; c.strokeStyle = g.color;
    c.strokeRect(x, y, w, h);
    if (w >= 16 * dpr || sel) {
      const t = (gi + 1) + "-" + (i + 1), tw = c.measureText(t).width + 6 * dpr;
      c.fillStyle = g.color; c.fillRect(x, y, tw, 14 * dpr);
      c.fillStyle = "#fff"; c.fillText(t, x + 3 * dpr, y + 1.5 * dpr);
    }
  }));
  if (S.sel.size === 1 && S.tool === "select") {
    const f = S.frames.get([...S.sel][0]);
    if (f) {
      c.fillStyle = "#fff"; c.strokeStyle = "#000"; c.lineWidth = dpr;
      const hs = 4 * dpr, pts = [[f.x, f.y], [f.x + f.w, f.y], [f.x, f.y + f.h], [f.x + f.w, f.y + f.h], [f.x + f.w / 2, f.y], [f.x + f.w / 2, f.y + f.h], [f.x, f.y + f.h / 2], [f.x + f.w, f.y + f.h / 2]];
      pts.forEach(([px, py]) => { c.fillRect(px * sx - hs, py * sx - hs, hs * 2, hs * 2); c.strokeRect(px * sx - hs, py * sx - hs, hs * 2, hs * 2); });
    }
  }
  if (drag && (drag.kind === "marquee" || drag.kind === "add")) {
    const r = normRect(drag.x0, drag.y0, drag.x1, drag.y1);
    c.save(); c.setLineDash([5 * dpr, 4 * dpr]); c.lineWidth = 1.5 * dpr;
    c.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent");
    c.strokeRect(r.x * sx, r.y * sx, r.w * sx, r.h * sx); c.restore();
  }
}
function normRect(x0: number, y0: number, x1: number, y1: number) {
  const x = Math.max(0, Math.min(x0, x1)), y = Math.max(0, Math.min(y0, y1));
  const xe = Math.min(S.W, Math.max(x0, x1)), ye = Math.min(S.H, Math.max(y0, y1));
  return { x, y, w: Math.max(0, xe - x), h: Math.max(0, ye - y) };
}
// round = 画素の境目（枠の端）、floor = クリックした画素そのもの（スポイト・当たり判定）
function toImg(e: PointerEvent, snap: (v: number) => number = Math.round): [number, number] {
  const r = ovl.getBoundingClientRect();
  return [snap((e.clientX - r.left) / r.width * S.W), snap((e.clientY - r.top) / r.height * S.H)];
}
function hitFrame(x: number, y: number) {
  let best: Frame | null = null;
  for (const f of S.frames.values()) {
    if (x >= f.x && x < f.x + f.w && y >= f.y && y < f.y + f.h && (!best || f.w * f.h < best.w * best.h)) best = f;
  }
  return best;
}
function hitEdges(f: Frame, x: number, y: number): Edges | null {
  const tol = 6 * S.W / ovl.getBoundingClientRect().width;
  const inX = x > f.x - tol && x < f.x + f.w + tol, inY = y > f.y - tol && y < f.y + f.h + tol;
  if (!inX || !inY) return null;
  const e = { l: Math.abs(x - f.x) <= tol, r: Math.abs(x - (f.x + f.w)) <= tol, t: Math.abs(y - f.y) <= tol, b: Math.abs(y - (f.y + f.h)) <= tol };
  return e.l || e.r || e.t || e.b ? e : null;
}
ovl.addEventListener("pointerdown", (e) => {
  if (!S.src || e.button !== 0) return;
  const [x, y] = toImg(e), [px, py] = toImg(e, Math.floor);
  if (S.tool === "pick") {
    const data = S.data!;
    const xx = Math.max(0, Math.min(S.W - 1, px)), yy = Math.max(0, Math.min(S.H - 1, py)), j = (yy * S.W + xx) * 4;
    $in("bgColor").value = rgbToHex(data[j], data[j + 1], data[j + 2]);
    setSeg("detSeg", "det", "color"); syncLabels(); savePrefs();
    setSeg("toolSeg", "tool", "select");
    runDetect(); toast("背景色を " + $in("bgColor").value.toUpperCase() + " にしました");
    return;
  }
  ovl.setPointerCapture(e.pointerId);
  if (S.tool === "add") { drag = { kind: "add", x0: x, y0: y, x1: x, y1: y }; return; }
  if (S.sel.size === 1) {
    const f = S.frames.get([...S.sel][0]), ed = f && hitEdges(f, x, y);
    if (f && ed) { drag = { kind: "resize", f, ed, orig: { ...f }, x0: x, y0: y, pushed: false }; return; }
  }
  const f = hitFrame(px, py), add = e.shiftKey || e.ctrlKey || e.metaKey;
  if (f) {
    if (add) { if (S.sel.has(f.id)) S.sel.delete(f.id); else S.sel.add(f.id); }
    else if (!S.sel.has(f.id)) S.sel = new Set([f.id]);
    const g = groupOf(f.id); if (g) S.activeG = g.id;
    refreshSel();
    return;
  }
  drag = { kind: "marquee", x0: x, y0: y, x1: x, y1: y, add };
});
ovl.addEventListener("pointermove", (e) => {
  if (!S.src) return;
  const [x, y] = toImg(e);
  if (!drag) {
    let cur = S.tool === "select" ? "default" : "crosshair";
    if (S.tool === "select" && S.sel.size === 1) {
      const f = S.frames.get([...S.sel][0]), ed = f && hitEdges(f, x, y);
      if (ed) cur = (ed.l && ed.t) || (ed.r && ed.b) ? "nwse-resize" : (ed.r && ed.t) || (ed.l && ed.b) ? "nesw-resize" : ed.l || ed.r ? "ew-resize" : "ns-resize";
    }
    ovl.style.cursor = cur;
    return;
  }
  if (drag.kind === "resize") {
    const { f, ed, orig } = drag, dx = x - drag.x0, dy = y - drag.y0;
    let x0 = orig.x, y0 = orig.y, x1 = orig.x + orig.w, y1 = orig.y + orig.h;
    if (ed.l) x0 = Math.min(x1 - 1, Math.max(0, x0 + dx)); if (ed.r) x1 = Math.max(x0 + 1, Math.min(S.W, x1 + dx));
    if (ed.t) y0 = Math.min(y1 - 1, Math.max(0, y0 + dy)); if (ed.b) y1 = Math.max(y0 + 1, Math.min(S.H, y1 + dy));
    // 元に戻す記録は実際に範囲が変わったときに積む（クリックだけで「やり直す」の履歴を消さない）
    if (!drag.pushed && (x0 !== f.x || y0 !== f.y || x1 - x0 !== f.w || y1 - y0 !== f.h)) { pushUndo(); drag.pushed = true; }
    Object.assign(f, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    drawOverlay(); return;
  }
  drag.x1 = x; drag.y1 = y; drawOverlay();
});
function endDrag() {
  if (!drag) return;
  const d = drag; drag = null;
  if (d.kind === "resize") {
    // 手で範囲を変えたコマは、塊の区別をやめて矩形内のコマ画素すべてを使う
    if (d.f.x !== d.orig.x || d.f.y !== d.orig.y || d.f.w !== d.orig.w || d.f.h !== d.orig.h) { d.f.labels = null; refresh(); }
    else { if (d.pushed) S.undo.pop(); drawOverlay(); }
    return;
  }
  const r = normRect(d.x0, d.y0, d.x1, d.y1);
  if (d.kind === "add") {
    if (r.w >= 2 && r.h >= 2) addFrame(r.x, r.y, r.w, r.h); else drawOverlay();
    return;
  }
  if (!d.add) S.sel.clear();
  if (r.w > 1 || r.h > 1) {
    for (const f of S.frames.values()) if (f.x < r.x + r.w && f.x + f.w > r.x && f.y < r.y + r.h && f.y + f.h > r.y) S.sel.add(f.id);
  }
  refreshSel();
}
ovl.addEventListener("pointerup", endDrag);
ovl.addEventListener("pointercancel", endDrag);

// ---- アニメ一覧 ----
const thumbCanvases = new Map<number, HTMLCanvasElement>();
function renderGroups() {
  const box = $("groupList");
  box.textContent = ""; thumbCanvases.clear();
  if (!S.groups.length) { box.innerHTML = '<div class="empty">' + (S.src ? "コマが見つかりません。許容値や背景色を調整してください" : "画像を読み込むとコマがここに並びます") + "</div>"; return; }
  const dpr = window.devicePixelRatio || 1;
  S.groups.forEach((g, gi) => {
    const card = document.createElement("div");
    card.className = "gcard" + (g.id === S.activeG ? " active" : "");
    const head = document.createElement("div"); head.className = "ghead";
    const dot = document.createElement("span"); dot.className = "gdot"; dot.style.background = g.color;
    const num = document.createElement("span"); num.className = "mono text-sm"; num.textContent = (gi + 1) + ".";
    const name = document.createElement("input"); name.className = "input gname"; name.value = g.name; name.setAttribute("aria-label", "アニメ名");
    name.addEventListener("change", () => { pushUndo(); g.name = name.value.trim() || "anim" + g.id; refreshLight(); });
    const cnt = document.createElement("span"); cnt.className = "hint"; cnt.textContent = g.ids.length + " コマ";
    head.append(dot, num, name, cnt);
    const btn = (label: string, title: string, fn: () => void) => { const b = document.createElement("button"); b.type = "button"; b.className = "btn btn-sm btn-ghost"; b.textContent = label; b.title = title; b.onclick = fn; head.append(b); return b; };
    btn("全選択", "このアニメのコマをすべて選択", () => { S.sel = new Set(g.ids); S.activeG = g.id; refreshSel(); });
    btn("位置順", "元画像での位置（行優先）で並べ直す", () => { pushUndo(); g.ids = readOrder(g.ids.map((id) => S.frames.get(id)!), true).flat().map((f) => f.id); refresh(); });
    btn("逆順", "並び順を逆にする", () => { pushUndo(); g.ids.reverse(); refresh(); });
    btn("↑", "上へ", () => { if (gi > 0) { pushUndo(); [S.groups[gi - 1], S.groups[gi]] = [S.groups[gi], S.groups[gi - 1]]; refresh(); } }).disabled = gi === 0;
    btn("↓", "下へ", () => { if (gi < S.groups.length - 1) { pushUndo(); [S.groups[gi + 1], S.groups[gi]] = [S.groups[gi], S.groups[gi + 1]]; refresh(); } }).disabled = gi === S.groups.length - 1;
    btn("前と結合", "1つ上のアニメの後ろにつなげる", () => { if (gi > 0) { pushUndo(); S.groups[gi - 1].ids.push(...g.ids); g.ids = []; pruneGroups(); refresh(); } }).disabled = gi === 0;
    btn("削除", "このアニメとコマを消す", () => { pushUndo(); g.ids.forEach((id) => S.frames.delete(id)); g.ids = []; pruneGroups(); S.sel.clear(); refresh(); }).classList.add("danger");
    card.addEventListener("click", (e) => { if (e.target === card || e.target === head) { S.activeG = g.id; refreshSel(); } });

    const strip = document.createElement("div"); strip.className = "thumbs";
    g.ids.forEach((id, i) => {
      const t = document.createElement("div"); t.className = "thumb bg-checker" + (S.sel.has(id) ? " sel" : ""); t.draggable = true; t.dataset.id = String(id);
      const cv = mk(Math.round(56 * dpr), Math.round(56 * dpr)); t.append(cv);
      const idx = document.createElement("span"); idx.className = "idx"; idx.textContent = String(i + 1); t.append(idx);
      thumbCanvases.set(id, cv);
      t.addEventListener("click", (e) => {
        if (e.shiftKey || e.ctrlKey || e.metaKey) { if (S.sel.has(id)) S.sel.delete(id); else S.sel.add(id); }
        else S.sel = new Set([id]);
        S.activeG = g.id; refreshSel();
      });
      t.addEventListener("dragstart", (e) => {
        dragIds = S.sel.has(id) ? orderedSel() : [id];
        e.dataTransfer!.effectAllowed = "move"; e.dataTransfer!.setData("text/plain", String(id));
      });
      t.addEventListener("dragover", (e) => {
        if (!dragIds) return; e.preventDefault(); e.stopPropagation();
        const r = t.getBoundingClientRect(), after = e.clientX > r.left + r.width / 2;
        clearDropMarks(); t.classList.add(after ? "drop-after" : "drop-before");
      });
      t.addEventListener("drop", (e) => {
        if (!dragIds) return; e.preventDefault(); e.stopPropagation();
        const r = t.getBoundingClientRect(), after = e.clientX > r.left + r.width / 2;
        const ids = dragIds; dragIds = null; clearDropMarks();
        let before: number | undefined = after ? g.ids[i + 1] : id;
        while (before != null && ids.includes(before)) before = g.ids[g.ids.indexOf(before) + 1];
        if (ids.includes(id) && ids.length === 1) return;
        moveIds(ids, g.id, before == null ? null : before);
      });
      t.addEventListener("dragend", () => { dragIds = null; clearDropMarks(); });
      strip.append(t);
    });
    strip.addEventListener("dragover", (e) => { if (!dragIds) return; e.preventDefault(); clearDropMarks(); strip.classList.add("over-end"); });
    strip.addEventListener("dragleave", () => strip.classList.remove("over-end"));
    strip.addEventListener("drop", (e) => { if (!dragIds) return; e.preventDefault(); const ids = dragIds; dragIds = null; clearDropMarks(); moveIds(ids, g.id, null); });
    card.append(head, strip);
    box.append(card);
  });
  drawThumbs();
}
let dragIds: number[] | null = null;
function clearDropMarks() { document.querySelectorAll(".drop-before,.drop-after,.over-end").forEach((el) => el.classList.remove("drop-before", "drop-after", "over-end")); }
function drawThumbs() {
  for (const [id, cv] of thumbCanvases) {
    const f = S.frames.get(id); if (!f) continue;
    const src = cutFrame(f), c = cv.getContext("2d")!, s = Math.min(cv.width / f.w, cv.height / f.h, 4 * (window.devicePixelRatio || 1));
    c.clearRect(0, 0, cv.width, cv.height);
    c.imageSmoothingEnabled = s < 1;
    const w = f.w * s, h = f.h * s;
    c.drawImage(src, (cv.width - w) / 2, (cv.height - h) / 2, w, h);
  }
}
function refreshSelThumbs() {
  document.querySelectorAll<HTMLElement>(".thumb").forEach((t) => t.classList.toggle("sel", S.sel.has(+t.dataset.id!)));
  document.querySelectorAll(".gcard").forEach((c, i) => c.classList.toggle("active", !!S.groups[i] && S.groups[i].id === S.activeG));
}

// ---- アニメーション確認 ----
let playing = true, animFrame = 0, lastT = 0;
function fillAnimSelect() {
  const sel = $sel("animGroup"), cur = +sel.value;
  sel.textContent = "";
  S.groups.forEach((g, i) => { const o = document.createElement("option"); o.value = String(g.id); o.textContent = (i + 1) + ". " + g.name + "（" + g.ids.length + "）"; sel.append(o); });
  if (S.groups.some((g) => g.id === cur)) sel.value = String(cur);
  else if (S.groups.some((g) => g.id === S.activeG)) sel.value = String(S.activeG);
}
function drawAnim() {
  const v = $<HTMLCanvasElement>("animView"), c = v.getContext("2d")!;
  if (!layout) { v.width = v.height = 1; $("animNote").textContent = ""; return; }
  const gid = +$sel("animGroup").value, rs = layout.rects.filter((r) => r.group.id === gid);
  if (!rs.length) { v.width = v.height = 1; $("animNote").textContent = ""; return; }
  animFrame %= rs.length;
  const r = rs[animFrame], s = Math.max(1, Math.min(4, Math.floor(320 / Math.max(r.cell.w, r.cell.h)))) || 1;
  const sc = Math.min(s, 320 / Math.max(r.cell.w, r.cell.h));
  const w = Math.max(1, Math.round(r.cell.w * sc)), h = Math.max(1, Math.round(r.cell.h * sc));
  if (v.width !== w || v.height !== h) { v.width = w; v.height = h; }
  c.clearRect(0, 0, w, h); c.imageSmoothingEnabled = sc < 1;
  c.drawImage(sheet, r.cell.x, r.cell.y, r.cell.w, r.cell.h, 0, 0, w, h);
  $("animNote").textContent = (animFrame + 1) + " / " + rs.length + " コマ（セル " + r.cell.w + "×" + r.cell.h + "）";
}
function tick(t: number) {
  if (playing && layout && t - lastT >= 1000 / +$in("fps").value) { lastT = t; animFrame++; drawAnim(); }
  requestAnimationFrame(tick);
}

// ---- 再描画のまとめ ----
let pendBuild = false;
function refresh() {
  pruneGroups();
  drawOverlay(); renderGroups(); fillAnimSelect(); updateSelNote();
  if (pendBuild) return; pendBuild = true;
  requestAnimationFrame(() => { pendBuild = false; buildSheet(); drawAnim(); });
}
// 名前の変更だけなら一覧は作り直さない（シートは JSON のタグ名に使うので組み直す）
function refreshLight() {
  fillAnimSelect();
  if (pendBuild) return; pendBuild = true;
  requestAnimationFrame(() => { pendBuild = false; buildSheet(); });
}
function refreshSel() { drawOverlay(); refreshSelThumbs(); updateSelNote(); }
$btn("sbNewGroup").onclick = newGroupFromSel; $btn("sbMerge").onclick = mergeSel; $btn("sbDelete").onclick = deleteSel;
$btn("sbClear").onclick = () => { S.sel.clear(); refreshSel(); };
$sel("sbMoveTo").addEventListener("change", (e) => {
  const target = e.target as HTMLSelectElement;
  const gid = +target.value; target.value = "";
  if (gid && S.sel.size) { S.activeG = gid; moveIds(orderedSel(), gid, null); toast("選択したコマを移動しました"); }
});
function updateSelBar() {
  const n = S.sel.size, bar = $("selBar");
  bar.hidden = n === 0; document.body.classList.toggle("has-selbar", n > 0);
  if (!n) return;
  $("selBarCount").textContent = n + " コマ選択中";
  $btn("sbMerge").disabled = n < 2;
  const sel = $sel("sbMoveTo"); sel.textContent = "";
  const o0 = document.createElement("option"); o0.value = ""; o0.textContent = "既存のアニメへ移動…"; sel.append(o0);
  S.groups.forEach((g, i) => { const o = document.createElement("option"); o.value = String(g.id); o.textContent = (i + 1) + ". " + g.name + " の末尾へ"; sel.append(o); });
}
function updateSelNote() {
  updateSelBar();
  const n = S.sel.size;
  $btn("btnMerge").disabled = n < 2; $btn("btnDelete").disabled = $btn("btnNewGroup").disabled = n < 1;
  $btn("btnUndo").disabled = !S.undo.length; $btn("btnRedo").disabled = !S.redo.length;
  let t;
  if (!S.src) t = "画像を読み込むと、検出したコマの枠がここに表示されます。";
  else if (n === 0) t = S.frames.size + " コマを検出" + (S.dropped ? "（小さすぎる塊 " + S.dropped + " 個は無視）" : "") + "。枠をクリックで選択、Shift/Ctrl で追加選択、空白をドラッグで範囲選択。";
  else if (n === 1) { const f = S.frames.get([...S.sel][0])!; t = "1コマ選択中（" + f.w + "×" + f.h + "、位置 " + f.x + "," + f.y + "）。辺や角をドラッグで範囲を調整できます。"; }
  else t = n + " コマ選択中。画面下のバーから、新しいアニメへの切り出し・移動・結合・削除ができます。";
  $("selNote").textContent = t;
}

// ---- 書き出し ----
function asepriteJson(fmt: string) {
  const L = layout!;
  const dur = Math.round(1000 / Math.max(1, +$in("fps").value || 1));
  const names = uniqNames(L.tags.map((t) => t.name));
  type Entry = { frame: Cell; rotated: boolean; trimmed: boolean; spriteSourceSize: Cell; sourceSize: { w: number; h: number }; duration: number };
  const entries: [string, Entry][] = [];
  L.tags.forEach((t, ti) => {
    for (let i = t.from; i <= t.to; i++) {
      const c = L.rects[i].cell;
      entries.push([names[ti] + " " + (i - t.from) + ".png", {
        frame: { x: c.x, y: c.y, w: c.w, h: c.h }, rotated: false, trimmed: false,
        spriteSourceSize: { x: 0, y: 0, w: c.w, h: c.h }, sourceSize: { w: c.w, h: c.h }, duration: dur,
      }]);
    }
  });
  const frames = fmt === "array" ? entries.map(([filename, v]) => Object.assign({ filename }, v)) : Object.fromEntries(entries);
  return {
    frames,
    meta: {
      app: "https://www.aseprite.org/", version: "1.3", image: pngName(), format: "RGBA8888",
      size: { w: L.W, h: L.H }, scale: "1",
      frameTags: L.tags.map((t, ti) => ({ name: names[ti], from: t.from, to: t.to, direction: "forward", color: t.color + "ff" })),
      layers: [], slices: [],
    },
  };
}
// 末尾に _列x行 を付ける（Anim-Editor がファイル名の最後の「数字x数字」を分割数として読む。各64まで）。
// 名前の途中に残った表記（元画像名の _4x4 など）は誤って読まれるので消す。
// セルの大きさがアニメごとに違う・64を超えるときは格子として読めないので付けない
function pngName() {
  const base = $in("baseName").value.trim().replace(/\.(png|json)$/i, "")
    .replace(/[_\-\s]*(?<!\d)\d+\s*[xX×]\s*\d+(?!\d)/g, "").replace(/^[_\-\s]+/, "") || "sprite_sheet";
  const u = layout && layout.uniform;
  const c = u ? Math.round(layout!.W / u[0]) : 0, r = u ? Math.round(layout!.H / u[1]) : 0;
  return base + (c >= 1 && r >= 1 && c <= 64 && r <= 64 ? "_" + c + "x" + r : "") + ".png";
}
$in("baseName").addEventListener("input", () => { $("pngPreview").textContent = layout ? pngName() : ""; });
$btn("btnPng").onclick = () => { if (!layout) return; IT.canvasToBlob(sheet).then((b) => IT.saveFile(pngName(), b), () => toast("PNGを作成できませんでした")); };
$btn("btnJson").onclick = () => { if (!layout) return; IT.saveFile(pngName().replace(/\.png$/, ".json"), new Blob([JSON.stringify(asepriteJson($sel("jsonFormat").value), null, 2)], { type: "application/json" })); };
$btn("btnPolish").onclick = () => {
  if (!layout) return;
  const n = pngName();
  IT.openIn("sprite-polish", IT.canvasToBlob(sheet).then((b) => [new File([b], n, { type: "image/png" }), new File([JSON.stringify(asepriteJson("array"))], n.replace(/\.png$/, ".json"), { type: "application/json" })]));
};

// ---- サンプル（コードで図形を描く。素材ファイルは使わない） ----
function drawSample() {
  const W = 960, H = 600, c = mk(W, H), x = c.getContext("2d")!;
  x.fillStyle = "#5a5a5a"; x.fillRect(0, 0, W, H);
  // 1段目: 広がる光の玉。小さい最初の2コマは縦に積んである
  const orb = (cx: number, cy: number, r: number) => {
    const g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, "#ffffff"); g.addColorStop(0.6, "#fff6c8"); g.addColorStop(0.85, "#f0a830"); g.addColorStop(1, "rgba(240,120,40,0)");
    x.fillStyle = g; x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fill();
  };
  orb(40, 30, 12); orb(40, 95, 24);
  ([[130, 70, 38], [250, 75, 50], [395, 80, 62], [560, 85, 74], [735, 90, 80]] as [number, number, number][]).forEach((a) => orb(...a));
  // 2段目: 回る星（位置が少しずつずれている）
  const star = (cx: number, cy: number, r: number, rot: number) => {
    x.fillStyle = "#7fd3ff"; x.strokeStyle = "#1f6f9f"; x.lineWidth = 3; x.beginPath();
    for (let i = 0; i < 10; i++) { const a = rot + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r; x.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); }
    x.closePath(); x.fill(); x.stroke();
  };
  for (let i = 0; i < 8; i++) star(60 + i * 112 + (i % 3) * 7, 255 + ((i * 37) % 23), 36, i * Math.PI / 20);
  // 3段目: 跳ねる四角
  for (let i = 0; i < 6; i++) {
    const h = [70, 56, 44, 56, 70, 80][i], w = [44, 52, 62, 52, 44, 40][i], cx = 70 + i * 120, by = 430;
    x.fillStyle = "#9be070"; x.strokeStyle = "#3d7a1f"; x.lineWidth = 3;
    x.fillRect(cx - w / 2, by - h, w, h); x.strokeRect(cx - w / 2, by - h, w, h);
  }
  // 4段目: 離れた粒でできた火花（結合距離のテスト用）
  for (let i = 0; i < 7; i++) {
    const cx = 70 + i * 120, cy = 530, d = 8 + i * 5, n = Math.max(5, Math.round(Math.PI * 2 * d / 10));
    x.fillStyle = "#ffd34d";
    for (let k = 0; k < n; k++) { const a = k / n * Math.PI * 2 + i * 0.3; x.beginPath(); x.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 3, 0, Math.PI * 2); x.fill(); }
  }
  // ゴミ点
  x.fillStyle = "#6a6a6a"; x.fillRect(900, 20, 2, 2); x.fillRect(20, 580, 1, 1);
  return c;
}
$btn("btnSample").onclick = () => setSource(drawSample(), "sample_effects.png");

// ---- UI 結線 ----
function setSeg(segId: string, attr: SegAttr, val: string) {
  document.querySelectorAll<HTMLButtonElement>("#" + segId + " button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset[attr] === val)));
  (S as Record<SegAttr, string>)[attr] = val;
  if (segId === "toolSeg") { ovl.className = "tool-" + val; drawOverlay(); }
}
function segWire(segId: string, attr: SegAttr, after?: () => void) {
  document.querySelectorAll<HTMLButtonElement>("#" + segId + " button").forEach((b) => b.addEventListener("click", () => { setSeg(segId, attr, b.dataset[attr]!); syncLabels(); if (after) after(); }));
}
function syncLabels() {
  ["tol", "gap", "minSize", "soft", "fps"].forEach((id) => { $(id + "V").textContent = $in(id).value; });
  $("bgHex").textContent = $in("bgColor").value.toUpperCase();
  $("bgRow").hidden = S.det !== "color";
  $("tolHint").textContent = S.det === "color"
    ? "背景色との差（RGB各成分の最大差）がこれより大きい画素をコマとみなします"
    : "不透明度（0〜255）がこれより大きい画素をコマとみなします";
  $("clearOpts").hidden = S.bgout !== "clear" || S.det !== "color";
  $("fixedRow").hidden = $sel("cellMode").value !== "fixed";
}
let detTimer = 0;
function scheduleDetect() { syncLabels(); clearTimeout(detTimer); detTimer = window.setTimeout(() => runDetect(), 200); }
["tol", "gap", "minSize", "bgColor"].forEach((id) => $(id).addEventListener("input", scheduleDetect));
$sel("autoMode").addEventListener("change", () => { if (!S.src) return; pushUndo(); autoGroup(); S.sel.clear(); refresh(); });
$btn("btnRedetect").onclick = () => runDetect();
$btn("btnPickCorner").onclick = () => { if (!S.src) return; const d = S.data!; $in("bgColor").value = rgbToHex(d[0], d[1], d[2]); savePrefs(); scheduleDetect(); };
segWire("detSeg", "det", () => { if (S.src) runDetect(); });
segWire("bgOutSeg", "bgout", () => { if (S.src) refresh(); });
segWire("anchorSeg", "anchor", () => { if (S.src) refresh(); });
segWire("toolSeg", "tool", () => { drag = null; drawOverlay(); });
["soft", "unblend", "cellMode", "cellW", "cellH", "pad", "maxCols", "mult4"].forEach((id) => $(id).addEventListener("input", () => { syncLabels(); if (S.src) refresh(); }));
$in("showGrid").addEventListener("input", drawSheetView);
$in("fps").addEventListener("input", syncLabels);
$sel("zoom").addEventListener("change", applyZoom);
$sel("animGroup").addEventListener("change", () => { animFrame = 0; drawAnim(); });
$btn("btnPlay").onclick = () => { playing = !playing; $btn("btnPlay").textContent = playing ? "一時停止" : "再生"; };
$btn("btnMerge").onclick = mergeSel; $btn("btnDelete").onclick = deleteSel; $btn("btnNewGroup").onclick = newGroupFromSel;
$btn("btnUndo").onclick = undo; $btn("btnRedo").onclick = redo;
document.addEventListener("keydown", (e) => {
  const tag = ((e.target as Element | null)?.tagName || "").toLowerCase();
  if (tag === "input" || tag === "select" || tag === "textarea") return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); redo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === "a") { if (!S.src) return; e.preventDefault(); S.sel = new Set(S.frames.keys()); refreshSel(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (k === "delete" || k === "backspace") { e.preventDefault(); deleteSel(); }
  else if (k === "m") mergeSel();
  else if (k === "g") newGroupFromSel();
  else if (k === "escape") {
    if (drag && drag.kind === "resize") { Object.assign(drag.f, drag.orig); if (drag.pushed) S.undo.pop(); drag = null; drawOverlay(); updateSelNote(); return; }
    if (drag) { drag = null; drawOverlay(); return; }
    S.sel.clear(); refreshSel();
  }
  else if (k === "v") setSeg("toolSeg", "tool", "select");
  else if (k === "r") setSeg("toolSeg", "tool", "add");
  else if (k === "i") setSeg("toolSeg", "tool", "pick");
});
IT.initDrop({ zone: "drop", input: "fileInput", accept: (f) => isImage(f) || isJson(f), onFiles: loadFiles, emptyMessage: "画像ファイルが見つかりませんでした" });
// 他のツールの「コマ整列ツールで開く」から開かれたときは、渡されたシート（と JSON）を読む
IT.receive(loadFiles);

// ---- 設定の記憶 ----
// IT.store の frame-sorter:settings に 1 オブジェクトで保存する（背景色・出力名は画像ごとに決まるので保存しない）
const PREFS_KEY = "frame-sorter:settings";
const PREF_IDS = ["tol", "gap", "minSize", "autoMode", "soft", "unblend", "cellMode", "cellW", "cellH", "pad", "maxCols", "mult4", "jsonFormat", "fps", "showGrid", "zoom"];
const PREF_SEGS = { bgout: "bgOutSeg", anchor: "anchorSeg" } as const;
type Prefs = Record<string, unknown>;
const prefEl = (id: string) => $<HTMLInputElement | HTMLSelectElement>(id);
function readPrefs(): Prefs {
  const o: Prefs = {};
  PREF_IDS.forEach((id) => { const el = prefEl(id); o[id] = el.type === "checkbox" ? (el as HTMLInputElement).checked : el.value; });
  for (const k in PREF_SEGS) o[k] = S[k as keyof typeof PREF_SEGS];
  return o;
}
const PREF_DEFAULTS = readPrefs();
let restoringPrefs = false;
function savePrefs() { if (!restoringPrefs) IT.store.set(PREFS_KEY, readPrefs()); }
function applyPrefs(p: Prefs) {
  restoringPrefs = true;
  try {
    PREF_IDS.forEach((id) => {
      const el = prefEl(id), v = p[id];
      if (el.type === "checkbox") { if (typeof v === "boolean") (el as HTMLInputElement).checked = v; return; }
      if (typeof v !== "string") return;
      if (el instanceof HTMLSelectElement) { if ([...el.options].some((o) => o.value === v)) el.value = v; return; }
      const n = Number(v), lo = Math.min(+el.min, +(PREF_DEFAULTS[id] as string));
      if (v.trim() !== "" && Number.isInteger(n) && n >= lo && n <= +el.max) el.value = String(n);
    });
    for (const k of Object.keys(PREF_SEGS) as (keyof typeof PREF_SEGS)[]) {
      const ok = typeof p[k] === "string" && [...document.querySelectorAll<HTMLButtonElement>("#" + PREF_SEGS[k] + " button")].some((b) => b.dataset[k] === p[k]);
      if (ok) setSeg(PREF_SEGS[k], k, p[k] as string);
    }
  } finally { restoringPrefs = false; }
  syncLabels(); applyZoom();
  if (S.src) runDetect();
}
PREF_IDS.forEach((id) => ["input", "change"].forEach((t) => $(id).addEventListener(t, savePrefs)));
Object.values(PREF_SEGS).forEach((seg) => document.querySelectorAll("#" + seg + " button").forEach((b) => b.addEventListener("click", savePrefs)));
$btn("btnResetPrefs").onclick = () => { applyPrefs(PREF_DEFAULTS); IT.store.remove(PREFS_KEY); toast("設定をリセットしました"); };
{ const saved = IT.store.get<Prefs>(PREFS_KEY); if (saved && typeof saved === "object") applyPrefs(saved); }

// テストから中の状態を見られるようにする（単体 HTML だった頃のグローバル変数と同じ名前）
Object.assign(window, { S, setSource, cutFrame, pngName });
Object.defineProperty(window, "layout", { get: () => layout, set: (v: Layout | null) => { layout = v; } });
Object.defineProperty(window, "detectCount", { get: () => detectCount });
Object.defineProperty(window, "buildCount", { get: () => buildCount });

// 起動
syncLabels(); updateSelNote(); updateStats(); applyZoom();
requestAnimationFrame(tick);
