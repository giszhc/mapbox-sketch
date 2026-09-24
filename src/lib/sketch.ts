/* =====================================================================
 * sketch.ts —— MapboxSketch 主类（对外唯一入口）。
 *
 * 职责（只做「通用的事」，不知道任何具体图形长什么样）：
 *   · 地图 / 自建 canvas 覆盖层 / 事件生命周期
 *   · 图形存取：id 分配、push/remove/clear/focus/config/样式
 *   · 调度：每种图形的绘制全部交给「类型处理器」（见 src/lib/shapes/*）
 *   · 性能：rAF 合帧重绘、视口剔除、同帧投影缓存、指针命中节流
 *
 * 快速上手
 *   const tool = new MapboxSketch(map, { defaultCfg: { text: '长安北街 · 骑行路线' } });  // 不传则用出厂默认「路径文字」
 *   tool.push('path', [[116.36, 39.94], [116.37, 39.94]], { nodes: ['甲', '乙'] }, 'curve');
 *   tool.draw('path');           // 开启手绘（再调一次 tool.cancel() 取消）
 *   tool.remove('path-1');       // 按 id 移除
 *   tool.clear();                // 清空所有图形（工具保留）
 *   tool.setStyle({ textColor: '#fff' });
 *   tool.exportJSON();           // 图形数据 → JSON 文本（importJSON 反向，追加合并）
 *   await tool.exportImage({ dpi: 300 });  // 当前视口连底图带标注导成一张图（**异步**）
 *   tool.destroy();              // 整体销毁
 *
 * 出图那一条是本文件里唯一会**改渲染倍率与坐标系原点**的操作（否则拿不到高清标注层、
 * 也覆盖不了纸张那张框）：它只动自己那一个私有字段 `_capture`，可见地图的相机与尺寸
 * 一个字节都不碰，细节见 `exportImage()` 与 AGENTS.md 第 4 节。
 * ===================================================================== */
import { DEFAULT_CFG, DEFAULT_STYLE } from './constants';
import {
  BASE_DPI, applyJpegDpi, applyPngDpi, capStyleSourceZoom, frameFitsWorld, minZoomToFit,
  normalizeMargin, paperFrame, planDecorate, planExport, worldPxAt,
} from './export-image';
import type { ExportPlan } from './export-image';
import { bboxOf, distToPolyline, nearestOnSeg, pointInRing } from './math';
import { handleDot } from './paint';
import { registerType as registerTypeImpl, registeredTypes } from './registry';
import {
  idTakenWarning, parseSketchData, pickGlobalStyle, readShapeData, toSketchData,
} from './serialize';
import { MapboxShapeType, isShapeType } from './sketch-shape-type';
import type { ShapeTypeRegistrable } from './registry';
import type { MapPointerEventLike, SketchHost } from './internal';
import type {
  Cfg, CfgKey, CfgPatch, DragContext, DrawSession, ExportImageOptions, ExportImageResult,
  ExportMapOptions, ExportPhase, ExportProgress, ExportTiles, GeomPatch, GeomState, ImportResult,
  LngLat, MapboxMap, PickImageResult, ScreenPoint, Shape, ShapeDatum, SketchData, SketchOptions,
  SnapHit, Style, StylePatch,
} from './types';

/**
 * 吸附提示记号的半径(px)。
 * 比预览落点(5)还小一圈：记号是「贴在光标下面的一个小点」，大了会盖住它瞄准的位置。
 */
const SNAP_MARK_R = 4;

/** 顶点手柄的命中半径(px)：光标离顶点这么近就算「压在顶点上」（`_vertexAt` / 命中预筛共用） */
const PICK_HANDLE_TOL = 14;

/** 出图采样探底用的网格：4×4 个点（见 `exportImage` 里那一步） */
const EXPORT_PROBE_GRID = 4;

/**
 * 分块导出切到「整张渲染」路的俯仰角门槛（度）。
 *
 * 为什么有这道门槛、为什么整张是唯一正路 —— 2026-09-21 实测（真 mapbox-gl 3.22，
 * headless Chrome，1600×900 视口 / scale 3.125，每块采 25 个屏幕点）：
 *
 *   方案                          pitch 0     pitch 30    pitch 45
 *   块尺寸容器（逐块建地图，旧路）  0.13 px     96~325 px   96~694 px
 *   整张容器 + 裁块                0.25 px     0.25 px     0.25 px
 *
 * 成因：mapbox 的透视投影把**垂直 fov 定死、水平尺度交给容器宽高比**（`_calcMatrices`
 * 里 `getCameraToClipPerspective(fov, width/height)`），而相机距离 `∝ 容器高`。块容器的
 * 宽高比与视口不同 ⇒ 每块都是一个不同的相机 ⇒ 与整张的对应一格**系统性错位**；
 * pitch=0 时投影退化为各向同性线性缩放，与容器尺寸无关，才恰好精确。bearing 无影响。
 * 同理，**整张**容器（与可见地图同参数，只是同比例放大 + zoom 抬 log2）对任意
 * pitch/bearing 都精确 —— 所以倾斜时分块不能各自建地图，必须整张渲染后裁块。
 */
const TILE_TILT_EPS = 0.01;

/**
 * 倾斜分块「整张渲染」的画布像素上限。
 *
 * 浏览器画布的面积上限约 2.68 亿（2^28）像素；这条路要**同时**活三张画布
 * （整张底图 + 输出画布 + 覆盖层），所以留出余量取 1.5 亿：
 * A0 横 @300dpi 的 1.395 亿放得下，@600dpi 的 5.58 亿当场说清楚怎么办。
 */
const TILE_WHOLE_MAX_PIXELS = 150_000_000;

/**
 * 倾斜分块「整张渲染」的画布**单边**上限（px）。
 *
 * 浏览器对画布还有单边长度限制（各家 16384–65535 不等，取最保守的 16384 兜底）：
 * 面积没超但单边超了的长条形取景框同样建不出来，一并给明确报错。
 */
const TILE_WHOLE_MAX_SIDE = 16384;

/**
 * 「相机被 mapbox 拉回世界内」时要补回来的位移（**画布像素**，正 = 把画面往右下推）。
 *
 * 由来见 `_createExportMap` 里 `shift` 那一段：mapbox 的 `_constrain()` 会改掉我们申请的
 * 中心，画面内容于是整体偏了，合成时按这个位移平移回来即可（世界装得下取景范围时，
 * 平移是**精确**的逆操作）。
 */
interface ExportShift {
  dx: number;
  dy: number;
}

/**
 * 自由手绘的**采样间距**(px)：光标每挪这么远才记一个顶点。
 *
 * 屏幕量纲，与缩放级无关 —— 手绘的手感是「跟着手走」，不是「按地理精度记」。
 * 取 3px：放大到能看见单像素时仍是连续笔迹，缩小时也不会因为鼠标抖动而堆点。
 * 真正的「别存一堆没用的点」交给类型的 `normalize()`（`math.simplifyPolyline`），
 * 那一步是**事后**做的，这一步只负责别漏掉手上的动作。
 */
const FREEHAND_MIN_PX = 3;

/**
 * JPEG 出图质量：固定 1。
 *
 * ★ 别改成 0.9x 之类的「平衡值」，也别把它开成选项：浏览器 `toBlob('image/jpeg')`
 *   不传质量时**默认就是 0.92**，所以这里必须显式写 1 —— 导出的图是拿去打印 / 汇报的，
 *   省下的那点体积不值得在文字笔画和细线上留下块状伪影。
 */
const JPEG_QUALITY = 1;

/** 一次图形拖拽会话 */
interface DragSession {
  /** 拖顶点 / 拖整体 */
  kind: 'vertex' | 'body';
  id: string;
  /** 顶点下标；body 时为 -1 */
  vi: number;
  /** 按下时的经纬度（平移基准） */
  lng: number;
  lat: number;
  /** 按下时的顶点快照（整体平移的基准） */
  orig: LngLat[];
  /** 是否已越过 4px 阈值、真的开始拖了 */
  started: boolean;
}

/** 命中检测结果：图形 + 顶点下标（-1 = 命中主体而非顶点） */
interface PickResult {
  shape: Shape;
  vi: number;
}

/**
 * 出图期间的渲染态（见 `MapboxSketch._capture`）。
 *
 * `frame` 是**取景框**：这一次导出要覆盖的那块范围，按 CSS 像素、相对容器左上角。
 * 跟随视口时它是 `(0, 0, 容器宽, 容器高)`；纸张模式时是纸张折算出来的尺寸
 * （见 `export-image.ts` 的 `planExport()`），**可能比容器还大、也可能为负** ——
 * 那正是「纸比屏幕大」的常态（A0 横放在 1920 的窗口里 dx ≈ −1287）。
 */
interface CaptureState {
  /**
   * 顶替 `_dpr` 的渲染倍率 = **输出像素 ÷ 取景框 CSS 宽**（也就是 `dpi/96`，
   * 与 `planExport` 算 `outW/outH` 用的是同一个值 —— 于是覆盖层画布的物理像素数
   * 恒等于 `outW × outH`，不差一分）。
   */
  dpr: number;
  /** 取景框（CSS px，相对容器左上角） */
  frame: { x: number; y: number; w: number; h: number };
}

/** 屏幕包围盒（`math.bboxOf` 的返回类型，取非空那一支） */
type BBox = NonNullable<ReturnType<typeof bboxOf>>;

/**
 * 同帧投影缓存条目。
 *
 * 除顶点外**连包围盒一起存**：视口剔除、命中扫描、吸附预筛三处都要包围盒，
 * 各自再调一次 `bboxOf` 就是每图形每帧三次 O(顶点数) 的遍历 —— 存下来只算一次。
 */
interface ProjEntry {
  gen: number;
  pts: ScreenPoint[];
  bb: BBox | null;
}

/* ── 帧调度兜底：没有 rAF 的环境（SSR / 裸 node）退化为定时器 ── */
function scheduleFrame(cb: () => void): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(cb);
  return setTimeout(cb, 16) as unknown as number;
}
function cancelFrame(h: number): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(h);
  else clearTimeout(h as unknown as ReturnType<typeof setTimeout>);
}

/**
 * 从宿主地图上抄一份 access token，给隐藏地图用（拿不到就返回 undefined）。
 *
 * ★ 这**不是**主路径：走 `map.constructor` 兜底时，隐藏地图用的是宿主同一份
 *   mapbox-gl，「宿主的 `mapboxgl.accessToken = '…'` 全局值」本来就对它生效。
 *   只有宿主给地图单独设过 token（按实例而非全局）时才用得着这一份。
 *
 * `Map` 上没有公开的 token getter，值在内部 `RequestManager._customAccessToken`
 * 上（mapbox-gl.d.ts:16430）。这是内部字段，所以全程**当可选读**：
 * 拿不到就算了，绝不让它把导出搞挂。
 */
function readAccessToken(map: MapboxMap): string | undefined {
  const rm = (map as unknown as { _requestManager?: { _customAccessToken?: unknown } })._requestManager;
  const t = rm && rm._customAccessToken;
  return typeof t === 'string' && t ? t : undefined;
}

/**
 * 等待时长 → 给人看的中文（`42 秒` / `3 分 5 秒` / `1 小时 12 分`）。
 *
 * ★ 为什么非格式化不可：出图等待**动辄几分钟**，而「已等 300 秒」得在脑子里除一次 60
 *   才知道是五分钟 —— 这块本来就是在报「还要等多久」，不该让用户先做算术。
 *   一小时以上**丢掉秒**：到了那个量级，秒数既没人看、又让一个字一直跳，只是噪音。
 *
 * ★ 60 秒以下仍然只报秒，**别退回去补成「0 分 42 秒」**：绝大多数导出在两分钟内结束，
 *   那个区间里「42 秒」更短、也更直接（这条文案在遮罩上一行里挤着，见 demo）。
 */
function fmtElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec} 秒`;
  const m = Math.floor(sec / 60);
  if (m < 60) {
    const s = sec % 60;
    return s ? `${m} 分 ${s} 秒` : `${m} 分`;   // 整分钟不写「0 秒」
  }
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h} 小时 ${mm} 分` : `${h} 小时`;
}

/**
 * 地图标注绘制引擎。
 *
 * 构造后自动：建全屏 canvas 覆盖层、绑定地图/窗口/键盘事件、注册全部已注册类型。
 */
export class MapboxSketch implements SketchHost {
  /* ── 宿主机（SketchHost 契约；带下划线的是引擎私有状态，类型代码只读不改） ── */
  _map: MapboxMap | null;
  _ctx: CanvasRenderingContext2D | null = null;
  _style: Style;
  _draw: DrawSession | null = null;
  _editEnabled = true;
  _hoverId: string | null = null;
  /**
   * 光标**此刻压在哪一支顶点手柄**上；没压着手柄时为 null。
   * 与 `_hoverId`（压在图形本体上）是两条互补的路：手柄优先，压着手柄时 `_hoverId` 为 null
   * （见 `_updateHover`）。
   *
   * 之所以要单独记一份：手柄的**外观反馈**得知道「是哪一支」——
   * 类型画出来的手柄图标（`drawHandles(shape, hoverVi)`）与引擎那圈通用白点都靠它
   * 把正被压着的那一支画成激活态。少了它，鼠标挪到控制点上一点反应都没有
   * （用户 2026-09-14 报的）。
   */
  _hoverVertex: { id: string; vi: number } | null = null;
  /**
   * 当前**选中**（点击聚焦）的图形 id；没有选中时为 null。
   * 与 `_hoverId` 一样是「引擎私有状态，类型代码只读不改」—— 但基类里那个
   * `isFocused()` 要读它，所以它是 `_` 开头的公开字段而不是 `private`（同 `_hoverId`）。
   */
  _focused: string | null = null;
  _interactive = true;
  /** 宿主给的选图回调（图片标注用）；没给时为 null，见 `SketchHost._pickImage` */
  _pickImage: (() => Promise<PickImageResult | null>) | null = null;
  /**
   * **容器**的 CSS 像素尺寸（0 = 画布还没建好 / 已销毁）。
   * 图片标注按它算「落地尺寸不能超过画布短边 1/3」，见 `SketchHost._cw`。
   *
   * ★ 恒为容器尺寸，**不随出图取景框变**（引擎内部要「这次画到哪」的地方一律走
   *   `_viewX/_viewY/_viewW/_viewH`）。这里是给类型代码用的对外契约。
   */
  _cw = 0;
  _ch = 0;

  private _opts: SketchOptions | null;
  private _defaults: Cfg;
  private _shapes = new Map<string, Shape>();
  private _seq = 0;
  private _types = new Map<string, MapboxShapeType>();

  private _canvas: HTMLCanvasElement | null = null;
  private _dpr = 1;

  /* ── 出图（exportImage）── */
  /**
   * 出图期间的渲染态；平时是 null（= 屏幕态：倍率用 `_dpr`、原点在容器左上角）。
   *
   * 两件事**合在一个字段里**是刻意的：它们必须同生同死 —— 只有倍率没有取景框
   * （或反过来）会让「手柄按容器坐标画、图形按取景框坐标画」这种**静默错位**成为
   * 合法状态：不报错、不警告，只有肉眼能发现。合成一个对象后它不可表示。
   *
   * 为什么要「顶替」`_dpr` 而不是「乘上去」：出图要的是「覆盖层画布的像素数正好等于
   * 输出像素数」，即 `取景框宽 × 该倍率 === 目标像素宽`。直接把这个倍率**定**成
   * `目标像素 / 取景框 CSS 宽`，这个等式就是构造出来的，不必再去推 `target / dpr`
   * 那串除法（而 `_resize()` 里 `_dpr` 是现读 `window` 的，乘出来的值会随它漂）。
   */
  private _capture: CaptureState | null = null;
  /**
   * 是否正在出图（见 `SketchHost._capturing`）；同一时刻只允许一次导出。
   *
   * ★ 由 `_capture` 现推，**不是**一个独立字段 —— 见它那段注释：两个字段一旦能
   *   各自赋值，就多出「倍率已切、取景框没切」这种错位状态。
   */
  get _capturing(): boolean { return this._capture !== null; }
  /** 是否有导出正在进行（并发闸） */
  private _exporting = false;
  /**
   * 「整张渲染 + 裁块」的隐藏地图缓存（倾斜分块专用，见 `TILE_TILT_EPS` 的注释）。
   *
   * ★ 缓存的是**整张隐藏地图本身**（连同它的 holder）而不是画布：跨块复用的正是
   *   「底图瓦片都下好了」这件事 —— 每块重建一次等于把上百块高 z 瓦片重下 N 遍。
   * ★ key 里带**可见地图的视角与底图样式指纹**（见 `_wholeTileKey`）：视角一动、
   *   底图一换，下一次导出自动重建 —— 缓存只在「同一批分块、同一视角」里复用，
   *   不会把上一次的底图悄悄带进这一次的图里。导出失败、key 失配、`destroy()` 时释放。
   *
   * ★ 连 `shift` 一起缓存：它是**这一张整图**的内容位移（视角不变就恒等），裁每一块时
   *   都要用它，重建一次反而会白算一遍。
   */
  private _wholeTileCache: {
    key: string; map: MapboxMap; holder: HTMLElement; shift: ExportShift;
  } | null = null;

  /* ── 帧调度与缓存 ── */
  /** 已排队的一次合帧重绘句柄（0 = 没有排队） */
  private _raf = 0;
  /** 启动期的渐进渲染句柄（与 _raf 分开，免得 destroy 时互相踩） */
  private _initRaf = 0;
  /** 已排队的悬停检测句柄（0 = 没有排队） */
  private _hoverRaf = 0;
  /** 待处理的最近一次 mousemove（合帧用，只保留最后一个） */
  private _hoverEvt: MapPointerEventLike | null = null;
  /** 投影缓存代次：每次 render / 每次命中扫描自增，缓存随之失效 */
  private _projGen = 0;
  private _projCache = new WeakMap<Shape, ProjEntry>();

  /* ── 绘制吸附（引擎级：39 种「逐点落点」类型的落点共用同一条链路，见 _resolveSnap） ── */
  /** 本帧吸附到的目标；null = 没吸上（`_drawSnapHint` 凭它决定画不画记号） */
  private _snap: SnapHit | null = null;
  /** 吸附总开关（构造选项可关，运行时用 setSnap） */
  private _snapOn = true;
  /** 吸附半径（屏幕像素，默认 12）；只走构造选项，不做运行时改 */
  private _snapTol = 12;
  /** 已排队的吸附解析句柄（0 = 没有排队）。绘制态专用，与编辑态的 _hoverRaf 各管各的 */
  private _snapRaf = 0;
  /** 待处理的最近一次 mousemove（合帧用，只保留最后一个）；同上，绘制态专用 */
  private _snapEvt: MapPointerEventLike | null = null;

  /* ── 显示总开关 ── */
  /**
   * 全局「显示标注」总开关。**只影响画不画、点不点得中，从不写回任何 `shape.hidden`** ——
   * 关掉再打开，各图形回到各自原来的可见性，而不是被「洗」成全部可见。
   */
  private _visibleAll = true;

  /* ── 交互锁与会话 ── */
  private _zoomLocked = false;
  private _panLocked = false;
  private _drag: DragSession | null = null;
  /**
   * 正在进行中的**自由手绘**笔触（`null` = 此刻没有半途的笔迹）。
   *
   * 只有 `freehand` 类型会走到这里（见 `MapboxShapeType.freehand`）：**第一击起笔 →
   * 移动按 `FREEHAND_MIN_PX` 采样 → 第二击成图**（全程不用按住鼠标）。`last` 存的是
   * **上一次采到点的屏幕位置**，用来判「这一下挪够 3px 了吗」—— 不能拿 `_draw.pts`
   * 的末点现投影来比：那要多一次投影，而且地图在这期间是锁着不动的，没必要。
   */
  private _brush: { last: ScreenPoint } | null = null;
  /**
   * 是否正有一次**异步落图**在等（图片标注正弹着文件框）。
   *
   * 等待期间再点地图 / 按 Esc 一律忽略：系统文件框是模态的，可地图上的指针与键盘
   * 事件照样在来 —— 放进去就会多落一条，或者把绘制态关掉、让结果回来时无处安放。
   */
  private _picking = false;
  private _destroyed = false;
  private _handlers: Record<string, any> | null = null;

  /**
   * @param map   已加载的 mapbox 地图实例
   * @param options 见 {@link SketchOptions}
   */
  constructor(map: MapboxMap, options: SketchOptions = {}) {
    if (!map || typeof map.project !== 'function') {
      throw new Error('MapboxSketch 需要一个已加载完成的 mapboxgl.Map 实例。');
    }
    this._map = map;
    this._opts = options || {};
    this._pickImage = typeof options.pickImage === 'function' ? options.pickImage : null;

    // ---- 样式 / 默认配置 ----
    this._style = Object.assign({}, DEFAULT_STYLE, options.style || {});
    this._defaults = Object.assign({}, DEFAULT_CFG, options.defaultCfg || {});

    // ---- 绘制吸附（不传 = 开启 + 12px；字段初始值就是出厂默认，这里只覆盖显式给的） ----
    if (options.snap) {
      if (options.snap.enabled === false) this._snapOn = false;
      const tol = options.snap.tol;
      if (typeof tol === 'number' && isFinite(tol) && tol > 0) this._snapTol = tol;
    }

    // ---- 类型注册表：静态注册的（含各内置类型自注册的）+ options 注入的 ----
    ([] as any[]).concat(registeredTypes() as any, options.types || [])
      .forEach((T) => this.addType(T));

    // ---- canvas 覆盖层 / 事件 ----
    this._buildCanvas();
    this._bindEvents();
    this._scheduleInitialRenders();
  }

  /**
   * 静态注册一种类型（供「类型文件」自我注册）。
   * 注册后，之后创建的每个实例都会自动带上该类型。
   *
   * 同一个 key 重复注册时按「后注册者胜」替换（开发期 HMR 重载会走到这条分支）。
   */
  static registerType(Type: ShapeTypeRegistrable): void {
    registerTypeImpl(Type);
  }

  /** 当前注册表里的类型类（只读快照；调试/测试用） */
  static get registeredTypes(): readonly ShapeTypeRegistrable[] {
    return registeredTypes();
  }

  /* ================================================================
   * 公开 API
   * ================================================================ */

  /**
   * 运行时追加一种绘制类型（扩展点，也可在构造 options.types 注入）。
   * @param def 子类构造器（推荐），或已实例化对象（会自动绑定宿主）。
   *            注册后 `tool.draw(def.key)` / `tool.push(def.key, …)` 即可用。
   */
  addType(def: (new (draw: any) => MapboxShapeType) | MapboxShapeType): MapboxShapeType {
    let inst: MapboxShapeType;
    if (isShapeType(def)) {
      inst = def;
      inst.draw = this;                                   // 实例 → 直接绑定宿主
    } else if (typeof def === 'function' && def.prototype instanceof MapboxShapeType) {
      inst = new (def as new (draw: any) => MapboxShapeType)(this);  // 子类构造器 → 实例化
    } else {
      throw new Error('addType 需要一个继承自 MapboxShapeType 的子类或实例。');
    }
    let key: string;
    try { key = inst.key; } catch { key = ''; }
    if (typeof key !== 'string' || !key) {
      throw new Error('addType：类型必须提供字符串 key。');
    }
    if (typeof inst.render !== 'function') {
      throw new Error(`addType：类型 "${key}" 必须实现 render(shape)。`);
    }
    if (this._types.has(key)) {
      throw new Error(`类型 "${key}" 已注册，不能重复。`);
    }
    this._types.set(key, inst);
    return inst;
  }

