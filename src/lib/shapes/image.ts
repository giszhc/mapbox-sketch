/* =====================================================================
 * shapes/image.ts —— 内置类型：ImageShape「图片标注」。
 *
 * 用户口径（2026-09-14 定）：**单击地图 → 弹系统文件框 → 选完直接贴上去**；
 * 点击图片可以改大小、平移、旋转。图片本体以 **data URL** 存在图形自己身上，
 * 所以导出 JSON 自带图片、离线内网都能用 —— 代价是文件会变大，宿主该在选图时
 * 降采样（demo 就是这么做的）。
 *
 * ★ 图片本体放的是 `Shape.data` 而**不是** `cfg`：`cfg` 的每个键都会被
 *   `config()` 写进全局默认供新图形继承，图片混进去就会「画一个新图，落出来的
 *   是上一张」。理由与 `Shape.hidden` 完全相同，见 types.ts 里那段注释。
 *
 * ── 几何：存 3 个点，[角0, 角1, 旋转柄] ────────────────────────────────
 * 三个点都是**正常顶点**（其中两个是**真正的图角**，见下），屏幕几何每帧现算：
 *
 *     M  = 两个角的屏幕中点                    ← 图片中心，也是旋转中心
 *     n  = normalize(旋转柄 − M)               ← 图片的「上」方向
 *     u  = perp(n)                             ← 图片的「右」方向
 *     D  = (wn/2)·u + (hn/2)·n                 ← 等比半对角向量（wn/hn = 自然像素尺寸）
 *     k  = |角1 − M| / |D|                     ← 一个自然像素 = 几个屏幕像素
 *     四角 = M ± (k·wn/2)·u ± (k·hn/2)·n
 *
 * 恒等式：只要两个角写的是**真正的角**，`|角1 − M|` 恰好是 `k·|D|`，于是 `k` 复原得
 * 分毫不差、画出来的四角正好包含这两个存储点，手柄不会飘。改大小（`_resize`）与旋转
 * （`_rotate`）都按这条口径重写两个角 —— 缺一不可，见 `_rotate` 里那段说明。
 *
 * ★ `u` 的符号**不**由「哪个点在前」决定：u 取反时画出来的四角是**同一组点**，
 *   但 `k` 是从两个角的偏移长度推的 —— 拿点序去翻 u，`D` 的方向跟着翻，
 *   而偏移没翻，算出来的尺寸就整个错掉（`u` 只由旋转柄定，与两点的顺序无关，
 *   所以「先写右上还是先写左下」画出来一模一样）。
 *
 * ★ 柄虽然「拖到哪都行」，但**落图与改大小时都按同一个摆法写它**：新中心正上方
 *   `h/2 + KNOB_GAP` 处（见 `place` / `_resize`）。它不是几何的一部分，只是为了让
 *   「拖一次角」不会顺手把图转歪（中心是两个角的中点，拖一个角就会动它）。
 *
 * ── 三个操作的落点 ──────────────────────────────────────────────────
 *   拖角   → `dragTo`：把光标投到**等比对角线**上（引擎默认的「顶点跟光标」会把
 *            图拉变形，而用户选的口径是**锁定等比**）
 *   拖图片 → 引擎默认的「主体整体平移」，一行都不用写
 *   拖旋转柄 → 柄**只提供方向**，拖到哪都行；按住 Shift 每 15° 吸附一档
 *            （Shift 由 `dragTo` 的上下文带进来；引擎自己的吸附只看 Alt）
 *
 * ── 手柄：四个角 + 一个旋转柄 ────────────────────────────────────────
 * 引擎的手柄默认「一个存储顶点一支」，而这里要**四个角都有缩放柄**（用户 2026-09-14
 * 的口径），存储点却只有两个 —— 于是走引擎的 `handles()` 钩子多报两支：
 * 下标 0/1/2 与 `pts` 一一对应（两个角 + 柄），**3/4 是派生手柄**（另外两个角，
 * 位置由 `_halfDiag` 现算，在 `pts` 里没有对应项）。引擎不会替派生手柄写顶点，
 * 所以拖它们由 `_resize` 自己把**两个**存储角一起重写。
 * 「存两组对角」是做不到的：过定（朝向 / 长宽比 / 尺寸被多余自由度顶着），
 * 而且与上面那条 `k` 的恒等式打架 —— 详见 `_halfDiag` 上面那段。
 *
 * 手柄的**光标**也在这里表态（`vertexCursor`）：柄＝转圈箭头、四个角＝双向箭头
 * （还要跟着各自那条对角线的朝向转）。理由见 `cursors.ts` 的文件头 ——
 * CSS 里没有「旋转」这个光标。
 * 光有光标还不够（Safari / Firefox 不画 SVG 光标，而且指针本身说不清含义），所以
 * 五个手柄**还画成图标**（`drawHandles` + `paint.ts` 里那两支）：同一个方向角
 * （`_diagAng`）喂给两处，光标和图标不许各指一个方向。鼠标压着的那一支还要翻成
 * 激活态（`drawHandles` 的 `hoverVi`）—— 挪上去毫无反应的话，根本不知道压没压上。
 *
 * 面板上那两行「旋转角度 / 尺寸」（`readGeom` / `writeGeom`）调的也是这三个顶点：
 * 几何只有一处真相，拖出来的和面板上敲出来的必须一模一样，所以两边共用 `_verts()`。
 *
 * ── 渲染 ────────────────────────────────────────────────────────────
 * 图片解码与渲染**分开**：`render()` 是同步的，解码还没完就先画占位框，框的尺寸与
 * 朝向跟真图**完全一致**（尺寸取自 `data` 里的自然像素，不依赖解码），图一到就位、
 * 框不会跳。解码完成时回调 `requestRender()` 补一帧。
 * `exportImage()` 会先 `await whenReady()` 把这些图等齐，所以成品里不会留占位框。
 *
 * 那圈边框**只在选中 / 悬停时画**（没有图可看的占位形态是例外，见 `render` 里的说明）：
 * 图片是一整块内容，静态时套一圈线只是底图上的噪点 —— 它真正的身份是「选中标记」。
 * 于是出图（`_capturing`）时自然也没有它：没有边框、没有手柄，就是贴上去的那张图。
 *
 * 边框宽与不透明度这两项走**类型专属默认样式**（`defaultStyle()`：2px / 0.85），
 * 不去动全局那套 3px 实色 —— 那是线、面、引线共用的，按图片的口味改会把整张地图的
 * 线一起改细改淡（理由写在 `defaultStyle()` 上面那段）。
 * ===================================================================== */
import { rotateCursor, scaleCursor } from '../cursors';
import { fromPlane, toPlane, toPlaneOne } from '../ground-frame';
import { fmtM, gdM } from '../math';
import {
  drawDot, fillRing, haloText, rotateHandleIcon, scaleHandleIcon, strokePolyline,
} from '../paint';
import { MapboxSketch } from '../sketch';
import { MapboxShapeType } from '../sketch-shape-type';
import type { GroundFrame } from '../ground-frame';
import type {
  CfgKey, DragContext, DrawSession, GeomPatch, GeomState, LngLat, PlaceContext,
  PlaceResult, ScreenPoint, Shape, StylePatch,
} from '../types';

/** 落地尺寸上限(px)：长边最长就这么长（比画布短边 1/3 还大的图才缩，小图保持原始像素 1:1） */
const MAX_SIDE = 200;

/** 旋转柄离图片上边的距离(px) */
const KNOB_GAP = 30;

/** 按住 Shift 时旋转吸附的网格(度) */
const SNAP_DEG = 15;

/** 退化阈值(px)：任一边小于它就不画 —— 那是一条线或一个点，没有图片的形状 */
const DEGENERATE = 0.5;

/** 拖角缩放的屏幕下限(px)：夹住最小尺寸，免得拖塌了再也抓不着 */
const MIN_SIDE = 8;

/** 手绘预览里那个示意方框的边长(px)：落地尺寸要等选完图才知道，所以只给个记号 */
const PREVIEW_BOX = 48;

