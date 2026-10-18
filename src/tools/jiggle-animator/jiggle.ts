// 揺れものアニメーターの計算部分（DOM に触れない純粋な処理）: 体の動き・バネの揺れ・拡縮のシミュレーションと、1フレームの変形
export const TAU = Math.PI * 2;

export type Motion = "hop" | "bounce" | "sway" | "land" | "none";
export type Mode = "pixel" | "smooth"; // "pixel" = ドット絵, "smooth" = イラスト
export type Axis = "both" | "x" | "y";
export type ScaleMode = "none" | "inflate" | "shrink" | "pulse";

export type Region = {
  name: string; cx: number; cy: number; rx: number; ry: number; feather: number;
  anchorOn: boolean; ax: number; ay: number;
  gain: number; axis: Axis; freq: number; damp: number;
  scaleMode: ScaleMode; scaleAmt: number; phase: number; scaleSpring: boolean;
};
// シミュレーションに使う全体設定
export type MotionSettings = { motion: Motion; amp: number; cycles: number; bodyMove: boolean; frames: number };
// 1フレーム分の結果: 体の位置と、領域ごとの揺れ (dx, dy)・拡縮 s
export type RegionFrame = { dx: number; dy: number; s: number };
export type SimFrame = { bx: number; by: number; rs: RegionFrame[] };
export type Source = { name: string; w: number; h: number; data: Uint8ClampedArray };

// ---------------------------------------------------------------- 体の動き
function bodyPos(motion: Motion, t: number, T: number, P: number, A: number): [number, number] {
  switch (motion) {
    case "hop": return [0, -A * Math.abs(Math.sin(Math.PI * t / P))];
    case "bounce": return [0, A * Math.sin(TAU * t / P)];
    case "sway": return [A * Math.sin(TAU * t / P), 0];
    case "land": { const tf = Math.max(T * 0.25, 1e-3); return [0, t < tf ? -A * (1 - (t / tf) ** 2) : 0]; }
    default: return [0, 0];
  }
}
function wave(kind: ScaleMode, u: number): number {
  switch (kind) {
    case "inflate": return (1 - Math.cos(u)) / 2;
    case "shrink": return -(1 - Math.cos(u)) / 2;
    case "pulse": return Math.sin(u);
    default: return 0;
  }
}
// 変形が折り返さない（逆算が収束する）よう、変位場の傾きの目安を 0.9 未満に抑える係数。
// 揺れ: 重みの傾きは最大 1.5/幅 なので |d|×1.5/幅。幅はぼかしの帯と根元〜中心の短い方。
// 拡縮: s×(p−c)×重み の傾きはおよそ |s|×(1 + 1.5/ぼかし + 根元側の項)。
function foldLimits(r: Region) {
  const rmin = Math.min(r.rx, r.ry), rmax = Math.max(r.rx, r.ry);
  const L = r.anchorOn ? Math.hypot(r.cx - r.ax, r.cy - r.ay) : Infinity;
  const band = Math.max(0.5, Math.min(r.feather * rmin, L >= 1 ? L : Infinity));
  return { kd: 1.5 / band, ks: 1 + 1.5 / r.feather + (L >= 1 && L < Infinity ? 1.5 * rmax / L : 0) };
}
const FOLD_MAX = 0.9;

