/* ドット絵拡大の処理（DOM に触れない純粋な関数）。画素は Uint32 の RGBA リトルエンディアン */

export type Img = { px: Uint32Array; w: number; h: number };
export type Border = "clamp" | "clear";
export type MethodId = "nearest" | "scale" | "xbr" | "xbrs";
export type Scale = 2 | 3 | 4 | 6 | 8;
export type ThinOptions = { outline: Set<number>; palette: number[]; width: number; inner: boolean; dotKeep: number };
type Step = ["n", number] | "s2" | "s3" | "x";

const A = (c: number) => c >>> 24;
const opaque = (c: number) => (c >>> 24) >= 128;

// 周囲 p ドットを足した配列。border = "clamp"（端の色を延ばす）/ "clear"（透明）
function pad(img: Img, p: number, border: Border): Uint32Array {
  const { px, w, h } = img, pw = w + p * 2, ph = h + p * 2, P = new Uint32Array(pw * ph);
  for (let yy = 0; yy < ph; yy++) {
    let sy = yy - p;
    const inY = sy >= 0 && sy < h;
    if (!inY && border !== "clamp") continue;
    sy = sy < 0 ? 0 : sy >= h ? h - 1 : sy;
    for (let xx = 0; xx < pw; xx++) {
      let sx = xx - p;
      const inX = sx >= 0 && sx < w;
      if (!inX && border !== "clamp") continue;
      sx = sx < 0 ? 0 : sx >= w ? w - 1 : sx;
      P[yy * pw + xx] = px[sy * w + sx];
    }
  }
  return P;
}

function nearest(img: Img, s: number): Img {
  const { px, w, h } = img, W = w * s, H = h * s, out = new Uint32Array(W * H);
  for (let y = 0; y < H; y++) {
    const sy = (y / s) | 0;
    for (let x = 0; x < W; x++) out[y * W + x] = px[sy * w + ((x / s) | 0)];
  }
  return { px: out, w: W, h: H };
}

function scale2x(img: Img, border: Border): Img {
  const { w, h } = img, P = pad(img, 1, border), pw = w + 2, W = w * 2, out = new Uint32Array(W * h * 2);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = (y + 1) * pw + x + 1;
    const B = P[c - pw], D = P[c - 1], E = P[c], F = P[c + 1], H = P[c + pw];
    let e0 = E, e1 = E, e2 = E, e3 = E;
    if (B !== H && D !== F) {
      if (D === B) e0 = D;
      if (B === F) e1 = F;
      if (D === H) e2 = D;
      if (H === F) e3 = F;
    }
    const o = y * 2 * W + x * 2;
    out[o] = e0; out[o + 1] = e1; out[o + W] = e2; out[o + W + 1] = e3;
  }
  return { px: out, w: W, h: h * 2 };
}

function scale3x(img: Img, border: Border): Img {
  const { w, h } = img, P = pad(img, 1, border), pw = w + 2, W = w * 3, out = new Uint32Array(W * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = (y + 1) * pw + x + 1;
    const Aa = P[c - pw - 1], B = P[c - pw], C = P[c - pw + 1], D = P[c - 1], E = P[c], F = P[c + 1],
      G = P[c + pw - 1], H = P[c + pw], I = P[c + pw + 1];
    const e = [E, E, E, E, E, E, E, E, E];
    if (B !== H && D !== F) {
      e[0] = D === B ? D : E;
      e[1] = (D === B && E !== C) || (B === F && E !== Aa) ? B : E;
      e[2] = B === F ? F : E;
      e[3] = (D === B && E !== G) || (D === H && E !== Aa) ? D : E;
      e[5] = (B === F && E !== I) || (H === F && E !== C) ? F : E;
      e[6] = D === H ? D : E;
      e[7] = (D === H && E !== I) || (H === F && E !== G) ? H : E;
      e[8] = H === F ? F : E;
    }
    const o = y * 3 * W + x * 3;
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) out[o + j * W + i] = e[j * 3 + i];
  }
  return { px: out, w: W, h: h * 3 };
}

