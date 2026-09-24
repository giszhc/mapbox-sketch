/* =====================================================================
 * shapes/line-deco.ts —— 「沿路径铺图案的线类标注」共用基类（**不注册**）。
 *
 * 铁路（枕木）/ 国界（点划线）/ 高压线（杆塔）/ 管道（双线）这四种标注，
 * 形态上是同一件事：**一条主线 + 一层沿线铺开的图案**。差别只在
 * 「主线怎么画」（实线 / 不画 / 两条平行线）与「图案怎么画」（枕木 / 点划 / 杆塔）。
 * 于是抽出这一层基类，四个类型各自只写自己那一小段。
 *
 * ★ 本文件**不调 `MapboxSketch.registerType`**（同 `text-block.ts` 之于
 *   文字 / 富文本标注）：它是个抽象骨架，没有 `key` / `label`，注册进去就是一个
 *   「没有名字、画不出来」的类型。要注册的是它的四个子类。
 *
 * ## 图案为什么按**屏幕像素**铺（而不是按地面距离）
 *
 * 这是**制图惯例**，不是偷懒：地图上的带状符号（铁路枕木、国界点划、高压杆塔）
 * 是「符号」而不是「实物的等比模型」—— 缩放地图时符号跟着放大、图案间距在屏幕上
 * 恒定，这才是一眼能认出来的样子。若按地面米数铺，缩到小比例尺时枕木会密成一片
 * 实心黑、放到大比例尺又稀疏得像虚线。本仓库既有的 `paint.denseTicks`（距离 /
 * 面积标注的密集刻度）走的就是同一套口径，这里与它保持一致。
 *
 * 代价是**间距不随底图比例尺变化**：`TIE_GAP` 这类常量就是「屏幕上的手感」，
 * 与地理尺度无关。要改手感就改那些常量（每个类型文件里各有一份，带注释）。
 *
 * ## 图案算在**地面平面**上（2026-09-18 用户报「地图视角倾斜后变形」）
 *
 * 图案的几何（枕木往哪边伸、偏置线偏多远）**不是**在屏幕坐标里算的，而是在
 * `ground-frame.ts` 那个「地面平面」（`u = lng·cosLat·k`、`v = lat·k`，y 向下）
 * 上算完、再**逐点投影**落到屏幕上：
 *
 * ```ts
 * const f = this.groundFrameAt(lat0);
 * const plane = toPlane(geo, f, 'down');       // 顶点搬到地面平面
 * const seg  = markAt(plane);                  // 图案照旧用屏幕那套算式算（平面 ≈ 未倾斜时的屏幕）
 * const out  = seg.map((p) => this.project(fromPlane(p, f, 'down')));   // 逐点投影
 * ```
 *
 * 为什么非得这样：地图一倾斜（pitch），**南北向的地面距离在屏幕上被压扁**，
 * 而东西向没有。若图案在屏幕空间里算，枕木 / 杆塔就不再垂直于它脚下那段铁路
 * （屏幕上看到的是一条被剪歪的铁路），管道的两条线也会一侧宽一侧窄。搬到地面
 * 平面上算，等于「先在地图上把符号画对，再连同地图一起透视」—— 倾斜后枕木会
 * 按真实透视缩短、拐弯处的偏置线仍然严丝合缝。**这条与「箭头 / 弧线 / 平行线」
 * 那批类型是同一个修法**（见 `ground-frame.ts` 的文件头）。
 *
 * ★ 手性取 `'down'`：平面 y 向下，于是**未倾斜时平面坐标 ≈ 屏幕坐标（差一个平移）**，
 *   各类型里那套按屏幕坐标写的算式（`upNormal`、`offsetPolyline` 的正负号）一个字
 *   都不用改。平移对图案无影响（弧长 / 法线 / 偏置全是相对量）。
 * ★ **只有图案走平面。主线（`g.base`）仍然直接用投影后的顶点**：线状地物的真实位置
 *   就是那串经纬点的连线，逐点投影正是它在屏幕上该有的样子。多绕一次平面只会让
 *   「未倾斜时也差上 1e-13」而没有任何好处。
 *
 * ## 子类要写什么
 *
 * ```ts
 * export class XxxShape extends LineDecoShape {
 *   get key() { return 'xxx'; }
 *   get label() { return '某某标注'; }
 *   protected paintDeco(ctx, g, st) {            // ① 必须：主线 + 图案
 *     this.strokeBase(ctx, g.base, st);           //   主线（不想要就整句删掉）
 *     const segs: Seg[] = [];                     //   图案：算在 g.plane 上
 *     this.alongMarks(g.plane, gap, (x, y, ang) => { ... });
 *     this.strokeSegs(ctx, g.toSegs(segs), ...);  //   落笔前统一投影回去
 *   }
 *   protected reach(st) { return ...; }          // ② 图案伸出主线多少 px（剔除用）
 * }
 * ```
 *
 * 落笔前投影这一步**别忘**：`g.toSegs` / `g.toScreen` / `g.toScreenAll` 就是
 * 「平面 → 屏幕」的三支助手，`strokeSegs` / `fillDots` 收的都是**屏幕**坐标。
 * 完整例子看 `railway.ts`（等距记号）/ `border.ts`（走弧长的点划图案）/
 * `pipeline.ts`（双线）。
 * ===================================================================== */
