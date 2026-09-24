/* =====================================================================
 * shapes/double-arrow.ts —— 内置类型：DoubleArrowShape「双箭头标注」（钳击箭头）。
 *
 * ★★ 几何**照搬**标绘库 mapbox-plot 的 `src/gispace/plot/DoubleArrow.js`
 *   （＝ openlayers-plot 的 `P.PlotTypes.DOUBLE_ARROW`，demo 按钮中文名「双箭头」），
 *   以及它依赖的 `src/gispace/PlotUtils.js` / `src/gispace/Constants.js`。
 *   和「集结地标注」一样：算法是别人的，别按自己审美重写，否则 `test/shapes-double-arrow.spec.ts`
 *   的金标准会红。
 *
 * ## 原版算法在做什么
 *
 * 1. 用户点 **4 个点**（原版 `fixPointCount = 4`）：
 *    `p0` = 左尾端、`p1` = 右尾端、`p2` = **右箭头尖端**、`p3` = **左箭头尖端**。
 * 2. `connPoint = mid(p0, p1)`（两尾连线中点＝钳口合拢处）；`tempPoint4 = p3`（第 4 击显式给出）。
 *    于是两个箭头头朝外、钳口在中间 —— 第 3 击确认右箭头尖端、第 4 击确认左箭头尖端。
 * 3. 把整块面拆成「左箭头 + 右箭头」两半（`getArrowPoints`），每半又拆成
 *    `箭身直线段 + 箭头三角 + 箭身直线段` 三段（`getArrowHeadPoints` / `getArrowBodyPoints`）。
 * 4. 两半的箭身用 `getBezierPoints` 圆滑成一条曲线，拼接成**一条闭合多边形轮廓**
 *    （`generate` 最后一行 `rlBodyPnts.concat(rArrowPnts, bodyPnts, lArrowPnts, lrBodyPnts)`）。
 *
 * ○ 只有「落了 2 击、光标还在动」那一刻（`count == 3`）原版才走 `getTempPoint4`，把光标
 *   绕「`p0`—`p1` 中点」镜像出另一只头 —— 那只是**过渡预览**；一旦第 4 击落下，一律改用
 *   显式的 `tempPoint4 = p3`（`count == 4` 那条支）。
 *
 * ★ **y 轴要取反**（同「集结地」）：原版跑在地理坐标（y 向上），本引擎跑在屏幕坐标
 *   （y 向下）；原版里大量 `getThirdPoint(..., clockWise = true/false)` 与 `isClockWise`
 *   分支都是手性相关的，整个链路**不像「闭合曲面」那样对称**，所以 `_arrow` 进门把
 *   `y` 取反、出门再取回来 —— 等价于「把屏幕点当成地理点喂给原版」，逐点与原版一致。
 *
 * ★ **存储顶点＝用户点的 4 个点**（钳击效果只在渲染期算，不写回 `pts`）——
 *   于是编辑态拖的还是那 4 个点，拖完箭头实时跟着变（同「曲线标注 / 闭合曲面」的口径）。
 *
 * ★ **顶点圆点不要在这里画**（见 AGENTS 4 节）；绘制中的落点除外（原版也画）。
 *
 * ★ `getBezierPoints` 用 `t += 0.01` 的 101 段（原版 `n` 阶贝塞尔、阶数 ≤ 2，不会溢出），
 *   与逐点金标准同参，所以点数列表由金标准钉死、不是随便估的。
 * ===================================================================== */
import { distToPolyline, pointInRing } from '../math';
import { drawDot } from '../paint';
import { MapboxSketch } from '../sketch';
import { toPlane } from '../ground-frame';
import { MapboxShapeType } from '../sketch-shape-type';
import type { LngLat, CfgKey, DrawSession, ScreenPoint, Shape } from '../types';
import {
  getAngleOfThreePoints, getBaseLength, getBezierPoints, getThirdPoint,
  isClockWise, len, mid, wholeDistance,
} from './plot-utils';

