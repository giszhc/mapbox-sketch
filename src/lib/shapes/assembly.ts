/* =====================================================================
 * shapes/assembly.ts —— 内置类型：AssemblyShape「集结地标注」。
 *
 * ★★ 这个形状**不是自己发明的**：几何逐行照搬标绘库 mapbox-plot 的
 *   `src/gispace/plot/GatheringPlace.js`（＝ openlayers-plot 的「聚集地」
 *   `P.PlotTypes.GATHERING_PLACE`，github.com/giszhc/mapbox-plot）。
 *   用户 2026-09-17 的原话：「我是就是这个里面的聚集地交互效果」。
 *   —— 所以下面所有常量、算式、退化分支、甚至「先补齐 6 个点再算 4 段贝塞尔」
 *   这种绕法，都**不要**按自己的审美重写；改了就跟参考实现逐点对不上，
 *   `test/shapes-assembly.spec.ts` 里的金标准用例会红。
 *
 * ⚠️ 前两版都是「我以为」的形状，都被否了，留个记录免得再走一遍：
 *   ① 等宽弯曲带（胶囊）：两条平行直边，看着是香肠，不是面；
 *   ② 自造的不对称半宽「腰子面」：形状像那么回事，但点选语义、预览时机、
 *      腰点的作用全跟参考实现不一样 —— 用户要的是「一样」，不是「差不多」。
 *
 * ## 原版算法在做什么（照抄过来的那份）
 *
 * 1. 输入 `[p0, p1, p2]`；只有 2 个点时**先合成第三点**（这正是「第一击之后
 *    鼠标一动就冒出一整块面」的来历）：
 *      `mid = (p0 + p1) / 2`，`d = |p0 → mid| / 0.9`，
 *      `p2 = 第三点(p0, mid, HALF_PI, d, 顺时针)`
 *    —— 从中点出发、垂直于 p0→p1 往外挑 `|p0p1| / 1.8`，所以光标离得越远面越大，
 *    而形状**立刻**就是完整的一块面，不是「先一条线再长出来」。
 * 2. `mid2 = (p0 + p2) / 2`，把序列补成 `[p0, p1, p2, mid2, p0, p1]` —— 绕一圈闭环。
 * 3. 对每个连续三元组求**双切线控制点**（`getBisectorNormals`，`t = 0.4`）：
 *    控制柄方向取「角平分线方向的法线」，长度取本段弦长的 `t` 倍。
 *    四条边、每条边两个控制柄 ⇒ 8 个控制点；把数组**整体错位一位**，
 *    让它跟「每段自己的两个控制柄」对上（原版 `normals = [last, ...rest]`）。
 * 4. 逐段走三次贝塞尔 `pnt1 → (c1, c2) → pnt2`，四段拼成一条闭合光滑曲线。
 *    曲线上**一定经过** `p0`、`p1`、`p2`、`mid2` 四个锚点。
 *
 * ## 交互（也照原版）
 *
 * | 动作 | 形状 |
 * |---|---|
 * | 第一击 | 无（原版 `pnts.length < 2` 直接 return） |
 * | 移动鼠标 | `[p0, 光标]` → **合成第三点** → 一整块面立刻出现 |
 * | 第二击 | `p1` 落地，形状不变（此刻光标还压在 p1 上） |
 * | 移动鼠标 | `[p0, p1, 光标]` → 光标当**第三点**，面跟着光标的方位变形 |
 * | 第三击 | 满 3 点 + `autoCommit` ⇒ 定稿退出（编辑时拖三个锚点改形状） |
 *
 * ★ **y 轴要取反**：原版跑在地理坐标（lng/lat，y 向上），本引擎跑在**屏幕坐标**
 *   （y 向下）。所以 `_blob()` 进门时 `y = -y`、出门时再取回来，等价于「把屏幕点
 *   当成地理点喂给原版」。
 *   ★ 实测（2026-09-17）：这一步**只对两击阶段有影响**。三点那一支里，算法对
 *     y 取反是**对称的**（`M∘F∘M = F`：控制柄那两侧的 `isClockWise` 判据跟着一起
 *     翻了，正好抵消），取不取反画出来一模一样；但两击阶段合成的第三点走的是
 *     `getThirdPoint(..., clockWise = true)` —— 那个 `true` 是写死的，不跟着手性走，
 *     于是不取反的话第三点会挑到**对面**去（光标往东，面却鼓向北边）。
 *     `test/shapes-assembly.spec.ts` 的 `two` 金标准就钉在这儿。
 *     下面统一按地理坐标那一套走，两击/三击用同一条通道，省得两种口径混着。
 * ★ **采样密度可以改**：`FITTING_COUNT` 原版是 100、这里是 24。采样点都落在
 *   同一条曲线上，只影响点数不影响形状（金标准也用 24 生成，逐点对得上）。
 * ★ **顶点圆点不要在这里画**（见 AGENTS 4 节；绘制中的落点除外，原版也画）。
 * ===================================================================== */
