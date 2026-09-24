/* =====================================================================
 * sketch-shape-type.ts —— 图形类型「抽象基类」MapboxShapeType。
 *
 * 主类 MapboxSketch 负责画布/事件/存储；每种「可绘制类型」（路径、多边形…）
 * 都继承本类，只实现自己那部分行为。子类里可用的东西：
 *   this.ctx         —— 当前 2d 上下文（已按 dpr 设好 CSS 像素坐标系）
 *   this.style       —— 全局样式表（只读）
 *   this.map         —— mapboxgl.Map 实例
 *   this.project(ll) —— 经纬度 → 屏幕坐标 {x,y}
 *   this.projectPts(shape) —— 存储顶点的投影（同帧内带缓存，优先用它）
 *   this.styleFor(shape)   —— 该图形「最终生效」的样式（全局 + 图形覆盖 + 悬停变色）
 *   this.isHovered(shape)  —— 该图形当前是否处于悬停/待拖拽高亮态
 *   this.isFocused(shape)  —— 该图形当前是否**选中**（「选中才显示」的装饰用它判断）
 *   this.hoverColor        —— 悬停高亮色（**全局项**，单图形覆盖不了它）
 *   math.* / paint.*       —— 公共几何工具与 canvas 原语
 * ===================================================================== */
import { DEFAULT_STYLE } from './constants';
import { fromPlane, groundFrameFor } from './ground-frame';
import { SHAPE_TYPE_BRAND } from './internal';
import { distToPolyline, pointInRing } from './math';
import type { GroundFrame, PlaneHanded } from './ground-frame';
import type { SketchHost } from './internal';
import type {
  CfgKey, CfgPatch, DragContext, DrawSession, GeomPatch, GeomState, LngLat, PickImageResult,
  PlaceContext, PlaceResult, ScreenPoint, Shape, Style, StylePatch,
} from './types';

/** 没有宿主时 styleFor 的兜底空样式（只读，不要改） */
const EMPTY_STYLE = {} as Style;

/**
 * 一种「可绘制图形类型」的统一骨架。
 * 继承它并实现 `key` / `render(shape)` 即可注册使用。
 */
export class MapboxShapeType {
  /**
   * 品牌标识：供 `isShapeType()` 做跨 ESM/CJS 副本的类型判定。
   * 子类会继承该字段，无需自己写。
   */
  readonly [SHAPE_TYPE_BRAND] = true as const;

  /** 宿主绘制工具实例（由 MapboxSketch.addType() 注入）；构造阶段可能为 null */
  draw: SketchHost | null;

  constructor(draw?: SketchHost | null) {
    this.draw = draw || null;
  }

  /* ---------------- 以下为「子类必须/通常要覆盖」的钩子 ---------------- */

  /** 类型唯一键（`tool.draw('xxx')` / `tool.push('xxx')` 用的字符串） */
  get key(): string {
    throw new Error('[MapboxShapeType] 子类必须实现 key 读取器');
  }

  /** 中文名（列表 / 提示文案用） */
  get label(): string { return this.key; }

  /** 完成绘制所需的最少落点数 */
  get minPts(): number { return 2; }

  /** 完成时是否自动「首尾闭合」成环（多边形 / 面类为 true） */
  get closesRing(): boolean { return false; }

  /** 落点数一旦达到 minPts 就【自动完成并退出绘制】？如「点」类型：单击一下即生成 */
  get autoCommit(): boolean { return false; }

  /**
   * 本类型是不是**自由手绘**（`false` = 默认的「逐点单击落点」）。
   *
   * 为 `true` 时，引擎把这条类型的整条绘制链路换成另一套手势 —— **两击一笔**：
   * **单击起点 → 移动鼠标描摹（一路按屏幕像素采样成顶点）→ 再单击一次完成**，
   * 全程不用按住鼠标。于是对这条类型：
   *   · 两次单击都由引擎接管（第一击起笔、第二击成图），**不是**「逐点落点」；
   *   · 双击 / 右键撤销同样不参与；
   *   · 起笔到收笔之间地图平移被锁住（否则描摹途中视野一动，笔迹上会多一道长跳）；
   *   · 起笔到收笔之间**不吸附** —— 手绘落点密、又跟着手走，吸附既没意义又把全表扫描
   *     拖进每个 mousemove；
   *   · 提示条该写「单击起点 → 移动 → 再单击完成」而不是「单击落点、双击完成」。
   *
   * 顶点由引擎按 `FREEHAND_MIN_PX` 的屏幕间距采样，**类型自己**可以在 `normalize()`
   * 里再做一次抽稀（两个内置的自由手绘类型走的是 `math.simplifyPolyline`，见
   * `shapes/free-line.ts`）—— 采样是「别漏掉手上的动作」，抽稀是「别存一堆没用的点」。
   *
   * 目前只有「自由线标注」与「自由面标注」两种类型用它。
   */
  get freehand(): boolean { return false; }