/** 几何常量（原版 `Constants.js`） */
const HALF_PI = Math.PI / 2;
/** 钳击箭头的固定比例（原版 `DoubleArrow` 构造函数的四个因子） */
const HEAD_HEIGHT_FACTOR = 0.25;
const HEAD_WIDTH_FACTOR = 0.3;
const NECK_HEIGHT_FACTOR = 0.85;
const NECK_WIDTH_FACTOR = 0.15;

/** 预览虚线的节奏（与其它类型的手绘预览同一套观感） */
const PREVIEW_DASH: [number, number] = [3, 3];

/** 一条钳击箭头的屏幕几何（就是那条闭合多边形轮廓） */
type Ring = ScreenPoint[];

/* ------------------------------------------------------------------ *
 * 原版 PlotUtils 的逐行搬移见 `plot-utils.ts`（箭头一族共用）——这里不再抄一份，
 * 免得那条手性算式在多处各自漂移。下面这些都在「地理坐标」上跑；`_arrow` 负责翻面。
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 原版 DoubleArrow 的方法（generate / getArrowPoints / getArrowHeadPoints /
 * getArrowBodyPoints / getTempPoint4），逐行搬移、跑在「地理坐标」上
 * ------------------------------------------------------------------ */

/** `DoubleArrow.prototype.getTempPoint4` —— 把 point 绕 `linePnt1—linePnt2` 中点镜像 */
function getTempPoint4(linePnt1: ScreenPoint, linePnt2: ScreenPoint, point: ScreenPoint): ScreenPoint {
  const midPnt = mid(linePnt1, linePnt2);
  const d = len(midPnt, point);
  const angle = getAngleOfThreePoints(linePnt1, midPnt, point);
  let symPnt: ScreenPoint, distance1: number, distance2: number, m: ScreenPoint;
  if (angle < HALF_PI) {
    distance1 = d * Math.sin(angle);
    distance2 = d * Math.cos(angle);
    m = getThirdPoint(linePnt1, midPnt, HALF_PI, distance1, false);
    symPnt = getThirdPoint(midPnt, m, HALF_PI, distance2, true);
  } else if (angle >= HALF_PI && angle < Math.PI) {
    distance1 = d * Math.sin(Math.PI - angle);
    distance2 = d * Math.cos(Math.PI - angle);
    m = getThirdPoint(linePnt1, midPnt, HALF_PI, distance1, false);
    symPnt = getThirdPoint(midPnt, m, HALF_PI, distance2, false);
  } else if (angle >= Math.PI && angle < Math.PI * 1.5) {
    distance1 = d * Math.sin(angle - Math.PI);
    distance2 = d * Math.cos(angle - Math.PI);
    m = getThirdPoint(linePnt1, midPnt, HALF_PI, distance1, true);
    symPnt = getThirdPoint(midPnt, m, HALF_PI, distance2, true);
  } else {
    distance1 = d * Math.sin(Math.PI * 2 - angle);
    distance2 = d * Math.cos(Math.PI * 2 - angle);
    m = getThirdPoint(linePnt1, midPnt, HALF_PI, distance1, true);
    symPnt = getThirdPoint(midPnt, m, HALF_PI, distance2, false);
  }
  return symPnt;
}

/** `DoubleArrow.prototype.getArrowHeadPoints` —— 箭头三角（5 点：颈左 / 头左 / 头尖 / 头右 / 颈右） */
function getArrowHeadPoints(points: ScreenPoint[]): ScreenPoint[] {
  const base = getBaseLength(points);
  const headHeight = base * HEAD_HEIGHT_FACTOR;
  const headPnt = points[points.length - 1];
  const headWidth = headHeight * HEAD_WIDTH_FACTOR;
  const neckWidth = headHeight * NECK_WIDTH_FACTOR;
  const neckHeight = headHeight * NECK_HEIGHT_FACTOR;
  const headEndPnt = getThirdPoint(points[points.length - 2], headPnt, 0, headHeight, true);
  const neckEndPnt = getThirdPoint(points[points.length - 2], headPnt, 0, neckHeight, true);
  const headLeft = getThirdPoint(headPnt, headEndPnt, HALF_PI, headWidth, false);
  const headRight = getThirdPoint(headPnt, headEndPnt, HALF_PI, headWidth, true);
  const neckLeft = getThirdPoint(headPnt, neckEndPnt, HALF_PI, neckWidth, false);
  const neckRight = getThirdPoint(headPnt, neckEndPnt, HALF_PI, neckWidth, true);
  return [neckLeft, headLeft, headPnt, headRight, neckRight];
}