/* ================================================================
 * 图片解码缓存（模块级：同一张图在多个图形 / 多个引擎之间只解一次）
 *
 * ★ 两张表都**带上限**：data URL 一存就是一整张图的体积，只进不出会一直涨
 *   （同 paint.ts 的 measureTextCached 口径）。超了丢最旧的，需要时再解一次。
 * ================================================================ */

/** 最多缓存几张解码好的图 */
const DECODE_LIMIT = 32;

/** data URL → 解码好的位图（LRU：命中就挪到队尾，屏幕上常画的那张不会被挤掉） */
const decoded = new Map<string, CanvasImageSource>();

/** 解不了的（坏 data URL / 不是图片）：记着它，免得每帧都新建一个 Image 再失败一次 */
const failed = new Set<string>();

/**
 * 正在解码：data URL → 解完（或确定解不了）要通知的人。
 * 里面既有引擎的重绘回调，也有 `whenDecoded()` 的 resolve。
 */
const waiting = new Map<string, Set<() => void>>();

type Decode =
  | { kind: 'ok'; img: CanvasImageSource }
  | { kind: 'loading' }
  | { kind: 'failed' };

/** 两张表谁超了上限就丢最旧的一条（Map / Set 都按插入顺序迭代） */
function evictOldest(): void {
  if (decoded.size > DECODE_LIMIT) {
    const oldest = decoded.keys().next().value;
    if (oldest != null) decoded.delete(oldest);
  }
  if (failed.size > DECODE_LIMIT) {
    const oldest = failed.values().next().value;
    if (oldest != null) failed.delete(oldest);
  }
}

/** 解码有了结果：记进表里，然后把等着的（重绘 / resolve）挨个叫醒 */
function settle(src: string, img: CanvasImageSource | null): void {
  if (img) decoded.set(src, img);
  else failed.add(src);
  evictOldest();
  const subs = waiting.get(src);
  waiting.delete(src);
  if (!subs) return;
  subs.forEach((cb) => {
    // 通知者自己出错（宿主重绘抛了 / resolve 了两次）不该连累其它等待者
    try { cb(); } catch { /* 见上 */ }
  });
}

/** 起一次解码（已经在解 / 已有结果就什么都不做）。`new Image()` 全库只在这里出现 */
function startDecode(src: string): void {
  if (waiting.has(src) || decoded.has(src) || failed.has(src)) return;
  waiting.set(src, new Set());
  // 非浏览器环境（SSR / 纯处理 JSON 的 Node 进程）里没有 Image：
  // 当成「解不了」而不是抛错 —— 这条图形的渲染本来就只发生在有画布的时候
  if (typeof Image !== 'function') { settle(src, null); return; }
  const el = new Image();
  el.onload = () => settle(src, el);
  el.onerror = () => settle(src, null);
  el.src = src;
}

/**
 * 取解码结果；没见过就顺手开始解。
 *
 * `onReady` 必须是**每个引擎一份的稳定函数**（类型实例构造时建一次）：解码期间它
 * 每帧都会被登记一次，每帧换一个新闭包的话这张订阅表会一直涨。
 */
function decode(src: string, onReady: () => void): Decode {
  const img = decoded.get(src);
  if (img) {
    decoded.delete(src);                 // 命中挪到队尾：屏幕上常画的那张别被挤掉
    decoded.set(src, img);
    return { kind: 'ok', img };
  }
  if (failed.has(src)) return { kind: 'failed' };
  startDecode(src);
  const subs = waiting.get(src);
  if (subs) subs.add(onReady);           // 刚 settle 过（没有 Image）时 subs 已经不在了
  return failed.has(src) ? { kind: 'failed' } : { kind: 'loading' };
}

/**
 * 等这张图解码完；**已经解完 / 已知解不了都返回 `null`**（= 不用等）。
 * 给 `whenReady` 用：出图前把还没解完的图等齐，免得成品里是占位框。
 */
function whenDecoded(src: string): Promise<void> | null {
  if (decoded.has(src) || failed.has(src)) return null;
  startDecode(src);
  return new Promise<void>((resolve) => {
    const subs = waiting.get(src);
    if (subs) subs.add(resolve);
    else resolve();                      // 极端情况：这一瞬刚好 settle 完了 → 已经就绪
  });
}

/* ================================================================
 * 几何
 * ================================================================ */

/** 图片的自然尺寸（自带多少像素）；`bad` = 文件里没带 / 不是正数，只能按 1:1 兜着画 */
interface Natural {
  wn: number;
  hn: number;
  bad: boolean;
}

/** 屏幕几何：中心 + 两条单位轴 + 屏幕上的整宽整高（长宽比 = 自然比例） */
interface ImageGeom {
  cx: number;
  cy: number;
  /** 局部 x 轴（图片的「右」） */
  ux: number;
  uy: number;
  /** 局部 y 轴（图片的「上」，即旋转柄那一侧） */
  nx: number;
  ny: number;
  /** 屏幕上的整宽 / 整高 */
  w: number;
  h: number;
  /**
   * **存着的**那两个角落在哪一象限（各 ±1，见 `_geom` 末尾）。
   *
   * 四角是两组对角，存储点只占其中一组；另一组（派生手柄 3 / 4 号）与它只差一个
   * `n` 分量的符号 —— 所以这一对符号就是「谁是存着的、谁是算出来的」的全部依据。
   * 不给的话，拖派生手柄时会把**存着的那对**当成另一条对角线写回去，图当场翻个个儿。
   */
  sa: number;
  sb: number;
}

export class ImageShape extends MapboxShapeType {
  get key(): string { return 'image'; }
  get label(): string { return '图片标注'; }
  get minPts(): number { return 3; }

  /**
   * 落图**不走**「落点数达标就成交」那条路：单击只负责给位置，顶点是选完图之后
   * 由 `place()` 一次性给出的（见下）。所以这里恒为 false。
   */
  get autoCommit(): boolean { return false; }

  /**
   * 解码完成后的重绘通知。**实例级稳定引用**：`decode()` 在解码期间每帧都会把它
   * 登记进订阅表，写成每帧新建的箭头函数会让那张表一直涨（见 decode 的说明）。
   */
  private readonly _notify = (): void => { this.requestRender(); };

  /**
   * 不接任何 cfg 键：图片本体与自然尺寸走 `Shape.data`（不能进 cfg），
   * 外观只有「边框色 / 边框宽 / 不透明度」三个**样式**键。
   */
  cfgKeys(): CfgKey[] { return []; }

  /**
   * 本类型专属的默认样式：**边框 2px、不透明度 0.85**（用户 2026-09-14 的口径）。
   * 不透明度这一项对图片是「边框 + 图片本体」一起（见 `render`），与其他类型同键同义。
   *
   * ★ 不改全局 `DEFAULT_STYLE` 的那两项：它们是线 / 面 / 引线**共用**的（3px 实色），
   *   按图片的口味改，等于把整张地图的线都改细、改淡。
   * ★ 也不在 `push()` 时写进 `shape.style`：那会变成「这条图形自己改过」——面板每行
   *   打上 `●`、导出 JSON 里凭空多一段 style，而「恢复默认」一按又跳回 3px。
   * 走这里是**类型的出厂值**：画出来是 2 / 0.85，面板回显是它，「恢复默认」清掉图形
   * 自己的覆盖之后落回来的仍是它。
   */
  defaultStyle(): StylePatch { return { pathWidth: 2, lineOpacity: 0.85 }; }

  get hint(): string {
    return '🖼 绘制<b>图片标注</b>：<b>单击地图</b>选位置，在弹出的文件框里挑一张图片，'
      + '<b>选完直接贴上</b>（不用再点）<br />'
      + '・拖<b>四个角手柄</b>＝等比改大小　・拖<b>图片内部</b>＝平移　'
      + '・拖<b>上方的圆柄</b>＝旋转（按住 <b>Shift</b> 每 15° 吸附一档）<br />'
      + '・图片本体跟着图形一起导出，换台机器打开照样在　・<b>Esc</b>＝取消';
  }

  /* ---------------- 数据读取 ---------------- */

