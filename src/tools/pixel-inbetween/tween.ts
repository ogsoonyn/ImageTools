/* ドット絵の中割りの処理（DOM に触れない純粋な関数）。
   画素は Uint32（ImageData のバイト列をそのまま読んだ値 = 0xAABBGGRR）。0 が背景（透明） */

export type Px = Uint32Array;

// ================= 色と画素 =================
export const rgbOf = (c: number): [number, number, number] => [c & 255, (c >>> 8) & 255, (c >>> 16) & 255];
export const packRGB = (r: number, g: number, b: number) => (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
export const lum = (c: number) => { const [r, g, b] = rgbOf(c); return 0.299 * r + 0.587 * g + 0.114 * b; };
export const colorDist2 = (a: number, b: number) => { const A = rgbOf(a), B = rgbOf(b); return (A[0] - B[0]) ** 2 + (A[1] - B[1]) ** 2 + (A[2] - B[2]) ** 2; };
export const toHex = (c: number) => "#" + rgbOf(c).map((v) => v.toString(16).padStart(2, "0")).join("");
export const fromHex = (h: string) => packRGB(parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16));

export const EASES: Record<string, { label: string; f: (t: number) => number }> = {
  linear: { label: "一定", f: (t) => t },
  in: { label: "ゆっくり始める", f: (t) => t * t },
  out: { label: "ゆっくり止まる", f: (t) => 1 - (1 - t) * (1 - t) },
  inout: { label: "ゆっくり始めて止まる", f: (t) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)) },
};

// 中割りの作り方（コマの大きさと「細かい設定」）
export type TweenOptions = {
  W: number; H: number;
  align: string;      // "centroid" | "bbox" | "none"
  comps: boolean;
  nearColor: boolean;
  extras: string;     // "merge" | "pop"
  prio: string;       // "edge" | "dark" | "order"
  holes: boolean;
};
type Pt = { x: number; y: number; c: number; e: boolean };
type Vec = { x: number; y: number };
// 動き。v: 0 = ずっと, 1 = 前半だけ, 2 = 後半だけ
export type Move = { ax: number; ay: number; bx: number; by: number; ca: number; cb: number; ea: boolean; eb: boolean; v: number };

