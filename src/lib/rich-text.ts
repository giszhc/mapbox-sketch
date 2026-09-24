/* =====================================================================
 * rich-text.ts —— 「富文本标注」的内容解析器：一段带**行内样式标签**的文字
 * →「行 × 段」的纯数据（每段自己的字号 / 颜色 / 粗体 / 斜体 / 下划线）。
 *
 * ★ 纯函数、零依赖、不碰 DOM / canvas：量字与绘制在类型里（`shapes/rich-text.ts`），
 *   这里只回答「这段字分成了哪几段、每段什么样式」。分成两件事的理由和
 *   `export-image.ts` / `serialize.ts` 一样 —— 解析这一块能在 vitest 里被穷举，
 *   而「画出来正不正」得靠真画布。
 *
 * ── 语法（写在面板那个多行输入框里）────────────────────────────────────
 *   <b>加粗</b>   →  b / bold    加粗
 *   <i>斜体</i>   →  i / italic  斜体
 *   <u>下划线</u> →  u / underline 下划线
 *   <s=24>大字</> →  s / size    这一段自己的字号(px)
 *   <c=#e03131>红字</> → c / color 这一段自己的颜色（#hex / 颜色名 / rgb()）
 *   <bg=#fff3bf>高亮</> → bg / bgcolor 这一段自己的**高亮色带**（铺在字下面的一条圆角色带）
 *   <r=8>圆角</>   →  r / radius  色带的圆角半径(px)，只在有底色时起作用
 *
 *   · 一个标签里可以写多个：`<b s=20 c=#e03131>标题</>`；
 *   · 分隔符是**空格或逗号**（`<b,s=20>` 与 `<b s=20>` 等价）；
 *   · 闭标签统一写 `</>`（`</b>` 这种带名字的也认，一律闭最内层）；
 *   · 可以嵌套：`<b>粗 <c=#e03131>还红</> 收尾</>`；
 *   · `<bg=none>` 把色带**关到这儿为止**（嵌套时用，见下面「行内标签 vs 样式面板」）；
 *   · 标签**不跨行**：一行末尾没闭合的标签，效果只到这一行末为止
 *     （换行是用户的段落切分，不该被一个漏写的 `</>` 连累到下一行）；
 *   · ★ 认不出来的 `<…>` **原样当文字显示** —— 不吞字符、不报错。
 *     写错的标签会在图上看得见（这正是让人发现写错的方式），而不是静默丢一段字。
 *
 * ── 行内标签 vs 样式面板 ─────────────────────────────────────────────
 *   与 `s=` / `c=` 同一口径：**段自己写了就压过面板，没写才取面板** ——
 *   字号 / 字色取 `textSize` / `textColor`。**底色是唯一的例外**：
 *   `<bg=…>` 是**段级高亮**，而面板上的 `bgColor` 是**整条标注**的一整块背景
 *   （2026-09-20 用户口径：「富文本应该是整个标注的背景，而不是某个标签的」）——
 *   两者是两件事，所以段这一层没有「跟随面板」这个状态：要么自己写了个色，要么没有。
 *   面板那块整块背景见 `shapes/rich-text.ts` 的 `_plate()`。
 *
 * ── 为什么不用 HTML ──────────────────────────────────────────────────
 *   引擎是 canvas，没有 DOM 排版可用；而 `innerHTML` 那条路会把「数据文件」
 *   变成一段可执行的标记。自己定一小撮标签，好处是**每一段都还能原样进出 JSON**
 *   （它就是 `cfg.text` 这个字符串），存档格式一个字都不用改。
 * ===================================================================== */
import type { RichLine, RichSegment } from './types';

/**
 * 行距倍数 = 字号 × 它（与「引线标注」同一口径）。
 *
 * ★ 导出而不是各写一份：`shapes/text-block.ts`（文字标注 / 富文本标注共用的排版）
 *   算行高也是这个数，两处不一致的话「同一行内容，两个类型的行距不一样」。
 */
export const LINE_H = 1.35;

/**
 * 段级高亮色带**没写圆角**时用的那个半径(px)。
 *
 * ★ 出厂就给一点圆角（而不是 0）：色带的用途是「高亮」，方角在字下面显得硬；
 *   想要方角写 `<r=0>` 就行 —— 默认值只决定「没写的时候长什么样」。
 *   ★ 它只管**段**（`<r=…>` / 段级色带）；整条标注那块整块背景的圆角是样式键
 *   `bgRadius`（面板上那一行），出厂的默认值同样取这个数，两处不能各写一份。
 *   与 `LINE_H` 一样放在这里：两个数字都是「排版口径」。
 */
export const BG_RADIUS = 4;

/** 字号的可接受区间(px)：写歪了（0 / 负数 / 几千）当**这个 token 不成立**，整串标签退回字面文字 */
const MIN_SIZE = 4;
const MAX_SIZE = 400;

