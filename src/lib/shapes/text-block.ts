/* =====================================================================
 * shapes/text-block.ts —— 「文字标注」与「富文本标注」共用的**锚点式文字块**基类。
 *
 * 两个类型是同一套交互，只有「一行里画什么」不一样：
 *   · 文字标注：整行一个样式（样式面板里的字号 / 颜色 / 描边）；
 *   · 富文本标注：一行里可以有多段，每段自己的字号 / 颜色 / 粗体 / 斜体 / 下划线。
 * 而下面这些**一个字都不该有两份**（各写一份迟早跑偏成「同一个柄，两个类型转出来的角不一样」）：
 *
 *   · 落点口径：`minPts = 1` + `autoCommit`（单击一下即落一个文字块，同「点 / 引线」）；
 *   · 旋转角存在 `Shape.data.rot`（度，`[0, 360)`）—— 它是**每条各不相同、也不该被
 *     下一条继承**的东西，所以不进 `cfg`（`cfg` 的每个键都会被 `config()` 写进全局
 *     默认供新图形继承，转过的文字不能让下一段也歪着出生，同图片标注的图片本体）；
 *   · 旋转柄是**派生手柄**（下标 1 ≥ `pts.length` = 1）：位置由「锚点 + 块高 + 角度」
 *     现算，`pts` 里没有对应项 —— 所以拖它必须由 `dragTo()` 自己算（引擎不会替派生
 *     手柄写顶点），`cullMargin()` / `vertexCursor()` / `drawHandles()` 也都得跟着覆盖；
 *   · 块高 / 块宽按**行 × 段**现算（`layout()`），命中检测是「把光标反着转回文字自己的
 *     坐标系，再判一个轴对齐矩形」—— 不这么做的话整块文字只有正中心那一小块点得中；
 *   · 拖柄 = 绕锚点转、Shift 每 15° 吸附一档、面板「几何参数 → 旋转角度」写的是同一个数。
 *
 * ── 旋转角怎么变成方向 ──────────────────────────────────────────────
 * `θ` 用的是 canvas 的旋转角（`ctx.rotate`，屏幕 y 向下 → 正值顺时针）：
 *   「文字向右」= (cosθ, sinθ)     「文字向上」= (sinθ, −cosθ) = paint.upNormal
 * 多行以**锚点为整块的中心**上下匀开：第 i 行的中心 = 锚点 + 「文字向下」× 行心偏移。
 *
 * ★ 本文件**不是**一个可注册的类型（没有 `MapboxSketch.registerType`），只是两个类型
 *   的公共父类 —— 它继承 `MapboxShapeType` 但不实现 `render()`，谁用它谁自己画。
 * ===================================================================== */
import { rotateCursor } from '../cursors';
import { cssFont } from '../math';
import {
  drawDot, handleDot, measureTextCached, rotateHandleIcon, upNormal,
} from '../paint';
import { LINE_H } from '../rich-text';
import { MapboxShapeType } from '../sketch-shape-type';
import type {
  DragContext, DrawSession, GeomPatch, GeomState, RichSegment, ScreenPoint, Shape,
} from '../types';

/** 旋转柄离文字块上边的距离(px)：与图片标注同一个摆法（`KNOB_GAP`） */
const KNOB_GAP = 30;

/** 按住 Shift 时旋转吸附的网格(度) */
const SNAP_DEG = 15;

/** 命中判定在文字块外**额外**给的余量(px)：字块是实心矩形，但四角不好压准 */
const HIT_PAD = 4;

/** 空文字时那个「这儿有一条空标注」记号的半径(px) */
const EMPTY_MARK = 7;

/** 量不出宽时「一个字约几个字号」的估算系数（只影响命中框与柄的位置，不影响画出来的字） */
const FALLBACK_CHAR_W = 0.9;

/**
 * 文字块里的一段：`seg` 是样式，`w` / `size` 是**量出来 / 定下来**的那两个数。
 *
 * 宽度在 `layout()` 里算一次就存下来（渲染时按它逐段推进），不留给渲染再量一遍 ——
 * 一帧里 `layout()` 至少要被问三次（剔除余量、命中预筛、渲染），量的是同一串字。
 */
