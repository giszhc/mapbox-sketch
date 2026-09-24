/* =====================================================================
 * shapes/bubble.ts —— 内置类型：BubbleShape「气泡标注」。
 *
 * ★★ 本类型是**新画**的（用户 2026-09-18 要求新增，附截图：白底圆角框 +
 *   底部小尾巴 + 文字）—— 标绘库 mapbox-plot 里没有对应的 Plot，按「直箭头 /
 *   平行线」的先例：交互与几何自己定，文件头写清楚，**不是移植**。
 *
 * ## 画法与几何（单击即成，同「点 / 文字标注」）
 *
 *   在地图上**单击一下**即落一个气泡 —— 落点是**尾巴的尖端**，气泡体悬在点的
 *   正上方（尾巴从体底边中点竖直指向落点）。
 *
 * 存 **1 个顶点 = 尾巴尖**（`minPts = 1` + `autoCommit`，同「文字标注」）。
 * 大小全部现算，不进顶点：
 *   · 文字内容来自 `cfg.text`（可多行，`\n` 换行），类型专属默认「气泡标注」；
 *   · 体宽 = 最长行量出来的宽 + 左右内边距、体高 = 行数 × 行距 + 上下内边距
 *     （量字走 `measureTextCached`，同「文字标注」的 `_block`）。
 *
 * ── 颜色从哪来 ──────────────────────────────────────────────────────
 * 气泡体走**标准的 `polygonFill`（面内填充）**，类型专属默认用 `defaultStyle()`
 * 钉成**白色**（附图口径）—— 面板现成的「面内填充」行就能改底色（含每图形覆盖 /
 * 「恢复默认」回白），不必新造一个样式键。全局那套黄 30% 的默认对气泡不生效。
 * 描边（体框 + 尾巴两条侧边）走 `pathColor` / `pathWidth` / `lineOpacity`，
 * **类型专属默认 0 = 不描边**（`defaultStyle()`；要边框就在面板上调「线宽」，
 * 全局那套 3px 是线面引线共用的，不动它）。
 * 文字走 `textColor` / `textSize` / 白描边（haloColor / haloWidth）—— 与「文本
 * 标注」同一套键，样式面板自动就有。
 *
 * ★ 几何是普通屏幕向量运算，**不需要 y 翻转**（只有 mapbox-plot 移植类型才翻）。
 * ★ 空文字与「文字标注」同口径：悬停 / 选中时画个虚线小圈，静态不出图。
 * ===================================================================== */
import { cssFont } from '../math';
import { drawDot, haloText, measureTextCached, roundRectPath } from '../paint';
import { MapboxSketch } from '../sketch';
import { MapboxShapeType } from '../sketch-shape-type';
import type { CfgKey, CfgPatch, DrawSession, ScreenPoint, Shape, StylePatch } from '../types';

/** 气泡体左右内边距(px) */
const PAD_X = 10;
/** 气泡体上下内边距(px) */
const PAD_Y = 6;
/** 圆角半径(px) */
const CORNER = 6;
/** 尾巴底边半宽(px)（底边全宽 = 2 × 它） */
const TAIL_HALF = 6;
/** 尾巴高度(px)：从体底边到尖端 */
const TAIL_H = 12;
/** 多行行距 = 字号 × 它（与「文字标注 / 引线」同一口径） */
const LINE_H = 1.35;
/** 命中判定在气泡体外**额外**给的余量(px)：同「文字标注」的 HIT_PAD */
const HIT_PAD = 4;
/** 空文字时那个「这儿有一条空标注」记号的半径(px)：同「文字标注」 */
const EMPTY_MARK = 7;

/** 气泡体的屏幕矩形（x/y = 左上角）与尾巴尖端 */
interface Body {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class BubbleShape extends MapboxShapeType {
  get key(): string { return 'bubble'; }
  get label(): string { return '气泡标注'; }
  get minPts(): number { return 1; }
  get autoCommit(): boolean { return true; }   // 单击一次即完成，无需双击 / 回车

  cfgKeys(): CfgKey[] { return ['text']; }

  /** 类型专属默认配置：新画的气泡默认写「气泡标注」（同「文字标注」的口径） */
  defaultCfg(): CfgPatch {
    return { text: '气泡标注' };
  }

  /**
   * 类型专属默认样式：**轮廓默认 0（不描边）**、气泡底默认**白色**（参考图口径：
   * 附图里的气泡只有一圈细边，纯色面上细边几乎看不见，索性默认不描）。
   *
   * 不去动全局 `pathWidth`（3px）与 `polygonFill`（黄 30%）—— 那两个是线、面、
   * 引线共用的，按气泡的口味改会把整张地图一起改掉（理由同「图片标注」的
   * 2px / 0.85，见 shapes/image.ts）。面板回显是它们、「恢复默认」清掉覆盖
   * 之后落回来的也是它们。要边框就在面板上把「线宽」调大（0 = 不描边）。
   */
  defaultStyle(): StylePatch {
    return { pathWidth: 0, polygonFill: '#ffffff' };
  }

