/* =====================================================================
 * paint.ts —— canvas 绘图原语（纯函数，无 DOM、无状态）。
 *
 * 从改造前的 mapbox-draw-paint.js（IIFE 全局脚本）平移而来。
 * 所有函数只依赖传入的 ctx，配合主类
 * `ctx.setTransform(dpr,0,0,dpr,0,0)` 之后的 **CSS 像素坐标系**。
 * 以命名空间形式从包出口导出（`paint.strokePolyline`），自定义类型可复用。
 * ===================================================================== */
import { buildArc, cssFont } from './math';
import type { LineType, ScreenPoint, TickPos } from './types';

/** 「白描边文字」的绘制参数 */
export interface TextPaintOpts {
  /** 字号(px) */
  size: number;
  /** 字色 */
  fill: string;
  /** 描边色（通常为半透明白） */
  halo: string;
  /**
   * 描边宽度(px)，默认 3。**0 = 不描边**：整段跳过 `strokeText`。
   *
   * ★ 不能靠 `ctx.lineWidth = 0` 来实现「不描边」：canvas 会**忽略非正数**、
   *   沿用上一次设进去的值（上一次可能是某条 30px 的粗线），字会被糊成一团白。
   */
  width?: number;
}

/** 密集刻度的绘制参数 */
export interface TicksOpts {
  /** 刻度间隔(px)，默认 18 */
  gap?: number;
  /** 相对线条的位置，默认 'top' */
  pos?: TickPos;
  /** 「被贴的那条线」的线宽(px)，用于算线的边缘，默认 5 */
  lineWidth?: number;
  /** 刻度伸出长度(px)，默认 6 */
  tickLen?: number;
  /** 刻度颜色，默认 '#333333' */
  color?: string;
  /** 刻度线宽，默认 1.2 */
  width?: number;
  /** 整组刻度的不透明度 */
  alpha?: number;
}

/** 屏幕「上侧」法线方向（指向屏幕上方的那一侧） */
export function upNormal(ang: number): ScreenPoint {
  return { x: Math.sin(ang), y: -Math.cos(ang) };
}

/** 与上侧相反的下侧法线方向 */
export function dnNormal(ang: number): ScreenPoint {
  return { x: -Math.sin(ang), y: Math.cos(ang) };
}

/** 描边折线（圆头圆角；可选虚线/透明度） */
export function strokePolyline(
  ctx: CanvasRenderingContext2D,
  arr: ScreenPoint[],
  color: string,
  width: number,
  dash?: number[] | null,
  alpha?: number | null,
): void {
  if (!arr || arr.length < 2) return;
  ctx.save();
  if (alpha != null) ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (dash) ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(arr[0].x, arr[0].y);
  for (let i = 1; i < arr.length; i++) ctx.lineTo(arr[i].x, arr[i].y);
  ctx.stroke();
  ctx.restore();
}

/**
 * 根据线型与线宽返回 dash 数组；`solid` 返回 `null`（不用 `setLineDash`，等同实线）。
 *
 * ★ 间距一律按线宽 `w` 缩放：细线（w 小）缩成短促的点划、粗线（w 大）放大成舒展的条块，
 * 视觉密度保持一致——否则细线上虚线糊成一团、粗线上虚线空成断点。基础比例取自
 * canvas 虚线的常见手感（dash ≈ 3w、gap ≈ 2w）。
 * - dashed：经典「- - -」长虚线
 * - dotted：等距点（用 0 长 dash + 圆头线帽画成圆点，gap 略大于线宽避免粘连）
 * - dashDot：一段实线 + 一个点「- · - ·」
 */
export function lineDashFor(type: LineType, width: number): number[] | null {
  const w = Math.max(1, width);
  switch (type) {
    case 'solid': return null;
    case 'dashed': return [3 * w, 2 * w];                 // 虚线：预测 / 预报
    case 'dotted': return [0, 2 * w];                     // 点线：估计 / 不确定
    case 'dashDot': return [3 * w, 2 * w, 0, 2 * w];      // 点划线：计划 / 规划
    case 'dashDotDot': return [3 * w, 2 * w, 0, 2 * w, 0, 2 * w]; // 双点划线：远期预测 / 工程假想轮廓
    case 'longDash': return [7 * w, 3 * w];               // 长虚线：边界 / 施工线 / 规划路径
    case 'shortDash': return [2 * w, 2 * w];              // 短虚线：断裂线 / 细虚线 / 辅助估计
  }
}