  /**
   * 取某类型的处理器实例（扩展点：类型自带的额外能力，如「坐标引线」的
   * `coordText(shape)`）。未注册返回 null。
   */
  getType(key: string): MapboxShapeType | null {
    return this._types.get(key) || null;
  }

  /**
   * 开启手绘。绘制中：单击落点 / 双击或回车完成 / 右键撤销上一点 / Esc 取消；
   * 完成自动生成新图形并聚焦，且【不缩放视野】。
   *
   * ★ `freehand` 类型（自由线 / 自由面）把上面那套手势整组换成**两击一笔**：单击起点 →
   *   移动鼠标描摹 → 再单击一次完成（见 `_beginBrush` / `_brushMove` / `_endBrush`）——
   *   全程不用按住鼠标。双击与右键对它们都不生效。
   * @param type 已注册的类型键（内置 'path' / 'polygon' / 'point' / …）
   */
  draw(type: string): void {
    this._assertAlive();
    if (!this._types.has(type)) {
      throw new Error(`未注册的绘制类型："${type}"（已注册：${[...this._types.keys()].join(', ')}）。`);
    }
    if (typeof this._map!.isStyleLoaded === 'function' && !this._map!.isStyleLoaded()) {
      throw new Error('地图样式尚未加载完成，请稍候再开始绘制。');
    }
    if (this._draw) this._exitDraw();                       // 切换类型先干净退出
    // 手绘期间的光标：自由手绘给十字（它靠「单击起点 → 移动 → 再单击」画，十字在说
    // 「这一下会落在地图上」）；逐点落点那套保持默认箭头（落点 + 虚线已是足够的反馈）
    this._cursor(this._types.get(type)!.freehand ? 'crosshair' : 'default');
    this._setZoomLock(true);                                 // 双击用于「完成」，关掉双击缩放
    this._draw = { type, pts: [], cursor: null };
    this.render();
    this._emit();
  }

  /** 取消当前进行中的手绘（Esc / 再点一次同一绘制按钮） */
  cancel(): void {
    if (this._destroyed) return;
    this._exitDraw();
  }

  /** 清空地图上【所有】图形；工具本身保留（画布仍在），可继续 draw() */
  clear(): void {
    this._assertAlive();
    this._shapes.clear();
    this._focused = null;
    this._hoverId = null;
    this._hoverVertex = null;      // 图形都没了，也就没有「压着哪支手柄」这回事
    this.render();
    this._emit();
  }

  /** 按 id 移除【某一个】图形 */
  remove(id: string): void {
    this._assertAlive();
    if (!this._shapes.delete(id)) return;
    if (this._focused === id) this._focused = null;
    if (this._hoverId === id) this._hoverId = null;
    if (this._hoverVertex && this._hoverVertex.id === id) this._hoverVertex = null;
    this.render();
    this._emit();
  }

  /**
   * 销毁绘制工具：移除画布与全部事件监听、恢复地图双击缩放与平移、
   * 清空内部状态。调用后本工具不可再用（地图不受影响）。
   */
  destroy(): void {
    if (this._destroyed) return;
    this._exitDraw();
    this._endDrag();
    this._dropWholeTileCache();   // 整张渲染的隐藏地图缓存（若在）一并释放
    this._focused = null;
    this._unbindEvents();
    if (this._panLocked && this._map) this._setPanLock(false);   // 保险：确保解锁
    this._shapes.clear();
    cancelFrame(this._raf);
    cancelFrame(this._initRaf);
    cancelFrame(this._hoverRaf);
    cancelFrame(this._snapRaf);
    this._raf = this._initRaf = this._hoverRaf = this._snapRaf = 0;
    this._hoverEvt = null;
    this._snapEvt = null;
    if (this._canvas && this._canvas.parentNode) {
      this._canvas.parentNode.removeChild(this._canvas);
    }
    this._canvas = null;
    this._ctx = null;
    this._types.clear();
    this._opts = null;
    this._map = null;
    this._destroyed = true;
  }

  /**
   * 动态修改【全局基础样式】：合并进全局样式并重绘。
   * 只影响「没有自己覆盖样式」的图形；某张图形用 applyStyle 覆盖过的键不再随之变化。
   */
  setStyle(patch: StylePatch = {}): void {
    this._assertAlive();
    Object.assign(this._style, patch);
    this.render();
  }

  /**
   * 取【全局基础样式】的一份**只读副本**（单图形自己的覆盖不在内 —— 那些用
   * `effectiveStyle(id)`）。写入口是 `setStyle()`，这两个是一对。
   *
   * ★ 给宿主回显「全局现在是什么样」用。别指望宿主自己存一份初值就够：
   *   `importJSON()` 会用文件里那份全局样式把 `_style` **整个换掉**
   *   （见 `pickGlobalStyle`），存下来的那份初值当场变成旧值 ——
   *   而「引擎改了、界面还在显示老样子」是最难被发现的一类不一致。
   */
  getStyle(): Style {
    this._assertAlive();
    return Object.assign({}, this._style);
  }

  /**
   * 【单图形】设置/覆盖样式：只作用于指定那张图形（缺省 = 当前聚焦图形），
   * 其余图形（含同类型）不受影响。
   */
  applyStyle(patch: StylePatch = {}, id?: string): void {
    this._assertAlive();
    const shape = this._resolveTarget(id);
    if (!shape) { this._warn('请先在「已绘图形」里选中一个图形，再设置它的样式。'); return; }
    shape.style = Object.assign(shape.style || {}, patch);
    this.render();
    this._emit();
  }

  /** 清掉某图形对样式的覆盖（恢复跟随全局基础样式） */
  resetStyle(id?: string): void {
    this._assertAlive();
    const shape = this._resolveTarget(id);
    if (!shape || !shape.style) return;
    shape.style = null;
    this.render();
    this._emit();
  }

  /**
   * 取某图形「最终生效」的样式快照（缺省 id = 聚焦）。只读副本。
   *
   * 合并顺序与渲染那条路（`MapboxShapeType.styleFor()`）**必须一致**：
   *   全局基础样式 → 本类型专属默认（`defaultStyle()`）→ 该图形自己的覆盖。
   * 少一层就会出现「面板显示 3px、画出来 2px」——这正是面板回显这类不一致里最难查的
   * （用户按面板上的数去改，改不动）。两处只差悬停那层临时的变色：
   * 那是光标此刻的反馈，不是这条图形长什么样，面板不该显示它。
   */
  effectiveStyle(id?: string): Style {
    this._assertAlive();
    const shape = this._resolveTarget(id);
    if (!shape) return Object.assign({}, this._style);
    const t = this._types.get(shape.type);
    // `Object.assign` 跳过 null / undefined，所以「没有类型默认样式」不必单独分一支
    return Object.assign({}, this._style, t ? t.styleDefaults : null, shape.style);
  }

  /**
   * 取某图形当前的**几何参数**（旋转角度 / 尺寸…），供宿主面板回显。
   *
   * 与 `effectiveStyle()` 同一套口径：`id` 缺省 = 当前聚焦的那条；具体是什么参数
   * 由**类型自己**表态（`readGeom()`）。类型没有「可调几何」这回事、或者形态退化
   * （算不出几何）时返回 `null` —— 面板据此整组不列，而不是列一堆没用的控件。
   *
   * ★ 报的是**屏幕量纲**（见 `GeomState`）：地图转了、缩放级别变了，同一张图片的
   *   角度与像素尺寸就会跟着变 —— 这正合面板上那两行控件的意思（调的是眼前这张图）。
   */
  getGeom(id?: string): GeomState | null {
    this._assertAlive();
    const shape = this._resolveTarget(id);
    if (!shape) return null;
    const t = this._types.get(shape.type);
    if (!t) return null;
    try { return t.readGeom(shape); }
    catch (err) { console.warn('[mapbox-sketch] 读取几何失败', err); return null; }
  }

  /**
   * 按几何参数改一条图形（面板上敲一个数 / 拖一下滑块走它），返回有没有真的改动。
   *
   * 与 `applyStyle()` 是同一套用法（写回**一条**图形、`id` 缺省 = 当前聚焦），
   * 区别只是写的是几何不是外观：几何是「此刻摆成什么样」，没有覆盖 / 恢复默认那一说。
   * 改完引擎会重绘并 `onChange`（同拖拽那条路）—— 顶点换了，投影缓存也要作废，
   * 这一步由 `render()` 自己 `_bumpFrame()`。
   */
  applyGeom(patch: GeomPatch, id?: string): boolean {
    this._assertAlive();
    const shape = this._resolveTarget(id);
    if (!shape) { this._warn('请先在「已绘图形」里选中一个图形，再改它的角度 / 尺寸。'); return false; }
    const t = this._types.get(shape.type);
    if (!t) return false;
    let changed = false;
    try { changed = t.writeGeom(shape, patch); }
    catch (err) { console.warn('[mapbox-sketch] 修改几何失败', err); return false; }
    if (!changed) return false;                    // 没改就别白重绘、白通知宿主
    this.render();
    this._emit();
    return true;
  }

  /**
   * 程序化新增一个图形（读后端数据 / 程序化生成都用它）。
   * @param type   类型键（须已注册）
   * @param coords 顶点 `[ [lng,lat], ... ]`（未闭合）
   * @param cfg    该图形专属配置，合并到默认配置上
   * @param id     手动指定 id；缺省自动生成 `类型-序号`（序号是一个**全局**自增计数，
   *               所以可能是 line-2 紧跟着 point-1；想要稳定 id 就自己传）
   * @param data   **类型私有数据**（如图片标注的图片本体，见 `Shape.data`）。
   *               它是拷一份存进去的，不参与配置合并、也不进任何全局默认
   * @returns 新图形 id
   */
  push(
    type: string,
    coords: LngLat[],
    cfg: CfgPatch = {},
    id?: string,
    data?: Record<string, ShapeDatum>,
  ): string {
    this._assertAlive();
    const t = this._types.get(type);
    if (!t) throw new Error(`未注册的图形类型："${type}"。`);
    if (!Array.isArray(coords) || coords.length < (t.minPts || 2)) {
      throw new Error(`类型 "${type}" 至少需要 ${t.minPts} 个顶点。`);
    }
    const shapeId = id || this._nextId(type);
    // cfg 合并顺序：全局默认 → 该类型专属默认(defaultCfg) → 本次显式 cfg。
    // 这样「引线标注」可让新画图形的 text 默认是「引线标注」，而不复用全局
    // 路径文字的默认文字；angle/len 等类型专属默认也不会污染其它类型。
    const typeCfg = typeof t.defaultCfg === 'function' ? t.defaultCfg() : {};
    const shape: Shape = {
      id: shapeId,
      type,
      pts: coords.map((p) => [p[0], p[1]] as LngLat),          // 拷贝，避免外部引用被改
      cfg: Object.assign({}, this._defaults, typeCfg, cfg),    // 全局默认 + 类型默认 + 覆盖
      style: null,                                             // 每图形可选样式覆盖
    };
    // 类型私有数据（图片标注的图片本体走这里）。`data` **不**放在 cfg 里，理由见 types.ts
    // 那段注释：cfg 的键会被 config() 写进全局默认，图片本体混进去会污染以后新建的图形。
    if (data) shape.data = Object.assign({}, data);
    this._shapes.set(shapeId, shape);                          // id 相同则整体替换
    this._focused = shapeId;
    // ★ 这里**必须**是合帧重绘，不能是 render()：批量 push（读后端数据一次画上去）
    //   会变成「每 push 一个就全量重画一次」，总成本 O(N²) —— 实测 2000 个要 712ms，
    //   5000 个四秒起步。requestRender 一帧内只真的画一次，批量灌入退化成 O(N)。
    this.requestRender();
    this._emit();
    return shapeId;
  }

  /* ── 数据存档：一次性导出 / 一键导入 ────────────────────────────────── */

  /**
   * 把当前**全部图形**导出成 JSON 文本（一次性拿全，不需要自己遍历 `shapes`）。
   *
   * ```ts
   * const text = tool.exportJSON();        // 缩进 2，给人看 / 进版本库
   * const text = tool.exportJSON(0);       // 一行，给程序比对
   * localStorage.setItem('标注', text);
   * ```
   *
   * 装的是**图形数据**：类型 / 顶点 / 绘制配置 / 样式覆盖 / 是否隐藏，
   * 外加一份**完整的全局基础样式**（`_style`）。
   *
   * 全局样式必须带上，而且不管它跟出厂默认一不一样都照写：没有样式覆盖的图形
   * 跟随的正是它。库以后改了 `DEFAULT_STYLE`、或者换个项目里全局配色不同，
   * 只有连它一起存，导回来才真的是当初那个样子。
   *
   * 不进文件的是**默认绘制配置**（每张图形的 `cfg` 本来就是完整的，自带全部配置）
   * 与**显示总开关**（那是「这个页面此刻看不看标注」的视图状态）。
   *
   * 反过来 `importJSON()` 能原样吃回去，且「导出 → 导入 → 再导出」得到的是
   * **逐字节相同**的文本。
   */
  exportJSON(space = 2): string {
    this._assertAlive();
    return JSON.stringify(toSketchData(this._shapes.values(), this._style), null, space);
  }

  /**
   * 从 JSON 文本（或已解析好的对象）导入图形。**追加合并**：地图上已有的保留，
   * 文件里的接在后面；id 撞了就自动换新号（换号会写进返回值的 `warnings`）。
   *
   * 想「整份还原」就 `clear()` 再 `importJSON()` —— 两条现成的 API 拼得出来，
   * 就不必再多一个 `mode` 选项。
   *
   * 出问题的分界画在「整份文件还能不能用」：
   * - **壳不对 → 抛错**（不是 JSON / 不是对象 / 没有 `shapes` 数组 /
   *   `app` 写错了 / `version` 比当前引擎支持的还高）。
   *   抛之前**一个字段都不改**，画布一点没动，可以放心重选文件。
   * - **壳对而某一条成不了图形 → 跳过那一条**（类型没注册 / 顶点不合法 /
   *   顶点数不够 / 它自己的 `defaultCfg()` 抛错），其余照常导进来。
   *   自定义类型拿到别的项目里必然没注册，整批失败太粗暴。
   *
   * 文件里带了全局基础样式（v2 起都有）就一并**套用**上去 —— 这是「导回来跟导出时
   * 长得一样」的另一半：没有样式覆盖的图形跟随的是全局样式，不套用的话它们会跟着
   * 导入方那台机器的配色走。文件没带（v1 老文件 / 手写的）则**一个键都不动**。
   *
   * 套用全局样式会连带影响地图上**已有**图形里没有覆盖的那些（这正是它的语义），
   * 所以返回值里用 `styled` 标出来，别让这件事悄悄发生。
   *
   * @returns 导入了几条、跳过了几条、实际拿到的 id、是否套用了文件里的全局样式、
   *          以及逐条问题。
   *          ★ 这些**不走 `onWarn`**：批量接口一次可能出几十条问题，
   *          而宿主的 `onWarn` 往往只是一行提示（后写覆盖先写），刷屏之后
   *          只剩最后一条，反而看不清。怎么显示由调用方决定。
   */
  importJSON(data: string | SketchData): ImportResult {
    this._assertAlive();
    const file = parseSketchData(data);              // 壳不对在这里就抛了，引擎状态未动
    const result: ImportResult = { added: 0, skipped: 0, ids: [], warnings: [], styled: false };
    const hiddenIds: string[] = [];
    const prevFocused = this._focused;

    // 全局基础样式：先套上，再灌图形（顺序不影响结果，但省得中途多画一帧）
    if (file.style !== undefined) {
      const next = pickGlobalStyle(file.style);
      // 归一化之后再比：`_style` 里可能有构造时塞进来的陌生键，那些不该算「不一样」
      if (JSON.stringify(pickGlobalStyle(this._style)) !== JSON.stringify(next)) {
        // ★ 不走公开的 `setStyle()`：它内部会 render()，而本次导入的最后只该画一帧
        //   （同本文件「批量接口不在循环里调立刻出图的方法」那条口径）
        Object.assign(this._style, next);
        result.styled = true;
      }
    }

    file.shapes.forEach((raw, i) => {
      const read = readShapeData(raw, i);
      if (!read.ok) {
        result.skipped += 1;
        result.warnings.push(read.reason);
        return;
      }
      const item = read.item;
      result.warnings.push(...item.warnings);

      // 类型没注册 → 跳过这一条（自定义类型换个项目就没了，不该连累整批）
      const t = this._types.get(item.type);
      if (!t) {
        result.skipped += 1;
        result.warnings.push(
          `第 ${i + 1} 条数据的类型 "${item.type}" 未注册，已跳过（可先 addType() 注册再导入）。`,
        );
        return;
      }

      // ★ 顶点数的检查必须在这里做：`push()` 对顶点不够是**抛错**的
      const minPts = t.minPts || 2;
      if (item.pts.length < minPts) {
        result.skipped += 1;
        result.warnings.push(
          `第 ${i + 1} 条数据（${t.label}）只有 ${item.pts.length} 个顶点，`
          + `少于该类型最少的 ${minPts} 个，已跳过。`,
        );
        return;
      }

      // id 撞了就让路 —— 绝不覆盖同 id 的已有图形（`push` 的 set 是「同 id 整体替换」）
      let id = item.id;
      if (id !== null && this._shapes.has(id)) {
        const next = this._nextId(item.type);
        result.warnings.push(idTakenWarning(i, id, next));
        id = next;
      }

      let shapeId: string;
      try {
        // ★ 复用 push()：配置合并（全局默认 → 类型默认 → 文件里的）、pts 拷贝、
        //   去重口径都长在它身上，导入不该另起一套。`push` 的插入在 `_emit` 之前，
        //   而 `_emit` 自带 try/catch，所以它**要么插入成功、要么什么都没插**，
        //   这里 catch 到的都是「第三方类型的 defaultCfg() 抛错」这类问题。
        shapeId = this.push(item.type, item.pts, item.cfg, id || undefined, item.data);
      } catch (err) {
        result.skipped += 1;
        result.warnings.push(
          `第 ${i + 1} 条数据（${t.label}）导入失败：${(err as Error).message}，已跳过。`,
        );
        return;
      }

      // 样式覆盖直接写内部对象：`applyStyle()` 每次都**立即重绘**，N 条就是 O(N²)。
      // 隐藏先攒着，循环外一次性交给 `_setHidden()`（它内部只合帧重绘一次）。
      const shape = this._shapes.get(shapeId);
      if (shape) {
        shape.style = item.style;
        if (item.hidden) hiddenIds.push(shapeId);
      }
      result.added += 1;
      result.ids.push(shapeId);
    });

    // 一条都没进库、也没套用样式 = 引擎状态一点没变，不重绘、也不发通知。
    // ★ `styled` 也要看：一份只有样式没有图形的文件同样得重绘一次，
    //   否则「套上了但画布没变」—— 正是那种「引擎改了、画面是旧的、还不报错」。
    if (result.added === 0 && !result.styled) return result;

    if (hiddenIds.length) this._setHidden(hiddenIds, true);

    // ★ 顺序不能反：`_setHidden` 内部的 `_dropHiddenInteractions()` 会清掉「指向
    //   刚被隐藏图形」的聚焦，还原聚焦必须排在它**之后**；判据要用 `_shown`
    //   （含刚导入的 hidden）而不是 `has`，否则会把聚焦还原到一条刚藏起来的图形上。
    //
    // ★ 这一句改完**必须再通知一次**：导入过程中每次 `push` 都发一次 onChange，
    //   宿主看到的是「聚焦 = 最后导入的那条」；不补这一次，面板就会高亮一行
    //   引擎里并不是聚焦的图形 —— 正是那种「引擎改了、面板显示旧值、还不报错」。
    this._focused = (prevFocused && this._shown(this._shapes.get(prevFocused)))
      ? prevFocused
      : null;

    // `push()` 全是合帧的，这里补一次「立刻出图」（同 `_commitDraw` 的口径）
    this.render();
    this._emit();
    return result;
  }

  /* ── 图片导出：视口或纸张 · 连底图带标注 → PNG / JPEG（可选 dpi） ─────── */

  /**
   * 收集各图形的**异步资源**等待（目前只有「图片标注」的图片解码）。
   *
   * 代价接近于零：没有异步资源的类型缺省返回 `null`（`whenReady` 的基类实现），
   * 这里连一个 Promise 都不会产生。有资源的（图片没解码完）才真的等 ——
   * 而 data URL 的解码也就几毫秒，所以**不报进度**：为它加一个 `ExportPhase`
   * 会动到对外的进度契约（宿主的穷尽 switch 会因此编译报错），不值当。
   *
   * 钩子抛错 / Promise 拒绝一律**吞掉**：那张图画成什么样就什么样，
   * 绝不能因为某个第三方类型的资源问题把整次导出搞挂（同 `_countTiles` 的口径）。
   *
   * ★ 返回 `null` = 一个都不用等，调用方**不许**无脑 `await`：
   *   `await` 一个已经 resolve 的 Promise 也会让出微任务，而出图的前几步
   *   （「正在等待地图加载…」这句进度）是**同步**报出去的 —— 多一个 await 就会让它
   *   晚一拍，宿主的进度条行为跟着变（`test/export.spec.ts` 钉着这条）。
   */
  private _assetWaits(): Promise<void>[] | null {
    const waits: Promise<void>[] = [];
    for (const shape of this._shapes.values()) {
      const t = this._types.get(shape.type);
      if (!t) continue;
      try {
        const w = t.whenReady(shape);
        if (w) waits.push(w.catch(() => { /* 见方法注释：不当成导出失败 */ }));
      } catch { /* 同上 */ }
    }
    return waits.length ? waits : null;
  }