export interface SegLayout {
  seg: RichSegment;
  /** 该段量出来的宽(px) */
  w: number;
  /** 该段实际用的字号(px)（段自己写了 `s=` 就用它，否则是样式面板的 textSize） */
  size: number;
}

/** 一行：若干段 + 该行的宽与行距 */
export interface LineLayout {
  segs: SegLayout[];
  /** 该行总宽(px)（＝各行落点用的宽度） */
  w: number;
  /** 该行行距(px) = 该行最大字号 × LINE_H，取整 */
  h: number;
}

/** 整块的排版结果：逐行 + 块宽 + 块高 */
export interface BlockLayout {
  lines: LineLayout[];
  w: number;
  h: number;
}

/** 一段「没有自己的样式」的文字（文字标注的每一行就是它） */
export function plainSeg(text: string): RichSegment {
  return {
    text, size: null, color: null, bold: false, italic: false, underline: false,
    bg: null, radius: null,
  };
}

export abstract class TextBlockShape extends MapboxShapeType {
  get minPts(): number { return 1; }
  get autoCommit(): boolean { return true; }   // 单击一次即完成，无需双击 / 回车

  /**
   * 子类给出「这条图形要画哪几行、每行哪几段」。
   * 富文本标注走 `rich-text.ts` 的解析结果；文字标注把 `cfg.text` 按 `\n` 切行、每行一段。
   */
  protected abstract linesOf(shape: Shape): RichSegment[][];

  /** 这条图形当前用的基准字号(px)：文字大小是**样式**（textSize），不是几何 */
  protected fontSizeOf(shape: Shape): number {
    const size = this.styleFor(shape).textSize;
    return size != null && size > 0 ? size : 15;
  }

  /**
   * 一段文字的 font 串。
   *
   * ★ 粗体 / 斜体是拼进 `cssFont` 的 weight 位（`italic 700 15px …` 是合法的 CSS
   *   font 简写）：`cssFont` 的第二个参数本来就收 `number | string`，库内别处传的都是
   *   数字，这里复用它是为了「字体族、默认字重」那两条口径只有一份。
   */
  protected fontOf(seg: RichSegment, size: number): string {
    const parts: string[] = [];
    if (seg.italic) parts.push('italic');
    if (seg.bold) parts.push('700');
    return parts.length ? cssFont(size, parts.join(' ')) : cssFont(size);
  }

  /** 一段量出来的宽(px)：量不出（没有可用 2d 上下文 / 量字抛错）时按字号估一个 */
  private _segWidth(
    c: CanvasRenderingContext2D | null | undefined,
    seg: RichSegment,
    size: number,
  ): number {
    if (!seg.text) return 0;
    if (c && typeof c.measureText === 'function') {
      try {
        return measureTextCached(c, seg.text, this.fontOf(seg, size));
      } catch { /* 量不出宽 → 走下面的估算 */ }
    }
    return Array.from(seg.text).length * size * FALLBACK_CHAR_W;
  }

  /**
   * 文字块之外**还要多占**的地方(px)：默认 0（`layout()` 量出来的就是画出来的）。
   *
   * ★ 这是给「字以外还画了东西」的类型留的口子：富文本的**整块背景**四周各外扩
   *   一点、段级高亮色带左右各外扩一点（见 `shapes/rich-text.ts` 的 `BG_PAD`），
   *   不问这一句的话，底色最外那一两个像素点不中、悬停框也比底色小一圈
   *   —— 画在哪就该点在哪。
   *   `y` 目前只有富文本的整块背景会用（色带纵向正好是整行高，不需要额外留白）。
   */
  protected padOf(_shape: Shape): { x: number; y: number } {
    return { x: 0, y: 0 };
  }