/** 填充一个闭合面（自动 closePath） */
export function fillRing(
  ctx: CanvasRenderingContext2D,
  pts: ScreenPoint[],
  color: string,
): void {
  if (!pts || pts.length < 3) return;
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * 圆角矩形**路径**（不填不描，调用方自己 `fill()` / `stroke()`）。
 *
 * ★ 自己拼路径而不是用 `ctx.roundRect()`：那个方法在旧 Safari / 旧 Firefox 上没有，
 *   而且 jsdom 的假 canvas 也没实现 —— 用它的话「测试里画不出来」和「真机上画不出来」
 *   是同一个症状（静默），排查不到根上。四段直线 + 四个圆弧走的是最老的那几个原语。
 *
 * `r` 会被夹到 `[0, min(w, h) / 2]`：半径比盒子还大时浏览器会画出诡异的形状，
 * 而「夹一下」正是用户想要的（写 `<r=99>` 就是想尽量圆）。`r ≤ 0` 走直角分支，
 * 连圆弧都不发 —— 免得测试里 `arc` 计数虚增。
 */
export function roundRectPath(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r = 0,
): void {
  if (!(w > 0) || !(h > 0)) { ctx.beginPath(); return; }
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  if (!(rr > 0)) {
    ctx.moveTo(x, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
    ctx.closePath();
    return;
  }
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arc(x + w - rr, y + rr, rr, -Math.PI / 2, 0);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arc(x + w - rr, y + h - rr, rr, 0, Math.PI / 2);
  ctx.lineTo(x + rr, y + h);
  ctx.arc(x + rr, y + h - rr, rr, Math.PI / 2, Math.PI);
  ctx.lineTo(x, y + rr);
  ctx.arc(x + rr, y + rr, rr, Math.PI, Math.PI * 1.5);
  ctx.closePath();
}

/**
 * 引擎**通用的顶点手柄**：一个「白芯 + 橙圈」的小圆点（`active` = 光标正压着它，
 * 翻成橙芯并放大一圈）。位置请从类型的 `handles()` 取 —— 那正是命中检测用的点列。
 *
 * ★ 抽成这里的一个原语，是因为「不走通用白点、改画图标的类型」（图片标注、文字标注）
 *   仍然要给**其余手柄**画这个点：自己再画一份的话，哪天圈色 / 半径变了，
 *   同一张图上的手柄就会长得不一样（引擎画的是一套、类型画的是另一套）。
 */
export function handleDot(
  ctx: CanvasRenderingContext2D, x: number, y: number, active: boolean,
): void {
  ctx.save();
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, active ? 8 : 6, 0, Math.PI * 2);
  ctx.fillStyle = active ? HANDLE_RING : '#ffffff';
  ctx.fill();
  ctx.strokeStyle = HANDLE_RING;
  ctx.stroke();
  ctx.restore();
}

/** 手柄的圈色（引擎通用白点与几支图标共用同一个橙） */
const HANDLE_RING = '#e67e22';

/** 画一个白描边的实心小圆点（顶点/落点标记用） */
export function drawDot(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, r: number, color: string,
): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
}