import { distToPolyline, fmtM, gdM, pointInRing } from '../math';
import { drawDot } from '../paint';
import { MapboxSketch } from '../sketch';
import { toPlane } from '../ground-frame';
import { MapboxShapeType } from '../sketch-shape-type';
import type { CfgKey, DrawSession, LngLat, ScreenPoint, Shape } from '../types';

/**
 * 双切线控制柄相对**本段弦长**的比例 —— 原版 `GatheringPlace` 构造函数里的
 * `this.t = 0.4`。越小角越尖、越大鼓得越圆。
 */
const BISECTOR_T = 0.4;

/**
 * 每段三次贝塞尔的采样段数。原版 `P.Constants.FITTING_COUNT = 100`
 * （4 段 ⇒ 412 个点，每帧重建太亏）；采样点全在同一条曲线上，24 段肉眼无差。
 */
const FITTING_COUNT = 24;

/**
 * 判「三点共线 / 有点重合」的容差 —— 原版 `P.Constants.ZERO_TOLERANCE`。
 * 比的是两个**单位向量之和**的模（无量纲，与坐标尺度无关），走退化分支。
 */
const ZERO_TOLERANCE = 1e-4;

/**
 * 两击阶段合成第三点用的系数 —— 原版写死的 `distance(pnts[0], mid) / 0.9`，
 * 等价于「挑出 `|p0p1| / 1.8` 那么远」，即第三点距弦 `0.5556 × 弦长`。
 */
const THIRD_POINT_K = 0.9;

/**
 * 两点几乎重合时不成形(px)。原版这个判据在 `PlotDraw.mapMouseMoveHandler` 里
 * （`distance(cursor, last) < ZERO_TOLERANCE` 就整个跳过）—— 那一档的
 * 1e-4 是**经纬度**，搬到像素上没意义，这里补一个像素口径的阈值：
 * 光标还压在上一个落点上时不画，免得 `azimuth` 除零变 NaN 闪一下。
 */
const MIN_SPAN_PX = 0.5;

/** 预览虚线的节奏（与其它类型的手绘预览同一套观感） */
const PREVIEW_DASH: [number, number] = [3, 3];

/** 一块「聚集地面」的屏幕几何 */
interface Blob {
  /** 闭合轮廓点列（可直接连成一条 path；首尾点重合，同原版） */
  ring: ScreenPoint[];
  /**
   * 「骨架点」＝ 6 个补齐后的锚点 + 8 个贝塞尔控制柄（屏幕坐标）。
   * 四段曲线**全部落在它的凸包里**（贝塞尔曲线的凸包性质）—— `cullMargin`
   * 直接量这些点，不用把 100 多个采样点建出来。
   */
  hull: ScreenPoint[];
}

/* ------------------------------------------------------------------ *
 * 原版 PlotUtils 的逐行搬移（都是纯算式，无状态）
 * ------------------------------------------------------------------ */

const len = (a: ScreenPoint, b: ScreenPoint): number => Math.hypot(a.x - b.x, a.y - b.y);
const midOf = (a: ScreenPoint, b: ScreenPoint): ScreenPoint =>
  ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const same = (a: ScreenPoint, b: ScreenPoint, eps = 1e-9): boolean =>
  Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps;

/**
 * `P.PlotUtils.getAzimuth` —— 照搬那四个象限分支（别改成 `Math.atan2`：
 * 原版的象限判据混用了开闭区间，换成 atan2 后**退化点附近的手性会变**，
 * 形状就跟参考实现错开了）。
 */
function azimuth(s: ScreenPoint, e: ScreenPoint): number {
  const angle = Math.asin(Math.abs(e.y - s.y) / len(s, e));
  if (e.y >= s.y && e.x >= s.x) return angle + Math.PI;
  if (e.y >= s.y) return Math.PI * 2 - angle;
  if (e.x < s.x) return angle;
  return Math.PI - angle;
}

/** `P.PlotUtils.getThirdPoint`：从 `e` 出发，按 `e→s` 的方位角转 `angle` 再走 `d` */
function thirdPoint(s: ScreenPoint, e: ScreenPoint, angle: number, d: number, cw: boolean): ScreenPoint {
  const alpha = azimuth(s, e) + (cw ? angle : -angle);
  return { x: e.x + d * Math.cos(alpha), y: e.y + d * Math.sin(alpha) };
}

