/* =====================================================================
 * shapes/distance.ts —— 内置类型：DistanceShape「距离标注」。
 *
 * 距离标注：一条可多点的折线，在每个【拐点】旁水平标注走到这里的
 * 【累计里程】（起点 0，逐点累加，终点＝全程总长；白描边、2 位小数、
 * m/km 自适应），并沿线铺【密集等距刻度】（尺子样、无数值）。量路时
 * 每个转弯处都能直接读出已走过的距离。
 * ===================================================================== */
import { fmtM, gdM } from '../math';
import { denseTicks, haloText, lineDashFor, strokePolyline, upNormal } from '../paint';
import { MapboxSketch } from '../sketch';
import { MapboxShapeType } from '../sketch-shape-type';
import { outsideTextMargin, previewPolyline } from './helpers';
import type { CfgKey, DrawSession, Shape } from '../types';

export class DistanceShape extends MapboxShapeType {
  get key(): string { return 'distance'; }
  get label(): string { return '距离标注'; }
  get minPts(): number { return 2; }
  get closesRing(): boolean { return false; }

  cfgKeys(): CfgKey[] { return ['ticks']; }   // 刻度可整体关掉（测量工具就是这么关的）

  get hint(): string {
    return '📏 绘制<b>距离标注</b>：单击地图依次落点，<b>每个拐点标注累计里程</b><br />'
      + '・<b>双击</b> 或按 <b>回车</b>＝完成　・<b>右键</b>＝撤销上一点　・<b>Esc</b>＝取消';
  }

  /** 拐点旁的水平里程文字画在顶点之外，剔除时放宽 */
  cullMargin(shape: Shape): number { return outsideTextMargin(this, shape, 34); }

  describe(shape: Shape): string {
    return `${this.label} · ${shape.pts.length} 点`;
  }

  /** 已提交距离标注的渲染：折线 + 密集刻度 + 每个拐点的累计里程 */
  render(shape: Shape): void {
    const ctx = this.ctx;
    const st = this.styleFor(shape);
    const orig = shape.pts;
    const n = orig.length;
    if (n < 2 || !ctx) return;

    const Pts = this.projectPts(shape);

    // 1) 折线本身
    strokePolyline(ctx, Pts, st.pathColor, st.pathWidth, lineDashFor(st.lineType, st.pathWidth), st.lineOpacity);

    // 2) 每个拐点「走到这里」的累计里程（米；折点间取测地线距离累加）
    //    cum[i] = 起点→第 i 个拐点的距离；cum[n-1] 即全程总长（标在终点旁）
    const cum = [0];
    for (let i = 1; i < n; i++) cum.push(cum[i - 1] + gdM(orig[i - 1], orig[i]));

    // 3) 密集等距刻度：沿线每隔固定像素一根垂直小短线，无数值（尺子样）。
    //    cfg.ticks 可整体关掉 —— 测量工具（MapboxSketchMeasure）就是用
    //    defaultCfg { ticks:false } 关的，标注引擎保持出厂的 true
    if (shape.cfg.ticks !== false) {
      denseTicks(ctx, Pts, {
        gap: 18, pos: st.tickPos, lineWidth: st.pathWidth, tickLen: 7,
        color: st.pathColor, width: 1.4, alpha: 0.55,
      });
    }

    // ★ 顶点圆点 2026-09 去掉了（见 AGENTS.md「顶点记号」）。这里尤其该去：
    //   每个拐点旁本来就贴着一行蓝色里程文字，圆点只是把同一个位置再说一遍。

    // 4) 每个拐点旁水平标注累计里程（不随线段旋转）：起点 0m，终点＝全程总长
    const off = st.pathWidth / 2 + 14;
    for (let i = 0; i < n; i++) {
      const p = Pts[i];
      // 标注放在该点沿线方向的上侧；末点沿用最后一段的方向
      const ref = i < n - 1 ? Pts[i + 1] : Pts[i - 1];
      const ang = Math.atan2(ref.y - p.y, ref.x - p.x);
      const u = upNormal(ang);                 // 屏幕「上侧」法线
      haloText(ctx, p.x + u.x * off, p.y + u.y * off, i === 0 ? '0m' : fmtM(cum[i]), {
        size: 12, fill: st.vertexColor, halo: st.haloColor, width: st.haloWidth,
      });
    }
  }

  /** 手绘预览：虚线折线 + 落点圆点 */
  preview(draw: DrawSession): void {
    previewPolyline(this, draw);
  }
}

MapboxSketch.registerType(DistanceShape);