  /** 绘制提示条里的按键说明（可以是 HTML） */
  get hint(): string {
    return '单击地图依次落点；双击或回车完成；右键撤销上一点；Esc 取消。';
  }

  /** 该类型会用到的 cfg 键（决定 `tool.config()` 把哪些面板项应用到该图形） */
  cfgKeys(): CfgKey[] { return ['showLine']; }

  /**
   * 该类型专属的【默认配置】（可选）：push 新图形时叠加在全局默认配置之上。
   * 例如「引线标注」希望默认 text 是「引线标注」，而不是继承全局路径文字的默认文字。
   * 缺省返回空表，即全部跟随全局默认。
   */
  defaultCfg(): CfgPatch { return {}; }

  /**
   * 该类型专属的【默认样式】（可选）：叠加在全局基础样式之上、**早于**本图形自己的
   * 覆盖样式（合并顺序见 `styleFor()`）。
   *
   * 例如「图片标注」默认边框 2px / 不透明度 0.85 —— 全局那套（3px 实色）是给
   * 线、面定的，套在图片上边框太抢眼。与 `defaultCfg()` 同一套口径，**只作用于本类型**：
   * 既不改全局样式表，也不影响别的类型（别拿它去改全局默认，见 AGENTS.md 3.4）。
   * 缺省返回空表，即全部跟随全局默认。
   */
  defaultStyle(): StylePatch { return {}; }

  /** 完成落点后的可选二次整理（框架已先做去重/封口）；默认原样返回 */
  normalize(raw: LngLat[]): LngLat[] { return raw.slice(); }

  /** 渲染一个【已提交】的图形 */
  render(_shape: Shape): void {
    throw new Error('[MapboxShapeType] 子类必须实现 render(shape)');
  }

  /** 绘制进行中的预览（可选；默认不画） */
  preview(_draw: DrawSession): void { /* noop */ }

  /**
   * 可选覆盖：自定义「光标是否命中图形本体」。
   *
   * 默认返回 `undefined` = 交给主类按【存储顶点】判定（线距 / 闭合面内部 / 点体）。
   * 只有「存储顶点很少、却渲染出更多几何」的类型才需要实现它 —— 例如「引线标注」
   * 只存 1 个锚点，却渲染出锚点→折点→文字端两段线，不实现的话整条引线都点不中，
   * 也就无法悬停变色 / 拖主体平移。
   *
   * @param x,y  光标 CSS 像素
   * @param Pts  已投影好的存储顶点
   * @param tol  引擎按线宽算好的命中容差(px)
   * @returns true 命中 / false 未命中 / undefined 用引擎默认规则
   */
  hitTest(
    _shape: Shape, _x: number, _y: number, _Pts: ScreenPoint[], _tol: number,
  ): boolean | undefined {
    return undefined;
  }

  /**
   * 渲染内容可能超出「存储顶点包围盒」的像素数（可选，默认 0）。
   * 主类做视口剔除时会按它放宽边界 —— 否则引线、边中文字这类「画在顶点之外」
   * 的内容会在图形刚出屏时被误剔除。
   */
  cullMargin(_shape: Shape): number { return 0; }

  /** 「已绘图形」列表里的一句话描述（可选；缺省为 `中文名 · n 顶点`） */
  describe(shape: Shape): string {
    return `${this.label} · ${shape.pts.length} 顶点`;
  }

