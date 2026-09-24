/* =====================================================================
 * types.ts —— 引擎对外公开的**全部类型契约**。
 *
 * 本文件只有类型声明，编译后不产生任何运行时代码。它是「库对使用者的承诺」：
 * 这里改一个键，就是一个潜在的破坏性变更。
 *
 * 只有 mapbox-gl 的类型是外部依赖，且必须写 `import type`——tsconfig 开了
 * verbatimModuleSyntax 强制这一点，保证构建产物里**没有** mapbox-gl 的运行时引用。
 * ===================================================================== */
import type { Map as MapboxMap } from 'mapbox-gl';
import type { ExportCell, ExportMargin, PaperSpec } from './export-image';

export type { MapboxMap };

/* ================================================================
 * 坐标
 * ================================================================ */

/** 经纬度坐标：[经度, 纬度]。顺序与 GeoJSON 一致（不是 [纬度, 经度]） */
export type LngLat = [number, number];

/** 屏幕坐标（CSS 像素，与 map.project 同坐标系） */
export interface ScreenPoint {
  x: number;
  y: number;
}

/** 轴对齐包围盒，用于视口剔除与命中粗筛 */
export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/* ================================================================
 * 样式
 * ================================================================ */

/** 密集刻度的相对位置：贴线上侧 / 横穿 / 贴线下侧 */
export type TickPos = 'top' | 'middle' | 'bottom';

/**
 * 线型（按行业制图 / CAD 惯例 + 预测行业约定扩展；dash 间距受 pathWidth 缩放，见 paint.lineDashFor）。
 * - 实线 solid：实测 / 实际（默认）
 * - 虚线 dashed：预测 / 预报（气象路径、交通预测、作战规划里最常见的「预测」线）
 * - 点线 dotted：估计 / 不确定 / 备选
 * - 点划线 dashDot：计划 / 规划 / 已排程（planned）
 * - 双点划线 dashDotDot：远期预测 / 工程图双点划线（phantom / 假想轮廓、相邻件轮廓）
 * - 长虚线 longDash：边界 / 施工线 / 规划路径（长划短隔，比虚线更粗犷）
 * - 短虚线 shortDash：断裂线（break line）/ 细虚线 / 辅助估计
 */
export type LineType =
  | 'solid' | 'dashed' | 'dotted' | 'dashDot'
  | 'dashDotDot' | 'longDash' | 'shortDash';

/**
 * 全局基础样式全集（21 个键，与 DEFAULT_STYLE 一一对应）。
 * 用 setStyle() 改全局基底，用 applyStyle() 覆盖单个图形。
 */
export interface Style {
  /** 路径线 / 多边形轮廓颜色 */
  pathColor: string;
  /** 轮廓线宽(px) */
  pathWidth: number;
  /** 轮廓不透明度 */
  lineOpacity: number;
  /** 线型：实线 / 虚线 / 点线 / 点划线（受 pathWidth 缩放） */
  lineType: LineType;
  /** 多边形面内淡填充 */
  polygonFill: string;
  /** 沿线文字 / 引线文字颜色 */
  textColor: string;
  /** 沿线文字字号(px) */
  textSize: number;
  /** 文字/标注白描边颜色 */
  haloColor: string;
  /**
   * 文字描边的宽度(px)；**0 = 不描边**。
   * 沿线文字 / 途经点短标注 / 引线文字 / 边长 / 面积 / 里程共用这一个键。
   */
  haloWidth: number;
  /**
   * 富文本标注的**整块背景底色**；出厂**纯白** `#ffffff`，**空串 = 不垫底**
   * （清空是「关掉」的意思，不是「透明」）。
   *
   * ★ 「整天标注的背景」不是「某一段的背景」：画的是一**整块矩形**
   *   （宽 = 最宽那一行、高 = 全部行高之和，四角按 `bgRadius` 圆），铺在**所有**字下面。
   *   要的正是「整条标注垫一块底板」这个效果 —— 每行各垫一条、宽度参差不齐的那种
   *   是**段级高亮**（`<bg=…>` 标签干的事），两者用途不同、互不干扰：
   *   段上写了 `<bg=#f00>` 就是在这块底板上再叠一条红色高亮条。
   *   （2026-09-20 用户口径：面板这一项是**整个标注**的背景，不是某个标签的。）
   *
   * ★ 只作用于「富文本标注」—— 别的类型要么本来就有一块面（面 / 气泡走 `polygonFill`），
   *   要么根本没有「一块文字块」这个概念。
   */
  bgColor: string;
  /**
   * 整块背景的**圆角半径**(px)；0 = 方角。
   *
   * ★ 它圆的是 `bgColor` 那一整块矩形，与段级 `<r=…>` 无关 —— 后者的圆角归段自己
   *   （见 `RichSegment.radius`）。没设 `bgColor` 时这个键白写（没有矩形可圆）。
   */
  bgRadius: number;
  /**
   * 边长 / 里程文字颜色（距离标注的累计里程、面积标注的每条边长）。
   * ★ 名字里的「顶点」是历史遗留：顶点圆点 2026-09 各类都不画了，这个键只作用于文字。
   */
  vertexColor: string;
  /** 「点」类型圆点填充色 */
  pointColor: string;
  /** 途经点短标注颜色 */
  nodeColor: string;
  /** 多边形中心「面积」文字颜色 */
  areaColor: string;
  /** 手绘预览（虚线/落点）颜色 */
  previewColor: string;
  /** 手绘多边形预览淡填充 */
  previewFill: string;
  /** 「点」类型圆点半径(px) */
  pointRadius: number;
  /** 密集刻度的相对位置（距离 / 面积标注用） */
  tickPos: TickPos;
  /**
   * 悬停在图形主体上时，本体线条临时染成的颜色。
   * 与 previewColor / previewFill / snapColor 一样是**全局**项：悬停高亮是交互反馈，
   * 不是某条标注的外观，所以 `applyStyle()` 给单个图形覆盖它不会有任何效果
   * （引擎读的是全局样式表，见 `MapboxShapeType.hoverColor`）。
   */
  hoverColor: string;
  /**
   * 手绘吸附命中时，提示记号的**填充色**（实心小圆点；那圈白描边是固定的，
   * 引擎为了让记号在卫星影像上不糊进背景才加的，不受本键控制）。
   * 与 previewColor / previewFill 一样是**全局**项：记号不属于任何一张图形，所以
   * `applyStyle()` 给单个图形覆盖它不会有任何效果（引擎读的是全局样式表）。
   */
  snapColor: string;
}

/** 样式键名 */
export type StyleKey = keyof Style;

