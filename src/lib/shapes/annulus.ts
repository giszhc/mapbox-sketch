/* =====================================================================
 * shapes/annulus.ts —— 内置类型：AnnulusShape「圆环标注」。
 *
 * ★★ 本类型是**新画**的（用户 2026-09-18 要求新增）—— 标绘库 mapbox-plot 里只有
 *   `Circle`（圆面），没有圆环；口径按「直箭头标注」的先例：交互与几何自己定，
 *   文件头写清楚，**不是移植**。三击即成，同「扇形 / 弧线」那一路。
 *
 * 存 3 个顶点：[圆心 C, 外圆上一点, 内圆上一点]：
 *   · 外半径 R = **投影后** C 到「外圆点」的**屏幕**距离，内半径 r = C 到「内圆点」的距离；
 *   · 两点谁远谁近无所谓 —— **大的自动当外圆**（拿反了也画得对）。
 *
 * ★★ 两圈都是**屏幕正圆**（2026-09-19 改回，与「圆」同一批 —— 用户实测：低缩放下拖
 *   圆环往北会「变成鸡蛋」）：环上 n 个点直接以「投影后的圆心」为心、以投影距离为半径
 *   排圆。形状只由三个控制点的投影位置决定 ⇒ 拖动不变形、缩放等比、倾斜 / 旋转仍是正圆。
 *   早先按「地面圆」（等距经纬平面转圈再投影）会随纬度被压成鸡蛋 —— 推导见
 *   `circle.ts` 文件头 ★★（墨卡托固有、改不掉；用户 2026-09-19 确认改屏幕口径）。
 *
 * ★ 面类：环带（R 与 r 之间）用 **evenodd 填充**（外圈 + 内圈两条子路径，重叠区
 *   抵消出「洞」），`showLine` 可关掉两圈描边只留淡填充。
 * ★ 命中按**半径带**判定（环带内即命中，圆心处的「洞」判不中）—— 引擎默认规则只认
 *   存储顶点的连线，完全对不上，必须自己实现 hitTest 与 cullMargin（同「圆」）。
 * ★ 环是**采样**出来的（不调 ctx.arc）：渲染 / 命中 / 预览要共用同一份点列。
 * ★ **顶点圆点不要在这里画**（见 AGENTS 4 节）；绘制中的落点除外。
 * ===================================================================== */
import { clamp, distToPolyline, fmtM, gdM, pointInRing } from '../math';
import { drawDot, lineDashFor, strokePolyline } from '../paint';
import { MapboxSketch } from '../sketch';
import { MapboxShapeType } from '../sketch-shape-type';
import type { CfgKey, DrawSession, LngLat, ScreenPoint, Shape } from '../types';

/** 采样段数的上下限（同「圆 / 椭圆」） */
const MIN_SEG = 16;
const MAX_SEG = 256;

/** 采样允许的最大拱高(px)：段数按它反解（同「圆 / 椭圆」） */
const MAX_SAGITTA = 0.2;

/** 退化阈值：投影后任一方向的跨度小于这么多像素就画不出（同「圆」的口径） */
const DEGENERATE = 0.5;

export class AnnulusShape extends MapboxShapeType {
  get key(): string { return 'annulus'; }
  get label(): string { return '圆环标注'; }
  get minPts(): number { return 3; }
  get autoCommit(): boolean { return true; }   // 三击即成：圆心 + 外圆 + 内圆

  cfgKeys(): CfgKey[] { return ['showLine']; } // 同「圆 / 扇形」：轮廓可隐藏，只留淡填充

  get hint(): string {
    return '◎ 绘制<b>圆环标注</b>：单击定<b>圆心</b> → 单击定<b>外圆</b>半径 → 移动鼠标定<b>内圆</b>半径'
      + '（第三击即完成）<br />'
      + '・第三点只需给出<b>到圆心的距离</b>（不用精确落在半径线上）；两个半径拿反了也没关系，'
      + '<b>大的自动当外圆</b><br />'
      + '・圆环是<b>屏幕正圆</b>：拖动 / 缩放 / 倾斜地图都不会变形　'
      + '・拖面＝整体平移；拖三个手柄＝分别挪圆心 / 外圆 / 内圆　・<b>Esc</b>＝取消';
  }

