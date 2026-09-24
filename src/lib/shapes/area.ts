/* =====================================================================
 * shapes/area.ts —— 内置类型：AreaShape「面积标注」。
 *
 * 面积标注：一个闭合多边形（淡面填充 + 轮廓），在【每条边的中点】标注
 * 这一段的【边长】（水平、白描边、2 位小数、m/km 自适应），边界再铺
 * 【密集等距刻度】（尺子样、无数值），形心处再标「面积 / 周长」。用作圈地量算。
 * ===================================================================== */
import { fmtArea, fmtM, gdM, polyAreaM2, screenCenter } from '../math';
import { denseTicks, fillRing, haloText, lineDashFor, strokePolyline } from '../paint';
import { MapboxSketch } from '../sketch';
import { MapboxShapeType } from '../sketch-shape-type';
import { outsideTextMargin, previewRing } from './helpers';
import type { CfgKey, DrawSession, ScreenPoint, Shape } from '../types';

export class AreaShape extends MapboxShapeType {
  get key(): string { return 'area'; }
  get label(): string { return '面积标注'; }
  get minPts(): number { return 3; }
  get closesRing(): boolean { return true; }

  cfgKeys(): CfgKey[] { return ['showLine', 'ticks']; }

  get hint(): string {
    return '▰ 绘制<b>面积标注</b>：单击地图依次落点自动闭合，<b>每条边中间标边长</b><br />'
      + '・<b>双击</b> 或按 <b>回车</b>＝完成　・<b>右键</b>＝撤销上一点　・<b>Esc</b>＝取消';
  }

  /** 边中点的边长文字画在环之外，剔除时放宽 */
  cullMargin(shape: Shape): number { return outsideTextMargin(this, shape, 26); }

  describe(shape: Shape): string {
    return `${this.label} · ${shape.pts.length} 顶点`;
  }

  /** 边中点的外扩方向：边的单位法向，翻到「背离形心」一侧（文字落在面外）。protected：测面的渲染变体（MeasureAreaShape）复用 */
  protected _outwardAt(ring: ScreenPoint[], i: number, ctr: ScreenPoint): ScreenPoint {
    const n = ring.length;
    const a = ring[i], b = ring[(i + 1) % n];       // 本条边的两个端点
    const ex = b.x - a.x, ey = b.y - a.y;
    const L = Math.hypot(ex, ey) || 1;
    // 边的两个单位法向（取边顺时针 / 逆时针旋转 90°）
    let dx = -ey / L, dy = ex / L;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;   // 边中点
    // 法向若指向形心则翻面，保证文字在面外而非面里
    if (dx * (mx - ctr.x) + dy * (my - ctr.y) < 0) { dx = -dx; dy = -dy; }
    return { x: dx, y: dy };
  }

  /** 已提交面积标注的渲染：淡面填充 + 闭合轮廓 + 密刻度 + 每条边中点边长 + 形心面积 */
  render(shape: Shape): void {
    const ctx = this.ctx;
    const st = this.styleFor(shape);
    const cfg = shape.cfg;
    const orig = shape.pts;
    const n = orig.length;
    if (n < 3 || !ctx) return;

    const ring = this.projectPts(shape);
    const closed = ring.concat([ring[0]]);

    // 1) 面内淡填充
    fillRing(ctx, ring, st.polygonFill);

    // 2) 闭合轮廓线（可隐藏，边长 / 周长文字仍显示）
    if (cfg.showLine !== false) {
      strokePolyline(ctx, closed, st.pathColor, st.pathWidth, lineDashFor(st.lineType, st.pathWidth), st.lineOpacity);
    }

    // 3) 每条边的边长（米；沿原坐标测地距离，不受屏幕缩放影响）
    const segM: number[] = [];
    for (let i = 0; i < n; i++) segM.push(gdM(orig[i], orig[(i + 1) % n]));
    const perim = segM.reduce((a, v) => a + v, 0);   // 各边之和 = 总周长

    // 4) 密集等距刻度：沿闭合环每隔固定像素一根垂直小短线，无数值（尺子样）。
    //    cfg.ticks 可整体关掉 —— 测量工具（MapboxSketchMeasure）就是用
    //    defaultCfg { ticks:false } 关的，标注引擎保持出厂的 true
    if (cfg.ticks !== false) {
      denseTicks(ctx, closed, {
        gap: 18, pos: st.tickPos, lineWidth: st.pathWidth, tickLen: 7,
        color: st.pathColor, width: 1.4, alpha: 0.55,
      });
    }

    // 5) 每条边中点外侧标注「这一段」的边长（水平、2 位小数、m/km 自适应）
    const ctr = screenCenter(ring);
    const off = st.pathWidth / 2 + 14;
    for (let i = 0; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % n];
      const o = this._outwardAt(ring, i, ctr);       // 边中点沿法向外移
      haloText(ctx, (a.x + b.x) / 2 + o.x * off, (a.y + b.y) / 2 + o.y * off,
        fmtM(segM[i]), { size: 12, fill: st.vertexColor, halo: st.haloColor, width: st.haloWidth });
    }

    // 6) 形心：面积（面积加权中心，落在面内）；其下补一行「周长 xx」
    const ctrText = '面积 ' + fmtArea(polyAreaM2(orig));
    haloText(ctx, ctr.x, ctr.y - 9, ctrText,
      { size: 15, fill: st.areaColor, halo: st.haloColor, width: st.haloWidth });
    haloText(ctx, ctr.x, ctr.y + 9, '周长 ' + fmtM(perim),
      { size: 12, fill: st.areaColor, halo: st.haloColor, width: st.haloWidth });
  }

  /** 手绘预览：淡面填充 + 闭合虚线环 + 落点圆点 */
  preview(draw: DrawSession): void {
    previewRing(this, draw);
  }
}

MapboxSketch.registerType(AreaShape);
