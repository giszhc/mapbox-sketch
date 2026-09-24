/* =====================================================================
 * measure-shapes.ts —— 测量专用的渲染变体（只给 MapboxSketchMeasure 用）。
 *
 * 测量的读数文字与「距离标注」不一样：起点标「开始」、终点标「总长：…」
 * （米 / 公里自适应），且不画密集刻度。这些差异是**测量场景专属**的 ——
 * 标注引擎里的测距/测面必须保持原样 —— 所以用「子类 + 实例级 addType」实现：
 * 只改写测量工具自己的类型表，不碰静态注册表，标注引擎那边一个字都不变。
 * ===================================================================== */
import { fmtArea, gdM, polyAreaM2, screenCenter } from './math';
import { fillRing, haloText, lineDashFor, strokePolyline, upNormal } from './paint';
import { AreaShape } from './shapes/area';
import { DistanceShape } from './shapes/distance';
import { outsideTextMargin } from './shapes/helpers';
import type { Shape } from './types';

/** 长度的中文单位自适应：<1000m 用「米」，否则「公里」，统一 2 位小数 */
function fmtLenCN(m: number): string {
  if (m < 1000) return `${m.toFixed(2)}米`;
  return `${(m / 1000).toFixed(2)}公里`;
}

/** 测距总长文字（终点旁） */
export function fmtTotal(m: number): string {
  return `总长：${fmtLenCN(m)}`;
}

/** 测面边长文字（每条边中点旁） */
export function fmtEdge(m: number): string {
  return `边长：${fmtLenCN(m)}`;
}

export class MeasureDistanceShape extends DistanceShape {
  get key(): string { return 'measureDistance'; }
  get label(): string { return '测距'; }

  /** 「总长：1234.56米」比标注的「0m」宽不少，视口剔除时多留余量防贴边消失 */
  cullMargin(shape: Shape): number { return outsideTextMargin(this, shape, 90); }

  /**
   * 测距渲染：与「距离标注」的差异只在文字 ——
   *   起点「开始」・中间拐点照旧标累计里程・终点「总长：xx米 / 公里」。
   * 密集刻度**不画**（那是标注的东西，测量读数就在拐点旁）。
   */
  render(shape: Shape): void {
    const ctx = this.ctx;
    const st = this.styleFor(shape);
    const orig = shape.pts;
    const n = orig.length;
    if (n < 2 || !ctx) return;

    const Pts = this.projectPts(shape);

    // 折线本身
    strokePolyline(ctx, Pts, st.pathColor, st.pathWidth, lineDashFor(st.lineType, st.pathWidth), st.lineOpacity);

    // 每个拐点「走到这里」的累计里程（米；折点间取测地线距离累加）
    const cum = [0];
    for (let i = 1; i < n; i++) cum.push(cum[i - 1] + gdM(orig[i - 1], orig[i]));

    // 每个拐点旁水平标注：起点「开始」，终点「总长：…」，中间照旧累计里程
    const off = st.pathWidth / 2 + 14;
    for (let i = 0; i < n; i++) {
      const p = Pts[i];
      const ref = i < n - 1 ? Pts[i + 1] : Pts[i - 1];
      const ang = Math.atan2(ref.y - p.y, ref.x - p.x);
      const u = upNormal(ang);                 // 屏幕「上侧」法线
      const text = i === 0 ? '开始'
        : i === n - 1 ? fmtTotal(cum[i])
        : fmtLenCN(cum[i]);              // 中间拐点：累计里程，同一套中文单位
      haloText(ctx, p.x + u.x * off, p.y + u.y * off, text, {
        size: 12, fill: st.vertexColor, halo: st.haloColor, width: st.haloWidth,
      });
    }
  }
}

export class MeasureAreaShape extends AreaShape {
  get key(): string { return 'measureArea'; }
  get label(): string { return '测面'; }

  /** 「边长：1234.56米」比标注的「123.45m」宽，视口剔除时多留余量防贴边消失 */
  cullMargin(shape: Shape): number { return outsideTextMargin(this, shape, 90); }

  /**
   * 测面渲染：与「面积标注」的差异只在边长文字 ——
   * 加「边长：」前缀、中文单位自适应（米 / 公里）。形心的「面积 / 周长」照旧。
   * 密集刻度**不画**（测量场景读数就在文字里，刻度只会把边线弄毛）。
   */
  render(shape: Shape): void {
    const ctx = this.ctx;
    const st = this.styleFor(shape);
    const cfg = shape.cfg;
    const orig = shape.pts;
    const n = orig.length;
    if (n < 3 || !ctx) return;

    const ring = this.projectPts(shape);
    const closed = ring.concat([ring[0]]);

    // 面内淡填充
    fillRing(ctx, ring, st.polygonFill);

    // 闭合轮廓线（可隐藏，边长 / 周长文字仍显示）
    if (cfg.showLine !== false) {
      strokePolyline(ctx, closed, st.pathColor, st.pathWidth, lineDashFor(st.lineType, st.pathWidth), st.lineOpacity);
    }

    // 每条边的边长（米；沿原坐标测地距离，不受屏幕缩放影响）
    const segM: number[] = [];
    for (let i = 0; i < n; i++) segM.push(gdM(orig[i], orig[(i + 1) % n]));
    const perim = segM.reduce((a, v) => a + v, 0);   // 各边之和 = 总周长

    // 每条边中点外侧标注「这一段」的边长：加「边长：」前缀、米/公里自适应
    const ctr = screenCenter(ring);
    const off = st.pathWidth / 2 + 14;
    for (let i = 0; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % n];
      const o = this._outwardAt(ring, i, ctr);       // 边中点沿法向外移
      haloText(ctx, (a.x + b.x) / 2 + o.x * off, (a.y + b.y) / 2 + o.y * off,
        fmtEdge(segM[i]),
        { size: 12, fill: st.vertexColor, halo: st.haloColor, width: st.haloWidth });
    }

    // 形心：面积（面积加权中心，落在面内）；其下补一行「周长 xx」（米/公里自适应）
    const ctrText = '面积 ' + fmtArea(polyAreaM2(orig));
    haloText(ctx, ctr.x, ctr.y - 9, ctrText,
      { size: 15, fill: st.areaColor, halo: st.haloColor, width: st.haloWidth });
    haloText(ctx, ctr.x, ctr.y + 9, '周长 ' + fmtLenCN(perim),
      { size: 12, fill: st.areaColor, halo: st.haloColor, width: st.haloWidth });
  }
}
