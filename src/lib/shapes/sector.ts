/* =====================================================================
 * shapes/sector.ts —— 内置类型：SectorShape「扇形标注」。
 *
 * 存 3 个顶点：[圆心 C, 起始边端点 S, 终止边端点 E]：
 *   · 半径 r = C 到 S 的**地理**距离（与「圆 / 椭圆」同口径：地理尺寸，缩放跟着变）
 *   · 起始方位 = 地面上 C→S 的方位角；终止方位 = C→E 的方位角
 *   · **E 只提供方向，半径永远用 r** —— 否则三点连出来就成了任意四边形，不是扇形
 * 夹角统一取**较小的一侧**（|Δ| ≤ 180°）：三次单击分不出「往哪边扫」，
 * 小夹角是唯一无歧义的取法，也正好覆盖「四分之一圆 / 半圆」这些常用形状。
 * 单击定圆心、橡皮筋预览、第三击即成（autoCommit，同「点 / 圆 / 椭圆」）。
 *
 * ★★ 几何在**地理空间**定义（2026-09-18 修，与 rect / ellipse / circle 同一批）：
 *   半径与两个方位角都在「等距经纬平面」里量（`u = lng·cos(lat)`、`v = lat`，
 *   东西向与南北向按米等权），弧上各点先在地面上参数化、再逐一投影。
 *   无倾斜 / 无旋转时与旧画法逐点相同（旧版在屏幕空间量半径与角度）；
 *   相机一动，扇形走真实投影 —— 不再随倾斜 / 旋转按单方向乱缩乱转
 *   （用户 2026-09-18 报「扇形也会变形」）。
 *
 * ★ 同 circle / ellipse：只存 3 个点却画出一整片扇形，弧还会画到三点包围盒之外，
 *   必须自己实现 hitTest 与 cullMargin（后者同时管「画不画」和「点不点得中」）。
 *
 * ★ 弧采样成折线来画（不直接用 ctx.arc 拼路径）：填充、描边、命中、预览就全在
 *   同一份点列上 —— 命中直接复用基类的 `defaultRingHit`，不会出现「看着在扇区里、
 *   引擎却认为点不中」。采样够密，成品上看不出是折线。
 * ===================================================================== */
import { clamp, fmtM, gdM, localM } from '../math';
import { drawDot, fillRing, lineDashFor, strokePolyline } from '../paint';
import { MapboxSketch } from '../sketch';
import { MapboxShapeType, defaultRingHit } from '../sketch-shape-type';
import type { CfgKey, DrawSession, LngLat, ScreenPoint, Shape } from '../types';

/** 弧上采样密度：每段弧长不超过这么多像素（拱高远小于 1 像素，看不出折线） */
const ARC_SEG_PX = 4;
const MIN_ARC_SEG = 8;
const MAX_ARC_SEG = 180;

/** 退化阈值：屏幕半径小于 0.5px、或张角小于 0.001 弧度，就画不出扇形了 */
const DEGENERATE_R = 0.5;
const DEGENERATE_SWEEP = 1e-3;

/** 等距经纬平面里的一个点（u = lng·cos(lat)，v = lat） */
const toUV = (ll: LngLat, cosLat: number): { u: number; v: number } =>
  ({ u: ll[0] * cosLat, v: ll[1] });

/** 两条边之间的夹角（弧度），归一化到 (-π, π] —— 即恒取较小的一侧 */
function minorSweep(a0: number, a1: number): number {
  return Math.atan2(Math.sin(a1 - a0), Math.cos(a1 - a0));
}

/** 扇形的**地面**几何：圆心（等距平面）+ 半径（等距平面单位）+ 起始角 + 扫过角 */
interface SectorGeom {
  cu: number;
  cv: number;
  r: number;
  a0: number;
  sweep: number;
  cosLat: number;
}

export class SectorShape extends MapboxShapeType {
  get key(): string { return 'sector'; }
  get label(): string { return '扇形标注'; }
  get minPts(): number { return 3; }
  get autoCommit(): boolean { return true; }   // 三击即成：圆心 + 起始边 + 终止边

  cfgKeys(): CfgKey[] { return ['showLine']; } // 同「面」：轮廓可隐藏，只留淡填充

