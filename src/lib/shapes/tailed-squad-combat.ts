/* =====================================================================
 * shapes/tailed-squad-combat.ts —— 内置类型：TailedSquadCombatShape「分队战斗行动尾标注」。
 *
 * ★★ 几何**照搬**标绘库 mapbox-plot 的 `src/gispace/plot/TailedSquadCombat.js`
 *   （那个 demo 的按钮中文名「分队战斗行动（尾）」）。用户 2026-09-17 要求新增。
 *
 * ## 原版结构
 *
 * 原版 `TailedSquadCombat` **继承 `AttackArrow`**，但 `generate` 其实就是
 * 「`SquadCombat` 的 generate ＋ 一个燕尾」：
 *   - `getTailPoints` 比父类多算一个 `swallowTailPnt`（尾口中点往回凹 `tailWidth×swallowTailFactor`），
 *     返回 3 点 `[tailLeft, swallowTailPnt, tailRight]`；
 *   - `generate` 用 `tailPnts[0]` 与 `tailPnts[2]`（跳过中间的 `swallowTailPnt`）做箭身两角，
 *     末尾再补上 `[tailPnts[1], leftPnts[0]]` 把燕尾凹口闭合。
 *
 * 本库照原版语义、但按**继承链**收口：让本类继承 `SquadCombatShape`（它已含分队战斗行动的
 * 偏移尾 + 整条 `pnts` 算法），只覆写 `getTailPoints`（补燕尾点）与 `buildRing`（末尾接燕尾）。
 * 头部五因子、箭身算法、y 轴翻面完全沿用。
 *
 * ★ 经 Hausdorff 对原版逐点验证一致（见 test/shapes-tailed-squad-combat.spec.ts）。
 * ===================================================================== */
import type { ScreenPoint } from '../types';
import { getBaseLength, getQBSplinePoints, getThirdPoint } from './plot-utils';
import { SquadCombatShape } from './squad-combat';

/** 几何常量（原版 `Constants.js`） */
const HALF_PI = Math.PI / 2;

export class TailedSquadCombatShape extends SquadCombatShape {
  get key(): string { return 'tailedSquadCombat'; }
  get label(): string { return '分队战斗行动尾标注'; }
  get minPts(): number { return 3; }        // 两尾 + 至少一个骨架点（同前两者）

  /** 原版 `TailedSquadCombat` 构造函数的 `swallowTailFactor` */
  protected swallowTailFactor = 1;

  get hint(): string {
    return '⏣ 绘制<b>分队战斗行动尾标注</b>：与「分队战斗行动标注」同一套画法（单击落<b>箭尾</b>、逐点画'
      + '<b>箭杆</b>、最后一点＝<b>箭头尖端</b>；<b>双击</b> 或按 <b>回车</b>完成），<br />'
      + '・区别只在<b>箭尾凹出一个燕尾</b>（形如 "＞" 的尾口）　・<b>右键</b>＝撤销上一点　・<b>Esc</b>＝取消';
  }

  /** `TailedSquadCombat.prototype.getTailPoints` —— 比父类多算一个燕尾点（尾口中点往回凹） */
  protected getTailPoints(pnts: ScreenPoint[]): ScreenPoint[] {
    const allLen = getBaseLength(pnts);
    const tailWidth = allLen * this.tailWidthFactor;
    const tailLeft = getThirdPoint(pnts[1], pnts[0], HALF_PI, tailWidth, false);
    const tailRight = getThirdPoint(pnts[1], pnts[0], HALF_PI, tailWidth, true);
    const len = tailWidth * this.swallowTailFactor;
    const swallowTailPnt = getThirdPoint(pnts[1], pnts[0], 0, len, true);
    return [tailLeft, swallowTailPnt, tailRight];
  }

  /**
   * `TailedSquadCombat.prototype.generate` —— 与父类 `SquadCombat` 的 generate 仅差末尾的燕尾闭合：
   * 箭身两角取 `tailPnts[0]` / `tailPnts[2]`（跳过中间的 `swallowTailPnt`），
   * 最后再补 `[tailPnts[1], leftPnts[0]]` 把燕尾凹口封上。
   */
  protected buildRing(raw: ScreenPoint[]): ScreenPoint[] | null {
    const n = raw.length;
    if (n < 2) return null;
    if (n === 2) return raw.slice();

    const pnts = raw;
    const tailPnts = this.getTailPoints(pnts);
    const headPnts = this.getArrowHeadPoints(pnts, tailPnts[0], tailPnts[2]);
    const neckLeft = headPnts[0];
    const neckRight = headPnts[4];
    const bodyPnts = this.getArrowBodyPoints(pnts, neckLeft, neckRight, this.tailWidthFactor);

    const count = bodyPnts.length;
    const leftPnts0 = [tailPnts[0]].concat(bodyPnts.slice(0, count / 2));
    leftPnts0.push(neckLeft);
    const rightPnts0 = [tailPnts[2]].concat(bodyPnts.slice(count / 2, count));
    rightPnts0.push(neckRight);

    const leftPnts = getQBSplinePoints(leftPnts0);
    const rightPnts = getQBSplinePoints(rightPnts0);
    return leftPnts.concat(headPnts, rightPnts.reverse(), [tailPnts[1], leftPnts[0]]);
  }
}

/* 自注册：import 本文件即把类型收进静态注册表 */
import { MapboxSketch } from '../sketch';
MapboxSketch.registerType(TailedSquadCombatShape);
