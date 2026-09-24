/* =====================================================================
 * shapes/straight-arrow.ts —— 内置类型：StraightArrowShape「直箭头标注」。
 *
 * ⚠️ **这个形状是「照用户给的图新画的」，不是标绘库的移植。**
 *   标绘库 mapbox-plot 里的 `StraightArrow`（＝ demo 按钮「直箭头」）其实是
 *   `ol.geom.LineString`：杆线 + V 形倒刺、**描边不填充**，跟用户要的不是一回事。
 *   用户 2026-09-17 的原话：「再加『粗单直箭头』也就是直箭头」+ 一张截图
 *   （矩形箭杆 + 三角箭头的**块状箭头**，蓝描边、面填充）。
 *   对照图见 `C:/Users/giszh/AppData/Local/Temp/ref/straight-arrow-candidates.png`
 *   （A/B 是原版、C 才是用户要的）—— 用户明确选了 C。
 *   ⇒ 所以这里没有「原版逐点」可对，金标准是**自证**（钉住本实现自己的几何），
 *     不是跟别人的实现比。别拿 mapbox-plot 的 StraightArrow 去校它。
 *
 * ## 几何（轴向对称，无手性，不需要翻面）
 *
 * 两个用户点：`p0` = 箭尾、`p1` = 箭头尖端。设 `L = |p0→p1|`，`u` = 轴向单位向量，
 * `n` = 它的法向：
 *   · 箭杆：从 `p0` 到「颈部」`p1 − u·headLen`，半宽 `shaftHalf`
 *   · 箭头：颈部到 `p1` 的三角，半宽 `headHalf`
 * 拼成 **7 点闭合多边形**（矩形杆 + 三角头，正是「块状箭头」）：
 *   `[tailL, neckL, headTop, p1, headBot, neckR, tailR]`
 *
 * 比例（相对 `L`，数值照用户截图估的，改这几个常量就能调胖瘦）：
 *   · `shaftHalf = L × 0.06`　（箭杆半宽 ⇒ 杆宽 = 12% L）
 *   · `headHalf  = L × 0.135` （箭头半宽 ⇒ 头宽 = 27% L）
 *   · `headLen   = L × 0.17`  （箭头沿轴向的长度）
 *
 * ★ **存储顶点＝用户点的 2 个点**（形状只在渲染期算，不写回 `pts`）。
 * ★ **顶点圆点不要在这里画**（见 AGENTS 4 节）；绘制中的落点除外。
 * ===================================================================== */
import { toPlane } from '../ground-frame';
import { distToPolyline, pointInRing } from '../math';
import { drawDot } from '../paint';
import { MapboxSketch } from '../sketch';
import { MapboxShapeType } from '../sketch-shape-type';
import type { CfgKey, DrawSession, LngLat, ScreenPoint, Shape } from '../types';

/** 块状直箭头的固定比例（相对两点距离；照用户截图估的，可调胖瘦） */
const SHAFT_HALF_WIDTH_FACTOR = 0.06;
const HEAD_HALF_WIDTH_FACTOR = 0.135;
const HEAD_LENGTH_FACTOR = 0.17;
/** 两点短于这个距离就当退化（画不成箭头） */
const MIN_LENGTH = 1e-6;

/** 预览虚线的节奏（与其它类型的手绘预览同一套观感） */
const PREVIEW_DASH: [number, number] = [3, 3];

/** 一条块状直箭头的屏幕几何（就是那个 7 点闭合多边形） */
type Ring = ScreenPoint[];

/** 由两点算出块状箭头轮廓；退化（两点重合）时返回 `null` */
function generate(raw: ScreenPoint[]): Ring | null {
  if (raw.length < 2) return null;
  const p0 = raw[0], p1 = raw[1];
  const dx = p1.x - p0.x, dy = p1.y - p0.y;
  const L = Math.hypot(dx, dy);
  if (!(L > MIN_LENGTH)) return null;              // 两点重合：画不出箭头
  const ux = dx / L, uy = dy / L;                  // 轴向单位向量
  const nx = -uy, ny = ux;                         // 法向（垂直于轴向）
  const shaftHalf = L * SHAFT_HALF_WIDTH_FACTOR;
  const headHalf = L * HEAD_HALF_WIDTH_FACTOR;
  const headLen = L * HEAD_LENGTH_FACTOR;
  const neckX = p1.x - ux * headLen, neckY = p1.y - uy * headLen;   // 颈（箭杆末端）
  const off = (bx: number, by: number, d: number): ScreenPoint => ({ x: bx + nx * d, y: by + ny * d });
  const tailL = off(p0.x, p0.y, shaftHalf);
  const tailR = off(p0.x, p0.y, -shaftHalf);
  const neckL = off(neckX, neckY, shaftHalf);
  const neckR = off(neckX, neckY, -shaftHalf);
  const headTop = off(neckX, neckY, headHalf);
  const headBot = off(neckX, neckY, -headHalf);
  return [tailL, neckL, headTop, p1, headBot, neckR, tailR];
}

export class StraightArrowShape extends MapboxShapeType {
  get key(): string { return 'straightArrow'; }
  get label(): string { return '直箭头标注'; }
  get minPts(): number { return 2; }
  get autoCommit(): boolean { return true; }   // 两击即成

  cfgKeys(): CfgKey[] { return ['showLine']; } // 同其它面类：轮廓可隐藏，只留淡填充