/** 圆角半径的可接受区间(px)：0（方角）到 64（足够圆，再大也会被夹到半高/半宽） */
const MIN_RADIUS = 0;
const MAX_RADIUS = 64;

/** 颜色值的可接受写法：#hex / 颜色名 / rgb()·rgba()。其余一律不认（写错就看得见） */
const HEX_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const NAME_RE = /^[a-z]{3,20}$/i;
const FUNC_RE = /^rgba?\([0-9.,%\s]+\)$/i;

/**
 * 一个标签 token → 它对样式的改动；`null` = 不认这个 token
 * （调用方据此把整个 `<…>` 当字面文字，见文件头那条）。
 */
interface TagAttrs {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  size?: number;
  color?: string;
  /**
   * 段级高亮色带：`undefined` = **这个标签没提这件事**（沿用栈里当前那层的值）；
   * `null` = `<bg=none>`，把色带关到这儿为止。
   *
   * ★ 这里的 `undefined` 只活在这一层（「提没提」），**不会**落进 `RichSegment` ——
   *   段里只有「有没有色」（见 `types.ts` 的 `RichSegment.bg`）。段级高亮与面板上那块
   *   整条标注的背景是两件事，不需要「跟随面板」这第三种状态。
   */
  bg?: string | null;
  radius?: number;
}

/** 认一个 `<…>` 里的一项（`b` / `s=24` / `c=#f00`…） */
function parseToken(raw: string): TagAttrs | null {
  const token = raw.trim().toLowerCase();
  if (!token) return null;
  if (token === 'b' || token === 'bold') return { bold: true };
  if (token === 'i' || token === 'italic') return { italic: true };
  if (token === 'u' || token === 'underline') return { underline: true };
  const eq = token.indexOf('=');
  if (eq < 0) return null;
  const name = token.slice(0, eq).trim();
  // ★ 值**不做 toLowerCase**：颜色值 `#E03131`、`Red` 是用户写的原文，
  //   大写十六进制在 canvas 里完全合法，转成小写只会让导出文件里的内容跟人写的不一样。
  const value = raw.slice(raw.indexOf('=') + 1).trim();
  if (name === 's' || name === 'size') {
    if (!/^\d+(?:\.\d+)?$/.test(value)) return null;
    const px = Number(value);
    if (!isFinite(px) || px < MIN_SIZE || px > MAX_SIZE) return null;
    return { size: px };
  }
  if (name === 'c' || name === 'color') {
    const v = value.toLowerCase();
    if (!HEX_RE.test(v) && !NAME_RE.test(v) && !FUNC_RE.test(v)) return null;
    return { color: value };
  }
  if (name === 'bg' || name === 'bgcolor') {
    const v = value.toLowerCase();
    // ★ `none` / `transparent` 要**先**判：这俩能过 NAME_RE（纯字母），落到下面就成了
    //   「一个颜色」。而 canvas 不认识 `none`，`fillStyle = 'none'` 会被**静默忽略**、
    //   沿用一个颜色 —— 画出来是一块莫名其妙的底色，比不画还糟。
    if (v === 'none' || v === 'transparent') return { bg: null };
    if (!HEX_RE.test(v) && !NAME_RE.test(v) && !FUNC_RE.test(v)) return null;
    return { bg: value };
  }
  if (name === 'r' || name === 'radius') {
    if (!/^\d+(?:\.\d+)?$/.test(value)) return null;
    const px = Number(value);
    if (!isFinite(px) || px < MIN_RADIUS || px > MAX_RADIUS) return null;
    return { radius: px };
  }
  return null;
}

/**
 * 把一个标签体切成若干项：分隔符是**空白或逗号**，但**括号里的逗号不算分隔符**
 * —— 颜色可以写成 `rgba(255,0,0,0.5)`，那两个逗号是色值的一部分，
 * 按普通分隔符切会把 `rgba(255` / `0` / `0` / `0.5)` 拆成四段，整串退化成字面文字。
 */