// ================= 自動の中割り =================
function collectPoints(px: Px, opt: TweenOptions) {
  const W = opt.W, H = opt.H, pts: Pt[] = [], at = new Int32Array(W * H).fill(-1);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, c = px[i];
    if (!c) continue;
    const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1 || !px[i - 1] || !px[i + 1] || !px[i - W] || !px[i + W];
    at[i] = pts.length;
    pts.push({ x, y, c, e: edge });
  }
  return { pts, at };
}
// 8近傍でつながった絵のかたまり
function components(pts: Pt[], at: Int32Array, opt: TweenOptions): Pt[][] {
  const W = opt.W, H = opt.H, seen = new Uint8Array(pts.length), out: Pt[][] = [];
  for (let s = 0; s < pts.length; s++) {
    if (seen[s]) continue;
    const list: Pt[] = [], stack = [s]; seen[s] = 1;
    while (stack.length) {
      const p = pts[stack.pop()!]; list.push(p);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = p.x + dx, y = p.y + dy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const j = at[y * W + x];
        if (j >= 0 && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    out.push(list);
  }
  return out;
}
function centroid(list: Pt[]): Vec { let x = 0, y = 0; for (const p of list) { x += p.x; y += p.y; } return { x: x / list.length, y: y / list.length }; }
function bboxCenter(list: Pt[]): Vec {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of list) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
}
function offsetOf(A: Pt[], B: Pt[], opt: TweenOptions): Vec {
  if (opt.align === "none") return { x: 0, y: 0 };
  const f = opt.align === "bbox" ? bboxCenter : centroid;
  const a = f(A), b = f(B);
  return { x: b.x - a.x, y: b.y - a.y };
}

type Group = { A: Pt[]; B: Pt[]; ca?: Vec; cb?: Vec };
// かたまりどうしを結ぶ。余ったかたまりは一番近い組に混ぜる
function matchComponents(CA: Pt[][], CB: Pt[][], g: Vec, opt: TweenOptions): Group[] {
  const diag = Math.hypot(opt.W, opt.H) || 1;
  const ca = CA.map(centroid), cb = CB.map(centroid);
  const cand: [number, number, number][] = [];
  for (let i = 0; i < CA.length; i++) for (let j = 0; j < CB.length; j++) {
    const d = Math.hypot(cb[j].x - ca[i].x - g.x, cb[j].y - ca[i].y - g.y) / diag;
    cand.push([d + 0.5 * Math.abs(Math.log(CA[i].length / CB[j].length)), i, j]);
  }
  cand.sort((a, b) => a[0] - b[0]);
  const ga = new Int32Array(CA.length).fill(-1), gb = new Int32Array(CB.length).fill(-1), groups: Required<Group>[] = [];
  for (const [, i, j] of cand) {
    if (ga[i] >= 0 || gb[j] >= 0) continue;
    ga[i] = gb[j] = groups.length;
    groups.push({ A: [...CA[i]], B: [...CB[j]], ca: ca[i], cb: cb[j] });
  }
  for (let i = 0; i < CA.length; i++) if (ga[i] < 0) {
    let best = 0, bd = Infinity;
    groups.forEach((G, k) => { const d = Math.hypot(G.ca.x - ca[i].x, G.ca.y - ca[i].y); if (d < bd) { bd = d; best = k; } });
    groups[best].A.push(...CA[i]);
  }
  for (let j = 0; j < CB.length; j++) if (gb[j] < 0) {
    let best = 0, bd = Infinity;
    groups.forEach((G, k) => { const d = Math.hypot(G.cb.x - cb[j].x, G.cb.y - cb[j].y); if (d < bd) { bd = d; best = k; } });
    groups[best].B.push(...CB[j]);
  }
  return groups;
}

// 2つの点の集まりを、ずれ o を差し引いた距離の2乗の合計が小さくなるように1対1で結ぶ（近似）
function matchSets(A: Pt[], B: Pt[], o: Vec, colorW: number, opt: TweenOptions) {
  const na = A.length, nb = B.length;
  const res: { pairs: [Pt, Pt][]; la: Pt[]; lb: Pt[] } = { pairs: [], la: [], lb: [] };
  if (!na || !nb) { res.la = A.slice(); res.lb = B.slice(); return res; }
  const cost = (a: Pt, b: Pt) => {
    const dx = b.x - a.x - o.x, dy = b.y - a.y - o.y;
    return dx * dx + dy * dy + (colorW ? colorDist2(a.c, b.c) * colorW : 0);
  };
  // 候補の組: 少なければ全部、多ければ近いものだけ。数の少ない側から、多い側を格子で探す
  const ci: number[] = [], cj: number[] = [], cc: number[] = [];
  const add = (i: number, j: number) => { ci.push(i); cj.push(j); cc.push(cost(A[i], B[j])); };
  if (na * nb <= 250000) {
    for (let i = 0; i < na; i++) for (let j = 0; j < nb; j++) add(i, j);
  } else if (na <= nb) {
    const grid = pointGrid(B, opt);
    for (let i = 0; i < na; i++) for (const j of grid.near(A[i].x + o.x, A[i].y + o.y, 10)) add(i, j);
  } else {
    const grid = pointGrid(A, opt);
    for (let j = 0; j < nb; j++) for (const i of grid.near(B[j].x - o.x, B[j].y - o.y, 10)) add(i, j);
  }
  const order = Array.from(cc.keys()).sort((x, y) => cc[x] - cc[y]);
  const ua = new Uint8Array(na), ub = new Uint8Array(nb);
  const pairs: [number, number][] = [];
  for (const k of order) {
    const i = ci[k], j = cj[k];
    if (ua[i] || ub[j]) continue;
    ua[i] = ub[j] = 1; pairs.push([i, j]);
    if (pairs.length === Math.min(na, nb)) break;
  }
  // 近くに相手が見つからなかった残り
  if (pairs.length < Math.min(na, nb)) {
    const ra: number[] = [], rb: number[] = [];
    for (let i = 0; i < na; i++) if (!ua[i]) ra.push(i);
    for (let j = 0; j < nb; j++) if (!ub[j]) rb.push(j);
    if (ra.length * rb.length <= 4e6) {
      for (const i of ra) {
        let best = -1, bc = Infinity;
        for (const j of rb) if (!ub[j]) { const c = cost(A[i], B[j]); if (c < bc) { bc = c; best = j; } }
        if (best < 0) break;
        ua[i] = ub[best] = 1; pairs.push([i, best]);
      }
    } else {
      ra.sort((p, q) => A[p].x + A[p].y - A[q].x - A[q].y); rb.sort((p, q) => B[p].x + B[p].y - B[q].x - B[q].y);
      const m = Math.min(ra.length, rb.length);
      for (let k = 0; k < m; k++) { ua[ra[k]] = ub[rb[k]] = 1; pairs.push([ra[k], rb[k]]); }
    }
  }
  // 入れ替えたほうが合計が減る組を入れ替える（交差をほどく）
  const n = pairs.length;
  const full = n <= 700;
  if (!full) pairs.sort((p, q) => (A[p[0]].x - A[q[0]].x) || (A[p[0]].y - A[q[0]].y));
  for (let sweep = 0; sweep < 4; sweep++) {
    let changed = false;
    for (let p = 0; p < n; p++) {
      const lim = full ? n : Math.min(n, p + 40);
      for (let q = p + 1; q < lim; q++) {
        const [a1, b1] = pairs[p], [a2, b2] = pairs[q];
        if (cost(A[a1], B[b2]) + cost(A[a2], B[b1]) < cost(A[a1], B[b1]) + cost(A[a2], B[b2]) - 1e-9) {
          pairs[p] = [a1, b2]; pairs[q] = [a2, b1]; changed = true;
        }
      }
    }
    if (!changed) break;
  }
  res.pairs = pairs.map(([i, j]) => [A[i], B[j]]);
  for (let i = 0; i < na; i++) if (!ua[i]) res.la.push(A[i]);
  for (let j = 0; j < nb; j++) if (!ub[j]) res.lb.push(B[j]);
  return res;
}

// 点の集まりを 4px 四方の格子に分けて、近い点を速く探す
function pointGrid(list: Pt[], opt: TweenOptions) {
  const cs = 4, gw = Math.ceil(opt.W / cs) + 1, gh = Math.ceil(opt.H / cs) + 1, cells = new Map<number, number[]>();
  list.forEach((p, j) => { const k = Math.floor(p.x / cs) + Math.floor(p.y / cs) * gw; (cells.get(k) || cells.set(k, []).get(k)!).push(j); });
  const maxR = gw + gh;
  // (qx, qy) を中心に r 周目の升だけを見る
  const ring = (qx: number, qy: number, r: number, fn: (j: number) => void) => {
    const at = (gx: number, gy: number) => { if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) return; const l = cells.get(gx + gy * gw); if (l) for (const j of l) fn(j); };
    if (r === 0) { at(qx, qy); return; }
    for (let gx = qx - r; gx <= qx + r; gx++) { at(gx, qy - r); at(gx, qy + r); }
    for (let gy = qy - r + 1; gy < qy + r; gy++) { at(qx - r, gy); at(qx + r, gy); }
  };
  const center = (x: number, y: number) => [Math.min(gw - 1, Math.max(0, Math.floor(x / cs))), Math.min(gh - 1, Math.max(0, Math.floor(y / cs)))];
  return {
    // k 個（全体がそれより少なければ全部）見つかるまで広げ、取りこぼしを減らすためにもう1周見る
    near(x: number, y: number, k: number): number[] {
      const [qx, qy] = center(x, y), out: number[] = [], want = Math.min(k, list.length);
      let stop = -1;
      for (let r = 0; r <= maxR; r++) {
        ring(qx, qy, r, (j) => out.push(j));
        if (stop < 0 && out.length >= want) stop = r + 1;
        if (stop >= 0 && r >= stop) break;
      }
      return out;
    },
    // いちばん近い点（見つけた点より近い点が入りうる周までは見る）
    nearest(x: number, y: number): Pt | null {
      const [qx, qy] = center(x, y);
      let best = -1, bd = Infinity;
      for (let r = 0; r <= maxR; r++) {
        if (best >= 0 && (r - 1) * cs > Math.sqrt(bd)) break;
        ring(qx, qy, r, (j) => { const d = (list[j].x - x) ** 2 + (list[j].y - y) ** 2; if (d < bd) { bd = d; best = j; } });
      }
      return best < 0 ? null : list[best];
    },
  };
}
const groupByColor = (list: Pt[]) => { const m = new Map<number, Pt[]>(); for (const p of list) (m.get(p.c) || m.set(p.c, []).get(p.c)!).push(p); return m; };

