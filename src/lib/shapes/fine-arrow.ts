/* =====================================================================
 * shapes/fine-arrow.ts —— 内置类型：FineArrowShape「细直箭头标注」。
 *
 * ★★ 几何**照搬**标绘库 mapbox-plot 的 `src/gispace/plot/FineArrow.js`
 *   （＝ openlayers-plot 的 `P.PlotTypes.FINE_ARROW`，那个 demo 的按钮中文名
 *   「细直箭头」；用户 2026-09-17 要求新增，口头叫它「粗单尖头箭头」），
 *   以及它依赖的 `src/gispace/PlotUtils.js` / `src/gispace/Constants.js`。
 *   常量、算式、退化分支一律**别按自己审美重写**，否则 `test/shapes-fine-arrow.spec.ts`
 *   的金标准会红。
 *
 * ## 原版算法在做什么
 *
 * 1. 用户点 **2 个点**（原版 `fixPointCount = 2`）：`p0` = 箭尾、`p1` = 箭头尖端。
 * 2. `len = getBaseLength([p0, p1])`（＝两点距离 ^ 0.99）；三处宽度都由它乘系数：
 *    `tailWidth = len × 0.15`（箭尾宽）、`neckWidth = len × 0.2`（箭颈宽）、
 *    `headWidth = len × 0.25`（箭头宽）。
 * 3. 尾巴两点 `tailLeft / tailRight = getThirdPoint(p1, p0, HALF_PI, tailWidth, ±)`
 *    （从尖端往箭尾方向挑，即箭尾横档的两端）；头两点 `headLeft / headRight =
 *    getThirdPoint(p0, p1, headAngle=π/8.5, headWidth, ∓)`；颈两点 `neckLeft / neckRight
 *    = getThirdPoint(p0, p1, neckAngle=π/13, neckWidth, ∓)`。
 * 4. 拼成 **7 点闭合多边形**
 *    `[tailLeft, neckLeft, headLeft, p1, headRight, neckRight, tailRight]`
 *    —— 一条细长箭身 + 一个带倒刺的箭头（填充 + 描边，是个「面」）。
 *
 * ★ **y 轴要取反**（同「集结地 / 双箭头」）：原版跑在地理坐标（y 向上），本引擎跑在
 *   屏幕坐标（y 向下）；`getThirdPoint(..., clockWise)` 是手性相关的，取反后才与原版
 *   逐点（含顶点顺序）一致。
 *
 * ★ **存储顶点＝用户点的 2 个点**（箭头形态只在渲染期算，不写回 `pts`）——
 *   于是编辑态拖的还是那 2 个点，拖完箭头实时跟着变（同「矩形 / 双箭头」的口径）。
 *
 * ★ **顶点圆点不要在这里画**（见 AGENTS 4 节）；绘制中的落点除外（原版也画）。
 * ===================================================================== */
import { distToPolyline, pointInRing } from '../math';
import { drawDot } from '../paint';
import { MapboxSketch } from '../sketch';
import { toPlane } from '../ground-frame';
import { MapboxShapeType } from '../sketch-shape-type';
import type { LngLat, CfgKey, DrawSession, ScreenPoint, Shape } from '../types';
import { getBaseLength, getThirdPoint } from './plot-utils';

/** 几何常量（原版 `Constants.js`） */
const HALF_PI = Math.PI / 2;
/**
 * 细直箭头的五个比例因子（＝原版 `FineArrow` 构造函数里那五个值）。
 *
 * ★ 「突击方向标注」在原版里就是 `goog.inherits(P.Plot.AssaultDirection, P.Plot.FineArrow)`
 *   —— **同一套几何、只换这五个数**，所以这里把它做成可替换的参数，别再抄一份几何。
 */
export interface FineArrowFactors {
  /** 箭尾宽 / 箭颈宽 / 箭头宽：都乘 `base = getBaseLength([p0,p1])` */
  tailWidthFactor: number;
  neckWidthFactor: number;
  headWidthFactor: number;
  /** 箭头 / 箭颈相对轴线的张角（弧度） */
  headAngle: number;
  neckAngle: number;
}

/** 原版 `FineArrow` 的出厂因子（「细直箭头标注」用这一套） */
export const FINE_ARROW_FACTORS: FineArrowFactors = {
  tailWidthFactor: 0.15,
  neckWidthFactor: 0.2,
  headWidthFactor: 0.25,
  headAngle: Math.PI / 8.5,
  neckAngle: Math.PI / 13,
};

/** 预览虚线的节奏（与其它类型的手绘预览同一套观感） */
const PREVIEW_DASH: [number, number] = [3, 3];

/** 一条细直箭头的屏幕几何（就是那个 7 点闭合多边形） */
type Ring = ScreenPoint[];

/* ------------------------------------------------------------------ *
 * 原版 PlotUtils 的逐行搬移见 `plot-utils.ts`（箭头一族共用）——这里不再抄一份。
 * 几何跑在「地理坐标」上；`_ring` 负责进门翻面、出门翻回。
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 原版 FineArrow.generate —— 2 点算出那条 7 点闭合轮廓（跑在「地理坐标」上）
 * ------------------------------------------------------------------ */