/* ================================================================
 * 手柄图标：「转圈箭头」与「双向箭头」
 *
 * 引擎默认的顶点手柄是一个「白芯 + 橙圈」的小圆点，它说得清「这儿有个手柄」，
 * 却**说不出这个手柄是干什么的** —— 用户 2026-09-14 提的正是这件事：鼠标挪到
 * 控制点上，光看指针根本猜不出拖下去是转还是改大小。
 *
 * 用 CSS 光标补这个信息补不齐：Safari / Firefox 根本不画 SVG 光标，只落到
 * 兜底的标准箭头（`cursors.ts` 里写清了这条路的天花板）。所以图片标注改成把
 * 手柄**画成图标** —— 转到柄上是转圈箭头、拖两个角是双向箭头，看图就知道拖哪个。
 * 光标那条路照旧留着（支持 SVG 光标的浏览器上两处一起给出同一个暗示）。
 *
 * 图形与 `cursors.ts` 里那两支光标是**同一个样子**（同一套比例、同一个「白芯 +
 * 黑边」画法）：光标那支画在 24×24 的框里、由浏览器缩放，这里画在半径 `BADGE_R`
 * 的圆牌上，两边的数字各自手算 —— 形状对上就行，尺寸量纲不同，强行共用一份反而绕。
 *
 * ★ **悬停态**（`active`）：光标压在哪一支手柄上，哪一支就换成「橙底 + 白笔画」并
 *   放大一圈。这是用户 2026-09-14 提的第二件事 —— 手柄画成图标之后「看得出来是干什么的」
 *   了，但鼠标挪上去**一点反应都没有**，反而不好确认「我是不是真的压在它上面」。
 *   引擎把「此刻压着第几个顶点」透给类型（`drawHandles(shape, hoverVi)`），
 *   这里只负责把那一支画成激活态。
 *   颜色沿用引擎通用手柄的悬停口径（橙），三支手柄共享同一套「激活 = 变橙」的读法。
 * ================================================================ */

/** 圆牌的半径(px)：白底 + 橙圈，与引擎通用手柄（白芯 + 橙圈）同一套配色 */
const BADGE_R = 9;

/** 悬停时圆牌的半径(px)：比常态大一圈，「压着的是这一支」才一眼可见 */
const BADGE_R_HOVER = 11;

/** 圆牌的圈色：与引擎通用手柄的圈同色（`sketch.ts` 的 `_drawHandles`） */
const RING = '#e67e22';

/** 图标的笔画色：圆牌是白底，深色笔画在上面最清楚 */
const INK = '#333333';

/** 悬停时图标的笔画色：圆牌翻成橙底，笔画得反过来用白色 */
const INK_HOVER = '#ffffff';

/** 双向箭头：杆的半长(px) */
const ARROW_SHAFT = 4;

/** 双向箭头：箭尖离中心的距离(px)。比 ARROW_SHAFT 大出来的那段就是箭头本身 */
const ARROW_TIP = 6.8;

/** 双向箭头：箭头底边的半宽(px) */
const ARROW_HEAD = 2;

/** 转圈箭头：弧的半径(px) */
const ARC_R = 5;

/** 转圈箭头：缺口的半角(度)。缺口留在正**下**方（中心 +90°），所以弧走 360 − 2×它 */
const ARC_GAP = 30;

/**
 * 手柄图标的底盘：实心圆 + 橙色描边（三支手柄共用，所以三支看着是一套东西）。
 *
 * @param active 光标是否正压在这一支上：是则翻成「橙底 + 白笔画」并放大一圈。
 *               底盘的尺寸随之变化，**笔画颜色由调用方跟着换**（见 INK / INK_HOVER）。
 */
function badge(ctx: CanvasRenderingContext2D, x: number, y: number, active: boolean): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, active ? BADGE_R_HOVER : BADGE_R, 0, Math.PI * 2);
  ctx.fillStyle = active ? RING : '#ffffff';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = RING;
  ctx.stroke();
  ctx.restore();
}

/**
 * 「改大小」手柄的图标：一支沿 `rad` 方向的双向箭头，画在 (x,y) 处的圆牌上。
 *
 * @param rad 箭头指向（屏幕角度，`Math.atan2(dy, dx)` 那种：0 = 正右、顺时针为正）。
 *            正负无所谓 —— 双向箭头是轴对称的。图片标注传的是它那条对角线，
 *            于是箭头指的正是拖起来会走的那条线（斜着的图配一支歪箭头才不误导）。
 * @param active 光标是否正压在这一支上（见 badge）
 */