  /** 图片本体的 data URL；没有 / 不是字符串时返回空串 */
  private _src(shape: Shape): string {
    const v = shape.data ? shape.data.image : undefined;
    return typeof v === 'string' && v ? v : '';
  }

  /**
   * 自然尺寸。**缺失也要能画**：退回 1:1，按存储的两个角定出一块可见的方框并标一句
   * 「数据缺失」—— 什么都不画的话这条图形就是「看不见却点得中」，比画错了还难查。
   */
  private _natural(shape: Shape): Natural {
    const d = shape.data;
    const wn = d ? Number(d.w) : NaN;
    const hn = d ? Number(d.h) : NaN;
    const ok = isFinite(wn) && wn > 0 && isFinite(hn) && hn > 0;
    return ok ? { wn, hn, bad: false } : { wn: 1, hn: 1, bad: true };
  }

  /* ---------------- 几何 ---------------- */

  /**
   * 由「两个对角 + 旋转柄」的投影点算出屏幕几何；退化 / 坏数据返回 null。
   *
   * 两条轴只由**旋转柄**定（所以跟两个角谁写在前面无关），尺度由两个角的
   * **间距**定（所以长宽比恒等于自然比例）。
   */
  private _geom(geo: LngLat[], nat: Natural): ImageGeom | null {
    if (geo.length !== 3) return null;
    // ★ 顶点先换算到**地面平面**，下面全是平面里的算式（手性 'down'，与旧实现吃的
    //   屏幕坐标同一套）；返回的 ImageGeom 也在平面里，调用方在边界处再投影回屏幕。
    //   无倾斜 / 无旋转时平面坐标 = 屏幕坐标（差一个平移），所以逐点几何与从前一致。
    const f = this.groundFrameAt(geo[0][1]);
    const plane = toPlane(geo, f, 'down');
    const P0 = plane[0], P1 = plane[1], K = plane[2];
    // 任何一个坐标不是有限数（坏数据 / 拿不到投影）直接判退化：
    // 后面全是乘除，NaN 会一路漏下去，最后写出 NaN 顶点
    if (!isFinite(P0.x + P0.y + P1.x + P1.y + K.x + K.y)) return null;

    const cx = (P0.x + P1.x) / 2, cy = (P0.y + P1.y) / 2;
    let nx = K.x - cx, ny = K.y - cy;
    const nlen = Math.hypot(nx, ny);
    if (!(nlen > 1e-6)) return null;              // 柄压在中心上：朝向定不出来
    nx /= nlen; ny /= nlen;

    // 局部 x 轴 = 「上方向」在屏幕上转 90°（屏幕 y 向下，所以 (−ny, nx) 是它的右手边）。
    // 符号不按点序翻 —— 理由见文件头那段。
    const ux = -ny, uy = nx;

    // 一个自然像素 = 几个屏幕像素：一对角之间的**距离**除以半对角向量的长度。
    // 用距离而不是投影（dot）：两个存储点不论落在哪一条对角线上，距离都是 k·|D|，
    // 于是「谁写在前面」「是左上还是右下」都不影响尺寸
    const dx = (nat.wn / 2) * ux + (nat.hn / 2) * nx;
    const dy = (nat.wn / 2) * uy + (nat.hn / 2) * ny;
    const dd = Math.hypot(dx, dy);
    if (!(dd > 1e-6)) return null;                // 自然尺寸不成形
    const k = Math.hypot(P1.x - cx, P1.y - cy) / dd;
    const w = k * nat.wn, h = k * nat.hn;
    if (!(w >= DEGENERATE) || !(h >= DEGENERATE)) return null;

    // 0 号角在两条轴上各落在哪一侧（±1）：它到中心的向量本来就是 ±(k·wn/2)u ± (k·hn/2)n，
    // 所以往 u / n 上各投一次就得到符号（与 `writeGeom` / `_rotate` 里那两行同一口径）。
    // 这对方符号决定「另外两个角算在哪」（`_halfDiag(g, -1, …)`），四支缩放柄全靠它
    const sa = (P0.x - cx) * ux + (P0.y - cy) * uy < 0 ? -1 : 1;
    const sb = (P0.x - cx) * nx + (P0.y - cy) * ny < 0 ? -1 : 1;
    return { cx, cy, ux, uy, nx, ny, w, h, sa, sb };
  }

  /** 四角（顺时针，从「右上」起）—— 渲染 / 命中 / 剔除共用同一份点列 */
  private _corners(g: ImageGeom): ScreenPoint[] {
    const ax = (g.ux * g.w) / 2, ay = (g.uy * g.w) / 2;
    const bx = (g.nx * g.h) / 2, by = (g.ny * g.h) / 2;
    return [
      { x: g.cx + ax + bx, y: g.cy + ay + by },
      { x: g.cx - ax + bx, y: g.cy - ay + by },
      { x: g.cx - ax - bx, y: g.cy - ay - by },
      { x: g.cx + ax - bx, y: g.cy + ay - by },
    ];
  }

  /**
   * 半对角线向量（从**中心指向某一个角**），按传进来的宽高定比例。
   *
   *     sign = +1 → A = sa·(w/2)u + sb·(h/2)n   ← **存着的**那一对角的向量（0 / 1 号柄）
   *     sign = −1 → B = sa·(w/2)u − sb·(h/2)n   ← 另一条对角（3 / 4 号**派生**手柄）
   *
   * `w`/`h` 传屏幕尺寸就是屏幕向量，传 `nat.wn`/`nat.hn` 就是「一个自然像素 = 1 屏幕
   * 像素」的单位比例版本 —— `_resize` 里两条都要用（`k` 是以单位比例定义的）。
   *
   * ★ 为什么另外两个角要**算**而不能**存**：四角是两组对角，存两组就**过定**了
   *   （朝向、长宽比、尺寸全被多余的自由度顶着，拖一次就可能不再是个矩形），
   *   而且存 4 个点会与「`k = |角1 − 中心| / |D|`」这条恒等式打架。B 与 A 只差一个
   *   `n` 分量的符号，算出来的仍是**真正的角**，于是四个角都能挂缩放柄。
   */
  private _halfDiag(g: ImageGeom, sign: number, w: number, h: number): ScreenPoint {
    return {
      x: (g.sa * w * g.ux) / 2 + (sign * g.sb * h * g.nx) / 2,
      y: (g.sa * w * g.uy) / 2 + (sign * g.sb * h * g.ny) / 2,
    };
  }

  /**
   * 五支手柄：两个存储角 + 旋转柄（下标 0 / 1 / 2，与 `pts` 一一对应），外加两个
   * **派生出来的**缩放柄（下标 3 / 4，落在另外两个角上）。
   *
   * ★ 用户 2026-09-14 的口径「缩放应该左上角和右下角也有」—— 四个角都能拖。
   *   3 / 4 号是**派生手柄**（下标 ≥ `pts.length`，见基类 `handles()` 那段）：
   *   它们没有对应的存储顶点，所以拖起来必须由 `dragTo()` 自己算（`_resize` 里
   *   「两个存储角一起重写」那一路）。只加 `handles()` 而不管 `dragTo()` 的话，
   *   手柄看着在、拖着不动。
   * ★ 3 号 = 中心 + B、4 号 = 中心 − B（B 见 `_halfDiag`）。任意一支的对角那头就是
   *   它拖起来**固定不动**的锚点 —— 四支缩放柄在这一点上是完全对称的。
   * ★ 形态算不出来（退化 / 坏数据）时退回 `projectPts()`：那时至少两个存储角还能拖
   *   —— 手柄总得抓得着（与 `drawHandles` 返回 false、交回引擎白点是同一件事）。
   */
  handles(shape: Shape): ScreenPoint[] {
    const Pts = this.projectPts(shape);
    const g = this._geom(shape.pts, this._natural(shape));
    if (!g) return Pts;
    // ★ 几何在平面上，手柄要交给引擎当点击目标 ⇒ 折回屏幕
    const f = this.groundFrameAt(shape.pts[0][1]);
    const b = this._halfDiag(g, -1, g.w, g.h);
    const plane = [
      { x: g.cx, y: g.cy },
      { x: g.cx, y: g.cy },
      { x: g.cx, y: g.cy },
      { x: g.cx + b.x, y: g.cy + b.y },
      { x: g.cx - b.x, y: g.cy - b.y },
    ];
    // 0 / 1 号＝两个**存储角**（平面坐标由 `_geom` 的符号定），2 号＝旋转柄存的是真顶点
    const st = toPlane(shape.pts, f, 'down');
    plane[0] = st[0];
    plane[1] = st[1];
    plane[2] = st[2];
    return this._screenPts(plane, f);
  }

