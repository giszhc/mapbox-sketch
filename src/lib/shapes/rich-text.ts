/* =====================================================================
 * shapes/rich-text.ts —— 内置类型：RichTextShape「富文本标注」。
 *
 * ★★ 本类型是**新画**的（用户 2026-09-18 要求新增），标绘库里没有对应物。
 *
 * ── 与「文字标注」的关系 ────────────────────────────────────────────
 * 交互一模一样（单击即成、文字以落点为中心、可多行、可绕锚点旋转、旋转柄 / 命中 /
 * 面板几何全在父类 `TextBlockShape` 里），差别只有一条：
 * **一行里可以有好几段，每段自己的字号 / 颜色 / 粗体 / 斜体 / 下划线 / 高亮色带**
 * —— 于是「大标题 + 小注」能写在同一块标注里，而不用叠两条图形。
 *
 * 语法（写在面板那个多行输入框里，规则与实现都在 `src/lib/rich-text.ts`）：
 *   `<b>` 加粗、`<i>` 斜体、`<u>` 下划线、`<s=24>` 字号、`<c=#e03131>` 颜色、
 *   `<bg=#fff3bf>` 高亮色带、`<r=8>` 色带圆角（`<bg=none>` 关掉色带），
 *   闭标签统一 `</>`，可以嵌套、可以一项里写多个（`<b s=20 c=#e03131>`）。
 *   认不出来的 `<…>` **原样当文字**（写错了在图上看得见，而不是静默丢字）。
 *
 * ── 为什么内容还是一个字符串 ────────────────────────────────────────
 * `cfg.text` 存的就是用户敲进去的那串带标签的文字，解析发生在**每帧的排版**
 * （`layout()` → `linesOf()`）。好处有三条：
 *   1) 存档 / 导入导出零改动 —— 它就是普通文本，`serialize.ts` 一个字都不用碰；
 *   2) 面板上的 textarea 直接编辑原文，所见即所得（改错了当场看得出来）；
 *   3) 解析是纯函数（`src/lib/rich-text.ts`），能在 vitest 里穷举，不必起画布。
 * 代价是每帧都要解析一次 —— 与「量字」同一量级、且有 `measureTextCached` 那样的
 * 热路径缓存兜着（同一串字每帧解析出来的结果完全一样），不值得为它另存一份结构。
 *
 * ── 各段怎么摆 ──────────────────────────────────────────────────────
 * 一行里的各段沿「文字向右」依次推进（段宽由 `layout()` 量好存下来），
 * 全行以**行心**为基线上下居中（`textBaseline = 'middle'`）——
 * 于是 28px 的标题段与 15px 的正文段在同一行里是**中线对齐**的，而不是底边对齐。
 * 行距按该行**最大**字号算（见父类 `layout()`）；下划线按段自己的字号画在字下方。
 * 白描边（`haloWidth`）分两趟走：先把整行所有段描一遍、再整行填色 ——
 * 逐段「描完再填」的话，后一段的白边会啃掉前一段最后一笔的边。
 * 底色（`<bg=…>`）在**所有字之前**铺：它在字下面，所以整行先铺一遍底色、再描边填字
 * （见 `_backgrounds`：相邻同底色段合成一条，纵向用整行高好让上下行接上）；
 * 面板上的 `bgColor` 则更靠前，是**整条标注的一整块背景**（见 `_plate`）——
 * 「整个标注垫一块底板」与「一段文字高亮一条」是两件事，前者管整块、后者管某几个字。
 * ===================================================================== */
import { roundRectPath } from '../paint';
import { parseRichText, plainOfLine, BG_RADIUS } from '../rich-text';
import { MapboxSketch } from '../sketch';
import { TextBlockShape } from './text-block';
import type { BlockLayout, LineLayout } from './text-block';
import type { CfgKey, CfgPatch, RichSegment, Shape, Style } from '../types';

/** 下划线离行心的距离 = 字号 × 它（`textBaseline = 'middle'`，0.44 落在字脚附近） */
const UNDERLINE_Y = 0.44;

/** 下划线粗细 = 字号 × 它（下限 1px，免得 8px 的字画出一条看不见的线） */
const UNDERLINE_W = 0.07;