/** 样式补丁：setStyle / applyStyle / 每图形覆盖都用它 */
export type StylePatch = Partial<Style>;

/* ================================================================
 * 绘制配置
 * ================================================================ */

/** 沿线文字的分布方式：平均铺满全线 / 紧凑自然字距 */
export type SpreadMode = 'spread' | 'tight';

/**
 * 默认绘制配置全集（8 个键，与 DEFAULT_CFG 一一对应）。
 * 每个图形最终拿到的 cfg 都是「全局默认 + 类型默认 + 本次显式传入」合并后的完整表。
 */
export interface Cfg {
  /** 路径沿线文字 / 引线标注文字（类型不同，含义不同） */
  text: string;
  /** 沿线文字分布方式（仅「路径文字」用） */
  spread: SpreadMode;
  /** 是否平滑曲线（仅「路径文字」用） */
  smooth: boolean;
  /** 是否画轮廓线（路径文字 / 面 / 面积标注用） */
  showLine: boolean;
  /** 是否画途经点短标注（「路径文字」用，需配合 nodes） */
  showNodes: boolean;
  /** 途经点标注文字数组（与各顶点一一对应） */
  nodes: string[];
  /** 引线标注：引线方向角度°（0~360 连续，顺时针：0=右 90=下 180=左 270=上） */
  angle: number;
  /** 引线标注：第一段引线长度(px) */
  len: number;
  /**
   * 是否画密集刻度（仅「距离标注 / 面积标注」读）。
   * 测量工具（MapboxSketchMeasure）创建实例时把它默认成 false —— 量算读数就在
   * 拐点 / 边中点旁，刻度只会把线弄毛；标注引擎保持出厂的 true。
   */
  ticks: boolean;
}

/** 配置键名（决定 config() 能把哪些面板项应用到某类型图形上） */
export type CfgKey = keyof Cfg;

/** 配置补丁：config() / 类型 defaultCfg() 用它 */
export type CfgPatch = Partial<Cfg>;

/* ================================================================
 * 富文本标注的行内样式（`rich-text.ts` 解析后的产物）
 * ================================================================ */

/**
 * 富文本里的一段文字 + 它自己的样式。
 *
 * ★ 那几个 `| null` 是**刻意的**：`null` 表示「这一段没有自己的值，跟随样式面板」
 *   （`textSize` / `textColor` / `radius`），而不是「透明 / 0 号字」—— 「没设」与
 *   「设成 0」是两件事，混成一个值就没法区分「跟随全局」和「用户真的要它看不见」。
 *
 *   ★ 只有 `bg` 的 `null` 不是「跟随面板」而是「**这一段不铺**」：面板上的 `bgColor`
 *     是**整条标注**的背景（一整块矩形，见 `Style.bgColor`），与段级高亮是两回事，
 *     所以段这一层没有「跟随面板」这个状态 —— 要么自己写了个色，要么没有。
 *
 * 这些值全部由 `cfg.text` 那一个字符串解析出来（`parseRichText`），所以**存档格式
 * 一个字节都不用改**：富文本标注的「富」只活在它自己的那段文字里。
 */
export interface RichSegment {
  /** 段内文字（不含标签） */
  text: string;
  /** 这一段自己的字号(px)；`null` = 用样式面板的 `textSize` */
  size: number | null;
  /** 这一段自己的字色；`null` = 用样式面板的 `textColor` */
  color: string | null;
  /** 加粗 */
  bold: boolean;
  /** 斜体 */
  italic: boolean;
  /** 下划线（canvas 没有文字装饰，是画出来的一条线） */
  underline: boolean;
  /**
   * 这一段自己的**高亮底色**：在字的下面铺一条色带。`null` = 这一段不铺。
   *
   * ★ 这是**段级高亮**，与样式面板那个 `bgColor`（整条标注的**一整块**背景）
   *   是两件事，互不干扰：面板的整块底色照铺，段上的这条色带叠在它上面。
   *   典型的段级用法：「一行里只有几个字高亮」（`<bg=#fff3bf>重点</>其余照旧`）。
   *
   * ★ `<bg=none>` 与「没写」解析出来都是 `null`（都不铺）—— 它存在的意义只在**嵌套**：
   *   `<bg=#f00>甲<bg=none>乙</>丙</>` 里用它把高亮「关到这儿为止」，闭掉内层之后
   *   丙又回到外层的红。解析器里 `undefined` 只用来区分「这个标签提没提 bg」
   *   （见 `rich-text.ts` 的 `TagAttrs`），落进段里就只是「有没有色」。
   */
  bg: string | null;
  /**
   * 这条色带的**圆角半径**(px)；`null` = 用 `BG_RADIUS`（出厂 4）。
   * 只在有底色时才有意义 —— 没有那块矩形，圆角无处可圆。
   */
  radius: number | null;
}

/** 富文本里的一行：若干段（`\n` 切出来的段落切分，空行是 `segs: []`） */
export interface RichLine {
  segs: RichSegment[];
}

/* ================================================================
 * 图形
 * ================================================================ */

/**
 * 类型私有数据里的**单个值**：字符串或有限数字。
 *
 * 只认这两种标量是故意的 —— 它得能原样进出 JSON，导入时还要能逐值校验
 * （嵌套对象 / 数组 / null 一概不收，省得「文件里塞什么引擎都照单全收」）。
 */
export type ShapeDatum = string | number;

/**
 * 一个**已提交**的图形。
 * `style` 为 null 表示完全跟随全局样式；否则是叠在全局之上的覆盖表。
 */
export interface Shape {
  /** 图形 id（自动生成 `类型-序号`，也可 push 时手动指定）。一经创建不可变 */
  readonly id: string;
  /** 类型键，对应某个已注册的 MapboxShapeType.key */
  readonly type: string;
  /** 顶点经纬度（未闭合；面类型的首尾不重复） */
  pts: LngLat[];
  /** 该图形生效的完整绘制配置 */
  cfg: Cfg;
  /** 该图形自己的样式覆盖；null = 跟随全局 */
  style: StylePatch | null;
  /**
   * 是否隐藏（缺省 / `false` = 显示）。用 `tool.hide(id)` / `show(id)` 改。
   *
   * ★ 它是**图形数据**，所以放在 Shape 上而不是 `Cfg` 里：
   *   `Cfg` 的每个键都会被 `config()` 写进「全局默认」供新图形继承，隐藏混进去的话，
   *   一次 `config()` 就能让以后新建的图形全是隐藏的 —— 那是「画了半天什么也看不见」。
   *   放在这里则天然只属于这一个图形，改它也不碰任何默认值。
   *
   * 隐藏 = **完全退出交互**：不画、不悬停命中、不当吸附目标、不可拖。
   */
  hidden?: boolean;
  /**
   * **类型私有数据**（缺省 = 一条都没有）。键与含义由各类型自己约定，引擎不解释、
   * 只原样存取（`push()` 传入 → 导出 → 导入 → 再导出，一路照抄）。
   *
   * ★ 与 `hidden` 同一个理由放在 `Shape` 上而不是 `Cfg` 里：`Cfg` 的每个键都会被
   *   `config()` **不过滤**地写进「全局默认」供新图形继承。图片标注的图片本体
   *   （data URL）混进去的话，一次 `config()` 就能让以后新建的每条图片标注都带着
   *   上一张图 —— 那是「落点落出一张几百米外的旧图，文件还被顶到几百 MB」。
   *   放在这里则天然只属于这一个图形，改它也不碰任何默认值。
   */
  data?: Record<string, ShapeDatum>;
}

