/* =====================================================================
 * shapes/closed-curve.ts —— 内置类型：ClosedCurveShape「闭合曲面标注」。
 *
 * ★★ 几何**照搬**标绘库 mapbox-plot 的 `src/gispace/plot/ClosedCurve.js`
 *   （＝ openlayers-plot 的 `P.PlotTypes.CLOSED_CURVE`，那个 demo 的按钮中文名
 *   叫「曲线面」）。和「集结地标注」是同一个双切线族，区别只有两点：
 *     · 两个控制柄的比例 `t = 0.3`（集结地是 0.4）—— 拐角收得更紧；
 *     · **不做任何取点合成**，直接把用户点的那一串点绕成闭环。
 *
 * ## 原版算法
 *
 * 1. 点数 < 2 ⇒ 什么都不画；**正好 2 个点** ⇒ 原样输出那两点（退化分支，画不成面）；
 * 2. `pnts = points + [points[0], points[1]]` —— 把首两个点补到尾巴上，于是
 *    「连续三元组」恰好绕一整圈：(p0,p1,p2) … (p_{n-1},p0,p1)；
 * 3. 每个三元组求**双切线控制点**（`getBisectorNormals`，`t = 0.3`）：
 *    方向取角平分线的法线、长度取本段弦长的 `t` 倍；n 段 ×2 = 2n 个控制点，
 *    再把数组**整体错位一位**（原版 `normals = [last, ...rest]`），
 *    让每个控制点对上「它真正服务的那一段」；
 * 4. 逐段走三次贝塞尔，n 段拼成一条**闭合**光滑曲线 ——
 *    曲线上一定经过用户点的每一个点。
 *
 * ## 交互（原版没有再设 `fixPointCount`，走的是通用那一套）
 *
 * 单击依次落点 → **双击 / 回车**完成（同「多边形 / 曲线标注」）→ 右键撤销上一点。
 * 第一击之后要**动一下鼠标**才看得到东西：只有 2 个点时原版给的是那两点连成的
 * 一条退化线段（画不成面），第 3 个点一落才长成一块面。
 *
 * ★ **不用像「集结地」那样翻 y 轴**：那条链路里唯一的「手性不对称」是
 *   `getThirdPoint(..., clockWise = true)`（写死的常量），本类型压根没有那个分支；
 *   其余全是距离 / 法线 / 三次插值，对 `y → −y` 是**对称的**（`M∘F∘M = F`）——
 *   取不取反画出来一模一样，所以这里直接按屏幕坐标算，金标准也是同口径生成的。
 * ★ **存储顶点＝用户点的那几个点**（平滑只在渲染期做，不写回 `pts`）——
 *   于是编辑态拖的还是那几个点，拖完曲线实时跟着变（同「曲线标注」的口径）。
 * ★ **顶点圆点不要在这里画**（见 AGENTS 4 节）；绘制中的落点除外（原版也画）。
 * ===================================================================== */
import { distToPolyline, pointInRing } from '../math';
import { drawDot } from '../paint';
import { MapboxSketch } from '../sketch';
import { toPlane } from '../ground-frame';
import { MapboxShapeType } from '../sketch-shape-type';
import type { LngLat, CfgKey, DrawSession, ScreenPoint, Shape } from '../types';

/**
 * 双切线控制柄相对**本段弦长**的比例 —— 原版 `ClosedCurve` 构造函数里的
 * `this.t = 0.3`（「集结地」是 0.4，所以那个更鼓、这个拐角更贴）。
 */
const BISECTOR_T = 0.3;

/**
 * 每段三次贝塞尔的采样段数。原版 `P.Constants.FITTING_COUNT = 100`
 * （n 段 ⇒ 每段 103 个点，点多了每帧重建太亏）；采样点全在同一条曲线上，
 * 24 段肉眼无差，金标准也用 24 生成、逐点对得上。
 */
const FITTING_COUNT = 24;