  get hint(): string {
    return '➤ 绘制<b>直箭头标注</b>（粗单直箭头，块状箭头）：单击定<b>箭尾</b> → '
      + '移动鼠标把<b>箭头尖端</b>摆到位 → 第二次单击完成（两击即成）<br />'
      + '・矩形箭杆 + 三角箭头，整条形状是一个闭合多边形　・落的两点都在轮廓上，编辑时拖它们改形状　・<b>Esc</b>＝取消';
  }

  /* ---------------- 几何：渲染 / 命中 / 剔除 / 预览四处共用同一份算式 ---------------- */

  /**
   * 由「已落点 [+ 光标]」算出这条块状箭头的闭合轮廓；点数不够或退化时返回 `null`。
   *
   * ★ 顶点先换算到**地面平面**（`ground-frame.ts`）再喂给 `generate()`，出来的
   *   轮廓点再折回经纬、逐点投影 —— 地图倾斜 / 旋转时形状跟着地面走，不会因为
   *   「屏幕像素差变了」而变形（2026-09-18 修）。
   */
  private _ring(geo: LngLat[]): Ring | null {
    if (geo.length < 2) return null;
    const f = this.groundFrameAt(geo[0][1]);
    // ★ 本类型的 `generate()` 是直接按**屏幕坐标**（y 向下）写的，所以平面也按同一
    //   手性喂进去（`'down'`）—— 否则轮廓点序会镜像反转，逐点金标准立刻对不上
    const out = generate(toPlane(geo, f, 'down'));
    if (!out) return null;
    const ring = this.planeToScreen(out, f, 'down');
    const finite = (p: ScreenPoint): boolean => Number.isFinite(p.x) && Number.isFinite(p.y);
    if (!ring.every(finite)) return null;
    return ring;
  }

  describe(shape: Shape): string {
    return `${this.label} · ${shape.pts.length} 顶点`;
  }

  /**
   * 轮廓画在锚点之外（箭头 / 箭杆都往两侧探出），必须量整条轮廓来定余量，
   * 否则滑出屏幕时会被误剔除。算不出来时退回「线宽那一档」。
   */
  cullMargin(shape: Shape): number {
    const lw = this.styleFor(shape).pathWidth;
    const pad = (typeof lw === 'number' && lw > 0 ? lw : 3) / 2 + 4;
    const Pts = this.projectPts(shape);
    if (Pts.length < 2) return pad;
    const ring = this._ring(shape.pts);
    if (!ring) return pad;
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
    return reach + pad;
  }

  /**
   * 自定义命中：量**真正画出来的那个 7 点闭合多边形**，不是引擎默认的「两点连线」。
   * 点在轮廓内即命中；轮廓外再按「贴着边」放一圈容差。
   */
  hitTest(shape: Shape, x: number, y: number, Pts: ScreenPoint[], tol: number): boolean | undefined {
    if (Pts.length < 2) return undefined;        // 形态超出预期 → 交回默认规则
    const ring = this._ring(shape.pts);
    if (!ring) return distToPolyline(x, y, Pts, false) <= tol;
    if (ring.length >= 3 && pointInRing(x, y, ring)) return true;
    return distToPolyline(x, y, ring, true) <= tol;
  }

  /** 已提交的形状：一条闭合的块状箭头（淡填充 + 轮廓；showLine 关掉就只留填充） */
  render(shape: Shape): void {
    const ctx = this.ctx;
    const ring = this._ring(shape.pts);
    if (!ctx || !ring) return;
    const st = this.styleFor(shape);

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(ring[0].x, ring[0].y);
    for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i].x, ring[i].y);
    ctx.closePath();
    ctx.fillStyle = st.polygonFill;
    ctx.fill();
    if (shape.cfg.showLine !== false) {
      // ★ 描边用 pathColor：悬停高亮染的正是它（见基类 styleFor）
      ctx.globalAlpha = st.lineOpacity;
      ctx.lineWidth = st.pathWidth;
      ctx.strokeStyle = st.pathColor;
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * 手绘预览：**与落地同一套几何**，所以预览长什么样、落下就是什么样。
   * ★ 一击未落时不画；落 1 击 + 光标 = 2 点 ⇒ 整条块状箭头立刻出现，第 2 击落下即定稿。
   */
  preview(draw: DrawSession): void {
    const ctx = this.ctx, st = this.style;
    if (!ctx || !st) return;

    const geo = draw.pts.concat(draw.cursor ? [draw.cursor] : []);
    if (!geo.length) return;                       // 一击未落：不画
    const Pts = geo.map((p) => this.project(p));
    const ring = geo.length >= 2 ? this._ring(geo) : null;

    ctx.save();
    ctx.globalAlpha = 0.6;
    if (ring) {
      ctx.beginPath();
      ctx.moveTo(ring[0].x, ring[0].y);
      for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i].x, ring[i].y);
      if (ring.length >= 3) {
        ctx.closePath();
        ctx.fillStyle = st.previewFill;
        ctx.fill();
      }
      ctx.setLineDash(PREVIEW_DASH);
      ctx.lineWidth = 3;
      ctx.strokeStyle = st.previewColor;
      ctx.stroke();
    }
    // 已落点 + 光标各点一下（`restore` 一并复位 lineDash）
    Pts.forEach((p) => drawDot(ctx, p.x, p.y, 5, st.previewColor));
    ctx.restore();
  }
}

/* 自注册：import 本文件即把类型收进静态注册表 */
MapboxSketch.registerType(StraightArrowShape);