/* ================================================================
 * 数据文件（exportJSON / importJSON）
 * ================================================================ */

/**
 * 数据文件里的一条图形。**字段都是「可疑的」**：它来自一个可能被手改过的文件，
 * 导入时逐条校验，不合法就整条跳过（见 `ImportResult.warnings`）。
 *
 * 与 `Shape` 的差别只有两点：`id` 可缺省（冲突或缺失时自动分配），
 * `cfg` 可缺省（缺的键用**当前工具**的默认值补齐，同 `push()` 的合并口径）。
 */
export interface ShapeData {
  /** 缺省、非字符串、或与已有 id 冲突 → 自动分配新 id（换号会记进 warnings） */
  id?: string;
  /** 类型键。未注册的类型整条跳过 */
  type: string;
  /** 顶点经纬度。必须是有限的数字对，且不少于该类型的 minPts */
  pts: LngLat[];
  /** 只保留 `Cfg` 里认识的键 */
  cfg?: CfgPatch;
  /** 该图形的样式覆盖；空对象会被归一成 null（见 serialize.ts） */
  style?: StylePatch | null;
  /** 是否隐藏。缺省 = 显示 */
  hidden?: boolean;
  /** 类型私有数据（见 `Shape.data`）。非字符串 / 非有限数字的值会被丢掉并记进 warnings */
  data?: Record<string, ShapeDatum>;
}

/**
 * 导出 / 导入的文件外壳。
 *
 * `app` 与 `version` 是为了「一眼看出文件不对」和往后加字段时还有得判断：
 * `app` 写了就必须是 mapbox-sketch（写错了直接抛），`version` 高于当前引擎支持的
 * `SKETCH_DATA_VERSION` 也直接抛 —— 让新版本导出的文件在旧版本里静默丢字段，
 * 比报错难查得多。
 *
 * **全局基础样式必须装**（`style`，完整一份，跟出厂默认一样也照写）。
 * 理由是这类文件要能扛住版本升级：库以后改了出厂配色，老文件导回来也必须是
 * 当初那个样子 —— 没有覆盖过的图形跟随的正是这份全局样式，不带就等于把它们的
 * 颜色交给了「导入时那台机器的默认值」。
 *
 * 仍然不进文件的是**默认绘制配置**与**显示总开关**：每张图形的 `cfg` 都是完整的
 * （它自带全部配置，不依赖全局默认），而总开关是「这个页面此刻看不看标注」的视图
 * 状态，不是这份数据的一部分。
 */
export interface SketchData {
  /** 固定为 'mapbox-sketch'；缺省视为本工具的文件 */
  app?: string;
  /** 缺省视为 1 */
  version?: number;
  /** 全局基础样式（完整一份）。缺省 = 不动导入方的全局样式（v1 老文件就是这样） */
  style?: Style;
  shapes: ShapeData[];
}

/**
 * `importJSON()` 的结果。
 *
 * `added` / `skipped` 是给 UI 直接拼句子用的；`ids` 是给程序化跟进用的
 * （接着 focus / hide / applyStyle 那些刚进来的图形）—— 冗余是刻意的。
 * `added === ids.length`。
 */
export interface ImportResult {
  /** 成功入库的条数（id 被换过号的也算成功） */
  added: number;
  /** 整条跳过的条数（类型未注册 / 顶点不合法…） */
  skipped: number;
  /** 实际入库的 id，顺序同文件；被换过号的这里是**新**号 */
  ids: string[];
  /**
   * 逐条问题（未注册类型 / 顶点不合法 / id 被换号 / 某字段取值不合法…）。
   *
   * ★ 这些**不**走 `onWarn`：批量接口一次可能出几十条问题，而 `onWarn` 在宿主那边
   *   往往是「后写覆盖先写」的一行提示，刷屏之后只剩最后一条，反而看不清。
   *   怎么显示由调用方决定（demo 只展示前几条）。
   */
  warnings: string[];
  /**
   * 是否套用了文件里的**全局基础样式**。
   *
   * `true` 表示这份文件带来的配色跟本机当前的不一样、已经盖上去了 ——
   * 这会连带改变地图上**已有**图形里那些没有样式覆盖的脸色，所以值得说出来。
   * 文件里没带 `style`（v1 老文件 / 手写的）或跟本机本来一致时为 `false`。
   */
  styled: boolean;
}

/* ================================================================
 * 绘制会话（进行中的手绘）
 * ================================================================ */

/** 一次进行中的手绘状态。渲染预览时传给类型的 preview(draw) */
export interface DrawSession {
  /** 正在绘制的类型键 */
  type: string;
  /** 已落下的点 */
  pts: LngLat[];
  /** 橡皮筋端点的当前光标经纬度；光标从未移动过时为 null */
  cursor: LngLat | null;
}

/* ================================================================
 * 吸附（手绘落点时的自动对齐）
 * ================================================================ */

/** 吸附命中的来源：已有图形的顶点 / 已有图形的边线 / 当前图形自己的已落点 */
export type SnapKind = 'vertex' | 'edge' | 'self';

/**
 * 一次吸附的解析结果。
 *
 * 只存经纬度、**不存屏幕坐标**：地图一平移缩放，屏幕坐标就过期了，
 * 而经纬度不会。提示记号要画的时候再用 `project()` 现算屏幕位置。
 */
export interface SnapHit {
  /**
   * 吸到的是哪一类。**只作信息用**：画布上的提示记号三种来源长得一模一样
   * （蓝色实心小圆点 + 白描边），需要区分的是调用方自己（如做统计、写日志）。
   */
  kind: SnapKind;
  lngLat: LngLat;
}