function generate(raw: ScreenPoint[], f: FineArrowFactors): Ring | null {
  const n = raw.length;
  if (n < 2) return null;                          // 原版 `count < 2` 直接 return
  const pnt1 = raw[0], pnt2 = raw[1];
  const base = getBaseLength([pnt1, pnt2]);
  const tailWidth = base * f.tailWidthFactor;
  const neckWidth = base * f.neckWidthFactor;
  const headWidth = base * f.headWidthFactor;
  const tailLeft = getThirdPoint(pnt2, pnt1, HALF_PI, tailWidth, true);
  const tailRight = getThirdPoint(pnt2, pnt1, HALF_PI, tailWidth, false);
  const headLeft = getThirdPoint(pnt1, pnt2, f.headAngle, headWidth, false);
  const headRight = getThirdPoint(pnt1, pnt2, f.headAngle, headWidth, true);
  const neckLeft = getThirdPoint(pnt1, pnt2, f.neckAngle, neckWidth, false);
  const neckRight = getThirdPoint(pnt1, pnt2, f.neckAngle, neckWidth, true);
  return [tailLeft, neckLeft, headLeft, pnt2, headRight, neckRight, tailRight];
}

export class FineArrowShape extends MapboxShapeType {
  get key(): string { return 'fineArrow'; }
  get label(): string { return '细直箭头标注'; }
  get minPts(): number { return 2; }
  get autoCommit(): boolean { return true; }   // 两击即成：同原版 fixPointCount = 2

  cfgKeys(): CfgKey[] { return ['showLine']; } // 同其它面类：轮廓可隐藏，只留淡填充

  /**
   * 五个比例因子。**子类换掉它就能得到另一种箭头** —— 原版的「突击方向」正是
   * `AssaultDirection extends FineArrow`，只改了这五个数，几何一行没动。
   */
  protected factors(): FineArrowFactors { return FINE_ARROW_FACTORS; }

  get hint(): string {
    return '↟ 绘制<b>细直箭头标注</b>（单尖头直箭头，亦称<b>粗单尖头箭头</b>）：'
      + '单击定<b>箭尾</b> → 移动鼠标把<b>箭头尖端</b>摆到位 → 第二次单击完成（两击即成）<br />'
      + '・箭身 / 箭头的宽度都按两点距离成比例　・落的两点都在轮廓上，编辑时拖它们改形状　・<b>Esc</b>＝取消';
  }

  /* ---------------- 几何：渲染 / 命中 / 剔除 / 预览四处共用同一份算式 ---------------- */

  /**
   * 由「已落点 [+ 光标]」算出这条细直箭头的闭合轮廓；点数不够或退化时返回 `null`。
   *
   * ★ 进门先把 `y` 取反（原版跑在地理坐标 y 向上，本引擎跑在屏幕坐标 y 向下），
   *   出门再取回来 —— 不取反箭头会上下镜像（原版有手性相关分支，见文件头）。
   */
  private _ring(geo: LngLat[]): Ring | null {
    if (geo.length < 2) return null;
    // ★ 顶点先换算到**地面平面**再喂给 `generate()`（手性 = 'up'，对应原来那次 y 取反），
    //   算完折回经纬、逐点投影 —— 倾斜 / 旋转时形状跟着地面走（2026-09-18 修）。
    const f = this.groundFrameAt(geo[0][1]);
    const ring = generate(toPlane(geo, f), this.factors());
    if (!ring) return null;
    const back = this.planeToScreen(ring, f);
    const finite = (p: ScreenPoint): boolean => Number.isFinite(p.x) && Number.isFinite(p.y);
    if (!back.every(finite)) return null;   // 退化输入（两点重合）可能吐 Infinity，交回默认
    return back;
  }

  describe(shape: Shape): string {
    return `${this.label} · ${shape.pts.length} 顶点`;
  }

  /**
   * 轮廓画在锚点之外（箭头 / 箭尾都往两侧探出 `base × 0.25` 左右），必须量整条轮廓
   * 来定余量，否则滑出屏幕时会被误剔除。算不出来时退回「线宽那一档」。
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

  /** 已提交的形状：一条闭合的细直箭头（淡填充 + 轮廓；showLine 关掉就只留填充） */
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
   * 手绘预览：**与落地同一套几何**（原版每帧把「已落点 + 光标」整体重算一遍），
   * 所以预览长什么样、落下就是什么样。
   *
   * ★ 一击未落时不画（原版 `count < 2` 直接 return）；
   * ★ 落 1 击 + 光标 = 2 点 ⇒ 整条细直箭头立刻出现 —— 第 2 击落下即定稿。
   */
  preview(draw: DrawSession): void {
    const ctx = this.ctx, st = this.style;
    if (!ctx || !st) return;

    const geo = draw.pts.concat(draw.cursor ? [draw.cursor] : []);
    if (!geo.length) return;                       // 一击未落：不画
    const Pts = geo.map((p) => this.project(p));   // 只用来画落点圆点
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
MapboxSketch.registerType(FineArrowShape);