function splitAttrs(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = depth > 0 ? depth - 1 : 0;
    if (depth === 0 && (ch === ',' || ch === ' ' || ch === '\t')) {
      if (cur) out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * 认一个 `<…>` 的**整体**：返回它对样式的改动。
 * `null` = 不是标签（原样当文字），`'close'` = 闭标签（`</>` / `</b>`…）。
 *
 * 空标签 `<>` **不算标签**：它没有任何一项属性，收下它只会让 `<` `>` 这两个
 * 字符凭空消失（用户想打一对尖括号时就会撞上）。要「什么都不改」本来也没意义。
 */
function parseTag(inner: string): TagAttrs | 'close' | null {
  const body = inner.trim();
  if (body.startsWith('/')) return 'close';           // `</>` 与 `</b>` 一律闭最内层
  const merged: TagAttrs = {};
  let any = false;
  for (const piece of splitAttrs(body)) {
    const attrs = parseToken(piece);
    if (!attrs) return null;                          // 有一项不认 → 整串退回字面文字
    Object.assign(merged, attrs);
    any = true;
  }
  return any ? merged : null;
}

/** 一段文字的样式在栈里的累计形态（`size` / `color` 为空 = 跟随样式面板） */
interface Frame {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  size: number | null;
  color: string | null;
  /**
   * 段级高亮色带：`string` = 铺这条色带；`null` = 这一段不铺。
   *
   * ★ 与 `size` / `color` 的 `null` 含义**不同**：那两位是「跟随样式面板」，这里的是
   *   「不铺」—— 面板上的 `bgColor` 是**整条标注**的一整块背景，不是段的兜底色
   *   （见 `types.ts` 的 `RichSegment.bg`）。
   */
  bg: string | null;
  /** 色带的圆角半径(px)；`null` = 用出厂 `BG_RADIUS` */
  radius: number | null;
}

const BASE: Frame = {
  bold: false, italic: false, underline: false, size: null, color: null,
  bg: null, radius: null,
};

function seg(text: string, f: Frame): RichSegment {
  return {
    text,
    size: f.size,
    color: f.color,
    bold: f.bold,
    italic: f.italic,
    underline: f.underline,
    bg: f.bg,
    radius: f.radius,
  };
}

/**
 * 解析**一行**：扫标签、按栈累计样式、切出若干段。
 *
 * 相邻同款式的段会被合并（`abc<b><b>d` 这种写法不必在画的时候多走一趟），
 * 空文字段直接丢掉 —— 但 `text` 原样保留其余字符（含空格），量字与绘制都按原文来。
 */
function parseLine(src: string): RichSegment[] {
  const out: RichSegment[] = [];
  const stack: Frame[] = [BASE];
  let buf = '';
  const top = (): Frame => stack[stack.length - 1];
  const flush = () => {
    if (!buf) return;
    const f = top();
    const last = out[out.length - 1];
    // 与上一段样式完全一致 → 合并（同一次绘制的相邻两段没有分别的意义）
    if (last && last.size === f.size && last.color === f.color && last.bold === f.bold
      && last.italic === f.italic && last.underline === f.underline
      && last.bg === f.bg && last.radius === f.radius) {
      last.text += buf;
    } else {
      out.push(seg(buf, f));
    }
    buf = '';
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch !== '<') { buf += ch; continue; }
    const end = src.indexOf('>', i + 1);
    if (end < 0) { buf += ch; continue; }              // 这一行没有 `>`：后面全是普通文字
    const tag = parseTag(src.slice(i + 1, end));
    if (tag === null) { buf += ch; continue; }         // 不认的标签：`<` 原样留下（后面几字符照常走）
    flush();
    if (tag === 'close') {
      if (stack.length > 1) stack.pop();               // 多写的闭标签：忍着，不吃字
    } else {
      const p = top();
      stack.push({
        bold: tag.bold || p.bold,
        italic: tag.italic || p.italic,
        underline: tag.underline || p.underline,
        size: tag.size != null ? tag.size : p.size,
        color: tag.color != null ? tag.color : p.color,
        // ★ 这里比的是 `undefined`（而不是 `!= null`）：`<bg=none>` 给的是 `null`，
        //   它有「把色带关掉」这个意思，跟「这个标签没提」是两回事 ——
        //   否则 `<bg=#f00>甲<bg=none>乙</>` 里的 `bg=none` 会被当成「没提」，
        //   高亮一路铺到行尾。
        bg: tag.bg === undefined ? p.bg : tag.bg,
        radius: tag.radius != null ? tag.radius : p.radius,
      });
    }
    i = end;
  }
  flush();
  return out;
}

/**
 * 解析整段内容：`\n` 切行，每行再切段。
 *
 * `\r` 顺手去掉（Windows 粘贴进来的是 `\r\n`，留着会让「行末多一个看不见的字符」）；
 * 中间的空行**保留**（那是用户刻意留的段间距），整段一个可见字符都没有时返回空数组
 * （＝ 没有内容，与 `shapes/text.ts` 的判空口径一致）。
 *
 * @param src `cfg.text` 的原文；非字符串一律当「没有内容」
 */
export function parseRichText(src: unknown): RichLine[] {
  if (src == null || src === '') return [];
  const lines = String(src)
    .split('\n')
    .map((ln) => (ln.endsWith('\r') ? ln.slice(0, -1) : ln))
    .map(parseLine);
  return lines.some((segs) => segs.some((s) => s.text !== ''))
    ? lines.map((segs) => ({ segs }))
    : [];
}

/** 一行的纯文字（去掉全部标签）：`describe()` 与「空不空」的判断用它 */
export function plainOfLine(line: RichLine): string {
  return line.segs.map((s) => s.text).join('');
}