/**
 * 判「三点共线 / 有重合点」的容差 —— 原版 `P.Constants.ZERO_TOLERANCE`。
 * 比的是两个**单位向量之和**的模（无量纲，与坐标尺度无关），走退化分支。
 */
const ZERO_TOLERANCE = 1e-4;

/** 预览虚线的节奏（与其它类型的手绘预览同一套观感） */
const PREVIEW_DASH: [number, number] = [3, 3];

/** 一条闭合曲面的屏幕几何 */
interface Ring {
  /** 闭合轮廓点列（可直接连成一条 path；首尾点重合，同原版） */
  ring: ScreenPoint[];
  /**
   * 「骨架点」＝补齐后的闭环锚点 + 全部控制柄（屏幕坐标）。曲线完全落在它们的
   * 凸包里（贝塞尔曲线的凸包性质），`cullMargin` 量它就不必建上百个采样点。
   */
  hull: ScreenPoint[];
}

/* ------------------------------------------------------------------ *
 * 原版 PlotUtils 的逐行搬移（与 shapes/assembly.ts 同源，各自独立一份：
 * 两个类型的 t 不同，且这两处都不该被对方的调参连累）
 * ------------------------------------------------------------------ */

const len = (a: ScreenPoint, b: ScreenPoint): number => Math.hypot(a.x - b.x, a.y - b.y);

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

export class ClosedCurveShape extends MapboxShapeType {
  get key(): string { return 'closedCurve'; }
  get label(): string { return '闭合曲面标注'; }
  get minPts(): number { return 3; }
  get closesRing(): boolean { return true; }

  cfgKeys(): CfgKey[] { return ['showLine']; } // 同其它面类：轮廓可隐藏，只留淡填充

  get hint(): string {
    return '◍ 绘制<b>闭合曲面标注</b>：单击地图依次落点，全部拐点被圆滑成一条'
      + '<b>首尾相接</b>的闭合曲线，围出一块面<br />'
      + '・<b>双击</b> 或按 <b>回车</b>＝完成（末点自动连回首点）　・<b>右键</b>＝撤销上一点'
      + '　・<b>Esc</b>＝取消<br />'
      + '・画完后选中它即可拖动各个点，曲面实时跟着变';
  }

  /* ---------------- 几何：渲染 / 命中 / 剔除 / 预览四处共用同一份算式 ---------------- */

