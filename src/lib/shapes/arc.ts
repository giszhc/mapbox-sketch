/* =====================================================================
 * shapes/arc.ts —— 内置类型：ArcShape「弧线标注」。
 *
 * ★★ 几何**照搬**标绘库 mapbox-plot 的 `src/gispace/plot/Arc.js`
 *   （＝ openlayers-plot 的 `P.PlotTypes.ARC`，那个 demo 的按钮中文名「弧线」）。
 *   用户 2026-09-18 要求新增。常量、算式、退化分支一律**别按自己审美重写**。
 *
 * ## 原版算法在做什么（过三点的**一段圆弧**，不填充、不成面）
 *
 * 与「弓形面标注」（`Lune`）同族但有两个关键差别 ——
 *   · 原版 `goog.inherits(P.Plot.Arc, ol.geom.LineString)`：它是**线**不是面，
 *     弧上 101 个点连成一条开折线，**末点不连回首点**；
 *   · 只落两点时**不补点**，直接退化成「两点间的直线段」（弓形面那个分支会
 *     `getThirdPoint` 补出第三点，这里没有）。
 * 三点定圆 / 起止角 / `isClockWise` 定侧的算法与弓形面**逐字相同**：
 * `getCircleCenterOfThreePoints` 定圆、半径 = |p1 → 圆心|、
 * `getAzimuth(p1→圆心)` / `getAzimuth(p2→圆心)` 定起止 —— 弧永远扫过第三点那一侧，
 * **三个落点都在弧上**。弧按 `Constants.FITTING_COUNT = 100` 均匀采样。
 *
 * ★ **y 轴要取反**（同「弓形面 / 进攻方向」一族）：原版跑地理坐标（y 向上），本引擎跑
 *   屏幕坐标（y 向下）；`isClockWise` / `getAzimuth` 都是手性相关的 —— 不取反，
 *   弧会扫到第三点的**另一侧**。
 *
 * ★ 三点**共线**时垂直平分线平行，交点吐 `Infinity`（原版行为）——这里靠
 *   「折线必须全有限」那一道闸返回 `null`：不画、不命中。
 *
 * ★ **存储顶点＝用户落的那三个点**（弧只在渲染期算，不写回 `pts`）。
 * ★ **顶点圆点不要在这里画**（见 AGENTS 4 节）；绘制中的落点除外。
 * ===================================================================== */
import { distToPolyline } from '../math';
import { drawDot, lineDashFor, strokePolyline } from '../paint';
import { MapboxSketch } from '../sketch';
import { toPlane } from '../ground-frame';
import { MapboxShapeType } from '../sketch-shape-type';
import type { LngLat, CfgKey, DrawSession, ScreenPoint, Shape } from '../types';
import {
  distance, getArcPoints, getAzimuth, getCircleCenterOfThreePoints, isClockWise,
} from './plot-utils';

/** 一条弧线的屏幕几何（开折线：弧上 101 个采样点） */
type Arc = ScreenPoint[];

export class ArcShape extends MapboxShapeType {
  get key(): string { return 'arc'; }
  get label(): string { return '弧线标注'; }
  get minPts(): number { return 3; }
  get autoCommit(): boolean { return true; }   // 原版 fixPointCount = 3：三击即成

  cfgKeys(): CfgKey[] { return []; }           // 同「曲线」：仅一条线，无可调开关

  get hint(): string {
    return '⌒ 绘制<b>弧线标注</b>：单击落<b>弧的起点</b> → 单击落<b>弧的终点</b> → 移动鼠标把第三点摆到位 →'
      + '第三击即完成（口径同「弧线」标绘）<br />'
      + '・三个落点<b>都在弧上</b>，弧从第三点那侧扫过（第三点摆哪边、弧就往哪边弯）<br />'
      + '・三点排在一条直线上时画不出（没有过三点的圆）　・<b>Esc</b>＝取消';
  }

  /* ---------------- 几何：渲染 / 命中 / 剔除 / 预览四处共用同一份算式 ---------------- */

  /**
   * `Arc.prototype.generate` —— 合成整条弧（开折线，跑在「地理坐标」上）。
   * 原版两点时**原样吐回**（两点连线）；三点共线会吐非有限数，由外层 `_arc` 的有限闸挡住。
   */
  protected buildArc(raw: ScreenPoint[]): Arc | null {
    const n = raw.length;
    if (n < 2) return null;                       // 原版 `getPointCount() < 2` 直接 return
    if (n === 2) return raw.slice();              // 原版两点支：setCoordinates(this.points)

    const p1 = raw[0], p2 = raw[1], p3 = raw[2];
    const center = getCircleCenterOfThreePoints(p1, p2, p3);
    const radius = distance(p1, center);

    // 弧永远扫过 p3 那一侧（isClockWise 决定起止角谁先谁后）
    const angle1 = getAzimuth(p1, center);
    const angle2 = getAzimuth(p2, center);
    let startAngle: number, endAngle: number;
    if (isClockWise(p1, p2, p3)) { startAngle = angle2; endAngle = angle1; }
    else { startAngle = angle1; endAngle = angle2; }

    return getArcPoints(center, radius, startAngle, endAngle);
  }

