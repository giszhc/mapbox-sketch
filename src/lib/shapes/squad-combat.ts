/* =====================================================================
 * shapes/squad-combat.ts —— 内置类型：SquadCombatShape「分队战斗行动标注」。
 *
 * ★★ 几何**照搬**标绘库 mapbox-plot 的 `src/gispace/plot/SquadCombat.js`
 *   （那个 demo 的按钮中文名「分队战斗行动」），依赖的 `PlotUtils.js` 已在 `plot-utils.ts`。
 *   用户 2026-09-17 要求新增。常量、算式、退化分支一律**别按自己审美重写**。
 *
 * ## 与「进攻方向标注」(`AttackArrow`) 的关系
 *
 * 原版 `SquadCombat` **继承** `AttackArrow`，但**覆写**了 `generate` 与 `getTailPoints`，
 * 几何**并非**同一套：
 *   1. 进攻方向的箭尾就是用户落的前两点（`p0/p1`，按顺逆时针挑左右）；
 *      分队战斗行动的箭尾是**从前两点算出来的偏移点**——
 *      `getTailPoints` 取 `allLen × tailWidthFactor(0.1)` 长、垂直于 `p1→p0` 方向、落在 `p0` 两侧。
 *   2. 进攻方向的箭头 / 箭身按「箭尾中点 + 骨架」(`bonePnts`) 算；
 *      分队战斗行动按**整条 `pnts`**（含前两点）算，且 `tailWidthFactor` 是**常数 0.1**
 *      （进攻方向是 `dist(p0,p1)/baseLen` 现算的）。
 *   3. 头部五因子完全一致（head 0.18 / headWidth 0.3 / neckHeight 0.85 / neckWidth 0.15 / headTail 0.8），
 *      所以 `factors()` 直接沿用父类 `AttackArrowShape` 的 `ATTACK_ARROW_FACTORS`，无需覆写。
 *
 * ★ y 轴取反、`_ring`、存储顶点＝用户落点、命中 / 剔除 / 渲染 / 预览：全部沿用父类。
 * ★ 「分队战斗行动（尾）」(`TailedSquadCombat`) 在原版里另写了一个**继承 AttackArrow** 的类，
 *   其 `generate` 正是「本类的 generate ＋ 一个燕尾」—— 所以本文件把 `getTailPoints` /
 *   `buildRing` 写成 `protected`，供子类 `tailed-squad-combat.ts` 覆写。
 * ===================================================================== */
import type { ScreenPoint } from '../types';
import { getBaseLength, getThirdPoint, getQBSplinePoints } from './plot-utils';
import { AttackArrowShape } from './attack-arrow';

/** 几何常量（原版 `Constants.js`） */
const HALF_PI = Math.PI / 2;

export class SquadCombatShape extends AttackArrowShape {
  get key(): string { return 'squadCombat'; }
  get label(): string { return '分队战斗行动标注'; }
  get minPts(): number { return 3; }        // 两尾 + 至少一个骨架点（同进攻方向）

  /** 原版 `SquadCombat` 构造函数的 `tailWidthFactor`（常量，非现算） */
  protected tailWidthFactor = 0.1;

  get hint(): string {
    return '⏣ 绘制<b>分队战斗行动标注</b>：单击落下<b>箭尾</b>后逐点单击画出<b>箭杆</b>，'
      + '最后一个点＝<b>箭头尖端</b>；<b>双击</b> 或按 <b>回车</b>完成<br />'
      + '・箭尾是从前两点算出的偏移点（两尾朝内收），其余点被圆滑成带箭头的绸带　・'
      + '<b>右键</b>＝撤销上一点　・<b>Esc</b>＝取消';
  }

  /** `SquadCombat.prototype.getTailPoints` —— 箭尾是**偏移点**（落在 `p0` 两侧、垂直于 `p1→p0`） */
  protected getTailPoints(pnts: ScreenPoint[]): ScreenPoint[] {
    const allLen = getBaseLength(pnts);
    const tailWidth = allLen * this.tailWidthFactor;
    const tailLeft = getThirdPoint(pnts[1], pnts[0], HALF_PI, tailWidth, false);
    const tailRight = getThirdPoint(pnts[1], pnts[0], HALF_PI, tailWidth, true);
    return [tailLeft, tailRight];
  }

  /**
   * `SquadCombat.prototype.generate` —— 与父类 `AttackArrow` 的 generate **不同**：
   * 用偏移后的 `getTailPoints`，且 `getArrowHeadPoints` / `getArrowBodyPoints` 都吃**整条 `pnts`**、
   * `tailWidthFactor` 是**常数**（非现算）。
   */
  protected buildRing(raw: ScreenPoint[]): ScreenPoint[] | null {
    const n = raw.length;
    if (n < 2) return null;                       // 原版 `getPointCount() < 2` 直接 return
    if (n === 2) return raw.slice();              // 原版两点时原样吐回

    const pnts = raw;
    const tailPnts = this.getTailPoints(pnts);
    const headPnts = this.getArrowHeadPoints(pnts, tailPnts[0], tailPnts[1]);
    const neckLeft = headPnts[0];
    const neckRight = headPnts[4];
    const bodyPnts = this.getArrowBodyPoints(pnts, neckLeft, neckRight, this.tailWidthFactor);

    const count = bodyPnts.length;
    const leftPnts0 = [tailPnts[0]].concat(bodyPnts.slice(0, count / 2));
    leftPnts0.push(neckLeft);
    const rightPnts0 = [tailPnts[1]].concat(bodyPnts.slice(count / 2, count));
    rightPnts0.push(neckRight);

    const leftPnts = getQBSplinePoints(leftPnts0);
    const rightPnts = getQBSplinePoints(rightPnts0);
    return leftPnts.concat(headPnts, rightPnts.reverse());
  }
}

/* 自注册：import 本文件即把类型收进静态注册表 */
import { MapboxSketch } from '../sketch';
MapboxSketch.registerType(SquadCombatShape);
