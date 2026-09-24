/* =====================================================================
 * shapes/helpers.ts —— 内置类型之间共用的渲染片段。
 *
 * 主要就三件事：手绘预览（线段型 / 面型 / 自由手绘）、「悬停红」判定、自由手绘抽稀。
 * 新类型若也是「折线」或「闭合面」，直接调这里的助手即可，不必照抄。
 * ===================================================================== */
import { drawDot, fillRing, strokePolyline } from '../paint';
import { simplifyPolyline } from '../math';
import type { MapboxShapeType } from '../sketch-shape-type';
import type { DrawSession, LngLat, Shape } from '../types';

/** 把「已落点 + 当前光标」拼成完整预览点列 */
function previewGeo(draw: DrawSession) {
  return draw.pts.concat(draw.cursor ? [draw.cursor] : []);
}

/**
 * 线段型预览：虚线折线 + 各落点圆点。
 * 适用于「线 / 路径文字 / 距离标注」这类开放式折线。
 */
export function previewPolyline(inst: MapboxShapeType, draw: DrawSession): void {
  const ctx = inst.ctx, st = inst.style;
  const all = previewGeo(draw);
  if (!all.length || !ctx || !st) return;
  const Pts = all.map((g) => inst.project(g));
  if (Pts.length >= 2) strokePolyline(ctx, Pts, st.previewColor, 3, [3, 3]);
  Pts.forEach((p) => drawDot(ctx, p.x, p.y, 5, st.previewColor));
}

/**
 * 面型预览：≥3 点时淡面填充 + 闭合虚线环 + 各落点圆点。
 * 适用于「面 / 面积标注」这类自动闭合的类型。
 */
export function previewRing(inst: MapboxShapeType, draw: DrawSession): void {
  const ctx = inst.ctx, st = inst.style;
  if (!ctx || !st) return;
  const all = previewGeo(draw);
  if (!all.length) return;
  const Pts = all.map((g) => inst.project(g));

  // ≥3 个顶点了，先预览面内淡填充（连回首点闭合）
  if (Pts.length >= 3) {
    const fillPts = draw.pts.length && draw.cursor ? Pts.concat([Pts[0]]) : Pts;
    fillRing(ctx, fillPts, st.previewFill);
  }
  // 闭合虚线预览（已落点 + 光标 → 回到首点）
  if (draw.pts.length >= 1) {
    const dashPts = Pts.concat([Pts[0]]);
    if (dashPts.length >= 3) strokePolyline(ctx, dashPts, st.previewColor, 3, [3, 3]);
  }
  Pts.forEach((p) => drawDot(ctx, p.x, p.y, 5, st.previewColor));
}

/**
 * 视口剔除的安全边距：给「文字画在顶点之外」的类型用。
 * 取该图形最终线宽的一半 + 一个常量余量，够覆盖边中/拐点外侧的水平标注。
 */
export function outsideTextMargin(inst: MapboxShapeType, shape: Shape, extra = 26): number {
  const st = inst.styleFor(shape);
  return (st.pathWidth || 3) / 2 + extra;
}

/* ---------------- 自由手绘 ---------------- */

/**
 * 自由手绘的预览：**实线**笔迹（面型先铺一层淡填充）。
 *
 * 与 `previewPolyline` / `previewRing` 的两处不同，都不是随手写的：
 *   · **不画落点圆点** —— 手绘的落点是 3px 一个的采样点，按 5px 半径画出来
 *     整条线就是一条毛虫（圆点直径比点间距还大）；
 *   · **实线而不是虚线** —— 虚线是「橡皮筋」的语义（还没定下来的两段之间拉一条），
 *     而手绘这一笔画下去就是最终的线，用虚线看着像在闪烁；
 *   · 面型在 ≥3 点时就先把闭合填充铺上（首尾那一小段回折也算），
 *     收笔后会怎么填，画的时候就看得见。
 */
export function previewFreehand(inst: MapboxShapeType, draw: DrawSession, ring = false): void {
  const ctx = inst.ctx, st = inst.style;
  if (!ctx || !st) return;
  const Pts = draw.pts.map((g) => inst.project(g));
  if (Pts.length < 2) return;
  if (ring && Pts.length >= 3) fillRing(ctx, Pts, st.previewFill);
  const line = ring && Pts.length >= 3 ? Pts.concat([Pts[0]]) : Pts;
  strokePolyline(ctx, line, st.previewColor, 3, null);
}

/** 自由手绘抽稀的屏幕容差(px)：一条笔迹被碾平到「偏离不超过 1.5px」 */
export const FREEHAND_SIMPLIFY_PX = 1.5;

/**
 * 自由手绘落点完成后的**抽稀**：投影 → Douglas-Peucker → 反投影回经纬度。
 *
 * 采样（引擎按 3px 记点）与抽稀是两件事：前者保证不漏掉手上的动作，后者负责
 * 「别存一堆没用的点」。一条随手画的线动辄几百个顶点，其中大半落在近似直线上 ——
 * 留着它们，存档大、编辑态的手柄还会糊成一片。
 *
 * ★ 容差是**屏幕像素**（见 `math.simplifyPolyline`），所以同一个笔迹在不同缩放级下
 *   抽出来的顶点数不同。这是刻意的：抽稀要保的是「看起来还是那条线」。
 * ★ 一个点都没丢掉时返回**原数组的浅拷贝**，不走「投影 → 反投影」那一趟 ——
 *   那趟会带来约 1e-9 度的浮点漂移，没必要白挨。
 * ★ 投影不可用（宿主已销毁、样式没就绪）时原样返回：`normalize()` 在提交那一刻跑，
 *   失败绝不该把整条笔迹吞掉。
 */
export function simplifyFreehand(
  inst: MapboxShapeType, raw: LngLat[], tol = FREEHAND_SIMPLIFY_PX,
): LngLat[] {
  if (raw.length <= 3) return raw.slice();          // 没有可丢的中间点
  try {
    const map = inst.map;
    if (!map) return raw.slice();
    const sp = raw.map((p) => map.project(p));
    const keep = simplifyPolyline(sp, tol);
    if (keep.length >= raw.length || keep.length < 2) return raw.slice();
    return keep.map((p) => {
      const ll = map.unproject([p.x, p.y]);
      return [ll.lng, ll.lat] as LngLat;
    });
  } catch {
    return raw.slice();
  }
}