export function scaleHandleIcon(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, rad: number, active: boolean,
): void {
  badge(ctx, x, y, active);
  const c = Math.cos(rad), s = Math.sin(rad);
  const ink = active ? INK_HOVER : INK;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  // 杆（圆牌已经是白的，就不用像光标那样再描一圈白边了）
  ctx.beginPath();
  ctx.moveTo(x - ARROW_SHAFT * c, y - ARROW_SHAFT * s);
  ctx.lineTo(x + ARROW_SHAFT * c, y + ARROW_SHAFT * s);
  ctx.lineWidth = 1.6;
  ctx.stroke();
  for (const dir of [-1, 1]) {
    const bx = x + dir * ARROW_SHAFT * c, by = y + dir * ARROW_SHAFT * s;   // 箭头底边中点 = 杆的端点
    const tx = x + dir * ARROW_TIP * c, ty = y + dir * ARROW_TIP * s;       // 箭尖
    // 底边两角：从底边中点沿**法线**各偏 ARROW_HEAD（法线 = 轴向转 90°，与 dir 无关）
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(bx - ARROW_HEAD * s, by + ARROW_HEAD * c);
    ctx.lineTo(bx + ARROW_HEAD * s, by - ARROW_HEAD * c);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/**
 * 「旋转」手柄的图标：一段带缺口的圆弧 + 弧端的箭头（顺时针），画在 (x,y) 处的圆牌上。
 *
 * ★ 缺口留在正**下**方（用户 2026-09-14 报的「图标反了」）：原先缺口朝上、箭头落在
 *   右上角，看着跟「往下转」是一回事 —— 圆牌是在图片**上方**的手柄，缺口朝上时，
 *   整支图标读起来是「从图片这头往下压」。缺口翻到下方之后，弧与箭头都落在柄的下半侧，
 *   对着它所绕的那个中心，才像是「绕着图片转」。
 *   翻法就是整支图标绕圆心转 180°：缺口中心 −90° → +90°，箭头随之到左下角，
 *   转向仍是顺时针（转 180° 不改左右手）。`cursors.ts` 那支转圈光标同步翻了同一角度 ——
 *   两处必须是一个样子，否则悬停时指针和图标各指一个方向。
 *
 * @param active 光标是否正压在这一支上（见 badge）
 */
export function rotateHandleIcon(
  ctx: CanvasRenderingContext2D, x: number, y: number, active: boolean,
): void {
  badge(ctx, x, y, active);
  // 弧：从缺口的上沿（正下方再偏 ARC_GAP）顺时针走 360−2×ARC_GAP 度到另一沿。
  // canvas 的 y 轴向下，所以「角度增大 = 屏幕上顺时针」，与直觉一致，不必取反
  const from = (90 + ARC_GAP) * (Math.PI / 180);
  const to = (90 + 360 - ARC_GAP) * (Math.PI / 180);
  const ink = active ? INK_HOVER : INK;
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, ARC_R, from, to);
  ctx.lineWidth = 1.8;
  ctx.lineCap = 'round';
  ctx.strokeStyle = ink;
  ctx.stroke();

  // 箭头贴在弧的**起点**上、朝顺时针切线方向 —— 与光标那支同一个画法，
  // 免得悬停时指针和图标各指一个方向
  const px = x + ARC_R * Math.cos(from), py = y + ARC_R * Math.sin(from);
  const tx = -Math.sin(from), ty = Math.cos(from);          // 顺时针切线
  const nx = -ty, ny = tx;                                  // 它的法线（箭头底边的方向）
  ctx.beginPath();
  ctx.moveTo(px + tx * 3.4, py + ty * 3.4);                 // 箭尖
  ctx.lineTo(px - tx * 0.6 + nx * 1.9, py - ty * 0.6 + ny * 1.9);
  ctx.lineTo(px - tx * 0.6 - nx * 1.9, py - ty * 0.6 - ny * 1.9);
  ctx.closePath();
  ctx.fillStyle = ink;
  ctx.fill();
  ctx.restore();
}

/**
 * 量一串文字的宽度，按「字体 + 文字」缓存；同一串字只真的量一次。
 *
 * ★ 这不是「顺手优化」：`measureText` 是走排版引擎的**同步**调用，比一次 `hypot`
 *   贵几个数量级，而各类型每帧要量的翻来覆去就是同样那几串字 —— 引线标注量
 *   「文字该有多宽」来定下划线长度，路径文字量每个字的宽来定字距。上千个标注时
 *   这里每帧就是上千次排版调用。
 *
 * `ctx.font` 由本函数自己在未命中时设好再还原 —— **命中路径上完全不碰 ctx**，
 * 调用方也就不必记住「量之前要先设 font」这条隐含契约（漏了会量出上个字号的值，
 * 而且不报错）。
 *
 * ★ 缓存**必须有上限**：「坐标引线标注」的文字是锚点经纬度，拖动时每帧都在变，
 *   每个新值都是一个新键 —— 不设上限就是一条缓慢的内存泄漏。满了直接清空重来，
 *   重建的代价不过是那几串字再量一遍。
 */
const textWidthCache = new Map<string, number>();

/** 字宽缓存的条目上限（见上：坐标类文字会持续产生新键） */
const TEXT_WIDTH_CACHE_MAX = 512;

export function measureTextCached(
  ctx: CanvasRenderingContext2D,
  text: string,
  font: string,
): number {
  // 键 = 字体串长度 + 字体串 + 文字。**长度前缀不能省**：拿某个分隔符拼
  // 「字体 + 文字」，只要它本身可能出现在字体串里，两组不同的输入就能拼出同一个键
  // （文字是用户内容，什么都可能有）。长度前缀让拼接点永远无歧义。
  const key = font.length + ':' + font + text;
  const hit = textWidthCache.get(key);
  if (hit !== undefined) return hit;
  ctx.save();
  try {
    ctx.font = font;
    const w = ctx.measureText(text).width;
    if (textWidthCache.size >= TEXT_WIDTH_CACHE_MAX) textWidthCache.clear();
    textWidthCache.set(key, w);
    return w;
  } finally {
    ctx.restore();          // 量字抛错也不能把 ctx 的 save 栈漏掉
  }
}

/** 水平（不旋转）绘制「白描边文字」，用于边长/面积等无需贴线旋转的标注 */
export function haloText(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, text: string, o: TextPaintOpts,
): void {
  ctx.save();
  ctx.font = cssFont(o.size || 12);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const w = o.width != null ? o.width : 3;
  if (w > 0) {                       // 0 = 不描边：见 TextPaintOpts.width 的说明
    ctx.lineWidth = w;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = o.halo;
    ctx.strokeText(text, x, y);
  }
  ctx.fillStyle = o.fill;
  ctx.fillText(text, x, y);
  ctx.restore();
}

/** 在某点沿角度旋转地绘制「白描边文字」（贴线文字 / 途经点标注用） */
export function rotText(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, ang: number, text: string, o: TextPaintOpts,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  ctx.font = cssFont(o.size || 12);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const w = o.width != null ? o.width : 3;
  if (w > 0) {                       // 0 = 不描边：见 TextPaintOpts.width 的说明
    ctx.lineWidth = w;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = o.halo;
    ctx.strokeText(text, 0, 0);
  }
  ctx.fillStyle = o.fill;
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

/** 逐字绘制：沿该点切线旋转 + 白描边（沿线平均分布文字用） */
export function paintChar(
  ctx: CanvasRenderingContext2D,
  ch: string, p: { x: number; y: number; ang: number }, o: TextPaintOpts,
): void {
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.ang);
  ctx.font = cssFont(o.size);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const w = o.width != null ? o.width : 3;
  if (w > 0) {                       // 0 = 不描边：见 TextPaintOpts.width 的说明
    ctx.lineWidth = w;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = o.halo;
    ctx.strokeText(ch, 0, 0);
  }
  ctx.fillStyle = o.fill;
  ctx.fillText(ch, 0, 0);
  ctx.restore();
}

/** 逐字绘制里的一「字」：画在哪（屏幕坐标）＋ 沿哪条切线旋转（弧度） */
export interface CharRunItem {
  /** 单个字符（可能是代理对，如 emoji / 生僻字，调用方用 Array.from 拆） */
  ch: string;
  x: number;
  y: number;
  /** 该字处折线的切线角（弧度） */
  ang: number;
}

/**
 * 逐字绘制**一整串**字：每个字沿各自切线旋转 + 白描边。
 *
 * 画出来的东西和逐字调 `paintChar` 完全一样，区别只在**重复的状态设置**：
 * 整串字的字号 / 线宽 / 描边色 / 填充色都相同，所以这些设一次就够，
 * 循环里只剩每个字自己的 translate + rotate。路径文字一帧要画几百上千个字，
 * 省下的就是 per-char 的 7 次 canvas 属性写入。
 *
 * `paintChar` 保留不动 —— 画单个字、或每个字参数都不同时，直接用它更清楚。
 */
export function paintCharRun(
  ctx: CanvasRenderingContext2D,
  run: CharRunItem[],
  o: TextPaintOpts,
): void {
  if (!run.length) return;
  ctx.save();
  // —— 以下这些整串共用，设在循环外；内层 save/restore 会原样带回它们 ——
  ctx.font = cssFont(o.size);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // 「描不描边」是个**整串级别**的开关（见 TextPaintOpts.width），所以判断也提到循环外：
  // 循环里只多一次 boolean 比较，不新增任何 canvas 属性写入（这里是每帧上千字的热路径）
  const w = o.width != null ? o.width : 3;
  const halo = w > 0;
  if (halo) {
    ctx.lineWidth = w;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = o.halo;
  }
  ctx.fillStyle = o.fill;
  for (let i = 0; i < run.length; i++) {
    const c = run[i];
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.ang);
    if (halo) ctx.strokeText(c.ch, 0, 0);    // 先描白边（宽度 0 就整段不描）
    ctx.fillText(c.ch, 0, 0);                // 再填字色
    ctx.restore();
  }
  ctx.restore();
}