/** `DoubleArrow.prototype.getArrowBodyPoints` —— 箭身两条边（左 / 右） */
function getArrowBodyPoints(
  points: ScreenPoint[], neckLeft: ScreenPoint, neckRight: ScreenPoint, tailWidthFactor: number,
): ScreenPoint[] {
  const allLen = wholeDistance(points);
  const base = getBaseLength(points);
  const tailWidth = base * tailWidthFactor;
  const neckW = len(neckLeft, neckRight);
  const widthDif = (tailWidth - neckW) / 2;
  let tempLen = 0;
  const leftBodyPnts: ScreenPoint[] = [];
  const rightBodyPnts: ScreenPoint[] = [];
  for (let i = 1; i < points.length - 1; i++) {
    const angle = getAngleOfThreePoints(points[i - 1], points[i], points[i + 1]) / 2;
    tempLen += len(points[i - 1], points[i]);
    const w = (tailWidth / 2 - (tempLen / allLen) * widthDif) / Math.sin(angle);
    const left = getThirdPoint(points[i - 1], points[i], Math.PI - angle, w, true);
    const right = getThirdPoint(points[i - 1], points[i], angle, w, false);
    leftBodyPnts.push(left);
    rightBodyPnts.push(right);
  }
  return leftBodyPnts.concat(rightBodyPnts);
}

/** `DoubleArrow.prototype.getArrowPoints` —— 一边的「箭身 + 箭头 + 箭身」三段 */
function getArrowPoints(pnt1: ScreenPoint, pnt2: ScreenPoint, pnt3: ScreenPoint, clockWise: boolean): ScreenPoint[] {
  const midPnt = mid(pnt1, pnt2);
  const d = len(midPnt, pnt3);
  let midPnt1 = getThirdPoint(pnt3, midPnt, 0, d * 0.3, true);
  let midPnt2 = getThirdPoint(pnt3, midPnt, 0, d * 0.5, true);
  midPnt1 = getThirdPoint(midPnt, midPnt1, HALF_PI, d / 5, clockWise);
  midPnt2 = getThirdPoint(midPnt, midPnt2, HALF_PI, d / 4, clockWise);
  const points = [midPnt, midPnt1, midPnt2, pnt3];
  const arrowPnts = getArrowHeadPoints(points);
  const neckLeftPoint = arrowPnts[0];
  const neckRightPoint = arrowPnts[4];
  const tailWidthFactor = len(pnt1, pnt2) / getBaseLength(points) / 2;
  const bodyPnts = getArrowBodyPoints(points, neckLeftPoint, neckRightPoint, tailWidthFactor);
  const n = bodyPnts.length;
  const lPoints = bodyPnts.slice(0, n / 2);
  const rPoints = bodyPnts.slice(n / 2, n);
  lPoints.push(neckLeftPoint);
  rPoints.push(neckRightPoint);
  lPoints.reverse();
  lPoints.push(pnt2);
  rPoints.reverse();
  rPoints.push(pnt1);
  return lPoints.reverse().concat(arrowPnts, rPoints);
}