  /** 反投影一个屏幕点到经纬度（拿不到地图时抛错，由调用方那一帧放弃） */
  private _un(x: number, y: number): LngLat {
    const m = this.map;
    if (!m) throw new Error('宿主已销毁，无法落图。');
    const ll = m.unproject([x, y]);
    return [ll.lng, ll.lat];
  }

  /* ---------------- 地面平面（2026-09-18 起图片的几何都在它上面算） ---------------- */

  /**
   * 图片的几何（中心 / 两条轴 / 宽高 / 手柄）一律在**地面平面**上算（见
   * `ground-frame.ts`），只在边界处换算：
   *   · 屏幕鼠标点 → 平面：`_planeOf()`
   *   · 平面点 → 屏幕：`_screenPt()` / `_screenPts()`
   *
   * 平面比例只由 zoom 与纬度定、**与相机姿态无关**，所以地图倾斜 / 旋转时照片不再
   * 跟着乱缩：它平铺在地面上，倾斜时呈透视（与矩形 / 圆 / 扇形 / 旗一个口径，
   * 用户 2026-09-18 选的就是这一条）。手性用 `'down'` —— 本文件的算式都是按屏幕
   * 坐标（y 向下）写的，平面取同一手性才不会镜像。
   */
  private _planeOf(x: number, y: number, f: GroundFrame): ScreenPoint | null {
    try {
      return toPlaneOne(this._un(x, y), f, 'down');
    } catch {
      return null;                               // 地图拿不到：这一帧不动
    }
  }

  /** 平面点 → 屏幕 */
  private _screenPt(p: ScreenPoint, f: GroundFrame): ScreenPoint {
    return this.project(fromPlane(p, f, 'down'));
  }

  /** 平面点列 → 屏幕点列 */
  private _screenPts(pts: ScreenPoint[], f: GroundFrame): ScreenPoint[] {
    return this.planeToScreen(pts, f, 'down');
  }

  /**
   * 由「中心 + 角度 + 比例」算出三个顶点（两个**真正的角** + 旋转柄）。
   *
   * ★ 落图（`place`）、拖柄旋转（`_rotate`）、面板改几何（`writeGeom`）三处都走它：
   *   各写一份的话，「角的符号」「柄摆在哪」这类口径迟早会跑偏 —— 手柄飘到图片外面
   *   就是这么来的。三条路也都写的是**真正的角**，文件头那条恒等式（`k` 能复原）
   *   才立得住。
   *   （`_resize` 不走它：那条路是从**固定不动的那个角**反推中心与比例的，算式不是
   *   这一种；但它落的是同一个口径 —— 两个存储点必须是真的角。）
   *
   * @param ang  图片的「右」（u 轴）在屏幕上的角度（弧度）：**0 = 正放**
   * @param k    一个自然像素等于几个屏幕像素
   * @param sx,sy 这对角沿 u / n 轴的**符号**（±1）：决定它是「右上左下」还是「左上
   *              右下」那一对。传**当前那两个角的符号** —— 于是转完、缩完之后，
   *              每支手柄还长在原来那个图角上，两支不会互换位置
   * @param knob 旋转柄摆在哪（屏幕坐标）。它不是几何的一部分、只提供方向：
   *             落图 / 改大小 / 面板改完都摆在「新中心正上方 h/2 + KNOB_GAP」，
   *             只有拖柄那条路摆在光标处（拖到哪都行，见 `_rotate`）
   */
  private _verts(
    nat: Natural, cx: number, cy: number, ang: number, k: number,
    sx: number, sy: number, knob: ScreenPoint, f: GroundFrame,
  ): LngLat[] {
    const ux = Math.cos(ang), uy = Math.sin(ang);
    const nx = uy, ny = -ux;                    // n = u 转 90°（与 _geom 的 u = (-ny, nx) 互逆）
    const ax = (sx * k * nat.wn * ux) / 2 + (sy * k * nat.hn * nx) / 2;
    const ay = (sx * k * nat.wn * uy) / 2 + (sy * k * nat.hn * ny) / 2;
    // ★ 入参 / 出参都在**地面平面**上（`cx/cy/knob` 是平面坐标，先前的实现是屏幕坐标
    //   + 反投影；现在平面点直接折回经纬，少一次 unproject 往返）
    return [
      fromPlane({ x: cx + ax, y: cy + ay }, f, 'down'),
      fromPlane({ x: cx - ax, y: cy - ay }, f, 'down'),
      fromPlane(knob, f, 'down'),
    ];
  }

  /**
   * 某条对角线的屏幕角度（`Math.atan2` 那种：0 = 正右、顺时针为正）——
   * 就是「从中心指向这条对角线上那个角」的方向，`_halfDiag` 直接给它。
   *
   * `sign` 与 `_halfDiag` 同义：`+1` = 存着的对角（0 / 1 号柄）、`−1` = 派生的那条
   * （3 / 4 号柄）。两组角朝两个方向，箭头得各指各的。
   *
   * 手柄图标与手柄光标**必须指同一个方向**（一个斜 30° 的图，配一支正 45° 的箭头
   * 就是把人往错的方向带），所以这条算式只有这一份：`drawHandles` 与 `vertexCursor` 共用。
   */
  private _diagAng(g: ImageGeom, sign: number, f: GroundFrame): number {
    // ★ 几何在地面平面上，而图标 / 鼠标样式画在屏幕上 ⇒ 中心与那个角都要投到屏幕再量
    const quad = this._screenPts(this._corners(g), f);          // [TR, TL, BL, BR]
    const c = this._screenPt({ x: g.cx, y: g.cy }, f);
    // 存着的那条对角线（sign = +1）落在 (sa, sb) 象限；派生那条只差一个 n 分量的符号
    const sa = g.sa, sb = sign > 0 ? g.sb : -g.sb;
    const i = sa > 0 ? (sb > 0 ? 0 : 3) : (sb > 0 ? 1 : 2);
    const p = quad[i];
    return Math.atan2(p.y - c.y, p.x - c.x);
  }

  /* ---------------- 异步落图 ---------------- */

  /**
   * 异步落图（引擎在单击时调用，见 `_placeAsync`）：先请**宿主**弹文件框选图，
   * 再把这条图形以「单击处为图片**中心**、屏幕正放、长边不超过 `MAX_SIDE`」落下来。
   *
   * 三个顶点全是**屏幕算完再反投影**的：尺寸与朝向由我们定，跟用户点哪儿无关
   * （点在哪儿，哪儿就是中心）。返回 `null` = 用户取消，引擎会保持绘制态。
   *
   * ★ 写成**箭头函数字段**而不是原型方法：基类里 `place` 声明成可选属性，
   *   子类用方法去实现会被 TS 判成两种成员（TS2425，见基类那段注释）。
   */
  place = async (ctx: PlaceContext): Promise<PlaceResult | null> => {
    const picked = await this.pickImage();     // 宿主没配 pickImage 会抛 → 变成一句 onWarn
    if (!picked) return null;

    // 宿主报的尺寸可能是坏的（0 / NaN / 字符串）：宁可当 1:1 方图，也别让 NaN 烂进顶点
    const wn = Number(picked.width), hn = Number(picked.height);
    const okNat = isFinite(wn) && wn > 0 && isFinite(hn) && hn > 0;
    const aw = okNat ? wn : 1, ah = okNat ? hn : 1;

    const d = this.draw;
    // ★ 落点处的地面平面中心（几何都在平面上算，见 `_planeOf` 那段说明）
    const f = this.groundFrameAt(ctx.lngLat[1]);
    const c = toPlaneOne(ctx.lngLat, f, 'down');
    // 落地尺度：**只缩不放**（本来小的图保持 1:1 原始像素），再按画布短边夹一道 ——
    // 200px 的图落在 300px 宽的画布上就顶到天花板了。画布还没建好时（_cw = 0）只用 200
    const short = d ? Math.min(d._cw, d._ch) : 0;
    const cap = short > 0 ? Math.min(MAX_SIDE, short / 3) : MAX_SIDE;
    const k = Math.min(1, cap / Math.max(aw, ah));
    const hh = (ah * k) / 2;

    // 初始朝向 = 屏幕正放（角度 0）：图片的「上」对着屏幕上方，旋转柄在上边外侧 30px。
    // 存的两个角取「右上 / 左下」这一对（谁先谁后无所谓，见 _geom 的符号处理）——
    // `_verts` 的 sx/sy 就是这一对角的符号，与 `_resize` / `_rotate` 之后重新写出来的
    // 仍是同一对
    const pts: LngLat[] = this._verts(
      { wn: aw, hn: ah, bad: !okNat }, c.x, c.y, 0, k, 1, 1,
      { x: c.x, y: c.y - hh - KNOB_GAP }, f,
    );
    // 顺手起一次解码：等用户松手时图多半已经好了，不必先看一眼「图片加载中…」
    if (okNat) startDecode(picked.dataUrl);
    return { pts, data: { image: picked.dataUrl, w: aw, h: ah } };
  };

