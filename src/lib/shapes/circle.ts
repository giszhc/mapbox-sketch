/* =====================================================================
 * shapes/circle.ts —— 内置类型：CircleShape「圆形标注」。
 *
 * 存 2 个顶点：[圆心, 圆周上一点]。单击定圆心、橡皮筋预览半径、第二击即成
 * （autoCommit，同「点 / 引线」）。
 *
 * ★★ 圆是**屏幕正圆**（2026-09-19 改回 —— 用户实测：低缩放下拖圆往北会「变成鸡蛋」）：
 *   环上 n 个点直接以「投影后的圆心」为心、「投影后两点距」为半径排圆。形状**只**
 *   由两个控制点的投影位置决定 ⇒
 *     · 拖动（两点同屏幕位移）⇒ 正圆逐像素不变，不会越拖越扁 / 越大；
 *     · 缩放 ⇒ 半径按投影距离等比缩放（圆跟着地图放大缩小，同「面」的手感）；
 *     · 倾斜 / 旋转 ⇒ 仍是正圆。
 *
 *   为什么不是「地面圆」（2026-09-18 曾这么做过：等距经纬平面转圈再投影）：墨卡托
 *   纬度比例随纬度变，**大圆在低缩放 / 高纬度下必然被压成「鸡蛋」**（实测 zoom2 半径
 *   200px 蛋比 1.70、zoom3 蛋比 1.21，且越往北拖越大）。这与「精确球面地面圆」逐点
 *   吻合（1.698 vs 1.688），是投影固有、改不掉。圆是**标注**不是地面要素，用户要
 *   「看着就是正圆」，故按屏幕口径 —— 代价是倾斜地图时圆不再被压成贴地椭圆
 *   （用户 2026-09-19 确认取此口径）。
 *
 * ★ 本类型只存 2 个点却画出整片圆：引擎默认的「线距 / 面内」命中规则只认
 *   存储顶点（两点连线），必须自己实现 hitTest（按采样环判）；圆又远远画在
 *   两点包围盒之外，cullMargin 必须盖住整条环伸出去的距离，否则圆滑到屏幕边缘
 *   会被整个误剔除。
 *
 * ★ 环是**采样**出来的（不调 ctx.arc）：渲染 / 命中 / 预览共用同一份点列，
 *   三处不会各算各的。
 * ===================================================================== */
import { clamp, distToPolyline, fmtM, gdM, pointInRing } from '../math';
import { drawDot, fillRing, lineDashFor, strokePolyline } from '../paint';
import { MapboxSketch } from '../sketch';
import { MapboxShapeType } from '../sketch-shape-type';
import type { CfgKey, DrawSession, LngLat, ScreenPoint, Shape } from '../types';

/** 采样段数的上下限（同「椭圆」） */
const MIN_SEG = 16;
const MAX_SEG = 256;

/** 采样允许的最大拱高(px)：段数按它反解（同「椭圆」，大圆在 300dpi 出图下仍光滑） */
const MAX_SAGITTA = 0.2;

/** 退化阈值：屏幕半径小于它就不画（半径 ≈ 0 没有圆的形状） */
const DEGENERATE_R = 0.5;

export class CircleShape extends MapboxShapeType {
  get key(): string { return 'circle'; }
  get label(): string { return '圆形标注'; }
  get minPts(): number { return 2; }
  get autoCommit(): boolean { return true; }   // 两点即成：圆心 + 圆周上一点

  cfgKeys(): CfgKey[] { return ['showLine']; } // 同「面」：轮廓可隐藏，只留淡填充

  get hint(): string {
    return '◯ 绘制<b>圆形标注</b>：单击定<b>圆心</b>，再单击定<b>半径</b>（第二击即完成）<br />'
      // 半径 = 两点的距离，所以拖圆心那把**改的是圆心、半径也跟着变** —— 别写成
      // 「挪圆心」那种「半径不变」的说法，用户照着试一次就会发现对不上
      + '・圆是<b>屏幕正圆</b>：拖动 / 缩放 / 倾斜地图都不会变形　'
      + '・拖面＝整体平移，拖圆心手柄＝挪圆心（半径＝两点距离，会跟着变），'
      + '拖圆周手柄＝改半径　・<b>Esc</b>＝取消';
  }

