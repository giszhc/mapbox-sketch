/* =====================================================================
 * shapes/pipeline.ts —— 内置类型：PipelineShape「管道 / 光缆标注」。
 *
 * ★★ 本类型是**新画**的（用户 2026-09-18 要求新增）—— 标绘库 mapbox-plot 里没有
 *   对应的 Plot，口径按「平行线 / 垂直线标注」的先例：交互与符号自己定、文件头写清楚，
 *   **不是移植**。
 *
 * ## 符号：双线
 *
 * 两条**等距平行**的细线，中间留白 —— 地图上表示埋地管线（油气管道 / 通信光缆 /
 * 输水管）的通用符号。它跟「平行线标注」看着像，但**不是一回事**：
 *
 *   · 平行线标注存 3 个顶点（基准线两端 + 平行线起点），平行线是**用户摆过去的**
 *     一条独立线段，两线可以不等长、也不要求等距；
 *   · 本类型存 2+ 个顶点（就是这条管线本身），两条线是**由它偏置出来**的 ——
 *     永远等距、永远等长、永远跟着走向弯，它是一条线状地物，不是两段几何关系。
 *
 * ## 几何
 *
 * 偏置走 `math.offsetPolyline`（斜接：顶点沿角平分线走，拐角处两侧仍严丝合缝，
 * 而不是各自按自己那一段的法线挪、在拐角上裂开一道口子）。
 *
 *   ・两条线同色：`pathColor`；不透明度：`lineOpacity`
 *   ・每条线到主线的距离 = `lineW × 0.9 + 1.5`、自身线宽 = `lineW × 0.55`
 *     （3px 线宽 ⇒ 中线相距 8.4px、每条 1.65px 宽，中间留白约 6.7px）
 *   ★ `pathWidth` 在这里是**整个符号的粗细基准**：把它调大，两条线一起变粗、
 *     间距也一起变宽（管线符号放大），比例不会走样。
 *
 * ## 偏置算在地面平面上（不是屏幕坐标）
 *
 * 「等距」是**地面上的等距**：地图一倾斜，南北向被压扁，若在屏幕坐标里偏置，
 * 两条线在屏幕上看还是一样宽，可落到地图上就变成一侧宽一侧窄（用户报的
 * 「视角倾斜后变形」）。所以偏置在 `g.plane`（地面平面）上算完，再经
 * `g.toScreenAll` 逐点投影 —— 倾斜后两条线仍是一条真管线的两侧边界。
 * 详见 `line-deco.ts` 的文件头。
 *
 * ## 绘制方式
 *
 * 逐点落点、双击 / 回车完成（`minPts = 2`，同「折线标注」）。
 * ===================================================================== */
import { offsetPolyline } from '../math';
import { strokePolyline } from '../paint';
import { MapboxSketch } from '../sketch';
import { LineDecoShape } from './line-deco';
import type { DecoFrame } from './line-deco';
import type { CfgKey, Style } from '../types';

/** 每条线到主线的距离 = 主线线宽 × 系数 + 常数(px) */
const OFF_K = 0.9;
const OFF_M = 1.5;
/** 每条线自身的线宽 = 主线线宽 × 这个比例 */
const LINE_W_K = 0.55;

export class PipelineShape extends LineDecoShape {
  get key(): string { return 'pipeline'; }
  get label(): string { return '管道 / 光缆标注'; }

  cfgKeys(): CfgKey[] { return []; }

  get hint(): string {
    return '🛢 绘制<b>管道 / 光缆标注</b>：单击地图依次落点连成一条双线'
      + '（油气管道 / 通信光缆 / 输水管通用符号）<br />'
      + '・两条线永远等距平行、跟着走向弯；粗细在右侧面板调「线宽」<br />'
      + '・<b>双击</b> 或按 <b>回车</b>＝完成　・<b>右键</b>＝撤销上一点　・<b>Esc</b>＝取消';
  }

  /** 两条线到主线的距离 + 线自身的一半 */
  protected reach(st: Style): number {
    const w = this.lineW(st);
    return w * OFF_K + OFF_M + Math.max(1, w * LINE_W_K) / 2 + 1;
  }

  protected paintDeco(
    ctx: CanvasRenderingContext2D, g: DecoFrame, st: Style,
  ): void {
    const w = this.lineW(st);
    const off = w * OFF_K + OFF_M;
    const lw = Math.max(1, w * LINE_W_K);
    // ★ 主线这里不画（两条偏置线就是符号本体）。正负号的口径同 `paint.upNormal`（正 = 平面「上侧」）
    strokePolyline(ctx, g.toScreenAll(offsetPolyline(g.plane, off)), st.pathColor, lw, null, st.lineOpacity);
    strokePolyline(ctx, g.toScreenAll(offsetPolyline(g.plane, -off)), st.pathColor, lw, null, st.lineOpacity);
  }
}

/* 自注册：import 本文件即把类型收进静态注册表 */
MapboxSketch.registerType(PipelineShape);
