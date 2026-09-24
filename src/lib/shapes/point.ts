/* =====================================================================
 * shapes/point.ts —— 内置类型：PointShape「点标注」。
 *
 * 单击地图一下即生成一个圆点标记（autoCommit = true：达到最少点数自动完成，
 * 无需双击 / 回车）。点标注无文字、无可调开关；半径走样式键 pointRadius。
 * ===================================================================== */
import { drawDot } from '../paint';
import { MapboxSketch } from '../sketch';
import { MapboxShapeType } from '../sketch-shape-type';
import type { CfgKey, DrawSession, Shape } from '../types';

export class PointShape extends MapboxShapeType {
  get key(): string { return 'point'; }
  get label(): string { return '点标注'; }
  get minPts(): number { return 1; }
  get autoCommit(): boolean { return true; }   // 单击一次即完成，无需双击 / 回车

  cfgKeys(): CfgKey[] { return []; }           // 点标注没有可调开关

  get hint(): string {
    return '📍 绘制<b>点标注</b>：在地图上单击一下即生成一个圆点，<b>无需双击/回车</b><br />'
      + '・画下一个点请再次点击本按钮';
  }

  /** 外圈淡晕的半径倍数（也是剔除时要留的边距来源） */
  private get haloScale(): number { return 2.3; }

  /** 外圈淡晕会超出顶点，剔除时按它放宽 */
  cullMargin(shape: Shape): number {
    return (this.styleFor(shape).pointRadius || 6) * this.haloScale;
  }

  describe(): string {
    return `${this.label} ×1`;
  }

  /** 已提交的点：外圈淡晕 + 实心圆点 + 白描边；悬停时外圈加红色虚线圆 */
  render(shape: Shape): void {
    const ctx = this.ctx;
    const st = this.styleFor(shape);
    const pt = this.projectPts(shape)[0];
    if (!ctx || !pt) return;
    const r = st.pointRadius || 6;

    ctx.save();
    // 外圈淡晕：让点更醒目
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = st.pointColor;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, r * this.haloScale, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    drawDot(ctx, pt.x, pt.y, r, st.pointColor);
    ctx.restore();

    // 编辑态悬停反馈：整片点体（无顶点区分）上画一个红色虚线圆圈，
    // 半径与 pointRadius 一起伸缩（= 点体命中范围），提示「这点可拖动」。
    if (this.isHovered(shape)) {
      const rr = Math.max(r + 8, 18);
      ctx.save();
      ctx.strokeStyle = this.hoverColor;       // 全局项，见基类的 hoverColor getter
      ctx.lineWidth = 1.6;
      ctx.setLineDash([5, 4]);                 // 虚线圆圈
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, rr, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();                           // restore 一并复位 lineDash
    }
  }

  /** 手绘预览：光标处一个半透明候选点 */
  preview(draw: DrawSession): void {
    const ctx = this.ctx, st = this.style;
    if (!draw.cursor || !ctx || !st) return;
    const p = this.project(draw.cursor);
    ctx.save();
    ctx.globalAlpha = 0.4;
    drawDot(ctx, p.x, p.y, st.pointRadius || 6, st.previewColor);
    ctx.restore();
  }
}

MapboxSketch.registerType(PointShape);
