/* =====================================================================
 * shapes/attack-arrow.ts —— 内置类型：AttackArrowShape「进攻方向标注」。
 *
 * ★★ 几何**照搬**标绘库 mapbox-plot 的 `src/gispace/plot/AttackArrow.js`
 *   （＝ openlayers-plot 的 `P.PlotTypes.ATTACK_ARROW`，那个 demo 的按钮中文名「进攻方向」），
 *   以及它依赖的 `PlotUtils.js` / `Constants.js`（那几个原语已并入 `plot-utils.ts`）。
 *   用户 2026-09-17 要求新增。常量、算式、退化分支一律**别按自己审美重写**。
 *
 * ## 原版算法在做什么（多点逐段「带箭头的绸带」）
 *
 * 1. 用户**逐点落点**（原版没设 `fixPointCount` ⇒ 双击 / 回车收尾，同多边形）。
 *    前两个点是**箭尾两边**，其余点是**箭杆的骨架点**（最后一个＝箭头尖端）。
 * 2. 先按 `isClockWise(p0,p1,p2)` 决定哪边是 `tailLeft` / `tailRight`，再取箭尾中点
 *    `midTail = mid(tailLeft, tailRight)`，骨架点列 `bonePnts = [midTail, ...pnts.slice(2)]`。
 * 3. **箭头**（`getArrowHeadPoints`）：以骨架末端为尖、按 `headHeightFactor` 算头高（并以
 *    `headTailFactor × 尾宽` 封顶、以末段长为上限），得到 `[neckLeft, headLeft, headPnt, headRight, neckRight]`。
 * 4. **箭身**（`getArrowBodyPoints`）：沿骨架每个中间点做法向偏移（宽度从尾宽线性收到颈宽），
 *    得到左右两串点。
 * 5. 左右两串各自用 **二次 B 样条**（`getQBSplinePoints`）圆滑，再与箭头拼成一条闭合轮廓：
 *    `leftPnts.concat(headPnts, rightPnts.reverse())`。
 *
 * ★ **y 轴要取反**（同「集结地 / 双箭头 / 细直箭头」）：原版跑地理坐标（y 向上），本引擎跑
 *   屏幕坐标（y 向下）；`isClockWise` / `getThirdPoint(..., clockWise)` 都是手性相关的。
 *
 * ★ **存储顶点＝用户落的那些点**（绸带只在渲染期算，不写回 `pts`）。
 * ★ **顶点圆点不要在这里画**（见 AGENTS 4 节）；绘制中的落点除外。
 *
 * ★ 「进攻方向（尾）」（`TailedAttackArrow`）在原版里是**继承本类**、只覆写 `generate`
 *   加一个「燕尾」，见 `tailed-attack-arrow.ts` —— 所以这里的 `buildRing` / `getArrowHeadPoints`
 *   / `getArrowBodyPoints` 都写成可继承的 `protected`。
 * ===================================================================== */
import { distToPolyline, pointInRing } from '../math';
import { drawDot } from '../paint';
import { MapboxSketch } from '../sketch';
import { toPlane } from '../ground-frame';
import { MapboxShapeType } from '../sketch-shape-type';
import type { LngLat, CfgKey, DrawSession, ScreenPoint, Shape } from '../types';
import {
  distance, getAngleOfThreePoints, getBaseLength, getQBSplinePoints, getThirdPoint,
  isClockWise, mid, wholeDistance,
} from './plot-utils';

/** 几何常量（原版 `Constants.js`） */
const HALF_PI = Math.PI / 2;

/** 预览虚线的节奏（与其它类型的手绘预览同一套观感） */
const PREVIEW_DASH: [number, number] = [3, 3];

/** 进攻方向的固定比例（原版 `AttackArrow` 构造函数的五个因子） */
export interface AttackArrowFactors {
  headHeightFactor: number;
  headWidthFactor: number;
  neckHeightFactor: number;
  neckWidthFactor: number;
  headTailFactor: number;
}
export const ATTACK_ARROW_FACTORS: AttackArrowFactors = {
  headHeightFactor: 0.18,
  headWidthFactor: 0.3,
  neckHeightFactor: 0.85,
  neckWidthFactor: 0.15,
  headTailFactor: 0.8,
};

/** 一条进攻方向的屏幕几何（闭合轮廓） */
type Ring = ScreenPoint[];

