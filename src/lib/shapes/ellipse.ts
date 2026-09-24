/* =====================================================================
 * shapes/ellipse.ts —— 内置类型：EllipseShape「椭圆标注」。
 *
 * 存 2 个顶点：外接矩形对角线上的两个角，椭圆**内接**在这个矩形里：
 *   中心 = 两角的经纬度中点、东西向半轴 = 半个经度差、南北向半轴 = 半个纬度差，
 *   两条轴**沿经纬线对齐**（不能斜着放，同「矩形」）。
 *   单击第一个角、橡皮筋预览、第二击即成（autoCommit）。
 *
 * ★ 2026-09-14 用户改的口径。原先定的是「中心 + 长轴端点 + 短轴端点」三次单击，
 *   真机上不好用：第 1 击之后只画一条长轴辅助线、**看不到椭圆**，非得点到第二下
 *   才有个影子，而且三击才收工。改成两击后，「一个光标位置只能给出方向 + 距离」
 *   就定不出两个半轴了，用户在外接矩形 / 固定长短轴比 / 保持三击只提前预览这三条
 *   里选了**外接矩形**：两轴都能自由定，代价是不再能斜着放。
 *
 * ★★ 几何在**地理空间**定义（2026-09-18 修，同 rect.ts）：早先的实现按「投影后
 *   两角的屏幕差」取半轴、在屏幕上画轴对齐椭圆 —— 地图一带倾斜（pitch）或旋转
 *   （bearing），屏幕轴向就不对应地面轴向了，椭圆跟着相机变来变去（用户实测报告）。
 *   现在改成：半轴在经纬度里取，环上 n 个点先在**地面**上参数化、再逐一投影。
 *   无倾斜 / 无旋转时与旧画法逐点相同；相机一动，椭圆走真实投影 —— 它仍然是
 *   「那块地面」的内接椭圆，形状本身不再漂。
 *
 * ★ 引擎默认命中只认【存储顶点】那两点连线（对角线），且环在倾斜下会伸出
 *   两角的包围盒 —— hitTest 按采样环判、cullMargin 按整条环量伸出量。
 *
 * ★ 椭圆环是**采样**出来的（不调 ctx.ellipse）：一来测试用的记录型画布没有 ellipse，
 *   调了会在用例里**静默丢图形**（引擎逐条 try/catch，只 warn 不炸）；二来渲染、
 *   命中、预览共用同一份点列，三处不会各算各的。
 * ===================================================================== */
import { clamp, distToPolyline, fmtM, gdM, pointInRing } from '../math';
import { drawDot, fillRing, lineDashFor, strokePolyline } from '../paint';
import { MapboxSketch } from '../sketch';
import { MapboxShapeType } from '../sketch-shape-type';
import type { CfgKey, DrawSession, LngLat, ScreenPoint, Shape } from '../types';

/** 采样段数的上下限：下限让很小的椭圆也是圆的，上限防大椭圆每帧白画上千个点 */
const MIN_SEG = 16;
const MAX_SEG = 256;

/**
 * 采样允许的最大拱高(px)：相邻两个采样点连成弦、与真实椭圆弧之间的最大偏离。
 * 段数按它反解（见 `_ring`），而不是按半径线性取值 —— 后者在半径大时不够密，
 * 「大椭圆 + 300dpi 出图」（出图会按 3~4 倍重画）就能看出折角。
 */
const MAX_SAGITTA = 0.2;

/** 退化阈值(px)：投影后的环在任一方向比它还窄就是一条线，没有椭圆的形状 */
const DEGENERATE = 0.5;

/** 地面椭圆的参数（半轴按经纬度差计）：中心 + 两个半轴 */
interface GroundAxes {
  clng: number;
  clat: number;
  a: number;      // 东西向半轴（半个经度差）
  b: number;      // 南北向半轴（半个纬度差）
}

export class EllipseShape extends MapboxShapeType {
  get key(): string { return 'ellipse'; }
  get label(): string { return '椭圆标注'; }
  get minPts(): number { return 2; }
  get autoCommit(): boolean { return true; }   // 两角即成：外接矩形定下来了，椭圆就定了