  /* ---------------- 拖拽：改大小 / 旋转（平移走引擎默认） ---------------- */

  /**
   * 自算拖拽。`kind === 'body'`（拖图片内部平移）返回 false —— 引擎默认那套
   * 「按屏幕位移把各顶点整体搬」正是要的，一行都不用重写（图片因此在拖动中
   * 既不变形也不变朝向）。
   *
   * ★ 2026-09-18 起几何在地面平面上：这里传 `ctx.orig`（经纬快照）给 `_geom`，
   *   光标在 `_rotate` / `_resize` 里再折到同一个平面。原先那份
   *   「把快照投影成屏幕点」的 `_projectOrig` 因此删掉了 —— 平面坐标就是它的替代。
   */
  dragTo(ctx: DragContext): boolean {
    if (ctx.kind !== 'vertex') return false;
    const nat = this._natural(ctx.shape);
    const f = this.groundFrameAt(ctx.orig[0][1]);
    const g = this._geom(ctx.orig, nat);          // ★ 几何吃经纬点列（内部走地面平面）
    if (!g) return false;                        // 形态坏了：交回引擎默认，至少还能拖
    if (ctx.vi === 2) return this._rotate(ctx, g, nat, f);
    // 四支缩放柄走同一条算式：0 / 1 是存着的两个角，3 / 4 是派生出来的另两个角
    // （它们在 `pts` 里没有对应项，所以引擎那套「顶点跟光标」写不了 —— 必须自己算）
    if (ctx.vi !== 0 && ctx.vi !== 1 && ctx.vi !== 3 && ctx.vi !== 4) return false;
    return this._resize(ctx, g, nat, ctx.vi, f);
  }

  /**
   * 手柄的鼠标样式（用户 2026-09-14 提的）：**拖柄是「转」、拖角是「改大小」**，
   * 光标得在按下去之前就把这件事说出来，而不是让人试一下才知道。
   *
   * 缩放那四支要**跟着图片当前朝向转**：角是沿图片的对角线走的（见 `_resize` 的
   * 那道投影），图斜 30°，双向箭头也斜 30° —— 指的正是拖起来会走的那条线。
   * 四支缩放柄分属**两条**对角线（0/1 与 3/4），所以角度得按柄选（`_diagAng` 的 `sign`）。
   *
   * 退化形态（柄压在中心上 / 两个角重合）算不出朝向，但仍然给一支不转的双向箭头：
   * 手柄还是「改大小」的手柄，这里退回默认指针会让人以为它不能拖。
   */
  vertexCursor(shape: Shape, vi: number): string | null {
    if (vi === 2) return rotateCursor();
    if (vi !== 0 && vi !== 1 && vi !== 3 && vi !== 4) return null;
    const f = this.groundFrameAt(shape.pts[0][1]);
    const g = this._geom(shape.pts, this._natural(shape));
    if (!g) return scaleCursor(0);
    // 同一条对角线上的两支是相反的两个方向，而双向箭头本来就是轴对称的 —— 它们
    // 用同一个角都是同一支箭头。角度与手柄图标共用 `_diagAng()`，两边不许各指一个方向
    return scaleCursor(this._diagAng(g, vi >= 3 ? -1 : 1, f));
  }

  /**
   * 自己画五个手柄（引擎只在**选中**这条图形、编辑态下调用，见基类那段）。
   *
   * 用户 2026-09-14 提的：光靠鼠标指针看不出控制点是干什么的（而且 Safari / Firefox
   * 根本不画 SVG 光标），所以手柄画成两种图标，看图就知道拖哪个：
   *   0 / 1 / 3 / 4 号（四个图角）→ 双向箭头，方向**跟着所在的对角线转**（斜着的图配
   *                                一支正箭头就是把人往错的方向带）
   *   2 号（旋转柄）             → 转圈箭头
   * 与 `vertexCursor()` 是同一套语义，只是不再指望浏览器把光标画出来。
   *
   * `hoverVi` 那一支画成激活态（橙底白笔画 + 放大一圈）：鼠标挪到控制点上得有反应，
   * 用户 2026-09-14 报的第二件事 —— 光换光标不算反应，Safari / Firefox 上连光标都不换。
   */
  drawHandles(shape: Shape, hoverVi: number): boolean {
    const ctx = this.ctx;
    const f = this.groundFrameAt(shape.pts[0][1]);
    const g = this._geom(shape.pts, this._natural(shape));
    // 形态算不出来（退化 / 坏数据）：交回引擎那圈通用白点 —— 图标再好看，
    // 也得先保证「手柄抓得着」（那时 `vertexCursor` 也退回了一支不转的双向箭头）
    if (!ctx || !g) return false;
    // 位置一律从 `handles()` 取：那正是引擎判定「点着了哪个手柄」用的点列，
    // 在这儿另算一遍就会出现「图标画在 A、判定认的是 B」—— 看着有手柄、拖不动
    const Hs = this.handles(shape);
    const ang0 = this._diagAng(g, 1, f);         // 0 / 1 号所在的那条对角线
    const ang1 = this._diagAng(g, -1, f);        // 3 / 4 号所在的那条
    scaleHandleIcon(ctx, Hs[0].x, Hs[0].y, ang0, hoverVi === 0);
    scaleHandleIcon(ctx, Hs[1].x, Hs[1].y, ang0, hoverVi === 1);
    rotateHandleIcon(ctx, Hs[2].x, Hs[2].y, hoverVi === 2);
    scaleHandleIcon(ctx, Hs[3].x, Hs[3].y, ang1, hoverVi === 3);
    scaleHandleIcon(ctx, Hs[4].x, Hs[4].y, ang1, hoverVi === 4);
    return true;
  }

  /* ---------------- 面板上的几何控件（旋转角度 / 尺寸） ---------------- */

  /**
   * 读当前几何：**屏幕角度**（0 = 正放、顺时针为正）+ **长边像素**。
   *
   * 两个都是屏幕量纲，与面板上那两行控件的口径一致（见 `GeomState`）；
   * 形态退化时返回 `null`（那时面板整组不列，列出来也没东西可调）。
   */
  readGeom(shape: Shape): GeomState | null {
    const g = this._geom(shape.pts, this._natural(shape));
    if (!g) return null;
    // u 轴的方向角就是「图片转了多少度」（正放时 u = (1,0) → 0）。
    // 归一化到 [0,360)：`atan2` 给的是 (-180,180]，面板上出现一个 -90 会被读成
    // 「反向转了 90°」，而拖柄的直觉是一直往前转
    let deg = (Math.atan2(g.uy, g.ux) * 180) / Math.PI;
    if (deg < 0) deg += 360;
    deg = Math.round(deg * 10) / 10;               // 抹掉浮点尾巴：359.9999 看着像坏了
    if (deg >= 360) deg = 0;                       // 四舍五入到 360 = 没转（面板上别出现 360）
    return {
      rotateDeg: deg,
      sizePx: Math.round(Math.max(g.w, g.h) * 10) / 10,
    };
  }