import { fromPlane, toPlane } from '../ground-frame';
import { buildArc } from '../math';
import { strokePolyline } from '../paint';
import { MapboxShapeType } from '../sketch-shape-type';
import { previewPolyline } from './helpers';
import type { CfgKey, DrawSession, ScreenPoint, Shape, Style } from '../types';

/** 一条线段的两个端点（`strokeSegs` 的入参单元） */
export type Seg = [ScreenPoint, ScreenPoint];

/**
 * 图案的落点系统：**几何在地面平面上算、落笔前逐点投影**（见文件头）。
 *
 * 交给 `paintDeco` 的那个对象就是它 —— 子类拿 `plane` 算图案、拿
 * `toScreen*` 投影，拿 `base` 画主线。
 */
export interface DecoFrame {
  /** 主线：**直接投影**的存储顶点（线状地物本该有的样子，不走平面） */
  base: ScreenPoint[];
  /** 同一条线在**地面平面**上的位置（y 向下，与屏幕同手性）：图案几何一律算在它上面 */
  plane: ScreenPoint[];
  /** 平面点 → 屏幕点（逐点投影 ⇒ 倾斜时跟着地面一起被透视） */
  toScreen(p: ScreenPoint): ScreenPoint;
  /** 平面点列 → 屏幕点列 */
  toScreenAll(pts: ScreenPoint[]): ScreenPoint[];
  /** 一批线段（平面）→ 一批线段（屏幕） */
  toSegs(segs: Seg[]): Seg[];
}

export abstract class LineDecoShape extends MapboxShapeType {
  /** 本族的公共几何口径：一笔连线，两端点起步（同「折线标注」） */
  get minPts(): number { return 2; }
  get closesRing(): boolean { return false; }

  /**
   * 无面板可调配置（同「曲线 / 弧线 / 平行线」那几支纯线类型）：
   * 这四种标注「长什么样」是**类型自带的符号语义**（铁路就该有枕木、国界就该是
   * 点划线），不是一条可以随手改的配置。符号的**粗细**走样式键 `pathWidth`
   * （见下面的 `lineW`），颜色走 `pathColor` —— 那两样才是要调的东西。
   */
  cfgKeys(): CfgKey[] { return []; }