  /**
   * 由「已落点 [+ 光标]」算出这条闭合曲面；点数不够时返回 `null`。
   *
   * 点数恰好为 2 时按原版给退化结果（就是那两点连成的一条线段）——
   * 绘制途中「第一击 + 鼠标一动」看到的正是它，第 3 个点落下才长成面。
   */
  private _ring(geo: LngLat[]): Ring | null {
    if (geo.length < 2) return null;
    // ★ 顶点先换算到**地面平面**再走原版那套（手性 = 'down'：本类型的算式直接按屏幕坐标
    //   写的、没取反过），算完折回经纬、逐点投影 —— 倾斜 / 旋转时曲线跟着地面走
    //   （2026-09-18 修）。
    const f = this.groundFrameAt(geo[0][1]);
    const raw: ScreenPoint[] = toPlane(geo, f, 'down');
    if (raw.length === 2) {
      return { ring: this.planeToScreen(raw, f, 'down'), hull: this.planeToScreen(raw, f, 'down') };
    }

    // 把首两个点补到尾巴上 ⇒ n 个点绕成 n 段闭环
    const loop = raw.concat([raw[0], raw[1]]);

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
      ring: this.planeToScreen(ring, f, 'down'),
      hull: this.planeToScreen(loop.concat(controls), f, 'down'),
    };
  }

  /** 已提交图形（存储顶点直接当锚点；绘制中走 `preview`） */
  private _ringOf(shape: Shape): Ring | null {
    const Pts = this.projectPts(shape);
    if (Pts.length < 2) return null;
    return this._ring(shape.pts);
  }

  describe(shape: Shape): string {
    // 同「多边形 / 自由面」：面类报顶点数
    return `${this.label} · ${shape.pts.length} 顶点`;
  }

  /**
   * 曲线**画在锚点之外**：拐角处鼓出去的那一块可能跑到顶点包围盒外面
   * （贝塞尔曲线落在控制点的凸包里，量骨架点就是上界）。`cullMargin` 每帧对每个
   * 图形都要算，用采样点量就得为此建上百个点，不值当。
   * 算不出来时退回「线宽那一档」，写 0 会让弧顶刚出屏就被剔除。
   */
  cullMargin(shape: Shape): number {
    const lw = this.styleFor(shape).pathWidth;
    const pad = (typeof lw === 'number' && lw > 0 ? lw : 3) / 2 + 4;
    const Pts = this.projectPts(shape);
    if (Pts.length < 2) return pad;
    const g = this._ring(shape.pts);
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
   * 自定义命中：量**真正画出来的那条闭合曲线**，不是引擎默认的「顶点连线」。
   *
   * ★ 默认规则在这里会漏判：拐点被圆滑之后鼓出去的那一块离顶点连线可不近
   *   （拐点越尖差得越多），表现为「明明点在面上却点不中」。
   * ★ 点在环内即命中；环外再按「贴着轮廓」放一圈容差。
   */
  hitTest(shape: Shape, x: number, y: number, Pts: ScreenPoint[], tol: number): boolean | undefined {
    if (Pts.length < 2) return undefined;        // 形态超出预期 → 交回默认规则
    const g = this._ring(shape.pts);
    if (!g) return distToPolyline(x, y, Pts, false) <= tol;
    if (g.ring.length >= 3 && pointInRing(x, y, g.ring)) return true;
    return distToPolyline(x, y, g.ring, true) <= tol;
  }

  /** 已提交的形状：一条闭合曲面（淡填充 + 轮廓；showLine 关掉就只留填充） */
  render(shape: Shape): void {
    const ctx = this.ctx;
    const g = this._ringOf(shape);
    if (!ctx || !g) return;
    const st = this.styleFor(shape);

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(g.ring[0].x, g.ring[0].y);
    for (let i = 1; i < g.ring.length; i++) ctx.lineTo(g.ring[i].x, g.ring[i].y);
    ctx.closePath();
    if (g.ring.length >= 3) {
      ctx.fillStyle = st.polygonFill;
      ctx.fill();
    }
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
   * 手绘预览：**与落地同一套几何**（原版每帧把「已落点 + 光标」整体重算一遍），
   * 所以预览长什么样、落下就是什么样。
   *
   * ★ 一击未落时不画（原版 `count < 2` 直接 return）；
   * ★ 只有两个点时画的是一条线段（原版那个退化分支），第 3 点落下才成面。
   */
  preview(draw: DrawSession): void {
    const ctx = this.ctx, st = this.style;
    if (!ctx || !st) return;

    const geo = draw.pts.concat(draw.cursor ? [draw.cursor] : []);
    if (!geo.length) return;                       // 一击未落：不画
    const Pts = geo.map((p) => this.project(p));   // 只用来画落点圆点
    const g = geo.length >= 2 ? this._ring(geo) : null;

    ctx.save();
    ctx.globalAlpha = 0.6;
    if (g) {
      ctx.beginPath();
      ctx.moveTo(g.ring[0].x, g.ring[0].y);
      for (let i = 1; i < g.ring.length; i++) ctx.lineTo(g.ring[i].x, g.ring[i].y);
      if (g.ring.length >= 3) {
        ctx.closePath();
        ctx.fillStyle = st.previewFill;
        ctx.fill();
      }
      ctx.setLineDash(PREVIEW_DASH);
      ctx.lineWidth = 3;
      ctx.strokeStyle = st.previewColor;
      ctx.stroke();
    }
    // 已落点 + 光标各点一下（`restore` 一并复位 lineDash）
    Pts.forEach((p) => drawDot(ctx, p.x, p.y, 5, st.previewColor));
    ctx.restore();
  }
}

/* 自注册：import 本文件即把类型收进静态注册表 */
MapboxSketch.registerType(ClosedCurveShape);
