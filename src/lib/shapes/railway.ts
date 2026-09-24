/* =====================================================================
 * shapes/railway.ts —— 内置类型：RailwayShape「铁路标注」。
 *
 * ★★ 本类型是**新画**的（用户 2026-09-18 要求新增）—— 标绘库 mapbox-plot 里没有
 *   对应的 Plot，口径按「平行线 / 垂直线标注」的先例：交互与符号自己定、文件头写清楚，
 *   **不是移植**。
 *
 * ## 符号：钢轨 + 枕木
 *
 * 一条实线（钢轨）＋ 沿线每隔 `TIE_GAP` 像素画一根**垂直于线**的短刻线（枕木）——
 * 这是地图上最通用的铁路符号。枕木与主线同色，比主线细（免得盖过钢轨本身）。
 *
 *   ・主线：`pathColor / pathWidth / lineOpacity`
 *   ・枕木：同色；长度 = `lineW × 2 + 8`（3px 线宽 ⇒ 14px），自身线宽 = `lineW × 0.55`
 *
 * ## 间距为什么是屏幕像素
 *
 * 见 `line-deco.ts` 的文件头：带状符号是「符号」不是「实物的等比模型」，缩放时
 * 图案间距在屏幕上恒定才是制图惯例（本仓库既有的 `paint.denseTicks` 同一口径）。
 *
 * ## 枕木算在地面平面上（不是屏幕坐标）
 *
 * 「垂直于线」是**地面上的垂直**，不是屏幕上的垂直：地图一倾斜，南北向被压扁，
 * 屏幕上看着「垂直」的枕木在真实地图上其实是歪的（用户报的「视角倾斜后变形」）。
 * 所以枕木的落点与方向都在 `g.plane`（地面平面）上算完，再经 `g.toSegs` 逐点
 * 投影 —— 倾斜时枕木会按真实透视变短、仍牢牢垂直于它脚下那段钢轨。详见
 * `line-deco.ts` 的文件头。
 *
 * ## 绘制方式
 *
 * 逐点落点、双击 / 回车完成（`minPts = 2`，同「折线标注」）—— 铁路是一条折线地物。
 * ===================================================================== */
import { upNormal } from '../paint';
import { MapboxSketch } from '../sketch';
import { LineDecoShape } from './line-deco';
import type { DecoFrame, Seg } from './line-deco';
import type { CfgKey, Style } from '../types';

/** 枕木沿线的屏幕间距(px)：小一点才看得出「铁路」，大了像梯子 */
const TIE_GAP = 9;
/** 枕木长度 = 主线线宽 × 这个系数 + 这个常数(px) */
const TIE_LEN_K = 2;
const TIE_LEN_M = 8;
/** 枕木自身的线宽 = 主线线宽 × 这个比例（比主线细，别盖过钢轨） */
const TIE_W_K = 0.55;

export class RailwayShape extends LineDecoShape {
  get key(): string { return 'railway'; }
  get label(): string { return '铁路标注'; }

  cfgKeys(): CfgKey[] { return []; }

  get hint(): string {
    return '🚂 绘制<b>铁路标注</b>：单击地图依次落点连成铁路（实线钢轨 + 沿线枕木）<br />'
      + '・粗细在右侧面板调「线宽」——枕木的长短会跟着它一起变<br />'
      + '・<b>双击</b> 或按 <b>回车</b>＝完成　・<b>右键</b>＝撤销上一点　・<b>Esc</b>＝取消';
  }

  /** 一根枕木的长度(px)，由主线线宽定 */
  private tieLen(st: Style): number {
    return this.lineW(st) * TIE_LEN_K + TIE_LEN_M;
  }

  /** 枕木向主线两侧各伸出「长度的一半」 */
  protected reach(st: Style): number {
    return this.tieLen(st) / 2 + 1;
  }

  protected paintDeco(
    ctx: CanvasRenderingContext2D, g: DecoFrame, st: Style,
  ): void {
    this.strokeBase(ctx, g.base, st);                    // 钢轨（投影后的顶点，不走平面）

    const half = this.tieLen(st) / 2;
    const segs: Seg[] = [];
    this.alongMarks(g.plane, TIE_GAP, (x, y, ang) => {
      const n = upNormal(ang);                           // 垂直于线的那一侧（平面上的垂直）
      segs.push([
        { x: x - n.x * half, y: y - n.y * half },
        { x: x + n.x * half, y: y + n.y * half },
      ]);
    });
    // 两端点各自投影 ⇒ 倾斜时枕木跟着地面被透视压缩
    this.strokeSegs(ctx, g.toSegs(segs), st.pathColor, Math.max(1, this.lineW(st) * TIE_W_K), st.lineOpacity);
  }
}

/* 自注册：import 本文件即把类型收进静态注册表 */
MapboxSketch.registerType(RailwayShape);
