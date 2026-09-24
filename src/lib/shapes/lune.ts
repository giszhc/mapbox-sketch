/* =====================================================================
 * shapes/lune.ts —— 内置类型：LuneShape「弓形面标注」。
 *
 * ★★ 几何**照搬**标绘库 mapbox-plot 的 `src/gispace/plot/Lune.js`
 *   （＝ openlayers-plot 的 `P.PlotTypes.LUNE`，那个 demo 的按钮中文名「弓形」；
 *   GISpace 军标体系里它的全名就是「弓形面标注」——`ol.geom.Polygon`，一块面）。
 *   用户 2026-09-18 要求新增。常量、算式、退化分支一律**别按自己审美重写**。
 *
 * ## 原版算法在做什么（三点定圆 → 圆弧 + 弦围出的一块「弓形」）
 *
 * 1. `fixPointCount = 3`：三击即成。只落两点时原版会**自己补第三个点**
 *    （`getThirdPoint(p1, mid, HALF_PI, d)` —— 在 p1p2 中点往一侧偏出等距点），
 *    所以两点也能算出完整几何（编辑时少一个点也不至于整条消失）。
 * 2. `getCircleCenterOfThreePoints` 过三点定圆（两条弦的垂直平分线求交），
 *    半径 = |p1 → 圆心|。**三个落点都在圆周上**。
 * 3. `getAzimuth(p1→圆心)` / `getAzimuth(p2→圆心)` 定弧的起止角；`isClockWise(p1,p2,p3)`
 *    决定从哪头起——效果是**弧永远扫过 p3 那一侧**（第三击把弧「拉」向哪边，
 *    弓形就朝哪边鼓）。弧按 `Constants.FITTING_COUNT = 100` 均匀采样成 101 个点。
 * 4. 末尾再 `push(弧上第一点)` 把环闭合 —— 弧 + 弦 p2→p1 围出一块面（弓形）。
 *
 * ★ **y 轴要取反**（同「进攻方向 / 双箭头」一族）：原版跑地理坐标（y 向上），本引擎跑
 *   屏幕坐标（y 向下）；`isClockWise` / `getAzimuth` 都是手性相关的——不取反，
 *   弧会扫到 p3 的**另一侧**（弓形朝反方向鼓）。
 *
 * ★ 三点**共线**时垂直平分线平行，交点吐 `Infinity`（原版行为）——这里靠
 *   「轮廓必须全有限」那一道闸返回 `null`：不画、不命中，同「退化」的扇形。
 *
 * ★ **存储顶点＝用户落的那三个点**（弧只在渲染期算，不写回 `pts`）。
 * ★ **顶点圆点不要在这里画**（见 AGENTS 4 节）；绘制中的落点除外。
 * ===================================================================== */
import { distToPolyline, pointInRing } from '../math';
import { drawDot } from '../paint';
import { MapboxSketch } from '../sketch';
import { toPlane } from '../ground-frame';
import { MapboxShapeType } from '../sketch-shape-type';
import type { LngLat, CfgKey, DrawSession, ScreenPoint, Shape } from '../types';
import {
  distance, getArcPoints, getAzimuth, getCircleCenterOfThreePoints, getThirdPoint, isClockWise, mid,
} from './plot-utils';

/** 几何常量（原版 `Constants.js`） */
const HALF_PI = Math.PI / 2;

/** 预览虚线的节奏（与其它类型的手绘预览同一套观感） */
const PREVIEW_DASH: [number, number] = [3, 3];

/** 一条弓形面的屏幕几何（闭合环：弧上 101 点 + 闭合点） */
type Ring = ScreenPoint[];

export class LuneShape extends MapboxShapeType {
  get key(): string { return 'lune'; }
  get label(): string { return '弓形面标注'; }
  get minPts(): number { return 3; }
  get autoCommit(): boolean { return true; }   // 原版 fixPointCount = 3：三击即成

  cfgKeys(): CfgKey[] { return ['showLine']; } // 同其它面类：轮廓可隐藏，只留淡填充

  get hint(): string {
    return '◠ 绘制<b>弓形面标注</b>：单击落<b>弓形弦的两个端点</b> → 移动鼠标把第三点摆到位 →'
      + '第三击即完成（口径同「弓形」标绘）<br />'
      + '・三个落点<b>都在圆弧上</b>，弧从第三点那侧扫过（第三点摆哪边、弓形就朝哪边鼓）<br />'
      + '・三点排在一条直线上时画不出（没有过三点的圆）　・<b>Esc</b>＝取消';
  }

  /* ---------------- 几何：渲染 / 命中 / 剔除 / 预览四处共用同一份算式 ---------------- */

  /**
   * `Lune.prototype.generate` —— 合成整条闭合环（跑在「地理坐标」上）。
   * 原版两点时补第三个点；三点共线会吐非有限数，由外层 `_ring` 的有限闸挡住。
   */
  protected buildRing(raw: ScreenPoint[]): Ring | null {
    const n = raw.length;
    if (n < 2) return null;                       // 原版 `getPointCount() < 2` 直接 return

    const pnts = raw.slice();
    if (pnts.length === 2) {
      // 原版两点支：往中点一侧偏出等距第三点（getThirdPoint 不传 clockWise ⇒ false）
      const m = mid(pnts[0], pnts[1]);
      const d = distance(pnts[0], m);
      pnts.push(getThirdPoint(pnts[0], m, HALF_PI, d, false));
    }
    const p1 = pnts[0], p2 = pnts[1], p3 = pnts[2];

    const center = getCircleCenterOfThreePoints(p1, p2, p3);
    const radius = distance(p1, center);

    // 弧永远扫过 p3 那一侧（isClockWise 决定起止角谁先谁后）
    const angle1 = getAzimuth(p1, center);
    const angle2 = getAzimuth(p2, center);
    let startAngle: number, endAngle: number;
    if (isClockWise(p1, p2, p3)) { startAngle = angle2; endAngle = angle1; }
    else { startAngle = angle1; endAngle = angle2; }

    const arcPnts = getArcPoints(center, radius, startAngle, endAngle);
    arcPnts.push(arcPnts[0]);                     // 原版 `pnts.push(pnts[0])`：闭合成 Polygon
    return arcPnts;
  }