  /**
   * 把**取景范围**（所见即所得、镜头不动）连底图带标注导成一张图片。
   *
   * ```ts
   * const r = await tool.exportImage({ format: 'png', dpi: 300 });
   * download(r.blob, `标注-${r.dpi}dpi.png`);
   *
   * // 纸张模式：取景范围换成 A4 纵向，1mm 纸上 = 96/25.4 屏幕 CSS 像素的地理范围
   * const p = await tool.exportImage({ dpi: 300, paper: { size: 'A4' } });
   * ```
   *
   * **取景范围**默认是当前视口；传了 `paper` 就换成纸张折算出来的那一块（见
   *   `export-image.ts` 的 `paperFrame()`），**以视口中心为中心**。除了这一项，
   *   下面所有算式两种模式**完全共用** —— 所以 `_capture.frame` 是唯一的模式分叉点。
   *   纸张比视口大时（A0/A1），成品里会出现**屏幕上根本看不到**的区域，这是对的。
   *
   * **清晰度是怎么来的**：底图和标注是两条不同的路，各自的清晰度来源也不同。
   *
   * - **标注层**：我们自己的覆盖层 canvas 按 `dpi/96` 倍**真·重渲染**。所有类型画的
   *   都是 CSS 像素坐标，放大只是换个 `setTransform` 系数，所以 41 种内置类型
   *   一行都不用改，字和线都真的按 300dpi 画出来。
   * - **底图**：mapbox-gl 3 的底图画布尺寸**只**由「容器 CSS × devicePixelRatio」
   *   决定，`setPixelRatio` 已经不存在，`setScaleFactor` 是符号图层的无障碍缩放
   *   （不是分辨率）。所以这里**另建一张隐藏地图**，容器给 `取景范围 × scale`、
   *   zoom 抬高 `log2(scale)`（地理范围与取景范围完全一致，像素多 scale 倍），
   *   它于是会去抓**更高 z 的瓦片** —— 底图也就真的更细了。
   *
   * **为什么用户看不见**：可见地图的相机、容器尺寸、渲染循环**全程一个字节都不动**
   *   （不是「改完再改回来」—— 那会让人亲眼看见地图放大、重新下瓦片、再弹回去）。
   *   隐藏地图挂在 `opacity:0` 的离屏容器里，导出结束就整个销毁。
   *
   * **代价**：高清导出**不是瞬时的**。底图要在隐藏地图里重新下瓦片，
   *   几秒很正常 —— 所以务必用 `onProgress` 给用户反馈（宿主/示例页里是个遮罩）。
   *   它的第二个参数 `ExportProgress` 带着 `phase` / `elapsedMs` / `tiles`，
   *   宿主要画一条真的会动的进度条就靠 `tiles`（读不出来时是 `undefined`，退回不确定态）。
   *   纸张比视口大时瓦片数按面积翻倍，这一等会更久。
   *
   * **不想要这一等**：传 `hdBasemap: false`（见 `ExportImageOptions.hdBasemap`）——
   *   底图改用**屏幕上现成的那一级**瓦片放大，不再去下更深一级，于是那几秒到几分钟的
   *   等待基本消失；代价是底图的详略度停在这一级（放大会看到线和注记变粗、路网变稀）。
   *   **标注层不受影响**，它始终按 `dpi/96` 真·重渲染。
   *
   * **图廓整饰**（专题图 / 打印图）：传 `margin` 在地图外面留一圈边，再传 `decorate`
   *   把图框 / 白边 / 指北针 / 图例画上去。装饰是画在**引擎的合成画布**上的，所以
   *   dpi 元数据仍由引擎写进文件本体 —— 宿主自己拿成品图再合成一张就会丢掉这一步
   *   （打印排版又变成 72dpi）。`decorate` 拿到的几何全是**输出像素**且已算好
   *   （见 `ExportDecorateInfo`），一个减法都不用做。
   *
   * ```ts
   * await tool.exportImage({
   *   dpi: 300, paper: { size: 'A3' },
   *   margin: 13,                                       // CSS 像素：四边各留 13px
   *   decorate: (ctx, g) => {                           // g.map = 地图区在整页上的矩形
   *     ctx.strokeStyle = '#000';
   *     ctx.lineWidth = 3 * g.scale;                    // 3 CSS 像素的外框
   *     ctx.strokeRect(g.width / 2, g.height / 2, g.width, g.height);  // 见 API.md 的完整例子
   *   },
   * });
   * ```
   *
   *   不传 `margin` 时输出画布就是地图区，一切与以前**逐字节相同**（连 `width/height`
   *   报的数都还是地图区的像素数）。
   *
   * **出发前先等底图下完**：可见地图（屏幕上那张）和隐藏地图各等一次，判据是
   *   `loaded()` / `idle`（在 mapbox 里这两者本来就是同一个条件，理由见
   *   `_waitBasemapReady`）。所以「刚打开页面就点导出」不会导出一张空白底图的图，
   *   而是先等它下完再出图。**这一等没有超时**：300dpi 要在隐藏地图里另下一百多块
   *   高 z 瓦片，慢的服务要几分钟也照等 —— 理由（以及「为什么不设上限」）见
   *   `_waitBasemapReady`，那是这个库最不该被「顺手优化」的一处。
   *
   * @throws 已销毁 / 容器尺寸为 0 / 上一次导出还没结束时抛中文错误。
   */
  async exportImage(opts: ExportImageOptions = {}): Promise<ExportImageResult> {
    this._assertAlive();
    const map = this._map;
    if (!map) throw new Error('绘制工具已被 destroy()，无法导出图片。');
    if (this._exporting) throw new Error('上一次导出还没结束，请稍候再试。');

    const c = map.getContainer();
    const cssW = c.clientWidth || 0;
    const cssH = c.clientHeight || 0;
    if (cssW <= 0 || cssH <= 0) {
      throw new Error('地图容器尺寸为 0，无法导出图片（容器可能还没显示，或已被隐藏）。');
    }

    const format: 'png' | 'jpeg' = opts.format === 'jpeg' ? 'jpeg' : 'png';
    const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    /**
     * 底图档位（`ExportImageOptions.hdBasemap`）。**缺省是 `true`** —— 不认识这个选项的
     * 调用方（以及所有既有代码）行为逐字节不变，这正是给新选项定默认值的规矩：
     * 只有显式写 `false` 才会切成「拿现成瓦片放大」那一档。
     */
    const hd = opts.hdBasemap !== false;
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const dpiIn = opts.dpi != null ? opts.dpi : BASE_DPI;
    const plan = planExport({
      cssW, cssH, dpr, dpi: dpiIn,
      paper: opts.paper,
      // 分块导出：这一块在整块取景范围里的位置（`planExportTiles` 给的）。
      // 不给 = 整张不切，`offset` 恒为 0，下面走的是老路径。
      cell: opts.cell,
    });
    /**
     * 倾斜分块的「整张渲染」计划（`TILE_TILT_EPS` 注释里的第二行方案）。
     * 只在「分了块 **且** 地图带着俯仰角」时非空 —— 正俯视时透视退化为线性缩放，
     * 逐块建地图本来就精确，不必多背一张整张画布。
     */
    const tilted = Math.abs(map.getPitch()) > TILE_TILT_EPS;
    const wholePlan = tilted && plan.cell
      ? planExport({ cssW, cssH, dpr, dpi: dpiIn, paper: opts.paper })
      : null;
    // 整张路的画布 = 全部输出像素，建不出来就当场说清楚（绝不默默出错图）
    if (wholePlan
      && (wholePlan.outW * wholePlan.outH > TILE_WHOLE_MAX_PIXELS
        || Math.max(wholePlan.outW, wholePlan.outH) > TILE_WHOLE_MAX_SIDE)) {
      throw new Error(
        `倾斜视角下的分块导出必须按「整张」渲染底图（约 ${wholePlan.outW}×${wholePlan.outH} 像素），`
        + '超出了浏览器画布能建出的上限。请把地图设为正俯视（pitch 0）后重试 —— 正俯视下逐块导出'
        + '精确、也没有这个尺寸限制；或降低 dpi / 改用更小的纸张。',
      );
    }
    /*
     * ★★ 纸张的取景范围必须装得下「整个世界」，否则这张图必错 —— 拦在这里。
     *
     * 判据与来龙去脉见 `export-image.ts` 那节「取景范围必须装得下整个世界」。一句话：
     * mapbox 的 `_constrain()` 不许视口纵向越出世界，越了只有两条路 ——
     *   ① 视口高 ≤ 世界高：把相机中心往下/上压（画面内容整体偏，可按差值平移回来，
     *      见 `_createExportMap` 的 `shift`）；
     *   ② 视口高 > 世界高：**把 zoom 强行抬高**、中心钉在世界正中（平移救不回来）。
     * ② 一旦发生，底图与覆盖层再也对不上 —— 导出来是一张看着正常、其实错的图，
     * 所以宁可在建图之前就停下。
     *
     * ★ 2026-09-22 实报（用户截图：同一片大陆出现两遍、中间一道接缝）：A0 竖 @300dpi、
     *   zoom 2.5。取景范围高 4494 CSS 像素，而世界只有 2896 —— 超了 1.55 倍，
     *   分块后上下两块各自被压到 ±37.4°，140° 的纬度带被渲染了两遍。（实测：申请中心
     *   lat 83.0 → 实得 37.38，正是「容器高的一半」被顶回世界内。）
     *
     * ★ 判**纸张的整张取景范围**，不判分块后那一块：分块只是我们自己的切法，用户要的是
     *   一张纸 —— 同一张纸 @96dpi 不分块、@300dpi 分 2×2，不能出现「@96 报错、@300 照出」
     *   两套结论。（分块那一块恒小于整张，整张过了，逐块建地图必然也过。）
     */
    const pf = paperFrame(opts.paper);
    const frameH = pf ? pf.frameH : cssH;
    const zoomNow = map.getZoom();
    if (!frameFitsWorld(frameH, zoomNow)) {
      const world = worldPxAt(zoomNow);
      throw new Error(
        `这次导出要取景 ${Math.round(pf ? pf.frameW : cssW)}×${Math.round(frameH)} CSS 像素`
        + `（${pf ? `纸张 ${pf.wmm}×${pf.hmm}mm 折算` : '跟随视口'}），而 zoom ${zoomNow} 下`
        + `整个世界只有 ${Math.round(world)} 像素高 —— 取景范围比世界还高 `
        + `${(frameH / world).toFixed(2)} 倍。mapbox 会把相机硬拉回世界内（中心被改、`
        + 'zoom 被强行抬高），照这样导出来的图会重复出现同一片大陆、或者整体错位，所以就此停下。'
        + `请把地图放大到 zoom ≥ ${minZoomToFit(frameH).toFixed(2)} 后重试，或改用更小的纸张。`,
      );
    }
    const warnings = plan.warnings.slice();
    const startedAt = Date.now();
    /**
     * 报一句进度。`phase` / `tiles` 是给宿主**画进度条**用的（文案它只能显示，
     * 结构化信息才能算百分比），所以每个调用点都必须报准自己是哪一步。
     */
    const progress = (msg: string, phase: ExportPhase, tiles?: ExportTiles): void => {
      if (typeof opts.onProgress !== 'function') return;
      const info: ExportProgress = { phase, elapsedMs: Date.now() - startedAt };
      if (tiles) info.tiles = tiles;
      try { opts.onProgress(msg, info); } catch (err) { console.error(err); }
    };

    // 并发闸从这里开始：下面每一个 await 之前都必须已经置上
    this._exporting = true;
    const prevCapture = this._capture;
    let restored = false;
    /**
     * 还原屏幕渲染态（幂等）。**提前调一次、`finally` 再兜一次** ——
     * 任何提前抛出都不该把屏幕留在出图态（见下面「在编码之前就还原」那段）。
     */
    const restoreCapture = (): void => {
      if (restored) return;
      restored = true;
      this._capture = prevCapture;
      try {
        this._resize();
        this.render();
      } catch (err) {
        // 还原时的一次渲染异常**不能**吞掉一次本来能成功的导出（结果此时已经算完）
        console.warn('[mapbox-sketch] 还原渲染态失败', err);
      }
    };
    let holder: HTMLElement | null = null;
    let hidden: MapboxMap | null = null;
    /** 倾斜分块的整张渲染上下文；非空时底图从 `whole.map` 的画布上裁出来 */
    let whole: { plan: ExportPlan; map: MapboxMap; holder: HTMLElement; shift: ExportShift } | null = null;
    /** 逐块建地图那条路（非倾斜 / 不分块）的相机位移；见 `_createExportMap` 的 `shift` */
    let shift: ExportShift = { dx: 0, dy: 0 };
    /** 本次导出是否完整走完（决定整张缓存是保留还是释放） */
    let exportOk = false;

    try {
      // ★ 先等各图形的**异步资源**（图片标注的解码）就绪：没解码完时它画的是占位框，
      //   而 `render()` 是**同步**的 —— 不等的话，「导入一份带图的 JSON 后立刻导出」
      //   的成品里就是一堆「图片加载中…」。它与地图瓦片无关，所以放在最前面。
      //   `null` 时**不能** await（理由见 `_assetWaits`）。
      const assetWaits = this._assetWaits();
      if (assetWaits) await Promise.all(assetWaits);

      // ★ 再等**可见地图**，而且必须在 `_createExportMap()`（它里面要读 `getStyle()`）**之前**：
      //   可见地图的样式还没加载完时，`getStyle()` 给的是一份**没有图层**的样式，
      //   照着它建出来的隐藏地图自然是一张空底图（成品里就只剩标注层）。
      //   顺带，它也是「所见即所得」的前提 —— 屏幕上还没画出来的东西，导出来只能是空白。
      //   （「正在等待地图加载…」那句由 `_waitBasemapReady` 自己报，等待期间它还会
      //     接着报「已等 <时长> · N%」—— 等待动辄几十秒到几分钟，进度不能一动不动）
      await this._waitBasemapReady(map, '可见地图', progress);

      progress('正在准备底图…', 'prepareMap');
      if (!wholePlan) this._dropWholeTileCache();   // 这次用不上整张缓存，别让它白占内存
      if (wholePlan) {
        // ── 倾斜分块：整张渲染 + 裁块 ──
        // 同一批分块、同一视角 → 复用上一块建好的整张隐藏地图（底图瓦片都已就位，
        // 每块重建等于把上百块高 z 瓦片重下 N 遍）。视角/底图一变，key 失配自动重建。
        const key = this._wholeTileKey(map, wholePlan, dpr, hd);
        const cached = this._wholeTileCache;
        if (cached && cached.key === key) {
          whole = { plan: wholePlan, map: cached.map, holder: cached.holder, shift: cached.shift };
        } else {
          this._dropWholeTileCache();
          const built = this._createExportMap(map, wholePlan, hd, opts.transformStyle);
          // ★ 先入缓存、再做可能抛错的 fov 补偿 / 等底图：中途任何一步失败，
          //   finally 的 `!exportOk → _dropWholeTileCache()` 都能把这份资源收走。
          //   先做后存的话，补偿一抛，刚建出来的地图就成了无主的泄漏。
          this._wholeTileCache = {
            key, map: built.map, holder: built.holder, shift: built.shift,
          };
          whole = { plan: wholePlan, map: built.map, holder: built.holder, shift: built.shift };
          this._compensateExportFov(map, built.map, wholePlan, cssH);
          await this._waitBasemapReady(built.map, '隐藏地图', progress);
        }
      } else {
        const built = this._createExportMap(map, plan, hd, opts.transformStyle);
        // ★ 同理先赋给 finally 能看见的变量，再走可能抛错的补偿
        holder = built.holder;
        hidden = built.map;
        shift = built.shift;
        // 未分块的倾斜导出也吃同一套 fov 补偿：取景框 ≠ 视口形状时，老路径的
        // 「容器 = 框×scale + 抄相机」在 pitch>0 下不再成立（见 TILE_TILT_EPS 注释）。
        if (tilted) this._compensateExportFov(map, built.map, plan, cssH);
        await this._waitBasemapReady(hidden, '隐藏地图', progress);
      }

      // ---- 覆盖层按目标像素「真·重渲染」 ----
      // ★ 这个倍率就是「输出像素 ÷ **取景框** CSS 宽」：于是覆盖层画布的物理像素数
      //   **恒等于** outW × outH，与底图那半张逐像素对齐，不差一分。
      //   分母取的是取景框宽（而不是容器宽）是纸张模式能成立的关键：纸可能比屏幕宽，
      //   用容器宽会把覆盖层画布多撑出 `容器宽/取景框宽` 倍，粘贴时整张错位。
      //
      // ★ 为什么不写成 `plan.outW / plan.frameW`：那个 `outW` 是**取整过**的，
      //   纸张宽又是 793.70… 这种小数，相除出来的倍率必然带舍入，`_resize()` 再
      //   乘回去就可能比输出少 1 像素（纸越大越容易露，A0 上是一条可见的白边）。
      //   这两个数乘起来就是 `dpi/96` 本身 —— 与 `outW/outH` 用的是同一个值，
      //   于是 `_resize()` 与 `planExport` 走的是同一个 `round(取景范围 × target)`，
      //   逐像素必然相等。
      //
      // ★ 从这里到 `restoreCapture()` 之间**不许出现 await**：这一段里
      //   `_viewX/_viewY/_viewW/_viewH` 与屏幕不再重合，任何能把控制权交出去的
      //   东西（指针事件、rAF）插进来都会按取景框坐标画到屏幕上 —— 表现是
      //   「手柄画在别处、点不中、吸附飘」。`_waitBasemapReady` 动辄几十秒，
      //   把这一行提到它前面就等于把这个 bug 送上生产线。
      this._capture = {
        dpr: plan.scale * dpr,
        frame: { x: plan.frameX, y: plan.frameY, w: plan.frameW, h: plan.frameH },
      };
      this._resize();
      this.render();
      progress('正在合成…', 'compose');

      /*
       * ---- 图廓整饰：整页画布 = 地图区 + 四边外边距 ----
       *
       * 只在**合成**这一段起作用：取景范围、隐藏地图尺寸、覆盖层物理像素、分块规划
       * 全都没变（外边距是在已经出好的地图外面加边，不是把取景范围放大）。
       * 不传 `margin` 时 `deco` 与 `plan` 逐项相等 —— 老路径一个字节都不变。
       *
       * `outScale` = 输出像素 ÷ CSS 像素，就是 `plan.scale × dpr`（= 生效 dpi / 96）。
       * `decorate` 回调拿到的 `scale` 也是它 —— 宿主按屏幕像素设计的装饰尺寸乘一次即可。
       */
      const deco = planDecorate(plan.outW, plan.outH, normalizeMargin(opts.margin), plan.scale * dpr);
      const hasMargin = deco.width !== plan.outW || deco.height !== plan.outH;

      const out = document.createElement('canvas');
      out.width = deco.width;
      out.height = deco.height;
      const octx = out.getContext('2d');
      if (!octx) throw new Error('无法创建导出用的画布（浏览器拒绝提供 2d 上下文）。');

      /*
       * ★ 底色**不在这里铺** —— 挪到 `_probeBasemap` 之后，用 `destination-over`
       *   铺在已有像素**下面**（见探底那一段的注释）。
       *   先铺的话画布从第一笔起就是不透明的，而探底正是靠 alpha 判断「底图到底画进来
       *   没有」——它就成了一个永远说「画进来了」的摆设。2026-09-22 实测踩到：
       *   mapbox 3.22 在 token 校验失败后会清空画布并停渲染（`_revokeAuth`），整块
       *   地图区全是白的，而这条告警一声没吭。铺底的效果一个像素都没少（见下面）。
       */

      // 底图。两条路：
      // · 老路：隐藏画布就是「这一块」的底图，整幅拉伸铺满输出（隐藏画布可能因
      //   取整差 1px，拉伸一下即可，肉眼不可见）。
      // · 整张路（倾斜分块）：隐藏画布是**整张**取景范围的底图，把这一块对应的
      //   矩形裁出来贴进输出。裁剪坐标 = 「块框相对整框的偏移 × 画布物理密度」，
      //   密度从画布实际宽度反推（吸收容器取整 / devicePixelRatio 的零头）。
      const baseCanvas = whole
        ? whole.map.getCanvas()
        : (hidden as MapboxMap).getCanvas();
      /*
       * ★ 相机被 mapbox 拉回世界内时，这半张底图的**内容整体偏了** `shift` 个画布像素
       *   （原因与量法见 `_createExportMap` 的 `shift`），贴的时候按它推回去。
       *   整张路与逐块路用的是同一个值：整张路是从整张画布上裁一块下来贴，两者密度相同，
       *   位移也就相同。（覆盖层随后 1:1 贴上去，不参与平移 —— 它本来就是按**申请的**
       *   取景框画的，正是平移要还原到的那个坐标系。）
       */
      const sc = whole ? whole.shift : shift;
      if (sc.dx !== 0 || sc.dy !== 0) {
        /*
         * 平移会空出一条边，那条边本来就是「世界之外」（世界外面没有瓦片，底图背景层
         * 也没铺到那儿）。按导出背景色补上，别留一道透明缝 —— 在 JPEG 下更是一条黑边。
         * ★ 只补**地图区**那一块：整页那圈外边距是整饰自己的地盘（外框 / 白边），
         *   在这里重铺一遍颜色覆盖不住什么，但会与宿主在 `decorate` 里画的底色打架。
         */
        octx.fillStyle = opts.background || '#ffffff';
        octx.fillRect(deco.mapX, deco.mapY, plan.outW, plan.outH);
      }
      // 地图一律贴到 `deco.mapX/mapY`（没传 margin 时是 0/0，与老路径逐像素相同）
      if (whole) {
        const k = baseCanvas.width / whole.plan.frameW;
        octx.drawImage(
          baseCanvas,
          (plan.frameX - whole.plan.frameX) * k,
          (plan.frameY - whole.plan.frameY) * k,
          plan.frameW * k,
          plan.frameH * k,
          deco.mapX + sc.dx, deco.mapY + sc.dy, plan.outW, plan.outH,
        );
      } else {
        octx.drawImage(baseCanvas, deco.mapX + sc.dx, deco.mapY + sc.dy, plan.outW, plan.outH);
      }

      // 探底：读不到内容说明宿主地图没开 preserveDrawingBuffer，成品里将只剩标注层
      // （采样点在**地图区**里 —— 整页外边距那圈本来就什么都没有）
      // `background` 一并交给它：铺过底色的画布上，只剩底色的地方等于没画（见那里注释）
      const baseDrawn = this._probeBasemap(
        octx, plan.outW, plan.outH, deco.mapX, deco.mapY, opts.background,
      );
      if (!baseDrawn) {
        warnings.push(
          '底图没能读回来（成品里只有标注层）。常见原因：宿主地图没开 '
          + 'preserveDrawingBuffer: true；或 Mapbox token 校验失败 —— mapbox-gl 3.x '
          + '在 token 无效时会清空画布并停止渲染（自建瓦片底图也一样）。也可以通过 '
          + 'SketchOptions.createMap 自行构造隐藏地图。',
        );
      }

      /*
       * ---- 底色：现在才铺，用 `destination-over` 铺在已画好的像素**下面** ----
       *
       * JPEG 没有透明通道（不铺底，透明处就是黑色）；有图廓时外面那圈也必须铺，
       * 否则是「一圈透明」（PNG）或黑边（JPEG）。
       *
       * 为什么放到探底之后：见上面那段「底色不在这里铺」。`destination-over` 把这次
       * 填充画到**已有内容的下面**，于是最终的每一个像素与「先铺底再画」**逐字节相同**
       * （Porter-Duff 的 `over` 可结合：C over (B over A) ≡ (C over B) over A），
       * 而探底读到的 alpha 仍然是「地图到底画没画」的真话。
       */
      if (format === 'jpeg' || hasMargin) {
        octx.save();
        octx.globalCompositeOperation = 'destination-over';
        octx.fillStyle = opts.background || '#ffffff';
        octx.fillRect(0, 0, deco.width, deco.height);
        octx.restore();
      }

      // 覆盖层画布已经是 outW × outH 的物理像素，1:1 贴到地图区即可
      if (this._canvas) octx.drawImage(this._canvas, deco.mapX, deco.mapY);

      /*
       * ---- 整饰层：图框 / 指北针 / 图例 / 图名（`ExportImageOptions.decorate`）----
       *
       * 位置在**覆盖层之后、还原渲染态之前**：
       *   · 之后 —— 装饰是画在「地图 + 标注」上面的（图例本来就压在地图上）。
       *     ★ 注意这不是「盖住」那层意思：`decorate` 想画在地图之外的边距上，
       *       就直接用 `info.map` 反推坐标（`margin` 也在 info 里），不必猜。
       *   · 还原之前 —— 与上面几步同属一段**同步代码**，中间不许出现 await：
       *     宿主回调里若读 Vue ref / 写 DOM，那都是它自己的事；引擎这边只是画离屏画布，
       *     屏幕渲染态仍是出图态，直到下面 `restoreCapture()` 才还回去（顺序与理由见那段注释）。
       *
       * 抛错**不吞**：见 `ExportImageOptions.decorate` —— 整饰画不出来这张图就是废的，
       * 静默吞掉只会让用户拿到一张缺图例的成品还以为没事。`finally` 照常清理。
       */
      if (typeof opts.decorate === 'function') {
        opts.decorate(octx, {
          width: deco.width,
          height: deco.height,
          dpi: plan.dpi,
          scale: plan.scale * dpr,
          map: { x: deco.mapX, y: deco.mapY, w: plan.outW, h: plan.outH },
          margin: deco.margin,
        });
      }

      /*
       * ★ 出图态用完了，**在编码之前就还原** —— 别挪回 `finally`。
       *
       * 出图期间覆盖层的画布物理尺寸与坐标系原点都跟屏幕不一致，而 `toBlob` 编码
       * 一张 300dpi 的图要几百毫秒，这期间**必须**已经回到屏幕态：
       *   · 上面那句 `progress('正在合成…')` 会调宿主的回调（demo 里是写 Vue ref），
       *     微任务刷完就在下一次绘制之前落地 —— 那正是「用户亲眼看见标注被压扁」的窗口；
       *   · 纸张模式下这个窗口比视口模式宽得多：容器宽 ≠ 取景框宽，画面不是等比缩放，
       *     而是真的错位（视口模式「看起来一模一样」纯属物理尺寸等比放大的巧合）。
       *
       * 这一段到上面那次 `render()` 之间全是同步代码、没有 await，浏览器插不进一帧。
       * `finally` 里那次**保留**作安全网（幂等，正常情况下是空操作、不会多画一帧）。
       * 也**不报进度**：否则宿主看到的 `phase` 序列会多一条（`test/export.spec.ts` 钉着）。
       */
      restoreCapture();

      progress('正在编码图片…', 'encode');
      const raw = await new Promise<Blob | null>((resolve) => {
        try {
          // 质量只对 JPEG 有意义（PNG 无损，传了也被浏览器忽略），所以只给 JPEG 传
          out.toBlob((b) => resolve(b), mime, format === 'jpeg' ? JPEG_QUALITY : undefined);
        } catch (err) {
          console.warn('[mapbox-sketch] canvas.toBlob 失败', err);
          resolve(null);
        }
      });
      if (!raw) throw new Error('浏览器未能把画布编码成图片（canvas.toBlob 没有得到结果）。');

      // ★ dpi 写进**文件本身**：canvas 编码出来的 PNG / JPEG 不带任何分辨率信息，
      //   不写的话 Photoshop / Word 一律按 72 dpi 排版，「300dpi 导出」就只剩下
      //   「像素多」这一个意思了。
      const bytes = new Uint8Array(await raw.arrayBuffer());
      const stamped = format === 'jpeg' ? applyJpegDpi(bytes, plan.dpi) : applyPngDpi(bytes, plan.dpi);

      exportOk = true;
      return {
        // `as unknown as BlobPart`：Uint8Array 视图在运行时本来就是合法的 BlobPart，
        // 这里过不去纯粹是 lib.dom 的 Uint8Array<ArrayBufferLike> 与 ArrayBuffer
        // 的型变问题（SharedArrayBuffer 不在 BlobPart 里）
        blob: new Blob([stamped as unknown as BlobPart], { type: mime }),
        // ★ 整页尺寸（含四边外边距）。没传 `margin` 时 `deco` 与 `plan` 的 outW/outH 相等，
        //   老调用方读到的数与以前逐字节相同。
        width: deco.width,
        height: deco.height,
        // 只在真的有外边距时给地图区矩形：没传 margin 时它就是整张图，没有信息量
        ...(hasMargin
          ? { mapRect: { x: deco.mapX, y: deco.mapY, w: plan.outW, h: plan.outH } }
          : {}),
        dpi: plan.dpi,
        mime,
        baseDrawn,
        warnings,
      };
    } finally {
      // ★ 顺序有讲究：先把渲染态还原并重画（屏幕上那张覆盖层立刻回到正常清晰度），
      //   再拆隐藏地图 —— 反过来的话中间会有一小段「画布还是出图尺寸、但渲染倍率
      //   已还原」的错位。正常情况下上面已经提前还原过，这里是幂等的空操作。
      restoreCapture();
      if (hidden) {
        try { hidden.remove(); } catch (err) { console.warn('[mapbox-sketch] 移除隐藏地图失败', err); }
      }
      if (holder && holder.parentNode) holder.parentNode.removeChild(holder);
      // 整张缓存只在「完整成功」后保留给下一块复用；半途失败的那份底图不可信，释放
      if (whole && !exportOk) this._dropWholeTileCache();
      this._exporting = false;
    }
  }