/** 绘制吸附选项（`new MapboxSketch(map, { snap: {...} })`） */
export interface SnapOptions {
  /** 是否开启，默认 true（绘制中可按 Alt 临时关闭） */
  enabled?: boolean;
  /** 吸附半径（屏幕像素），默认 12 —— 屏幕量纲，缩放级别不影响手感 */
  tol?: number;
}

/* ================================================================
 * 测量（MapboxSketchMeasure）
 * ================================================================ */

/** 测量类型：测距 / 测面（`MapboxSketchMeasure.isMeasuring()` 的返回值） */
export type MeasureKind = 'distance' | 'area';

/* ================================================================
 * 类型钩子的契约（供写自定义类型时对照，不在运行时有约束力）
 * ================================================================ */

/**
 * 一次**异步落图**的上下文（`place` 钩子的入参）。
 * 图形以单击处为中心落地，所以这里只需要那一个点。
 */
export interface PlaceContext {
  /** 单击处的经纬度 */
  lngLat: LngLat;
  /** 单击处的屏幕坐标（画布已销毁等场合可能没有） */
  point?: ScreenPoint;
}

/** `place` 钩子的结果：顶点就绪，引擎据此落一条图形 */
export interface PlaceResult {
  /** 顶点经纬度；数量少于该类型的 `minPts` 会被引擎拒绝并提示 */
  pts: LngLat[];
  /** 该图形的私有数据（见 `Shape.data`） */
  data?: Record<string, ShapeDatum>;
}

/**
 * 一次拖拽的上下文（`dragTo` 钩子的入参），拖拽期间**每帧一次**。
 *
 * 给的都是「按下时的快照 + 光标当前位置」：类型自己算几何时**必须**从
 * `orig` / `start` 这些不动的基准推，不要拿上一帧的结果累加 ——
 * 地图投影不是线性的，累加会慢慢漂。
 */
export interface DragContext {
  /** 正在被拖的图形 */
  shape: Shape;
  /** 拖的是单个顶点还是整条主体 */
  kind: 'vertex' | 'body';
  /** 顶点下标；`kind === 'body'` 时为 -1 */
  vi: number;
  /** 光标当前位置（经纬度） */
  cursor: LngLat;
  /** 光标当前位置（屏幕坐标；没有 `point` 的事件上是 undefined） */
  point?: ScreenPoint;
  /** **按下时**的顶点快照（整体平移的基准）。**只读** —— 它是引擎的会话快照，改了会污染整次拖拽 */
  orig: LngLat[];
  /** **按下时**的光标经纬度 */
  start: LngLat;
  /** 是否按着 Alt（与引擎吸附同一口径：Alt = 临时关吸附） */
  alt: boolean;
  /** 是否按着 Shift（给类型做「15° 吸附」这类增强用） */
  shift: boolean;
}

/**
 * 可调的**几何参数**键（见 `GeomPatch` / `GeomState`）。
 *
 * ★ 与 `CfgKey` / `StyleKey` 是三套彼此独立的东西，别互相借：
 *   · 配置（cfg）管「这条标注**写什么**」—— 每个键都会被 `config()` 写进全局默认，
 *     好让下一个新图形继承（图片本体当初就是因此不能进 cfg，见 `Shape.data`）；
 *   · 样式（style）管「它**长什么样**」—— 能单图形覆盖、也能一键恢复跟随全局；
 *   · 几何（这里）管「它**此刻摆在哪儿 / 多大 / 多斜**」—— 每条图形各不相同，
 *     既不该被新图形继承，也不是外观，所以两者都不沾。
 */
export type GeomKey = 'rotateDeg' | 'sizePx';

/**
 * 一次几何调整（`tool.applyGeom()` / 类型的 `writeGeom()` 钩子）。
 *
 * 只给**要改的那几项**，没给的保持现状：哪些参数对这条图形有意义由类型自己定
 * （点 / 线 / 面没有「角度」「尺寸」这回事，也就不实现 `readGeom` / `writeGeom`；
 * 文字标注只有角度 —— 它没有可调的尺寸）。
 */
export interface GeomPatch {
  /** 旋转角度（度）：0 = **正放**，顺时针为正。口径与 `GeomState.rotateDeg` 完全相同 */
  rotateDeg?: number;
  /** 尺寸（屏幕像素）：等比图形给的是**长边**，短边按比例跟着走（见 `GeomState.sizePx`） */
  sizePx?: number;
}

/**
 * 一条图形当前的几何参数（`tool.getGeom()` / 类型的 `readGeom()` 钩子）。
 *
 * ★ 全是**屏幕量纲**，不是地理量纲：面板上那两个控件调的就是「你眼前看到的那张图」，
 *   拿经纬度 / 米去表达「转了 30°、缩到 200px」既绕又对不上用户的手感。
 *   代价是地图转了、缩放级别变了之后同一个图形的这两个数会变 —— 这正是屏幕量纲该有的样子。
 */
export interface GeomState {
  /**
   * 旋转角度（度）：0 = 正放（图形不带旋转地贴在屏幕上的样子），顺时针为正，
   * 取值落在 `[0, 360)`。
   */
  rotateDeg: number;
  /**
   * 尺寸（屏幕像素）：等比图形给的是**长边**的长度（短边按长宽比跟着走，
   * 所以一个数就说清了整块大小）。
   *
   * ★ **可选**：只有「尺寸本身可调」的类型才给这一项。目前的两种几何型图形里，
   *   图片标注给（旋转角度 + 尺寸），文字标注**不给** —— 文字的大小是样式键
   *   `textSize`，不是几何；同一个数两处可调只会让人不知道改的是哪个。
   *   读它的宿主按「`undefined` = 这条图形没有可调的尺寸」处理（面板据此不列那行）。
   */
  sizePx?: number;
}

/**
 * 一种绘制类型要实现的钩子清单。
 * 实际基类是 {@link MapboxShapeType}；本接口只作**文档型契约**，
 * 用 getter 混可选钩子的写法不适合用 implements 去约束。
 */
