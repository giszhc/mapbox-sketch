/* =====================================================================
 * shapes/powerline.ts —— 内置类型：PowerlineShape「高压线标注」。
 *
 * ★★ 本类型是**新画**的（用户 2026-09-18 要求新增）—— 标绘库 mapbox-plot 里没有
 *   对应的 Plot，口径按「平行线 / 垂直线标注」的先例：交互与符号自己定、文件头写清楚，
 *   **不是移植**。
 *
 * ## 符号：导线 + 杆塔
 *
 * 一条实线（导线）＋ 沿线每隔 `PYLON_GAP` 像素画一座**杆塔**。杆塔是一个「工」字形：
 *
 * ```
 *   ──┬──      ← 两根横担（沿**线的方向**，模拟输电塔的两层横担）
 *    │
 *    │         ← 杆身（垂直于线，横穿导线）
 *    │
 *   ──┴──
 * ```
 *
 * ★ 与「铁路标注」刻意拉开：铁路的枕木**密而短**（9px 一根、只比线宽一点），
 *   高压线的杆塔**疏而高**（46px 一座、杆身是线宽的 4.8 倍），两者放在一张图上
 *   一眼就能分清 —— 这正是这两种符号在地图惯例里的差别。
 *
 *   ・主线与杆塔同色：`pathColor`；粗细基准：`pathWidth`；不透明度：`lineOpacity`
 *   ・杆身高的一半 = `lineW × 2.4 + 6`（3px 线宽 ⇒ 13.2px，即杆身 26.4px）
 *   ・横担半宽 = 杆身高的一半 × 0.42，两根分别位于杆身 ±58% 处
 *   ・杆塔自身线宽 = `lineW × 0.5`
 *
 * ## 杆塔算在地面平面上（不是屏幕坐标）
 *
 * 「杆身垂直于线、横担沿着线」是**地面上的垂直与平行**：地图一倾斜，南北向被压扁，
 * 屏幕坐标里算出来的杆塔会歪掉（用户报的「视角倾斜后变形」）。所以杆塔的落点与
 * 三根线段都在 `g.plane`（地面平面）上算完，再经 `g.toSegs` 逐点投影 —— 倾斜时
 * 杆塔按真实透视立着，仍垂直于它脚下那段导线。详见 `line-deco.ts` 的文件头。
 *
 * ## 绘制方式
 *
 * 逐点落点、双击 / 回车完成（`minPts = 2`，同「折线标注」）。
 * ===================================================================== */
import { upNormal } from '../paint';
import { MapboxSketch } from '../sketch';
import { LineDecoShape } from './line-deco';
import type { DecoFrame, Seg } from './line-deco';
import type { CfgKey, Style } from '../types';

/** 杆塔沿线的屏幕间距(px)：稀疏，与铁路枕木（9px）刻意拉开 */
const PYLON_GAP = 46;
/** 杆身「高的一半」 = 主线线宽 × 系数 + 常数(px) */
const STEM_H_K = 2.4;
const STEM_H_M = 6;
/** 横担半宽 = 杆身「高的一半」 × 这个比例 */
const ARM_W_K = 0.42;
/** 两根横担位于杆身的 ±这个比例处（0.58 = 靠近两端但不贴边） */
const ARM_AT = 0.58;
/** 杆塔自身的线宽 = 主线线宽 × 这个比例 */
const PYLON_W_K = 0.5;

export class PowerlineShape extends LineDecoShape {
  get key(): string { return 'powerline'; }
  get label(): string { return '高压线标注'; }

  cfgKeys(): CfgKey[] { return []; }

  get hint(): string {
    return '⚡ 绘制<b>高压线标注</b>：单击地图依次落点连成线路（导线 + 沿线杆塔）<br />'
      + '・粗细在右侧面板调「线宽」——杆塔的大小会跟着它一起变<br />'
      + '・<b>双击</b> 或按 <b>回车</b>＝完成　・<b>右键</b>＝撤销上一点　・<b>Esc</b>＝取消';
  }

  /** 杆身「高的一半」(px)，由主线线宽定 */
  private stemH(st: Style): number {
    return this.lineW(st) * STEM_H_K + STEM_H_M;
  }

  /** 杆塔沿杆身方向向两侧各伸出「高的一半」 */
  protected reach(st: Style): number {
    return this.stemH(st) + 1;
  }

  protected paintDeco(
    ctx: CanvasRenderingContext2D, g: DecoFrame, st: Style,
  ): void {
    this.strokeBase(ctx, g.base, st);                    // 导线（投影后的顶点，不走平面）

    const h = this.stemH(st);
    const arm = h * ARM_W_K;
    const segs: Seg[] = [];
    this.alongMarks(g.plane, PYLON_GAP, (x, y, ang) => {
      const n = upNormal(ang);                           // 垂直于线：杆身方向（平面上的垂直）
      const t = { x: Math.cos(ang), y: Math.sin(ang) };  // 沿线方向：横担方向
      // 杆身：横穿导线
      segs.push([
        { x: x - n.x * h, y: y - n.y * h },
        { x: x + n.x * h, y: y + n.y * h },
      ]);
      // 两根横担：沿线的方向，挂在杆身两端内侧
      for (const k of [-ARM_AT, ARM_AT]) {
        const cx = x + n.x * h * k, cy = y + n.y * h * k;
        segs.push([
          { x: cx - t.x * arm, y: cy - t.y * arm },
          { x: cx + t.x * arm, y: cy + t.y * arm },
        ]);
      }
    });
    // 每根线段两端各自投影 ⇒ 倾斜时杆塔按真实透视立着
    this.strokeSegs(ctx, g.toSegs(segs), st.pathColor, Math.max(1, this.lineW(st) * PYLON_W_K), st.lineOpacity);
  }
}

/* 自注册：import 本文件即把类型收进静态注册表 */
MapboxSketch.registerType(PowerlineShape);