  /**
   * 两圈屏幕正圆（屏幕点列）：圆心取**投影后**的圆心，两个半径取**投影后**各点到圆心
   * 的屏幕距离（大的自动当外圆）。形状只由三个控制点的投影位置决定（见文件头 ★★）。
   * 退化（外半径 < 0.5px）时返回 `null`。
   */
  private _rings(
    C: LngLat, P1: LngLat, P2: LngLat,
  ): { outer: ScreenPoint[]; inner: ScreenPoint[] } | null {
    const c = this.project(C);
    const s1 = this.project(P1), s2 = this.project(P2);
    const d1 = Math.hypot(s1.x - c.x, s1.y - c.y);
    const d2 = Math.hypot(s2.x - c.x, s2.y - c.y);
    const R = Math.max(d1, d2), r = Math.min(d1, d2);   // 大的自动当外圆
    if (!(R >= DEGENERATE)) return null;                // 两个半径都 ≈ 0：没有面的形状

    // 段数按屏幕半径的拱高反解（同「圆 / 椭圆」）
    const n = clamp(
      Math.ceil(Math.PI / Math.acos(clamp(1 - MAX_SAGITTA / R, -1, 1))),
      MIN_SEG, MAX_SEG,
    );
    const ring = (rad: number): ScreenPoint[] => {
      const out: ScreenPoint[] = [];
      for (let i = 0; i < n; i++) {
        const t = (i / n) * Math.PI * 2;
        out.push({ x: c.x + rad * Math.cos(t), y: c.y + rad * Math.sin(t) });
      }
      return out;
    };
    const outer = ring(R);
    const inner = r >= DEGENERATE ? ring(r) : [];
    return { outer, inner };
  }

  /** 圆环画在三点包围盒之外（外圈可能伸出去），剔除边距按整条外圈量（同「圆」） */
  cullMargin(shape: Shape): number {
    const Pts = this.projectPts(shape);
    if (Pts.length < 3) return 0;
    const rings = this._rings(shape.pts[0], shape.pts[1], shape.pts[2]);
    if (!rings) return 0;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of Pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    let reach = 0;
    for (const p of rings.outer) {
      const dx = Math.max(minX - p.x, 0, p.x - maxX);
      const dy = Math.max(minY - p.y, 0, p.y - maxY);
      reach = Math.max(reach, Math.hypot(dx, dy));
    }
    const lw = this.styleFor(shape).pathWidth;
    return reach + ((typeof lw === 'number' && lw > 0 ? lw : 3) / 2 + 2);
  }

  describe(shape: Shape): string {
    if (shape.pts.length < 3) return `${this.label} · ${shape.pts.length} 点`;
    const [C, P1, P2] = shape.pts;
    // 半径在**米平面**上报（与「圆」同口径）：两点谁远谁近无所谓，fmtM 各报各的
    const d1 = gdM(C, P1), d2 = gdM(C, P2);
    return `圆环 · 外 ${fmtM(Math.max(d1, d2))} · 内 ${fmtM(Math.min(d1, d2))}`;
  }

  /**
   * 自定义命中：落在**环带**里（外圈之内、内圈之外）算命中本体，
   * 使整个环可悬停变红 / 聚焦后拖三个手柄（圆心 / 外圆 / 内圆）。
   * 圆心处的「洞」判不中 —— 那正是圆环和圆面的区别。
   */
  hitTest(shape: Shape, x: number, y: number, Pts: ScreenPoint[], tol: number): boolean | undefined {
    if (Pts.length !== 3) return undefined;      // 形态超出预期 → 交回默认规则
    const rings = this._rings(shape.pts[0], shape.pts[1], shape.pts[2]);
    if (!rings) return false;                    // 退化：没画出来，也就不该被点中
    const inHole = rings.inner.length >= 3 && pointInRing(x, y, rings.inner);
    if (!inHole && pointInRing(x, y, rings.outer)) return true;   // 环带内
    // 两圈各自外扩一圈容差（洞的边界也算贴着环带）
    if (distToPolyline(x, y, rings.outer, true) <= tol) return true;
    if (rings.inner.length >= 3 && distToPolyline(x, y, rings.inner, true) <= tol) return true;
    return false;
  }