export interface ShapeTypeHooks {
  /** 类型唯一键 */
  readonly key: string;
  /** 中文名（列表/提示文案用） */
  readonly label: string;
  /** 完成绘制所需的最少落点数 */
  readonly minPts: number;
  /** 完成时是否自动首尾闭合（面类为 true） */
  readonly closesRing: boolean;
  /** 落点数达到 minPts 就自动完成并退出绘制（如「点」单击即成） */
  readonly autoCommit: boolean;
  /** 是否走**自由手绘**：单击起点 → 移动描摹采样成点 → 再单击完成（见 AGENTS.md「自由手绘」） */
  readonly freehand: boolean;
  /** 绘制提示条里的按键说明（可以是 HTML） */
  readonly hint: string;
  /** 该类型会用到的 cfg 键 */
  cfgKeys(): CfgKey[];
  /** 类型专属默认配置（可选） */
  defaultCfg?(): CfgPatch;
  /**
   * 类型专属默认样式（可选）：叠在全局基础样式之上、本图形自己的覆盖之下。
   * 只作用于本类型，不改全局样式表（层序见 `MapboxShapeType.styleFor()`）。
   */
  defaultStyle?(): StylePatch;
  /** 落点完成后的二次整理（可选；框架已先做去重/封口） */
  normalize?(raw: LngLat[]): LngLat[];
  /** 渲染一个已提交的图形 */
  render(shape: Shape): void;
  /** 绘制进行中的预览（可选） */
  preview?(draw: DrawSession): void;
  /**
   * 自定义「光标是否命中图形本体」（可选）。
   * 返回 true/false 即采用；返回 undefined 走引擎默认规则（线距/面内/点体）。
   * 只有「存储顶点很少、却渲染出更多几何」的类型才需要（如引线标注只存 1 个锚点）。
   */
  hitTest?(shape: Shape, x: number, y: number, Pts: ScreenPoint[], tol: number): boolean | undefined;
  /**
   * 各支手柄的屏幕位置（可选；缺省 = 一个存储顶点一支手柄）。允许返回**比 `pts` 长**：
   * 多出来的下标即**派生手柄**（图片标注四个角都有缩放柄，而它只存两个角）——
   * 引擎不会替它写顶点，拖它必须由 `dragTo()` 自己处理。
   */
  handles?(shape: Shape): ScreenPoint[];
  /** 列表行里的一句话描述（可选；缺省由引擎拼 `标签 · n 顶点`） */
  describe?(shape: Shape): string;
  /** 渲染内容可能超出「存储顶点包围盒」的像素数（可选；供视口剔除留安全边距） */
  cullMargin?(shape: Shape): number;
  /**
   * **异步落图**（可选）。实现了它的类型，单击地图时引擎调它、**单击不再直接落点**，
   * 由它自己（走宿主的 `pickImage` 之类）拿到需要的东西再给出顶点。
   *
   * 返回 `null` = 用户中途取消，引擎**保持绘制态**（可以再点一次）；
   * 抛错 = 引擎 `onWarn` 提示并保持绘制态。等待期间再点地图 / 按 Esc 都会被忽略。
   */
  place?(ctx: PlaceContext): Promise<PlaceResult | null>;
  /**
   * 拖拽中由**类型自己**算几何（可选）。返回 `true` = 引擎不再写 `pts`
   * （既不做「顶点跟随光标」也不做「整体平移」），整件事交给类型。
   *
   * 只有「引擎默认那两下是错的」类型才需要它 —— 图片标注拖角要保持长宽比，
   * 自由拉伸会把图拉变形，所以它在钩子里把光标投到等比对角线上再写回顶点。
   */
  dragTo?(ctx: DragContext): boolean;
  /**
   * 本图形还有没有**异步资源没就绪**（可选；典型是还没解码完的图片）。
   * `exportImage()` 出图前会 `await` 它，免得成品里是个占位框。
   *
   * 返回 `null` = 已就绪、不用等。没有异步资源的类型**别实现它**（实现了也必须
   * 在就绪时返回 `null`，而不是一个已 resolve 的 Promise —— 那会让每次出图都多等一个微任务）。
   */
  whenReady?(shape: Shape): Promise<void> | null;
  /**
   * 光标压在**第 `vi` 个顶点手柄**上时该显示什么鼠标样式（可选；返回 CSS `cursor` 值，
   * `null` = 不特别显示）。现成的两款在 `cursors.ts`：`rotateCursor()` / `scaleCursor(rad)`。
   *
   * ★ 这只是**锦上添花**的一路：Safari / Firefox 根本不画 SVG 光标，而指针本身也说不清
   *   那个手柄是「转」还是「改大小」。语义要靠 `drawHandles()` 画成图标一起说，
   *   两处必须是同一个方向（图片标注把方向角抽成了 `_diagAng()`，两边共用）；
   *   「正压着哪一支」的**可见反馈**也归 `drawHandles()`（那里的 `hoverVi` 参数）。
   */
  vertexCursor?(shape: Shape, vi: number): string | null;
  /**
   * 本图形**自己画顶点手柄**（可选）。返回 `true` = 引擎不再画它那圈通用白点，
   * 整件事交给类型 —— 图片标注用它把三个手柄画成「转圈箭头 / 双向箭头」两个图标：
   * 通用白点说不清哪个手柄是干什么的（画布上的 `paint.rotateHandleIcon` /
   * `paint.scaleHandleIcon` 就是现成的两支，第三方类型可以直接用）。
   *
   * ★ 手柄得**对鼠标有反应**：光标压在某一支上时，这一支要画成激活态，否则用户
   *   根本不知道自己有没有压在它上面（用户 2026-09-14 报的「鼠标移动上去没有效果」）。
   *   `hoverVi` 就是引擎告诉你的「此刻压着的是哪一支」，两个现成的图标都收这个参数；
   *   引擎自己那圈通用白点也会把压着的那一支填成橙色 —— 类型不实现本钩子同样有反馈。
   *
   * @param hoverVi 光标此刻压着的顶点下标（**属于本图形**才给，别的图形上压着手柄时
   *                这里是 `-1`）；没压着手柄时也一律 `-1`
   */
  drawHandles?(shape: Shape, hoverVi: number): boolean;
  /**
   * 读这条图形的**几何参数**（可选；`tool.getGeom()` 走它，给宿主面板回显用）。
   * 返回 `null` = 这个类型没有「可调几何」这回事（形态退化时也该返回 `null`）。
   */
  readGeom?(shape: Shape): GeomState | null;
  /**
   * 按**几何参数**改这条图形（可选；`tool.applyGeom()` 走它）。
   * 返回 `true` = 真的改了（引擎据此重绘并通知宿主）。没改就别返回 true ——
   * 否则面板每敲一下都会白重绘一帧、白通知一次宿主。坏值（NaN / 非正数）该当成
   * 「这一项没给」，而不是「改成一个坏值」。
   *
   * ★ 与 `dragTo()` 的分工：那条路是「光标拖到哪」的连续几何，这条是「面板上给一个数」
   *   的离散几何 —— 算的是同一件事，所以**内部该共用同一份算式**，否则迟早变成
   *   「拖出来的和面板上调出来的不一样」，而只有用户会发现。
   */
  writeGeom?(shape: Shape, patch: GeomPatch): boolean;
}

