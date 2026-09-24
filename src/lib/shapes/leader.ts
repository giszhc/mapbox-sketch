/* =====================================================================
 * shapes/leader.ts —— 内置类型：LeaderShape「引线标注」。
 *
 * 「引线标注」＝ 锚点 + 两段式引线 + 水平文字（AutoCAD / PPT 那种引线）。
 *   · 单击地图一下即生成一个锚点（autoCommit = true：达到最少点数自动完成）。
 *   · 引线第一段（从锚点出发的「直段」）方向由 cfg.angle 连续控制（0°~360°），
 *     长度由 cfg.len 控制（px）；到达「折点 F」后折向水平，水平段通向文字。
 *   · 文字始终【水平正放】，绝不随角度旋转 / 翻转；第二段是水平段，因此
 *     0° / 180° / 360° 时两段共线，看起来就是「一条横线 + 线上的文字」。
 *   · 角度约定 =「顺时针」扫角：dir = (cosθ, +sinθ)（屏幕 y 向下），故数值越大
 *     引线越顺时针转 —— 0°=向右、90°=向下、180°=向左、270°=向上。
 *   · 水平段是一条「文字下划线」，长度随文字自动伸缩（文字宽 + 两端各 5px 出头）；
 *     下划线折向哪一侧由折点 x 分量自动决定（cosθ ≥ 0 → 朝右），所有中间角度
 *     都用三角函数连续计算，不做四方向离散。
 *
 * 本类同时是「引线坐标标注」的基类（见 leader-coord.ts），几何 / 命中 / 拖动
 * 全部可继承，子类通常只需覆写 linesFor() 与 cfgKeys()。
 * ===================================================================== */
import { cssFont, distToSeg } from '../math';
import { drawDot, lineDashFor, measureTextCached, strokePolyline } from '../paint';
import { MapboxSketch } from '../sketch';
import { MapboxShapeType } from '../sketch-shape-type';
import type { CfgKey, CfgPatch, DrawSession, LngLat, ScreenPoint, Shape } from '../types';

/** _layout 需要的最小形状信息（真 Shape、或 preview 里的临时几何都满足） */
interface LeaderGeom {
  cfg?: CfgPatch | null;
  pts: LngLat[];
}

/** 引线的三个关键点：锚点 A → 折点 F → 水平段末端 E */
export interface LeaderLayout {
  /** 锚点 */
  A: ScreenPoint;
  /** 折点（第一段终点） */
  F: ScreenPoint;
  /** 水平段（文字下划线）末端 */
  E: ScreenPoint;
  /** 1 = 水平段朝右 / -1 = 朝左 */
  east: 1 | -1;
}

export class LeaderShape extends MapboxShapeType {
  get key(): string { return 'leader'; }
  get label(): string { return '引线标注'; }
  get minPts(): number { return 1; }
  get autoCommit(): boolean { return true; }   // 单击一次即完成，无需双击 / 回车（同「点」）

  cfgKeys(): CfgKey[] { return ['text', 'angle', 'len']; }

  get hint(): string {
    return '➤ 绘制<b>引线标注</b>：在地图上单击一下即定下锚点，<b>无需双击/回车</b><br />'
      + '・画好后在左侧面板输入<b>文字</b>、调<b>角度°</b>(0~360 连续)与<b>引线长度</b><br />'
      + '・角度顺时针：0°=右 90°=下 180°=左 270°=上；文字始终水平正向<br />'
      + '・拖动锚点圆点可整体移动引线；悬停引线会变红提示可拖';
  }

  /**
   * 该类型专属默认配置（push 新图形时叠加在全局默认之上）。
   *
   * 新画出的引线默认文字为「引线标注」，不复用全局的路径文字默认（「路径文字」）。
   * 注意 text 是「每张新引线自己的默认」，
   * 不等于共享的全局 text 默认 —— draw 时逐条叠进 cfg，所以不会污染路径文字的
   * 全局默认（面板里改文字用 `config({ text }, { defaults: false })`，只改聚焦那张）。
   *
   * angle / len 的默认留在主类 DEFAULT_CFG（330 / 60），跟随全局默认即可，
   * 好让「面板先调好角度 / 长度、再画下一个引线」的预设置能生效。
   */
  defaultCfg(): CfgPatch {
    return { text: '引线标注' };
  }