export class AttackArrowShape extends MapboxShapeType {
  get key(): string { return 'attackArrow'; }
  get label(): string { return '进攻方向标注'; }
  get minPts(): number { return 3; }        // 两尾 + 至少一个骨架点
  // 原版没设 fixPointCount ⇒ 不 autoCommit：逐点落点，双击 / 回车收尾（同多边形）

  cfgKeys(): CfgKey[] { return ['showLine']; } // 同其它面类：轮廓可隐藏，只留淡填充

  /** 五个比例因子（子类「进攻方向（尾）」沿用这一套，另加燕尾参数） */
  protected factors(): AttackArrowFactors { return ATTACK_ARROW_FACTORS; }

  get hint(): string {
    return '➹ 绘制<b>进攻方向标注</b>：单击落下<b>箭尾</b>后逐点单击画出<b>箭杆</b>，'
      + '最后一个点＝<b>箭头尖端</b>；<b>双击</b> 或按 <b>回车</b>完成<br />'
      + '・前两个点是箭尾两边，其余点被圆滑成带箭头的绸带　・<b>右键</b>＝撤销上一点　・<b>Esc</b>＝取消';
  }

  /* ---------------- 几何：渲染 / 命中 / 剔除 / 预览四处共用同一份算式 ---------------- */

  /** `AttackArrow.prototype.getArrowHeadPoints` —— 箭头（颈左 / 头左 / 头尖 / 头右 / 颈右） */
  protected getArrowHeadPoints(bonePnts: ScreenPoint[], tailLeft: ScreenPoint, tailRight: ScreenPoint): ScreenPoint[] {
    const f = this.factors();
    const last = bonePnts.length - 1;
    const headPnt = bonePnts[last];
    let headHeight = getBaseLength(bonePnts) * f.headHeightFactor;
    const lastSeg = distance(headPnt, bonePnts[last - 1]);
    const tailWidth = distance(tailLeft, tailRight);
    if (headHeight > tailWidth * f.headTailFactor) headHeight = tailWidth * f.headTailFactor;
    const headWidth = headHeight * f.headWidthFactor;
    const neckWidth = headHeight * f.neckWidthFactor;
    headHeight = headHeight > lastSeg ? lastSeg : headHeight;
    const neckHeight = headHeight * f.neckHeightFactor;
    const headEndPnt = getThirdPoint(bonePnts[last - 1], headPnt, 0, headHeight, true);
    const neckEndPnt = getThirdPoint(bonePnts[last - 1], headPnt, 0, neckHeight, true);
    const headLeft = getThirdPoint(headPnt, headEndPnt, HALF_PI, headWidth, false);
    const headRight = getThirdPoint(headPnt, headEndPnt, HALF_PI, headWidth, true);
    const neckLeft = getThirdPoint(headPnt, neckEndPnt, HALF_PI, neckWidth, false);
    const neckRight = getThirdPoint(headPnt, neckEndPnt, HALF_PI, neckWidth, true);
    return [neckLeft, headLeft, headPnt, headRight, neckRight];
  }

  /** `AttackArrow.prototype.getArrowBodyPoints` —— 箭身左右两条边 */
  protected getArrowBodyPoints(
    bonePnts: ScreenPoint[], neckLeft: ScreenPoint, neckRight: ScreenPoint, tailWidthFactor: number,
  ): ScreenPoint[] {
    const allLen = wholeDistance(bonePnts);
    const baseLen = getBaseLength(bonePnts);
    const tailWidth = baseLen * tailWidthFactor;
    const neckWidth = distance(neckLeft, neckRight);
    const widthDif = (tailWidth - neckWidth) / 2;
    let tempLen = 0;
    const leftBodyPnts: ScreenPoint[] = [];
    const rightBodyPnts: ScreenPoint[] = [];
    for (let i = 1; i < bonePnts.length - 1; i++) {
      const angle = getAngleOfThreePoints(bonePnts[i - 1], bonePnts[i], bonePnts[i + 1]) / 2;
      tempLen += distance(bonePnts[i - 1], bonePnts[i]);
      const w = (tailWidth / 2 - (tempLen / allLen) * widthDif) / Math.sin(angle);
      leftBodyPnts.push(getThirdPoint(bonePnts[i - 1], bonePnts[i], Math.PI - angle, w, true));
      rightBodyPnts.push(getThirdPoint(bonePnts[i - 1], bonePnts[i], angle, w, false));
    }
    return leftBodyPnts.concat(rightBodyPnts);
  }