  /**
   * 建那张「离屏的同款地图」：容器尺寸与 zoom 都按 `plan.scale` 放大，
   * 于是它看到的**地理范围**与可见地图完全一致（就取景框那么宽），但像素多 `scale` 倍。
   *
   * ★ `center` / `padding` 抄可见地图的**原值**（padding 乘 scale），不要「顺手修正」成
   *   `unproject(框心)` 或归零。理由是一条恒等式：隐藏地图容器 = `取景框 × scale`、
   *   zoom 抬高 `log2(scale)`、padding 同比放大时，被覆盖的那块窗口的左边界正好是
   *   `(容器宽 − 取景框宽) / 2` —— **padding 项整体消掉了**，与 `plan.frameX/frameY`
   *   逐像素一致。所以纸框天然居中在容器上，宿主有没有 padding 都对。
   *   把 padding 归零会让有 padding 的宿主（左侧抽屉 / 图例预留）把纸框整体偏
   *   `(P.左 − P.右) / 2`，而 demo 零 padding 根本看不出来。
   *
   * ★ 容器尺寸必须是 `取景框 × scale`，**别**偷懒改成「容器仍按视口建、合成时用
   *   `drawImage` 裁一块出来」：那样画布像素数就不再等于 `planExport` 规划的
   *   `outW × outH`，而是「视口 × scale」—— 与要的那张纸无关。反例：4K 容器
   *   (3840×2160) + A4 竖 @300dpi，真正的输出只有 2480×3508，却要建
   *   12000×6750 ≈ 8100 万像素 ≈ 324MB 的画布，多出来的部分裁掉就扔。
   *
   *   注：2026-09-15 起导出**不再有尺寸上限**（见 `export-image.ts` 文件头），所以
   *   「尺寸太大」这一关现在是浏览器替我们守 —— 但「画布正好是输出那么多像素」这条
   *   仍然必须靠容器尺寸来保证。
   *
   * @returns `shift` = 相机被 mapbox 拉回世界内造成的**内容位移**（画布像素，要传给
   *   `drawImage` 补回来）。零位移是常态。
   */
  private _createExportMap(
    map: MapboxMap,
    plan: ReturnType<typeof planExport>,
    hd: boolean,
    xf?: ExportImageOptions['transformStyle'],
  ): { map: MapboxMap; holder: HTMLElement; shift: ExportShift } {
    const scale = plan.scale;
    const cssW = plan.frameW;
    const cssH = plan.frameH;
    const holder = document.createElement('div');
    holder.setAttribute('aria-hidden', 'true');
    /*
     * ★ 必须是 `opacity: 0`，不能图省事用 `display:none` / `visibility:hidden`：
     *   `display:none` 的元素 `clientWidth` 是 0（地图算不出画布尺寸），
     *   `visibility:hidden` 则有被浏览器跳过渲染的风险。`opacity:0` 的元素
     *   照常参与布局、照常跑 rAF，只是看不见。
     */
    holder.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;'
      + 'z-index:-1;overflow:hidden;'
      + `width:${Math.max(1, Math.round(cssW * scale))}px;`
      + `height:${Math.max(1, Math.round(cssH * scale))}px;`;
    document.body.appendChild(holder);

    const zoom = map.getZoom();
    const padding = map.getPadding();
    /*
     * ★ 窗口对准取景框有**两条路**，由 `plan.offset`（取景框中心相对视口中心的偏移）
     *   是否为 0 决定 —— 分块导出时取景框不在视口中心上，老办法就失效了。
     *
     *   老路径（`offset` 为 0，整张不切）：「容器 = 取景框 × scale + center 抄可见地图
     *   + padding × scale + zoom + log2(scale)」这条恒等式让窗口**正好**落在取景框上。
     *   一个字都别动 —— 所有既有导出都走这里，逐字节不变是硬要求。
     *
     *   新路径（偏心）：隐藏地图的内容只由「容器尺寸 + center + zoom」决定，容器尺寸
     *   已经定死成「块取景范围 × scale」，所以想让窗口偏移，**唯一的办法就是换 center**：
     *   把**框心**从屏幕坐标反投影成经纬度交上去。几个要点：
     *     · 必须用**可见地图**的 `unproject` —— `frameX/frameY/frameW/frameH` 本就是
     *       可见地图容器的坐标系（见 `ExportPlan`），而且隐藏地图此刻刚建出来、
     *       还没加载完，问它要坐标不可靠。
     *     · 框心可以落在容器**外**（A0 横放在 1920 窗口里，块心可能在 x = −163），
     *       `unproject` 对整个平面成立，不要求点在容器内，与 zoom 也无关。
     *     · `padding` 一并**归零**：新路径不依赖上面那条恒等式，窗口严格以 `center`
     *       为中心、与 padding 无关。留着 padding 反而会让窗口整体偏
     *       `(padL − padR)/2`，把这一块和邻块错开 —— 那是最难查的一类接缝。
     */
    const eccentric = plan.offset.x !== 0 || plan.offset.y !== 0;
    /** 我们**申请**的中心（下面要拿它和 mapbox 实得的中心对差，见 `shift` 那段） */
    const asked = eccentric
      ? map.unproject([plan.frameX + plan.frameW / 2, plan.frameY + plan.frameH / 2])
      : map.getCenter();
    const options: ExportMapOptions = {
      container: holder,
      /*
       * ★ 底图清晰度只有**这一处分叉**（`hd: false` = 不导出高清底图）。
       *
       * 隐藏地图的 zoom 必须抬高 `log2(scale)` —— 那是「地理范围不变、像素多 scale 倍」
       * 的全部机制，动不得。于是想要「不另下更深一级的瓦片、拿屏幕上现成的那一级放大」，
       * 唯一的入口就是把源的 `maxzoom` 压到**可见地图当前那一级**（`capStyleSourceZoom`）。
       * 压完之后隐藏地图照旧按抬高后的 zoom 建、照旧逐像素对齐，只是底图的详略度
       * 停在当前层级 —— 快是真的快（那些瓦片浏览器早就有了），糊也是真的糊。
       *
       * ★ `transformStyle`（宿主钩子）在 maxzoom 压制**之后**跑：它要对付的是另一件事
       *   —— 样式里屏幕像素单位的值不随「容器放大 + zoom 抬高」变大（线宽 / 图标 /
       *   文字在高 dpi 下不跟着放大），宿主得自己乘 scale。两步变换互不搭界。
       */
      style: (() => {
        const base = hd ? map.getStyle() : capStyleSourceZoom(map.getStyle(), zoom);
        return xf ? xf(base) : base;
      })(),
      center: asked,
      // 地理范围不变的换算：容器放大 s 倍 ⇒ zoom 抬高 log2(s)
      zoom: zoom + Math.log2(scale),
      bearing: map.getBearing(),
      pitch: map.getPitch(),
      // `|| 0`：mapbox 的 Padding 类型把四个边都标成了可选
      padding: eccentric
        ? { top: 0, right: 0, bottom: 0, left: 0 }
        : {
            top: (padding.top || 0) * scale,
            right: (padding.right || 0) * scale,
            bottom: (padding.bottom || 0) * scale,
            left: (padding.left || 0) * scale,
          },
      // ★ 必须抬高：补偿后的 zoom 可能超过原 maxZoom，被夹掉的话隐藏地图看到的
      //   范围就和可见地图不一样了 —— 导出图的底图会比标注层「缩水」，逐像素错位
      maxZoom: Math.max(map.getMaxZoom(), zoom + Math.log2(scale) + 1),
      // ★ 必须开：否则（WebGL 的默认行为）画面缓冲在读之前就被丢弃，读回来是全透明
      preserveDrawingBuffer: true,
      interactive: false,
      attributionControl: false,
      fadeDuration: 0,
      accessToken: readAccessToken(map),
    };

    let made: unknown;
    try {
      const create = this._opts && this._opts.createMap;
      made = create
        ? create(options)
        // 兜底：用宿主自己那份 mapbox-gl 的构造器。库不 import mapbox-gl（零依赖），
        // 这样也不存在「两份 mapbox-gl 打架」的问题，宿主的 accessToken 全局值也照常生效
        : new ((map as unknown as { constructor: new (o: ExportMapOptions) => MapboxMap }).constructor)(options);
    } catch (err) {
      throw new Error(
        '创建隐藏地图失败：' + (err instanceof Error ? err.message : String(err))
        + '。可以通过 SketchOptions.createMap 自行提供构造器。',
      );
    }

    const cand = made as Partial<MapboxMap> | null;
    const usable = !!cand
      && typeof cand.on === 'function' && typeof cand.once === 'function'
      && typeof cand.getCanvas === 'function' && typeof cand.remove === 'function';
    if (!usable) {
      throw new Error(
        '隐藏地图构造器返回的对象不像一个 mapboxgl.Map（缺 on / once / getCanvas / remove）。'
        + '请通过 SketchOptions.createMap 显式提供构造器。',
      );
    }

    /*
     * ★ 把可见地图上**运行期注册的图片**（`map.addImage` 的那些 —— 专题页的方块点
     *   图标就是）搬到隐藏地图上。
     *
     * 为什么必须搬：`addImage` 的图标**不在 `getStyle()` 的序列化结果里**（那里面
     * 只有 sources / layers），上面那份 style 抄得再全也带不走它们 —— symbol 层
     * 拿不到 `icon-image` 就整层不画，导出图上的点位凭空消失（2026-09-22 实测）。
     *
     * ★ 用**公开 API** `map.getImage(id)` 读回：`StyleImage` 能直接喂 `addImage`，
     *   不用手搓 `{data,width,height}`，跨 mapbox 版本更稳。上一版走的是
     *   `style.imageManager.getImage(id)` —— 那条要带 `scope` 参数，漏了就按 scope
     *   不匹配返回 `undefined`，图标照样搬不过来（导出就是丢图标）。
     *   全程防御：读不到 / 结构变了就跳过 —— 少个图标不该让整次导出失败。
     */
    try {
      const host = map as unknown as {
        listImages?: () => string[];
        getImage?: (id: string) => {
          data: Uint8ClampedArray | Uint8Array; width: number; height: number;
          pixelRatio?: number; sdf?: boolean;
        } | null | undefined;
        hasImage?: (id: string) => boolean;
      };
      const sink = cand as unknown as {
        addImage?: (id: string, image: unknown, opts?: { pixelRatio?: number }) => void;
        hasImage?: (id: string) => boolean;
      };
      if (typeof host.listImages === 'function'
        && typeof host.getImage === 'function'
        && typeof sink.addImage === 'function') {
        for (const name of host.listImages()) {
          if (sink.hasImage && sink.hasImage(name)) continue;
          const img = host.getImage(name);
          if (!img || !img.width || !img.height) continue;
          // StyleImage 自带 pixelRatio / sdf，`addImage` 直接认，不另传 options
          sink.addImage(name, img);
        }
      }
    } catch { /* 内部结构对不上：跳过图片搬运，导出照常走 */ }

    /*
     * ★ 画布被浏览器 / 显卡驱动**悄悄钳小**了，就当场停下。
     *
     * 超上限时浏览器**不报错**，只把 WebGL 的绘制缓冲钳到上限 —— `canvas.width/height`
     * 仍然是我们申请的那个数，`drawingBufferWidth/Height` 才是真在用的。2026-09-22 实测：
     *
     *   · 9934×14044 的画布（A0 竖 @300dpi 的「整张」）→ 绘制缓冲只有 **4967×7022**
     *     （面积约 1/4，浏览器自己缩的），画布上只有左上角那块是真渲染过的；
     *   · 软渲染（SwiftShader，`MAX_TEXTURE_SIZE = 8192`）下 8192×8192 更是**直接拿不到上下文**。
     *
     * 后果是「导出成功、图却大片空白或错位」—— 倾斜分块那条路（整张渲染 + 裁块）
     * 尤其致命：四个角里只有左上角是真的。这种图能正常打开、看着还挺像样，
     * 比报一句错难查一百倍，所以宁可在建图这一步就拦下来。
     */
    const canvas = (cand as MapboxMap).getCanvas();

    /*
     * ★★ 相机被 mapbox「拉回世界内」了 —— 画面内容会比该在的位置整体偏，必须补回来。
     *
     * `Transform#_constrain()` 里**与容器尺寸有关**的三条硬约束（实测 3.22，压缩产物里
     * 那段；界都是 `Transform#scale` = 世界在当前 zoom 下有多少 CSS 像素）：
     *
     *     if (r - c < h) a = h + c;      // 视口上边越出世界 → 把中心往下压
     *     if (r + c > d) a = d - c;      // 视口下边越出世界 → 把中心往上压
     *     if (d - h < this.height) {     // 世界比视口还矮 → 抬高 zoom 并把中心钉在世界正中
     *       n = this.height / (d - h); a = (d + h) / 2;
     *     }
     *
     * 前两条只是**平移**：相机挪了，而容器尺寸与缩放都没变，画面内容跟着整体偏 —— 算出差值
     * 再平移回来是**精确**的逆（前提是世界装得下取景范围）。
     * 第三条是真换了缩放（`zoom += scaleZoom(n)`），平移救不回来；那种情况已被
     * `exportImage` 开头那道守卫拦在建图之前 —— 能走到这里的，取景范围一定装得下世界。
     *
     * ★ 2026-09-22 实测（A0 竖 @300、zoom 2.5、分块 2×2）：申请中心 lat 83.0 → 实得 lat 37.38、
     *   申请 lat −75.77 → 实得 −37.38，正是「把上/下边顶回世界内」的那一下；两块各渲染
     *   140° 纬度 ⇒ 同一片大陆出现两遍。（那个配置整张纸已超出世界，现在直接报错。本条平移
     *   管的是「整张装得下、但这一块的位置探出世界」—— 例如视口压在极圈上时的上下两块。）
     *
     * 符号（唯一容易写反的一处）：屏幕 y = 容器高/2 + (墨Y(点) − 墨Y(相机)) × 世界高，而
     * 墨Y 向南增大。于是「实得相机比申请相机偏南」⇒ 内容整体偏**北**（画到了该在的位置上方）
     * ⇒ 要把它**往下推**正量：dy = (墨Y(实得) − 墨Y(申请)) × 世界高。横向同理（lng 向东增大）：
     * dx = (lng实得 − lng申请)/360 × 世界宽。
     */
    const shift: ExportShift = { dx: 0, dy: 0 };
    try {
      const got = (cand as MapboxMap).getCenter();
      const ad = asked as { lng: number; lat: number };
      if ([got.lng, got.lat, ad.lng, ad.lat].every((v) => typeof v === 'number' && Number.isFinite(v))) {
        // 世界在**画布像素**里的边长：世界 = `TILE_PX × 2^zoom` 个 CSS 像素，再乘「每个
        // 取景框 CSS 像素对应几个画布像素」（从画布实际宽度反推，顺带吸收取整与 dpr 的零头）。
        const perCss = canvas.width / Math.max(1, plan.frameW);
        const worldPx = worldPxAt(zoom) * perCss;
        // 墨卡托纵坐标的「世界比例」（0 = 北极、1 = 南极，向南增大）
        const mercY = (lat: number): number => 0.5
          - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / (2 * Math.PI);
        // ★ 经度差先折进 [−180, 180)：`LngLat` 会把 lng 绕回 ±180 内，而偏心分块申请的
        //   框心**可以**落在 ±180 之外（`unproject` 对整个平面成立）。不折的话
        //   「申请 190 → 实得 −170」会被算成整整一圈（凭空平移一整个世界宽）。
        const dLng = ((got.lng - ad.lng + 540) % 360) - 180;
        const dx = (dLng / 360) * worldPx;
        const dy = (mercY(got.lat) - mercY(ad.lat)) * worldPx;
        if (Number.isFinite(dx) && Number.isFinite(dy)) {
          shift.dx = dx;
          shift.dy = dy;
        }
      }
    } catch { /* 读不到中心就当没偏移：老行为，不额外报错 */ }

    const ctxOf = canvas as unknown as { getContext?: (t: string) => unknown };
    const gl = (typeof ctxOf.getContext === 'function'
      ? ctxOf.getContext('webgl2') ?? ctxOf.getContext('webgl')
      : null) as { drawingBufferWidth: number; drawingBufferHeight: number } | null;
    if (gl && canvas.width > 0 && canvas.height > 0
      && (gl.drawingBufferWidth < canvas.width || gl.drawingBufferHeight < canvas.height)) {
      throw new Error(
        `这次导出要建 ${canvas.width}×${canvas.height} 像素的画布，但浏览器只给了 `
        + `${gl.drawingBufferWidth}×${gl.drawingBufferHeight} 的绘制缓冲（超出了画布上限；`
        + '超限时浏览器不报错、只把缓冲钳小）。照这样导出来的图会大片空白或错位，所以就此停下。'
        + '请把 dpi 降一档、或换更小的纸张；分块导出请把地图设为正俯视（pitch 0）——'
        + '正俯视下逐块导出精确、也不需要建这么大的画布。',
      );
    }
    return { map: cand as MapboxMap, holder, shift };
  }

  /**
   * 倾斜导出的 **fov 补偿**：把隐藏地图的每像素角分辨率校准到「可见地图 ÷ plan.scale」。
   *
   * 背景：mapbox 把**垂直 fov 定死、水平尺度交给容器宽高比**（`TILE_TILT_EPS` 注释）。
   * 隐藏地图的容器是「取景框 × scale」—— 框高 ≠ 视口高时，照抄相机的隐藏地图
   * 每像素角分辨率与可见地图对不上，pitch>0 时整个画面系统性错位（实测 96~694px）。
   * 修法只有一行：fov' = `2·atan(tan(fov/2) × 框高/视口高)`，让两条路重新逐像素一致。
   *
   * 2026-09-21 实测（真 mapbox-gl 3.22 + headless Chrome，pitch 0/30/45 × 框=视口/纸比
   * 视口大 × 带 bearing / 带 padding）：补偿后每一格的投影错位全部 ≤ 0.25px（取整零头）。
   *
   * ★ 只在 `|pitch| > TILE_TILT_EPS` 时由调用方进入；框高 = 视口高时 fov' ≡ fov，
   *   直接返回 —— 碰 mapbox 内部结构（`map.transform.fov`，`set fov` 会自己
   *   `_calcMatrices`）的次数越少越好。读不到 / 设不上 / 被 mapbox 钳制（fov 允许
   *   0.01–60°，纸比视口大太多时会撞上限）都**明确抛错**，绝不默默出错的图。
   */
  private _compensateExportFov(
    map: MapboxMap,
    hidden: MapboxMap,
    p: ReturnType<typeof planExport>,
    cssH: number,
  ): void {
    const ratio = p.frameH / cssH;
    if (Math.abs(ratio - 1) < 1e-6) return;
    const vT = (map as unknown as { transform?: { fov?: unknown } }).transform;
    const fovV = vT && typeof vT.fov === 'number' ? vT.fov : NaN;
    const hT = (hidden as unknown as { transform?: { fov?: unknown } }).transform;
    if (!Number.isFinite(fovV) || !hT || typeof hT.fov !== 'number') {
      throw new Error(
        '倾斜视角下导出比视口更大/更小的取景框，需要读取并调整隐藏地图的 fov，'
        + '但当前 mapbox-gl 版本没有暴露 map.transform.fov（内部结构变了）。'
        + '请把地图设为正俯视（pitch 0）后重试 —— 正俯视下不需要这个补偿。',
      );
    }
    const deg = 2 * Math.atan(Math.tan((fovV / 2) * Math.PI / 180) * ratio) * 180 / Math.PI;
    try {
      hT.fov = deg;
    } catch (err) {
      throw new Error(
        '倾斜视角下导出需要调整隐藏地图的 fov，但设置失败（'
        + (err instanceof Error ? err.message : String(err)) + '）。'
        + '请把地图设为正俯视（pitch 0）后重试。',
      );
    }
    if (typeof hT.fov !== 'number' || Math.abs(hT.fov - deg) > 1e-6) {
      throw new Error(
        `倾斜视角下导出这张取景范围需要把隐藏地图的 fov 设为 ${deg.toFixed(1)}°，`
        + '超出 mapbox 允许的 0.01–60° 范围（取景框与视口差得太多）。'
        + '请把地图设为正俯视（pitch 0）后重试 —— 正俯视下任意大小的取景范围都精确。',
      );
    }
  }