  get hint(): string {
    return '◔ 绘制<b>扇形标注</b>：单击定<b>圆心</b> → 单击定<b>起始边</b> → 单击定<b>终止边</b>（第三击即完成）<br />'
      + '・半径取<b>起始边</b>的长度，终止边只定方向；两边之间取<b>较小夹角</b>（≤180°）<br />'
      + '・扇形跟着地面走（倾斜 / 旋转地图时走真实投影）　・三点逐一<b>单击</b>，别双击（双击会撤掉上一点）<br />'
      + '・拖面＝整体平移；拖手柄＝只动那个点，拖<b>圆心</b>会连着改形状　・<b>Esc</b>＝取消';
  }

  /**
   * 扇形的**地面**几何（等距经纬平面里量）；退化（半径 ≈ 0、终止边方向不明、
   * 或张角 ≈ 0）时返回 null。
   */
  private _geom(C: LngLat, S: LngLat, E: LngLat): SectorGeom | null {
    const cosLat = Math.max(Math.cos((C[1] * Math.PI) / 180), 0.01);
    const c = toUV(C, cosLat), s = toUV(S, cosLat), e = toUV(E, cosLat);
    const su = s.u - c.u, sv = s.v - c.v;
    const eu = e.u - c.u, ev = e.v - c.v;
    const r = Math.hypot(su, sv);
    // ★ 终止边端点与圆心重合时必须先挡住：`atan2(0, 0)` 返回的是 0，会被当成
    //   「终止边指向正东」，于是一个方向根本没定下来的图形**凭空画出一片扇形**
    //   （画的、命中的、describe 报的都基于这个假角度，画面上看不出哪里不对）。
    //   这条路很容易走到：吸附会把光标吸到本图形自己的已落点上（圆心也是候选），
    //   落第三下时手一抖就撞上。不能指望 atan2 的退化约定。
    if (r < 1e-9 || Math.hypot(eu, ev) < 1e-9) return null;
    const a0 = Math.atan2(sv, su);
    const sweep = minorSweep(a0, Math.atan2(ev, eu));
    if (Math.abs(sweep) < DEGENERATE_SWEEP) return null;
    return { cu: c.u, cv: c.v, r, a0, sweep, cosLat };
  }

  /**
   * 扇形环（屏幕点列）：**首点是圆心**，其后是弧上的采样点 —— 末点即弧的另一端，
   * 所以闭合起来正好是「圆心 → 起始边 → 弧 → 终止边 → 圆心」。
   * render / hitTest / preview 共用同一份点列（各写一份 = 「看着在扇区里、点不中」）。
   */
  private _ring(C: LngLat, S: LngLat, E: LngLat): ScreenPoint[] | null {
    const g = this._geom(C, S, E);
    if (!g) return null;
    const C0 = this.project(C);
    /** 地面上角度 t 处的点（等距平面 → 经纬度） */
    const at = (t: number): LngLat => [
      (g.cu + g.r * Math.cos(t)) / g.cosLat,
      g.cv + g.r * Math.sin(t),
    ];
    // 屏幕上的半径：取起始边端点（必在弧上）与弧中点两者里更远的那个，量一次
    let rPx = 0;
    for (const t of [g.a0, g.a0 + g.sweep / 2, g.a0 + g.sweep]) {
      const s = this.project(at(t));
      rPx = Math.max(rPx, Math.hypot(s.x - C0.x, s.y - C0.y));
    }
    if (rPx < DEGENERATE_R) return null;
    // 采样段数按**弧长**定：小扇形不必画上百个点，大扇形的每段也不会拉成长弦
    const n = clamp(Math.ceil((Math.abs(g.sweep) * rPx) / ARC_SEG_PX), MIN_ARC_SEG, MAX_ARC_SEG);
    const out: ScreenPoint[] = [C0];
    for (let i = 0; i <= n; i++) out.push(this.project(at(g.a0 + g.sweep * (i / n))));
    return out;
  }