/**
 * 背景 / 色带在文字四周多留的空白(px)。
 *
 * ★ 与 `padOf()` 是**同一个数**：画出去多宽，命中 / 剔除 / 悬停框就要按多宽算
 *   —— 两处各写一个数，迟早出现「底色最外那两像素点不中」。
 *   段级色带只在左右外扩（纵向用整行高，上下行要接得上）；整块背景四周都外扩。
 */
const BG_PAD = 3;

export class RichTextShape extends TextBlockShape {
  get key(): string { return 'richText'; }
  get label(): string { return '富文本标注'; }

  cfgKeys(): CfgKey[] { return ['text']; }

  get hint(): string {
    return '🅁 绘制<b>富文本标注</b>：单击一下即落一个文字块，<b>无需双击/回车</b>'
      + '（与「文字标注」同一套交互）<br />'
      + '・<b>一行里可以有几段不同样式</b>：<code>&lt;b&gt;</code>加粗、'
      + '<code>&lt;i&gt;</code>斜体、<code>&lt;u&gt;</code>下划线、'
      + '<code>&lt;s=24&gt;</code>字号、<code>&lt;c=#e03131&gt;</code>颜色、'
      + '<code>&lt;bg=#fff3bf&gt;</code>局部高亮条、<code>&lt;r=8&gt;</code>高亮条圆角'
      + '（<code>&lt;bg=none&gt;</code>关掉高亮条），'
      + '闭标签统一写 <code>&lt;/&gt;</code>（可嵌套、可写在一起：'
      + '<code>&lt;b s=20 c=#e03131&gt;</code>）<br />'
      + '・例：<code>&lt;b s=22&gt;标题&lt;/&gt; &lt;bg=#fff3bf&gt;高亮&lt;/&gt;小字</code>'
      + '　・内容在上面的输入框里改，<b>回车换行 ＝ 多行</b><br />'
      + '・<b>整条标注的背景</b>（一整块）在右侧样式面板的「背景底色」里设，'
      + '与上面那个只管几个字的 <code>&lt;bg=…&gt;</code> 是两回事<br />'
      + '・拖文字本体＝平移；拖上方的<b>圆柄</b>＝绕中心旋转（<b>Shift</b> 每 15° 吸附一档）';
  }

  /**
   * 该类型专属默认配置：出厂内容就是一段**能看出富文本长什么样**的示例
   * （一行 20px 加粗的标题 + 一行「带底色高亮 + 彩色」的说明），而不是一串光秃秃的标签。
   *
   * 与「文字标注」同一口径：面板里改文字走 `config({ text }, { defaults: false })`
   * —— 只改聚焦的这一条，不把文案写进被各类型共享的全局默认。
   */
  defaultCfg(): CfgPatch {
    return {
      text: '<b s=20>富文本标注</>\n<bg=#fff3bf>每段</><c=#e03131>都能</>单独设样式',
    };
  }

  /** 本类型要画的【行 × 段】：`cfg.text` 的富文本解析结果（见 rich-text.ts） */
  protected linesOf(shape: Shape): RichSegment[][] {
    return parseRichText((shape.cfg || {}).text).map((ln) => ln.segs);
  }

  /**
   * 文字块四周要多留多少才算「点得中 / 要剔除 / 画悬停框」。
   *
   * 两条来源，取**宽**的那个：
   *   · 整块背景（样式面板的 `bgColor`）→ 四周各外扩 `BG_PAD`（`_plate` 画的就是这么大）；
   *   · 段级高亮色带（`<bg=…>`）→ 只在**左右**外扩（纵向用整行高，上下行要接得上）。
   *
   * ★ 判据要跟 `_plate` / `_backgrounds` **逐字一致**：面板设了整块背景时，
   *   最外那几像素是画出来了的，只按文字量宽的话就是「看得见却点不中」。
   */
  protected padOf(shape: Shape): { x: number; y: number } {
    if (this.styleFor(shape).bgColor) return { x: BG_PAD, y: BG_PAD };
    const has = this.linesOf(shape).some((segs) => segs.some((s) => s.text && s.bg));
    return has ? { x: BG_PAD, y: 0 } : { x: 0, y: 0 };
  }