// 2 色を重み w（0..1、c2 の割合）で混ぜる。透明を含むのでアルファで重み付けする
function mixColor(c1: number, c2: number, w: number): number {
  if (c1 === c2) return c1;
  const a1 = A(c1) / 255 * (1 - w), a2 = A(c2) / 255 * w, a = a1 + a2;
  if (a <= 0) return 0;
  const r = ((c1 & 255) * a1 + (c2 & 255) * a2) / a;
  const g = (((c1 >>> 8) & 255) * a1 + ((c2 >>> 8) & 255) * a2) / a;
  const b = (((c1 >>> 16) & 255) * a1 + ((c2 >>> 16) & 255) * a2) / a;
  return ((Math.round(a * 255) << 24) | (Math.round(b) << 16) | (Math.round(g) << 8) | Math.round(r)) >>> 0;
}

// xBR 2 倍（Hyllian の xBR を元にした実装）。blend = false なら新しい色を作らない「くっきり」版
function xbr2x(img: Img, border: Border, blend: boolean): Img {
  const { w, h } = img, p = 2, P = pad(img, p, border), pw = w + p * 2, n = P.length;
  const Y = new Float32Array(n), U = new Float32Array(n), V = new Float32Array(n), Al = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const c = P[i], r = c & 255, g = (c >>> 8) & 255, b = (c >>> 16) & 255;
    Y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    U[i] = -0.169 * r - 0.331 * g + 0.5 * b;
    V[i] = 0.5 * r - 0.419 * g - 0.081 * b;
    Al[i] = A(c);
  }
  const d = (i: number, j: number) => 48 * Math.abs(Y[i] - Y[j]) + 7 * Math.abs(U[i] - U[j]) + 6 * Math.abs(V[i] - V[j]) + 48 * Math.abs(Al[i] - Al[j]);
  const eq = (i: number, j: number) => P[i] === P[j] || (Math.abs(Y[i] - Y[j]) <= 24 && Math.abs(U[i] - U[j]) <= 6 && Math.abs(V[i] - V[j]) <= 6 && Math.abs(Al[i] - Al[j]) <= 8);
  const mix = blend ? mixColor : (c1: number, c2: number, wt: number) => (wt >= 0.5 ? c2 : c1);
  const o = [0, 0, 0, 0];
  function kernel(pe: number, pi: number, ph: number, pf: number, pg: number, pc: number, pd: number, pb: number,
    f4: number, i4: number, h5: number, i5: number, n1: number, n2: number, n3: number): void {
    if (eq(pe, ph) || eq(pe, pf)) return;
    const e = d(pe, pc) + d(pe, pg) + d(pi, h5) + d(pi, f4) + 4 * d(ph, pf);
    const i = d(ph, pd) + d(ph, i5) + d(pf, i4) + d(pf, pb) + 4 * d(pe, pi);
    const px = P[d(pe, pf) <= d(pe, ph) ? pf : ph];
    if (e < i && ((!eq(pf, pb) && !eq(ph, pd)) || (eq(pe, pi) && !eq(pf, i4) && !eq(ph, i5)) || eq(pe, pg) || eq(pe, pc))) {
      const ke = d(pf, pg), ki = d(ph, pc);
      const ex2 = !eq(pe, pc) && !eq(pb, pc), ex3 = !eq(pe, pg) && !eq(pd, pg);
      const left = 2 * ke <= ki && ex3, up = ke >= 2 * ki && ex2;
      if (left || up) {
        o[n3] = mix(o[n3], px, 0.75);
        if (left) o[n2] = mix(o[n2], px, 0.25);
        if (up) o[n1] = mix(o[n1], px, 0.25);
      } else o[n3] = mix(o[n3], px, 0.5);
    } else if (e <= i) o[n3] = mix(o[n3], px, 0.25);
  }
  const W = w * 2, out = new Uint32Array(W * h * 2), r = pw;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = (y + p) * pw + x + p;
    const pa = c - r - 1, pb = c - r, pc = c - r + 1, pd = c - 1, pe = c, pf = c + 1, pg = c + r - 1, ph = c + r, pi = c + r + 1;
    const a1 = c - 2 * r - 1, b1 = c - 2 * r, c1 = c - 2 * r + 1, a0 = c - r - 2, c4 = c - r + 2, d0 = c - 2, f4 = c + 2,
      g0 = c + r - 2, i4 = c + r + 2, g5 = c + 2 * r - 1, h5 = c + 2 * r, i5 = c + 2 * r + 1;
    o[0] = o[1] = o[2] = o[3] = P[pe];
    kernel(pe, pi, ph, pf, pg, pc, pd, pb, f4, i4, h5, i5, 1, 2, 3);
    kernel(pe, pc, pf, pb, pi, pa, ph, pd, b1, c1, f4, c4, 0, 3, 1);
    kernel(pe, pa, pb, pd, pc, pg, pf, ph, d0, a0, b1, a1, 2, 1, 0);
    kernel(pe, pg, pd, ph, pa, pi, pb, pf, h5, g5, d0, g0, 3, 0, 2);
    const q = y * 2 * W + x * 2;
    out[q] = o[0]; out[q + 1] = o[1]; out[q + W] = o[2]; out[q + W + 1] = o[3];
  }
  return { px: out, w: W, h: h * 2 };
}