/** `DoubleArrow.prototype.generate` —— 合成整条闭合轮廓 */
function generate(raw: ScreenPoint[]): Ring | null {
  const n = raw.length;
  if (n < 2) return null;
  if (n === 2) return raw.slice();                 // 退化：原样吐回两个点
  const pnt1 = raw[0], pnt2 = raw[1], pnt3 = raw[2];
  // 本引擎存 4 个用户点，正常路径是 n === 4（第 4 点＝左箭头尖端，显式作 tempPoint4）；
  // n === 3 只在「落了 2 击 + 光标」那一刻的过渡预览里出现，走原版 getTempPoint4 镜像支；
  // n === 5 本引擎不会产生（保留以与原版逐行一致）。
  const tempPoint4 = n === 3 ? getTempPoint4(pnt1, pnt2, pnt3) : raw[3];
  const connPoint = n === 3 || n === 4 ? mid(pnt1, pnt2) : raw[4];

  let leftArrowPnts: ScreenPoint[];
  let rightArrowPnts: ScreenPoint[];
  if (isClockWise(pnt1, pnt2, pnt3)) {
    leftArrowPnts = getArrowPoints(pnt1, connPoint, tempPoint4, false);
    rightArrowPnts = getArrowPoints(connPoint, pnt2, pnt3, true);
  } else {
    leftArrowPnts = getArrowPoints(pnt2, connPoint, pnt3, false);
    rightArrowPnts = getArrowPoints(connPoint, pnt1, tempPoint4, true);
  }

  const m = leftArrowPnts.length;
  const t = (m - 5) / 2;
  const llBodyPnts = leftArrowPnts.slice(0, t);
  const lArrowPnts = leftArrowPnts.slice(t, t + 5);
  const lrBodyPnts = leftArrowPnts.slice(t + 5, m);
  const rlBodyPnts = rightArrowPnts.slice(0, t);
  const rArrowPnts = rightArrowPnts.slice(t, t + 5);
  const rrBodyPnts = rightArrowPnts.slice(t + 5, m);

  const rlBodyPnts2 = getBezierPoints(rlBodyPnts);
  const bodyPnts = getBezierPoints(rrBodyPnts.concat(llBodyPnts.slice(1)));
  const lrBodyPnts2 = getBezierPoints(lrBodyPnts);

  return rlBodyPnts2.concat(rArrowPnts, bodyPnts, lArrowPnts, lrBodyPnts2);
}

export class DoubleArrowShape extends MapboxShapeType {
  get key(): string { return 'doubleArrow'; }
  get label(): string { return '双箭头标注'; }
  get minPts(): number { return 4; }
  get autoCommit(): boolean { return true; }   // 四击即成：同原版 fixPointCount = 4

  cfgKeys(): CfgKey[] { return ['showLine']; } // 同其它面类：轮廓可隐藏，只留淡填充

  get hint(): string {
    return '⇶ 绘制<b>双箭头标注</b>（钳击箭头）：单击定<b>左尾端</b> → 单击定<b>右尾端</b>'
      + ' → 单击确认<b>右箭头尖端</b> → 移动鼠标把<b>左箭头尖端</b>摆到位，<b>第四次单击</b>完成（四击即成）<br />'
      + '・轮廓一定过你落的四个点（两尾＋两尖），编辑时拖它们改形状　・<b>Esc</b>＝取消';
  }

  /* ---------------- 几何：渲染 / 命中 / 剔除 / 预览四处共用同一份算式 ---------------- */

  /**
   * 由「已落点 [+ 光标]」算出这条钳击箭头的闭合轮廓；点数不够或退化时返回 `null`。
   *
   * ★ 进门先把 `y` 取反（原版跑在地理坐标 y 向上，本引擎跑在屏幕坐标 y 向下），
   *   出门再取回来 —— 不取反形状会上下镜像（原版有大量手性相关分支，见文件头）。
   */
  private _arrow(geo: LngLat[]): Ring | null {
    if (geo.length < 2) return null;
    // ★ 顶点先换算到**地面平面**再喂给 `generate()`（原版跑在地理坐标 y 向上，
    //   面就是 y 向上的），算完再折回经纬、逐点投影 —— 倾斜 / 旋转时形状跟着地面走
    //   （2026-09-18 修；手性 = 'up'，与原来那次 y 取反对应）。
    const f = this.groundFrameAt(geo[0][1]);
    const ring = generate(toPlane(geo, f));
    if (!ring) return null;
    const back = this.planeToScreen(ring, f);
    const finite = (p: ScreenPoint): boolean => Number.isFinite(p.x) && Number.isFinite(p.y);
    if (!back.every(finite)) return null;   // 退化输入（三点共线）可能吐 Infinity，交回默认
    return back;
  }

