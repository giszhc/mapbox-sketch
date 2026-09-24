/* =====================================================================
 * shapes/parallel.ts —— 内置类型：ParallelShape「平行线标注」。
 *
 * ★★ 本类型是**新画**的（用户 2026-09-18 要求新增）—— 标绘库 mapbox-plot 里
 *   没有对应的 Plot（它的 PlotTypes 全集见 `PlotTypes.js`，没有平行/垂直线），
 *   口径按「直箭头标注」的先例：交互与几何自己定，文件头写清楚，**不是移植**。
 *
 * ## 画法与几何（三击即成，同「扇形 / 弧线」那一路）
 *
 *   单击定<b>基准线</b>起点 → 单击定基准线终点 → 移动鼠标把平行线摆到位 → 第三击完成。
 *
 * 存 3 个顶点 [P0, P1, C]，**三个落点都在图形上**：
 *   · 基准线 = P0 → P1；
 *   · 平行线 = C → C + (P1 − P0) —— 它就是基准线段的**平移副本**（平行、等长），
 *     C 是它的起点：拖 C＝整条平行线跟着平移（永远与基准线平行，方向不会画歪）；
 *     两条线的间距＝C 到基准线所在直线的距离，侧向由 C 在哪一侧定。
 *
 * ★ 纯线（两条断开的线段），不填充 —— 同「曲线 / 弧线」的图面口径。
 * ★ 几何是普通屏幕向量运算，**不跑原版的方位角 / 手性那套**，也就**不需要 y 翻转**
 *   （只有 mapbox-plot 移植的类型才翻，见 attack-arrow.ts 文件头）。
 * ★ 基准线退化成一点（P0 == P1）时画不出；C 与 P0 重合时两条线叠在一起（无害，照画）。
 * ===================================================================== */
import { distToPolyline } from '../math';
import { drawDot, lineDashFor, strokePolyline } from '../paint';
import { MapboxSketch } from '../sketch';
import { toPlane } from '../ground-frame';
import { MapboxShapeType } from '../sketch-shape-type';
import type { LngLat, CfgKey, DrawSession, ScreenPoint, Shape } from '../types';

/** 两条线段的屏幕几何 */
type Segs = [ScreenPoint[], ScreenPoint[]];

export class ParallelShape extends MapboxShapeType {
  get key(): string { return 'parallel'; }
  get label(): string { return '平行线标注'; }
  get minPts(): number { return 3; }
  get autoCommit(): boolean { return true; }   // 三击即成：基准线两端 + 平行线起点

  cfgKeys(): CfgKey[] { return []; }           // 纯线，无可调开关（同「曲线」）

  get hint(): string {
    return '∥ 绘制<b>平行线标注</b>：单击定<b>基准线</b>两端 → 移动鼠标把平行线摆到位 →'
      + '第三击即完成<br />'
      + '・平行线是基准线的<b>平移副本</b>（平行、等长），第三点＝平行线的起点，拖它＝平移整条平行线<br />'
      + '・两点重合画不出　・<b>Esc</b>＝取消';
  }

  /* ---------------- 几何：渲染 / 命中 / 剔除 / 预览四处共用同一份算式 ---------------- */

  /**
   * 两条线段：基准 [P0,P1] + 平移副本 [C, C+(P1−P0)]。
   * 返回 `null` ＝ 画不出（基准线两点重合）。
   */
  private _segs(geo: LngLat[]): Segs | null {
    if (geo.length !== 3) return null;
    // ★ 几何在地面平面上算（手性 'down'：本类型的算式直接按屏幕坐标写的），
    //   出来的点再折回经纬、逐点投影 —— 倾斜 / 旋转时两条线跟着地面走真实投影
    //   （2026-09-18 修）。
    const f = this.groundFrameAt(geo[0][1]);
    const [P0, P1, C] = toPlane(geo, f, 'down');
    if (Math.hypot(P1.x - P0.x, P1.y - P0.y) < 1e-6) return null;
    const base: ScreenPoint[] = [P0, P1];
    const copy: ScreenPoint[] = [C, { x: C.x + (P1.x - P0.x), y: C.y + (P1.y - P0.y) }];
    return [this.planeToScreen(base, f, 'down'), this.planeToScreen(copy, f, 'down')];
  }

  describe(shape: Shape): string {
    return `${this.label} · ${shape.pts.length} 点`;
  }

  /** 平行线整体画在三点包围盒之外（副本可能平移出去），量全部画出的点定余量。 */
  cullMargin(shape: Shape): number {
    const lw = this.styleFor(shape).pathWidth;
    const pad = (typeof lw === 'number' && lw > 0 ? lw : 3) / 2 + 4;
    const Pts = this.projectPts(shape);
    if (Pts.length < 2) return pad;
    const segs = this._segs(shape.pts);
    if (!segs) return pad;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of Pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    let reach = 0;
    for (const seg of segs) {
      for (const p of seg) {
        const dx = Math.max(minX - p.x, 0, p.x - maxX);
        const dy = Math.max(minY - p.y, 0, p.y - maxY);
        reach = Math.max(reach, Math.hypot(dx, dy));
      }
    }
    return reach + pad;
  }

  /** 自定义命中：贴着**任意一条**线段都算命中本体（引擎默认只认存储顶点的连线）。 */
  hitTest(shape: Shape, x: number, y: number, Pts: ScreenPoint[], tol: number): boolean | undefined {
    if (Pts.length !== 3) return undefined;      // 形态超出预期 → 交回默认规则
    const segs = this._segs(shape.pts);
    if (!segs) return false;                     // 退化：没画出来，也就不该被点中
    return segs.some((seg) => distToPolyline(x, y, seg, false) <= tol);
  }

  /** 已提交的图形：两条圆头线段（不填充） */
  render(shape: Shape): void {
    const ctx = this.ctx;
    if (!ctx || shape.pts.length < 3) return;
    const segs = this._segs(shape.pts);
    if (!segs) return;                           // 退化：不画
    const st = this.styleFor(shape);
    for (const seg of segs) {
      strokePolyline(ctx, seg, st.pathColor, st.pathWidth, lineDashFor(st.lineType, st.pathWidth), st.lineOpacity);
    }
  }

  /** 手绘预览：与落地同一套几何的虚线 + 各落点圆点。 */
  preview(draw: DrawSession): void {
    const ctx = this.ctx, st = this.style;
    if (!ctx || !st) return;
    const geo = draw.pts.concat(draw.cursor ? [draw.cursor] : []);
    if (!geo.length) return;
    const raw = geo.map((p) => this.project(p));

    ctx.save();
    ctx.globalAlpha = 0.6;
    if (raw.length === 2) {
      // 还没落第三点：先把基准线用虚线连上（同折线预览）
      strokePolyline(ctx, raw, st.previewColor, 3, [3, 3]);
    } else {
      const segs = this._segs(geo);
      if (segs) {
        for (const seg of segs) strokePolyline(ctx, seg, st.previewColor, 3, [3, 3]);
      }
    }
    raw.forEach((p) => drawDot(ctx, p.x, p.y, 5, st.previewColor));
    ctx.restore();
  }
}

/* 自注册：import 本文件即把类型收进静态注册表 */
MapboxSketch.registerType(ParallelShape);
