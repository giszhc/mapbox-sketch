/* =====================================================================
 * shapes/rect.ts —— 内置类型：RectShape「矩形标注」。
 *
 * 存 2 个顶点：对角线上的两个角，矩形按**经纬度轴向**对齐：两条边平行经线、
 * 两条平行纬线。单击第一角、橡皮筋预览、第二击即成。
 *
 * ★★ 几何在**地理空间**定义（2026-09-18 修）：早先的实现是「两点投影成屏幕点、
 *   再取屏幕 min/max」—— 那是**屏幕轴对齐**：地图一带倾斜（pitch）或旋转
 *   （bearing），屏幕上的轴对齐就不再对应地面上的轴对齐，画出来的四边形跟着
 *   相机变来变去（用户实测报告的正是这个）。现在改成：先在经纬度里混合出
 *   **4 个地面角**（lng 取自一角、lat 取自另一角），再把 4 个角逐一投影。
 *   无倾斜 / 无旋转时与旧画法逐点相同；相机一动，四边形走真实投影 ——
 *   它仍然是「那块地面」的矩形，只是透视变了，形状本身不再漂。
 *
 * ★ 本类型只存 2 个点却画出 4 个角的四边形：另两个角（屏幕上）可能落在
 *   存储顶点包围盒之外（倾斜 / 旋转下），所以 hitTest 与 cullMargin 都按
 *   **整条四边形**算，不能按两点连线。
 * ===================================================================== */
import { distToPolyline, fmtM, gdM, pointInRing } from '../math';
import { drawDot } from '../paint';
import { MapboxSketch } from '../sketch';
import { MapboxShapeType } from '../sketch-shape-type';
import type { CfgKey, DrawSession, LngLat, ScreenPoint, Shape } from '../types';

/** 退化阈值(px)：投影后四边形任一方向比它还窄就是一条线，画不出「面」 */
const DEGENERATE = 0.5;

export class RectShape extends MapboxShapeType {
  get key(): string { return 'rect'; }
  get label(): string { return '矩形标注'; }
  get minPts(): number { return 2; }
  get autoCommit(): boolean { return true; }   // 两角即成

  cfgKeys(): CfgKey[] { return ['showLine']; } // 同「面」：轮廓可隐藏，只留淡填充

  get hint(): string {
    return '▭ 绘制<b>矩形标注</b>：单击第一个角，再单击<b>对角</b>（第二击即完成）<br />'
      + '・矩形沿经纬线对齐（倾斜 / 旋转地图时跟着地面走）　・拖角手柄＝改大小，拖内部＝平移　・<b>Esc</b>＝取消';
  }

  describe(shape: Shape): string {
    if (shape.pts.length < 2) return `${this.label} · ${shape.pts.length} 点`;
    const [a, b] = shape.pts;
    const w = gdM([a[0], a[1]], [b[0], a[1]]);   // 沿纬线的宽（经度差）
    const h = gdM([a[0], a[1]], [a[0], b[1]]);   // 沿经线的高（纬度差）
    return `矩形 · ${fmtM(w)} × ${fmtM(h)}`;
  }

  /**
   * 地面四角（经纬度混合）逐一投影后的屏幕四边形。
   * 渲染 / 命中 / 剔除 / 预览四处共用这一份 —— 几何只有这一处算式。
   */
  private _quad(a: LngLat, b: LngLat): ScreenPoint[] {
    const corners: LngLat[] = [
      [a[0], a[1]],
      [b[0], a[1]],
      [b[0], b[1]],
      [a[0], b[1]],
    ];
    return corners.map((c) => this.project(c));
  }

  /** 投影后任一方向比 DEGENERATE 还窄：那条「面」已经塌成线，画不出（不画也不命中） */
  private _visible(quad: ScreenPoint[]): boolean {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of quad) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    return maxX - minX > DEGENERATE && maxY - minY > DEGENERATE;
  }

  /**
   * 自定义命中：落在四边形面里（或贴边一圈容差）即算命中本体，
   * 使矩形可悬停变红 / 聚焦后拖两个对角手柄改大小。
   */
  hitTest(shape: Shape, x: number, y: number, Pts: ScreenPoint[], tol: number): boolean | undefined {
    if (Pts.length !== 2) return undefined;      // 形态超出预期 → 交回默认规则
    const quad = this._quad(shape.pts[0], shape.pts[1]);
    if (!this._visible(quad)) return false;      // 没画出来，也就不该被点中
    if (pointInRing(x, y, quad)) return true;    // 面内即本体（同「圆 / 椭圆」的口径）
    return distToPolyline(x, y, quad, true) <= tol;  // 贴着边一圈也算（与旧行为同方向）
  }

  /**
   * 剔除边距：倾斜 / 旋转下，另两个地面角的投影可能落在两存储顶点的包围盒之外
   * —— 按整条四边形量「伸出量」，加上线宽一半的余量。
   */
  cullMargin(shape: Shape): number {
    const Pts = this.projectPts(shape);
    if (Pts.length < 2) return 0;
    const quad = this._quad(shape.pts[0], shape.pts[1]);
    if (!this._visible(quad)) return 0;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of Pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    let reach = 0;
    for (const p of quad) {
      const dx = Math.max(minX - p.x, 0, p.x - maxX);
      const dy = Math.max(minY - p.y, 0, p.y - maxY);
      reach = Math.max(reach, Math.hypot(dx, dy));
    }
    const lw = this.styleFor(shape).pathWidth;
    return reach + ((typeof lw === 'number' && lw > 0 ? lw : 3) / 2 + 2);
  }

  /** 已提交的矩形：淡填充 + 描边（showLine 可只留填充） */
  render(shape: Shape): void {
    const ctx = this.ctx;
    const st = this.styleFor(shape);
    if (!ctx || shape.pts.length < 2) return;
    const quad = this._quad(shape.pts[0], shape.pts[1]);
    if (!this._visible(quad)) return;            // 退化：不画

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(quad[0].x, quad[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(quad[i].x, quad[i].y);
    ctx.closePath();
    ctx.fillStyle = st.polygonFill;
    ctx.fill();
    if (shape.cfg.showLine !== false) {
      ctx.lineWidth = st.pathWidth;
      ctx.strokeStyle = st.pathColor;
      ctx.globalAlpha = st.lineOpacity;
      ctx.stroke();
    }
    ctx.restore();
  }

  /** 手绘预览：第一角到光标的虚线矩形（同一套地面四角）+ 落点圆点 */
  preview(draw: DrawSession): void {
    const ctx = this.ctx, st = this.style;
    if (!ctx || !st) return;
    const anchor = draw.pts[0] ?? draw.cursor;   // 一击未落时在光标处示意
    if (!anchor) return;
    const A = this.project(anchor);
    if (!draw.pts.length || !draw.cursor) {
      ctx.save();
      ctx.globalAlpha = 0.6;
      drawDot(ctx, A.x, A.y, 5, st.previewColor);
      ctx.restore();
      return;
    }

    const quad = this._quad(anchor, draw.cursor);
    ctx.save();
    ctx.globalAlpha = 0.6;
    drawDot(ctx, A.x, A.y, 5, st.previewColor);
    if (this._visible(quad)) {
      ctx.strokeStyle = st.previewColor;
      ctx.lineWidth = 3;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(quad[0].x, quad[0].y);
      for (let i = 1; i < 4; i++) ctx.lineTo(quad[i].x, quad[i].y);
      ctx.closePath();
      ctx.stroke();
    }
    ctx.restore();
  }
}

/* 自注册：import 本文件即把类型收进静态注册表 */
MapboxSketch.registerType(RectShape);