  /**
   * 整块的排版：逐行量宽、定行距（＝该行**最大**字号 × LINE_H），块宽取最长那行。
   *
   * 行距按「该行最大字号」而不是固定字号：富文本里一行可以写着 28px 的标题和 15px
   * 的正文，行距跟着大的那个走才不挤；纯文字的每一段都没有自己的字号，于是恒等于
   * `round(textSize × 1.35)` —— 与改造前逐字一致。
   *
   * @param ctx 要量字就传**这一帧要画的那个** ctx；只问尺寸（剔除 / 命中）时可以省，
   *            那时用它自己的 `this.ctx`（量的是同一串字，缓存在 `measureTextCached`）
   */
  protected layout(shape: Shape, ctx?: CanvasRenderingContext2D | null): BlockLayout {
    const fallback = this.fontSizeOf(shape);
    const c = ctx || this.ctx;
    const lines: LineLayout[] = [];
    let w = 0;
    let h = 0;
    for (const segs of this.linesOf(shape)) {
      let lineW = 0;
      let maxSize = 0;
      const out: SegLayout[] = [];
      for (const seg of segs) {
        const size = seg.size != null && seg.size > 0 ? seg.size : fallback;
        if (size > maxSize) maxSize = size;
        const sw = this._segWidth(c, seg, size);
        out.push({ seg, w: sw, size });
        lineW += sw;
      }
      const lh = Math.round((maxSize || fallback) * LINE_H);
      lines.push({ segs: out, w: lineW, h: lh });
      if (lineW > w) w = lineW;
      h += lh;
    }
    return { lines, w, h };
  }

  /**
   * 每一行的行心相对锚点的偏移(px)：沿「文字向下」方向，整块以锚点为中心上下匀开。
   * 行高逐行可能不同（富文本），所以要累加而不是「(i − (n−1)/2) × 行距」。
   */
  protected lineOffsets(block: BlockLayout): number[] {
    const out: number[] = [];
    let y = -block.h / 2;
    for (const ln of block.lines) {
      out.push(y + ln.h / 2);
      y += ln.h;
    }
    return out;
  }

  /** 这条文字转了多少弧度（`Shape.data.rot` 存的是度，坏值当 0 = 正放） */
  protected rotRad(shape: Shape): number {
    return (this.rotDeg(shape) * Math.PI) / 180;
  }

  /** 这条文字转了多少度（`[0, 360)`；没转过 / 是坏值都是 0） */
  protected rotDeg(shape: Shape): number {
    const deg = (shape.data || {}).rot;
    return typeof deg === 'number' && isFinite(deg) ? this.normDeg(deg) : 0;
  }

  /** 把角度（度）归一化到 `[0, 360)` 并抹掉浮点尾巴（同图片标注的 `readGeom`） */
  protected normDeg(deg: number): number {
    let d = ((deg % 360) + 360) % 360;
    d = Math.round(d * 10) / 10;
    return d >= 360 ? 0 : d;                 // 四舍五入到 360 = 没转（面板上别出现 360）
  }

  /**
   * 旋转柄的屏幕位置：锚点 + 「文字向上」× (块高/2 + `KNOB_GAP`)。
   *
   * ★ 算式只有这一份：`handles()`（引擎据它判定点着了第几支手柄）、`drawHandles()`
   *   （画图标）、`cullMargin()`（剔除余量）三处都走它 —— 各写一份就会出现
   *   「图标画在这儿、手柄得去那儿拖」。
   */
  protected knob(shape: Shape, A: ScreenPoint): ScreenPoint {
    const { h } = this.layout(shape);
    const n = upNormal(this.rotRad(shape));
    const d = h / 2 + KNOB_GAP;
    return { x: A.x + n.x * d, y: A.y + n.y * d };
  }

  /**
   * 两支手柄：0 号 = 锚点（拖它整体平移，走引擎默认），1 号 = **旋转柄**。
   *
   * 1 号是派生手柄（下标 ≥ `pts.length`）：位置由锚点 + 块高 + 角度现算，`pts` 里没有
   * 对应项，所以拖它由 `dragTo()` 自己处理。形态算不出来时（顶点没投影出来）退回
   * `projectPts()` —— 手柄总得抓得着，少了它至少锚点还能拖。
   */
  handles(shape: Shape): ScreenPoint[] {
    const Pts = this.projectPts(shape);
    const A = Pts[0];
    if (!A || !isFinite(A.x) || !isFinite(A.y)) return Pts;
    return [A, this.knob(shape, A)];
  }

  /**
   * 旋转柄画在文字块之外（还有那个圆牌图标），剔除时按**外接圆**放宽：
   * 块的对角半径与「柄离锚点的距离」取大者，再加图标半径与一点余量。
   */
  cullMargin(shape: Shape): number {
    const { w, h } = this.layout(shape);
    const pad = this.padOf(shape);
    const diag = Math.hypot(w / 2 + pad.x, h / 2 + pad.y);
    return Math.max(diag, h / 2 + KNOB_GAP) + 14;
  }