  /**
   * 可选：**异步落图**。实现了它的类型，单击地图时引擎调它、**单击不再直接落点**，
   * 顶点（以及该图形的私有数据）由它拿到后再交回来。
   *
   * ★ 它声明成**可选属性**而不是「返回 null 的空实现」：引擎靠「有没有这个方法」
   *   判断该走异步落图还是走原来的「落一个点 / 达到 minPts 就成交」。写成空实现的话，
   *   所有类型都会变成异步类型，单击落点的手感全没了。
   *
   * ★ 前面的 `declare` 是**必须**的：不带它时，`useDefineForClassFields` 一旦为真
   *   （target 升到 ES2022 就会自动变真），这行会编译成基类构造器里的
   *   `place = undefined`，把子类原型上的方法**盖住** —— 于是类型的 `place` 永远
   *   是 undefined、每次单击都退回「落一个点」，而且不报任何错。`declare` 让它
   *   纯属类型声明、不产生任何运行时代码。
   *
   * ★ 它声明成**属性**，所以子类也要用**属性**去实现（箭头函数字段），
   *   写成原型方法 `async place(ctx) {}` 会被 TS 判成两种成员（TS2425）。
   *   `declare` 的那一行是纯类型声明，子类的箭头函数字段照样是指到实例上的属性，
   *   引擎只看 `typeof t.place === 'function'`，两种形式它都认。
   *
   * 返回 `null` = 用户中途取消，引擎保持绘制态（还能再点一次）。
   */
  declare place?: (ctx: PlaceContext) => Promise<PlaceResult | null>;

  /**
   * 拖拽中由**类型自己**算几何（可选）。返回 `true` = 引擎不再写 `pts`，整件事交给类型。
   *
   * 默认 `false`（= 引擎的默认行为：顶点跟随光标、主体按**屏幕位移**整体搬），
   * 所以只有「默认那两下是错的」类型才需要覆盖它。
   *
   * ★ 主体平移那一路**不需要你操心**：引擎是先在屏幕上把各顶点整体挪同样的像素、
   *   再反算回经纬度的（`sketch.ts` 的 `_moveBodyByScreen`），所以图形跨纬度拖动
   *   不会因墨卡托的纬度非线性而变形。别在类型里再写一份「所有顶点同加一个经纬度差」——
   *   那正是被换掉的老写法。
   */
  dragTo(_ctx: DragContext): boolean { return false; }

  /**
   * 本图形还有没有**异步资源没就绪**（可选；`exportImage()` 出图前会 `await`）。
   * 默认 `null` = 已就绪、不用等 —— 没有异步资源的类型因此**一次都不用改**。
   */
  whenReady(_shape: Shape): Promise<void> | null { return null; }

  /**
   * 光标压在**第 `vi` 个顶点手柄**上时该显示什么鼠标样式（可选，返回 CSS `cursor` 值）。
   *
   * 默认 `null` = 引擎什么都不特别显示（保持默认箭头）—— 与不实现这个方法完全一致。
   *
   * ★ 为什么这件事得由类型说了算：引擎只看得见「第 i 个顶点」，而那个顶点在手柄
   *   语义上是「转」还是「改大小」是类型的事。图片标注就是现成的例子：2 号顶点是
   *   旋转柄（要转圈箭头）、0/1 号是等比缩放角（要双向箭头，还得跟着图片朝向转）。
   *   现成的两款在 `cursors.ts`：`rotateCursor()` / `scaleCursor(角度)`，都可以直接用。
   *
   * ★ 拖动期间也会问（每帧一次），所以这里**只该做纯计算**：不要在里面写状态、
   *   发请求、或者依赖「上一次调用」—— 它跟 `render()` 一样是随时会被叫的。
   *
   * @param shape 该图形（几何自己用 `this.projectPts(shape)` 取）
   * @param vi    顶点下标，`>= 0`（引擎只在压着手柄时问；压在本体上是另一条路）
   */
  vertexCursor(_shape: Shape, _vi: number): string | null { return null; }

  /**
   * 可选：本图形**自己画顶点手柄**（返回 `true` = 引擎不再画那圈通用白点）。
   *
   * 引擎默认给每个顶点画一个「白芯 + 橙圈」的小圆点 —— 那是「这儿有个手柄」的最低限度
   * 提示，但**说不出这个手柄是干什么的**。图片标注三个手柄要干两件不同的事（转、改大小），
   * 于是它用这个钩子把三个手柄画成图标（转圈箭头 / 双向箭头），一眼就能对上要拖哪个
   * （用户 2026-09-14 提的）。图标的现成两支在 `paint.ts`：`rotateHandleIcon()` /
   * `scaleHandleIcon()`，第三方类型可以直接用。
   *
   * ★ 只对**当前聚焦**的那条图形调用，且只在编辑态、非绘制中、非出图时
   *   （跟引擎画手柄的时机完全一致）—— 不用自己判这些条件。
   * ★ 画在**世界坐标**里（与 `render()` 同一个坐标系；画布左上角为原点），
   *   第 i 支手柄的位置请用 `this.handles(shape)[i]` 取 —— 那正是引擎判定
   *   「点着了哪个手柄」用的点，两边必须是同一处，否则会「看着有手柄、拖不动」。
   * ★ 返回 `true` 之后引擎**不会**再补那圈白点：宁可图标画得简单，也别让白点压在上面。
   *   （形态算不出来时应当返回 `false`，把通用白点让给引擎 —— 手柄总得抓得着。）
   * ★ 压在某一支上时，**那一支要画成激活态**：`hoverVi` 就是引擎给的「此刻压着第几个
   *   顶点」（不属于本图形时为 `-1`）。不区分的话，鼠标挪到控制点上一点反应都没有 ——
   *   用户 2026-09-14 报的正是这件事。`paint.ts` 那两支图标都收 `active` 参数。
   *
   * @param hoverVi 光标压着的顶点下标（`-1` = 没压着）
   */
  drawHandles(_shape: Shape, _hoverVi: number): boolean { return false; }

