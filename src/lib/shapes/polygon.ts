/* =====================================================================
 * shapes/polygon.ts —— 内置类型：PolygonShape「多边形标注」。
 *
 * 多边形标注：一个闭合多边形，只表现「一块区域」—— 淡面填充 + 轮廓线，
 * 不写任何文字数字（面积 / 周长请用「面积标注」类型）。
 * ===================================================================== */
import { fillRing, lineDashFor, strokePolyline } from '../paint';
import { MapboxSketch } from '../sketch';
import { MapboxShapeType } from '../sketch-shape-type';
import { previewRing } from './helpers';
import type { CfgKey, DrawSession, Shape } from '../types';

export class PolygonShape extends MapboxShapeType {
  get key(): string { return 'polygon'; }
  get label(): string { return '多边形标注'; }
  get minPts(): number { return 3; }
  get closesRing(): boolean { return true; }

  cfgKeys(): CfgKey[] { return ['showLine']; }

  get hint(): string {
    return '▱ 绘制<b>多边形标注</b>：单击地图依次落点，自动淡填充成一块区域<br />'
      + '・<b>双击</b> 或按 <b>回车</b>＝完成　・<b>右键</b>＝撤销上一点　・<b>Esc</b>＝取消';
  }

  describe(shape: Shape): string {
    return `${this.label} · ${shape.pts.length} 顶点`;
  }

  /** 已提交面的渲染：淡面填充 + 闭合轮廓（纯区域，不带文字数字） */
  render(shape: Shape): void {
    const ctx = this.ctx;
    const st = this.styleFor(shape);
    const cfg = shape.cfg;
    if (shape.pts.length < 3 || !ctx) return;

    const ring = this.projectPts(shape);          // 屏幕顶点（走投影缓存）
    const closed = ring.concat([ring[0]]);        // 补首点成闭合环

    // 1) 面内淡填充（画在轮廓线之下）
    fillRing(ctx, ring, st.polygonFill);

    // 2) 闭合轮廓线（直边；可隐藏）
    if (cfg.showLine !== false) {
      strokePolyline(ctx, closed, st.pathColor, st.pathWidth, lineDashFor(st.lineType, st.pathWidth), st.lineOpacity);
    }

    // ★ 顶点圆点 2026-09 去掉了：面的拐点靠轮廓自己就看得出来，而那一圈蓝点
    //   在成图里比轮廓还抢眼（详见 AGENTS.md「顶点记号」）。
  }

  /** 手绘预览：淡面填充 + 闭合虚线环 + 落点圆点 */
  preview(draw: DrawSession): void {
    previewRing(this, draw);
  }
}

MapboxSketch.registerType(PolygonShape);
