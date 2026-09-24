/* =====================================================================
 * math.ts —— 纯数学 / 几何 / 格式化工具（无 DOM、无状态、无副作用）。
 *
 * 从改造前的 mapbox-draw-math.js（IIFE 全局脚本）平移而来。
 * 以命名空间形式从包出口导出（`math.buildArc`），自定义图形类型可自由复用。
 * ===================================================================== */
import type { LngLat, ScreenPoint } from './types';

/** canvas 统一使用的字体族（中文字体优先） */
export const FONT_FAMILY = '"PingFang SC","Microsoft YaHei",sans-serif';

/**
 * 拼出统一字体字符串，如 `400 15px "PingFang SC",...`
 *
 * ★ 默认字重 400 = （正常，不加粗）。标注文字本来就带白描边，已经足够把字从底图上拎出来；
 *   再加粗就成了糊成一块的粗黑字，压在卫星影像上反而更难看。要加粗只能显式传 weight，
 *   库内所有调用走的都是这个默认值 —— 也就是说，**标注文字一律不加粗**。
 */
export function cssFont(size: number, weight: number | string = 400): string {
  return `${weight} ${size}px ${FONT_FAMILY}`;
}

/** 钳制数值到 [a, b] */
export function clamp(v: number, a: number, b: number): number {
  return v < a ? a : (v > b ? b : v);
}

/** 平滑采样的默认步长（米）：相邻采样点的间距下限，也是「采样有多细」的兜底口径 */
export const SMOOTH_STEP_M = 30;

/**
 * 平滑该用多细的采样步长（米）——按**屏幕**定，而不是按经纬度定。
 *
 * 从前是写死的 30m，与缩放无关：一条 20km 的路在缩到全览时，那些采样点全都挤在
 * 几十个像素里，一帧白白多画几百个顶点（实测 300 条路径文字 65ms/帧、32 万次
 * canvas 调用，其中九成以上是这么来的）。改成「一个采样点不细于 2 屏幕像素」：
 * 缩小时自然变粗、放大时退回 30m 下限，**放大后与从前逐点一致**。
 *
 * 比例尺用图形自己的顶点量：取投影后最长的那一段，拿它的像素长比测地长。
 * 不走 `map.getZoom()` 那套公式 —— 那要假定瓦片尺寸等投影细节；而 `project`
 * 出来的就是画布上真实的像素，这个比值天然自洽，换了地图实现也不会错。
 * 顶点几乎重合时（像素长趋近 0）比值会炸，此时退回默认步长。
 *
 * ★ 放在 math.ts 而不是某个类型文件里：这是一个**纯换算**，凡是要画平滑折线的
 *   类型（路径文字、曲线标注…）都该用同一份 —— 各抄一份迟早跑偏成「同一条折线，
 *   两个类型平滑出来的粗细不一样」。
 *
 * @param geo 存储顶点（经纬度）
 * @param pts 同一批顶点**已投影**的屏幕坐标（顺序一一对应）
 */
export function smoothStepM(geo: LngLat[], pts: ScreenPoint[]): number {
  let px = 0;                        // 最长那一段的像素长
  let m = 0;                         // 同一段的测地长
  for (let i = 1; i < pts.length && i < geo.length; i++) {
    const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (d > px) { px = d; m = gdM(geo[i - 1], geo[i]); }
  }
  return px > 0.5 ? Math.max(SMOOTH_STEP_M, (m / px) * 2) : SMOOTH_STEP_M;
}

/**
 * Catmull-Rom 样条平滑：折线 → 圆滑连续曲线（等距采样折点）。
 * 折线顶点越多越平滑；采样在经纬度空间完成，任意缩放都不失真。
 *
 * 步长交给调用方：**曲线要多细是渲染期的事，不是几何本身的性质**。同一个图形
 * 缩小时可以取粗些（那些采样点在屏幕上本来也挨不到一个像素），放大时再取细。
 * @param pts   顶点 `[ [lng,lat], ... ]`
 * @param stepM 采样步长（米），缺省 {@link SMOOTH_STEP_M}
 * @returns 平滑后的稠密折点
 */
