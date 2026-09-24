/* =====================================================================
 * shapes/curve.ts —— 内置类型：CurveShape「曲线标注」。
 *
 * 用户口径（2026-09-15 定）：**逐点单击落点、自动平滑**——操作与「折线标注」完全一样
 * （单击依次落点、双击 / 回车完成、右键撤销上一点），落下来的拐点被
 * Catmull-Rom 自动圆滑成曲线；**不带任何文字**（要沿线文字用「路径文字」，
 * 要每段长度用「距离标注」）。
 *
 * 与「折线标注」的唯一区别就是画出来是弯的，所以：
 *   · 存储顶点仍是用户点的那几个（平滑只在渲染期做，不写回 `pts`）——
 *     于是编辑态拖的还是那几个拐点，拖完曲线实时跟着变；
 *   · 命中、剔除都按**真正画出来的那条平滑曲线**算，而不是顶点连线
 *     （引擎默认那套量的是顶点连线：拐点越尖，鼓出去的那一段差得越多，
 *     表现为「明明点在线上却点不中」）。见下面 `hitTest` / `cullMargin`。
 *
 * 平滑的采样步长走 `math.smoothStepM()` —— 与「路径文字」同一份算式（同一个折线
 * 在两种类型下必须平滑得一样粗细），它按屏幕像素定步长，缩小时自动变粗。
 * ===================================================================== */
import { distToPolyline, smoothPolyline, smoothStepM } from '../math';
import { drawDot, lineDashFor, strokePolyline } from '../paint';
import { MapboxSketch } from '../sketch';
import { MapboxShapeType } from '../sketch-shape-type';
import type { CfgKey, DrawSession, LngLat, ScreenPoint, Shape } from '../types';

export class CurveShape extends MapboxShapeType {
  get key(): string { return 'curve'; }
  get label(): string { return '曲线标注'; }
  get minPts(): number { return 2; }
  get closesRing(): boolean { return false; }

  cfgKeys(): CfgKey[] { return []; }           // 曲线：仅一条曲线，无可调开关

  get hint(): string {
    return '∿ 绘制<b>曲线标注</b>：单击地图依次落点，拐点自动圆滑成曲线（不带文字）<br />'
      + '・<b>双击</b> 或按 <b>回车</b>＝完成　・<b>右键</b>＝撤销上一点　・<b>Esc</b>＝取消<br />'
      + '・画完后选中它即可拖动各个拐点，曲线实时跟着变';
  }

  describe(shape: Shape): string {
    return `${this.label} · ${shape.pts.length} 点`;
  }

  /**
   * 这条曲线在屏幕上的样子：存储顶点 →（按屏幕步长）平滑 → 投影。
   * 渲染与命中判定共用它，保证「画出来的」和「点得中的」是同一条线。
   *
   * 顶点少于 2 个时原样返回投影结果（还成不了一条线）。
   */
  private _screenCurve(shape: Shape): ScreenPoint[] {
    const raw = this.projectPts(shape);
    const geo = shape.pts;
    if (raw.length < 2 || geo.length < 2) return raw;
    return smoothPolyline(geo, smoothStepM(geo, raw)).map((g) => this.project(g));
  }

  /**
   * 平滑曲线鼓出顶点连线的上限(px)。
   *
   * Catmull-Rom 在「顶点 i → i+1」这一段上的点与弦的差是
   *   `h10·m1 + h11·m2`，其中 `m1 = (P[i+1] − P[i−1])/2`、`m2 = (P[i+2] − P[i])/2`，
   * 而 `|h10|, |h11| ≤ 4/27` —— 于是 `|差| ≤ (2/27)·(|P[i+1] − P[i−1]| + |P[i+2] − P[i]|)`。
   * 取各段里最大的那个就是「曲线最多能鼓出包围盒多远」，剔除时按它放宽。
   *
   * ★ 不能像「路径文字」那样写死 20px：那是个经验值，而这里顶点疏密由用户点的
   *   位置决定 —— 隔 500px 点一下再往回兜，鼓出上百像素是有的，写死就会在图形
   *   还没出屏时把它剔掉（表现为「拖到边上曲线突然没了」）。
   */
  private _bulge(Pts: ScreenPoint[]): number {
    // 两个顶点之间的「平滑」就是那条直线本身（`smoothPolyline` 对 2 个点不弯），
    // 一点都鼓不出去 —— 不加这一句的话上面那条公式会给出一段凭空多出来的余量
    if (Pts.length < 3) return 0;
    let worst = 0;
    for (let i = 0; i < Pts.length - 1; i++) {
      const p0 = Pts[i - 1] || Pts[i];
      const p3 = Pts[i + 2] || Pts[i + 1];
      const d = Math.hypot(Pts[i + 1].x - p0.x, Pts[i + 1].y - p0.y)
        + Math.hypot(p3.x - Pts[i].x, p3.y - Pts[i].y);
      if (d > worst) worst = d;
    }
    return (2 / 27) * worst;
  }

  /** 曲线会鼓出顶点包围盒（见 `_bulge`），两侧还要各留半个线宽 */
  cullMargin(shape: Shape): number {
    const st = this.styleFor(shape);
    return (st.pathWidth || 3) / 2 + this._bulge(this.projectPts(shape)) + 2;
  }

  /**
   * 自定义「本体」命中：引擎默认量的是**顶点连线**（存储顶点就那几个拐点），
   * 而画出来的是平滑曲线 —— 拐点处鼓出去的那一段会点不中，也不是「贴着线
   * 就好点」的那种小偏差（顶点越尖差得越多）。所以这里直接量真正画出来的曲线。
   *
   * 代价是每次命中都要平滑一遍，但只有**过了包围盒预筛**的图形才会走到这里，
   * 且一帧就问一次光标位置。
   */
  hitTest(shape: Shape, x: number, y: number, Pts: ScreenPoint[], tol: number): boolean {
    if (Pts.length < 2) {
      return Pts.length === 1 ? Math.hypot(x - Pts[0].x, y - Pts[0].y) <= tol : false;
    }
    return distToPolyline(x, y, this._screenCurve(shape), false) <= tol;
  }

  /** 已提交的曲线：一条圆头平滑曲线（不画顶点圆点，同「路径文字」的图面口径） */
  render(shape: Shape): void {
    const ctx = this.ctx;
    const st = this.styleFor(shape);
    if (!ctx || shape.pts.length < 2) return;
    strokePolyline(ctx, this._screenCurve(shape), st.pathColor, st.pathWidth, lineDashFor(st.lineType, st.pathWidth), st.lineOpacity);
  }

  /** 手绘预览：与落地同一套平滑的虚线曲线 + 各落点圆点 */
  preview(draw: DrawSession): void {
    const ctx = this.ctx, st = this.style;
    if (!ctx || !st) return;
    const geo: LngLat[] = draw.pts.concat(draw.cursor ? [draw.cursor] : []);
    if (!geo.length) return;
    const raw = geo.map((g) => this.project(g));
    // 已经落下的点 + 光标这一段就先把拐角圆滑上：预览里看到的弧线就是画完的弧线
    const Pts = raw.length >= 2
      ? smoothPolyline(geo, smoothStepM(geo, raw)).map((g) => this.project(g))
      : raw;
    if (Pts.length >= 2) strokePolyline(ctx, Pts, st.previewColor, 3, [3, 3]);
    raw.forEach((p) => drawDot(ctx, p.x, p.y, 5, st.previewColor));
  }
}

/* 自注册：import 本文件即把类型收进静态注册表（见 registry.ts） */
MapboxSketch.registerType(CurveShape);