  /**
   * 由「已落点 [+ 光标]」算出这条弧；点数不够或退化时返回 `null`。
   *
   * ★ 进门先把 `y` 取反（原版跑在地理坐标 y 向上，本引擎跑在屏幕坐标 y 向下），
   *   出门再取回来 —— 不取反弧会扫到第三点的另一侧（原版有手性相关分支，见文件头）。
   */
  private _arc(geo: LngLat[]): Arc | null {
    if (geo.length < 2) return null;
    // ★ 顶点先换算到**地面平面**再走三点定圆（手性 = 'up'，对应原来那次 y 取反），
    //   算完折回经纬、逐点投影 —— 倾斜 / 旋转时弧跟着地面走（2026-09-18 修）。
    const f = this.groundFrameAt(geo[0][1]);
    const arc = this.buildArc(toPlane(geo, f));
    if (!arc) return null;
    const back = this.planeToScreen(arc, f);
    const finite = (p: ScreenPoint): boolean => Number.isFinite(p.x) && Number.isFinite(p.y);
    if (!back.every(finite)) return null;   // 三点共线 → 圆心是 Infinity，画不出
    return back;
  }

  describe(shape: Shape): string {
    return `${this.label} · ${shape.pts.length} 点`;
  }

  /** 弧画在三点包围盒之外（圆弧外鼓可能伸出去），量整条弧定余量，避免滑出屏幕被误剔除。 */
  cullMargin(shape: Shape): number {
    const lw = this.styleFor(shape).pathWidth;
    const pad = (typeof lw === 'number' && lw > 0 ? lw : 3) / 2 + 4;
    const Pts = this.projectPts(shape);
    if (Pts.length < 2) return pad;
    const arc = this._arc(shape.pts);
    if (!arc) return pad;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of Pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    let reach = 0;
    for (const p of arc) {
      const dx = Math.max(minX - p.x, 0, p.x - maxX);
      const dy = Math.max(minY - p.y, 0, p.y - maxY);
      reach = Math.max(reach, Math.hypot(dx, dy));
    }
    return reach + pad;
  }

  /** 自定义命中：量**真正画出来的那条弧**，不是引擎默认的「三点折线」。 */
  hitTest(shape: Shape, x: number, y: number, Pts: ScreenPoint[], tol: number): boolean | undefined {
    if (Pts.length < 2) return undefined;        // 形态超出预期 → 交回默认规则
    const arc = this._arc(shape.pts);
    if (!arc) return distToPolyline(x, y, Pts, false) <= tol;
    return distToPolyline(x, y, arc, true) <= tol;
  }

  /** 已提交的弧线：一条圆头的开折线（同「曲线标注」的图面口径，不填充） */
  render(shape: Shape): void {
    const ctx = this.ctx;
    if (!ctx || shape.pts.length < 2) return;
    const arc = this._arc(shape.pts);
    if (!arc) return;                            // 退化（三点共线）：不画
    const st = this.styleFor(shape);
    strokePolyline(ctx, arc, st.pathColor, st.pathWidth, lineDashFor(st.lineType, st.pathWidth), st.lineOpacity);
  }

  /** 手绘预览：与落地同一套几何的虚线弧 + 各落点圆点。 */
  preview(draw: DrawSession): void {
    const ctx = this.ctx, st = this.style;
    if (!ctx || !st) return;

    const geo = draw.pts.concat(draw.cursor ? [draw.cursor] : []);
    if (!geo.length) return;                       // 一击未落：不画
    const Pts = geo.map((p) => this.project(p));   // 只用来画落点圆点
    const arc = geo.length >= 2 ? this._arc(geo) : null;

    ctx.save();
    ctx.globalAlpha = 0.6;
    if (arc) {
      strokePolyline(ctx, arc, st.previewColor, 3, [3, 3]);
    } else if (Pts.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(Pts[0].x, Pts[0].y);
      for (let i = 1; i < Pts.length; i++) ctx.lineTo(Pts[i].x, Pts[i].y);
      ctx.setLineDash([3, 3]);
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
MapboxSketch.registerType(ArcShape);