  /**
   * 整张渲染缓存的指纹：视角（center / zoom / bearing / pitch）+ 底图样式 + 缩放参数。
   * 任何一项变了，缓存的下一次命中自然失败 → 重建，绝不会把旧底图带进新图里。
   */
  private _wholeTileKey(map: MapboxMap, p: ReturnType<typeof planExport>, dpr: number, hd: boolean): string {
    const c = map.getCenter();
    return JSON.stringify([
      'whole-tile-v1',
      c ? c.lng : null, c ? c.lat : null,
      map.getZoom(), map.getBearing(), map.getPitch(),
      dpr, p.dpi, p.frameW, p.frameH, p.outW, p.outH,
      // ★ `hd` 必须进 key：它决定隐藏地图用的是「另下深层瓦片」还是「现成的那一级」，
      //   两次导出如果只差这一个开关就会命中同一张缓存 —— 那等于开关不起作用
      //   （先高清后不糊、先不糊后高清，两种都错，而且只在同一次会话里出现）。
      hd,
      map.getStyle(),
    ]);
  }

  /** 释放整张渲染缓存（隐藏地图 + 它的离屏容器）。幂等，任何时候调用都安全。 */
  private _dropWholeTileCache(): void {
    const cached = this._wholeTileCache;
    this._wholeTileCache = null;
    if (!cached) return;
    try {
      cached.map.remove();
    } catch (err) {
      console.warn('[mapbox-sketch] 释放整张底图缓存失败', err);
    }
    if (cached.holder.parentNode) cached.holder.parentNode.removeChild(cached.holder);
  }

  /**
   * 等一张地图的底图**下完**（`exportImage` 前的两步：可见地图一次、隐藏地图一次）。
   *
   * **判据就是 `map.loaded()` / `idle` 事件**，两者在 mapbox-gl 里是同一个条件
   *   （`idle() { return !this.isMoving() && this.loaded() }`），而 `loaded()` 要求
   *   `style.loaded()` —— 后者会逐个 source cache 检查 `_tiles` 里**所有已知瓦片**
   *   都到了（`errored` 也算「到了」）。所以「等一声 `idle`」本来就是对的口径，
   *   别再自己拼一套 `areTilesLoaded()` 之类的条件了。
   *
   * **★ 没有超时，一直等到下完为止 —— 这是刻意的，别加回去。**
   *   曾经这里是「可见地图 + 隐藏地图**合起来** 8 秒封顶」，后果是每次高清导出都必然
   *   超时、拿半张底图出图：成品中心有一块影像、四周是透明的阶梯形空白（瓦片是**从
   *   中心往外**下的，所以先到的正好是中间那圈），而且只留一句告警、不报错 ——
   *   看起来就像「导出成功了，可图是坏的」。原因很简单：300dpi 要在隐藏地图里
   *   **从零另下**一百多块高 z 瓦片（同一片区域、像素多 3 倍，瓦片也就多几倍），
   *   这块 ArcGIS 服务实测约 1 秒/块就是两分钟，而**各家的带宽差得很远，慢的还要更久**。
   *   拿不准该等多久的东西，就别猜：用户点导出要的就是「等数据全部加载完再导出」。
   *
   *   那「服务挂了呢，岂不是永远等下去」？不会：瓦片请求**失败**（连不上 / 404 /
   *   连超时）在 mapbox 里也算终态，`loaded()` 照样会变真、照常出图（那种图的底图
   *   是空的，由 `_probeBasemap` 那条路告警）。真正会拖长的只有「连着但迟迟不回」，
   *   而那也是浏览器先超时。
   *
   * 进度从哪来：mapbox 每下完一块瓦片都会在**地图**上发一个 `data` 事件
   *   （`SourceCache._tileLoaded` → `source.fire('data')` → 冒泡到 Style → 再冒泡到 Map，
   *   因为库里给两者都 `setEventedParent` 了；地图再转发成 `data` / `sourcedata`）。
   *   收着它只为报进度 —— 等待动辄几十秒到几分钟，遮罩上那行字一动不动的话，
   *   用户会以为它死了。**别把这个监听「收紧」成只认瓦片事件**（`e.dataType === 'source'`）：
   *   万一 mapbox 改了事件形状，过滤错的后果是**少报进度**，不值得为这点精度冒险。
   *   （mapbox **没有**「一块瓦片开始请求」的事件，能听到的只有「下完了」，
   *   所以进度是「已完成 / 已知总数」而不是「已发请求」—— 对进度条来说没有区别。）
   *
   * 快路：`loaded()` 已经是 true 就直接返回，一秒都不等 —— 绝大多数导出走这条路。
   *   ★ 刚建出来的隐藏地图不会误判成「下完了」：那时 `_sourcesDirty` 还是 true
   *   （构造时样式数据事件刚把它置上），而且它一块瓦片都还没请求。
   *
   * @param what '可见地图' = 屏幕上那张（等它既是为了「所见即所得」，也是为了 `getStyle()`
   *             能拿到一份**完整**的样式）；'隐藏地图' = 出图时另建的那张。
   * @param progress 中文进度回调；本方法会先报一句「正在等待…」，等待期间再报已等时长
   *                 （数得出瓦片时还跟一个整次导出的进度百分比，如「已等 23 秒 · 66%」；
   *                 时长由 `fmtElapsed` 格式化成「3 分 5 秒」，不是一串裸秒数）。
   */
  private _waitBasemapReady(
    map: MapboxMap,
    what: '可见地图' | '隐藏地图',
    progress: (msg: string, phase: ExportPhase, tiles?: ExportTiles) => void,
  ): Promise<void> {
    const base = what === '可见地图' ? '正在等待地图加载…' : '正在等待底图瓦片…';
    const phase: ExportPhase = what === '可见地图' ? 'waitVisible' : 'waitTiles';
    progress(base, phase);

    // 宿主交给我们的不一定是 mapbox-gl（测试替身、宿主自造的地图）：问不出「下完没」
    const askable = typeof map.loaded === 'function'
      && typeof map.on === 'function' && typeof map.off === 'function';
    if (!askable) {
      // 可见地图直接放行 —— 什么都问不出来，就不能拿它拦着导出
      if (what === '可见地图') return Promise.resolve();
      // 隐藏地图退回「等一次 `idle`」：`once` 一定在（`_createExportMap()` 要求它有）
      return this._waitIdleOnce(map);
    }
    if (map.loaded()) return Promise.resolve();          // 早下完了：一秒都不等

    return new Promise<void>((resolve) => {
      const startedAt = Date.now();
      /** 上次报出去是什么时候 / 报的是什么，用来节流（见下面 `report`） */
      let lastAt = 0;
      let lastKey = '';
      /**
       * 报一次进度。
       *
       * 节流到 250ms：300dpi 那一轮有一百多块瓦片、每块都可能来一个 `data`，
       * 一次不落地报出去的话宿主的进度条一秒要重画几十次（每次还得重新数一遍瓦片表）。
       * 250ms 是「看着是连续在动」与「别白干活」之间的折中。
       */
      const report = (): void => {
        const now = Date.now();
        const sec = Math.floor((now - startedAt) / 1000);
        const tiles = this._countTiles(map);
        // 文案只报百分比不报块数：用户要的是「还剩多少」，不是「分母是几」。
        // 原始块数照样从 `ExportProgress.tiles` 给出去（宿主想自己算、自己写都行）
        //
        // ★ 百分比前面**不写「底图」**（曾经写的是「底图 66%」，用户 2026-09-15 让去掉）：
        //   等待这一段占的就是整次导出的绝大部分时间，而这个数正是**整次导出的进度** ——
        //   标成「底图」反而让人以为后面还有别的进度、或者以为标注层不算在里面。
        //   叠了几张底图也一样：数的是**全部** source cache，报的就该是总的那个数。
        const pct = tiles ? Math.round((tiles.loaded / tiles.total) * 100) : null;
        // ★ 节流与去重仍然按**秒**算，不按格式化后的字符串：一句话里的时长可能整整
        //   一分钟都长一个样（「已等 3 分」），拿它去重会让分钟位跳动的那一秒被吞掉。
        const key = `${sec}|${pct == null ? '' : pct}`;
        if (key === lastKey) return;                     // 秒数和百分比都没变：没什么可说的
        if (now - lastAt < 250) return;
        lastKey = key;
        lastAt = now;
        const waited = fmtElapsed(now - startedAt);
        progress(
          pct == null ? `${base}（已等 ${waited}）` : `${base}（已等 ${waited} · ${pct}%）`,
          phase,
          tiles || undefined,
        );
      };
      const onData = (): void => { report(); };
      /*
       * ★ 光靠 `data` 报进度是不够的：瓦片**断流**（服务连上了、却迟迟不回）时一个事件
       *   都不会来，那行字会永远停在「已等 42 秒」—— 明明还在等，看起来却像死了。
       *   再挂一根 1 秒的心跳，只为让秒数一直往上走。
       *   （它**不影响等多久**：什么时候收工仍然只看 `loaded()`，没有任何上限。）
       */
      const heart = setInterval(report, 1000);
      // 收到 `idle` 再复查一次 `loaded()` 才收工：真 mapbox 上两者等价，但宿主自造的
      // 地图未必守这个规矩，多问一句不会有损失（问了不真就继续等，反正不设超时）
      const onIdle = (): void => {
        if (!map.loaded()) return;
        clearInterval(heart);
        map.off('data', onData);
        map.off('idle', onIdle);
        resolve();
      };
      map.on('data', onData);
      map.on('idle', onIdle);
    });
  }

  /**
   * 数一下这张地图的底图瓦片进度：`{ loaded, total }`；**数不出来就返回 `null`**。
   *
   * 数不出来有几种正常情况：宿主给的是测试替身 / 自己包过的地图（没有 `style`）、
   * 样式还没就绪、或者一块瓦片都还没请求（`total === 0`）。这时进度文案里就不带数字，
   * 宿主的进度条退回不确定态 —— 有数字是锦上添花，没有也照样导出。
   *
   * ★ 「算下完」的口径**必须和引擎等的那个条件一致**：mapbox 的 `areTilesLoaded()`
   *   就是「每块瓦片的 state 都是 `loaded` 或 `errored`」，而 `Tile.loaded()` 正是这两个。
   *   照着它抄，进度条才会**刚好在等待结束的那一刻**走到 100%；自己换一套口径
   *   （比如把 `empty` 也算成下完）就会出现「条满了，可它还在等」。
   *
   * 读的是 mapbox 的私有瓦片表（`style.getSourceCaches()` 是公开方法，**`_tiles` 不是**，
   * 只是恰好在 `.d.ts` 里躺着）：所以这里只读、`try` 全包、拿不到就当没有。
   * 进度显示再怎么样也不能反过来影响导出 —— 哪天 mapbox 改了字段名，最多是没有进度条，
   * 不会出不了图。**别为了「更准」在这里写任何有副作用的调用。**
   */
  private _countTiles(map: MapboxMap): ExportTiles | null {
    try {
      const style = (map as unknown as { style?: { getSourceCaches?: () => unknown } }).style;
      const caches = style && typeof style.getSourceCaches === 'function'
        ? style.getSourceCaches() : null;
      if (!Array.isArray(caches)) return null;

      let loaded = 0;
      let total = 0;
      type TileLike = { loaded?: () => boolean; state?: string };
      for (const cache of caches as Array<{ _tiles?: Record<string, TileLike> }>) {
        const tiles = cache && cache._tiles;
        if (!tiles) continue;
        for (const id in tiles) {
          const tile = tiles[id];
          if (!tile) continue;
          total += 1;
          const done = typeof tile.loaded === 'function'
            ? tile.loaded()
            : tile.state === 'loaded' || tile.state === 'errored';
          if (done) loaded += 1;
        }
      }
      return total > 0 ? { loaded, total } : null;
    } catch {
      return null;                                        // 形状跟预期不同：当没有就是了
    }
  }

  /**
   * 问不出「下完没」的地图（替身 / 宿主自造）退回用：等一次 `idle` 就算数。
   *
   * 这里也**不设超时** —— 但如果连监听都挂不上（`once` 抛错），只能立刻放行：
   * 那是一种「既问不出来、也等不到」的地图，卡在这儿比出一张没有底图的图更糟。
   */
  private _waitIdleOnce(map: MapboxMap): Promise<void> {
    return new Promise<void>((resolve) => {
      try {
        map.once('idle', () => resolve());
      } catch (err) {
        console.warn('[mapbox-sketch] 监听地图 idle 失败', err);
        resolve();
      }
    });
  }

  /**
   * 抽样探一下底图有没有真的画进来（读不到内容 = 透明的空画布）。
   *
   * `dx/dy` = 地图区在整页画布上的偏移（图廓整饰时非 0）：采样点必须落在地图区里 ——
   * 落在外边距那圈上永远读到透明，会把「底图好好的」误判成「没读回来」而多出一条告警。
   *
   * `background` = 导出底色（`ExportImageOptions.background`）。画布可能**已经被铺过底色**
   * （JPEG / 有图廓时引擎在探底之后用 `destination-over` 铺；相机被约束时补边也是先铺），
   * 铺过的画布 alpha 全是 255 —— 光看 alpha 永远判「画进来了」。所以「只剩底色」的
   * 像素也算没画：2026-09-22 实测，mapbox 3.22 在 token 校验失败后清空画布并停渲染
   * （`_revokeAuth`），成品整块地图区是白的，这条告警必须叫得出来。
   *
   * 误报代价可控：9 个采样点**全部**恰好等于底色才会误报，一张真底图做不到这么均匀。
   */
  private _probeBasemap(
    ctx: CanvasRenderingContext2D,
    outW: number,
    outH: number,
    dx = 0,
    dy = 0,
    background?: string | null,
  ): boolean {
    const bg = this._bgRgb(ctx, background);
    for (let i = 0; i < EXPORT_PROBE_GRID; i++) {
      for (let j = 0; j < EXPORT_PROBE_GRID; j++) {
        const x = dx + Math.min(outW - 1, Math.floor(outW * (0.125 + 0.25 * i)));
        const y = dy + Math.min(outH - 1, Math.floor(outH * (0.125 + 0.25 * j)));
        let d: Uint8ClampedArray;
        try {
          d = ctx.getImageData(x, y, 1, 1).data;
        } catch {
          // 画布被污染等原因读不了 → 当作「有内容」，宁可漏报也不误报
          return true;
        }
        // 透明 = 什么都没画
        if (d[3] <= 8) continue;
        // 只剩底色 = 底图没画（见方法注释）
        if (bg && d[0] === bg[0] && d[1] === bg[1] && d[2] === bg[2]) continue;
        // 有一个采样点有内容就算底图画进来了：瓦片之间的缝隙本来就是透的
        return true;
      }
    }
    return false;
  }

