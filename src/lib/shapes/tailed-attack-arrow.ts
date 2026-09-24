/* =====================================================================
 * shapes/tailed-attack-arrow.ts —— 内置类型：TailedAttackArrowShape「进攻方向尾标注」。
 *
 * ★★ 几何**照搬**标绘库 mapbox-plot 的 `src/gispace/plot/TailedAttackArrow.js`
 *   （＝ openlayers-plot 的 `P.PlotTypes.TAILED_ATTACK_ARROW`，那个 demo 的按钮中文名
 *   「进攻方向（尾）」）。用户 2026-09-17 要求新增。
 *
 * ★ 原版是 `goog.inherits(P.Plot.TailedAttackArrow, P.Plot.AttackArrow)` ——
 *   箭头 / 箭身的算法（`getArrowHeadPoints` / `getArrowBodyPoints`）**全部继承**，
 *   五个比例因子也与「进攻方向」**逐字相同**；只**覆写 `generate`**，在轮廓末尾再接一段
 *   **「燕尾」**：
 *
 *     var tailWidth = distance(tailLeft, tailRight);
 *     var allLen    = getBaseLength(bonePnts);
 *     var len       = allLen * this.tailWidthFactor(0.1) * this.swallowTailFactor(1);
 *     this.swallowTailPnt = getThirdPoint(bonePnts[1], bonePnts[0], 0, len, true);
 *     ...
 *     setCoordinates([leftPnts.concat(headPnts, rightPnts.reverse(),
 *                                     [this.swallowTailPnt, leftPnts[0]])]);
 *
 *   ⇒ 也就是在箭尾中点那一段往回凹出一个 V（燕尾），再连回首点把轮廓闭合。
 *   所以本库也照原版那样**继承** `AttackArrowShape`，只覆写 `buildRing`（＋ key / label / hint）；
 *   其余（命中 / 剔除 / 渲染 / 预览 / y 轴翻面）全部沿用父类。
 *
 * ★ **存储顶点＝用户落的那些点**；★ **顶点圆点不要在这里画**（见 AGENTS 4 节）。
 * ===================================================================== */
import { MapboxSketch } from '../sketch';
import { getBaseLength, getQBSplinePoints, getThirdPoint, isClockWise, mid, distance } from './plot-utils';
import { AttackArrowShape } from './attack-arrow';
import type { ScreenPoint } from '../types';

/** 原版 `TailedAttackArrow` 比 `AttackArrow` 多出来的两个数（只用来定「燕尾」的长度） */
const TAIL_WIDTH_FACTOR = 0.1;
const SWALLOW_TAIL_FACTOR = 1;

export class TailedAttackArrowShape extends AttackArrowShape {
  get key(): string { return 'tailedAttackArrow'; }
  get label(): string { return '进攻方向尾标注'; }

  get hint(): string {
    return '➹ 绘制<b>进攻方向尾标注</b>：与「进攻方向标注」同一套画法（单击落<b>箭尾</b>、逐点画<b>箭杆</b>、'
      + '最后一点＝<b>箭头尖端</b>；<b>双击</b> 或按 <b>回车</b>完成），<br />'
      + '・区别只在<b>箭尾凹出一个燕尾</b>（形如 "＞" 的尾口）　・<b>右键</b>＝撤销上一点　・<b>Esc</b>＝取消';
  }

  /**
   * `TailedAttackArrow.prototype.generate` —— 与父类同构，只在末尾再接「燕尾」两点。
   * （原版就是整段复制父类再改这几行，这里照做；算法本身仍跑在「地理坐标」上。）
   */
  protected buildRing(raw: ScreenPoint[]): ScreenPoint[] | null {
    const n = raw.length;
    if (n < 2) return null;
    if (n === 2) return raw.slice();

    let tailLeft = raw[0];
    let tailRight = raw[1];
    if (isClockWise(raw[0], raw[1], raw[2])) { tailLeft = raw[1]; tailRight = raw[0]; }
    const midTail = mid(tailLeft, tailRight);
    const bonePnts = [midTail].concat(raw.slice(2));
    const headPnts = this.getArrowHeadPoints(bonePnts, tailLeft, tailRight);
    const neckLeft = headPnts[0];
    const neckRight = headPnts[4];

    const tailWidth = distance(tailLeft, tailRight);
    const allLen = getBaseLength(bonePnts);
    const len = allLen * TAIL_WIDTH_FACTOR * SWALLOW_TAIL_FACTOR;
    const swallowTailPnt = getThirdPoint(bonePnts[1], bonePnts[0], 0, len, true);
    const factor = tailWidth / allLen;            // 与原版 AttackArrow 的 tailWidthFactor 同式

    const bodyPnts = this.getArrowBodyPoints(bonePnts, neckLeft, neckRight, factor);
    const count = bodyPnts.length;
    const leftPnts0 = [tailLeft].concat(bodyPnts.slice(0, count / 2));
    leftPnts0.push(neckLeft);
    const rightPnts0 = [tailRight].concat(bodyPnts.slice(count / 2, count));
    rightPnts0.push(neckRight);

    const leftPnts = getQBSplinePoints(leftPnts0);
    const rightPnts = getQBSplinePoints(rightPnts0);
    return leftPnts.concat(headPnts, rightPnts.reverse(), [swallowTailPnt, leftPnts[0]]);
  }
}

/* 自注册：import 本文件即把类型收进静态注册表 */
MapboxSketch.registerType(TailedAttackArrowShape);