  cfgKeys(): CfgKey[] { return ['showLine']; } // 同「面」：轮廓可隐藏，只留淡填充

  get hint(): string {
    return '⬭ 绘制<b>椭圆标注</b>：单击外接矩形的<b>第一个角</b>，再单击<b>对角</b>（第二击即完成）<br />'
      + '・椭圆内接在这个矩形里，长短轴<b>沿经纬线对齐</b>（倾斜 / 旋转地图时跟着地面走）<br />'
      + '・拖角手柄＝改大小，拖椭圆内部＝平移　・<b>Esc</b>＝取消';
  }

  /** 地面半轴；某个方向的差为 0（两角在同一条经线 / 纬线上）时返回 null */
  private _axes(p0: LngLat, p1: LngLat): GroundAxes | null {
    const a = Math.abs(p1[0] - p0[0]) / 2;
    const b = Math.abs(p1[1] - p0[1]) / 2;
    if (a === 0 || b === 0) return null;
    return { clng: (p0[0] + p1[0]) / 2, clat: (p0[1] + p1[1]) / 2, a, b };
  }

  /**
   * 椭圆环（屏幕点列，不闭合）：环上 n 个点先在**地面**上按参数方程取好、
   * 再逐一投影。render / hitTest / preview 共用，保证「画出来的」与「点得中的」
   * 永远是同一条曲线。
   *
   * 段数按**投影后的屏幕尺寸**反解（拱高公式，同旧版）：用「地面外接矩形四角的
   * 投影离投影中心的最大距离」当屏幕半径的保守估计（≥ 真实半轴的屏幕长度）——
   * 倾斜 / 旋转下屏幕尺寸每帧都在变，段数也就每帧跟着自适应。半轴越大段数越多，
   * 大椭圆在 300dpi 出图放大后仍光滑；小椭圆则省。
   */
  private _ring(p0: LngLat, p1: LngLat): ScreenPoint[] | null {
    const ax = this._axes(p0, p1);
    if (!ax) return null;
    const C = this.project([ax.clng, ax.clat]);
    let R = 0;
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        const c = this.project([ax.clng + ax.a * sx, ax.clat + ax.b * sy]);
        R = Math.max(R, Math.hypot(c.x - C.x, c.y - C.y));
      }
    }
    if (R < DEGENERATE) return null;
    // R ≥ DEGENERATE(0.5) 且 MAX_SAGITTA(0.2) 远小于它，acos 的入参必在 (0.6, 1) 内
    const n = clamp(
      Math.ceil(Math.PI / Math.acos(clamp(1 - MAX_SAGITTA / R, -1, 1))),
      MIN_SEG, MAX_SEG,
    );
    const out: ScreenPoint[] = [];
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      out.push(this.project([ax.clng + ax.a * Math.cos(t), ax.clat + ax.b * Math.sin(t)]));
    }
    // 倾斜 / 旋转的极端相机下，某个方向的投影可能塌成一条线（宽或高 ≈ 0）—— 没有面的形状
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of out) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    if (maxX - minX < DEGENERATE || maxY - minY < DEGENERATE) return null;
    return out;
  }

  describe(shape: Shape): string {
    if (shape.pts.length < 2) return `${this.label} · ${shape.pts.length} 点`;
    const [p0, p1] = shape.pts;
    // 两条轴的实长就是外接矩形的宽与高，照 rect 的口径沿经纬线各量一次（东西向走纬线、
    // 南北向走经线）；量出来是**全轴长**，不是半轴
    const w = gdM([p0[0], p0[1]], [p1[0], p0[1]]);
    const h = gdM([p0[0], p0[1]], [p0[0], p1[1]]);
    // 有一个方向退化成 0（两下点在一条经线 / 纬线上，很容易发生）：画面上是一条线段，
    // 而「长轴 xx × 短轴 0.00米」这种数看着不像坏掉，只会让人对着画布找不到椭圆
    if (!(w >= 1e-6) || !(h >= 1e-6)) return `${this.label} · 退化`;
    return `椭圆 · 长轴 ${fmtM(Math.max(w, h))} × 短轴 ${fmtM(Math.min(w, h))}`;
  }

  /**
   * 自定义命中：按采样环判 —— 环内（pointInRing）或贴着环一圈容差内都算命中本体，
   * 使整片椭圆可悬停变红 / 聚焦后拖两个角手柄改大小。
   */
  hitTest(shape: Shape, x: number, y: number, Pts: ScreenPoint[], tol: number): boolean | undefined {
    if (Pts.length !== 2) return undefined;      // 形态超出预期 → 交回默认规则
    const ring = this._ring(shape.pts[0], shape.pts[1]);
    if (!ring) return false;                     // 没画出来，也就不该被点中
    if (pointInRing(x, y, ring)) return true;    // 面内即本体（同「圆 / 矩形」的口径）
    // 贴边一圈容差：换算成屏幕尺寸后，环上的弦偏差（≤ MAX_SAGITTA）远小于 tol，无碍
    return distToPolyline(x, y, ring, true) <= tol;
  }

  /**
   * 剔除边距：倾斜 / 旋转下，环会伸出两存储顶点的包围盒 —— 按整条环量「伸出量」，
   * 加上线宽一半的余量（无倾斜 / 无旋转时伸出量为 0，只剩线宽那一档，同旧行为量级）。
   */
  cullMargin(shape: Shape): number {
    const Pts = this.projectPts(shape);
    if (Pts.length < 2) return 0;
    const ring = this._ring(shape.pts[0], shape.pts[1]);
    if (!ring) return 0;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of Pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    let reach = 0;
    for (const p of ring) {
      const dx = Math.max(minX - p.x, 0, p.x - maxX);
      const dy = Math.max(minY - p.y, 0, p.y - maxY);
      reach = Math.max(reach, Math.hypot(dx, dy));
    }
    const lw = this.styleFor(shape).pathWidth;
    return reach + ((typeof lw === 'number' && lw > 0 ? lw : 3) / 2 + 2);
  }

  /** 已提交的椭圆：淡填充 + 描边（showLine 可只留填充）；悬停时描边染成高亮色 */
  render(shape: Shape): void {
    const ctx = this.ctx;
    const st = this.styleFor(shape);
    if (!ctx || shape.pts.length < 2) return;
    const ring = this._ring(shape.pts[0], shape.pts[1]);
    if (!ring) return;                           // 退化（外接矩形塌成线段）：不画

    fillRing(ctx, ring, st.polygonFill);
    if (shape.cfg.showLine !== false) {
      // 补回首点成闭合环：折线描边不会自己闭合
      strokePolyline(ctx, ring.concat([ring[0]]), st.pathColor, st.pathWidth, lineDashFor(st.lineType, st.pathWidth), st.lineOpacity);
    }
  }

  /**
   * 手绘预览：
   *   · 一击未落 —— 光标处一个圆点（示意第一个角落哪）
   *   · 落完第一个角 —— 只画虚线**椭圆**（将长成什么样），第二击即完成
   *
   * ★ 2026-09-14 用户要求去掉虚线**外接矩形**。外接矩形仍然在定形几何里（`_axes` 就是
   *   按它算的），只是不再画出来：用户手上已经有一个角了、盯的是椭圆长成什么样，
   *   再叠一个方框纯粹是抢戏（方框是「矩形标注」自己的预览）。
   */
  preview(draw: DrawSession): void {
    const ctx = this.ctx, st = this.style;
    if (!ctx || !st) return;
    const anchor = draw.pts[0] ?? draw.cursor;   // 一击未落时在光标处示意
    if (!anchor) return;
    const A = this.project(anchor);

    ctx.save();
    ctx.globalAlpha = 0.6;
    drawDot(ctx, A.x, A.y, 5, st.previewColor);
    if (draw.pts.length && draw.cursor) {
      // 样式与虚线由 strokePolyline 内部 save/restore 自理，这里不必再设一遍
      const ring = this._ring(anchor, draw.cursor);   // 光标即对角（地面参数化，同落地）
      if (ring) strokePolyline(ctx, ring.concat([ring[0]]), st.previewColor, 3, [3, 3]);
    }
    ctx.restore();
  }
}

/* 自注册：import 本文件即把类型收进静态注册表 */
MapboxSketch.registerType(EllipseShape);
