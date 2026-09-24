/* =====================================================================
 * shapes/leader-coord.ts —— 内置类型：LeaderCoordShape「坐标引线标注」。
 *
 * 本质是「引线标注」的变体：锚点 + 两段式引线 + 水平文字，几何、命中、
 * 拖动、编辑全继承自 LeaderShape（shapes/leader.ts）。
 * 唯一区别：文字内容【不由面板输入】，而是程序在每次渲染时根据锚点经纬度
 * （shape.pts[0]）实时换算成【度分秒】，分两行显示：
 *     经度：116°23′31.2″
 *     纬度：39°56′04.56″
 * 拖动锚点时文字随之实时刷新（linesFor() 每次读 pts 现算）。
 *
 * 格式口径：用符号 ° ′ ″，不用汉字「度分秒」；纯数字、不带东西南北 / EW
 * 半球后缀 —— 负经度 / 负纬度在度数前直接加负号，如 -75°58′41.3″（西经 / 南纬）。
 * ===================================================================== */
import { MapboxSketch } from '../sketch';
import { LeaderShape } from './leader';
import type { CfgKey, CfgPatch, Shape } from '../types';

/**
 * 小数 → 度分秒字符串（° ′ ″）。
 *
 * 全部换算成「秒的 0.01 倍」整数来算，60″ / 60′ 进位天然正确
 * （含舍入到边界的情形），无需手工逐级进位。
 * 秒整数补足 2 位、小数去尾 0：如 04″、04.56″、31.2″。
 */
export function dms(v: number): string {
  const neg = v < 0;
  const x = Math.abs(v);
  let T = Math.round(x * 3600 * 100);   // 总「百分之一秒」，0.01″ 精度取整
  const d = Math.floor(T / 360000);     // 度（100 × 3600 = 360000）
  T %= 360000;
  const m = Math.floor(T / 6000);       // 分（100 × 60 = 6000）
  T %= 6000;
  const sInt = Math.floor(T / 100);     // 整秒
  const sFrac = T % 100;                // 秒的小数（百分位）
  const fracTxt = String(sFrac).padStart(2, '0').replace(/0+$/, '');
  const secTxt = sFrac === 0
    ? String(sInt).padStart(2, '0')
    : String(sInt).padStart(2, '0') + '.' + fracTxt;
  return (neg ? '-' : '') + d + '°' + String(m).padStart(2, '0') + '′' + secTxt + '″';
}

export class LeaderCoordShape extends LeaderShape {
  get key(): string { return 'leaderCoord'; }
  get label(): string { return '坐标引线标注'; }
  get minPts(): number { return 1; }
  get autoCommit(): boolean { return true; }   // 单击一次即完成（同引线 / 点）

  /** 面板不提供文字输入：文字是锚点坐标换算来的，只有角度 / 长度可调 */
  cfgKeys(): CfgKey[] { return ['angle', 'len']; }

  /** 继承的「默认文字 = 引线标注」对坐标型无意义，压空（实际文字由 linesFor 现算） */
  defaultCfg(): CfgPatch { return {}; }

  get hint(): string {
    return '➤ 绘制<b>坐标引线标注</b>：在地图上单击一下即拾取该点的经纬度坐标<br />'
      + '・自动显示两行度分秒：<b>经度：…°…′…″ / 纬度：…°…′…″</b>，不用输入文字<br />'
      + '・拖锚点圆点可整体移动；悬停引线变红提示可拖<br />'
      + '・画好后可在面板调<b>角度 / 长度</b>；坐标随锚点<b>实时刷新</b>';
  }

  describe(shape: Shape): string {
    return `坐标引线 ${shape.cfg.angle}° · ${this.coordText(shape)}`;
  }

  /**
   * 文字行 = 锚点经纬度换算的度分秒（经度行 / 纬度行）。
   * 每次渲染现算 shape.pts[0]，故拖动锚点时文字实时更新。
   * 基类 render / _hSpan / hitTest 都依赖此方法，天然拿到最长一行来定下划线长度。
   * @returns 恒两行（经度在上、纬度在下）
   */
  linesFor(shape: Shape): string[] {
    const [lng, lat] = shape.pts[0];
    return ['经度：' + dms(lng), '纬度：' + dms(lat)];
  }

  /** 度分秒字符串（供列表描述 / 回显复用，不带「经度：」前缀） */
  coordText(shape: Shape): string {
    const [lng, lat] = shape.pts[0];
    return dms(lng) + '  ' + dms(lat);
  }
}

MapboxSketch.registerType(LeaderCoordShape);