  /**
   * 把 CSS 颜色解析成 rgb 三元组（解析不了给 `null`，探底就退回只看 alpha）。
   *
   * 归一化借画布自己做（`fillStyle` 会把任何合法颜色规整成 `#rrggbb` / `rgba(...)`）。
   * 认没认出来用一个**哨兵色**判断：先赋透明黑再赋真值，赋完仍是透明黑 = 画布没认出
   * 这个值（赋不进去时 `fillStyle` 保持原值）。不用 `CSS.supports` —— jsdom 里未必有，
   * 而这里需要的只是「画布认不认得」，画布自己就是裁判。
   */
  private _bgRgb(ctx: CanvasRenderingContext2D, css?: string | null): [number, number, number] | null {
    const s = typeof css === 'string' ? css.trim() : '';
    if (!s) return null;
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0)'; // 哨兵：全透明，当底色没有意义
    ctx.fillStyle = s;
    const norm = String(ctx.fillStyle);
    ctx.restore();
    if (norm === 'rgba(0, 0, 0, 0)') return null;
    if (/^#[0-9a-f]{6}$/i.test(norm)) {
      return [parseInt(norm.slice(1, 3), 16), parseInt(norm.slice(3, 5), 16), parseInt(norm.slice(5, 7), 16)];
    }
    const m = /^rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(norm);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  }

  /**
   * 聚焦某图形（作为面板控件的作用对象）；id 不存在则忽略。聚焦即显示编辑手柄。
   * 隐藏中的图形不聚焦 —— 聚焦了也看不见手柄，不如干脆不接（同 `!has(id)` 的静默口径）。
   */
  focus(id: string): void {
    const s = this._shapes.get(id);
    if (!s || !this._shown(s)) return;
    this._focused = id;
    this.render();
    this._emit();
  }

  /** 退出编辑态（清空聚焦） */
  blur(): void {
    if (!this._focused) return;
    this._focused = null;
    this.render();
    this._emit();
  }

  /**
   * 全局开关「编辑」。
   *
   * `true`（默认）：点击已绘图形进入编辑 —— 显示顶点手柄、可拖手柄调整 / 拖主体
   *   整体平移、悬停给抓取光标（Esc 或点空白退出）。
   * `false`（纯浏览态）：点图形不选中、不出手柄、不可拖改、不给悬停光标；地图照常可平移。
   *   想调某图形的颜色等仍可走「已绘图形」列表选中它。
   */
  setEditing(on: boolean): void {
    this._assertAlive();
    this._editEnabled = !!on;
    if (!this._editEnabled) {
      this._endDrag();                         // 拖拽中关闭 → 结束会话并解锁地图平移
      this._hoverId = null;                    // 并去掉悬停高亮
      this._hoverVertex = null;                // 以及手柄的激活态（手柄这时也不画了）
    }
    this.render();                             // 立即隐藏 / 恢复聚焦图形的顶点手柄
  }

  /** 当前是否允许编辑（true = 可点图形改） */
  get editing(): boolean { return this._editEnabled; }

  /**
   * 全局开关「指针交互」。
   *
   * `true`（默认）：本实例照常响应地图上的点击 / 拖拽 / 键盘 —— 绘制、编辑、Esc/回车。
   * `false`：本实例**完全让出指针** —— 不落点、不选中、不拖拽、不响应 Esc/回车；
   *   已画图形照常显示（渲染循环不受影响），地图照常平移缩放。
   *
   * 典型场景是**同一张地图上跑两个实例**（如页面里已有的标注引擎 + 测量工具）：
   * 测量开始时把标注引擎 setInteractive(false)，免得测量期间的每次点击都同时被
   * 两套引擎解读（点中标注会莫名进入编辑、Esc 会串台）；测量结束后再开回来。
   * 关闭时会顺带退出进行中的绘制并取消聚焦，保证不存在「看不见但还活着」的会话。
   */
  setInteractive(on: boolean): void {
    this._assertAlive();
    if (this._interactive === !!on) return;
    this._interactive = !!on;
    if (!this._interactive) {
      this._exitDraw();                        // 绘制中关闭 → 退出绘制（恢复双击缩放 / 光标）
      this._endDrag();                         // 拖拽中关闭 → 结束会话并解锁地图平移
      if (this._focused) { this._focused = null; this.render(); this._emit(); }
    }
    this._emit();
  }

  /** 当前是否响应指针 / 键盘交互（true = 照常） */
  get interactive(): boolean { return this._interactive; }

  /**
   * 全局开关「绘制吸附」。
   *
   * `true`（默认）：手绘落点自动吸到**已有图形的顶点 / 边线**以及**当前图形已落点**上，
   *   光标附近出现记号提示（三种来源共用一个蓝色实心小圆点）。按住 **Alt** 可临时关掉这一次。
   * `false`：点哪儿是哪儿，不吸附也不画提示记号。
   *
   * 只管**手绘**；已提交图形的拖拽编辑（拖顶点 / 拖主体）不受影响。
   */
  setSnap(on: boolean): void {
    this._assertAlive();
    this._snapOn = !!on;
    if (!this._snapOn) {
      this._snap = null;                      // 关掉就别把上一帧的记号留在画布上
      this._snapEvt = null;
      if (this._snapRaf) { cancelFrame(this._snapRaf); this._snapRaf = 0; }
    }
    this.render();
  }

  /** 当前是否开启绘制吸附 */
  get snapping(): boolean { return this._snapOn; }

  /* ================================================================
   * 公开 API：显示 / 隐藏
   *
   * 三层粒度，各有用处：单个（列表里点眼睛）、按类型（先关掉整类看清底图）、
   * 全局总开关（一次全关）。三者都只改「画不画 + 参不参与交互」，
   * 不碰 `pts` / `cfg` / `style` —— 藏起来的数据随时原样回来。
   * ================================================================ */

  /**
   * 隐藏一个或一批图形。隐藏 = **完全退出交互**：不画、不悬停命中、
   * 不当手绘吸附目标、不可拖。只做「不画」是不行的 —— 藏起来的图形还会截走点击，
   * 用户会以为程序坏了。
   *
   * 隐藏聚焦中的那个会自动退出聚焦（否则一圈顶点手柄会浮在看不见的图形上）；
   * 正在被拖的那个会立即结束拖拽（否则 `_dragTo` 会一直改一个看不见的图形的 `pts`）。
   *
   * @param target 图形 id，或 id 数组
   */
  hide(target: string | string[]): void {
    this._assertAlive();
    this._setHidden(target, true);
  }

  /** 显示一个或一批图形（`hide()` 的逆操作，恢复绘制与全部交互） */
  show(target: string | string[]): void {
    this._assertAlive();
    this._setHidden(target, false);
  }

  /** 隐藏某个**类型**的全部图形（如先把「距离标注」整类关掉看清底图） */
  hideType(type: string): void {
    this._assertAlive();
    this._setHiddenByType(type, true);
  }

  /** 显示某个类型的全部图形 */
  showType(type: string): void {
    this._assertAlive();
    this._setHiddenByType(type, false);
  }

  /** 该图形是否被隐藏（只看它**自己**的开关，不含全局总开关）；id 不存在返回 false */
  isHidden(id: string): boolean {
    const s = this._shapes.get(id);
    return !!s && !!s.hidden;
  }

  /**
   * 全局「显示标注」总开关。
   *
   * `false`：所有**已提交**图形一律不画、也不参任何交互（悬停 / 点选 / 拖拽 / 吸附），
   *   地图本身照常可平移缩放 —— 「先关掉所有标注，看清底图」。
   * `true`（默认）：恢复。
   *
   * ★ 它**从不写回** `shape.hidden`：关掉再打开，原先被单独隐藏的那几条仍然是隐藏的。
   *   也**不影响**手绘预览与吸附记号 —— 那是「正在操作」的反馈，藏掉会像卡死。
   */
  setVisible(on: boolean): void {
    this._assertAlive();
    this._visibleAll = !!on;
    if (!this._visibleAll) this._dropHiddenInteractions();
    this.render();                             // 立即见效（同 setEditing / setSnap）
  }

  /** 全局「显示标注」总开关当前是否开着 */
  get visible(): boolean { return this._visibleAll; }

  /**
   * 改一批图形的隐藏状态。
   *
   * 循环里**只改数据、不重绘**，循环外统一 `requestRender()` + `_emit()` ——
   * 在循环里 `render()` 是 O(N²)，与 `push()` 那个坑完全一样（见 `push` 上的注释）。
   * 用 `requestRender()` 还让「push 一个就 hide 一个」的灌数据写法天然合帧，
   * 不会先闪一帧再消失。
   */
  private _setHidden(target: string | string[], on: boolean): void {
    const ids = Array.isArray(target) ? target : [target];
    let changed = false;
    for (const id of ids) {
      const s = this._shapes.get(id);
      if (!s) continue;                        // 不存在的 id 静默跳过（同 remove 的口径）
      if (!!s.hidden === on) continue;
      s.hidden = on;
      changed = true;
    }
    if (!changed) return;
    if (on) this._dropHiddenInteractions();
    this.requestRender();
    this._emit();
  }

  /** 改某个类型全部图形的隐藏状态：先挑出该类型的 id，再走同一条链路 */
  private _setHiddenByType(type: string, on: boolean): void {
    const ids: string[] = [];
    for (const s of this._shapes.values()) if (s.type === type) ids.push(s.id);
    this._setHidden(ids, on);
  }

  /**
   * 收掉「指向一个刚刚变得不可见的图形」的交互状态：聚焦 / 悬停 / 拖拽会话。
   * 三个都收掉才不会有「手柄浮在空处」「光标还是抓手」「拖着一个看不见的东西」。
   */
  private _dropHiddenInteractions(): void {
    if (this._focused !== null && !this._shown(this._shapes.get(this._focused))) {
      this._focused = null;
    }
    if (this._hoverId !== null && !this._shown(this._shapes.get(this._hoverId))) {
      this._hoverId = null;
      this._cursor('');
    }
    if (this._hoverVertex && !this._shown(this._shapes.get(this._hoverVertex.id))) {
      this._hoverVertex = null;
    }
    const d = this._drag;
    if (d && !this._shown(this._shapes.get(d.id))) this._endDrag();
  }

  /**
   * 该图形此刻是否**显示**（全局总开关 && 它自己的开关）。
   *
   * ★ 别和 `_visible()` 搞混：那个是**视口剔除**（图形在不在画布内），
   *   这个是**用户开关**。两者是正交的两回事，渲染与命中都要同时满足。
   */
  private _shown(shape: Shape | undefined): boolean {
    return this._visibleAll && !!shape && !shape.hidden;
  }

  /** 当前是否正拖着某个图形（拖顶点 / 拖主体） */
  get dragging(): boolean { return !!this._drag; }

  /** 只读迭代用 Map：id → Shape */
  get shapes(): ReadonlyMap<string, Shape> { return this._shapes; }

  /** 是否存在该 id 的图形 */
  has(id: string): boolean { return this._shapes.has(id); }

  /** 取当前聚焦图形对象；没有返回 null */
  getFocused(): Shape | null {
    if (this._focused === null) return null;
    return this._shapes.get(this._focused) || null;
  }

  /** 某类型的中文名（列表 / UI 用） */
  typeLabel(key: string): string {
    const t = this._types.get(key);
    return t ? t.label : key;
  }

  /** 某类型的按键提示 HTML（绘制提示条用） */
  typeHint(key: string): string {
    const t = this._types.get(key);
    return t && typeof t.hint === 'string' ? t.hint : '';
  }

  /** 某图形的一句话描述（列表用）。也可传图形 id 或图形对象 */
  describe(shape: Shape | string): string {
    const s = typeof shape === 'string' ? this._shapes.get(shape) : shape;
    if (!s) return '';
    const t = this._types.get(s.type);
    return t ? t.describe(s) : s.type;
  }

  /**
   * 修改「默认绘制配置」，并顺带应用到当前聚焦图形上
   * （聚焦图形类型不适用的键自动跳过，如多边形的 text / smooth）。
   *
   * @param opts.defaults 是否把 patch 一并写进「全局默认配置」，默认 true：
   *   面板调好默认值后下个新图形即继承。传 false 时只改当前聚焦图形、不碰全局默认 ——
   *   适合「仅改这一张」的场景，避免把某类型专属字段（如引线标注的 text）写进被其它
   *   类型共享的全局默认（那会让下一张「路径文字」意外沿用引线的文字）。
   */
  config(patch: CfgPatch = {}, opts: { defaults?: boolean } = {}): void {
    this._assertAlive();
    if (opts.defaults !== false) {
      Object.assign(this._defaults, patch);          // 先更新全局默认（供新图形继承）
    }
    const f = this.getFocused();
    if (f) {
      const t = this._types.get(f.type);
      const allow = new Set<CfgKey>(t ? t.cfgKeys() : []);
      const apply: CfgPatch = {};
      (Object.keys(patch) as CfgKey[]).forEach((k) => {
        if (allow.has(k)) (apply as any)[k] = (patch as any)[k];
      });
      if (Object.keys(apply).length) {
        Object.assign(f.cfg, apply);
        if (f.cfg.nodes) f.cfg.nodes = f.cfg.nodes.slice();
      }
    }
    this.render();
    this._emit();
  }

  /** 当前默认配置快照（text / spread / smooth / …），供外部回显 */
  getDefaults(): Cfg {
    return Object.assign({}, this._defaults);
  }

  /** 当前正在进行的绘制类型键；没在绘制时返回 null */
  isDrawing(): string | null { return this._draw ? this._draw.type : null; }

  /** 是否已销毁 */
  get destroyed(): boolean { return this._destroyed; }

  /* ================================================================
   * 公开 API：渲染调度
   * ================================================================ */

  /**
   * **立即**重绘一帧（同步）。初始化与状态变更用；连续的地图/指针事件请用
   * `requestRender()` 合帧，避免一帧内反复全量重画。
   */
  render(): void {
    if (this._destroyed || !this._ctx || !this._projectReady()) return;
    // 立即画完了 → 之前排队的那一帧已经没有意义，撤掉。
    // 不撤就会出现「刚 render() 完、紧接着 rAF 又整张重画一遍」的重复劳动
    // （比如 push() 排了帧、随后有人显式 render()；或地图 render 事件正好赶到）。
    // 放在早退守卫**之后**：没就绪时排队的那一帧还得留着。
    if (this._raf) { cancelFrame(this._raf); this._raf = 0; }
    this._bumpFrame();                       // 新的一帧 → 投影缓存全部失效
    const ctx = this._ctx;
    const s = this._scale;                   // 出图期间更大，各类型无须知情
    // 坐标系原点默认在**容器左上角**；出图期间挪到**取景框左上角**（纸张模式框比容器大，
    // 它的一部分在容器外，得靠这个负偏移把它们画进画布）。跟随视口时取景框就是容器，
    // 偏移为 0 —— 这一句与旧版的 `setTransform(s,0,0,s,0,0)` 逐像素等价。
    ctx.setTransform(s, 0, 0, s, -this._viewX * s, -this._viewY * s);
    // 按 CSS 尺寸清（变换已含 s 倍）—— 且这个矩形此时正好等于整张画布
    ctx.clearRect(this._viewX, this._viewY, this._viewW, this._viewH);

    // 每个已提交图形 → 由它的类型处理器决定怎么画（视口外的直接跳过）
    for (const shape of this._shapes.values()) {
      const t = this._types.get(shape.type);
      if (!t) {
        console.warn('[mapbox-sketch] 未注册的类型，已跳过图形', shape.id, shape.type);
        continue;
      }
      // 两道互不相干的关卡：先看「用户关掉了吗」（两次布尔判断，最便宜），
      // 再看「在不在画布内」（要算包围盒）
      if (!this._shown(shape)) continue;
      if (!this._visible(shape, t)) continue;
      try {
        t.render(shape);
      } catch (err) {
        // 单图形渲染失败不中断整张画布（多为投影瞬间不可用）
        console.warn('[mapbox-sketch] 渲染图形失败', shape.id, err);
      }
    }

    /*
     * ★ 以下三段都是**编辑态装饰**：它们表达的是「此刻你在操作什么」，
     *   不是「这张图上有什么」。出图（`_capturing`）时必须整段跳过 ——
     *   否则鼠标恰好悬停在某条图形上时，成品里那条会被染成高亮红；
     *   聚焦图形的那圈顶点手柄也会被一起画进图里。
     *
     *   ★ 新增任何「编辑期提示」时都要挂进这个判断里 —— 只把悬停色挡住是不够的
     *   （悬停色已经在更上游的 `isHovered()` 里被 `_capturing` 挡住了）。
     */
    if (!this._capturing) {
      // 进行中的手绘预览 → 交给类型处理器
      if (this._draw) {
        const t = this._types.get(this._draw.type);
        if (t && typeof t.preview === 'function') {
          try { t.preview(this._draw); } catch (err) { console.warn('[mapbox-sketch] 预览失败', err); }
        }
      }

      // 吸附提示（画在预览之上、手柄之下：它跟着光标走，是最需要被看见的那个）
      try { this._drawSnapHint(); } catch (err) { console.warn('[mapbox-sketch] 吸附提示绘制失败', err); }

      // 聚焦图形的顶点手柄（编辑入口；绘制中不画）
      try { this._drawHandles(); } catch (err) { console.warn('[mapbox-sketch] 手柄绘制失败', err); }
    }
  }

  /**
   * 请求一次重绘：置脏 + 排到下一帧，**一帧内多次调用只会真的重画一次**。
   * 手绘橡皮筋、拖拽、悬停变色这类「我们自己发起」的连续重绘走它。
   *
   * ★ 地图自身的位姿变化（move / zoom / 俯仰 / 样式变更）**不要**走这里 ——
   *   那类重绘挂在 mapbox 的 `render` 事件上同步画（见 `_bindEvents` 的 h.sync）。
   *   排到下一个 rAF 会让覆盖层比地图慢一帧，拖动/缩放时标注会抖。
   */
  requestRender(): void {
    if (this._destroyed || this._raf) return;
    this._raf = scheduleFrame(() => {
      this._raf = 0;
      this.render();
    });
  }

  /** 取该图形存储顶点的投影（同一「帧代次」内带缓存，重复调用不重复投影） */
  projectPts(shape: Shape): ScreenPoint[] {
    const hit = this._projCache.get(shape);
    if (hit && hit.gen === this._projGen) return hit.pts;
    const m = this._map;
    const pts: ScreenPoint[] = m ? shape.pts.map((ll) => m.project(ll)) : [];
    this._projCache.set(shape, { gen: this._projGen, pts, bb: bboxOf(pts) });
    return pts;
  }

  /** 该图形本帧的投影包围盒（与 `projectPts` 共用同一条缓存，不重复遍历顶点） */
  private _bboxOf(shape: Shape): BBox | null {
    const hit = this._projCache.get(shape);
    if (!hit || hit.gen !== this._projGen) this.projectPts(shape);
    return this._projCache.get(shape)!.bb;
  }

  /** 单个经纬度 → 屏幕坐标 */
  project(ll: LngLat): ScreenPoint {
    if (!this._map) throw new Error('绘制工具已被 destroy()，无法投影。');
    return this._map.project(ll);
  }

  /* ================================================================
   * 内部：画布与事件生命周期
   * ================================================================ */

  /** 开始新的「投影缓存代次」：渲染与命中扫描各自成帧，互不污染缓存 */
  private _bumpFrame(): void { this._projGen++; }

  /** 建一张铺满地图容器、不可交互的全屏 canvas 覆盖层 */
  private _buildCanvas(): void {
    const map = this._map!;
    const overlay = document.createElement('canvas');
    overlay.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:5;';
    map.getContainer().appendChild(overlay);
    this._canvas = overlay;
    this._ctx = overlay.getContext('2d');
    this._resize();
  }

  /**
   * 本次渲染该用的倍率：平时就是 `devicePixelRatio`，出图期间是取景框那一个。
   *
   * `_resize()` 与 `render()` 都读它、**都不读 `_dpr`** —— 出图的放大因此只需要
   * 改这一个字段，各类型的绘制代码一行都不用动（它们画的都是 CSS 像素坐标，
   * 放大只是 `setTransform` 换个系数）。
   */
  private get _scale(): number {
    return this._capture ? this._capture.dpr : this._dpr;
  }

  /*
   * ── 取景框（CSS px，相对容器左上角）──
   *
   * 平时是**整个容器**，出图期间是这一次导出要覆盖的那块范围（纸张模式可能比容器
   * 大、也可能为负）。绘制坐标系、画布物理尺寸、视口剔除框三处都读这四个 getter，
   * 别再各自去读 `_cw/_ch` —— 「画在哪、多大、剔除到哪」必须是同一块矩形。
   *
   * ★ `_cw/_ch` 的语义**不变**（恒为容器 CSS 尺寸），因为 `SketchHost` 是对外契约：
   *   图片标注按它算「落地尺寸不能超过画布短边 1/3」，那是**落地那一刻**的事，
   *   与出图取景无关。出图期间不会有指针事件，两者不会打架。
   */
  private get _viewX(): number { return this._capture ? this._capture.frame.x : 0; }
  private get _viewY(): number { return this._capture ? this._capture.frame.y : 0; }
  private get _viewW(): number { return this._capture ? this._capture.frame.w : this._cw; }
  private get _viewH(): number { return this._capture ? this._capture.frame.h : this._ch; }

  /** 按**取景框**尺寸与（出图期间的）渲染倍率设定画布物理尺寸 */
  private _resize(): void {
    const map = this._map;
    if (!map) return;
    const c = map.getContainer();
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    this._dpr = dpr;
    this._cw = c.clientWidth || 0;
    this._ch = c.clientHeight || 0;
    if (this._canvas) {
      // 画布的 CSS 尺寸是 100%（见 _buildCanvas），所以这里改的只是物理像素：
      // 出图期间这张图在屏幕上显示大小不变，只是短暂地更清晰
      const s = this._scale;
      // 出图期间取景框宽 × 该倍率 === outW，等式是构造出来的（见 `_capture`）
      this._canvas.width = Math.round(this._viewW * s);
      this._canvas.height = Math.round(this._viewH * s);
    }
  }

  /** 绑定地图 / 窗口 / 文档事件（destroy 时一并解绑） */
  private _bindEvents(): void {
    const map = this._map!;
    const h = {
      /*
       * ★ 与地图「同帧」重绘 —— 覆盖层不能比地图慢一帧。
       *
       * 这里**必须同步调 render()**，不能走 requestRender() 排到下一个 rAF：
       * mapbox 是在它自己的 rAF 回调里更新位姿并重绘地图画布的，此时若我们把
       * 重绘排进下一个 rAF，回调触发时地图的 transform 还是「上一帧」的状态 ——
       * 覆盖层于是永远落后地图一帧。拖动/缩放时地图在动、标注却慢半拍地追，
       * 看起来就是标注在闪烁/抖动。
       *
       * 改成挂在 mapbox 自己的 `render` 事件上，两个好处一次拿到：
       *   1) `render` 在 mapbox 重绘的那一帧内触发，我们同步画 → 同帧合成，不抖；
       *   2) `render` 每次重绘只触发一次，天然就是「一帧一次」，
       *      比原来的 rAF 合帧更省 —— 地图不动时它根本不触发，零浪费。
       * 也正因为有了它，move / zoom / pitchedrag / styledata 都不再需要单独监听
       * （那些情况 mapbox 都会重绘 → 都会触发 `render`），少绑几个事件还顺带
       * 避免了同一帧被触发两次。
       */
      sync: () => this.render(),
      resize: () => { this._resize(); this.render(); },
      click: (e: MapPointerEventLike) => this._onClick(e),
      mousedown: (e: MapPointerEventLike) => this._onMouseDown(e),
      mousemove: (e: MapPointerEventLike) => this._onMousemove(e),
      mouseup: (e: MapPointerEventLike) => this._onMouseUp(e),
      winup: (e: MapPointerEventLike) => this._onMouseUp(e),  // 鼠标可能在画布外松开：window 兜底
      dblclick: (e: MapPointerEventLike) => this._onDblclick(e),
      contextmenu: (e: MapPointerEventLike) => this._onContextmenu(e),
      keydown: (e: KeyboardEvent) => this._onKeydown(e),
    };
    this._handlers = h;
    // 地图每重绘一帧就同步画一次覆盖层（见上面 h.sync 的说明，别改成 requestRender）
    map.on('render', h.sync as any);
    if (typeof window !== 'undefined') window.addEventListener('resize', h.resize);
    map.on('click', h.click as any);
    map.on('mousedown', h.mousedown as any);
    map.on('mousemove', h.mousemove as any);
    map.on('mouseup', h.mouseup as any);
    map.on('dblclick', h.dblclick as any);
    map.on('contextmenu', h.contextmenu as any);
    if (typeof window !== 'undefined') window.addEventListener('mouseup', h.winup as any);
    if (typeof document !== 'undefined') document.addEventListener('keydown', h.keydown as any);
  }

  /** 解除 _bindEvents 绑定的所有监听 */
  private _unbindEvents(): void {
    const h = this._handlers;
    if (!h) return;
    const map = this._map;
    if (map) {
      map.off('render', h.sync as any);
      map.off('click', h.click as any);
      map.off('mousedown', h.mousedown as any);
      map.off('mousemove', h.mousemove as any);
      map.off('mouseup', h.mouseup as any);
      map.off('dblclick', h.dblclick as any);
      map.off('contextmenu', h.contextmenu as any);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', h.resize);
      window.removeEventListener('mouseup', h.winup as any);
    }
    if (typeof document !== 'undefined') document.removeEventListener('keydown', h.keydown as any);
    this._handlers = null;
  }

  /**
   * 实例化后跑 ~30 帧渐进渲染：`map.project` 在样式就绪前不可用，
   * 这段循环覆盖「首次出图」的时机（样式就绪即自动画出已 push 的图形）。
   */
  private _scheduleInitialRenders(): void {
    let n = 0;
    const tick = () => {
      if (this._destroyed) return;
      this.render();
      if (n++ < 30) this._initRaf = scheduleFrame(tick);
    };
    this._initRaf = scheduleFrame(tick);
  }

  /** 校验工具未被销毁 */
  private _assertAlive(): void {
    if (this._destroyed) {
      throw new Error('绘制工具已被 destroy()，请刷新页面后重新创建。');
    }
  }

  /** 通知外部 UI 状态已变化 */
  private _emit(): void {
    const cb = this._opts && this._opts.onChange;
    if (typeof cb === 'function') {
      try { cb(); } catch (err) { console.error(err); }
    }
  }

  /** 轻量提示（如点数不足），走 options.onWarn */
  private _warn(msg: string): void {
    const cb = this._opts && this._opts.onWarn;
    if (typeof cb === 'function') cb(msg);
  }

  /** 手绘期间禁用 / 恢复地图「双击缩放」 */
  private _setZoomLock(lock: boolean): void {
    const z = this._map && (this._map as any).doubleClickZoom;
    if (!z) return;
    if (lock && !this._zoomLocked) { z.disable(); this._zoomLocked = true; }
    else if (!lock && this._zoomLocked) { z.enable(); this._zoomLocked = false; }
  }

  /** 图形拖拽期间禁用 / 恢复地图平移（与 _setZoomLock 思路一致） */
  private _setPanLock(lock: boolean): void {
    const dp = this._map && (this._map as any).dragPan;
    if (!dp) return;
    if (lock && !this._panLocked) { dp.disable(); this._panLocked = true; }
    else if (!lock && this._panLocked) { dp.enable(); this._panLocked = false; }
  }

  /**
   * 按类型生成自增 id：path-1 / polygon-2 / …
   *
   * ★ 必须跳过**已被占用**的号：`_seq` 只认自己发出去的号，而 `push()` 的第四个
   *   参数和 `importJSON()` 都能带**外来 id** 进来（一份别处导出的存档里就是
   *   `line-1 / line-2 …`）。而 `push` 往 `_shapes` 里 set 是「同 id 整体替换」——
   *   撞上就是无声地吃掉一条图形，不抛错、也不提示。以前碰不到（id 都是自己发的），
   *   导入把外来 id 引进来之后这就是常事。
   *   `_seq` 只增不减，这个循环必然终止。
   */
  private _nextId(type: string): string {
    let id: string;
    do {
      this._seq += 1;
      id = `${type}-${this._seq}`;
    } while (this._shapes.has(id));
    return id;
  }

  /** 定位要操作的图形：给了 id 用 id，否则用当前聚焦；两者都没有返回 null */
  private _resolveTarget(id?: string): Shape | null {
    if (id != null) return this._shapes.get(id) || null;
    return this.getFocused();
  }

  /** 退出绘制：清状态（含吸附）、恢复光标与双击缩放，重绘去掉预览 */
  private _exitDraw(): void {
    if (!this._draw) return;
    // 手绘进行中被打断（Esc / 换类型 / 关交互 / destroy）：先把手势的锁还回去。
    // 少了这一句，一笔画到一半按 Esc 会把地图平移永久锁死 —— 而且不报任何错。
    if (this._brush) {
      this._brush = null;
      this._setPanLock(false);
    }
    this._draw = null;
    this._snap = null;                        // 吸附提示随绘制会话一起结束
    this._snapEvt = null;
    if (this._snapRaf) { cancelFrame(this._snapRaf); this._snapRaf = 0; }
    this._setZoomLock(false);
    this._cursor('');
    this.render();
    this._emit();
  }

  /** 判断地图是否已可进行投影（样式就绪）；未就绪渲染直接跳过 */
  private _projectReady(): boolean {
    if (!this._map) return false;
    try {
      const p = this._map.project([0, 0]);
      return !!(p && isFinite(p.x) && isFinite(p.y));
    } catch { return false; }
  }

  /* ================================================================
   * 内部：视口剔除
   * ================================================================ */

  /**
   * 该图形是否可能落在**取景框**内。用「存储顶点的投影包围盒」外加类型声明的
   * `cullMargin` 与取景框矩形做相交测试 —— 顶点全在框外的图形直接跳过不画。
   * 这是上千个标注时的主要提速点：视野外的图形不再付出任何绘制成本。
   *
   * ★ 框取的是**取景框**而不是容器，这是**正确性**、不是优化。纸张比视口大时
   *   （A0 横放在 1920 窗口里，框的左右各伸出屏幕外 1287px），框内、容器外的图形
   *   有一大片；继续按容器剔除的话成品左右两边会各缺一截，而且**不报任何错**。
   *   反过来的情形（纸比屏幕小）才是顺带省下的性能。
   */
  private _visible(shape: Shape, t: MapboxShapeType): boolean {
    const bb = this._bboxOf(shape);
    if (!bb) return true;                    // 没顶点：交给类型自己决定画不画
    const m = t.cullMargin(shape);
    const x0 = this._viewX;
    const y0 = this._viewY;
    return !(bb.maxX + m < x0 || bb.minX - m > x0 + this._viewW
      || bb.maxY + m < y0 || bb.minY - m > y0 + this._viewH);
  }

  /* ================================================================
   * 内部：手绘交互事件（this._draw 非空才生效）
   * ================================================================ */

  private _onClick(e: MapPointerEventLike): void {
    if (!this._interactive) return;            // 交互已让出（见 setInteractive）
    if (!this._draw) return;
    if (this._picking) return;                 // 上一次异步落图还在等（见 _placeAsync）
    const t = this._types.get(this._draw.type);
    // ★ 自由手绘类型（自由线 / 自由面）走的是**两击一笔**，不进下面「逐点落点」那条路：
    //   第一击起笔，之后鼠标怎么走线就怎么长（`_brushMove`），第二击收笔成图 ——
    //   全程**不用按住任何键**。挡住的正是「逐点落点」：放它过去的话，第一击会既起笔
    //   又落点，第二击也会被当成又一个落点记进 `pts`（那是一根凭空拉出去的刺）。
    if (t && t.freehand) {
      if (this._brush) this._endBrush(e);      // 第二击 = 收笔（见 `_endBrush`）
      else this._beginBrush(e);                // 第一击 = 起笔（见 `_beginBrush`）
      return;
    }
    // ★ 异步落图的类型（实现了 place 的类型，目前只有「图片标注」）：这一击**不落点**，
    //   交给类型自己去取需要的东西（弹文件框选图），回来再落一整条图形。
    if (t && typeof t.place === 'function') {
      void this._placeAsync(t, e);
      return;
    }
    // 落点前先解析一次吸附：吸上了就落吸附点，没吸上落光标原始位置。
    // 用**这一下事件自身的坐标**解析，而不是上一帧存下的提示 —— 提示是给人看的，
    // 真正落哪儿以当前这一击为准（鼠标移动与点击之间可能隔了好几帧）。
    const snap = this._resolveSnap(this._px(e), this._py(e), this._alt(e));
    this._snap = null;                       // 落完点，上一帧的提示记号即作废
    this._draw.pts.push(snap ? snap.lngLat : [e.lngLat.lng, e.lngLat.lat]);
    // autoCommit 类型（如「点」）：单击即达最少点数，立即完成，无需双击/回车
    if (t && t.autoCommit && this._draw.pts.length >= (t.minPts || 2)) {
      this._commitDraw();
      return;
    }
    this.render();
  }

  /* ================================================================
   * 内部：**自由手绘**（两击一笔，只有 freehand 类型走）
   *
   * 这是**引擎级**能力：与「逐点单击落点」并行的另一套手势 —— **第一击起笔 → 鼠标
   * 移动一路采样成顶点 → 第二击收笔成图**，全程不用按住任何键。两个入口都挂在
   * `_onClick` 上（移动那一段挂 `_onMousemove`），类型侧只声明一句 `freehand = true`
   * 即可（见 `MapboxShapeType.freehand`）。
   * 现有的其他 39 种类型一次都没被碰到 —— `freehand` 默认 false，入口第一句就返回。
   * ================================================================ */

  /**
   * 起笔：该类型的**第一次单击**。只有 `freehand` 类型 + 左键 + 样式就绪才算数。
   *
   * 起笔时**重置** `_draw.pts`：一笔即一条图形，上一次没画成的残留不该并进这一笔
   * （那会让「上次点歪了一下」变成新图形上的一段乱线）。
   */
  private _beginBrush(e: MapPointerEventLike): void {
    const d = this._draw;
    if (!d || this._brush || this._picking) return;
    if (e.originalEvent && e.originalEvent.button !== 0) return;   // 只响应左键
    const t = this._types.get(d.type);
    if (!t || !t.freehand) return;
    if (!this._projectReady()) return;

    const ll: LngLat = [e.lngLat.lng, e.lngLat.lat];
    d.pts = [ll];
    d.cursor = ll;
    this._brush = { last: { x: this._px(e), y: this._py(e) } };
    // 手绘期间不吸附：落点密、又跟着手走，吸附既没意义，又会把「全表顶点 + 全表边线」
    // 的扫描塞进每个 mousemove。已经排队的提示与记号一并撤掉，免得它挂在原地骗人。
    this._snap = null;
    this._snapEvt = null;
    if (this._snapRaf) { cancelFrame(this._snapRaf); this._snapRaf = 0; }
    // 从这一击到第二击之间**锁住地图平移**：这一笔的每个顶点都是「当前视野下光标走过的
    // 地方」（存的是经纬度），中途把地图拖走了，后面的点就落在另一个视野里 —— 笔迹上
    // 凭空多一道直挺挺的长跳，而且不报任何错。想边看边画就先 Esc 取消（`_exitDraw`
    // 会把锁还回去），平移过去再重新起一笔。
    this._setPanLock(true);
    this._cursor('crosshair');
    this.render();
  }

  /** 移动：按屏幕间距采样。挪不够 `FREEHAND_MIN_PX` 就不记点（鼠标抖动不该堆点） */
  private _brushMove(e: MapPointerEventLike): void {
    const d = this._draw, b = this._brush;
    if (!d || !b) return;
    const x = this._px(e), y = this._py(e);
    if (Math.hypot(x - b.last.x, y - b.last.y) < FREEHAND_MIN_PX) return;
    b.last = { x, y };
    const ll: LngLat = [e.lngLat.lng, e.lngLat.lat];
    d.pts.push(ll);
    d.cursor = ll;
    // 直接 render 而不是 requestRender：与绘制态那条橡皮筋同一口径（见 _onMousemove），
    // 手绘的笔迹要贴着光标走，不该比地图上的其他东西晚一帧。
    this.render();
  }

  /**
   * 收笔：该类型的**第二次单击** → 成图。
   *
   * 点数不够（两击落在同一处、中间压根没动）时**留在绘制态**并说一句怎么画 ——
   * 静默失败正是本仓库最想避免的症状：用户会以为「这个工具坏了」。
   */
  private _endBrush(e?: MapPointerEventLike): void {
    if (!this._brush) return;
    this._brush = null;                        // 先清：下面可能走 _exitDraw，那边也会看它
    this._setPanLock(false);
    const d = this._draw;
    if (!d) { this._cursor(''); return; }
    const t = this._types.get(d.type);
    // 收笔那一击所在处是这一笔的终点，得落在那儿。中间那些点按 3px 阈值采样，收笔点却
    // 可能正好落在两次采样之间 —— 不补这一下，线会比手停下的地方短一截（画直线时最明显）。
    // ★ 只在一笔**真的动过**（已采到 ≥2 个点）时才补：一击完成（只有起点）不补，
    //   否则「单击不落点」那条规矩会被这一行悄悄破掉 —— 两点恰好够 minPts=2。
    const last = d.pts[d.pts.length - 1];
    if (d.pts.length >= 2 && e && e.lngLat && last
      && (last[0] !== e.lngLat.lng || last[1] !== e.lngLat.lat)) {
      const ll: LngLat = [e.lngLat.lng, e.lngLat.lat];
      d.pts.push(ll);
      d.cursor = ll;
    }
    if (d.pts.length < (t ? t.minPts : 2)) {
      this._warn(`${t ? t.label : d.type}：请在地图上单击起点，移动鼠标描摹，再次单击完成绘制。`);
      this._cursor('crosshair');               // 还在绘制态：恢复 draw() 那支十字光标
      this.render();
      return;
    }
    this._commitDraw();                        // 内部会 _exitDraw（解锁 / 复位光标）并 push
  }

  /**
   * 走一次**异步落图**：调类型的 `place()`，拿到顶点后落一整条图形。
   *
   * 与 `_commitDraw()` 的分工：那边是「引擎自己攒的点够数了」，这边是「类型去宿主那儿
   * （弹文件框选图）拿到顶点」。共同点是要落得**像手画的一样** —— 同样是退出绘制态 +
   * `push()` + 补一帧 `render()`（否则预览擦掉到新图形出现之间会空一帧，闪一下）。
   *
   * 三种结果都**保持绘制态**（用户可以再点一次）：用户取消（`null`）、类型抛错、
   * 顶点不够数。只有真落成了才退。
   *
   * ★ 等待期间 `_picking` 挡住「再点地图」与「按 Esc」：文件框是系统的模态框，
   *   但地图上的事件不会因此停下来 —— 不挡就会多落一条、或者把绘制态关掉让结果无处安放。
   */
  private async _placeAsync(t: MapboxShapeType, e: MapPointerEventLike): Promise<void> {
    const type = t.key;
    this._picking = true;
    try {
      const picked = await t.place!({
        lngLat: [e.lngLat.lng, e.lngLat.lat],
        point: e.point ? { x: e.point.x, y: e.point.y } : undefined,
      });
      // 等回来时世界可能已经变了：地图/工具被销毁、用户换了绘制类型（Esc 退过一次又开了
      // 别的）、或者上一次的绘制态已经收工 —— 三种都直接丢弃结果。
      if (this._destroyed) return;
      if (!this._draw || this._draw.type !== type) return;
      if (!picked) return;                       // 用户取消：留在绘制态
      const minPts = t.minPts || 2;
      if (picked.pts.length < minPts) {
        this._warn(`${t.label}至少需要 ${minPts} 个顶点，请重试。`);
        return;
      }
      this._exitDraw();
      this.push(type, picked.pts, {}, undefined, picked.data);
      this.render();                             // 同 _commitDraw：立刻成型，别留一帧空白
    } catch (err) {
      if (this._destroyed) return;
      this._warn(`${t.label}落图失败：${(err as Error).message}`);
    } finally {
      this._picking = false;
    }
  }

  private _onMousemove(e: MapPointerEventLike): void {
    // —— 自由手绘笔触进行中：跟手采样（不吸附、不合帧，笔迹要贴着光标） ——
    if (this._brush) { this._brushMove(e); return; }
    // —— 绘制橡皮筋：光标 + 吸附一起按帧解析（与下面悬停同一套节流写法）——
    // 吸附是「全表顶点 + 全表边线」的扫描，一帧算一次就够；橡皮筋本来也只按帧重画，
    // 所以既不引入额外延迟，又把 O(n) 从「每个 mousemove」降到「每帧一次」——
    // 上千个标注时不至于把 GC 拖垮。
    if (this._draw) {
      this._snapEvt = e;
      if (!this._snapRaf) {
        this._snapRaf = scheduleFrame(() => {
          this._snapRaf = 0;
          const ev = this._snapEvt;
          this._snapEvt = null;
          const d = this._draw;
          if (!ev || this._destroyed || !d) return;
          d.cursor = [ev.lngLat.lng, ev.lngLat.lat];
          this._snap = this._resolveSnap(this._px(ev), this._py(ev), this._alt(ev));
          this.render();
        });
      }
      return;
    }
    // —— 编辑：拖拽会话进行中（要跟手，但仍按帧合并掉一帧内的多次事件） ——
    if (this._drag) {
      this._dragTo(e);
      // 拖「主体」给移动图标；拖「顶点小圆点」问类型要（图片标注的旋转柄 / 缩放角
      // 各有各的样式，而且缩放那支还要跟着图形当前朝向转）。类型不表态就是默认箭头。
      this._cursor(this._drag.kind === 'vertex'
        ? this._handleCursor(this._shapes.get(this._drag.id), this._drag.vi)
        : 'move');
      return;
    }
    // —— 非拖拽：编辑开启时给「可操作」反馈（编辑关闭时一律无提示）——
    // 命中检测是全表扫描，按帧节流：一帧内最多算一次，只保留最后一个事件。
    if (!this._editEnabled || !this._projectReady()) return;
    this._hoverEvt = e;
    if (this._hoverRaf) return;
    this._hoverRaf = scheduleFrame(() => {
      this._hoverRaf = 0;
      const ev = this._hoverEvt;
      this._hoverEvt = null;
      if (!ev || this._destroyed || !this._interactive || !this._editEnabled
        || this._drag || this._draw) return;
      this._updateHover(this._px(ev), this._py(ev));
    });
  }

  /**
   * 刷新悬停态：命中主体 → 本体变红 + 移动光标；压在顶点手柄上 → 那支手柄变激活态 +
   * 问类型要光标；落在空白 → 恢复原样。`_onMouseUp` 复用本方法（松手后同样要按当前指针位置重判）。
   *
   * ★ 压着手柄时也要重绘：手柄的**外观**要跟着换（图标翻成橙底 / 通用白点填橙）。
   *   这是用户 2026-09-14 报的第二件事 —— 原先这条路只换光标，光标在 Safari / Firefox 上
   *   又根本不生效，于是「鼠标挪到控制点上一点反应都没有」。光标那条路照旧留着。
   */
  private _updateHover(x: number, y: number): void {
    const hit = this._pickAt(x, y);
    const vi = hit && hit.vi >= 0 ? hit.vi : -1;
    // 手柄优先于主体：命中结果里手柄本来就盖过本体（见 `_pickAt`），
    // 于是压着手柄时 `_hoverId` 为 null，本条图形不会同时「整条变红」
    const hover = hit && vi < 0 ? hit.shape.id : null;
    const vtx = hit && vi >= 0 ? { id: hit.shape.id, vi } : null;
    // 比的是「是不是同一支手柄」：同一条图形的另一个顶点也算换了（`?.` 两边都空时相等）
    const moved = vtx?.id !== this._hoverVertex?.id || vtx?.vi !== this._hoverVertex?.vi;
    if (moved) this._hoverVertex = vtx;
    if (hover !== this._hoverId) {
      this._hoverId = hover;
      this.render();                          // 本体红变了，手柄的激活态顺带一起重画
    } else if (moved) {
      this.render();                          // 只是换了/离开了手柄：也得重画那一支
    }
    if (hit && vi >= 0) this._cursor(this._handleCursor(hit.shape, vi));
    else this._cursor(hover ? 'move' : '');
  }

  /**
   * 指针已不在画布上（拖到画布外松手，或 window 兜底 mouseup 没有有效坐标）：
   * 清掉悬停红、手柄激活态与光标。少了它，鼠标在画布外松开后图形会一直「红着」。
   */
  private _clearHover(): void {
    // 手柄激活态也算「要重画」：指针走了，那支手柄得从橙底变回白底
    const had = this._hoverId !== null || this._hoverVertex !== null;
    this._hoverId = null;
    this._hoverVertex = null;
    if (had) this.render();
    this._cursor('');
  }

  /**
   * 某个顶点手柄的光标：**问类型要**（`vertexCursor`）。
   *
   * 手柄长什么样只有类型自己知道 —— 引擎一视同仁地只看见「第 i 个顶点」，而图片标注
   * 的 2 号顶点是旋转柄、0/1 号是缩放角。类型不表态（返回 null）时给 `''`，
   * 也就是「不特别显示」，与这个钩子存在之前的行为完全一致。
   */
  private _handleCursor(shape: Shape | undefined, vi: number): string {
    if (!shape || vi < 0) return '';
    const t = this._types.get(shape.type);
    return t ? t.vertexCursor(shape, vi) || '' : '';
  }

  /** 地图鼠标事件的屏幕坐标（CSS 像素，与 map.project 同坐标系） */
  private _px(e: MapPointerEventLike): number {
    if (e.point && isFinite(e.point.x)) return e.point.x;
    return this._map!.project(e.lngLat as any).x;
  }

  private _py(e: MapPointerEventLike): number {
    if (e.point && isFinite(e.point.y)) return e.point.y;
    return this._map!.project(e.lngLat as any).y;
  }

  /** 这一下指针事件是否按着 Alt（Alt = 临时不吸）。window 兜底事件上没有 originalEvent → 当没按 */
  private _alt(e: MapPointerEventLike): boolean {
    return !!(e.originalEvent && e.originalEvent.altKey);
  }

  /**
   * 这一下指针事件是否按着 Shift。
   * 引擎自己不看它 —— 只透给类型的 `dragTo`（图片标注按它把旋转吸附到 15° 网格）。
   */
  private _shift(e: MapPointerEventLike): boolean {
    return !!(e.originalEvent && e.originalEvent.shiftKey);
  }

  /* ================================================================
   * 内部：绘制吸附
   *
   * 这是**引擎级**能力：除两种自由手绘外的 39 种类型共用同一条手绘落点链路（_onClick / 橡皮筋），
   * 吸附就插在那条链路上，各类型一行都不用改 —— 以后加新类型也自动带上。
   * ================================================================ */

  /**
   * 解析一次吸附 —— 引擎里**唯一**的吸附决策点。
   *
   * 候选分两层，**顶点层整体优先于边线层**：容差内只要有可吸的点，就不退而吸线。
   * 否则会出现「明明压在顶点上、却因为那条边线近了 0.3px 而吸到线中间」这种事。
   *
   * 一趟遍历同时收集两层的最近者，扫完再按优先级定胜负。
   *
   * @param x,y    光标的屏幕坐标（CSS 像素）
   * @param altKey 按着 Alt = 这一下不吸
   */
  private _resolveSnap(x: number, y: number, altKey: boolean): SnapHit | null {
    const d = this._draw;
    // 自由手绘笔触进行中不吸附（起笔到收笔之间都算）：落点密、跟着手走，吸附既没意义，
    // 又会在每个 mousemove 上多做一轮全表扫描（见 `_beginBrush`）
    if (!d || !this._snapOn || altKey || this._brush) return null;
    const map = this._map;
    if (!map || !this._projectReady()) return null;
    const tol = this._snapTol;
    this._bumpFrame();                       // 整轮扫描共用一份投影结果（同 _pickAt）

    let ptHit: SnapHit | null = null, ptD = tol;
    let edgeHit: SnapHit | null = null, edgeD = tol;

    for (const shape of this._shapes.values()) {
      // 隐藏的图形**不当吸附目标** —— 藏起来的东西不该有引力，
      // 否则你会在一个看不见的顶点上落下一个点，且完全没有反馈
      if (!this._shown(shape)) continue;
      const Pts = this.projectPts(shape);
      if (!Pts.length) continue;
      // 预筛：屏幕包围盒外扩一个容差都够不着 → 整块跳过。
      // 视野外 / 远处的图形因此几乎零成本（与 _visible 同一套做法）。
      const bb = this._bboxOf(shape);
      if (bb && (x < bb.minX - tol || x > bb.maxX + tol
        || y < bb.minY - tol || y > bb.maxY + tol)) continue;

      // 顶点：直接用**存储的**经纬度 —— 不走「投影 → 反投影」的来回换算，免掉浮点漂移
      for (let i = 0; i < Pts.length; i++) {
        const dist = Math.hypot(x - Pts[i].x, y - Pts[i].y);
        if (dist > ptD) continue;
        ptD = dist;
        ptHit = { kind: 'vertex', lngLat: [shape.pts[i][0], shape.pts[i][1]] };
      }

      // 边线：屏幕上算出线段上的最近点，只有它必须反投影还原成经纬度
      if (Pts.length < 2) continue;
      const t = this._types.get(shape.type);
      const n = t && t.closesRing ? Pts.length : Pts.length - 1;  // 面含首尾那段
      for (let i = 0; i < n; i++) {
        const a = Pts[i], b = Pts[(i + 1) % Pts.length];
        const near = nearestOnSeg(x, y, a.x, a.y, b.x, b.y);
        if (near.d > edgeD) continue;
        edgeD = near.d;
        const ll = map.unproject([near.x, near.y]);
        edgeHit = { kind: 'edge', lngLat: [ll.lng, ll.lat] };
      }
    }

    // 当前图形自己的已落点（同属顶点层，一起比）。
    // **排除最后一个**：那正是你刚点下的那个点，吸回去毫无意义，
    // 还会让你没法在它附近落下一个点（想收得很紧的折角就画不出来了）。
    for (let i = 0; i < d.pts.length - 1; i++) {
      const p = map.project(d.pts[i]);
      const dist = Math.hypot(x - p.x, y - p.y);
      if (dist > ptD) continue;
      ptD = dist;
      ptHit = { kind: 'self', lngLat: [d.pts[i][0], d.pts[i][1]] };
    }

    return ptHit || edgeHit;
  }

  /**
   * 画吸附提示记号。位置由 hit 的**经纬度现投影**得来 —— 提示里不存屏幕坐标，
   * 地图平移/缩放后它才不会挂在旧地方。
   *
   * 记号是**蓝色实心小圆点 + 白色描边**（同 `paint.drawDot` 的画法：先填后描）。
   * 三种吸附来源画的是同一个记号 —— 手感上「吸上了」本身就是唯一要传达的信息，
   * 再按来源分成方块 / 圆 / 菱形，反而要人在瞄准的瞬间去分辨形状。
   * 白色描边不是装饰：卫星影像底色花，没有它这个蓝点会糊进背景里。
   */
  private _drawSnapHint(): void {
    const hit = this._snap, ctx = this._ctx, map = this._map;
    if (!hit || !ctx || !map) return;
    let p: ScreenPoint;
    try { p = map.project(hit.lngLat); } catch { return; }
    if (!isFinite(p.x) || !isFinite(p.y)) return;
    ctx.save();
    ctx.beginPath();
    ctx.arc(p.x, p.y, SNAP_MARK_R, 0, Math.PI * 2);
    ctx.fillStyle = this._style.snapColor || DEFAULT_STYLE.snapColor;
    ctx.fill();
    ctx.lineWidth = 1;                        // 1px：够勾出蓝点的边，又不把半径 4 的小点糊成一坨
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.stroke();
    ctx.restore();
  }

  /**
   * 设置悬停 / 拖拽光标。mapbox 的画布在 `.mapboxgl-canvas-container` 里、
   * 且该容器在示例 CSS 里被强制成 default，只改容器不会覆盖子元素的计算光标，
   * 所以要连 canvas 一起改（与 draw / exitDraw 的改法一致），否则 move 不生效。
   */
  private _cursor(c: string): void {
    const map = this._map;
    if (!map) return;
    const co = map.getContainer();
    if (co) co.style.cursor = c;
    const cv = typeof map.getCanvas === 'function' ? map.getCanvas() : null;
    if (cv) cv.style.cursor = c;
  }

  private _onDblclick(e: MapPointerEventLike): void {
    if (!this._draw) return;
    const t = this._types.get(this._draw.type);
    // 自由手绘**没有「双击完成」这一步**：完成是第二击（见 `_endBrush`）。放它进来会
    // 把已经画好的笔迹末点弹掉，甚至把一笔两点的线「完成」在半截上。
    if (t && t.freehand) return;
    if (e.preventDefault) e.preventDefault();
    // 双击的第二次单击已作为一个落点 push 进来，这里把它当作「完成」信号弹掉
    if (this._draw.pts.length) this._draw.pts.pop();
    if (this._draw.pts.length >= (t ? t.minPts : 2)) this._commitDraw();
    else this.render();
  }

  private _onContextmenu(e: MapPointerEventLike): void {
    if (!this._draw) return;
    const t = this._types.get(this._draw.type);
    if (t && t.freehand) return;               // 自由手绘两击成形，没有「撤销上一点」可言
    if (e.preventDefault) e.preventDefault();
    if (this._draw.pts.length) { this._draw.pts.pop(); this.render(); }
  }

  private _onKeydown(e: KeyboardEvent): void {
    if (!this._interactive) return;            // 交互已让出：Esc/回车不再归本实例管
    // 输入框 / 文本域内按键不拦截（例如文字框里回车提交）
    const tag = e.target && (e.target as HTMLElement).tagName;
    if (tag && /^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
    if (e.isComposing || e.keyCode === 229) return;   // 中文输入法组合中忽略
    if (e.key === 'Alt' && this._draw) {
      // 绘制中按下 Alt = 临时不吸。把提示记号立刻撤掉，免得指针不动时它还挂在原地骗人。
      // 松手不必处理：下一次 mousemove 会按「没按 Alt」重新解析。
      // 拦掉默认行为：否则 Windows / Chrome 下按一下 Alt 会把焦点抢到浏览器菜单栏，
      // 后续的 Esc / 回车就被它吃了（只在绘制中拦，影响面就这一会儿）。
      e.preventDefault();
      if (this._snap) { this._snap = null; this.render(); }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      // ★ 异步落图等待中（系统文件框还开着/结果还在路上）：Esc **不许**退出绘制态。
      //   否则结果回来时绘制态已经没了，用户看到的是「明明选了图，地图上什么都没出现」；
      //   要取消就直接在文件框里点取消（那会走「返回 null、留在绘制态」那条路）。
      if (this._picking) return;
      if (this._draw) this._exitDraw();          // 绘制中 → 取消手绘
      else if (this._focused) this.blur();       // 编辑中 → 退出编辑
      return;
    }
    if (e.key === 'Enter') { e.preventDefault(); this._commitDraw(); }
  }

  /**
   * 通用顶点清洗：去连续重复点；`closesRing` 类型去掉「末点 = 首点」。
   */
  private _cleanPts(raw: LngLat[]): LngLat[] {
    const pts: LngLat[] = raw
      .filter((p, i) => i === 0 || p[0] !== raw[i - 1][0] || p[1] !== raw[i - 1][1])
      .map((p) => [p[0], p[1]] as LngLat);
    const t = this._draw ? this._types.get(this._draw.type) : null;
    if (t && t.closesRing && pts.length >= 2) {
      const f = pts[0], l = pts[pts.length - 1];
      if (l[0] === f[0] && l[1] === f[1]) pts.pop();
    }
    return pts;
  }

  /** 手绘完成：清洗 → 校验 → 生成图形 → 结束手绘并聚焦 */
  private _commitDraw(): void {
    const d = this._draw;
    if (!d) return;
    const t = this._types.get(d.type);
    const minPts = t ? t.minPts : 2;
    const cleaned = this._cleanPts(d.pts);
    const pts = t ? t.normalize(cleaned) : cleaned;
    if (pts.length < minPts) {
      this._warn(`${t ? t.label : d.type} 至少需要 ${minPts} 个顶点，请继续单击地图落点。`);
      return;                                  // 点数不足：保持绘制状态等待继续
    }
    this._exitDraw();                          // 退出绘制（恢复光标 / 双击缩放）
    this.push(d.type, pts, {});                // 用默认配置生成；不缩放视野
    // 但提交这一下要**立刻成型**：上一步刚把预览擦掉，如果等 push 排的那一帧再补图形，
    // 中间会空出一帧「什么都没画」——手下刚画完的线会闪一下。所以这里显式补一帧
    // （render 会把 push 排的那一帧撤掉，不会白画两遍）。
    this.render();
  }

  /* ================================================================
   * 内部：已绘图形的编辑（点击进入 → 拖顶点调整 / 拖主体平移）
   * 编辑态以「聚焦图形」为准；绘图中（_draw 非空）本组逻辑全部让路 —— 绘制靠的是
   * click（逐点落点那套、以及自由手绘的起收笔），**按下**在绘制态没有任何意义。
   * ================================================================ */

  private _onMouseDown(e: MapPointerEventLike): void {
    if (!this._interactive) return;                       // 交互已让出（见 setInteractive）
    // 绘制中：本组编辑逻辑一律让路 —— 绘制认的是 click（见 _onClick），mousedown 不参与。
    // ★ 「自由手绘」也在这里被挡掉了：它起收笔走的同样是 click（两击一笔，不用按住鼠标），
    //   所以按下这一下什么也不该发生。
    if (this._draw) return;
    if (this._destroyed) return;
    if (!this._editEnabled) return;                       // 编辑关闭（纯浏览态）
    if (!this._projectReady()) return;
    if (e.originalEvent && e.originalEvent.button !== 0) return;  // 只响应左键
    const x = this._px(e), y = this._py(e);
    const hit = this._pickAt(x, y);                        // {shape, vi} 或 null
    if (!hit) {                                            // 点空白
      if (this._hoverId !== null) { this._hoverId = null; this.render(); }  // 去掉悬停红
      if (this._focused) this.blur();                      // 退出编辑
      return;                                              // 不锁平移 → 地图可照常拖动
    }
    const s = hit.shape;
    // 派生手柄（下标 ≥ 顶点数，见 `handles()`）没有对应的 `pts`，引擎写不了它 ——
    // 拖它只能由类型自己算。类型没实现 `dragTo()` 时在这里**按下去的那一刻**说一句：
    // 不说的话，那支手柄看着在、拖着不动，像坏了。一次按下只报一句，不会刷屏。
    const th = this._types.get(s.type);
    if (hit.vi >= s.pts.length && !this._ownsDragTo(th)) {
      this._warn(`${th ? th.label : s.type} 的第 ${hit.vi + 1} 支手柄需要类型自己实现 dragTo() 才能拖，`
        + '请把这个情况反馈给标注类型的作者。');
      return;                                              // 不起拖拽会话，也不锁地图平移
    }
    if (this._hoverId !== s.id) this._hoverId = s.id;      // 按住哪个图形，拖动期间它保持「本体红」
    if (this._focused !== s.id) { this._focused = s.id; this._emit(); }
    // 记录一次潜在拖拽：press 存起始经纬度；立即锁住地图平移，
    // 免得拖动判定还没开始、地图已先跟着动（坐标基准会乱）。
    this._drag = {
      kind: hit.vi >= 0 ? 'vertex' : 'body',
      id: s.id, vi: hit.vi,
      lng: e.lngLat.lng, lat: e.lngLat.lat,
      orig: s.pts.map((p) => [p[0], p[1]] as LngLat),      // 拖拽起点快照（平移基准）
      started: false,
    };
    this._setPanLock(true);
    this.render();                                        // 立即显示手柄
  }

  /**
   * 该类型是不是**真的**自己实现了 `dragTo()`（而不是继承了基类那份空实现）。
   *
   * ★ 不能写成 `typeof t.dragTo === 'function'`：`MapboxShapeType` 上本来就有一个
   *   返回 `false` 的默认实现（可选钩子的统一写法），那句话对**任何**类型都成立 ——
   *   上面那道拦截等于不存在，派生手柄会静悄悄地拖不动，正好是它要防的症状。
   *   所以拿实例上那份跟**基类原型**上那一份比：不一样 = 子类覆盖过。
   *   原型方法（图片标注那样）和实例上的箭头函数字段算出来都是「不一样」，两种写法都认。
   *
   * ★ 也**不**靠「调一次看看返回什么」来判断：`dragTo()` 是有副作用的（改 `pts`），
   *   按下手那一刻试调一次会把图形先挪一下。
   */
  private _ownsDragTo(t: MapboxShapeType | undefined): boolean {
    return !!t && t.dragTo !== MapboxShapeType.prototype.dragTo;
  }

  /**
   * 拖拽移动：整体平移（body）或改单个顶点（vertex）。
   *
   * 两种口径**刻意不同**，不是疏漏：
   *   · 拖**单个顶点** = 「顶点落到光标处」（直接写 `e.lngLat`）—— 用户就是在摆那个点，
   *     所见即所得；
   *   · 拖**主体** = 「各顶点在屏幕上整体挪同样的像素」（`_moveBodyByScreen`）——
   *     形状与跟手都必须是像素级的，不能用经纬度差刚性平移（墨卡托纬度非线性）。
   */
  private _dragTo(e: MapPointerEventLike): void {
    const d = this._drag;
    if (!d) return;
    const shape = this._shapes.get(d.id);
    if (!shape) { this._endDrag(); return; }
    if (!d.started) {
      // 首帧先看是否真的在拖（屏幕位移阈值），避免误把单击当拖拽
      const p = this._map!.project([d.lng, d.lat]);
      if (Math.hypot(this._px(e) - p.x, this._py(e) - p.y) < 4) return;
      d.started = true;
    }
    // ★ 类型自算几何（可选）：下面那两下是「顶点跟随光标 / 主体整体平移」的默认行为，
    //   而图片标注拖角要**保持长宽比**（跟光标会把图拉变形）、拖旋转柄要能按 Shift 吸附，
    //   两下都对不上。返回 true 就是「我算完了，引擎别再写 pts」。
    const t = this._types.get(shape.type);
    if (t && t.dragTo(this._dragCtx(d, shape, e))) { this.requestRender(); return; }

    if (d.kind === 'vertex') {                             // 顶点跟随光标
      // 派生手柄不走到这里（`_onMouseDown` 已经拦掉了没有 `dragTo` 的类型）；
      // 兜底再判一次，免得某个类型的 dragTo 中途改用返回值 false 时写坏 `pts` 的越界下标
      if (d.vi < shape.pts.length) shape.pts[d.vi] = [e.lngLat.lng, e.lngLat.lat];
    } else {                                               // 整体平移：按**屏幕位移**搬
      this._moveBodyByScreen(shape, d, e);
    }
    this.requestRender();
  }

  /**
   * 整体平移：把按下时的各顶点**在屏幕上**整体挪同样的像素，再反算回经纬度。
   *
   * ★ 为什么不是「所有顶点同加一个经纬度差」（本章早先正是那么写的）：
   *   墨卡托的纬度是**非线性**的（`y ∝ ln(tan(π/4 + lat/2))`）。两点同加一个 `Δlat`
   *   之后，屏幕上的 **y 差会变** —— 纬度越高被拉得越长。于是往北拖一个矩形，它越拖
   *   越高、越拖越扁；拖一面旗，杆子越拖越长（实测：100px 的杆从 20°N 往北拖 300px
   *   会被拉到 111.24px）。**级别越小、一次拖动跨的纬度越多，越明显** ——
   *   用户 2026-09-16 报的「地图级别小的时候绘制的旗平移会变形」就是这条，
   *   而且它不是旗子独有的：**凡是有形状的标注都中招**（矩形 / 椭圆 / 扇形 / 折线…）。
   *
   * ★ 那种写法连「跟手」都做不到：光标移 300px，图形在高纬只走不到 300px。
   *
   * ★ 改按屏幕搬之后，**按下时的像素差**与**松开时的像素差**逐像素相同 ⇒ 形状一点不变、
   *   光标 1:1 跟手。全程只用 `project` / `unproject` 这一对互逆运算，不假设投影是什么，
   *   所以旋转 / 倾斜（bearing / pitch）的地图同样成立。
   *
   * ★ 地图自身的 pan / zoom **不需要**这个处理：两点各自的屏幕 y 只取决于自己的纬度与
   *   zoom（世界像素只随 zoom 等比变），与地图中心在哪无关，差值恒定。所以这一改动
   *   只影响「拖图形」这一条路径，不动别处。
   *
   * ★ 每帧都从 `d.orig`（按下时的只读快照）重算，绝不拿上一帧的结果累加 —— 累加会漂。
   */
  private _moveBodyByScreen(shape: Shape, d: DragSession, e: MapPointerEventLike): void {
    const map = this._map;
    if (!map) return;
    const p0 = map.project([d.lng, d.lat]);            // 按下时光标所在的屏幕点
    const dx = this._px(e) - p0.x;
    const dy = this._py(e) - p0.y;
    for (let i = 0; i < shape.pts.length; i++) {
      const q = map.project(d.orig[i]);                // 按下时该顶点的屏幕点
      const ll = map.unproject([q.x + dx, q.y + dy]);   // 整体平移同样的像素 → 反算经纬度
      shape.pts[i] = [ll.lng, ll.lat];
    }
  }

  /**
   * 组装一次拖拽上下文（给类型的 `dragTo` 钩子）。
   *
   * 一次拖拽里每帧一个对象。这里不做复用/池化：拖拽期间每帧本来就要重跑一遍类型的
   * 几何计算与一次全量重绘，一个短命小对象的开销跟它们不在一个量级上。
   */
  private _dragCtx(d: DragSession, shape: Shape, e: MapPointerEventLike): DragContext {
    return {
      shape,
      kind: d.kind,
      vi: d.vi,
      cursor: [e.lngLat.lng, e.lngLat.lat],
      point: e.point ? { x: e.point.x, y: e.point.y } : undefined,
      orig: d.orig,
      start: [d.lng, d.lat],
      alt: this._alt(e),
      shift: this._shift(e),
    };
  }

  /**
   * 鼠标松开：结束拖拽（可能从未真正拖起 → 仅当一次单击）。
   *
   * ★ 自由手绘**不在这里收笔**：起收笔都走 `click`（见 `_onClick` / `_endBrush`），
   *   松手这一下对它没有任何意义 —— 它全程就没按住过鼠标。
   */
  private _onMouseUp(e: MapPointerEventLike): void {
    if (!this._drag) return;
    const wasDrag = this._drag.started;
    this._endDrag();
    // 松手后按「指针当前位置」刷新悬停：仍压在图形上就继续红、给对应光标（本体是移动、
    // 手柄由类型定）；落到空白（或拖到画布外松开）则清掉。走的就是 mousemove 那条路
    // （`_updateHover`），免得「悬停」在两条路上各有一套判定。map 的 mouseup 带 .point 可精确判定；
    // window 兜底事件在画布外触发、无有效坐标，此时指针已不在画布上，直接清红。
    if (this._editEnabled && this._projectReady()) {
      const onCanvas = !!(e && e.point && isFinite(e.point.x));
      if (onCanvas) this._updateHover(e.point!.x, e.point!.y);
      else this._clearHover();
    } else if (wasDrag) {
      this.render();                                   // 编辑关闭 / 未就绪：兜底重绘一次
    }
    if (wasDrag) this._emit();                         // 拖完：UI 列表 / 聚焦同步
  }

  /** 收尾一次拖拽会话：解锁地图平移、清状态、还原光标 */
  private _endDrag(): void {
    if (!this._drag) return;
    this._setPanLock(false);
    this._drag = null;
    this._cursor('');
  }

  /** 命中检测：返回光标下最上层的 {shape, vi}；vi >= 0 表示正压在某个顶点上 */
  private _pickAt(x: number, y: number): PickResult | null {
    this._bumpFrame();                       // 整轮扫描共用一份投影结果
    let best: PickResult | null = null;
    for (const shape of this._shapes.values()) {           // 迭代序即叠放序：后画的在上
      const t = this._types.get(shape.type);
      if (!t) continue;
      // 隐藏的图形**不参与任何指针交互** —— 悬停变红 / 点选聚焦 / 起拖全在这一处出去。
      // 漏了这句，藏起来的图形还会把点击截走，看起来就像「程序坏了」。
      if (!this._shown(shape)) continue;
      if (!this._pickNear(shape, t, x, y)) continue;        // 包围盒预筛：够不着的整块跳过
      // 顶点手柄区优先命中。★ 光看「顶点数 > 1」是不够的，那会漏掉**派生手柄**：
      //   · 派生手柄（下标 ≥ `pts.length`）在 `pts` 里没有对应的顶点 —— 文字标注只存
      //     1 个锚点，却还有一支旋转柄。按顶点数判，那支柄在命中检测里根本不存在：
      //     悬停它没反应，按下去的落点算「空白」→ 直接退出编辑态、手柄当场消失
      //     （用户 2026-09-15 报的「旋转按钮摁下就没了」就是这个）。
      //   · 但单点图形（`pts.length === 1`）的 **0 号**手柄就是它本体所在的那一点：
      //     「点」和文字标注的锚点都该整体走本体（悬停变红 / 拖走平移），
      //     不给它单开一个顶点区。所以只有**派生**的那些才按手柄算。
      const Hs = t.handles(shape);                         // 与图标 / 光标 / dragTo 的 vi 同一份点列
      const vi = this._vertexAt(Hs, x, y);
      if (vi >= 0 && (shape.pts.length > 1 || vi >= shape.pts.length)) {
        best = { shape, vi };
        continue;
      }
      if (this._bodyHit(shape, t, x, y)) best = { shape, vi: -1 };
    }
    return best;
  }

  /**
   * 命中扫描的包围盒预筛：光标连「该图形可能被命中的范围」都够不着 → 整块跳过。
   *
   * 与 `_visible()` / `_resolveSnap()` 同一套做法，区别只在外扩量取的是**命中半径**
   * 而不是绘制外扩。上千个标注时这是悬停/拖拽不卡的关键：远处的图形不再付出
   * 逐顶点 `hypot` 与逐段 `distToPolyline` 的成本，只剩一次包围盒比较。
   *
   * 外扩量由三项取最大，每一项都对应一条真实判定里的常量，所以**不可能比真实判定更紧**
   * （紧了会表现为「明明该点中的图形点不中」）：
   *   · `_vertexAt` 的手柄区半径
   *   · `_bodyHit` 的本体容差（线宽的一半 + 5 / 点体半径）—— 同一个 `_bodyTol()`
   *   · 类型声明的 `cullMargin`：画在顶点之外的内容（引线、边中文字）也应当能被点到
   *
   * ★ 派生手柄（`handles()` 里下标 ≥ `pts.length` 的那些）也算「画在顶点之外」：
   *   它们的位置由几何算出来，可能落在存储顶点的包围盒外面 —— 类型必须保证
   *   `cullMargin()` 把它们盖住，否则会出现「手柄看得见、点不着」（图片标注的
   *   cullMargin 取的是旋转矩形的外接圆半径，四个角都在里面）。
   */
  private _pickNear(shape: Shape, t: MapboxShapeType, x: number, y: number): boolean {
    const bb = this._bboxOf(shape);
    if (!bb) return true;                    // 没顶点：交给类型自己决定
    const m = Math.max(PICK_HANDLE_TOL, this._bodyTol(shape, t), t.cullMargin(shape));
    return !(x < bb.minX - m || x > bb.maxX + m
      || y < bb.minY - m || y > bb.maxY + m);
  }

  /**
   * 本体命中的容差半径(px)。`_bodyHit` 与命中预筛 `_pickNear` **共用同一套口径** ——
   * 两处各写一份的话，改了其中一处就会出现「预筛把该命中的图形筛掉了」这种极难查的漏。
   */
  private _bodyTol(shape: Shape, t: MapboxShapeType): number {
    const st = t.styleFor(shape);
    if (t.key === 'point') {                               // 点：本体就是那个圆点
      return Math.max(((st && st.pointRadius) || 6) + 8, 18);
    }
    const w = (st && st.pathWidth) || 3;
    return Math.max(w / 2 + 5, 10);                        // 线体命中容差(px)
  }

  /**
   * `Hs` 里哪一支手柄被压着；返回手柄下标或 -1。
   *
   * 点列由**调用方**从类型的 `handles()` 取（而不是这里自己去数存储顶点）：图片标注
   * 四个角上都有缩放柄却只存两个角、文字标注存 1 个锚点却还有一支旋转柄 —— 命中检测、
   * `drawHandles(shape, hoverVi)`、`vertexCursor(shape, vi)`、`dragTo(ctx.vi)` 里那个
   * `vi` 全是**同一份下标**，差一处就会「看着有手柄、拖不动」或者「拖的是另一支」。
   * 传进来复用，顺带也让「该不该按手柄算」那个判断与它看的是同一份点列。
   */
  private _vertexAt(Hs: ScreenPoint[], x: number, y: number): number {
    for (let i = 0; i < Hs.length; i++) {
      if (Math.hypot(x - Hs[i].x, y - Hs[i].y) <= PICK_HANDLE_TOL) return i;
    }
    return -1;
  }

  /** 光标是否落在图形「本体」（线段 / 闭合面内部 / 点体）上；顶点区不算 */
  private _bodyHit(shape: Shape, t: MapboxShapeType, x: number, y: number): boolean {
    const tol = this._bodyTol(shape, t);
    const Pts = this.projectPts(shape);
    if (!Pts.length) return false;
    // 类型可选的自定义「本体」命中：返回 true/false 即用它；undefined 走下面默认规则。
    // 典型：引线标注只存 1 个锚点、却渲染出锚点→折点→文字端两段线，
    //   它的 hitTest() 要按「光标离那两段线的距离」判定，才能悬停变红 / 拖主体平移。
    const custom = t.hitTest(shape, x, y, Pts, tol);
    if (custom !== undefined) return !!custom;
    if (t.key === 'point') {                               // 点：一个圆点
      return Math.hypot(x - Pts[0].x, y - Pts[0].y) <= tol;
    }
    if (t.closesRing) {                                    // 面：内部或贴边
      if (Pts.length >= 3 && pointInRing(x, y, Pts)) return true;
      return distToPolyline(x, y, Pts, true) <= tol;
    }
    return distToPolyline(x, y, Pts, false) <= tol;        // 线类
  }

  /** 在聚焦图形上叠加「顶点手柄」（编辑入口的视觉提示）。仅非绘制态、有聚焦、编辑开启时画 */
  private _drawHandles(): void {
    if (this._draw || !this._ctx || this._focused == null) return;
    if (!this._editEnabled) return;                       // 编辑关闭：即便有聚焦图形也不画手柄
    const shape = this._shapes.get(this._focused);
    if (!shape) return;
    // 防御性的一道：正常路径上 hide() / setVisible(false) 已经把 _focused 清掉了
    // （见 `_dropHiddenInteractions`），但手柄浮在一个看不见的图形上实在太扎眼，值得再兜一次
    if (!this._shown(shape)) return;
    const ctx = this._ctx;
    // 类型可以**自己画手柄**（返回 true = 通用白点就不画了）。图片标注是第一个用它的：
    // 它那三个手柄干的是两件不同的事（转 / 改大小），通用白点说不出这件事，而 SVG 光标
    // 在 Safari / Firefox 上又不生效（见 cursors.ts）—— 所以画成图标才真的看得出来。
    // 这里单独套一层 try/catch（外层还有一层）：一个类型的手柄画崩了，不该把
    // 「其它图形的手柄 / 白点」一起带下去 —— 出问题就退回通用白点，手柄总得抓得着。
    // 光标压在哪一支上（**只认本图形的**：`_hoverVertex` 是全局面，可能指着别的图形）；
    // -1 = 没压着手柄。它既是「图标画成激活态」的输入，也是下面通用白点填橙的依据
    const v = this._hoverVertex;
    const hvi = v && v.id === shape.id ? v.vi : -1;
    const t = this._types.get(shape.type);
    if (t) {
      let done = false;
      try { done = t.drawHandles(shape, hvi); }
      catch (err) { console.warn('[mapbox-sketch] 手柄图标绘制失败', err); }
      if (done) return;
    }
    // 点列与命中检测**同源**（`handles()`）：各取一份就会出现「白点画在这儿、
    // 手柄得去那儿拖」，而派生手柄的位置根本算不出第二份来。
    // 每个点走 paint 的 `handleDot`（白芯 + 橙圈）：类型自己画图标的那些手柄
    // （图片标注的转 / 缩、文字标注的转）剩下的通用点也从那里画，两边长得一样
    const Hs = t ? t.handles(shape) : this.projectPts(shape);
    for (let i = 0; i < Hs.length; i++) {
      // 压着的那一支翻成「橙芯 + 橙圈」并放大一圈：不这样，鼠标挪到控制点上
      // 一点反应都没有（用户 2026-09-14 报的），根本不知道有没有压在它上面
      handleDot(ctx, Hs[i].x, Hs[i].y, i === hvi);
    }
  }
}