  get hint(): string {
    return '💬 绘制<b>气泡标注</b>：在地图上单击一下即落一个气泡，<b>无需双击/回车</b><br />'
      + '・落点＝<b>尾巴尖端</b>，气泡体悬在点的正上方；内容在右侧面板里改，<b>支持多行</b><br />'
      + '・拖气泡本体＝平移（尾巴尖跟着走）　・样式面板可改文字颜色 / 字号 / 边框粗细（0＝无边框）';
  }

  /* ---------------- 几何：文字行 / 气泡体矩形（渲染 / 命中 / 剔除共用） ---------------- */

  /** 本类型要画的【文字行】：`cfg.text` 按 `\n` 切分（同「文字标注」的 linesFor） */
  protected linesFor(shape: Shape): string[] {
    const raw = (shape.cfg || {}).text;
    if (raw == null || raw === '') return [];
    const lines = String(raw).split('\n').map((ln) => (ln.endsWith('\r') ? ln.slice(0, -1) : ln));
    return lines.some((ln) => ln !== '') ? lines : [];
  }

  /** 这条气泡当前用的字号(px)：文字大小是**样式**（textSize），不是几何 */
  private _fontSize(shape: Shape): number {
    const size = this.styleFor(shape).textSize;
    return size != null && size > 0 ? size : 15;
  }

  /**
   * 文字块的屏幕尺寸：宽 = 最长那行量出来的宽、高 = 行数 × 行距。
   * 量字走 `measureTextCached`（同「文字标注」的 `_block`，一帧要被问多次）；
   * 量不出宽时按「一个字约 0.9 个字号」估一个。
   */
  private _block(shape: Shape, ctx?: CanvasRenderingContext2D | null): {
    w: number; h: number; lh: number; n: number;
  } {
    const lines = this.linesFor(shape);
    const fs = this._fontSize(shape);
    const lh = Math.round(fs * LINE_H);
    const n = lines.length;
    if (!n) return { w: 0, h: 0, lh, n: 0 };
    const c = ctx || this.ctx;
    let w = 0;
    let measured = false;
    if (c && typeof c.measureText === 'function') {
      try {
        const font = cssFont(fs);
        lines.forEach((ln) => { w = Math.max(w, measureTextCached(c, ln, font)); });
        measured = true;
      } catch { /* 量不出宽 → 走下面的估算 */ }
    }
    if (!measured) {
      const most = lines.reduce((a, ln) => Math.max(a, Array.from(ln).length), 0);
      w = most * fs * 0.9;
    }
    return { w, h: lh * n, lh, n };
  }

  /**
   * 气泡体的屏幕矩形：水平方向以落点为中心，体底边悬在落点上方 `TAIL_H` 处
   * （尾巴从体底边中点竖直指向落点）。渲染 / 命中 / 剔除三处共用这一份算式。
   */
  private _body(shape: Shape, A: ScreenPoint, ctx?: CanvasRenderingContext2D | null): Body {
    const { w: tw } = this._block(shape, ctx);
    const lines = this.linesFor(shape);
    const lh = Math.round(this._fontSize(shape) * LINE_H);
    const th = lh * lines.length;
    return {
      x: A.x - (tw / 2 + PAD_X),
      y: A.y - TAIL_H - (th + 2 * PAD_Y),
      w: tw + 2 * PAD_X,
      h: th + 2 * PAD_Y,
    };
  }

  /** 剔除余量：气泡体在落点上方、两侧都可能伸出，取「半宽」与「全高 + 尾巴」的大者 */
  cullMargin(shape: Shape): number {
    const Pts = this.projectPts(shape);
    const A = Pts[0];
    if (!A) return 0;
    const b = this._body(shape, A);
    return Math.max(b.w / 2, b.h + TAIL_H) + 14;
  }

  describe(shape: Shape): string {
    const lines = this.linesFor(shape);
    if (!lines.length) return '气泡（空）';
    const first = lines.find((ln) => ln !== '') || '';
    return `气泡 “${first}”${lines.length > 1 ? `（共 ${lines.length} 行）` : ''}`;
  }

  /* ---------------- 命中 / 渲染 ---------------- */

  /**
   * 自定义「本体」命中：气泡 = 体矩形 + 尾巴三角，引擎默认那套只认存储顶点
   * （这里就 1 个尾巴尖）—— 不实现的话只有尾巴尖那一小块点得中。
   */
  hitTest(shape: Shape, x: number, y: number, Pts: ScreenPoint[], tol: number): boolean {
    const A = Pts[0];
    if (!A) return false;
    const b = this._body(shape, A);
    // 体矩形（含容差）
    if (x >= b.x - tol - HIT_PAD && x <= b.x + b.w + tol + HIT_PAD
      && y >= b.y - tol - HIT_PAD && y <= b.y + b.h + tol + HIT_PAD) return true;
    // 尾巴三角（三条边 + 内部；底边贴着体底边，已含在体矩形里）
    const base = A.y - TAIL_H;
    if (y <= A.y + tol && y >= base - tol - HIT_PAD) {
      // 在尾巴高度带里：到「中轴」的横向距离随 y 线性收窄（三角）
      const t = Math.min(Math.max((y - base) / TAIL_H, 0), 1);   // 0=底边 1=尖端
      const half = TAIL_HALF * (1 - t);
      if (Math.abs(x - A.x) <= half + tol) return true;
    }
    return false;
  }