export function smoothPolyline(pts: LngLat[], stepM: number = SMOOTH_STEP_M): LngLat[] {
  const out: LngLat[] = [];
  const step = stepM > 0 ? stepM : SMOOTH_STEP_M;
  const P = pts.map(([x, y]) => ({ x, y }));
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[i - 1] || P[i];
    const p1 = P[i];
    const p2 = P[i + 1];
    const p3 = P[i + 2] || P[i + 1];
    // 该段每 step 米一个采样点（纬度方向 1°≈110.5km，经度乘 cos 校正）
    const dLat = (p2.y - p1.y) * 110540;
    const dLng = (p2.x - p1.x) * 111320 * Math.cos((p1.y * Math.PI) / 180);
    const div = Math.max(1, Math.ceil(Math.hypot(dLat, dLng) / step));
    for (let j = 0; j < div; j++) {
      const t = j / div;
      const t2 = t * t, t3 = t2 * t;
      const x = 0.5 * (2 * p1.x
        + (-p0.x + p2.x) * t
        + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2
        + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
      const y = 0.5 * (2 * p1.y
        + (-p0.y + p2.y) * t
        + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2
        + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
      out.push([x, y]);
    }
  }
  const last = P[P.length - 1];
  out.push([last.x, last.y]);
  return out;
}

/** 两点间近似大圆距离（米）——路线尺度小，等距近似足够 */
export function gdM(a: LngLat, b: LngLat): number {
  const R = 6371000;
  const r1 = (a[1] * Math.PI) / 180, r2 = (b[1] * Math.PI) / 180;
  const dLat = (r2 - r1) * R;
  const dLng = ((b[0] - a[0]) * Math.PI) / 180 * Math.cos((r1 + r2) / 2) * R;
  return Math.hypot(dLat, dLng);
}

/**
 * 经纬度 → 以 `ref` 为原点的**局部等矩形平面**坐标（米；x = 东，y = 北）。
 *
 * `gdM` 给的是「两点距离」，量不出**方向** —— 而扇形标注要的正是「两条边的夹角」：
 * 把两条边都换算到这个平面里再取 `atan2` 相减，夹角与地图的 bearing 无关（bearing
 * 只是把这个平面整体转一下，两条边的夹角不变），于是 `describe` 不依赖地图是否就绪。
 * 演示尺度（几百米~几公里）下这个近似的误差可以忽略。
 *
 * ★ `polyAreaM2` 里手写着同一段换算：它在面积标注的**每帧热路径**上，那里内联着
 *   省掉每点一次对象分配；本函数服务的是「每次 describe / 每次落点才调一次」的场景。
 */
export function localM(ref: LngLat, p: LngLat): { x: number; y: number } {
  const cos = Math.cos((ref[1] * Math.PI) / 180);
  return { x: (p[0] - ref[0]) * 111320 * cos, y: (p[1] - ref[1]) * 110540 };
}

/** 米 → 可读字符串，统一保留 2 位小数 */
export function fmtM(m: number): string {
  if (m < 1000) return m.toFixed(2) + 'm';
  return (m / 1000).toFixed(2) + 'km';
}

/** 面积(㎡) → 可读字符串，统一保留 2 位小数 */
export function fmtArea(m2: number): string {
  if (!isFinite(m2) || m2 < 0) return '-';
  if (m2 < 10000) return m2.toFixed(2) + ' m²';
  return (m2 / 1e6).toFixed(2) + ' km²';
}

/**
 * 多边形面积（㎡）：以「首点为原点的平面等矩形」近似，演示尺度足够。
 * @param pts 未闭合顶点（>=3）
 */
export function polyAreaM2(pts: LngLat[]): number {
  if (pts.length < 3) return 0;
  const cosRef = Math.cos((pts[0][1] * Math.PI) / 180);
  let a2 = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    const x1 = (p[0] - pts[0][0]) * 111320 * cosRef, y1 = (p[1] - pts[0][1]) * 110540;
    const x2 = (q[0] - pts[0][0]) * 111320 * cosRef, y2 = (q[1] - pts[0][1]) * 110540;
    a2 += x1 * y2 - x2 * y1;
  }
  return Math.abs(a2) / 2;
}