// 各フレームの体の位置・領域ごとの揺れ・拡縮を求める
export function simulate(regions: Region[], S: MotionSettings, mode: Mode): { list: SimFrame[]; warm: number; SUB: number } {
  // 時間は「1ループ = 1」で正規化する。枚数は切り出す細かさ、再生速度は再生の速さだけを変え、動きの中身は変えない
  const N = S.frames, T = 1, loop = S.motion !== "land";
  const P = S.motion === "land" ? T : T / S.cycles;
  const A = S.amp;
  let wMax = 1;
  for (const r of regions) wMax = Math.max(wMax, TAU * r.freq);
  const SUB = Math.max(8, Math.ceil(Math.max(800, wMax / 0.01) / N));
  const dt = T / (N * SUB);
  // ループ時は数回空回しして定常状態の1ループを切り出す（継ぎ目が出ない）
  let warm = 0;
  if (loop && regions.length) {
    let tau = 0;
    for (const r of regions) tau = Math.max(tau, 1 / (Math.max(r.damp, 0.02) * TAU * r.freq));
    warm = Math.min(200, Math.max(2, Math.ceil(8 * tau / T)));
  }
  const st = regions.map((r) => ({ dx: 0, dy: 0, vx: 0, vy: 0, s: r.scaleSpring ? 0 : 0, vs: 0 }));
  const out: SimFrame[] = [];
  const totalFrames = warm * N + N;
  const bp = (t: number) => bodyPos(S.motion, t, T, P, A);
  for (let f = 0; f < totalFrames; f++) {
    if (f >= warm * N) {
      const t = f * SUB * dt;
      const b = S.bodyMove ? bp(t) : [0, 0];
      const rs = regions.map((r, i) => {
        let dx = st[i].dx * r.gain, dy = st[i].dy * r.gain, s = st[i].s;
        const { kd, ks } = foldLimits(r);
        const lip = Math.hypot(dx, dy) * kd + Math.abs(s) * ks;
        const clamped = lip > FOLD_MAX;
        if (clamped) { const f = FOLD_MAX / lip; dx *= f; dy *= f; s *= f; }
        // 丸めで上限を越えないよう、抑えたときは 0 側へ切り捨てる
        if (mode === "pixel") { const q = clamped ? Math.trunc : Math.round; dx = q(dx); dy = q(dy); }
        return { dx, dy, s };
      });
      out.push({ bx: mode === "pixel" ? Math.round(b[0]) : b[0], by: mode === "pixel" ? Math.round(b[1]) : b[1], rs });
    }
    for (let k = 0; k < SUB; k++) {
      const t = (f * SUB + k) * dt;
      const a0 = bp(t - dt), a1 = bp(t), a2 = bp(t + dt);
      const ax = (a0[0] - 2 * a1[0] + a2[0]) / (dt * dt);
      const ay = (a0[1] - 2 * a1[1] + a2[1]) / (dt * dt);
      for (let i = 0; i < regions.length; i++) {
        const r = regions[i], q = st[i], w = TAU * r.freq, z = r.damp;
        if (r.axis !== "y") { q.vx += (-w * w * q.dx - 2 * z * w * q.vx - ax) * dt; q.dx += q.vx * dt; } else { q.dx = q.vx = 0; }
        if (r.axis !== "x") { q.vy += (-w * w * q.dy - 2 * z * w * q.vy - ay) * dt; q.dy += q.vy * dt; } else { q.dy = q.vy = 0; }
        const target = r.scaleAmt * wave(r.scaleMode, TAU * t / P + r.phase * Math.PI / 180);
        if (r.scaleSpring) { q.vs += (w * w * (target - q.s) - 2 * z * w * q.vs) * dt; q.s += q.vs * dt; }
        else q.s = target;
      }
    }
  }
  return { list: out, warm, SUB };
}

// ---------------------------------------------------------------- 変形
export type PreparedRegion = {
  cx: number; cy: number; irx: number; iry: number; inner: number; feather: number;
  dx: number; dy: number; s: number; anchor: boolean; ax: number; ay: number; vx: number; vy: number; iL2: number;
  x0: number; x1: number; y0: number; y1: number;
};
export function prepRegion(r: Region, fr: RegionFrame | null | undefined): PreparedRegion {
  const R: PreparedRegion = {
    cx: r.cx, cy: r.cy, irx: 1 / r.rx, iry: 1 / r.ry, inner: 1 - r.feather, feather: r.feather,
    dx: fr ? fr.dx : 0, dy: fr ? fr.dy : 0, s: fr ? fr.s : 0, anchor: false, ax: 0, ay: 0, vx: 0, vy: 0, iL2: 0,
    x0: 0, x1: 0, y0: 0, y1: 0,
  };
  if (r.anchorOn) {
    const vx = r.cx - r.ax, vy = r.cy - r.ay, L2 = vx * vx + vy * vy;
    if (L2 >= 1) Object.assign(R, { anchor: true, ax: r.ax, ay: r.ay, vx, vy, iL2: 1 / L2 });
  }
  const m = Math.hypot(R.dx, R.dy) + Math.abs(R.s) * Math.max(r.rx, r.ry) + 2;
  R.x0 = r.cx - r.rx - m; R.x1 = r.cx + r.rx + m; R.y0 = r.cy - r.ry - m; R.y1 = r.cy + r.ry + m;
  return R;
}
export function weightAt(R: PreparedRegion, x: number, y: number): number {
  const nx = (x - R.cx) * R.irx, ny = (y - R.cy) * R.iry, r2 = nx * nx + ny * ny;
  if (r2 >= 1) return 0;
  let w = 1;
  const rr = Math.sqrt(r2);
  if (rr > R.inner) { const tt = (1 - rr) / R.feather; w = tt * tt * (3 - 2 * tt); }
  if (R.anchor) {
    const tt = ((x - R.ax) * R.vx + (y - R.ay) * R.vy) * R.iL2;
    if (tt <= 0) return 0;
    if (tt < 1) w *= tt * tt * (3 - 2 * tt);
  }
  return w;
}