  /**
   * 圆角矩形路径 —— 直接用引擎那条通用原语（`paint.roundRectPath`）。
   *
   * ★ 本类型原来是自己手画一份（fake-ctx 没有 `roundRect`，得用四段直线 + 四个弧拼）；
   *   富文本的**背景底色块**也需要同一件事，于是把它下沉成 `paint.ts` 的原语 ——
   *   各留一份的话，哪天「半径大于半高该怎么夹」变了，气泡与底色块的圆角就不一样了。
   */
  private _roundRectPath(ctx: CanvasRenderingContext2D, b: Body): void {
    roundRectPath(ctx, b.x, b.y, b.w, b.h, CORNER);
  }

  /**
   * 已提交的气泡：白底圆角体 + 底部尾巴 + 文字。
   *
   * 绘制顺序有讲究：**先描体框、再画尾巴** —— 尾巴的白填充正好盖掉体框底边上
   * 被尾巴跨着的那一段（参考图里尾巴与体框是连成一体的，中间不能有横线），
   * 最后补尾巴两条侧边的描边。
   */
  render(shape: Shape): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const st = this.styleFor(shape);
    const Pts = this.projectPts(shape);
    const A = Pts[0];
    if (!A) return;

    const b = this._body(shape, A, ctx);
    const lines = this.linesFor(shape);
    if (!lines.length) {
      this._markEmpty(ctx, shape, A);
      return;
    }

    // ★ 描边宽度 ≤ 0 = **不描边**（体框与尾巴侧边都省掉，只留白底 + 文字）——
    //   别写成 `pathWidth || 2`：那会把用户显式设的 0 又变回 2，描边永远关不掉
    const lw = st.pathWidth;
    const stroke = typeof lw === 'number' && lw > 0;
    // 1) 体：底色（polygonFill，类型默认白，面板「面内填充」可改）
    this._roundRectPath(ctx, b);
    ctx.fillStyle = st.polygonFill;
    ctx.fill();
    // 2) 体框（showLine 关掉 = 无边框的纯白气泡；pathWidth = 0 同样无边框）
    if (stroke && shape.cfg.showLine !== false) {
      ctx.globalAlpha = st.lineOpacity;
      ctx.lineWidth = lw;
      ctx.strokeStyle = st.pathColor;
      this._roundRectPath(ctx, b);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // 3) 尾巴：白填充（盖掉体框底边被跨着的那段）+ 两条侧边描边
    const base = A.y - TAIL_H;
    ctx.beginPath();
    ctx.moveTo(A.x - TAIL_HALF, base);
    ctx.lineTo(A.x + TAIL_HALF, base);
    ctx.lineTo(A.x, A.y);
    ctx.closePath();
    ctx.fillStyle = st.polygonFill;
    ctx.fill();
    if (stroke && shape.cfg.showLine !== false) {
      ctx.globalAlpha = st.lineOpacity;
      ctx.lineWidth = lw;
      ctx.strokeStyle = st.pathColor;
      ctx.beginPath();
      ctx.moveTo(A.x - TAIL_HALF, base);
      ctx.lineTo(A.x, A.y);
      ctx.lineTo(A.x + TAIL_HALF, base);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // 4) 文字：多行在体里上下匀开（行距同「文字标注」），恒水平、不旋转
    const fs = this._fontSize(shape);
    const lh = Math.round(fs * LINE_H);
    const cx = b.x + b.w / 2;
    const cy = b.y + PAD_Y;
    const opts = {
      size: fs,
      fill: st.textColor,
      halo: st.haloColor,
      width: st.haloWidth,          // 0 = 不描边（haloText 自己会整段跳过 strokeText）
    };
    for (let i = 0; i < lines.length; i++) {
      haloText(ctx, cx, cy + lh * (i + 0.5), lines[i], opts);
    }

    // 编辑态悬停反馈：绕着气泡体画一圈虚线（同「文字标注」）
    if (this.isHovered(shape)) {
      ctx.save();
      ctx.strokeStyle = this.hoverColor;
      ctx.lineWidth = 1.6;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(b.x - 3, b.y - 3, b.w + 6, b.h + 6);
      ctx.restore();                 // restore 一并复位 lineDash
    }
  }

  /** 空文字时的记号：一个虚线小圈（只在悬停 / 选中时，同「文字标注」） */
  private _markEmpty(ctx: CanvasRenderingContext2D, shape: Shape, A: ScreenPoint): void {
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

  /** 手绘预览：光标处一个候选圆点 + 十字（同「文字标注」，文字内容此刻拿不到） */
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

/* 自注册：import 本文件即把类型收进静态注册表 */
MapboxSketch.registerType(BubbleShape);