/** `P.PlotUtils.getNormal`：两条单位边向量之和（角平分线方向，模 ∈ [0, 2]） */
function bisector(p1: ScreenPoint, p2: ScreenPoint, p3: ScreenPoint): ScreenPoint {
  const l1 = len(p1, p2) || 1;
  const l2 = len(p3, p2) || 1;
  return { x: (p1.x - p2.x) / l1 + (p3.x - p2.x) / l2, y: (p1.y - p2.y) / l1 + (p3.y - p2.y) / l2 };
}

/** `P.PlotUtils.isClockWise` —— 原版的叉积判据（注意是 `>`，共线时算「非顺时针」） */
const isClockWise = (p1: ScreenPoint, p2: ScreenPoint, p3: ScreenPoint): boolean =>
  (p3.y - p1.y) * (p2.x - p1.x) > (p2.y - p1.y) * (p3.x - p1.x);

/**
 * `P.PlotUtils.getBisectorNormals`：给 `p2` 两侧各一个控制柄。
 * 返回 `[右, 左]` —— 右柄服务**进入** p2 的那段（长度按 `p1p2` 弦长）、
 * 左柄服务**离开** p2 的那段（长度按 `p2p3` 弦长）。
 * 角平分线退化（三点共线 / 有重合点）时退回「沿弦 `t` 倍处」。
 */
function bisectorNormals(
  t: number, p1: ScreenPoint, p2: ScreenPoint, p3: ScreenPoint,
): [ScreenPoint, ScreenPoint] {
  const n = bisector(p1, p2, p3);
  const dist = Math.hypot(n.x, n.y);
  if (dist > ZERO_TOLERANCE) {
    const ux = n.x / dist, uy = n.y / dist;
    const d1 = t * len(p1, p2);
    const d2 = t * len(p2, p3);
    return isClockWise(p1, p2, p3)
      ? [{ x: p2.x - d1 * uy, y: p2.y + d1 * ux }, { x: p2.x + d2 * uy, y: p2.y - d2 * ux }]
      : [{ x: p2.x + d1 * uy, y: p2.y - d1 * ux }, { x: p2.x - d2 * uy, y: p2.y + d2 * ux }];
  }
  return [
    { x: p2.x + t * (p1.x - p2.x), y: p2.y + t * (p1.y - p2.y) },
    { x: p2.x + t * (p3.x - p2.x), y: p2.y + t * (p3.y - p2.y) },
  ];
}

/** `P.PlotUtils.getCubicValue`：三次贝塞尔取点 */
function cubicValue(
  t: number, p0: ScreenPoint, c1: ScreenPoint, c2: ScreenPoint, p1: ScreenPoint,
): ScreenPoint {
  const s = Math.max(Math.min(t, 1), 0);
  const u = 1 - s;
  const u2 = u * u, s2 = s * s;
  return {
    x: u2 * u * p0.x + 3 * u2 * s * c1.x + 3 * u * s2 * c2.x + s2 * s * p1.x,
    y: u2 * u * p0.y + 3 * u2 * s * c1.y + 3 * u * s2 * c2.y + s2 * s * p1.y,
  };
}

/** 两点之间的地理距离（`describe` 用） */
const geoLen = (a: LngLat, b: LngLat): number => gdM(a, b);

export class AssemblyShape extends MapboxShapeType {
  get key(): string { return 'assembly'; }
  get label(): string { return '集结地标注'; }
  get minPts(): number { return 3; }
  get autoCommit(): boolean { return true; }   // 三击即成：同原版 fixPointCount = 3

  cfgKeys(): CfgKey[] { return ['showLine']; } // 轮廓可隐藏，只留淡填充

  get hint(): string {
    return '▰ 绘制<b>集结地标注</b>：单击定<b>第一点</b> → 移动鼠标立刻长出<b>面</b>'
      + ' → 单击定<b>第二点</b> → 移动鼠标把<b>第三点</b>摆到位'
      + ' → 第三次单击完成（三击即成）<br />'
      + '・三点都是<b>锚点</b>，曲线一定过它们（与「聚集地」标绘口径一致）'
      + '　・<b>Esc</b>＝取消';
  }

  /* ---------------- 几何：渲染 / 命中 / 剔除 / 预览四处共用同一份算式 ---------------- */