export const METHODS: { id: MethodId; label: string }[] = [
  { id: "nearest", label: "最近傍（ドットのまま）" },
  { id: "scale", label: "Scale2x/3x（軽くジャギー取り）" },
  { id: "xbr", label: "xBR くっきり（新しい色を作らない）" },
  { id: "xbrs", label: "xBR なめらか（中間色で滑らかに）" },
];

// 倍率ごとの段取り。xBR は 2 倍の繰り返しなので 3 の倍数は Scale3x を混ぜる
export function plan(method: MethodId, s: Scale): { steps: Step[]; note?: string } {
  if (method === "nearest") return { steps: [["n", s]] };
  const S = ({ 2: ["s2"], 3: ["s3"], 4: ["s2", "s2"], 6: ["s3", "s2"], 8: ["s2", "s2", "s2"] } as Record<Scale, Step[]>)[s];
  if (method === "scale") return { steps: S };
  const X = ({ 2: ["x"], 4: ["x", "x"], 8: ["x", "x", "x"], 6: ["x", "s3"], 3: ["s3"] } as Record<Scale, Step[]>)[s];
  const note = s === 3 ? "xBR は 2 倍単位のため、3倍は Scale3x で処理しています"
    : s === 6 ? "6倍は xBR 2倍のあと Scale3x で処理しています" : "";
  return { steps: X, note };
}

function upscale(img: Img, method: MethodId, s: Scale, border: Border): Img {
  let cur = img;
  for (const st of plan(method, s).steps) {
    if (Array.isArray(st)) cur = nearest(cur, st[1]);
    else if (st === "s2") cur = scale2x(cur, border);
    else if (st === "s3") cur = scale3x(cur, border);
    else cur = xbr2x(cur, border, method === "xbrs");
  }
  if (method === "xbrs") {
    // 縁に半透明のにじみを出さない
    const px = cur.px;
    for (let i = 0; i < px.length; i++) {
      const a = A(px[i]);
      if (a < 128) px[i] = 0; else if (a < 255) px[i] = (px[i] | 0xff000000) >>> 0;
    }
  }
  return cur;
}

// ---- 輪郭を細く保つ ----
// Zhang-Suen の細線化。M（0/1）をその場で書き換える
function skeletonize(M: Uint8Array, W: number, H: number): Uint8Array {
  let list = [];
  for (let i = 0; i < M.length; i++) if (M[i]) list.push(i);
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : M[y * W + x]);
  let changed = true;
  while (changed) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      const del: number[] = [];
      for (const i of list) {
        if (!M[i]) continue;
        const x = i % W, y = (i / W) | 0;
        const p2 = at(x, y - 1), p3 = at(x + 1, y - 1), p4 = at(x + 1, y), p5 = at(x + 1, y + 1),
          p6 = at(x, y + 1), p7 = at(x - 1, y + 1), p8 = at(x - 1, y), p9 = at(x - 1, y - 1);
        const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
        if (B < 2 || B > 6) continue;
        const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
        let Acount = 0;
        for (let k = 0; k < 8; k++) if (!seq[k] && seq[k + 1]) Acount++;
        if (Acount !== 1) continue;
        if (step === 0 ? (p2 * p4 * p6 || p4 * p6 * p8) : (p2 * p4 * p8 || p2 * p6 * p8)) continue;
        del.push(i);
      }
      for (const i of del) M[i] = 0;
      if (del.length) changed = true;
    }
    list = list.filter((i) => M[i]);
  }
  return M;
}