  /**
   * 扇形画在三点包围盒之外（弧可能伸出去，倾斜 / 旋转下更明显），
   * 剔除边距 = 整条环超出包围盒的伸出量 + 线宽余量。
   * ★ 它同时管着「画不画」（`_visible`）与「点不点得中」（`_pickNear`）。
   */
  cullMargin(shape: Shape): number {
    const Pts = this.projectPts(shape);
    if (Pts.length < 3) return 0;
    const ring = this._ring(shape.pts[0], shape.pts[1], shape.pts[2]);
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
    if (shape.pts.length < 3) return `${this.label} · ${shape.pts.length} 点`;
    const [C, S, E] = shape.pts;
    // 张角在**米平面**上量，与地面口径等价（地图带 bearing 时两者只差一个整体旋转，
    // 夹角不变），好处是 describe 不依赖地图是否就绪
    const u = localM(C, S), v = localM(C, E);
    // 起始边或终止边退化成零长度（`[C, S, C]` 这种也凑得齐 minPts = 3，吸附还会
    // 主动帮你凑）—— 这时画面上什么都没有，再报一个「看着很合理」的半径和角度，
    // 就只剩下列表里那条数字与画布对不上，没人知道该往哪找
    if (Math.hypot(u.x, u.y) < 1e-6 || Math.hypot(v.x, v.y) < 1e-6) {
      return `${this.label} · 退化`;
    }
    const sweep = minorSweep(Math.atan2(u.y, u.x), Math.atan2(v.y, v.x));
    const deg = Math.round(Math.abs(sweep) * 180 / Math.PI);
    return `扇形 · 半径 ${fmtM(gdM(C, S))} · ${deg}°`;
  }

  /**
   * 自定义命中：扇区内部（外扩一圈容差）都算命中本体，
   * 使整片扇形可悬停变红 / 聚焦后拖三个手柄（圆心 / 起始边端 / 终止边端）。
   */
  hitTest(shape: Shape, x: number, y: number, Pts: ScreenPoint[], tol: number): boolean | undefined {
    if (Pts.length !== 3) return undefined;      // 形态超出预期 → 交回默认规则
    const ring = this._ring(shape.pts[0], shape.pts[1], shape.pts[2]);
    if (!ring) return false;                     // 没画出来，也就不该被点中
    // 基类的默认面类规则：环内 或 贴着环（两条半径 + 弧）—— 与画出来的完全一致
    return defaultRingHit(x, y, ring, tol);
  }

  /** 已提交的扇形：淡填充 + 描边（showLine 可只留填充）；悬停时描边染成高亮色 */
  render(shape: Shape): void {
    const ctx = this.ctx;
    const st = this.styleFor(shape);
    if (!ctx || shape.pts.length < 3) return;
    const ring = this._ring(shape.pts[0], shape.pts[1], shape.pts[2]);
    if (!ring) return;                           // 退化（半径 / 张角 ≈ 0）：不画

    fillRing(ctx, ring, st.polygonFill);
    if (shape.cfg.showLine !== false) {
      // 补回首点成闭合环：闭合那一段就是「终止边 → 圆心」，两条半径与弧一起描出来
      strokePolyline(ctx, ring.concat([ring[0]]), st.pathColor, st.pathWidth, lineDashFor(st.lineType, st.pathWidth), st.lineOpacity);
    }
  }

  /**
   * 手绘预览：
   *   · 一击未落 —— 光标处一个圆点（示意圆心落哪）
   *   · 落完圆心 —— 中心与光标两点 + 虚线半径线（一眼看出半径与起始角）
   *   · 落完起始边 —— 再叠一个虚线扇形（第三个点跟手定终止角）
   */
  preview(draw: DrawSession): void {
    const ctx = this.ctx, st = this.style;
    if (!ctx || !st) return;
    const cur = draw.cursor;
    const anchor = draw.pts[0] ?? cur;           // 还没落点时在光标处示意
    if (!anchor) return;
    const C = this.project(anchor);

    ctx.save();
    ctx.globalAlpha = 0.6;
    drawDot(ctx, C.x, C.y, 5, st.previewColor);
    if (draw.pts.length) {
      const S = draw.pts[1] ?? cur;              // 起始边端点（落完第二点后固定）
      if (S) {
        const Sp = this.project(S);
        drawDot(ctx, Sp.x, Sp.y, 5, st.previewColor);
        strokePolyline(ctx, [C, Sp], st.previewColor, 2, [3, 3]);   // 起始边辅助线
        if (draw.pts.length >= 2 && cur) {
          const ring = this._ring(anchor, S, cur);                  // 光标即终止边端点
          if (ring) strokePolyline(ctx, ring.concat([ring[0]]), st.previewColor, 3, [3, 3]);
        }
      }
    }
    ctx.restore();
  }
}

/* 自注册：import 本文件即把类型收进静态注册表 */
MapboxSketch.registerType(SectorShape);