  /**
   * 各支手柄的**屏幕位置**：引擎的命中检测、悬停判定、通用白点都按这份点列走。
   * 缺省 = 「一个存储顶点一支手柄」（`projectPts(shape)`）—— 绝大多数类型就是这样。
   *
   * ★ 允许**比 `pts` 长**：多出来的那些是**派生手柄** —— 位置由几何算出来的、
   *   并不存在对应顶点的抓点（图片标注四个角上都有缩放柄，可它只存两个角）。
   *   规则很直白：**下标 ≥ `pts.length` 的就是派生手柄**。引擎不会替它写顶点
   *   （那个下标没有对应的 `pts`），拖它必须由 `dragTo()` 自己处理；
   *   只实现 `handles()` 而不实现 `dragTo()` 的话，那几支手柄看着在、拖着不动
   *   （引擎会在按下去时 `onWarn` 说一句，别让它静悄悄地失败）。
   * ★ 每帧会被问一次（命中扫描 + 画手柄），里面只该做纯计算；算不出手柄时
   *   返回 `projectPts(shape)` 就好 —— 那时手柄抓不着，比没有手柄更糟。
   */
  handles(shape: Shape): ScreenPoint[] { return this.projectPts(shape); }

  /**
   * 可选：读这条图形的**几何参数**（面板上的「旋转角度 / 尺寸」这类控件回显用）。
   *
   * 返回 `null` = 这个类型没有「可调几何」这回事（点 / 线 / 面 / 文字类都没有），
   * 宿主面板据此整组不列。形态退化（算不出几何）时同样返回 `null` ——
   * 那时给出控件也没有东西可调。
   */
  readGeom(_shape: Shape): GeomState | null { return null; }

  /**
   * 可选：按**几何参数**改这条图形（面板上敲一个数 / 拖一下滑块走这里）。
   *
   * ★ 与 `dragTo` 的分工：那条路是「光标拖到哪」的连续几何，这条是「面板上给一个数」
   *   的离散几何 —— 算的是同一件事，所以**内部该共用同一份算式**（图片标注就是共用
   *   `_verts()`，免得两条路各写一份、迟早跑偏成「拖出来的和调出来的不一样」）。
   *
   * @param patch 只包含要改的那几项（见 `GeomPatch`）；没给的保持现状
   * @returns 真的改了才返回 `true` —— 引擎据此决定重绘与通知宿主。没改动也返回 true 的话，
   *          面板每敲一下就会白重绘一帧、白通知一次宿主。
   */
  writeGeom(_shape: Shape, _patch: GeomPatch): boolean { return false; }

  /* ---------------- 便捷访问器（子类内部用） ---------------- */

  /** 当前 2d 上下文；尚未建好时（或已 destroy）为 null */
  get ctx(): CanvasRenderingContext2D | null {
    return this.draw ? this.draw._ctx : null;
  }

  /** 全局样式表（**只读**；要按图形取色请用 styleFor） */
  get style(): Style | null {
    return this.draw ? this.draw._style : null;
  }

  /**
   * 悬停高亮色（画悬停反馈用，如点的虚线圆、引线的锚点圆点）。
   *
   * ★ **只读全局样式表**，和 `previewColor` / `snapColor` 那几个全局项同一口径：
   *   悬停高亮是「交互反馈」，不是某条标注的外观 —— 给它 `applyStyle({ hoverColor })`
   *   是**静默无效**的（本仓库对全局项的一贯做法：键存进 `shape.style`，但永不读）。
   *   想让所有标注的悬停反馈换个颜色，走 `tool.setStyle({ hoverColor })`。
   *
   * 之所以收成这一个 getter：悬停色有三处消费点（这里的 `styleFor`、点、引线），
   * 分散写的话「到底从哪读」就有三份，迟早会漏改一处。
   */
  get hoverColor(): string {
    return (this.draw ? this.draw._style.hoverColor : '') || DEFAULT_STYLE.hoverColor;
  }