  /**
   * 面板上改几何。与拖柄、拖角**写的是同一份顶点**，只是输入从「光标在哪」换成
   * 「一个数」—— 所以共用 `_verts()`，落出来的图和拖出来的一模一样。
   *
   * 两个参数都以**中心不动**为前提：两个角按新的角度 / 比例对称地重写，而中心是
   * 它们的中点，于是自然不动（同 `_rotate`）。
   */
  writeGeom(shape: Shape, patch: GeomPatch): boolean {
    // ★ 坏值（NaN / 非正数）一律当「这一项**没给**」，而不是「改成一个坏值」：
    //   这是公开 API，面板那头虽然校验过，宿主直接传什么进来都可能 —— 按坏值往下算
    //   会写出一组 NaN 顶点（`_verts` 里全是乘除），而返回 true 还会白重绘一帧、
    //   白通知一次宿主。两项都不可用时才算「没有改动」。
    const rot = typeof patch.rotateDeg === 'number' && isFinite(patch.rotateDeg)
      ? patch.rotateDeg : null;
    const size = typeof patch.sizePx === 'number' && isFinite(patch.sizePx) && patch.sizePx > 0
      ? patch.sizePx : null;
    if (rot == null && size == null) return false;
    const nat = this._natural(shape);
    const f = this.groundFrameAt(shape.pts[0][1]);
    const plane = toPlane(shape.pts, f, 'down');   // ★ 几何吃地面平面
    const g = this._geom(shape.pts, nat);
    if (!g) return false;                          // 退化形态：这时 readGeom 也是 null

    // 角度：`GeomPatch` 里的度 → 弧度，口径与 `readGeom` 一致（u 轴的方向角）
    let ang = Math.atan2(g.uy, g.ux);
    if (rot != null) ang = (rot * Math.PI) / 180;
    // 尺寸：给的是**长边**，按长宽比换算成「每自然像素几个屏幕像素」；下限同拖角
    // （夹住最小尺寸，免得调成一条抓不着的线）
    const kNow = g.w / nat.wn;
    let k = kNow;
    if (size != null) k = Math.max(MIN_SIDE / Math.min(nat.wn, nat.hn), kNow * (size / Math.max(g.w, g.h)));
    // 这一对角的符号：拿存储的那两个角往**当前**两条轴上投 —— 同 `_rotate`，
    // 转完 / 缩完每支手柄还是原来那个图角上的手柄
    const P0 = plane[0];
    const sx = (P0.x - g.cx) * g.ux + (P0.y - g.cy) * g.uy < 0 ? -1 : 1;
    const sy = (P0.x - g.cx) * g.nx + (P0.y - g.cy) * g.ny < 0 ? -1 : 1;
    // 柄摆回「新中心正上方 h/2 + KNOB_GAP」（与落图 / 拖角同一个摆法）：它只提供方向，
    // 不能因为刚转过一次就停在一个歪七扭八的地方 —— 那会让下一次拖柄的手感变样
    const hh = (k * nat.hn) / 2;
    const pts = this._verts(nat, g.cx, g.cy, ang, k, sx, sy,
      { x: g.cx + Math.sin(ang) * (hh + KNOB_GAP), y: g.cy - Math.cos(ang) * (hh + KNOB_GAP) }, f);
    shape.pts[0] = pts[0];
    shape.pts[1] = pts[1];
    shape.pts[2] = pts[2];
    return true;
  }

  /**
   * 旋转：柄**只提供方向**（拖到哪、离多远都行），摁住 Shift 时先把方向吸附到 15°
   * 网格。吸附的是柄的方向，而柄的方向就是图片的「上」（见 `_geom`），所以图的朝向
   * 也随之落在一档一档上（u 轴与它差 90°，90 是 15 的整数倍，一起被吸附）。
   *
   * ★ 为什么**必须**把两个角一起重写，而不是只写柄、剩下的交给引擎默认的
   *   「顶点跟光标」（曾经就是那么做的 —— 用户 2026-09-14 报「旋转后缩放的控制点
   *   没有更新位置」）：画出来的四角是从「柄的方向 + 两个角的间距」**现算**的，
   *   而引擎的手柄画在**存储顶点**上。只挪柄，图转了、存的那两个角却还在原处，
   *   手柄当场飘到图片外面去。按新方向把两个角重写成**真正的角**之后：
   *   · 手柄永远贴在图角上（同一位图角、同一支手柄，跟着图一起转）；
   *   · `_geom` 的 `k = |角1 − M| / |D|` 恒等成立（写的就是角），尺寸不会被偷改。
   *
   * 取哪一对角：沿新轴 (u′, n′) 用**按下时那一对角的符号** —— 于是「右上 / 左下」
   * 这样的身份关系被保住，转完不会两支手柄互换位置。两个角对新中心对称，
   * 而 M 是两个角的中点 → M 不动，图是**绕中心**转。
   */
  private _rotate(ctx: DragContext, g: ImageGeom, nat: Natural, f: GroundFrame): boolean {
    // ★ 几何在平面上，光标是屏幕坐标 ⇒ 先折到平面（拿不到地图时这一帧不动）
    const p = ctx.point ? this._planeOf(ctx.point.x, ctx.point.y, f) : null;
    if (!p || !isFinite(p.x) || !isFinite(p.y)) return true;
    const dx = p.x - g.cx, dy = p.y - g.cy;
    const len = Math.hypot(dx, dy);
    if (!(len > 1e-6)) return true;                         // 光标压在中心上：方向不定

    let ang = Math.atan2(dy, dx);                           // 柄的方向 = 图片的「上」
    if (ctx.shift) {
      const step = (SNAP_DEG * Math.PI) / 180;
      ang = Math.round(ang / step) * step;
    }
    // 柄写在「离中心一样远、方向取吸附后那个」的点上：Shift 吸附只该改方向，
    // 不该把柄顺手拽到别的距离去（下一帧再拖时手感会莫名其妙地变）
    const knob = { x: g.cx + Math.cos(ang) * len, y: g.cy + Math.sin(ang) * len };
    // 这一对角的符号：拿按下时的快照往**旧轴**上投，重新写出来的仍是「同一个角」
    const o0 = toPlaneOne(ctx.orig[0], f, 'down');
    const sx = (o0.x - g.cx) * g.ux + (o0.y - g.cy) * g.uy < 0 ? -1 : 1;
    const sy = (o0.x - g.cx) * g.nx + (o0.y - g.cy) * g.ny < 0 ? -1 : 1;

    // 柄的方向转 90° = 图片的「右」（`_verts` 口径）；比例 k 不变（旋转不改尺寸）。
    // 柄就写在光标那一段距离上：它只提供方向，距离没有语义（下一次 `_resize` /
    // 面板改几何会把它摆回「新中心正上方 h/2 + KNOB_GAP」，与 `place()` 落图时一个摆法）
    const shape = ctx.shape;
    const pts = this._verts(nat, g.cx, g.cy, ang + Math.PI / 2, g.w / nat.wn, sx, sy, knob, f);
    shape.pts[0] = pts[0];
    shape.pts[1] = pts[1];
    shape.pts[2] = pts[2];
    return true;
  }

