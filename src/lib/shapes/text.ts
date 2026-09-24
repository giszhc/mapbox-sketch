/* =====================================================================
 * shapes/text.ts —— 内置类型：TextShape「文字标注」。
 *
 * 用户口径（2026-09-15 定）：**单击地图一下即落一个文字块，文字以该点为中心**
 * （同「点」的落点手感 —— 单击即完成，无需双击 / 回车）。文字可多行（回车换行），
 * 并可绕锚点旋转（拖手柄 或 面板里敲角度）。
 * ★ 2026-09-18 更名为「文字标注」（原名「文本标注」），并新增了「富文本标注」
 *   （`shapes/rich-text.ts`）—— 两个类型共用父类 `TextBlockShape`（锚点 / 旋转柄 /
 *   命中 / 几何全在那边），本文件只剩「这个类型的文字长什么样」。
 *
 * ── 存的是什么 ──────────────────────────────────────────────────────
 * 只存 **1 个顶点 = 文字块的中心**（锚点），与「点」「引线标注」同一口径：
 * `minPts = 1` + `autoCommit = true`（见父类）。多行、字宽都不进顶点 —— 它们要么来自
 * `cfg.text`（写什么），要么由字号现算（长什么样）。
 *
 * ── 文字怎么摆 ──────────────────────────────────────────────────────
 * 每一行是**一整段**、没有自己的样式：字号 / 颜色 / 描边走样式面板那套
 * （`textColor` / `textSize` / `haloColor` / `haloWidth`），所以这里只把 `cfg.text`
 * 按 `\n` 切行，剩下的交给父类的 `layout()` 与 `paint.rotText`。
 * 多行以锚点为整块的中心上下匀开（行距 = 字号 × 1.35，与引线标注同一口径）。
 *
 * 要「一行里几种字号 / 颜色」就用**富文本标注** —— 那是另一个类型，不是这个。
 * ===================================================================== */
import { rotText } from '../paint';
import { MapboxSketch } from '../sketch';
import { plainSeg, TextBlockShape } from './text-block';
import type { CfgKey, CfgPatch, RichSegment, Shape } from '../types';

export class TextShape extends TextBlockShape {
  get key(): string { return 'text'; }
  get label(): string { return '文字标注'; }

  cfgKeys(): CfgKey[] { return ['text']; }

  get hint(): string {
    return '🅣 绘制<b>文字标注</b>：在地图上单击一下即落一个文字块，<b>无需双击/回车</b><br />'
      + '・文字以该点为中心；内容在右侧面板里改，<b>支持多行</b>（回车换行）<br />'
      + '・拖文字本体＝平移；拖上方的<b>圆柄</b>＝绕中心旋转（按住 <b>Shift</b> 每 15° 吸附一档）<br />'
      + '・右侧「几何参数 → 旋转角度」与拖圆柄是同一件事，0°=正放、顺时针为正'
      + '<br />・要<b>一行里几种字号 / 颜色</b>请用「富文本标注」（另一个类型）';
  }

  /**
   * 该类型专属默认配置：新画的文字默认写「文字标注」，
   * 不复用全局默认文字（那是「路径文字」的占位串，见 leader.ts 同一处口径）。
   *
   * 面板里改文字走 `config({ text }, { defaults: false })` —— 只改聚焦的这一条，
   * 不把文案写进被各类型共享的全局默认。
   */
  defaultCfg(): CfgPatch {
    return { text: '文字标注' };
  }

  /**
   * 本类型要画的【文字行】：`cfg.text` 按 `\n` 切分，每行一整段（样式全走面板）。
   *
   * `\r` 顺手去掉：Windows 上粘贴进来的多行文本带的是 `\r\n`，
   * 留着 `\r` 量出来的宽会多出一截、看着像「右边莫名空了一块」。
   * 中间的**空行要留着**（那是用户刻意留的段间距），但整段全是空行时算「没有内容」。
   */
  protected linesOf(shape: Shape): RichSegment[][] {
    const raw = (shape.cfg || {}).text;
    if (raw == null || raw === '') return [];
    const lines = String(raw).split('\n').map((ln) => (ln.endsWith('\r') ? ln.slice(0, -1) : ln));
    return lines.some((ln) => ln !== '') ? lines.map((ln) => [plainSeg(ln)]) : [];
  }

  describe(shape: Shape): string {
    const lines = this.linesOf(shape);
    if (!lines.length) return '文字（空）';
    const first = lines.find((ln) => ln[0].text !== '')?.[0].text || '';
    return `文字 “${first}”${lines.length > 1 ? `（共 ${lines.length} 行）` : ''}`;
  }

  /**
   * 已提交的文字标注：绕锚点旋转的多行白描边文字。
   *
   * ★ 静态时**只画字**，不画框、不画手柄（与引线标注同一口径：常量装饰只会糊图面）。
   *   空文字是个例外 —— 那条图形什么都画不出来就成了「看不见却点得中」，
   *   所以给它一个虚线小圈，且**只在悬停 / 选中时**画（出图时这两个都是 false，
   *   成品里不会留下这个记号）。
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
    // 「文字向下」方向：向上是 (sinθ, -cosθ)，取反即可（多行就是沿它匀开的）
    const down = { x: -Math.sin(a), y: Math.cos(a) };
    for (let i = 0; i < block.lines.length; i++) {
      const ln = block.lines[i];
      const seg = ln.segs[0];
      if (!seg) continue;
      const opts = {
        size: seg.size,
        fill: st.textColor,
        halo: st.haloColor,
        width: st.haloWidth,          // 0 = 不描边（rotText 自己会整段跳过 strokeText）
      };
      // 第 i 行在自己的中心处画：文字块整体以锚点为中心
      rotText(ctx, A.x + down.x * offs[i], A.y + down.y * offs[i], a, seg.seg.text, opts);
    }

    // 编辑态悬停反馈：绕着文字块画一圈虚线（提示「这块可拖」）
    if (this.isHovered(shape)) this.hoverBox(ctx, A, block.w, block.h, a);
  }
}

/* 自注册：import 本文件即把类型收进静态注册表（见 registry.ts） */
MapboxSketch.registerType(TextShape);