/**
 * 类型构造器：继承 MapboxShapeType 的子类（推荐），
 * 或用 `addType` 时直接传已实例化的对象。
 */
export type ShapeTypeCtor<T = unknown> = new (draw: any) => T;

/* ================================================================
 * 构造选项与回调
 * ================================================================ */

/**
 * `SketchOptions.pickImage` 的结果：一张选好的图片。
 *
 * `width` / `height` 要的是**图片本身的自然像素**（不是显示尺寸、也不是缩略图尺寸）：
 * 图片标注的长宽比按它算，且会跟着图形一起进数据文件 —— 不存它的话，
 * 导入方在图片还没解码完（或干脆解码失败）时几何就会静默变形。
 */
export interface PickImageResult {
  /** 图片本体。推荐 data URL（自包含，导出 JSON 能把它带上；见 `Shape.data`） */
  dataUrl: string;
  /** 自然宽度（原始像素） */
  width: number;
  /** 自然高度（原始像素） */
  height: number;
}

/** `new MapboxSketch(map, options)` 的选项 */
export interface SketchOptions {
  /** 初始样式，合并到 DEFAULT_STYLE 之上 */
  style?: StylePatch;
  /** 初始默认绘制配置，合并到 DEFAULT_CFG 之上 */
  defaultCfg?: CfgPatch;
  /** 内部状态每次变化后回调（增/删/聚焦/配置/绘制开关/拖拽结束），供外部 UI 同步 */
  onChange?: () => void;
  /** 非致命提示（如绘制点数不足），参数为字符串 */
  onWarn?: (msg: string) => void;
  /** 额外注入的自定义类型构造器（亦可在运行时 addType） */
  types?: ShapeTypeCtor[];
  /** 手绘落点吸附（引擎级能力，所有类型共用）；不传 = 开启 + 12px 容差 */
  snap?: SnapOptions;
  /**
   * 「图片标注」要用的**选图回调**：点击地图后由引擎调用，宿主负责弹文件框并读成 data URL。
   *
   * 库**不碰文件 IO、不碰 DOM 文件框**（零运行时依赖，要能进任何宿主），所以这段留在宿主：
   *
   * ```ts
   * new MapboxSketch(map, {
   *   pickImage: async () => {
   *     const file = await openFileDialog();      // 宿主自己的实现
   *     if (!file) return null;                   // 用户取消 → 引擎保持绘制态
   *     return { dataUrl, width, height };        // 自然像素尺寸
   *   },
   * });
   * ```
   *
   * 返回 `null` = 用户取消。不传时「图片标注」落不了图（会走 `onWarn` 提示一句）。
   */
  pickImage?: () => Promise<PickImageResult | null>;
  /**
   * `exportImage()` 用来**另建一张隐藏地图**的构造器（可选）。
   *
   * 库对 `mapbox-gl` 只 `import type`（零运行时依赖），所以没法自己 `new mapboxgl.Map`。
   * 不传时会退回 `map.constructor` —— 用宿主自己那份 mapbox-gl，通常就够了，
   * 连 `accessToken` 都是宿主已经设好的全局值。
   *
   * 什么时候需要显式给：宿主用的不是 `mapboxgl.Map` 本身（自己包了一层、或换过
   * 构造器），或者要给隐藏地图单独指定 token。实现就一行：
   *
   * ```ts
   * new MapboxSketch(map, {
   *   createMap: (o) => new mapboxgl.Map(o as mapboxgl.MapOptions),
   * });
   * ```
   */
  createMap?: (options: ExportMapOptions) => MapboxMap;
}

/* ================================================================
 * 图片导出（exportImage）
 * ================================================================ */

/** 导出流程走到哪一步了（`ExportProgress.phase`；宿主可以据此画步骤条） */
export type ExportPhase =
  /** 等屏幕上那张地图把底图下完 —— 既是「所见即所得」的前提，也是 `getStyle()` 能拿到完整样式的条件 */
  | 'waitVisible'
  /** 建那张离屏的同款地图 */
  | 'prepareMap'
  /** 等离屏地图把（更高 z 的）瓦片下完 —— **通常是最久的一步** */
  | 'waitTiles'
  /** 覆盖层按目标像素重渲染 + 底图与标注合成为一张 */
  | 'compose'
  /** 编码成 PNG / JPEG，并把 dpi 写进文件本体 */
  | 'encode';

/** 底图瓦片进度：已经下了多少块 / 一共多少块 */
export interface ExportTiles {
  loaded: number;
  total: number;
}

/**
 * `onProgress` 的第二个参数：进度**文案之外的**结构化信息（文案是给人看的，这个是给代码用的）。
 *
 * 想要「已下 45 / 68 块」这种**确定**进度条，就得读 `tiles`；它是**尽力而为**的 ——
 * 引擎数的是真·mapbox-gl 内部的瓦片表，宿主的替身地图、样式还没就绪、一块瓦片都还没
 * 请求时都给不出来（那时 `tiles` 是 `undefined`，进度条请退回「转圈 + 已等 N 秒」）。
 */
export interface ExportProgress {
  /** 当前这一步 */
  phase: ExportPhase;
  /**
   * 从调 `exportImage()` 到现在过了多久（ms）。
   *
   * ★ 文案里那个已等时长由它换算而来，但**格式化成中文了**（`42 秒` / `3 分 5 秒` /
   *   `1 小时 12 分`）—— 出图等待动辄几分钟，裸秒数得让人自己做除法。
   *   宿主想自己排版就退回这个毫秒数，**别去正则解析文案**。
   */
  elapsedMs: number;
  /**
   * 这一步在等底图时的瓦片进度；给不了时为 `undefined`。
   *
   * ★ `loaded === total` 的那一刻**就是**等待结束的那一刻：这里的口径与引擎等待的
   *   条件（mapbox 的 `Tile.loaded()`）是同一套，所以进度条走到 100% 与进入下一步
   *   是同一下 —— 不会出现「条满了可它还在等」。
   */
  tiles?: ExportTiles;
}

/**
 * `decorate` 回调拿到的几何（**单位全是输出像素**，宿主不要自己再乘 `dpi/96`）。
 *
 * 有了它，宿主画图廓整饰（图框 / 指北针 / 图例 / 图名）时一个减法都不用做 ——
 * 「我该画在哪」与「引擎把地图贴在哪」是同一个算式，不会差半个框。
 */
