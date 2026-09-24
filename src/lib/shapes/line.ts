/* =====================================================================
 * shapes/line.ts —— 内置类型：LineShape「折线标注」。
 *
 * 折线标注：一条纯粹的多段折线，不写任何文字数字（要沿线文字用「路径文字」，
 * 要每段长度用「距离标注」）。
 * ===================================================================== */
import { lineDashFor, strokePolyline } from '../paint';
import { MapboxSketch } from '../sketch';
import { MapboxShapeType } from '../sketch-shape-type';
import { previewPolyline } from './helpers';
import type { CfgKey, DrawSession, Shape } from '../types';

export class LineShape extends MapboxShapeType {
  get key(): string { return 'line'; }
  get label(): string { return '折线标注'; }
  get minPts(): number { return 2; }
  get closesRing(): boolean { return false; }

  cfgKeys(): CfgKey[] { return []; }          // 折线标注：仅一根线条，无可调开关

  get hint(): string {
    return '〰 绘制<b>折线标注</b>：单击地图依次落点，直连成折线（无标注文字）<br />'
      + '・<b>双击</b> 或按 <b>回车</b>＝完成　・<b>右键</b>＝撤销上一点　・<b>Esc</b>＝取消';
  }

  describe(shape: Shape): string {
    return `${this.label} · ${shape.pts.length} 点`;
  }

  /** 已提交线的渲染：只有一条圆头折线 */
  render(shape: Shape): void {
    const ctx = this.ctx;
    const st = this.styleFor(shape);
    if (shape.pts.length < 2 || !ctx) return;
    strokePolyline(ctx, this.projectPts(shape), st.pathColor, st.pathWidth, lineDashFor(st.lineType, st.pathWidth), st.lineOpacity);
  }

  /** 手绘预览：虚线折线 + 落点圆点 */
  preview(draw: DrawSession): void {
    previewPolyline(this, draw);
  }
}

MapboxSketch.registerType(LineShape);