  /** mapboxgl.Map 实例 */
  get map(): SketchHost['_map'] {
    return this.draw ? this.draw._map : null;
  }

  /**
   * 取某个纬度上的**地面平面**（见 `ground-frame.ts`）。
   *
   * 标绘库搬过来的那批算法（箭头一族 / 弓形面 / 弧线 / 集结地 / 闭合曲面）原本跑在
   * 屏幕坐标里，地图一倾斜 / 旋转，同样的地理跨度在屏幕上的像素差就变了、形状跟着漂
   * （用户 2026-09-18 报的问题）。走本方法的类型统一改成：**顶点先换算到地面平面 →
   * 跑原算法 → 结果再折回经纬、逐点投影**，这样倾斜 / 旋转不会改变平面几何。
   *
   * 典型写法：
   * ```ts
   * const f = this.groundFrameAt(geo[0][1]);
   * const out = algorithm(toPlane(geo, f));                    // 原算式一个字不动
   * const ring = out.map((p) => this.project(fromPlane(p, f))); // 平面 → 经纬 → 屏幕
   * ```
   *
   * @param lat 定平面比例尺的纬度，一般取图形第一个顶点
   */
  protected groundFrameAt(lat: number): GroundFrame {
    return groundFrameFor(this.map, (ll) => this.project(ll), lat);
  }

  /** 地面平面点列 → 屏幕点列（`groundFrameAt` 的配套，省得每处都写一遍 map） */
  protected planeToScreen(
    pts: ScreenPoint[], f: GroundFrame, handed: PlaneHanded = 'up',
  ): ScreenPoint[] {
    return pts.map((p) => this.project(fromPlane(p, f, handed)));
  }

  /** `styleDefaults` 的缓存槽：`undefined` = 还没算过 */
  private _defStyle: StylePatch | null | undefined;

  /**
   * `defaultStyle()` 的**缓存版**（`null` = 本类型没设默认样式）。
   *
   * 之所以要缓存：`render()` 每帧对每条图形都要走一次 `styleFor()`，现算一张新表的话
   * 5000 条图形就是每秒几十万个临时对象（同 `style` / `styleFor` 那两处省复制的口径）。
   * 空表一律归一成 `null`，调用方一句 `Object.assign({}, base, dflt, override)` 就能用。
   */
  get styleDefaults(): StylePatch | null {
    if (this._defStyle === undefined) {
      const p = this.defaultStyle();
      this._defStyle = p && Object.keys(p).length > 0 ? p : null;   // ★ 只读共享引用，勿改
    }
    return this._defStyle;
  }

  /**
   * 取【某一张图形】最终要用的样式，合并顺序（后写的赢）：
   *   全局基础样式 → **本类型专属默认**（`defaultStyle()`）→ 该图形自己的覆盖 → 悬停高亮。
   * `render(shape)` 里应当用它而不是 `this.style`，
   * 这样同一类型的不同图形可以各自有不同颜色。
   *
   * ★ 悬停高亮染的是 `pathColor`，而颜色取自**全局样式表**（`this.hoverColor`）——
   *   它是全局项，单条图形覆盖不了它。
   *
   * ★ 返回值在「该图形没有样式覆盖、本类型没有默认样式、且未被悬停」时是**全局样式
   *   对象本身**（为省掉每个图形每帧一次 Object.assign）。调用方**只读**，不要写它。
   */
  styleFor(shape: Shape | null): Style {
    const base = (this.draw ? this.draw._style : null) || EMPTY_STYLE;
    const hovered = this.isHovered(shape);
    const override = shape ? shape.style : null;
    const dflt = this.styleDefaults;
    // `Object.assign` 会跳过 null / undefined，所以这里不用为「没默认样式」再分一支
    if (!override && !hovered && !dflt) return base;      // ★ 只读共享引用，勿改
    const st: Style = Object.assign({}, base, dflt, override);
    // ★ 用 getter 而不是 `st.hoverColor`：后者是「全局 + 本图形覆盖」合并出来的，
    //   而悬停色是全局项，不能让某条图形的覆盖把它改掉
    if (hovered) st.pathColor = this.hoverColor;
    return st;
  }