/*
 * src: 元のコマ, out: 拡大後, s: 倍率, opt: { outline:Set, palette:[色], width, inner, dotKeep, border }
 * 元画像で輪郭の色の画素を「外側（透明に接する）」「内側」「小さな点」に分け、拡大後の画素へ写す。
 * 外側は透明からの距離が width 以下だけ残す。内側は中心線（細線化）を width に太らせて残す。
 * 消した画素は、近くの塗り（輪郭でない不透明な画素）の色で埋める。
 */
function thinOutline(src: Img, out: Img, s: number, opt: ThinOptions & { border: Border }): Img {
  const { px: sp, w, h } = src, { px: op, w: W, h: H } = out;
  const K = opt.width, set = opt.outline, clear = opt.border === "clear";
  if (!set.size) return out;
  const res = op.slice();
  // 元画像の分類: 0 = 輪郭でない, 1 = 外側, 2 = 内側, 3 = 小さな点（残す）
  const isOL = new Uint8Array(w * h), cls = new Uint8Array(w * h);
  for (let i = 0; i < sp.length; i++) isOL[i] = opaque(sp[i]) && set.has(sp[i]) ? 1 : 0;
  const transAt = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? clear : !opaque(sp[y * w + x]));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!isOL[i]) continue;
    let outer = false;
    for (let dy = -1; dy <= 1 && !outer; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && transAt(x + dx, y + dy)) { outer = true; break; }
    cls[i] = outer ? 1 : 2;
  }
  // 内側の小さなかたまり（目など）は線として扱わない
  const seen = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (cls[i] !== 2 || seen[i]) continue;
    const comp = [i]; seen[i] = 1;
    for (let k = 0; k < comp.length; k++) {
      const x = comp[k] % w, y = (comp[k] / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (cls[j] === 2 && !seen[j]) { seen[j] = 1; comp.push(j); }
      }
    }
    if (comp.length <= opt.dotKeep || !opt.inner) for (const j of comp) cls[j] = 3;
  }
  // 輪郭でない元画素に、隣の輪郭の分類を持たせる（拡大で輪郭がはみ出した所のため）
  const near = new Uint8Array(w * h);
  const prio = [0, 3, 2, 1]; // 外側 > 内側 > 点（値は分類の番号ごとの優先度）
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (cls[i]) { near[i] = cls[i]; continue; }
    let best = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const c = cls[ny * w + nx];
      if (prio[c] > prio[best]) best = c;
    }
    near[i] = best;
  }

  // 拡大後の画素が輪郭の色か（中間色は一番近いパレットの色で判断）
  const memo = new Map<number, boolean>(), pal = opt.palette;
  const isOutlineColor = (c: number) => {
    if (!opaque(c)) return false;
    if (set.has(c)) return true;
    let v = memo.get(c);
    if (v !== undefined) return v;
    let best = Infinity, bc = 0;
    const r = c & 255, g = (c >>> 8) & 255, b = (c >>> 16) & 255;
    for (const q of pal) {
      const dr = r - (q & 255), dg = g - ((q >>> 8) & 255), db = b - ((q >>> 16) & 255);
      const dd = dr * dr * 3 + dg * dg * 4 + db * db * 2;
      if (dd < best) { best = dd; bc = q; }
    }
    v = set.has(bc);
    memo.set(c, v);
    return v;
  };
  const N = W * H, oOL = new Uint8Array(N), oc = new Uint8Array(N);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(h - 1, (y / s) | 0);
    for (let x = 0; x < W; x++) {
      const j = y * W + x;
      if (!isOutlineColor(op[j])) continue;
      oOL[j] = 1;
      oc[j] = near[sy * w + Math.min(w - 1, (x / s) | 0)];
    }
  }

  // 透明からの距離（4 近傍、K まで）。コマの外も透明として数える
  const dT = new Uint8Array(N).fill(255), q: number[] = [];
  for (let j = 0; j < N; j++) if (!opaque(op[j])) { dT[j] = 0; q.push(j); }
  if (clear) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const j = y * W + x;
    if ((x === 0 || y === 0 || x === W - 1 || y === H - 1) && dT[j] > 1) { dT[j] = 1; q.push(j); }
  }
  for (let b = 0; b < q.length; b++) {
    const j = q[b];
    if (dT[j] >= K) continue;
    const x = j % W, y = (j / W) | 0, nd = dT[j] + 1;
    if (x > 0 && dT[j - 1] > nd) { dT[j - 1] = nd; q.push(j - 1); }
    if (x < W - 1 && dT[j + 1] > nd) { dT[j + 1] = nd; q.push(j + 1); }
    if (y > 0 && dT[j - W] > nd) { dT[j - W] = nd; q.push(j - W); }
    if (y < H - 1 && dT[j + W] > nd) { dT[j + W] = nd; q.push(j + W); }
  }

  // 内側の線: 中心線を求める
  const keep = new Uint8Array(N);
  const M = new Uint8Array(N);
  let hasInner = false;
  for (let j = 0; j < N; j++) if (oOL[j] && oc[j] === 2) { M[j] = 1; hasInner = true; }
  if (hasInner) {
    const M0 = M.slice();
    skeletonize(M, W, H);
    // 内側の線の端が外側の輪郭につながっていた所は、外側の残す線まで最短でつなぎ直す
    // （細線化で端が少し縮むので、元の線の範囲と外側の輪郭の中を通って探す）
    const stamp = new Int32Array(N), prev = new Int32Array(N), dist = new Int32Array(N);
    let tag = 0;
    const limit = (s * 4) * (s * 4);
    const ends: number[] = [];
    for (let j = 0; j < N; j++) {
      if (!M[j]) continue;
      const x = j % W, y = (j / W) | 0;
      let nb = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if ((dx || dy) && nx >= 0 && ny >= 0 && nx < W && ny < H && M[ny * W + nx]) nb++;
      }
      if (nb <= 1) ends.push(j);
    }
    const allowed = (k: number) => M0[k] || (oOL[k] && oc[k] === 1);
    // まず線の向きのまままっすぐ延ばす（向きは中心線を少し戻った点から求める）
    const extend = (j: number) => {
      let cur = j, back = j, from = -1;
      for (let n = 0; n < s * 2; n++) {
        const x = cur % W, y = (cur / W) | 0;
        let next = -1;
        for (let dy = -1; dy <= 1 && next < 0; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const k = ny * W + nx;
          if (M[k] && k !== from && k !== cur) { next = k; break; }
        }
        if (next < 0) break;
        from = cur; cur = next; back = cur;
      }
      if (back === j) return false;
      let vx = (j % W) - (back % W), vy = ((j / W) | 0) - ((back / W) | 0);
      const len = Math.hypot(vx, vy);
      vx /= len; vy /= len;
      const path: number[] = [];
      const x0 = j % W, y0 = (j / W) | 0;
      for (let t = 1; t <= s * 3; t++) {
        const x = Math.round(x0 + vx * t), y = Math.round(y0 + vy * t);
        if (x < 0 || y < 0 || x >= W || y >= H) return false;
        const k = y * W + x;
        if (!allowed(k)) return false;
        if (oc[k] === 1 && dT[k] <= K) { for (const c of path) M[c] = 1; return true; }
        path.push(k);
      }
      return false;
    };
    for (const j of ends) {
      if (extend(j)) continue;
      tag++;
      const bq = [j]; stamp[j] = tag; prev[j] = -1; dist[j] = 0;
      let found = -1;
      for (let b = 0; b < bq.length && b < limit; b++) {
        const c = bq[b], cx = c % W, cy = (c / W) | 0;
        if (oc[c] === 1 && dT[c] <= K) { found = c; break; }
        if (dist[c] >= s * 2) continue;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx, ny = cy + dy;
          if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const k = ny * W + nx;
          if (stamp[k] === tag || !allowed(k)) continue;
          stamp[k] = tag; prev[k] = c; dist[k] = dist[c] + 1; bq.push(k);
        }
      }
      for (let c = found; c >= 0 && c !== j; c = prev[c]) M[c] = 1;
    }
    // 線の太さに戻す
    const lo = -Math.floor((K - 1) / 2), hi = lo + K - 1;
    for (let j = 0; j < N; j++) {
      if (!M[j]) continue;
      const x = j % W, y = (j / W) | 0;
      for (let dy = lo; dy <= hi; dy++) for (let dx = lo; dx <= hi; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const k = ny * W + nx;
        if (oOL[k] && (oc[k] === 2 || oc[k] === 1)) keep[k] = 1;
      }
    }
  }

  // 消す画素を決め、近くの塗りの色で埋める
  const rm = new Uint8Array(N);
  let fq: number[] = [];
  const filled = new Uint8Array(N);
  for (let j = 0; j < N; j++) {
    if (oOL[j]) {
      const c = oc[j];
      if ((c === 1 && dT[j] > K && !keep[j]) || (c === 2 && !keep[j])) rm[j] = 1;
    } else if (opaque(op[j])) { filled[j] = 1; fq.push(j); }
  }
  while (fq.length) {
    const nq: number[] = [];
    for (const j of fq) {
      const x = j % W, y = (j / W) | 0;
      const go = (k: number) => { if (rm[k] && !filled[k]) { filled[k] = 1; res[k] = res[j]; nq.push(k); } };
      if (x > 0) go(j - 1);
      if (x < W - 1) go(j + 1);
      if (y > 0) go(j - W);
      if (y < H - 1) go(j + W);
    }
    fq = nq;
  }
  return { px: res, w: W, h: H };
}