  /**
   * 把「已落点 [+ 光标]」算成一块闭合面；点数不够或退化时返回 `null`。
   *
   * ★ 进门先把 `y` 取反（原版跑在地理坐标 y 向上，本引擎跑在屏幕坐标 y 向下），
   *   出门再取回来 —— 不取反形状会上下镜像（细节见文件头）。
   * ★ 输入 2 个点时**先合成第三点**（原版那一步），所以「一击之后鼠标一动就有
   *   一整块面」是这里出来的，不是靠预览额外补点。
   */
  private _blob(geo: LngLat[]): Blob | null {
    if (geo.length < 2) return null;
    // ★ 顶点先换算到**地面平面**再走原版那套（手性 = 'up'，对应原来那次 y 取反），
    //   算完折回经纬、逐点投影 —— 倾斜 / 旋转时这块面跟着地面走（2026-09-18 修）。
    //   平面取的是**像素量级**（`ground-frame.ts` 里实测/公式给的每度像素数），
    //   所以下面那些绝对阈值（`MIN_SPAN_PX`）的口径与从前一致。
    const f = this.groundFrameAt(geo[0][1]);
    const base: ScreenPoint[] = toPlane(geo, f);
    let pts: ScreenPoint[];
    if (base.length === 2) {
      const m = midOf(base[0], base[1]);
      const d = len(base[0], m) / THIRD_POINT_K;
      if (!(d > MIN_SPAN_PX) || same(base[0], base[1])) return null;  // 光标还压在落点上
      pts = [base[0], thirdPoint(base[0], m, Math.PI / 2, d, true), base[1]];
    } else {
      pts = base.slice(0, 3);
    }
    if (same(pts[0], pts[1]) || same(pts[0], pts[2]) || same(pts[1], pts[2])) return null;

    // 补齐成闭环：p0 → p1 → p2 → mid(p0, p2) → p0
    const loop = pts.concat([midOf(pts[0], pts[2]), pts[0], pts[1]]);

    // 每个三元组出两个控制柄，再整体错位一位，让它跟「每段自己的控制柄」对上
    let normals: ScreenPoint[] = [];
    for (let i = 0; i < loop.length - 2; i++) {
      normals = normals.concat(bisectorNormals(BISECTOR_T, loop[i], loop[i + 1], loop[i + 2]));
    }
    const count = normals.length;
    normals = [normals[count - 1]].concat(normals.slice(0, count - 1));

    const ring: ScreenPoint[] = [];
    const controls: ScreenPoint[] = [];
    for (let i = 0; i < loop.length - 2; i++) {
      const p1 = loop[i], p2 = loop[i + 1];
      const c1 = normals[i * 2], c2 = normals[i * 2 + 1];
      controls.push(c1, c2);
      ring.push(p1);
      for (let k = 0; k <= FITTING_COUNT; k++) {
        ring.push(cubicValue(k / FITTING_COUNT, p1, c1, c2, p2));
      }
      ring.push(p2);
    }

    const finite = (p: ScreenPoint): boolean => Number.isFinite(p.x) && Number.isFinite(p.y);
    if (!ring.every(finite) || !controls.every(finite)) return null;

    // → 折回经纬、逐点投影（同一套地面平面）
    return {
      ring: this.planeToScreen(ring, f),
      hull: this.planeToScreen(loop.concat(controls), f),
    };
  }

  /** 已提交图形（存储顶点直接当锚点；绘制中走 `preview`） */
  private _blobOf(shape: Shape): Blob | null {
    const Pts = this.projectPts(shape);
    if (Pts.length < 2) return null;
    return this._blob(shape.pts);
  }