// 出力ピクセルごとに元画像の座標を逆算して取る（順方向 p → p + D(p) の逆を固定点反復で解く）
export function renderFrame(src: Source, regions: Region[], mode: Mode, fr: SimFrame, W: number, H: number, pad: number): ImageData {
  const img = new ImageData(W, H), d = img.data, sd = src.data, sw = src.w, sh = src.h;
  const Rs = regions.map((r, i) => prepRegion(r, fr.rs[i])).filter((R) => R.dx || R.dy || R.s);
  const pixel = mode === "pixel";
  for (let oy = 0; oy < H; oy++) {
    for (let ox = 0; ox < W; ox++) {
      const qx = ox + 0.5 - pad - fr.bx, qy = oy + 0.5 - pad - fr.by;
      let px = qx, py = qy;
      let hit = false;
      for (const R of Rs) if (qx >= R.x0 && qx <= R.x1 && qy >= R.y0 && qy <= R.y1) { hit = true; break; }
      if (hit) {
        for (let it = 0; it < 16; it++) {
          let Dx = 0, Dy = 0;
          for (const R of Rs) {
            if (px < R.x0 || px > R.x1 || py < R.y0 || py > R.y1) continue;
            const w = weightAt(R, px, py);
            if (w > 0) { Dx += w * (R.dx + R.s * (px - R.cx)); Dy += w * (R.dy + R.s * (py - R.cy)); }
          }
          const nx = qx - Dx, ny = qy - Dy;
          const done = Math.abs(nx - px) + Math.abs(ny - py) < 1e-3;
          px = nx; py = ny;
          if (done) break;
        }
      }
      const o = (oy * W + ox) * 4;
      if (pixel) {
        const ix = Math.floor(px), iy = Math.floor(py);
        if (ix < 0 || iy < 0 || ix >= sw || iy >= sh) continue;
        const i = (iy * sw + ix) * 4;
        d[o] = sd[i]; d[o + 1] = sd[i + 1]; d[o + 2] = sd[i + 2]; d[o + 3] = sd[i + 3];
      } else {
        // バイリニア（アルファ乗算済みで混ぜてふちの黒ずみを防ぐ）
        const fx = px - 0.5, fy = py - 0.5, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
        let r = 0, g = 0, b = 0, a = 0;
        for (let k = 0; k < 4; k++) {
          const xx = x0 + (k & 1), yy = y0 + (k >> 1);
          if (xx < 0 || yy < 0 || xx >= sw || yy >= sh) continue;
          const wgt = ((k & 1) ? tx : 1 - tx) * ((k >> 1) ? ty : 1 - ty);
          const i = (yy * sw + xx) * 4, al = sd[i + 3] * wgt;
          r += sd[i] * al; g += sd[i + 1] * al; b += sd[i + 2] * al; a += al;
        }
        if (a <= 0) continue;
        d[o] = r / a; d[o + 1] = g / a; d[o + 2] = b / a; d[o + 3] = a;
      }
    }
  }
  return img;
}