  /** 引线内容画在锚点之外，剔除时按「第一段长度 + 水平段长」放宽 */
  cullMargin(shape: Shape): number {
    const len = shape.cfg.len != null ? shape.cfg.len : 60;
    return len + this._hSpan(shape) + 8;
  }

  describe(shape: Shape): string {
    return `引线 ${shape.cfg.angle}° · ${shape.cfg.text || '（无文字）'}`;
  }

  /**
   * 由锚点 + cfg 算出引线的屏幕折点：
   *   A = 锚点 → F = 折点（第一段按 angle 走 len px）→ E = 水平段末端。
   * 水平段是「文字下划线」，长度由调用方按文字宽度给 span（= 文字宽 + 两头出头）；
   * 没给 span 时退化成一小截 14px（空文字 / 预览时的短尾巴示意折角）。
   */
  protected _layout(shape: LeaderGeom, span?: number): LeaderLayout {
    const cfg = shape.cfg || {};
    const angle = cfg.angle != null ? cfg.angle : 90;
    const rad = ((angle % 360) * Math.PI) / 180;
    const len = cfg.len != null ? cfg.len : 60;
    const A = this.project(shape.pts[0]);
    // 屏幕 y 向下、顺时针扫角：dir = (cosθ, +sinθ) → 90°=向下、270°=向上
    const F = { x: A.x + Math.cos(rad) * len, y: A.y + Math.sin(rad) * len };
    // 折点 x 分量符号决定水平段折向：cosθ ≥ 0 折向右（文字在右），否则折向左
    const east: 1 | -1 = Math.cos(rad) >= 0 ? 1 : -1;
    // 水平段末端：从折点向「外侧」伸 span px（默认短尾巴 14）
    const spanH = span == null ? 14 : span;
    const E = { x: F.x + east * spanH, y: F.y };
    return { A, F, E, east };
  }

  /**
   * 本类型要画出的【文字行】。render 与 _hSpan 都以它为准，保证下划线长度、
   * 命中范围与真正画出来的字一致。默认取 cfg.text（非空 → 单行）。
   * 「引线坐标标注」子类覆写它：返回按锚点经纬度算出的两行度分秒。
   * @returns 空数组 = 不画字（下划线退化成 14px 短尾巴）
   */
  linesFor(shape: Shape): string[] {
    const t = ((shape.cfg || {}).text || '').trim();
    return t ? [t] : [];
  }

  /**
   * 水平段（下划线）应有的总长：最长那行文字宽 + 两端各 5px 出头；
   * 无文字 / 量不出宽时给 14px。需用 2d ctx.measureText 量字，因此 render 与
   * hitTest 都先把 ctx 备好再算，保证画出的下划线和鼠标命中范围是同一套几何。
   *
   * ★ 量字走 `measureTextCached`：本函数**每帧每个引线至少被调三次**
   *   （`_visible` 的 cullMargin、`_pickAt` 的预筛、render），量的是同一串字。
   *   上千个引线时这里就是每帧数千次排版调用，而文字只在用户改它时才变。
   */
  protected _hSpan(shape: Shape, ctx?: CanvasRenderingContext2D | null): number {
    const lines = this.linesFor(shape);
    if (!lines.length) return 14;
    const c = ctx || this.ctx;
    if (c && typeof c.measureText === 'function') {
      try {
        const st = this.styleFor(shape);
        const font = cssFont(st.textSize || 15);
        let w = 0;
        lines.forEach((ln) => { w = Math.max(w, measureTextCached(c, ln, font)); });
        return w + 10;
      } catch { /* 个别环境量不出宽 → 退回短尾巴 */ }
    }
    return 14;
  }

  /**
   * 自定义「本体」命中：本类型只存 1 个锚点，却渲染出 A→F→E 两段线。
   * 引擎默认的「线距」判定只认存储顶点，1 个点时算不出距离 → 整条引线永远点不中。
   * 因此这里直接测「光标离两段线的距离 ≤ 容差」，并允许点锚点本身也算命中，
   * 使整条引线可悬停变红、拖主体（锚点）整体平移。
   */
  hitTest(shape: Shape, x: number, y: number): boolean {
    // 下划线长度与渲染一致地随文字伸缩（无字 14px 短尾巴）；坐标都是屏幕 CSS 像素
    const { A, F, E } = this._layout(shape, this._hSpan(shape));
    const st = this.styleFor(shape);
    const w = st.pathWidth || 3;
    const tol = Math.max(w / 2 + 5, 10);       // 与引擎线体容差一致
    // 锚点给一圈比线体更宽的容差：它是这条引线唯一可拖的「本体」，
    // 又只有 1 个像素级的落点，只按线距判定的话得非常准地压在那条线上才点得中
    const ar = Math.max(w + 6, 12);
    if (Math.hypot(x - A.x, y - A.y) <= ar) return true;
    return distToSeg(x, y, A.x, A.y, F.x, F.y) <= tol
      || distToSeg(x, y, F.x, F.y, E.x, E.y) <= tol;
  }

