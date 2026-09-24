/* =====================================================================
 * shapes/plot-utils.ts —— 标绘库 `src/gispace/PlotUtils.js` 的**逐行搬移**。
 *
 * 这里收**箭头一族**（双箭头 / 细直箭头 / 直箭头 / 突击方向 / 进攻方向 / 进攻方向（尾））
 * 共同用到的那几个算法原语：距离 / 整长 / 基准长 / 中点 / 方位角 / 三点夹角 /
 * 顺逆时针判据 / 第三点 / 二项式 / n 阶贝塞尔 / **二次 B 样条**；
 * 以及「弓形面标注」（`Lune`）用的两个圆几何原语：**三点定圆** / **两直线交点**。
 *
 * ★ **别按自己审美重写这里的算式** —— `getAzimuth` 的四个象限分支、`getThirdPoint` 的
 *   `clockWise` 手性、`getQBSplinePoints` 的 `t += 0.05` 步长，都是「逐点与原版一致」的前提；
 *   改动会让各箭头类型的金标准（`test/shapes-*.spec.ts`）立刻变红。
 * ★ 坐标为**屏幕坐标**（用法见各类型：进门把 y 取反当地理坐标喂进来，出门再取回）。
 * ★ 更早的两个箭头（双箭头 / 细直箭头）原本各自抄了一份，2026-09-17 起统一到这里；
 *   `assembly` / `closed-curve` 用的是另一批原语（bisector / cubic），暂未并入。
 * ===================================================================== */
import type { ScreenPoint } from '../types';

/** 原版 `Constants.TWO_PI` */
const TWO_PI = Math.PI * 2;

/** `P.PlotUtils.distance` */
export const distance = (a: ScreenPoint, b: ScreenPoint): number => Math.hypot(a.x - b.x, a.y - b.y);

/** 上一条的短名（本仓库既有写法） */
export const len = distance;

/** `P.PlotUtils.wholeDistance` */
export const wholeDistance = (points: ScreenPoint[]): number => {
  let d = 0;
  for (let i = 0; i < points.length - 1; i++) d += distance(points[i], points[i + 1]);
  return d;
};

/** `P.PlotUtils.getBaseLength` —— 原版是 `wholeDistance ^ 0.99`（不是直线距离） */
export const getBaseLength = (points: ScreenPoint[]): number => Math.pow(wholeDistance(points), 0.99);

/** `P.PlotUtils.mid` */
export const mid = (a: ScreenPoint, b: ScreenPoint): ScreenPoint =>
  ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * `P.PlotUtils.getIntersectPoint` —— 两直线 AB × CD 的交点。
 * ★ 原版就是裸除法：两线平行（`e == f`）或某条线水平退化时会吐 `Infinity` / `NaN`，
 *   调用方（`getCircleCenterOfThreePoints` → 弓形面标注）靠「轮廓必须全有限」那一道闸挡住。
 */
export function getIntersectPoint(
  pntA: ScreenPoint, pntB: ScreenPoint, pntC: ScreenPoint, pntD: ScreenPoint,
): ScreenPoint {
  if (pntA.y === pntB.y) {
    const f = (pntD.x - pntC.x) / (pntD.y - pntC.y);
    return { x: f * (pntA.y - pntC.y) + pntC.x, y: pntA.y };
  }
  if (pntC.y === pntD.y) {
    const e = (pntB.x - pntA.x) / (pntB.y - pntA.y);
    return { x: e * (pntC.y - pntA.y) + pntA.x, y: pntC.y };
  }
  const e = (pntB.x - pntA.x) / (pntB.y - pntA.y);
  const f = (pntD.x - pntC.x) / (pntD.y - pntC.y);
  const y = (e * pntA.y - pntA.x - f * pntC.y + pntC.x) / (e - f);
  return { x: e * y - e * pntA.y + pntA.x, y };
}

/** `P.PlotUtils.getCircleCenterOfThreePoints` —— 三点定圆的圆心（三点共线时退化，见上条） */
export function getCircleCenterOfThreePoints(
  pnt1: ScreenPoint, pnt2: ScreenPoint, pnt3: ScreenPoint,
): ScreenPoint {
  const pntA = mid(pnt1, pnt2);
  const pntB: ScreenPoint = { x: pntA.x - pnt1.y + pnt2.y, y: pntA.y + pnt1.x - pnt2.x };
  const pntC = mid(pnt1, pnt3);
  const pntD: ScreenPoint = { x: pntC.x - pnt1.y + pnt3.y, y: pntC.y + pnt1.x - pnt3.x };
  return getIntersectPoint(pntA, pntB, pntC, pntD);
}

/** 原版 `Constants.FITTING_COUNT`：圆弧一族（弓形面 / 弧线）的整弧采样段数 */
export const FITTING_COUNT = 100;

/**
 * `P.PlotUtils.getArcPoints` —— 圆弧上 `FITTING_COUNT + 1` 个采样点（含两端）。
 * 「弓形面标注」（`Lune`）与「弧线标注」（`Arc`）共用；扫过哪一段由调用方定的
 * 起止角决定（差的绝对值超过 2π 的情况原版没有，这里也不做）。
 */