  /**
   * 屏幕正圆（屏幕点列）：圆心取**投影后**的圆心，半径取**投影后**两点的距离。
   * 形状只由两个控制点的投影位置决定（见文件头 ★★），故拖动不变形、缩放等比、
   * 倾斜 / 旋转下仍是正圆。段数按屏幕半径的拱高反解（同「椭圆」，大圆仍光滑）。
   */
  private _ring(C: LngLat, P: LngLat): ScreenPoint[] | null {
    const c = this.project(C);
    const p = this.project(P);
    const R = Math.hypot(p.x - c.x, p.y - c.y);
    if (R < DEGENERATE_R) return null;           // 退化成一个点：没有圆的形状

    const n = clamp(
      Math.ceil(Math.PI / Math.acos(clamp(1 - MAX_SAGITTA / R, -1, 1))),
      MIN_SEG, MAX_SEG,
    );
    const out: ScreenPoint[] = [];
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      out.push({ x: c.x + R * Math.cos(t), y: c.y + R * Math.sin(t) });
    }
    return out;
  }

  /** 圆画在两点包围盒之外（倾斜下更明显），剔除边距按整条环的伸出量算 */
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

  describe(shape: Shape): string {
    if (shape.pts.length < 2) return `${this.label} · ${shape.pts.length} 点`;
    const r = gdM(shape.pts[0], shape.pts[1]);
    return `圆形 · 半径 ${fmtM(r)}`;
  }

  /**
   * 自定义命中：圆面内（外扩一圈容差）都算命中本体，
   * 使整圆可悬停变红 / 聚焦后拖两个手柄（圆心＝平移、圆周＝改半径）。
   */
  hitTest(shape: Shape, x: number, y: number, Pts: ScreenPoint[], tol: number): boolean | undefined {
    if (Pts.length !== 2) return undefined;      // 形态超出预期 → 交回默认规则
    const ring = this._ring(shape.pts[0], shape.pts[1]);
    if (!ring) return false;                     // 没画出来，也就不该被点中
    if (pointInRing(x, y, ring)) return true;    // 面内即本体
    return distToPolyline(x, y, ring, true) <= tol;
  }

  /** 已提交的圆：淡填充 + 描边（showLine 可只留填充）；悬停时描边染成高亮色 */
  render(shape: Shape): void {
    const ctx = this.ctx;
    const st = this.styleFor(shape);
    if (!ctx || shape.pts.length < 2) return;
    const ring = this._ring(shape.pts[0], shape.pts[1]);
    if (!ring) return;                           // 退化成一个点：不画

    fillRing(ctx, ring, st.polygonFill);
    if (shape.cfg.showLine !== false) {
      // 补回首点成闭合环：折线描边不会自己闭合
      strokePolyline(ctx, ring.concat([ring[0]]), st.pathColor, st.pathWidth, lineDashFor(st.lineType, st.pathWidth), st.lineOpacity);
    }
  }

  /** 手绘预览：圆心到光标的半径线 + 虚线圆 + 落点圆点（同一套地面环） */
  preview(draw: DrawSession): void {
    const ctx = this.ctx, st = this.style;
    if (!ctx || !st) return;
    const anchor = draw.pts[0] ?? draw.cursor;   // 一击未落时在光标处示意
    if (!anchor) return;
    const A = this.project(anchor);
    const B = draw.cursor ? this.project(draw.cursor) : A;

    ctx.save();
    ctx.globalAlpha = 0.6;
    if (draw.pts.length && draw.cursor) {
      drawDot(ctx, A.x, A.y, 5, st.previewColor);
      const ring = this._ring(anchor, draw.cursor);
      if (ring) strokePolyline(ctx, ring.concat([ring[0]]), st.previewColor, 3, [3, 3]);
      ctx.setLineDash([3, 3]);
      ctx.beginPath();                           // 半径辅助线：一眼看出当前半径
      ctx.moveTo(A.x, A.y);
      ctx.lineTo(B.x, B.y);
      ctx.stroke();
    } else {
      drawDot(ctx, A.x, A.y, 5, st.previewColor);
    }
    ctx.restore();
  }
}

/* 自注册：import 本文件即把类型收进静态注册表 */
MapboxSketch.registerType(CircleShape);