  /**
   * 自定义「本体」命中：文字块是一个**转了角度的矩形**，引擎默认那套只认存储顶点
   * （这里就 1 个锚点）—— 不实现的话只有正中心那一小块点得中，整块文字都点不着，
   * 也就无法悬停 / 拖主体平移。
   *
   * 做法是把光标转到文字自己的坐标系里，再按「半宽 / 半高 + 容差」判一个轴对齐矩形
   * （与渲染用的是同一个 `layout()` / 角度，画在哪就点在哪）。
   */
  hitTest(shape: Shape, x: number, y: number, Pts: ScreenPoint[], tol: number): boolean {
    const A = Pts[0];
    if (!A) return false;
    const { w, h } = this.layout(shape);
    if (!h) return Math.hypot(x - A.x, y - A.y) <= tol + EMPTY_MARK;   // 空文字：锚点附近一小圈
    const pad = this.padOf(shape);
    const a = this.rotRad(shape);
    const c = Math.cos(a), s = Math.sin(a);
    const dx = x - A.x, dy = y - A.y;
    // 反向旋转 θ：得到「沿文字向右 / 沿文字向下」两个分量
    const du = dx * c + dy * s;
    const dv = -dx * s + dy * c;
    return Math.abs(du) <= w / 2 + tol + HIT_PAD + pad.x
      && Math.abs(dv) <= h / 2 + tol + HIT_PAD + pad.y;
  }

  /* ---------------- 拖动：旋转（平移走引擎默认） ---------------- */

  /**
   * 自算拖拽：只有 **1 号（旋转柄）** 需要自己算，其余的（拖锚点、拖文字本体）
   * 返回 `false` 交回引擎 —— 「顶点跟光标」「主体整体平移」正是要的。
   *
   * 角度 = 「从锚点指向光标」这个方向当作文字的**上方**（柄就长在文字块上边中点，
   * 柄的方向天然就是文字的上方向）。按住 Shift 先吸附到 15° 网格（同图片标注的
   * 拖柄口径，引擎自己的吸附只看 Alt）。
   *
   * ★ 与「拖柄=柄跟光标走」的图片标注不同，这里**不存柄的位置**：柄的位置由角度
   *   与块高现算，所以拖到哪、离多远都行，它始终贴在文字块上边的正外侧
   *   —— 文字块的大小是随内容变的，把柄钉在某个距离上下一帧就会被文字撑歪。
   */
  dragTo(ctx: DragContext): boolean {
    if (ctx.kind !== 'vertex' || ctx.vi !== 1) return false;
    const A = this.projectPts(ctx.shape)[0];
    if (!A) return false;
    const p = ctx.point || this.project(ctx.cursor);
    if (!isFinite(p.x) || !isFinite(p.y)) return true;      // 拿不到光标：这一帧不动
    const dx = p.x - A.x, dy = p.y - A.y;
    const len = Math.hypot(dx, dy);
    if (!(len > 1e-6)) return true;                         // 光标压在锚点上：方向不定
    // 上方向 n = (dx, dy)/len，而 n = (sinθ, -cosθ) → θ = atan2(n.x, -n.y)
    let a = Math.atan2(dx / len, -dy / len);
    if (ctx.shift) {
      const step = (SNAP_DEG * Math.PI) / 180;
      a = Math.round(a / step) * step;
    }
    const shape = ctx.shape;
    if (!shape.data) shape.data = {};
    shape.data.rot = this.normDeg((a * 180) / Math.PI);
    return true;
  }

  /** 旋转柄给「转圈」光标；锚点是普通顶点，交回引擎默认 */
  vertexCursor(_shape: Shape, vi: number): string | null {
    return vi === 1 ? rotateCursor() : null;
  }

