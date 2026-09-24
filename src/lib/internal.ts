/* =====================================================================
 * internal.ts —— 引擎内部契约：宿主接口、品牌标识、运行时判定。
 *
 * 这里的东西**不是给普通使用者看的**，但对「自定义图形类型」的开发者是必要的：
 * 基类 MapboxShapeType 需要知道宿主（主类）提供哪些能力。
 *
 * 之所以不把宿主接口藏进主类文件，是为了打断循环依赖：
 *   sketch-shape-type.ts 需要「主类的形状」→ 只从本文件拿接口（纯类型，无运行时）
 *   sketch.ts 需要「基类的值」做 instanceof / 继承 → 从 sketch-shape-type.ts 拿
 * 由于本文件只导出类型 + 一个 Symbol（无任何 import），运行时依赖图是无环的。
 * ===================================================================== */
import type {
  DrawSession, LngLat, MapboxMap, PickImageResult, ScreenPoint, Shape, Style,
} from './types';

/**
 * 品牌标识：判断「一个值是不是图形类型实例」用。
 *
 * 为什么不直接用 `instanceof MapboxShapeType`：同一个包可能被**同时**以 ESM 和 CJS
 * 两种格式加载（例如宿主项目 ESM、某个插件 CJS），此时会有两份基类构造器，
 * 跨副本的 instanceof 一定为 false。改用全局注册表里的 Symbol 做鸭子判定，
 * 双副本下依然成立。
 *
 * 用 Symbol.for 而不是局部 Symbol：Symbol.for 走全局注册表，跨副本同名同值。
 */
export const SHAPE_TYPE_BRAND = Symbol.for('mapbox-sketch.shape-type');

/**
 * 主类暴露给「类型实例」的宿主能力。
 *
 * 带下划线前缀的字段是引擎私有状态：类型代码**可以读**（例如判断是否悬停），
 * 但不要写。日常开发请优先用基类上的公开访问器（`this.ctx` / `this.style` /
 * `this.map` / `this.project()` / `this.isHovered()`）。
 */
export interface SketchHost {
  /** @internal 当前 2d 上下文（已按 dpr 设好 CSS 像素坐标系）；绘制前可能为 null */
  _ctx: CanvasRenderingContext2D | null;
  /** @internal 全局基础样式表（只读使用） */
  _style: Style;
  /** @internal mapboxgl.Map 实例 */
  _map: MapboxMap | null;
  /** @internal 进行中的绘制会话；非绘制态为 null */
  _draw: DrawSession | null;
  /** @internal 编辑总开关（false = 纯浏览态，不选中、不出手柄、不悬停变色） */
  _editEnabled: boolean;
  /** @internal 当前悬停在「图形主体」上的图形 id */
  _hoverId: string | null;
  /** @internal 当前**选中**（点击聚焦）的图形 id；没有选中时为 null */
  _focused: string | null;
  /**
   * @internal 是否正在为出图而重渲染（`exportImage()` 期间为 true）。
   *
   * 出图要的是「干净的成品」：悬停高亮、顶点手柄、吸附记号、手绘预览这些
   * **编辑态装饰**都不该被画进图里。基类的 `isHovered()` 读它来判断，
   * 所以类型代码**不需要**为出图写任何分支。
   */
  _capturing: boolean;

  /**
   * @internal 宿主给的**选图回调**（`SketchOptions.pickImage`），没给时为 null。
   *
   * 库不碰文件 IO，所以「弹文件框、把图读成 data URL」那段只有宿主能做。
   * 类型代码请走基类的 `this.pickImage()`（它顺带把「宿主没给」变成一句明确的报错）。
   */
  _pickImage: (() => Promise<PickImageResult | null>) | null;

  /**
   * @internal 覆盖层画布的 CSS 像素尺寸（0 = 画布还没建好 / 已销毁）。
   *
   * 给「按视口大小定尺寸」的类型用（图片标注的落地尺寸不能大过画布短边的 1/3）。
   * 是 CSS 像素、不是设备像素 —— 与 `_ctx` 的坐标系一致，所以两个数才能直接比。
   */
  _cw: number;
  _ch: number;

  /**
   * 取该图形**存储顶点**的投影结果（同一帧内带缓存，重复调用不重复投影）。
   * 类型渲染时应优先用它，而不是自己 `shape.pts.map(p => this.map.project(p))`。
   */
  projectPts(shape: Shape): ScreenPoint[];

  /** 单点投影（不缓存，供临时点用） */
  project(ll: LngLat): ScreenPoint;

  /** 请求一次重绘（内部会合并到下一帧；测试里可用 render() 立即出图） */
  requestRender(): void;
}

/** 地图鼠标/触摸事件里我们真正用到的那几个字段（避免依赖 mapbox 的完整事件类型） */
export interface MapPointerEventLike {
  /** 光标所在的屏幕坐标（CSS 像素）；window 兜底事件上可能没有 */
  point?: ScreenPoint;
  lngLat: { lng: number; lat: number };
  /**
   * 原生事件上的少数字段；**一律当可选读**（window 兜底造的事件里可能没有）。
   *
   * `shiftKey` 只有「类型自算拖拽」那类增强在用（如图片标注按住 Shift 把旋转吸附到
   * 15° 网格），引擎自己的吸附只看 `altKey`。
   */
  originalEvent?: { button?: number; altKey?: boolean; shiftKey?: boolean };
  preventDefault?: () => void;
}