/**
 * 沿一条折线画【密集等距刻度】：每隔 gap(像素) 在弧上取一点，
 * 画一根垂直于该点切线的小短线，无数值、像刻度尺。
 * @param pts 投影后的屏幕点列；沿闭合环画请把首点重复在末尾传入
 */
export function denseTicks(
  ctx: CanvasRenderingContext2D,
  pts: ScreenPoint[],
  o: TicksOpts = {},
): void {
  if (!pts || pts.length < 2) return;
  const arc = buildArc(pts);                     // 弧长参数化（用其 at(s) 定位）
  if (!arc || arc.total <= 0) return;
  const gap = o.gap || 18;                       // 刻度间隔(px)，密集
  const pos = o.pos || 'top';                    // 相对线条的位置
  const hw = (o.lineWidth != null ? o.lineWidth : 5) / 2; // 线宽的一半：线的边缘
  const len = o.tickLen != null ? o.tickLen : 6; // 刻度伸出长度(px)
  ctx.save();
  ctx.strokeStyle = o.color || '#333333';
  ctx.lineWidth = o.width || 1.2;
  ctx.lineCap = 'round';
  if (o.alpha != null) ctx.globalAlpha = o.alpha;
  ctx.beginPath();
  for (let s = 0; s <= arc.total; s += gap) {
    const p = arc.at(s);
    const ux = Math.sin(p.ang), uy = -Math.cos(p.ang);   // 屏幕「上侧」法线
    let x0: number, y0: number, x1: number, y1: number;
    if (pos === 'middle') {
      // 横穿线条：从一侧边缘到另一侧边缘各再伸 len
      x0 = p.x - ux * (hw + len); y0 = p.y - uy * (hw + len);
      x1 = p.x + ux * (hw + len); y1 = p.y + uy * (hw + len);
    } else if (pos === 'bottom') {
      // 贴线条下侧边缘、向下向外伸，不进入线内
      x0 = p.x - ux * hw; y0 = p.y - uy * hw;
      x1 = p.x - ux * (hw + len); y1 = p.y - uy * (hw + len);
    } else { // 'top'（默认）：贴线条上侧边缘、向上向外伸，不进入线内
      x0 = p.x + ux * hw; y0 = p.y + uy * hw;
      x1 = p.x + ux * (hw + len); y1 = p.y + uy * (hw + len);
    }
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
  }
  ctx.stroke();
  ctx.restore();
}