/**
 * 屏幕坐标多边形中心（面积加权，落在面内；退化时退化为顶点均值）。
 * @param scr 投影后的顶点（无需闭合）
 */
export function screenCenter(scr: ScreenPoint[]): ScreenPoint {
  const n = scr.length;
  let A = 0, cx = 0, cy = 0;
  for (let i = 0; i < n; i++) {
    const p = scr[i], q = scr[(i + 1) % n];
    const cr = p.x * q.y - q.x * p.y;
    A += cr; cx += (p.x + q.x) * cr; cy += (p.y + q.y) * cr;
  }
  if (Math.abs(A) < 1e-6) {
    let sx = 0, sy = 0;
    for (const p of scr) { sx += p.x; sy += p.y; }
    return { x: sx / n, y: sy / n };
  }
  A /= 2;
  return { x: cx / (6 * A), y: cy / (6 * A) };
}

/* ================================================================
 * 命中检测用的距离/包含判定
 * （原为主类私有方法，抽出来给各类型共用：视口剔除与 hitTest 都要用）
 * ================================================================ */

/** 点到线段的距离（px 平面） */
export function distToSeg(
  px: number, py: number,
  x1: number, y1: number, x2: number, y2: number,
): number {
  const dx = x2 - x1, dy = y2 - y1;
  const L2 = dx * dx + dy * dy;
  let t = L2 ? ((px - x1) * dx + (py - y1) * dy) / L2 : 0;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/**
 * 线段上离 (px,py) **最近的那个点**，连同它的距离。
 *
 * 与 {@link distToSeg} 是同一个投影公式，但除了距离还要把点本身交出来 ——
 * 吸附需要知道「吸到哪」，光有距离不够。零长线段退化成端点。
 *
 * 之所以不把 distToSeg 改成调这个函数、让它只当一层薄封装：distToSeg 在
 * 命中检测的热路径上（每个图形的每段每帧都要算），凭空多一次对象分配不值得。
 * 两者并存，各取所需。
 */
export function nearestOnSeg(
  px: number, py: number,
  x1: number, y1: number, x2: number, y2: number,
): { x: number; y: number; d: number } {
  const dx = x2 - x1, dy = y2 - y1;
  const L2 = dx * dx + dy * dy;
  let t = L2 ? ((px - x1) * dx + (py - y1) * dy) / L2 : 0;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  const x = x1 + t * dx, y = y1 + t * dy;
  return { x, y, d: Math.hypot(px - x, py - y) };
}

/**
 * 点到折线（或闭合环）的最短距离。
 * @param closed true 时把末点与首点也连成一段
 */
export function distToPolyline(
  px: number, py: number, pts: ScreenPoint[], closed = false,
): number {
  const n = closed ? pts.length : pts.length - 1;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const d = distToSeg(px, py, a.x, a.y, b.x, b.y);
    if (d < best) best = d;
  }
  return best;
}

/** 射线法判断点是否在（屏幕坐标）多边形内部 */
export function pointInRing(px: number, py: number, pts: ScreenPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    const cross = ((a.y > py) !== (b.y > py)) &&
      (px < (b.x - a.x) * (py - a.y) / (b.y - a.y) + a.x);
    if (cross) inside = !inside;
  }
  return inside;
}