  describe(shape: Shape): string {
    const lines = parseRichText((shape.cfg || {}).text);
    if (!lines.length) return '富文本（空）';
    const first = lines.map(plainOfLine).find((t) => t !== '') || '';
    return `富文本 “${first}”${lines.length > 1 ? `（共 ${lines.length} 行）` : ''}`;
  }

  /**
   * 已提交的富文本：绕锚点旋转的多行、**逐段上样式**的白描边文字。
   *
   * 一行的绘制顺序（每一条都不能省）：
   *   0) **整条标注的背景**（样式面板的 `bgColor`，一整块，见 `_plate`）；
   *   1) 该行里各段的**高亮色带**（`<bg=…>`）：两块都在字下面，先铺底再写字；
   *   2) 整行先描白边：段与段之间不能互相啃边，所以描边是**整行一遍**再填色；
   *   3) 整行填色：每段用自己的颜色（没写就取样式面板的 `textColor`）；
   *   4) 该行里带下划线的段各画一条线（canvas 没有文字装饰，只能画）。
   *
   * 空内容与「文字标注」同口径：不画字，只在悬停 / 选中时给一个虚线小圈
   * （那条图形什么都画不出来就成了「看不见却点得中」）。
   */
  render(shape: Shape): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const st = this.styleFor(shape);
    const A = this.projectPts(shape)[0];
    if (!A) return;

    const block = this.layout(shape, ctx);
    if (!block.lines.length) {
      this.markEmpty(ctx, shape, A);
      return;
    }

    const a = this.rotRad(shape);
    const offs = this.lineOffsets(block);
    // 描边宽度 ≤ 0 = 不描边（整段跳过 strokeText，而不是塞一个 0 进去 —— 见 paint.ts）
    const halo = typeof st.haloWidth === 'number' && st.haloWidth > 0;

    ctx.save();
    ctx.translate(A.x, A.y);
    ctx.rotate(a);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    this._plate(ctx, block, st);                   // 0) 整条标注的背景（最底下）
    for (let i = 0; i < block.lines.length; i++) {
      const ln = block.lines[i];
      if (!ln.w) continue;                       // 空行：只为占一行高度，没有可画的
      ctx.save();
      ctx.translate(0, offs[i]);
      this._backgrounds(ctx, ln);                // 1) 段级高亮色带（在字下面）
      if (halo) {
        ctx.lineWidth = st.haloWidth;
        ctx.strokeStyle = st.haloColor;
        let x = -ln.w / 2;
        for (const s of ln.segs) {
          if (s.seg.text) {
            ctx.font = this.fontOf(s.seg, s.size);
            ctx.strokeText(s.seg.text, x, 0);
          }
          x += s.w;
        }
      }
      let x = -ln.w / 2;
      for (const s of ln.segs) {
        if (s.seg.text) {
          ctx.font = this.fontOf(s.seg, s.size);
          ctx.fillStyle = s.seg.color || st.textColor;
          ctx.fillText(s.seg.text, x, 0);
        }
        x += s.w;
      }
      this._underlines(ctx, ln, st.textColor);
      ctx.restore();
    }
    ctx.restore();