  /** 已提交的引线标注：两段引线 + 骑在下划线上的水平文字（可多行） */
  render(shape: Shape): void {
    const ctx = this.ctx;
    const st = this.styleFor(shape);     // 悬停时 pathColor 会自动变红
    if (!ctx) return;
    const lines = this.linesFor(shape);  // 实际要画的文字行（子类可覆写）

    // 水平段长度跟随最长那行文字：有字 → 文字宽 + 两头出头；空字 → 一小截示意折角
    const { A, F, E, east } = this._layout(shape, this._hSpan(shape, ctx));

    // 1) 两段引线：A→F（按角度 / 长度走），F→E 是「文字下划线」。
    //    0° / 180° 时 A、F、E 共线 → 自然是一条直线
    strokePolyline(ctx, [A, F, E], st.pathColor, st.pathWidth, lineDashFor(st.lineType, st.pathWidth), st.lineOpacity);

    // ★ 锚点圆点 2026-09 去掉了（见 AGENTS.md「顶点记号」）：引线的锚点就是那条线的
    //   起点，线自己已经把它说清楚了；悬停反馈仍然在（`styleFor` 会把 pathColor 染红）。
    //   `drawDot` 的 import 别顺手删 —— 下面的预览还在用。

    // 2) 水平文字：骑在 F→E 那段下划线之上、紧贴折点内侧起排，永远水平正读；
    //    多行文字以「最下一行贴下划线」为基准向上逐行堆叠（行距 ≈ 字号 × 1.35）
    if (!lines.length) return;
    ctx.save();
    const fs = st.textSize != null ? st.textSize : 15;
    ctx.font = cssFont(fs);
    ctx.textAlign = east > 0 ? 'left' : 'right';
    ctx.textBaseline = 'alphabetic';     // 基线略抬高，让横线像文字下方的一根下划线
    // ★ 本类型没走 paint 的字绘制原语（多行 + 左/右对齐 + 下划线基线都是它自己的口径），
    //   描边得自己来 —— 包括「0 = 不描边」这条：canvas 忽略非正数的 lineWidth、
    //   会沿用上一次设的值，所以不能塞个 0 进去，要整段跳过 strokeText
    const haloW = st.haloWidth != null ? st.haloWidth : 3;
    const halo = haloW > 0;
    if (halo) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = haloW;
      ctx.strokeStyle = st.haloColor || 'rgba(255,255,255,0.95)';
    }
    const tx = F.x + east * 5;           // 文字内侧与折点留 5px；下划线两端各出头 5px
    const lh = Math.round(fs * 1.35);    // 多行行距
    const topY = E.y - 2 - lh * (lines.length - 1);  // 最下一行基线 = E.y - 2，上面逐行抬高
    ctx.fillStyle = st.textColor;        // 2026-09-11 起与其他文字统一（默认蓝），可按图形覆盖
    lines.forEach((ln, i) => {
      const ty = topY + i * lh;
      if (halo) ctx.strokeText(ln, tx, ty);
      ctx.fillText(ln, tx, ty);
    });
    ctx.restore();
  }

  /** 手绘预览：光标处画一个半透明的候选锚点 + 一小截默认引线示意 */
  preview(draw: DrawSession): void {
    const ctx = this.ctx, st = this.style;
    if (!draw.cursor || !ctx || !st) return;
    const A = this.project(draw.cursor);
    ctx.save();
    ctx.globalAlpha = 0.5;
    const ghost = this._layout({ cfg: { angle: 330, len: 40 }, pts: [draw.cursor] });
    strokePolyline(ctx, [ghost.A, ghost.F, ghost.E], st.previewColor, st.pathWidth, [3, 3]);
    drawDot(ctx, A.x, A.y, 5, st.previewColor);
    ctx.restore();
  }
}

/* 自注册（引线坐标标注继承自本类，须在本文件之后加载） */
MapboxSketch.registerType(LeaderShape);