export function getArcPoints(
  center: ScreenPoint, radius: number, startAngle: number, endAngle: number,
): ScreenPoint[] {
  let angleDiff = endAngle - startAngle;
  angleDiff = angleDiff < 0 ? angleDiff + TWO_PI : angleDiff;
  const pnts: ScreenPoint[] = [];
  for (let i = 0; i <= FITTING_COUNT; i++) {
    const angle = startAngle + angleDiff * i / FITTING_COUNT;
    pnts.push({ x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) });
  }
  return pnts;
}

/** 原版的四个象限分支（别改成 atan2，手性会变） */
export function getAzimuth(start: ScreenPoint, end: ScreenPoint): number {
  const angle = Math.asin(Math.abs(end.y - start.y) / distance(start, end));
  if (end.y >= start.y && end.x >= start.x) return angle + Math.PI;
  if (end.y >= start.y && end.x < start.x) return TWO_PI - angle;
  if (end.y < start.y && end.x < start.x) return angle;
  return Math.PI - angle;
}

/** `P.PlotUtils.getAngleOfThreePoints` */
export function getAngleOfThreePoints(a: ScreenPoint, b: ScreenPoint, c: ScreenPoint): number {
  const angle = getAzimuth(b, a) - getAzimuth(b, c);
  return angle < 0 ? angle + TWO_PI : angle;
}

/** `P.PlotUtils.isClockWise` —— 原版的叉积判据（注意是 `>`，共线算「非顺时针」） */
export const isClockWise = (a: ScreenPoint, b: ScreenPoint, c: ScreenPoint): boolean =>
  (c.y - a.y) * (b.x - a.x) > (b.y - a.y) * (c.x - a.x);

/** `P.PlotUtils.getThirdPoint` */
export function getThirdPoint(
  start: ScreenPoint, end: ScreenPoint, angle: number, dist: number, clockWise: boolean,
): ScreenPoint {
  const azimuth = getAzimuth(start, end);
  const alpha = clockWise ? azimuth + angle : azimuth - angle;
  return { x: end.x + dist * Math.cos(alpha), y: end.y + dist * Math.sin(alpha) };
}

/** `P.PlotUtils.getFactorial` —— 原版显式列了 0..5，再循环 */
export function getFactorial(n: number): number {
  if (n <= 1) return 1;
  if (n === 2) return 2;
  if (n === 3) return 6;
  if (n === 4) return 24;
  if (n === 5) return 120;
  let r = 1;
  for (let i = 1; i <= n; i++) r *= i;
  return r;
}

/** `P.PlotUtils.getBinomialFactor` */
export const getBinomialFactor = (n: number, i: number): number =>
  getFactorial(n) / (getFactorial(i) * getFactorial(n - i));

/** `P.PlotUtils.getBezierPoints` —— n 阶贝塞尔，`t` 步长 0.01（原版同参） */
export function getBezierPoints(points: ScreenPoint[]): ScreenPoint[] {
  if (points.length <= 2) return points.slice();
  const out: ScreenPoint[] = [];
  const n = points.length - 1;
  for (let t = 0; t <= 1; t += 0.01) {
    let x = 0, y = 0;
    for (let i = 0; i <= n; i++) {
      const f = getBinomialFactor(n, i);
      const a = Math.pow(t, i);
      const b = Math.pow(1 - t, n - i);
      x += f * a * b * points[i].x;
      y += f * a * b * points[i].y;
    }
    out.push({ x, y });
  }
  out.push(points[n]);
  return out;
}

/** `P.PlotUtils.getQuadricBSplineFactor` */
export function getQuadricBSplineFactor(k: number, t: number): number {
  if (k === 0) return Math.pow(t - 1, 2) / 2;
  if (k === 1) return (-2 * Math.pow(t, 2) + 2 * t + 1) / 2;
  if (k === 2) return Math.pow(t, 2) / 2;
  return 0;
}

/**
 * `P.PlotUtils.getQBSplinePoints` —— 二次 B 样条平滑（**注意 `t` 步长是 0.05**，不是贝塞尔的 0.01）。
 * 「进攻方向」两兄弟的箭身两条边就是靠它圆滑出来的。
 */
export function getQBSplinePoints(points: ScreenPoint[]): ScreenPoint[] {
  if (points.length <= 2) return points.slice();
  const n = 2;
  const out: ScreenPoint[] = [points[0]];
  const m = points.length - n - 1;
  for (let i = 0; i <= m; i++) {
    for (let t = 0; t <= 1; t += 0.05) {
      let x = 0, y = 0;
      for (let k = 0; k <= n; k++) {
        const f = getQuadricBSplineFactor(k, t);
        x += f * points[i + k].x;
        y += f * points[i + k].y;
      }
      out.push({ x, y });
    }
  }
  out.push(points[points.length - 1]);
  return out;
}