    // 编辑态悬停反馈：绕着文字块画一圈虚线（提示「这块可拖」，同「文字标注」）
    if (this.isHovered(shape)) {
      const pad = this.padOf(shape);
      this.hoverBox(ctx, A, block.w + pad.x * 2, block.h + pad.y * 2, a);
    }
  }

  /**
   * **整条标注的背景**：一整块圆角矩形，铺在全部字（和全部色带）下面。
   *
   * ★ 2026-09-20 用户口径：「富文本应该是整个标注的背景，而不是某个标签的」——
   *   这一块由**样式面板的 `bgColor`** 决定（出厂**纯白**，与文字一起托在底图上；
   *   `''` = 不垫底，那是面板上「清空」之后的状态），与段级 `<bg=…>` 高亮色带是两件事：
   *   那是「某几个字高亮」，这是「整条标注垫一块底板」。
   *   两块都在字下面，所以顺序是「整块背景 → 段级色带 → 描边 → 填字」。
   *
   * ★ 尺寸取**整块的排版结果**（`block.w` = 最宽那一行、`block.h` = 全部行高之和），
   *   于是多行各自长短不一时底板仍是一个齐整的矩形 —— 这正是「背景」该有的样子
   *   （每行各铺一条、宽度参差不齐，那是色带的活）。
   *   四周各外扩 `BG_PAD`，与 `padOf()` 用同一个数（画多大就点多大）。
   *
   * 坐标是**块心局部坐标**（调用方已 translate 到锚点并转好角度，块心就在原点），
   * 所以这块底板跟着标注一起旋转 —— 与文字同进同退。
   */
  private _plate(ctx: CanvasRenderingContext2D, block: BlockLayout, st: Style): void {
    if (!st.bgColor) return;                     // 空串 = 不垫底（面板「清空」之后的状态）
    ctx.fillStyle = st.bgColor;
    roundRectPath(
      ctx,
      -block.w / 2 - BG_PAD,
      -block.h / 2 - BG_PAD,
      block.w + BG_PAD * 2,
      block.h + BG_PAD * 2,
      st.bgRadius,
    );
    ctx.fill();
  }

  /**
   * 该行的**段级高亮色带**：给该行每一个「写了 `<bg=…>`」的段在字下面铺一条圆角色带。
   *
   * ★ 判据就是 `s.seg.bg` —— 段级高亮与样式面板无关（面板上的 `bgColor` 是整条标注的
   *   一整块背景，见 `_plate`）。`<bg=none>` 与「没写标签」在这里都是「不铺」。
   *
   * 两条口径：
   *   · **相邻的同底色同圆角段合成一条**：`<bg=#fff3bf>一整行</>` 该是一条干净的
   *     圆角条，而不是被段边界切成几块、每块各自带圆角（中间还会露出缝）；
   *   · 纵向用**整行高**（不内缩）：上下两行的色带于是正好接上，多行高亮看着是一整块，
   *     而不是一条条中间带缝的横纹。
   *
   * 坐标是**行内局部坐标**（调用方已经 translate 到行心），与 `_underlines` 同一套。
   */
  private _backgrounds(ctx: CanvasRenderingContext2D, ln: LineLayout): void {
    let x = -ln.w / 2;
    let i = 0;
    while (i < ln.segs.length) {
      const s = ln.segs[i];
      const bg = s.seg.bg;
      // 没有色带、或这一段没有可见的字（空段没有可铺的地方）→ 往后挪一段
      if (!bg || !(s.w > 0)) { x += s.w; i++; continue; }
      const r = s.seg.radius != null ? s.seg.radius : BG_RADIUS;
      let runW = s.w;
      let j = i + 1;
      while (j < ln.segs.length) {
        const t = ln.segs[j];
        if (!(t.w > 0) || t.seg.bg !== bg) break;
        // 圆角不同就**不合并**：用户特意写了两个半径，就该看到两条不同的圆角
        if ((t.seg.radius != null ? t.seg.radius : BG_RADIUS) !== r) break;
        runW += t.w;
        j++;
      }
      ctx.fillStyle = bg;
      roundRectPath(ctx, x - BG_PAD, -ln.h / 2, runW + BG_PAD * 2, ln.h, r);
      ctx.fill();
      x += runW;
      i = j;
    }
  }

  /** 该行里带下划线的段：按段自己量出来的宽画一条线（颜色跟随该段的字色） */
  private _underlines(ctx: CanvasRenderingContext2D, ln: LineLayout, fallbackColor: string): void {
    let x = -ln.w / 2;
    for (const s of ln.segs) {
      if (s.seg.underline && s.seg.text && s.w > 0) {
        const y = s.size * UNDERLINE_Y;
        ctx.strokeStyle = s.seg.color || fallbackColor;
        ctx.lineWidth = Math.max(1, s.size * UNDERLINE_W);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + s.w, y);
        ctx.stroke();
      }
      x += s.w;
    }
  }
}

/* 自注册：import 本文件即把类型收进静态注册表（见 registry.ts） */
MapboxSketch.registerType(RichTextShape);