export interface ExportDecorateInfo {
  /** 整页输出像素宽（含四边外边距） */
  width: number;
  /** 整页输出像素高（含四边外边距） */
  height: number;
  /** 实际生效的 dpi（与 `ExportImageResult.dpi` 同值） */
  dpi: number;
  /** **输出像素 ÷ CSS 像素**的倍率（`= dpi / 96`）。装饰尺寸按屏幕像素设计时乘它 */
  scale: number;
  /** 地图区在整页画布上的矩形（输出像素、整数）。`x/y` 恒等于四边外边距 */
  map: { x: number; y: number; w: number; h: number };
  /** 四边外边距（输出像素、整数）：各边都是 `round(CSS 边距 × scale)` */
  margin: ExportMargin;
}

/**
 * `exportImage()` 的选项。
 *
 * ★ 这里**没有**「质量」这一项：JPEG 固定按质量 1 编码（见 `sketch.ts` 的 `JPEG_QUALITY`）。
 *   导出是拿去打印 / 汇报的，不该为了省体积在文字笔画和细线上留伪影，所以不留调节口。
 */
export interface ExportImageOptions {
  /** 图片格式，默认 `'png'`（带透明通道；`'jpeg'` 体积小但没有透明） */
  format?: 'png' | 'jpeg';
  /**
   * 目标打印分辨率，默认 96（= 屏幕上 1:1，所见即所得）。
   * 常用档位 96 / 150 / 200 / 300 —— 值与像素的比例是线性的：
   * 输出像素 = **取景范围** CSS 尺寸 × `dpi / 96`。
   */
  dpi?: number;
  /**
   * **纸张模式**：按打印纸出图，不给就是现在的「跟随视口」。
   *
   * `{ size: 'A4' }` = A4 纵向；`orientation: 'landscape'` 切横向。**取景范围**随之
   * 变成纸张折算出来的那一块（**纸上一毫米 = `96/25.4 ≈ 3.7795` 个屏幕 CSS 像素的
   * 地理范围**，与 `dpi` 无关 —— `dpi` 只决定这块范围被采样成多少像素）。
   *
   * 因为「屏幕上 1 CSS 像素对应多少米」逐像素不变，**视口所见不一定全进图**：
   * 窗口 16:9 而 A4 是 1:1.414，会切掉一截；反过来 A0/A1 比视口大，成品里会出现
   * 屏幕上看不到的区域。要「所见即所得」就别传它。
   *
   * 不认识的 `size` / `orientation` 一律当「没给」处理（退回跟随视口），不抛错。
   */
  paper?: PaperSpec | null;
  /**
   * **分块导出**：这次只要取景范围里的第几块（不给 = 整张不切）。
   *
   * 给 `{ col, row, cols, rows }` 就把取景范围**均分**成 `cols × rows` 格，导出这一格。
   * 用途只有一个：大纸（A0/A1）在高 dpi 下整张会撞浏览器的画布上限（单边约 16384、
   * 面积约 2.68 亿像素），切成小的每块都落在「稳定可出」的量级，**而每块本身就是一张
   * 完整的纸**（拿 `paperGrid()` 选块纸型，它按 A 系级数差算好行列数），拿去打印不用拼、
   * 也没有拼图接缝。
   *
   * 一份份自己拼 `col/row/cols/rows` 容易拼错，一般直接用 `planExportTiles()` 拿到
   * 逐块的规划，再把 `tile.cell` 传给这里。
   *
   * 脏值一律归一（份数至少 1、下标夹进范围内），不抛错。
   */
  cell?: ExportCell | null;
  /** JPEG 底色，默认 `'#ffffff'`（JPEG 没有透明通道，透明处会填成这个颜色） */
  background?: string;
  /**
   * 底图要不要按**高清**导出，默认 `true`（= 一直以来的行为）。
   *
   * ★ 高清是**拿时间换清晰度**：引擎会另建一张隐藏地图、把 zoom 抬高
   *   `log2(dpi/96)`，于是 mapbox 去抓**更深一级的瓦片** —— 300dpi 常常要另下一百多块，
   *   几秒到几分钟都正常（见 `exportImage()` 的「代价」那一段）。
   *
   * 传 `false` 就**跳过这一轮**：底图改用**屏幕上当前那一级**的瓦片放大
   *   （实现上是把每个瓦片源的 `maxzoom` 压到当前 zoom，让 mapbox 做 overzoom），
   *   于是那一等基本消失。代价是底图的详略度停在当前层级 ——
   *   栅格底图会发虚，矢量底图的注记仍清晰（overzoom 会重绘文字）但路网 / 面要素会变稀。
   *
   * ★ **只影响底图**：标注层始终按 `dpi/96` 真·重渲染，两种档位下一样清晰；
   *   输出尺寸、取景范围、分块规划、倾斜补偿也全都一模一样 —— 这个选项只改「底图从哪来」。
   *
   * ```ts
   * await tool.exportImage({ dpi: 300, hdBasemap: false });   // 快，底图停当前层级
   * ```
   */
  hdBasemap?: boolean;
  /**
   * 建隐藏地图前对**样式副本**做最后一次变换（在 `hdBasemap` 的 maxzoom 压制之后）。
   *
   * 背景：隐藏地图的机制是「容器放大 scale 倍 + zoom 抬 `log2(scale)`」——地理内容
   * 放大了，但 mapbox 样式里**屏幕像素单位**的值（`line-width` / `icon-size` /
   * `text-size` / `text-halo-width` / `circle-radius` …）与 zoom 无关，高 dpi 下
   * 不会跟着放大：宿主往样式里塞的矢量图层（专题页的线 / 点 / 文字标注就是）
   * 导出来会「线特别细、图标文字特别小」。给这个钩子把这些字段乘上 `dpi/96` 即可，
   * 96dpi（scale=1）时可以不传。
   *
   * ★ **必须返回新对象、不改入参**：`getStyle()` 是浅拷贝，样式对象与活地图内部
   *   共享（与 `capStyleSourceZoom` 同一条约定）——就地改会把活地图的底图也改了。
   *   只在浏览器主线程同步调用一次。
   * ★ 函数只应依赖 dpi / 纸张等**已进整张缓存指纹**的量：倾斜导出的整张隐藏地图
   *   按视角 + 样式 + dpi 做缓存，依赖别的外部状态可能把旧样式带进新图。
   */
  transformStyle?: <S extends object>(style: S) => S;
  /**
   * **图廓外边距**（CSS 像素）：在地图区外面留出一圈边，供专题图整饰用
   * （图框、白边、指北针、图例、图名）。不传 = 老行为（输出画布就是地图区，逐字节不变）。
   *
   * 给数字 = 四边同宽；给对象 = 逐边（缺的边按 0 算）。
   *
   * 两个后果，都是刻意的：
   *   · **输出画布变大**：`出图尺寸 = 地图区 + 四边外边距之和`（各边先乘 `dpi/96` 再取整），
   *     `ExportImageResult.width/height` 给的就是这个整页尺寸；
   *   · **会铺底**：外边距那圈没有地图内容，铺 `background`（默认 `#ffffff`）——
   *     与 JPEG 同一个道理，不铺就是一圈透明（PNG）或黑边（JPEG）。
   *
   * 取景范围、纸张换算、分块规划**全都不受影响**：外边距是在「已经出好的地图」外面加边，
   * 不是把取景范围放大 —— 所以「这张纸覆盖哪一块」那条口径一个字都没变。
   */
  margin?: number | Partial<ExportMargin>;
  /**
   * **整饰绘制回调**：地图贴完之后、编码之前调用一次，宿主在这里画图框 / 指北针 / 图例。
   *
   * 为什么要有它（而不是让宿主自己拿成品图再合成一张）：`canvas.toBlob()` 出来的图
   * **不带任何分辨率信息**，dpi 是引擎在编码前写进文件本体的（PNG `pHYs` / JPEG `JFIF`）。
   * 宿主自己合成就等于放弃了那一步 —— 打印出来排版还是 72dpi。这里给一个口子，
   * dpi 写入仍在引擎手上，宿主只管画。
   *
   * 回调参数里的几何全是**输出像素**、且已经算好（见 `ExportDecorateInfo`）：
   * 特别不要自己算 `dpi/96` —— 逐块导出时那套倍率由引擎统一给出，宿主抄一份必然有一天抄歪。
   *
   * ★ 回调抛错**会**让这次导出失败（错误原样抛给调用方）：整饰画不出来，这张图本来就是废的，
   *   静默吞掉只会让用户拿到一张缺图例的成品还以为没问题。与 `onProgress` 的口径不同 ——
   *   那个是「给你报个进度」，这个是「你在图上画东西」。
   */
  decorate?: (ctx: CanvasRenderingContext2D, info: ExportDecorateInfo) => void;
  /**
   * 进度回调（中文文案 + 结构化进度）。
   *
   * ★ 别把它当成可选的锦上添花：高清导出**不是瞬时的** —— 底图要在隐藏地图里
   * 重新下瓦片，几秒很正常。这几秒里宿主不给反馈，用起来就像点了没反应。
   *
   * 第二个参数 `info` 用来画**真的会动的**进度条（`info.tiles` 给得出时是确定的，
   * 给不出时退回不确定态）—— 只认第一个参数的旧代码一个字都不用改。
   *
   * ```ts
   * onProgress: (msg, info) => {
   *   bar.style.width = info.tiles ? `${info.tiles.loaded / info.tiles.total * 100}%` : '';
   *   label.textContent = msg;
   * }
   * ```
   */
  onProgress?: (msg: string, info: ExportProgress) => void;
}

