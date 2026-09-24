/* =====================================================================
 * shapes/border.ts —— 内置类型：BorderShape「国界 / 境界标注」。
 *
 * ★★ 本类型是**新画**的（用户 2026-09-18 要求新增）—— 标绘库 mapbox-plot 里没有
 *   对应的 Plot，口径按「平行线 / 垂直线标注」的先例：交互与符号自己定、文件头写清楚，
 *   **不是移植**。
 *
 * ## 符号：点划线（一长划 + 一点，反复）
 *
 * 这是地图上表示**境界线**（国界 / 省界 / 县界…）的通用符号：长划 + 一个实心点 +
 * 长划，反复到线尾。**不画连续底线** —— 点划线本身就把线「占满」了，再垫一条实线
 * 会把它变成一根实线的点缀，语义就散了（实线自己就是另一种符号）。
 *
 *   ・长划 / 点：`pathColor`；粗细：`pathWidth`；不透明度：`lineOpacity`
 *   ・长划长度 = `max(8, lineW × 4)`、留白 = `max(3, lineW × 1.4)`、
 *     点的半径 = `max(1, lineW × 0.7)`（3px 线宽 ⇒ 长划 12 / 留白 4.2 / 点直径 4.2，
 *     一个周期 24.6px）
 *
 * ## 图案算在地面平面上（不是屏幕坐标）
 *
 * 长划 / 点的**落点**由「沿弧长走图案」定，而这条弧长量的是**地面平面**上的弧长
 * （见 `line-deco.ts` 的文件头）：地图倾斜时南北向被压扁，量屏幕弧长会让图案在
 * 屏幕上等距、在地面上却越走越密（远处的长划挤成一团）。平面的弧长才是这条境界线
 * 真正的长度，倾斜时按透视呈现 —— 这才是「视角倾斜后不变形」。
 * 那个「点」的半径仍是**屏幕尺寸**（符号粗细不跟地面透视变），只有落点走平面。
 *
 * ## 为什么自己走弧长铺图案，而不用 `ctx.setLineDash`
 *
 * 两件事 `setLineDash` 做不了：
 *   1) **拐角会被抄近道**：虚线每一段都画在弦上，折线的转折处会看到一条斜穿的短线
 *      （这里按弧长走，跨过顶点就在顶点处打断，长划是完整地「贴着」折线走的）；
 *   2) **那个「点」画不好**：靠「长度为 0 的划 + 圆头线帽」凑出来的点在部分浏览器上
 *      宽度不可控（它是线宽决定的），而境界线上的点必须是一个明确的实心圆点。
 * 自己走一遍弧长还有个附带好处：图案的节奏在折线的每个拐角处**照常延续**，
 * 不会因为拐角而错拍。
 *
 * ## 绘制方式
 *
 * 逐点落点、双击 / 回车完成（`minPts = 2`，同「折线标注」）。
 * ===================================================================== */
import { buildArc } from '../math';
import { MapboxSketch } from '../sketch';
import { LineDecoShape } from './line-deco';
import type { DecoFrame, Seg } from './line-deco';
import type { Arc } from '../math';
import type { CfgKey, ScreenPoint, Style } from '../types';

/** 一个周期里四段的排布：长划 → 空 → 点 → 空 */
const PATTERN = ['dash', 'gap', 'dot', 'gap'] as const;
/** 长划长度 = 主线线宽 × 系数，但不短于常数(px) */
const DASH_K = 4;
const DASH_MIN = 8;
/** 留白长度 = 主线线宽 × 系数，但不短于常数(px) */
const GAP_K = 1.4;
const GAP_MIN = 3;
/** 实心点的半径 = 主线线宽 × 系数，但不小于常数(px) */
const DOT_K = 0.7;
const DOT_MIN = 1;

/**
 * 把弧上的 `[s, e]` 段切成折线点列：跨过的每个顶点都要插进来，
 * 否则长划在拐角处会走弦、看起来像抄了近道。
 *
 * 传进来的 `arc` 是**平面**上的弧，返回的也是平面点列（调用方负责投影）。
 */
function sliceArc(arc: Arc, s: number, e: number): ScreenPoint[] {
  const out: ScreenPoint[] = [arc.at(s)];
  for (const c of arc.cum) {
    if (c > s + 1e-9 && c < e - 1e-9) out.push(arc.at(c));
  }
  out.push(arc.at(e));
  return out;
}

export class BorderShape extends LineDecoShape {
  get key(): string { return 'border'; }
  get label(): string { return '国界 / 境界标注'; }

  cfgKeys(): CfgKey[] { return []; }

  get hint(): string {
    return '🛂 绘制<b>国界 / 境界标注</b>：单击地图依次落点，连成一条点划线'
      + '（长划 + 点，国界 / 省界 / 县界通吃）<br />'
      + '・粗细在右侧面板调「线宽」——长划与点的尺寸会跟着它一起变<br />'
      + '・<b>双击</b> 或按 <b>回车</b>＝完成　・<b>右键</b>＝撤销上一点　・<b>Esc</b>＝取消';
  }

  /** 向两侧最多伸出一个点的半径（长划没有横向伸出，宽度只是线宽的一半） */
  protected reach(st: Style): number {
    const w = this.lineW(st);
    return Math.max(w / 2, this.dotR(w)) + 1;
  }

  /** 那个「点」的半径(px) */
  private dotR(w: number): number {
    return Math.max(DOT_MIN, w * DOT_K);
  }

  protected paintDeco(
    ctx: CanvasRenderingContext2D, g: DecoFrame, st: Style,
  ): void {
    const arc = buildArc(g.plane);                       // ★ 量的是**地面平面**上的弧长
    if (!arc || !(arc.total > 0)) return;

    const w = this.lineW(st);
    const dotR = this.dotR(w);
    // 每一「段」的弧长：长划 / 空 / 点（点占的弧长 = 它的直径）/ 空
    const runs = [Math.max(DASH_MIN, w * DASH_K), Math.max(GAP_MIN, w * GAP_K), dotR * 2, Math.max(GAP_MIN, w * GAP_K)];

    const segs: Seg[] = [];
    const dots: ScreenPoint[] = [];
    let s = 0;
    let i = 0;
    while (s < arc.total - 1e-9) {
      const k = i % PATTERN.length;                    // 四段一轮，段长由线宽定
      const kind = PATTERN[k];
      const e = Math.min(s + runs[k], arc.total);
      if (kind === 'dash') {
        const sub = sliceArc(arc, s, e);
        for (let j = 0; j + 1 < sub.length; j++) segs.push([sub[j], sub[j + 1]]);
      } else if (kind === 'dot') {
        const p = arc.at((s + e) / 2);                 // 点落在这一小段的中间
        dots.push({ x: p.x, y: p.y });
      }
      s = e;
      i++;
    }

    // 落笔前统一投影：长划两端各自投影（倾斜时贴着地面走）、点只投影圆心（半径是屏幕尺寸）
    this.strokeSegs(ctx, g.toSegs(segs), st.pathColor, st.pathWidth, st.lineOpacity);
    this.fillDots(ctx, g.toScreenAll(dots), dotR, st.pathColor, st.lineOpacity);
  }
}

/* 自注册：import 本文件即把类型收进静态注册表 */
MapboxSketch.registerType(BorderShape);