  /**
   * 拖角改大小：**锁定等比**（用户 2026-09-14 选的口径）。四支缩放柄（0 / 1 / 3 / 4）
   * 走的是**同一条**算式 —— 它们在四个角上是对称的，分四份写迟早有一支跑偏。
   *
   * 引擎默认是「被拖的顶点＝光标」，那会让长宽比随便变（图被拉变形）。这里把光标
   * **投影到那条等比对角线上**：对角那头固定不动、朝向不变、比例恒等于自然尺寸。
   *
   *     end = ±1                        （被拖的柄在这条对角线上的哪一头）
   *     W   = 该对角线**单位比例**下的半对角向量（见 `_halfDiag`）
   *     F   = M − end·k·W               （对角那头：拖起来一动不动）
   *     k'  = end·dot(光标 − F, W) / (2|W|²)   （把光标投到 F → F+2k'·end·W 这条射线上）
   *     M'  = F + k'·end·W              （新中心）
   *     两个存储角 = M' ± k'·A          （A 恒取 `+1` 那条，见下）
   *
   * ★ 两条对角线只差一个 `n` 分量的符号（`_halfDiag`），所以 W 用 `sign` 选：
   *   `+1` = 存着的那条（0 / 1 号柄）、`−1` = 派生的那条（3 / 4 号柄）。
   *   而 A **恒取 `+1`** —— 存着的那对角永远写在原来那条对角线上，不跟着被拖的柄走
   *   （跟着走的话，拖一下派生柄就会把存着的这对挪到另一条对角线上，图当场翻个个儿）。
   * ★ 拖 0 / 1 号时另一个存储角**原封不动**（它就是不动的锚点）：不写它，连一次
   *   `unproject → project` 往返都省了 —— 那点浮点误差足以让「固定角一动不动」
   *   这句话连测试都过不去。
   *   拖 3 / 4 号时中心会动（锚点在**另一条**对角线的反向端，不是被拖柄的对角），
   *   所以那两个存储角**都得重写**。
   *
   * 投影长度夹到最小尺寸（`MIN_SIDE`）：拖回锚点是「缩到看不见」，松手就再也
   * 抓不着了；夹住则始终留一条抓得住的边。
   *
   * ★ 改大小的同时**把旋转柄一起挪**：中心 M 是两个角的中点，拖一个角就会动 M，
   *   而柄存的是经纬度 —— 不管它的话，「上方向」= 柄 − M 跟着变，图会莫名其妙地
   *   边缩边转（实测拖一次角歪 12°，很显眼）。柄的位置本来就没有语义（它只提供方向、
   *   拖到哪都行），所以按**旧方向**把它放到新中心的正上方 `h/2 + KNOB_GAP` 处，
   *   与 `place()` 落图时的摆法一致 —— 于是「拖角只改大小」这句话才立得住。
   */
  private _resize(ctx: DragContext, g: ImageGeom, nat: Natural, vi: number, f: GroundFrame): boolean {
    const derived = vi >= 3;                     // 3 / 4 号：另一条对角线上的派生柄
    const end = vi === 0 || vi === 3 ? 1 : -1;   // 柄在所属对角线上的哪一头
    const W = this._halfDiag(g, derived ? -1 : 1, nat.wn, nat.hn);
    const A = this._halfDiag(g, 1, nat.wn, nat.hn);
    const dd = W.x * W.x + W.y * W.y;
    if (!(dd > 1e-9)) return true;                          // 尺寸不成形：这一帧不动

    // 锚点 F：中心退掉「被拖柄那一半」就是它（按下时的快照推出来，与 pts 当前位置无关）
    const kOld = g.w / nat.wn;
    const fx = g.cx - end * kOld * W.x, fy = g.cy - end * kOld * W.y;

    // ★ 光标（屏幕）→ 地面平面；写回时再从平面折回经纬
    const p = ctx.point ? this._planeOf(ctx.point.x, ctx.point.y, f) : null;
    if (!p || !isFinite(p.x) || !isFinite(p.y)) return true;
    const kMin = MIN_SIDE / Math.min(nat.wn, nat.hn);
    const k = Math.max(kMin, (end * ((p.x - fx) * W.x + (p.y - fy) * W.y)) / (2 * dd));

    // 新中心（两个存储角的平面中点），把这一对角按新中心 / 新比例对称摆回去。
    // ★ 这个 `end` 不能省：`k` 是**长度**（恒正），方向全在 `end·W` 上 ——
    //   省掉它的话，锚点在上方的那两支柄（1 号与 4 号）会把中心摆到镜像的另一侧，
    //   两个存储角直接重合、图形当场退化
    const mx = fx + k * end * W.x, my = fy + k * end * W.y;
    const shape = ctx.shape;
    const toLL = (x: number, y: number): LngLat => fromPlane({ x, y }, f, 'down');
    if (vi === 0) shape.pts[0] = toLL(mx + k * A.x, my + k * A.y);
    else if (vi === 1) shape.pts[1] = toLL(mx - k * A.x, my - k * A.y);
    else {
      shape.pts[0] = toLL(mx + k * A.x, my + k * A.y);
      shape.pts[1] = toLL(mx - k * A.x, my - k * A.y);
    }

    // 柄：新中心正上方 h/2 + KNOB_GAP，方向沿用打开时的 n（与落图 / 面板改几何同一摆法）
    const gap = (k * nat.hn) / 2 + KNOB_GAP;
    shape.pts[2] = toLL(mx + g.nx * gap, my + g.ny * gap);
    return true;
  }

  /* ---------------- 渲染与命中 ---------------- */

  /** 图片本体 + 边框；解码没完 / 没数据时画占位框 + 一句说明（尺寸朝向与真图一致） */
  render(shape: Shape): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const st = this.styleFor(shape);
    const nat = this._natural(shape);
    const f = this.groundFrameAt(shape.pts[0][1]);
    const g = this._geom(shape.pts, nat);
    if (!g) return;                              // 退化（两个角重合 / 柄压在中心）：不画

    // ★ 照片**平铺在地面上**（2026-09-18 用户选的口径）：把平面四角投影成屏幕四边形，
    //   再把图映射上去 —— 倾斜 / 旋转时就是这块地面的透视，与矩形 / 圆一个口径
    const quad = this._screenPts(this._corners(g), f);          // [TR, TL, BL, BR]
    const box = quad.concat([quad[0]]);                         // 折线描边不会自己闭合

    const src = this._src(shape);
    const d: Decode = src ? decode(src, this._notify) : { kind: 'failed' };