  /**
   * `AttackArrow.prototype.generate` —— 合成整条闭合轮廓（跑在「地理坐标」上）。
   * 子类「进攻方向（尾）」覆写它，在末尾再接一段「燕尾」。
   */
  protected buildRing(raw: ScreenPoint[]): Ring | null {
    const n = raw.length;
    if (n < 2) return null;                       // 原版 `getPointCount() < 2` 直接 return
    if (n === 2) return raw.slice();              // 原版两点时原样吐回

    let tailLeft = raw[0];
    let tailRight = raw[1];
    if (isClockWise(raw[0], raw[1], raw[2])) { tailLeft = raw[1]; tailRight = raw[0]; }
    const midTail = mid(tailLeft, tailRight);
    const bonePnts = [midTail].concat(raw.slice(2));
    const headPnts = this.getArrowHeadPoints(bonePnts, tailLeft, tailRight);
    const neckLeft = headPnts[0];
    const neckRight = headPnts[4];
    const tailWidthFactor = distance(tailLeft, tailRight) / getBaseLength(bonePnts);
    const bodyPnts = this.getArrowBodyPoints(bonePnts, neckLeft, neckRight, tailWidthFactor);

    const count = bodyPnts.length;
    const leftPnts0 = [tailLeft].concat(bodyPnts.slice(0, count / 2));
    leftPnts0.push(neckLeft);
    const rightPnts0 = [tailRight].concat(bodyPnts.slice(count / 2, count));
    rightPnts0.push(neckRight);

    const leftPnts = getQBSplinePoints(leftPnts0);
    const rightPnts = getQBSplinePoints(rightPnts0);
    return leftPnts.concat(headPnts, rightPnts.reverse());
  }

  /**
   * 由「已落点 [+ 光标]」算出这条绸带的闭合轮廓；点数不够或退化时返回 `null`。
   *
   * ★ 进门先把 `y` 取反（原版跑在地理坐标 y 向上，本引擎跑在屏幕坐标 y 向下），
   *   出门再取回来 —— 不取反形状会上下镜像（原版有手性相关分支，见文件头）。
   */
  private _ring(geo: LngLat[]): Ring | null {
    if (geo.length < 2) return null;
    // ★ 顶点先换算到**地面平面**再喂给 `buildRing()`（手性 = 'up'，对应原来那次 y 取反），
    //   算完折回经纬、逐点投影 —— 倾斜 / 旋转时形状跟着地面走（2026-09-18 修）。
    const f = this.groundFrameAt(geo[0][1]);
    const ring = this.buildRing(toPlane(geo, f));
    if (!ring) return null;
    const back = this.planeToScreen(ring, f);
    const finite = (p: ScreenPoint): boolean => Number.isFinite(p.x) && Number.isFinite(p.y);
    if (!back.every(finite)) return null;   // 退化输入可能吐 Infinity，交回默认
    return back;
  }

  describe(shape: Shape): string {
    return `${this.label} · ${shape.pts.length} 顶点`;
  }

  /** 轮廓画在锚点之外（箭头 / 绸带都往两侧探出），量整条轮廓定余量，避免滑出屏幕被误剔除。 */
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

  /** 自定义命中：量**真正画出来的那条闭合轮廓**，不是引擎默认的「骨架折线」。 */
  hitTest(shape: Shape, x: number, y: number, Pts: ScreenPoint[], tol: number): boolean | undefined {
    if (Pts.length < 2) return undefined;        // 形态超出预期 → 交回默认规则
    const ring = this._ring(shape.pts);
    if (!ring) return distToPolyline(x, y, Pts, false) <= tol;
    if (ring.length >= 3 && pointInRing(x, y, ring)) return true;
    return distToPolyline(x, y, ring, true) <= tol;
  }

  /** 已提交的形状：一条闭合的绸带（淡填充 + 轮廓；showLine 关掉就只留填充） */
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

  /** 手绘预览：与落地同一套几何；两击未满时退回「骨架折线 + 落点圆点」。 */
  preview(draw: DrawSession): void {
    const ctx = this.ctx, st = this.style;
    if (!ctx || !st) return;

    const geo = draw.pts.concat(draw.cursor ? [draw.cursor] : []);
    if (!geo.length) return;                       // 一击未落：不画
    const Pts = geo.map((p) => this.project(p));   // 只用来画落点圆点
    const ring = geo.length >= 2 ? this._ring(geo) : null;

    ctx.save();
    ctx.globalAlpha = 0.6;
    if (ring && ring.length >= 3) {
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
MapboxSketch.registerType(AttackArrowShape);
