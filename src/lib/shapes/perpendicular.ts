/* =====================================================================
 * shapes/perpendicular.ts —— 内置类型：PerpendicularShape「垂直线标注」。
 *
 * ★★ 本类型是**新画**的（用户 2026-09-18 要求新增）—— 标绘库 mapbox-plot 里
 *   没有对应的 Plot，口径按「直箭头标注」的先例：交互与几何自己定，文件头写清楚，
 *   **不是移植**。
 *
 * ## 画法与几何（三击即成，同「扇形 / 弧线」那一路）
 *
 *   单击定<b>基准线</b>起点 → 单击定基准线终点 → 移动鼠标把垂直线摆到位 → 第三击完成。
 *
 * 存 3 个顶点 [P0, P1, C]，画出来是一个「⊥」：
 *   · 基准线 = P0 → P1；
 *   · 垂直线段从基准线的**中点 M** 出发，沿垂直方向，端点
 *     E = M + n·((C − M)·n)（n 是基准线的单位法向量）——
 *     即 **C 在「过 M 的垂直线」上的投影**。所以垂直线的长度与朝哪边都由第三点定，
 *     E 永远在图形上（就是垂直线段的那个自由端）。
 *
 * ★ 纯线（两条断开的线段），不填充 —— 同「曲线 / 弧线」的图面口径。
 * ★ 几何是普通屏幕向量运算，**不跑原版的方位角 / 手性那套**，也就**不需要 y 翻转**
 *   （只有 mapbox-plot 移植的类型才翻，见 attack-arrow.ts 文件头）。
 * ★ 退化：基准线两点重合画不出；C 正好落在 M 上（垂直线长度为 0）时只画基准线。
 * ===================================================================== */
import { distToPolyline } from '../math';
import { drawDot, lineDashFor, strokePolyline } from '../paint';
import { MapboxSketch } from '../sketch';
import { toPlane } from '../ground-frame';
import { MapboxShapeType } from '../sketch-shape-type';
import type { LngLat, CfgKey, DrawSession, ScreenPoint, Shape } from '../types';

/** 两条线段的屏幕几何（第二条可能不画 —— 长度为 0 时省略） */
type Segs = ScreenPoint[][];

/** 垂直线长度小于这么多像素时视为没画（`atan2` 级别的抖动滤掉） */
const MIN_PERP_LEN = 0.5;

export class PerpendicularShape extends MapboxShapeType {
  get key(): string { return 'perpendicular'; }
  get label(): string { return '垂直线标注'; }
  get minPts(): number { return 3; }
  get autoCommit(): boolean { return true; }   // 三击即成：基准线两端 + 垂直线端点

  cfgKeys(): CfgKey[] { return []; }           // 纯线，无可调开关（同「曲线」）

  get hint(): string {
    return '⊥ 绘制<b>垂直线标注</b>：单击定<b>基准线</b>两端 → 移动鼠标把垂直线摆到位 →'
      + '第三击即完成<br />'
      + '・垂直线从基准线<b>中点</b>立起、与基准线<b>恒成直角</b>，第三点定它的<b>高度与朝向</b>（拖端点＝改高度）<br />'
      + '・两点重合画不出　・<b>Esc</b>＝取消';
  }

  /* ---------------- 几何：渲染 / 命中 / 剔除 / 预览四处共用同一份算式 ---------------- */

  /**
   * 两条线段：基准 [P0,P1] + 从中点立起的垂直线段 [M, E]。
   * 返回 `null` ＝ 画不出（基准线两点重合）；垂直线长度 ≈ 0 时只返回基准线。
   */
  private _segs(geo: LngLat[]): Segs | null {
    if (geo.length !== 3) return null;
    // ★ 几何在地面平面上算（手性 'down'：算式直接按屏幕坐标写的；法向量的手性也
    //   跟着它走，所以手性必须一致），出来的点再折回经纬投影 —— 倾斜 / 旋转时
    //   两条线跟着地面走真实投影（2026-09-18 修）。
    const f = this.groundFrameAt(geo[0][1]);
    const [P0, P1, C] = toPlane(geo, f, 'down');
    const dx = P1.x - P0.x, dy = P1.y - P0.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return null;
    const n = { x: -dy / len, y: dx / len };          // 单位法向量
    const M = { x: (P0.x + P1.x) / 2, y: (P0.y + P1.y) / 2 };
    const t = (C.x - M.x) * n.x + (C.y - M.y) * n.y;  // C 在法向上的投影距离（带符号）
    const planeSegs: ScreenPoint[][] = [[P0, P1]];
    if (Math.abs(t) >= MIN_PERP_LEN) {
      planeSegs.push([M, { x: M.x + n.x * t, y: M.y + n.y * t }]);
    }
    return planeSegs.map((seg) => this.planeToScreen(seg, f, 'down')) as Segs;
  }

  describe(shape: Shape): string {
    return `${this.label} · ${shape.pts.length} 点`;
  }

  /** 垂直线立出三点包围盒（第三点摆得远时），量全部画出的点定余量。 */
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
MapboxSketch.registerType(PerpendicularShape);