  describe(shape: Shape): string {
    return `${this.label} · ${shape.pts.length} 顶点`;
  }

  /**
   * 轮廓画在锚点之外（箭身贝塞尔鼓出去、箭头三角也探出），必须量整条轮廓来定余量，
   * 否则滑出屏幕时会被误剔除。算不出来时退回「线宽那一档」，写 0 会让箭头顶刚出屏就被剔。
   */
  cullMargin(shape: Shape): number {
    const lw = this.styleFor(shape).pathWidth;
    const pad = (typeof lw === 'number' && lw > 0 ? lw : 3) / 2 + 4;
    const Pts = this.projectPts(shape);
    if (Pts.length < 2) return pad;
    const ring = this._arrow(shape.pts);
    if (!ring) return pad;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of Pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    let reach = 0;
    for (const p of ring) {
      const dx = Math.max(minX - p.x, 0, p.x - maxX);
      const dy = Math.max(minY - p.y, 0, p.y - maxY);
      reach = Math.max(reach, Math.hypot(dx, dy));
    }
    return reach + pad;
  }

  /**
   * 自定义命中：量**真正画出来的那条闭合多边形**，不是引擎默认的「顶点连线」。
   * 点在轮廓内即命中；轮廓外再按「贴着边」放一圈容差。
   */
  hitTest(shape: Shape, x: number, y: number, Pts: ScreenPoint[], tol: number): boolean | undefined {
    if (Pts.length < 2) return undefined;        // 形态超出预期 → 交回默认规则
    const ring = this._arrow(shape.pts);
    if (!ring) return distToPolyline(x, y, Pts, false) <= tol;
    if (ring.length >= 3 && pointInRing(x, y, ring)) return true;
    return distToPolyline(x, y, ring, true) <= tol;
  }

  /** 已提交的形状：一条闭合的钳击箭头（淡填充 + 轮廓；showLine 关掉就只留填充） */
  render(shape: Shape): void {
    const ctx = this.ctx;
    const ring = this._arrow(shape.pts);
    if (!ctx || !ring) return;
    const st = this.styleFor(shape);

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(ring[0].x, ring[0].y);
    for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i].x, ring[i].y);
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
   * 手绘预览：**与落地同一套几何**（原版每帧把「已落点 + 光标」整体重算一遍），
   * 所以预览长什么样、落下就是什么样。
   *
   * ★ 一击未落时不画（同原版 `count < 2` 直接 return）；
   * ★ 落 1 击 + 光标 = 2 点 ⇒ 一条退化线段；落 2 击 + 光标 = 3 点 ⇒ 原版 `getTempPoint4`
   *   镜像预览（过渡）；落 3 击 + 光标 = 4 点才长成完整的钳击箭头 —— 第 4 击落下即定稿。
   */
  preview(draw: DrawSession): void {
    const ctx = this.ctx, st = this.style;
    if (!ctx || !st) return;

    const geo = draw.pts.concat(draw.cursor ? [draw.cursor] : []);
    if (!geo.length) return;                       // 一击未落：不画
    const Pts = geo.map((p) => this.project(p));   // 只用来画落点圆点
    const ring = geo.length >= 2 ? this._arrow(geo) : null;

    ctx.save();
    ctx.globalAlpha = 0.6;
    if (ring) {
      ctx.beginPath();
      ctx.moveTo(ring[0].x, ring[0].y);
      for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i].x, ring[i].y);
      if (ring.length >= 3) {
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
MapboxSketch.registerType(DoubleArrowShape);