  /**
   * 由「已落点 [+ 光标]」算出这条弓形的闭合环；点数不够或退化时返回 `null`。
   *
   * ★ 进门先把 `y` 取反（原版跑在地理坐标 y 向上，本引擎跑在屏幕坐标 y 向下），
   *   出门再取回来 —— 不取反弧会扫到第三点的另一侧（原版有手性相关分支，见文件头）。
   */
  private _ring(geo: LngLat[]): Ring | null {
    if (geo.length < 2) return null;
    // ★ 顶点先换算到**地面平面**再走三点定圆（手性 = 'up'，对应原来那次 y 取反），
    //   算完折回经纬、逐点投影 —— 倾斜 / 旋转时弓形面跟着地面走（2026-09-18 修）。
    const f = this.groundFrameAt(geo[0][1]);
    const ring = this.buildRing(toPlane(geo, f));
    if (!ring) return null;
    const back = this.planeToScreen(ring, f);
    const finite = (p: ScreenPoint): boolean => Number.isFinite(p.x) && Number.isFinite(p.y);
    if (!back.every(finite)) return null;   // 三点共线 → 圆心是 Infinity，画不出
    return back;
  }

  describe(shape: Shape): string {
    return `${this.label} · ${shape.pts.length} 顶点`;
  }

  /** 弧画在三点包围盒之外（圆弧外鼓可能伸出去），量整条环定余量，避免滑出屏幕被误剔除。 */
  cullMargin(shape: Shape): number {
    const lw = this.styleFor(shape).pathWidth;
    const pad = (typeof lw === 'number' && lw > 0 ? lw : 3) / 2 + 4;
    const Pts = this.projectPts(shape);
    if (Pts.length < 2) return pad;
    const ring = this._ring(shape.pts);
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

  /** 自定义命中：量**真正画出来的那条闭合环**（弧 + 弦），不是引擎默认的「三点折线」。 */
  hitTest(shape: Shape, x: number, y: number, Pts: ScreenPoint[], tol: number): boolean | undefined {
    if (Pts.length < 2) return undefined;        // 形态超出预期 → 交回默认规则
    const ring = this._ring(shape.pts);
    if (!ring) return distToPolyline(x, y, Pts, false) <= tol;
    if (ring.length >= 3 && pointInRing(x, y, ring)) return true;
    return distToPolyline(x, y, ring, true) <= tol;
  }

  /** 已提交的形状：一块弓形面（淡填充 + 轮廓；showLine 关掉就只留填充） */
  render(shape: Shape): void {
    const ctx = this.ctx;
    const ring = this._ring(shape.pts);
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
      ctx.globalAlpha = st.lineOpacity;
      ctx.lineWidth = st.pathWidth;
      ctx.strokeStyle = st.pathColor;
      ctx.stroke();
    }
    ctx.restore();
  }

  /** 手绘预览：与落地同一套几何；两点即可成完整预览（原版两点支会补第三点）。 */
  preview(draw: DrawSession): void {
    const ctx = this.ctx, st = this.style;
    if (!ctx || !st) return;

    const geo = draw.pts.concat(draw.cursor ? [draw.cursor] : []);
    if (!geo.length) return;                       // 一击未落：不画
    const Pts = geo.map((p) => this.project(p));   // 只用来画落点圆点
    const ring = geo.length >= 2 ? this._ring(geo) : null;

    ctx.save();
    ctx.globalAlpha = 0.6;
    if (ring) {
      ctx.beginPath();
      ctx.moveTo(ring[0].x, ring[0].y);
      for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i].x, ring[i].y);
      ctx.closePath();
      ctx.fillStyle = st.previewFill;
      ctx.fill();
      ctx.setLineDash(PREVIEW_DASH);
      ctx.lineWidth = 3;
      ctx.strokeStyle = st.previewColor;
      ctx.stroke();
    } else {
      // 还没成面：先把「已落点 + 光标」用虚线连起来（同折线预览）
      if (Pts.length >= 2) {
        ctx.beginPath();
        ctx.moveTo(Pts[0].x, Pts[0].y);
        for (let i = 1; i < Pts.length; i++) ctx.lineTo(Pts[i].x, Pts[i].y);
        ctx.setLineDash(PREVIEW_DASH);
        ctx.lineWidth = 3;
        ctx.strokeStyle = st.previewColor;
        ctx.stroke();
      }
    }
    // 已落点 + 光标各点一下（`restore` 一并复位 lineDash）
    Pts.forEach((p) => drawDot(ctx, p.x, p.y, 5, st.previewColor));
    ctx.restore();
  }
}

/* 自注册：import 本文件即把类型收进静态注册表 */
MapboxSketch.registerType(LuneShape);