  /**
   * 自己画这两支手柄（引擎只在**选中**这条图形、编辑态下调用）。
   *
   * 0 号（锚点）用引擎那支通用的「白芯 + 橙圈」（`paint.handleDot`，与不实现本钩子时
   * 长得一模一样），1 号（旋转柄）画成**转圈箭头图标** —— 光靠鼠标指针说不出这个柄是
   * 干什么的，而 Safari / Firefox 根本不画 SVG 光标（见 cursors.ts）。
   * 位置一律从 `handles()` 取：那正是引擎判定「点着了哪一支」用的点列。
   */
  drawHandles(shape: Shape, hoverVi: number): boolean {
    const ctx = this.ctx;
    if (!ctx) return false;
    const Hs = this.handles(shape);
    const K = Hs[1];
    if (!K || !isFinite(K.x) || !isFinite(K.y)) return false;   // 形态算不出：交回通用白点
    handleDot(ctx, Hs[0].x, Hs[0].y, hoverVi === 0);
    rotateHandleIcon(ctx, K.x, K.y, hoverVi === 1);
    return true;
  }

  /* ---------------- 面板上的几何控件（只有「旋转角度」） ---------------- */

  /**
   * 读当前几何：只有**旋转角度**（屏幕量纲，0 = 正放、顺时针为正，见 `GeomState`）。
   *
   * ★ 不给 `sizePx`：文字的大小是样式键 `textSize`（面板「文字」组里那行「字号」），
   *   不是几何 —— 同一个数两处可调只会让人不知道改的是哪个。`GeomState.sizePx` 因此
   *   是**可选**的：只有「尺寸本身可调」的类型（图片标注）才给。
   */
  readGeom(shape: Shape): GeomState | null {
    if (!this.projectPts(shape).length) return null;
    return { rotateDeg: this.rotDeg(shape) };
  }

  /**
   * 面板上改旋转角：与拖柄**写的是同一个数**（`Shape.data.rot`），只是输入从
   * 「光标在哪」换成「一个数」。
   *
   * 坏值（NaN / 无穷）当「这一项没给」而不是「改成一个坏值」（同图片标注的 `writeGeom`）；
   * 值没变则返回 `false` —— 面板每敲一下都返回 true 的话，会白重绘一帧、白通知一次宿主。
   */
  writeGeom(shape: Shape, patch: GeomPatch): boolean {
    const rot = patch.rotateDeg;
    if (typeof rot !== 'number' || !isFinite(rot)) return false;
    const deg = this.normDeg(rot);
    if (deg === this.rotDeg(shape)) return false;
    if (!shape.data) shape.data = {};
    shape.data.rot = deg;
    return true;
  }

  /* ---------------- 两个类型共用的绘制片段 ---------------- */

  /**
   * 悬停反馈：绕着文字块画一圈虚线（转过的角度跟着一起转），提示「这块可拖」。
   * 颜色是全局的悬停色（同「点」的外圈虚线圆）。
   */
  protected hoverBox(ctx: CanvasRenderingContext2D, A: ScreenPoint, w: number, h: number, a: number): void {
    if (!(w > 0) || !(h > 0)) return;
    ctx.save();
    ctx.translate(A.x, A.y);
    ctx.rotate(a);
    ctx.strokeStyle = this.hoverColor;
    ctx.lineWidth = 1.6;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(-w / 2 - 3, -h / 2 - 3, w + 6, h + 6);
    ctx.restore();                 // restore 一并复位 lineDash
  }

  /** 空文字时的记号：一个虚线小圈（只在悬停 / 选中时） */
  protected markEmpty(ctx: CanvasRenderingContext2D, shape: Shape, A: ScreenPoint): void {
    if (!this.isHovered(shape) && !this.isFocused(shape)) return;
    ctx.save();
    ctx.strokeStyle = this.hoverColor;
    ctx.lineWidth = 1.6;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.arc(A.x, A.y, EMPTY_MARK, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * 手绘预览：光标处一个候选圆点 + 一个十字，示意「文字会以这一点为中心摆开」。
   * 文字内容此刻还拿不到（预览只有落点，没有 cfg），所以只给位置记号。
   */
  preview(draw: DrawSession): void {
    const ctx = this.ctx, st = this.style;
    if (!draw.cursor || !ctx || !st) return;
    const p = this.project(draw.cursor);
    ctx.save();
    ctx.globalAlpha = 0.6;
    drawDot(ctx, p.x, p.y, 5, st.previewColor);
    const r = 13;
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = st.previewColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(p.x - r, p.y);
    ctx.lineTo(p.x + r, p.y);
    ctx.moveTo(p.x, p.y - r);
    ctx.lineTo(p.x, p.y + r);
    ctx.stroke();
    ctx.restore();
  }
}