  describe(shape: Shape): string {
    const pts = shape.pts;
    // 满三点才算「成形」；两点只是绘制中途的瞬时状态（第三点还没落）
    if (pts.length < 3) return `${this.label} · ${pts.length} 点`;
    // 三个锚点之间最大的地理跨度 —— 画出来的面大致在这个尺寸上
    let span = 0;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const d = geoLen(pts[i], pts[j]);
        if (d > span) span = d;
      }
    }
    return `集结地 · 跨度 ${fmtM(span)}`;
  }

  /**
   * 曲线**画在锚点之外**：三个锚点、`mid(p0,p2)`、以及 8 个控制柄都可能跑到
   * 三点包围盒外面（贝塞尔曲线落在控制点的凸包里，所以量这些点就是上界）。
   * 用采样点量当然也行，但要为此建 100 多个点 —— `cullMargin` 每帧对每个图形
   * 都要算，不值当。算不出来时退回「线宽那一档」，写 0 会让弧顶刚出屏就被剔除。
   */
  cullMargin(shape: Shape): number {
    const lw = this.styleFor(shape).pathWidth;
    const pad = (typeof lw === 'number' && lw > 0 ? lw : 3) / 2 + 4;
    const Pts = this.projectPts(shape);
    if (Pts.length < 2) return pad;
    const g = this._blob(shape.pts);
    if (!g) return pad;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of Pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    let reach = 0;
    for (const p of g.hull) {
      const dx = Math.max(minX - p.x, 0, p.x - maxX);
      const dy = Math.max(minY - p.y, 0, p.y - maxY);
      const d = Math.hypot(dx, dy);
      if (d > reach) reach = d;
    }
    return reach + pad;
  }

  /**
   * 自定义命中：量**闭合轮廓**，不是引擎默认的「锚点连线」。
   *
   * ★ 默认规则在这里是错的：曲线的四个锚点是 `p0 / p1 / p2 / mid(p0,p2)`，
   *   而 `mid` 那个锚点**根本不在存储顶点里**，鼓出去的那一大块面也不在
   *   p0→p1→p2 折线上 —— 照默认来会出现「点在面上不中、点在面外反而中」。
   * ★ 点在环内即命中；环外再按「贴着轮廓」放一圈容差。
   */
  hitTest(shape: Shape, x: number, y: number, Pts: ScreenPoint[], tol: number): boolean | undefined {
    if (Pts.length < 2) return undefined;        // 形态超出预期 → 交回默认规则
    const g = this._blob(shape.pts);
    if (!g) return distToPolyline(x, y, Pts, false) <= tol;
    if (pointInRing(x, y, g.ring)) return true;
    return distToPolyline(x, y, g.ring, true) <= tol;
  }

  /** 已提交的形状：一块闭合的聚集地面（淡填充 + 轮廓；showLine 关掉就只留填充） */
  render(shape: Shape): void {
    const ctx = this.ctx;
    const g = this._blobOf(shape);
    if (!ctx || !g) return;
    const st = this.styleFor(shape);

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(g.ring[0].x, g.ring[0].y);
    for (let i = 1; i < g.ring.length; i++) ctx.lineTo(g.ring[i].x, g.ring[i].y);
    ctx.closePath();
    ctx.fillStyle = st.polygonFill;
    ctx.fill();
    if (shape.cfg.showLine !== false) {
      // ★ 描边用 pathColor：悬停高亮染的正是它（见基类 styleFor）
      ctx.globalAlpha = st.lineOpacity;
      ctx.lineWidth = st.pathWidth;
      ctx.strokeStyle = st.pathColor;
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * 手绘预览：**与落地同一套几何**（原版就是这么做的 —— 每帧把
   * 「已落点 + 光标」整体喂给 `generate()` 重算），所以预览长什么样、落下就是什么样。
   *
   * ★ 一击未落时不画（原版 `pnts.length < 2` 直接 return）；
   * ★ 光标还压在上一个落点上时不画 —— 原版在 `mapMouseMoveHandler` 里
   *   `distance(cursor, last) < ZERO_TOLERANCE` 就整个跳过，否则 `azimuth`
   *   会除零，第一帧闪一个 NaN 形状。
   */
  preview(draw: DrawSession): void {
    const ctx = this.ctx, st = this.style;
    if (!ctx || !st) return;

    const geo = draw.pts.concat(draw.cursor ? [draw.cursor] : []);
    if (!draw.pts.length) return;                     // 一击未落：不画
    const landed = draw.pts.map((p) => this.project(p));   // 只用来画落点圆点

    const cur = draw.cursor ? this.project(draw.cursor) : null;
    let g: Blob | null = null;
    if (cur) {
      const last = landed[landed.length - 1];
      if (Math.hypot(cur.x - last.x, cur.y - last.y) > MIN_SPAN_PX) {
        g = this._blob(geo);                          // ★ 几何吃**经纬点列**（内部走地面平面）
      }
    }

    ctx.save();
    ctx.globalAlpha = 0.6;
    if (g) {
      ctx.beginPath();
      ctx.moveTo(g.ring[0].x, g.ring[0].y);
      for (let i = 1; i < g.ring.length; i++) ctx.lineTo(g.ring[i].x, g.ring[i].y);
      ctx.closePath();
      ctx.fillStyle = st.previewFill;
      ctx.fill();
      ctx.setLineDash(PREVIEW_DASH);
      ctx.lineWidth = 3;
      ctx.strokeStyle = st.previewColor;
      ctx.stroke();
    }
    // 已落点 + 光标各点一下（`restore` 一并复位 lineDash）
    landed.forEach((p) => drawDot(ctx, p.x, p.y, 5, st.previewColor));
    if (cur) drawDot(ctx, cur.x, cur.y, 5, st.previewColor);
    ctx.restore();
  }
}

/* 自注册：import 本文件即把类型收进静态注册表 */
MapboxSketch.registerType(AssemblyShape);