  /** 把一条环接进当前路径（不 beginPath、不 closePath 之外的事） */
  private _path(ctx: CanvasRenderingContext2D, ring: ScreenPoint[]): void {
    if (ring.length < 3) return;
    ctx.moveTo(ring[0].x, ring[0].y);
    for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i].x, ring[i].y);
    ctx.closePath();
  }

  /**
   * 已提交的圆环：环带淡填充（evenodd，内圈挖洞）+ 两圈描边（showLine 可只留填充）。
   * 悬停时描边染成高亮色（同「圆」的做法，走 styleFor 的悬停层）。
   */
  render(shape: Shape): void {
    const ctx = this.ctx;
    const st = this.styleFor(shape);
    if (!ctx || shape.pts.length < 3) return;
    const rings = this._rings(shape.pts[0], shape.pts[1], shape.pts[2]);
    if (!rings) return;                          // 退化：不画

    ctx.save();
    // 环带：外圈 + 内圈两条子路径，evenodd 挖洞
    ctx.beginPath();
    this._path(ctx, rings.outer);
    if (rings.inner.length >= 3) this._path(ctx, rings.inner.slice().reverse());
    ctx.fillStyle = st.polygonFill;
    ctx.fill('evenodd');
    if (shape.cfg.showLine !== false) {
      // 两圈各自描：一圈一条闭合折线（strokePolyline 自带 save/restore 与端点样式）
      strokePolyline(ctx, rings.outer.concat([rings.outer[0]]),
        st.pathColor, st.pathWidth, lineDashFor(st.lineType, st.pathWidth), st.lineOpacity);
      if (rings.inner.length >= 3) {
        strokePolyline(ctx, rings.inner.concat([rings.inner[0]]),
          st.pathColor, st.pathWidth, lineDashFor(st.lineType, st.pathWidth), st.lineOpacity);
      }
    }
    ctx.restore();
  }

  /**
   * 手绘预览：
   *   · 一击未落 —— 光标处一个圆点（示意圆心落哪）
   *   · 落完圆心 —— 圆心与光标两点 + 虚线半径线 + 虚线外圆（一眼看出外半径）
   *   · 落完外圆 —— 再叠一个虚线内圆（第三个点跟手定内半径）
   */
  preview(draw: DrawSession): void {
    const ctx = this.ctx, st = this.style;
    if (!ctx || !st) return;
    const anchor = draw.pts[0] ?? draw.cursor;   // 还没落点时在光标处示意
    if (!anchor) return;
    const C = this.project(anchor);

    ctx.save();
    ctx.globalAlpha = 0.6;
    drawDot(ctx, C.x, C.y, 5, st.previewColor);
    if (draw.pts.length) {
      const P1 = draw.pts[1] ?? draw.cursor;      // 外圆点（落完第二点后固定）
      if (P1) {
        const P1s = this.project(P1);
        drawDot(ctx, P1s.x, P1s.y, 5, st.previewColor);
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 2;
        ctx.strokeStyle = st.previewColor;
        ctx.beginPath();                           // 起始半径辅助线：一眼看出外半径
        ctx.moveTo(C.x, C.y);
        ctx.lineTo(P1s.x, P1s.y);
        ctx.stroke();
        const rings = (draw.pts.length >= 2 && draw.cursor)
          ? this._rings(anchor, P1, draw.cursor)   // 光标即内圆点
          : this._rings(anchor, P1, P1);
        if (rings) {
          for (const ring of [rings.outer, rings.inner]) {
            if (ring.length < 3) continue;
            strokePolyline(ctx, ring.concat([ring[0]]), st.previewColor, 3, [3, 3]);
          }
        }
      }
    }
    ctx.restore();
  }
}

/* 自注册：import 本文件即把类型收进静态注册表 */
MapboxSketch.registerType(AnnulusShape);