  /**
   * 该图形当前是否处于「悬停 / 待拖拽」高亮态（类型内部画提示用）。
   *
   * 收口了原来散落在各类型里的 `this.draw._editEnabled && !this.draw._draw
   * && this.draw._hoverId === shape.id` 判断；主类私有字段的读法只在这两个
   * 访问器里（本方法与下面的 `isFocused`）。
   */
  isHovered(shape: Shape | null): boolean {
    const d = this.draw;
    if (!d || !shape) return false;
    // 出图期间一律「没悬停」：成品里不该出现那层临时的高亮色（见 SketchHost._capturing）
    if (d._capturing) return false;
    return !!(d._editEnabled && !d._draw && d._hoverId === shape.id);
  }

  /**
   * 该图形当前是不是**被选中的那一条**（点过它 → 引擎聚焦它、右侧面板显示它的样式）。
   *
   * 给「选中才显示」的编辑期装饰用：图片标注的边框就是这么定的（静态时是一整块内容，
   * 再套一圈线只是在底图上添噪点，`ShapesImage.render` 里那段有完整口径）。
   *
   * ★ 与 `isHovered` 同一条规矩：**出图期间一律算「没选中」**。选中态是「此刻你在
   *   操作什么」，不是「这张图上有什么」—— 出图时鼠标恰好停在那条图形上，成品里
   *   就会多出一圈只在编辑态才该有的线（同 `_capturing` 挡住手柄与悬停色的理由）。
   */
  isFocused(shape: Shape | null): boolean {
    const d = this.draw;
    if (!d || !shape || d._capturing) return false;
    return d._focused === shape.id;
  }

  /** 经纬度 → 屏幕坐标（渲染前主类已确认 `map.project` 可用） */
  project(ll: LngLat): ScreenPoint {
    const m = this.map;
    if (!m) throw new Error('[MapboxShapeType] 宿主已销毁，无法投影。');
    return m.project(ll);
  }

  /**
   * 取该图形**存储顶点**的投影结果（同一帧内带缓存）。
   * 比 `shape.pts.map(p => this.project(p))` 快，且与主类的命中检测共用同一份结果。
   */
  projectPts(shape: Shape): ScreenPoint[] {
    return this.draw ? this.draw.projectPts(shape) : [];
  }

  /** 请求一次重绘（会合并到下一帧） */
  requestRender(): void {
    if (this.draw) this.draw.requestRender();
  }

  /**
   * 调**宿主**给的选图回调（`SketchOptions.pickImage`）—— 「图片标注」用。
   *
   * 宿主没提供时**抛错**而不是返回 null：null 的语义是「用户取消了、留在绘制态」，
   * 两者混在一起的话，宿主忘了配 `pickImage` 就变成「点地图什么也不发生」——
   * 那正是本仓库最想避免的那种「看着像坏了」的症状。抛出来则会被
   * `_placeAsync()` 接住、变成一句明确的 onWarn。
   */
  pickImage(): Promise<PickImageResult | null> {
    const f = this.draw ? this.draw._pickImage : null;
    if (!f) throw new Error('宿主没有提供 pickImage 回调，选不了图片。');
    return f();
  }
}

/**
 * 判定一个值是否是「图形类型实例」（跨 ESM/CJS 双副本依然可靠）。
 * 主类 addType 用它做校验，第三方也可用。
 */
export function isShapeType(v: unknown): v is MapboxShapeType {
  if (!v || typeof v !== 'object') return false;
  if ((v as any)[SHAPE_TYPE_BRAND] !== true) return false;
  // 光有品牌字段还不够，必须有可用的 key 与 render
  return typeof (v as any).key === 'string' && typeof (v as any).render === 'function';
}

/* ---------------- 供基类命中检测复用的默认规则 ---------------- */
/* 主类在类型的 hitTest 返回 undefined 时会走这里；类型自己实现 hitTest
   需要「内部或贴边」判定时也可以直接调。 */

/** 默认「线类」本体命中：光标到折线的距离在容差内 */
export function defaultLineHit(x: number, y: number, Pts: ScreenPoint[], tol: number): boolean {
  return distToPolyline(x, y, Pts, false) <= tol;
}

/** 默认「面类」本体命中：在环内部，或贴着环边 */
export function defaultRingHit(x: number, y: number, Pts: ScreenPoint[], tol: number): boolean {
  if (Pts.length >= 3 && pointInRing(x, y, Pts)) return true;
  return distToPolyline(x, y, Pts, true) <= tol;
}