  /** 已提交图形：主线 + 图案，两块都由子类的 `paintDeco` 拼 */
  render(shape: Shape): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const g = this.decoFrame(shape);
    if (!g) return;                                  // 形态不足（< 2 个顶点）：不画半截
    this.paintDeco(ctx, g, this.styleFor(shape));
  }

  /**
   * 手绘预览：与「折线标注」完全一致的虚线 + 落点圆点。
   *
   * ★ **预览里不铺图案**：一是四个类型的预览长得一模一样，逐点落点时反而看不出
   *   差别（差别在落地之后）；二是预览是「还在画」的提示，虚线橡皮筋已经说清了
   *   「现在连到哪」，再叠一层枕木 / 杆塔只是把落点圆点糊住。
   * ★ 预览也因此**不用地面平面**（画的只是一条橡皮筋，没有图案几何）。
   */
  preview(draw: DrawSession): void {
    previewPolyline(this, draw);
  }

  /** 列表行描述（同「平行线 / 垂直线」那几支的写法） */
  describe(shape: Shape): string {
    return `${this.label} · ${shape.pts.length} 点`;
  }

  /**
   * 视口剔除的安全边距：图案画在主线上、又向两侧伸出，光按存储顶点算会误剔除。
   * 子类用 `reach()` 报「最远伸出多少像素」，这里再加 2px 收尾。
   */
  cullMargin(shape: Shape): number {
    return this.reach(this.styleFor(shape)) + 2;
  }

  /* ---------------- 子类要实现的 ---------------- */

  /**
   * 画出这条图形（主线与图案都由它决定）。
   * 形态不足（点列太短、算不出弧长）时**直接返回**，不要画半截。
   *
   * @param g 图案的落点系统：`g.plane` 上算、`g.toSegs / toScreenAll` 投影、`g.base` 画主线
   */
  protected abstract paintDeco(
    ctx: CanvasRenderingContext2D, g: DecoFrame, st: Style,
  ): void;

  /** 图案在主线之外伸出的最大像素数（`cullMargin` 用；默认 0 = 不伸出） */
  protected reach(_st: Style): number { return 0; }

  /* ---------------- 给子类用的现成助手 ---------------- */

  /**
   * 造图案的落点系统（见 `DecoFrame`）。形态不足（投影顶点 < 2）时返回 `null`。
   *
   * 平面比例尺取**第一个顶点所在纬度**（同「箭头 / 弧线」那批：一条线跨越的纬度
   * 有限，用一个纬度的比例尺足够；真要跨十几个纬度那是另一回事）。
   */
  private decoFrame(shape: Shape): DecoFrame | null {
    const base = this.projectPts(shape);              // 主线：同帧缓存，不重复投影
    if (base.length < 2) return null;
    const f = this.groundFrameAt(shape.pts[0][1]);
    const plane = toPlane(shape.pts, f, 'down');      // 'down'：平面 y 向下，算式与屏幕同手性
    const toScreen = (p: ScreenPoint): ScreenPoint => this.project(fromPlane(p, f, 'down'));
    return {
      base,
      plane,
      toScreen,
      toScreenAll: (pts) => pts.map(toScreen),
      toSegs: (segs) => segs.map((s): Seg => [toScreen(s[0]), toScreen(s[1])]),
    };
  }

  /**
   * 铺图案时的**有效线宽**：样式键 `pathWidth`（线宽）。
   *
   * ★ 它同时是**符号的尺寸基准**（枕木多长、杆塔多高都按它成比例），所以
   *   `pathWidth ≤ 0`（用户把线宽拖到 0）时退到 3 而不是 0 —— 否则整条符号
   *   会缩成一个点、看着像「这条标注坏了」。0 的含义在纯线类型上是「不描边」，
   *   在这一族上只能理解成「按出厂粗细画」（符号没有「看不见的粗细」这回事）。
   */
  protected lineW(st: Style): number {
    const w = st.pathWidth;
    return typeof w === 'number' && w > 0 ? w : 3;
  }

  /** 主线的默认画法：一根圆头实线（跟随 `pathColor / pathWidth / lineOpacity`） */
  protected strokeBase(
    ctx: CanvasRenderingContext2D, Pts: ScreenPoint[], st: Style,
  ): void {
    strokePolyline(ctx, Pts, st.pathColor, st.pathWidth, null, st.lineOpacity);
  }

  /**
   * 沿弧长每 `gap`(px) 调一次 `draw(x, y, ang)` —— 等距记号那一族（枕木 / 杆塔）共用。
   *
   * ★ 传进来的必须是 `g.plane`（**不是** `g.base`）：图案要在地面平面上等距铺，
   *   倾斜时才跟着地面一起压缩。
   * `ang` 是该处**切线角**（弧度），记号要垂直于线就取 `upNormal(ang)`、要沿着线
   * 就取 `(cos ang, sin ang)`。起点在 `s = 0`（线头上也有一个记号），之后按 `gap`
   * 等步走到底；最后一段不足 `gap` 就不再补一个（补了会挤出一个比别处窄一半的记号，
   * 比缺口更显眼）。
   */
  protected alongMarks(
    plane: ScreenPoint[], gap: number, draw: (x: number, y: number, ang: number) => void,
  ): void {
    const arc = buildArc(plane);
    if (!arc || !(gap > 0)) return;
    for (let s = 0; s <= arc.total; s += gap) {
      const p = arc.at(s);
      draw(p.x, p.y, p.ang);
    }
  }

  /**
   * 一批线段**一次性**描边（一遍 `beginPath` + 一遍 `stroke`）。收**屏幕**坐标。
   *
   * 不逐根 `strokePolyline` 是刻意的：枕木 / 杆塔动辄几十上百根，逐根走一遍
   * `save/restore + beginPath + stroke` 会白白多出几百次上下文状态切换 ——
   * 而这些记号本来就同色同宽，本来也该是一笔画出来的。
   *
   * 端头用 `butt`（平头）而不是圆头：记号是一根「刻线」，圆头会让它比算出来的长度
   * 多出一个线宽的尺寸，密排时相邻两根会糊在一起。
   */
  protected strokeSegs(
    ctx: CanvasRenderingContext2D, segs: Seg[],
    color: string, width: number, alpha: number | null,
  ): void {
    if (!segs.length) return;
    ctx.save();
    if (alpha != null) ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
    ctx.beginPath();
    for (const [a, b] of segs) {
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  /**
   * 一批**实心圆点**一次性填充（点划线里那个「点」、以后的点状记号都用它）。
   * 收**屏幕**坐标；半径是**屏幕尺寸**，不参与投影（符号的粗细不跟着地面透视变）。
   *
   * ★ 不用 `paint.drawDot`：那个原语是给「手绘预览落点」用的 —— 它除了填色还会
   *   描一圈**白边**（为了让记号在卫星影像上不糊进背景）。国界上的点描白边会变成
   *   一个个白圈，跟点划线的语义完全不搭。这里要的是纯色实心点，所以自己拼路径。
   */
  protected fillDots(
    ctx: CanvasRenderingContext2D, dots: ScreenPoint[], r: number,
    color: string, alpha: number | null,
  ): void {
    if (!dots.length || !(r > 0)) return;
    ctx.save();
    if (alpha != null) ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    for (const p of dots) {
      ctx.moveTo(p.x + r, p.y);                 // 每个点自成子路径，免得被连成一根线
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.restore();
  }
}