/** `exportImage()` 的结果 */
export interface ExportImageResult {
  /** 图片数据。**dpi 元数据已经写进文件本体**（PNG `pHYs` / JPEG `JFIF`），
   *  所以下载下来丢进 Photoshop / Word，显示的就是 `dpi` 那个值，而不是 72。 */
  blob: Blob;
  /** 像素宽。传了 `margin` 时是**整页**宽（含四边外边距），否则就是地图区宽 */
  width: number;
  /** 像素高。口径同 `width` */
  height: number;
  /**
   * 地图区在整页画布上的矩形（输出像素）。**只在传了 `margin` 时给出** ——
   * 没传时地图区就是整张图，`{ x: 0, y: 0, w: width, h: height }` 没有信息量。
   * 宿主想把地图单独裁出来（或者要把 `decorate` 里画的坐标再对一次）读它。
   */
  mapRect?: { x: number; y: number; w: number; h: number };
  /** 实际生效的 dpi。**不夹取**，正常就等于请求值（请求值非法时退回 96） */
  dpi: number;
  /** 实际 MIME，如 `'image/png'` */
  mime: string;
  /**
   * 底图有没有真的画进来。`false` = 成品里**只有标注层**，底图是透明/空白的。
   * 出现这种情况通常是宿主的地图没有 `preserveDrawingBuffer: true`
   * （读不出画布内容），或者 `createMap` 给的构造器没能建出地图。
   */
  baseDrawn: boolean;
  /** 中文告警（尺寸被夹、底图读不回来…）；正常时为空数组 */
  warnings: string[];
}

/**
 * 建隐藏地图要传给 `createMap` 的选项集。
 *
 * 这是一份**最小**清单：里面的每一项都是为了「让隐藏地图和可见地图看到完全相同的地理
 * 范围、并且能可靠地读回像素」。实现方照着透传给自己的地图构造器即可
 * （`new mapboxgl.Map(o as mapboxgl.MapOptions)`）。
 */
export interface ExportMapOptions {
  /** 隐藏容器。已经设好 `取景范围 × scale` 的尺寸、`opacity:0`，挂在 body 上
   *  （跟随视口时取景范围就是视口；纸张模式是纸张折算出来、以视口中心为中心的那一块） */
  container: HTMLElement;
  /** 样式：直接取自可见地图的 `getStyle()`，保证底图长得一模一样 */
  style: ReturnType<MapboxMap['getStyle']>;
  /** 相机中心（与可见地图一致） */
  center: { lng: number; lat: number };
  /** 已补偿过的缩放级：`可见地图.zoom + log2(scale)` */
  zoom: number;
  bearing: number;
  pitch: number;
  /**
   * 已按 scale 同比例放大的内边距。
   *
   * ★ 纸张模式下**仍然是 `P × scale`，不要归零**：纸框之所以正好居中在容器上，
   *   靠的就是「padding 与容器同比例放大」这条 —— 归零会让有 padding 的宿主
   *   （左侧抽屉 / 图例预留）把纸框整体偏 `(P.左 − P.右) / 2`。推导见
   *   `sketch.ts` 的 `_createExportMap()`。
   */
  padding: { top: number; right: number; bottom: number; left: number };
  /** 已抬高过，防止补偿后的 zoom 被夹掉导致导出错位 */
  maxZoom: number;
  /** 恒为 true：**必须**开，否则读不回画布内容（成品里会只剩标注层） */
  preserveDrawingBuffer: true;
  interactive: false;
  attributionControl: false;
  /** 0 = 不做淡入，少等一会儿 */
  fadeDuration: 0;
  /** 从宿主地图上抄来的 token；拿不到时省略（用宿主已设的全局 token） */
  accessToken?: string;
}