    if (d.kind === 'ok') {
      if (st.lineOpacity < 1) { ctx.save(); ctx.globalAlpha = st.lineOpacity; }
      this._drawQuad(ctx, d.img as CanvasImageSource, nat, quad);
      if (st.lineOpacity < 1) ctx.restore();
    } else {
      // 占位框的尺寸与朝向与真图**完全一致**（尺寸取自 data 里的自然像素，不依赖解码），
      // 所以图解码完就位时框不会跳一下
      if (nat.bad || !src) fillRing(ctx, quad, st.previewFill);
      const msg = !src || nat.bad ? '图片数据缺失'
        : d.kind === 'loading' ? '图片加载中…' : '图片加载失败';
      const c = this._screenPt({ x: g.cx, y: g.cy }, f);
      haloText(ctx, c.x, c.y, msg, {
        size: 12, fill: st.textColor, halo: st.haloColor, width: st.haloWidth,
      });
    }
    // 边框：**只在「这一条正被操作」时画**（选中 / 悬停）。
    // ★ 为什么不是像别的类型那样常驻（用户 2026-09-14 的口径：「添加的图片不显示边框，
    //   只有选中才显示」）：其它类型画的本来就是线 / 框，边框就是它自己；而图片是一整块
    //   内容，四周再常驻一圈线，等于在地图上多出一圈跟谁都无关的噪点。改大到「选中才出现」
    //   之后，框才回归它本来的意思 —— **选中标记**（和那三个顶点手柄是一套的东西）。
    // ★ 没有图可看的时候（加载中 / 加载失败 / 数据缺失）**必须照画**：那种状态下框就是
    //   这条图形的全部 —— 不画就成了「看不见却点得中」，比画错了还难查（见 _natural）。
    const active = d.kind !== 'ok' || this.isHovered(shape) || this.isFocused(shape);
    if (active) strokePolyline(ctx, box, st.pathColor, st.pathWidth, null, st.lineOpacity);
  }

  /**
   * 把图映射到（屏幕上的）四边形 —— **照片平铺地面**的贴图那一步。
   *
   * canvas 2D 只有仿射变换、没有透视贴图，所以做法是：把四边形沿对角线拆成两个三角形，
   * 各自「裁到这个三角形 + 解出它自己的仿射 + 画整张图」。两个三角形各有一份自己的
   * 仿射，拼起来就是那个四边形的近似透视（边界精确）。
   *
   * ★ 两个裁剪三角形各**从重心向外胀 0.5px**：不胀的话，两个三角形各自抗锯齿，对角线上
   *   会留下一条发丝似的缝（照片上很显眼）。胀出来的那一小圈在四边形外侧，肉眼看不出来。
   */
  private _drawQuad(
    ctx: CanvasRenderingContext2D, img: CanvasImageSource, nat: Natural, quad: ScreenPoint[],
  ): void {
    const [tr, tl, bl, br] = quad;               // 与 `_corners()` 的顺序一致
    const wn = nat.wn, hn = nat.hn;
    // 三角形一：左上 / 右上 / 左下（自然坐标 (0,0) / (wn,0) / (0,hn)）
    this._texTriangle(ctx, img, wn, hn, [tl, tr, bl], [[0, 0], [wn, 0], [0, hn]]);
    // 三角形二：右上 / 右下 / 左下（自然坐标 (wn,0) / (wn,hn) / (0,hn)）
    this._texTriangle(ctx, img, wn, hn, [tr, br, bl], [[wn, 0], [wn, hn], [0, hn]]);
  }

  /** 一个「纹理三角形」：裁到它（外胀 0.5px）+ 仿射映射整张图 */
  private _texTriangle(
    ctx: CanvasRenderingContext2D, img: CanvasImageSource, wn: number, hn: number,
    s: ScreenPoint[], t: number[][],
  ): void {
    // 外胀：三个顶点各沿「重心 → 顶点」方向推 0.5px
    const cx = (s[0].x + s[1].x + s[2].x) / 3, cy = (s[0].y + s[1].y + s[2].y) / 3;
    const grow = s.map((p) => {
      const dx = p.x - cx, dy = p.y - cy;
      const len = Math.hypot(dx, dy) || 1;
      return { x: p.x + (dx / len) * 0.5, y: p.y + (dy / len) * 0.5 };
    });
    // 仿射：自然点 t[0] → grow[0]、t[1] → grow[1]、t[2] → grow[2]
    const ax = t[1][0] - t[0][0], ay = t[1][1] - t[0][1];       // 自然 x 方向的增量
    const bx = t[2][0] - t[0][0], by = t[2][1] - t[0][1];       // 自然 y 方向的增量
    const det = ax * by - ay * bx;
    if (!det) return;
    // 解 2×2：屏幕增量 = M · 自然增量
    const m11 = ((grow[1].x - grow[0].x) * by - (grow[2].x - grow[0].x) * ay) / det;
    const m21 = ((grow[1].y - grow[0].y) * by - (grow[2].y - grow[0].y) * ay) / det;
    const m12 = (ax * (grow[2].x - grow[0].x) - bx * (grow[1].x - grow[0].x)) / det;
    const m22 = (ax * (grow[2].y - grow[0].y) - bx * (grow[1].y - grow[0].y)) / det;
    // 平移：让自然点 t[0] 落到 grow[0]
    const e = grow[0].x - (m11 * t[0][0] + m12 * t[0][1]);
    const fsh = grow[0].y - (m21 * t[0][0] + m22 * t[0][1]);

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(grow[0].x, grow[0].y);
    ctx.lineTo(grow[1].x, grow[1].y);
    ctx.lineTo(grow[2].x, grow[2].y);
    ctx.closePath();
    ctx.clip();
    ctx.transform(m11, m21, m12, m22, e, fsh);
    ctx.drawImage(img, 0, 0, wn, hn);
    ctx.restore();
  }

  /**
   * 命中：把光标变到图片的局部坐标里，判「面内即本体（外扩一圈容差）」——
   * 与圆 / 矩形 / 椭圆同一口径，于是整张图都可悬停变红、可拖着平移。
   */
  hitTest(shape: Shape, x: number, y: number, Pts: ScreenPoint[], tol: number): boolean | undefined {
    if (Pts.length !== 3) return undefined;      // 形态超出预期 → 交回默认规则
    const nat = this._natural(shape);
    const f = this.groundFrameAt(shape.pts[0][1]);
    const g = this._geom(shape.pts, nat);
    if (!g) return false;                        // 画不出来，也就不该被点中
    // ★ 几何在平面里，光标是屏幕坐标 ⇒ 先把光标折到同一平面再比
    const p = this._planeOf(x, y, f);
    if (!p) return false;                        // 拿不到地图：这一帧点不中
    const dx = p.x - g.cx, dy = p.y - g.cy;
    const du = dx * g.ux + dy * g.uy;
    const dn = dx * g.nx + dy * g.ny;
    return Math.abs(du) <= g.w / 2 + tol && Math.abs(dn) <= g.h / 2 + tol;
  }

  /**
   * 剔除边距：取**外接圆**半径（半对角线）+ 线宽那一档。
   *
   * ★ 图片的四个角会甩到「存储顶点包围盒」之外（存储的只是一条对角线上的两个角），
   *   而投影（尤其带倾斜）不会把长度放大，所以「外接圆」是最省事、也一定盖得住的一档
   *   —— 与 `_corners()` 画出来的四边形是同一套尺度（几何在地面平面上，比例只由
   *   zoom 与纬度定）。
   */
  cullMargin(shape: Shape): number {
    const g = this._geom(shape.pts, this._natural(shape));
    if (!g) return 0;
    const st = this.styleFor(shape);
    return Math.hypot(g.w, g.h) / 2 + (st.pathWidth || 0) / 2 + 2;
  }

  /**
   * 列表行描述：**只报尺寸**，绝不打印图片本体 —— data URL 是几 MB 的字符串，
   * 塞进列表行会让界面直接卡住。
   */
  describe(shape: Shape): string {
    const nat = this._natural(shape);
    const g = this._geom(shape.pts, nat);
    if (!g) return `${this.label} · 退化`;
    if (nat.bad || !this._src(shape)) return `${this.label} · 数据缺失`;
    // 两条轴各量一次：沿局部 x / y 从一边的中点走到另一边（图片是斜的，只能这么量）。
    // ★ 几何在地面平面上，轴端直接折回经纬再量米数（旧实现是拿屏幕坐标往返投影）
    const f = this.groundFrameAt(shape.pts[0][1]);
    const at = (dx: number, dy: number): LngLat =>
      fromPlane({ x: g.cx + dx, y: g.cy + dy }, f, 'down');
    const ax = (g.ux * g.w) / 2, ay = (g.uy * g.w) / 2;
    const bx = (g.nx * g.h) / 2, by = (g.ny * g.h) / 2;
    const W = gdM(at(-ax, -ay), at(ax, ay));
    const H = gdM(at(-bx, -by), at(bx, by));
    return `图片 · 宽 ${fmtM(W)} × 高 ${fmtM(H)}`;
  }

  /** 手绘预览：光标处一个落点记号 + 一个示意方框（真尺寸要选完图才知道） */
  preview(draw: DrawSession): void {
    const ctx = this.ctx, st = this.style;
    if (!ctx || !st) return;
    const at = draw.cursor ?? draw.pts[0];
    if (!at) return;
    const p = this.project(at);
    const half = PREVIEW_BOX / 2;
    strokePolyline(ctx, [
      { x: p.x - half, y: p.y - half }, { x: p.x + half, y: p.y - half },
      { x: p.x + half, y: p.y + half }, { x: p.x - half, y: p.y + half },
      { x: p.x - half, y: p.y - half },
    ], st.previewColor, 2, [4, 4]);
    drawDot(ctx, p.x, p.y, 4, st.previewColor);
  }

  /** 出图前要等的：图片还没解码完就等它（见 `exportImage` 的 `_waitAssetsReady`） */
  whenReady(shape: Shape): Promise<void> | null {
    const src = this._src(shape);
    return src ? whenDecoded(src) : null;
  }
}

/* 自注册：import 本文件即把类型收进静态注册表 */
MapboxSketch.registerType(ImageShape);