// 動きの一覧を作る。move = { ax, ay, bx, by, ca, cb, ea, eb, v }（v: 0 = ずっと, 1 = 前半だけ, 2 = 後半だけ）
export function buildPlan(pxA: Px, pxB: Px, opt: TweenOptions): Move[] {
  const a = collectPoints(pxA, opt), b = collectPoints(pxB, opt), moves: Move[] = [];
  const mv = (p: Pt, q: Pt, v = 0) => moves.push({ ax: p.x, ay: p.y, bx: q.x, by: q.y, ca: p.c, cb: q.c, ea: p.e, eb: q.e, v });
  if (!a.pts.length || !b.pts.length) {
    for (const p of a.pts) mv(p, p, 1);
    for (const q of b.pts) mv(q, q, 2);
    return moves;
  }
  const g = offsetOf(a.pts, b.pts, opt);
  const groups: Group[] = opt.comps
    ? matchComponents(components(a.pts, a.at, opt), components(b.pts, b.at, opt), g, opt)
    : [{ A: a.pts, B: b.pts }];
  for (const G of groups) {
    const o = offsetOf(G.A, G.B, opt);
    const mA = groupByColor(G.A), mB = groupByColor(G.B);
    let LA: Pt[] = [], LB: Pt[] = [];
    for (const [c, la] of mA) {
      const r = matchSets(la, mB.get(c) || [], o, 0, opt);
      r.pairs.forEach(([p, q]) => mv(p, q)); LA.push(...r.la); LB.push(...r.lb);
    }
    for (const [c, lb] of mB) if (!mA.has(c)) LB.push(...lb);
    if (opt.nearColor && LA.length && LB.length) {
      const r = matchSets(LA, LB, o, 0.01, opt);
      r.pairs.forEach(([p, q]) => mv(p, q)); LA = r.la; LB = r.lb;
    }
    if (opt.extras === "merge") {
      // 余った画素: 消える側は近くの画素へ寄っていき、増える側は近くの画素から出てくる
      const grids = new Map<Pt[], ReturnType<typeof pointGrid>>(), gridOf = (list: Pt[]) => grids.get(list) || grids.set(list, pointGrid(list, opt)).get(list)!;
      for (const p of LA) { const q = gridOf(mB.get(p.c) || G.B).nearest(p.x + o.x, p.y + o.y)!; mv(p, q, 1); }
      for (const q of LB) { const p = gridOf(mA.get(q.c) || G.A).nearest(q.x - o.x, q.y - o.y)!; mv(p, q, 2); }
    } else {
      for (const p of LA) mv(p, { x: p.x + o.x, y: p.y + o.y, c: p.c, e: p.e }, 1);
      for (const q of LB) mv({ x: q.x - o.x, y: q.y - o.y, c: q.c, e: q.e }, q, 2);
    }
  }
  return moves;
}
// 「寄せる」の消える側は終点では見えなくてよいので、後半もそのまま描く（重なりで隠れる）
export function renderPlan(moves: Move[], t: number, opt: TweenOptions): Px {
  const W = opt.W, H = opt.H, out = new Uint32Array(W * H), pr = new Float64Array(W * H).fill(-Infinity), edge = new Uint8Array(W * H);
  const late = t >= 0.5;
  moves.forEach((m, k) => {
    if (m.v === 1 && late && opt.extras === "pop") return;
    if (m.v === 2 && !late && opt.extras === "pop") return;
    const x = Math.round(m.ax + (m.bx - m.ax) * t), y = Math.round(m.ay + (m.by - m.ay) * t);
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const c = late ? m.cb : m.ca, e = late ? m.eb : m.ea;
    // 寄せる・出す画素は、移動中ずっとほかの画素より弱くする（形の中に点が残らないように）
    const weak = opt.extras === "merge" && m.v !== 0 ? -1e7 : 0;
    const p = weak + (opt.prio === "edge" ? (e ? 1000 : 0) + (255 - lum(c)) : opt.prio === "dark" ? 255 - lum(c) : k);
    const i = y * W + x;
    if (p > pr[i]) { pr[i] = p; out[i] = c; edge[i] = e ? 1 : 0; }
  });
  dropInnerEdges(out, edge, opt);
  if (opt.holes) fillHoles(out, opt);
  return out;
}
// 輪郭だった画素が移動の途中で形の内側に入ったら、まわりの内側の色に置き換える（中に黒い点が残らないように）
function dropInnerEdges(px: Px, edge: Uint8Array, opt: TweenOptions) {
  const W = opt.W, H = opt.H, src = px.slice();
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    if (!edge[i] || !src[i - 1] || !src[i + 1] || !src[i - W] || !src[i + W]) continue;
    const cnt = new Map<number, number>();
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const j = i + dy * W + dx;
      if (j !== i && src[j] && !edge[j]) cnt.set(src[j], (cnt.get(src[j]) || 0) + 1);
    }
    let best = 0, bn = 0; for (const [c, n] of cnt) if (n > bn) { bn = n; best = c; }
    if (bn >= 3) px[i] = best;
  }
}
// 穴埋め: (1) 上下左右のうち3方向以上が埋まった1ドット (2) 絵に囲まれた小さな背景（外とつながらない）
function fillHoles(px: Px, opt: TweenOptions) {
  const W = opt.W, H = opt.H, src = px.slice();
  const majority = (buf: Px, x: number, y: number) => {
    const cnt = new Map<number, number>();
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const X = x + dx, Y = y + dy;
      if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
      const c = buf[Y * W + X]; if (c) cnt.set(c, (cnt.get(c) || 0) + 1);
    }
    let best = 0, bn = 0; for (const [c, n] of cnt) if (n > bn) { bn = n; best = c; }
    return best;
  };
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    if (src[i]) continue;
    const n4 = (src[i - 1] ? 1 : 0) + (src[i + 1] ? 1 : 0) + (src[i - W] ? 1 : 0) + (src[i + W] ? 1 : 0);
    if (n4 >= 3) px[i] = majority(src, x, y);
  }
  const seen = new Uint8Array(W * H), limit = Math.max(4, Math.round(W * H * 0.01));
  for (let s = 0; s < W * H; s++) {
    if (px[s] || seen[s]) continue;
    const reg: number[] = [], st = [s]; seen[s] = 1; let open = false;
    while (st.length) {
      const i = st.pop()!, x = i % W, y = (i / W) | 0; reg.push(i);
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) open = true;
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1])
        if (j >= 0 && !px[j] && !seen[j]) { seen[j] = 1; st.push(j); }
    }
    if (open || reg.length > limit) continue;
    // 外側から順に、まわりで多い色で埋める
    let left = reg;
    while (left.length) {
      const next: number[] = [], fills: [number, number][] = [];
      for (const i of left) { const c = majority(px, i % W, (i / W) | 0); if (c) fills.push([i, c]); else next.push(i); }
      if (!fills.length) break;
      for (const [i, c] of fills) px[i] = c;
      left = next;
    }
  }
}