/** 一系列屏幕点的包围盒；空数组返回 null */
export function bboxOf(pts: ScreenPoint[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (!pts.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/* ================================================================
 * 弧长参数化
 * ================================================================ */

/** 折线中的一段（含其起点的切线角） */
export interface ArcSeg {
  x0: number;
  y0: number;
  dx: number;
  dy: number;
  len: number;
  /** 该段切线角（弧度） */
  ang: number;
}

/** 弧上一点：位置 + 该处切线角 */
export interface ArcPoint {
  x: number;
  y: number;
  /** 切线角（弧度），贴线旋转文字用 */
  ang: number;
}

/** 弧长参数化结果 */
export interface Arc {
  segs: ArcSeg[];
  /** cum[i] = 前 i 段累计长度 */
  cum: number[];
  /** 总弧长 */
  total: number;
  /** 按弧长 s 取点（自动钳制到 [0,total]） */
  at(s: number): ArcPoint;
}

/**
 * 把一串【屏幕坐标点】做成「弧长参数化」结构：
 * `segs` / `cum` / `total` + `at(s)`（二分定位 → 位置 + 切线角）。
 * @param P 投影后的点列（>=2）；无法构成有效弧长（总长为 0）时返回 null
 */
export function buildArc(P: ScreenPoint[]): Arc | null {
  const segs: ArcSeg[] = [], cum = [0];
  let total = 0;
  for (let i = 0; i < P.length - 1; i++) {
    const a = P[i], b = P[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    segs.push({ x0: a.x, y0: a.y, dx, dy, len, ang: Math.atan2(dy, dx) });
    total += len;
    cum.push(total);
  }
  if (!segs.length || total <= 0) return null;
  return {
    segs, cum, total,
    at(s: number): ArcPoint {
      const sc = clamp(s, 0, total);
      let lo = 0, hi = segs.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cum[mid + 1] < sc) lo = mid + 1; else hi = mid;
      }
      const sg = segs[lo];
      const t = clamp((sc - cum[lo]) / sg.len, 0, 1);
      return { x: sg.x0 + sg.dx * t, y: sg.y0 + sg.dy * t, ang: sg.ang };
    },
  };
}

/* ================================================================
 * 折线等距偏置（平行曲线）
 * ================================================================ */

/** 斜接长度的上限倍数：角尖到 `1/cos(半角)` 会飞出去，夹住它 */
const MITER_MAX = 4;

/**
 * 折线的**等距偏置**：把每个顶点沿「两侧相邻段的角平分线」挪 `off` 像素，
 * 得到一条与原折线处处相距 `off` 的平行折线。
 *
 * 给「双线」类的符号用（管道 / 光缆：主线两侧各一条细线；也可以拿去画平行带）。
 * 正负号的口径与 `paint.upNormal` 一致：**正值往屏幕「上侧」偏**（切线顺时针转 90°），
 * 负值往下侧；所以画对称的双线就是 `off` 与 `-off` 各来一次。
 *
 * ★ 逐个顶点挪「它自己那一段的法线」是错的：拐角内侧会叠、外侧会裂开一道口子。
 *   这里走的是**斜接（miter）**——顶点处沿角平分线走 `off / cos(半角)`，两侧的
 *   平行线在拐角处仍严丝合缝（与 canvas 的 `lineJoin: 'miter'` 同一套算法）。
 * ★ 尖角上限 `MITER_MAX`：`1/cos(半角)` 在 180° 折返（原路折回）附近发散，
 *   不夹的话那一个顶点会飞出去几百像素、把包围盒撑爆。夹住之后尖角会被削平一小截，
 *   而双线符号在这个量级上根本看不出来（同 `paint.roundRectPath` 夹半径的口径）。
 * ★ 退化情形（顶点重合 / 整条折线缩成一点 / `off` 不是有限数）一律**原样返回**，
 *   不做「猜一个方向」——偏不出来时画出来的东西跟原线重合，比画歪强。
 *
 * @param pts 屏幕坐标点列（>= 2）
 * @param off 偏移量(px)。正 = 屏幕「上侧」；0 / 非有限数 = 原样返回
 * @returns 偏置后的新点列。**连点都是新对象**（不是共享引用）—— 调用方随便改，
 *          不会反过来污染传进来的那一串
 */
export function offsetPolyline(pts: ScreenPoint[], off: number): ScreenPoint[] {
  const n = pts.length;
  const out: ScreenPoint[] = [];
  // ★ 退化时也**逐点新建**：`pts.slice()` 是浅拷贝，里面还是同一批对象，
  //   调用方一改就改到了入参上（那正是「偏不出来」时最容易踩的一脚）
  if (n < 2 || !Number.isFinite(off) || off === 0) return pts.map((p) => ({ x: p.x, y: p.y }));

  /** 第 `si` 段（`pts[si]` → `pts[si+1]`）的**上侧**单位法线；该段退化成一个点时返回 null */
  const segNormal = (si: number): ScreenPoint | null => {
    if (si < 0 || si > n - 2) return null;
    const dx = pts[si + 1].x - pts[si].x, dy = pts[si + 1].y - pts[si].y;
    const len = Math.hypot(dx, dy);
    if (!(len > 1e-9)) return null;
    return { x: dy / len, y: -dx / len };          // 与 paint.upNormal 同一个手性
  };

  for (let i = 0; i < n; i++) {
    // 端点只有一侧有段，自然只用一个法线；内部顶点取前后两段
    const na = segNormal(i - 1) || segNormal(i);
    const nb = segNormal(i) || segNormal(i - 1);
    if (!na || !nb) { out.push({ x: pts[i].x, y: pts[i].y }); continue; }

    let mx = na.x + nb.x, my = na.y + nb.y;
    const ml = Math.hypot(mx, my);
    let k = 1;                                      // 斜接系数 = 1 / cos(半角)
    if (ml > 1e-9) {
      mx /= ml; my /= ml;
      k = 1 / Math.max(mx * na.x + my * na.y, 1 / MITER_MAX);
    } else {
      mx = na.x; my = na.y;                         // 180° 折返：退回单段法线
    }
    out.push({ x: pts[i].x + mx * off * k, y: pts[i].y + my * off * k });
  }
  return out;
}

/* ================================================================
 * 折线抽稀（自由手绘用）
 * ================================================================ */

/**
 * Douglas-Peucker 抽稀：把一条点列里「偏不到 `tol` 之外」的点全丢掉，首末点必留。
 *
 * 给**自由手绘**用：描摹时引擎按屏幕间距采样（`sketch.ts` 的
 * `FREEHAND_MIN_PX`），保证不漏掉手上的动作；可一条随手画的线本来就带几百个点，
 * 其中绝大多数落在一条近似直线上 —— 它们既让存档变大，也让编辑态拖手柄时
 * 手柄糊成一片。抽稀是「别存一堆没用的点」，采样是「别漏掉动作」，两件事。
 *
 * ★ 容差是**屏幕像素**、不是米：抽稀的目的是「看起来还是那条线」，那就得按
 *   眼睛的量纲判。代价是同一个笔迹在不同缩放级下抽出来的顶点数不同 —— 这正是
 *   屏幕量纲该有的样子（同 `GeomState` 的旋转角度 / 尺寸）。
 *
 * ★ 判据用「点到**首末连线**的距离」，不裁到线段内。这是 Douglas-Peucker 的
 *   原始形式，对**闭合环**（自由面）也更稳：末段与首段之间那一小段回折不会被
 *   当成「离得很远」而整片保留。
 *
 * @param pts 屏幕点列（少于 3 个点原样返回 —— 没有可丢的中间点）
 * @param tol 允许的最大偏离（px）；`<= 0` 原样返回
 */
export function simplifyPolyline(pts: ScreenPoint[], tol = 1.5): ScreenPoint[] {
  const n = pts.length;
  if (n <= 2 || !(tol > 0)) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  // 待分段的区间（用栈而不是递归：一条随手画的线可能有几千个点，
  // 递归在退化输入下会叠得很深）
  const stack: number[] = [0, n - 1];
  while (stack.length) {
    const b = stack.pop() as number;
    const a = stack.pop() as number;
    if (b - a < 2) continue;                       // 中间没有可丢的点
    const ax = pts[a].x, ay = pts[a].y;
    const dx = pts[b].x - ax, dy = pts[b].y - ay;
    const len = Math.hypot(dx, dy);
    let worst = -1, wi = -1;
    for (let i = a + 1; i < b; i++) {
      const p = pts[i];
      // 点到直线 ab 的距离；a、b 重合时退化成点距（否则会除以 0）
      const d = len > 0
        ? Math.abs(dy * p.x - dx * p.y + pts[b].x * ay - pts[b].y * ax) / len
        : Math.hypot(p.x - ax, p.y - ay);
      if (d > worst) { worst = d; wi = i; }
    }
    if (worst > tol) { keep[wi] = 1; stack.push(a, wi, wi, b); }
  }
  const out: ScreenPoint[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