// 画像全体の処理。frame = { cols, rows } ならコマごとに別々に拡大する
export function render(img: Img, opt: { method: MethodId; scale: Scale; frame: { cols: number; rows: number } | null; thin: ThinOptions | null }): Img & { note: string } {
  const { method, scale: s, frame, thin } = opt;
  const hasAlpha = img.px.some((c) => !opaque(c));
  const border = hasAlpha ? "clear" : "clamp"; // 不透明な画像はコマ単位でも端の色を延ばす（透明で角が欠けないように）
  const cols = frame ? frame.cols : 1, rows = frame ? frame.rows : 1;
  const cw = Math.floor(img.w / cols), ch = Math.floor(img.h / rows);
  const W = cw * cols * s, H = ch * rows * s, out = new Uint32Array(W * H);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const cell = new Uint32Array(cw * ch);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) cell[y * cw + x] = img.px[(r * ch + y) * img.w + c * cw + x];
    const src = { px: cell, w: cw, h: ch };
    let up = upscale(src, method, s, border);
    if (thin) up = thinOutline(src, up, s, { ...thin, border });
    for (let y = 0; y < up.h; y++) out.set(up.px.subarray(y * up.w, (y + 1) * up.w), (r * ch * s + y) * W + c * cw * s);
  }
  return { px: out, w: W, h: H, note: plan(method, s).note || "" };
}

// 色の一覧（多い順）と、輪郭らしい色の推定（透明に接する画素で一番多い色）
export function analyze(img: Img): { palette: number[]; auto: number | null } {
  const { px, w, h } = img, count = new Map<number, number>(), edge = new Map<number, number>();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = px[y * w + x];
    if (!opaque(c)) continue;
    count.set(c, (count.get(c) || 0) + 1);
    let e = x === 0 || y === 0 || x === w - 1 || y === h - 1;
    for (let dy = -1; dy <= 1 && !e; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && !opaque(px[ny * w + nx])) { e = true; break; }
    }
    if (e) edge.set(c, (edge.get(c) || 0) + 1);
  }
  const palette = [...count.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const lum = (c: number) => 0.299 * (c & 255) + 0.587 * ((c >>> 8) & 255) + 0.114 * ((c >>> 16) & 255);
  let auto: number | null = null;
  const hasAlpha = px.some((c) => !opaque(c));
  if (hasAlpha && edge.size) auto = [...edge.entries()].sort((a, b) => b[1] - a[1])[0][0];
  else if (palette.length) auto = palette.slice(0, 16).reduce((a, b) => (lum(b) < lum(a) ? b : a));
  return { palette, auto };
}
