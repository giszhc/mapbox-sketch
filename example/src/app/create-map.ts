/* =====================================================================
 * create-map.ts —— 示例的地图创建与 token 存取。
 *
 * 把「建图 / 报错归类 / 存 token」从组件里拆出来，组件只管调用与展示。
 * 注意：这是示例（demo）代码，mapbox-gl 在这里是**运行时**依赖；
 * 库源码（src/lib）里 mapbox-gl 永远只做 `import type`。
 * ===================================================================== */
import mapboxgl from 'mapbox-gl';
import type { ExportMapOptions } from '@giszhc/mapbox-sketch';
import { BASE_STYLE, INITIAL_CENTER, INITIAL_ZOOM } from './basemap';

/**
 * token 的 localStorage 键名。
 * ★ 保持 'mapbox_token' 不变 —— 用户已有的 token 就存在这个键下，
 *   换个名字等于把他们的 token 弄丢。
 */
export const TOKEN_KEY = 'mapbox_token';

/** 读取已保存的 token（没有则空串） */
export function readToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return ''; // 隐私模式等禁用了 localStorage
  }
}

/** 记住 token，下次打开自动回填 */
export function saveToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* 存不了就算了，不影响本次使用 */
  }
}

/** mapbox 的错误消息 → 给人看的中文提示（客户端消息，纯展示） */
export function describeMapError(message: string): string {
  const hint = /unauthor|forbidden|403|401|quota|402/i.test(message)
    ? '\n→ token 无效 / 过期 / 超出配额，请到 console 申请或换一个 token'
    : '\n(提示：若频繁 404，可能是地图样式缺图层，不影响本示例的标注)';
  return `Mapbox 报错：${message}${hint}`;
}

/**
 * mapbox 自身常抛的「无害噪声」消息（请求被切掉、瓦片 404 之类），
 * 这类不往界面上报，否则换 token / 拖地图时会满屏红条。
 */
export function isIgnorableMapError(message: string): boolean {
  if (!message) return true;
  return /aborted|canceled/i.test(message);
}

/**
 * 「没配 token」那句噪声 —— 只在**出图地图**上降噪用（见 `createExportMap`）。
 * 屏幕上的地图不适用：它的错误要经 `describeMapError` 报到界面上。
 */
const NO_ACCESS_TOKEN = /access token is required/i;

/**
 * 出图用的隐藏地图构造器 —— 交给引擎的 `SketchOptions.createMap`。
 *
 * 库自己不 import mapbox-gl（零依赖硬约束），它默认只能拿宿主地图的 `constructor`
 * 来兜底。示例这里本来就是运行时依赖 mapbox-gl，所以**显式传一个**：
 * 一是不用去碰 `constructor` 这种内部手段，二是 `accessToken` 是我们自己的，
 * 语义清楚。
 *
 * 选项由引擎算好（容器尺寸、补偿过的 zoom、放大后的 padding…），这里**原样透传**，
 * 一个字都不要自己改 —— 改哪一项都会让导出图跟屏幕上的视口对不上。
 */
export function createExportMap(o: ExportMapOptions): mapboxgl.Map {
  if (o.accessToken) mapboxgl.accessToken = o.accessToken;
  // accessToken 先摆好，再 spread：它不在 MapOptions 里，直接塞进去 mapbox 会当成未知项
  const { accessToken: _ignored, ...options } = o;
  void _ignored;
  /*
   * ★ 本地导出的隐藏地图也必须关掉本地 CJK 接管（`localIdeographFontFamily` 默认
   *   'sans-serif' 会用**本机系统字体**画中文，样式 text-font 配的自定义字体栈失效）。
   *   本地导出走这里；不设的话，同一张图屏幕是刻本宋、导出来变系统字。
   *   引擎透传的 options 不认识这个字段，这里补上不影响视口几何（纯渲染层）。
   *   运行时认一切假值（→ LocalGlyphMode.none），.d.ts 只写了 string，断言见
   *   断言是因为 Mapbox GL 的运行时接收假值，而类型声明只写了 string。
   */
  const map = new mapboxgl.Map({
    ...options,
    localIdeographFontFamily: false as unknown as string,
  } as mapboxgl.MapOptions);
  /*
   * 出图地图是**离屏**的，没人看它的界面，但它照样会 fire `error`。
   * 一旦**没有任何监听者**，mapbox 就把错误事件直接抛到 window —— 实测 3.22 在
   * 「没配 token、底图又不是 mapbox 托管源」时会抛
   * `A valid Mapbox access token is required`（`Map#_authenticate` 拿到 `NO_ACCESS_TOKEN`
   * 后走 `_revokeAuth()`），于是控制台在**每次出图时冒一条红色未捕获异常**，
   * 看着像是出图炸了（实际出图是好的：这条错误地图非托管瓦片压根用不到 token）。
   *
   * 这里**只降噪、不静默**：已知噪声（被切掉的请求、token 那句）丢掉，其它照旧打出来 ——
   * 出图地图上的真错误必须留痕，不能因为「反正用户看不见」就吞掉。
   */
  map.on('error', (e: unknown) => {
    const err = e as { error?: { message?: string }; message?: string };
    const msg = String(err?.error?.message || err?.message || '');
    if (isIgnorableMapError(msg) || NO_ACCESS_TOKEN.test(msg)) return;
    console.error('[Mapbox export error]', msg);
  });
  return map;
}

/** 建图所需的回调 */
export interface CreateMapOptions {
  /** 地图挂载的容器元素 */
  container: HTMLElement;
  /** 有效的 Mapbox Access Token */
  token: string;
  /**
   * 额外要挂到右下角的自定义控件（如测量按钮组）。
   * ★ 它们**先于** NavigationControl 加入：mapbox 同一角落的控件按加入顺序
   *   从上往下排，先加的在上 —— 这样测量按钮组正好落在缩放按钮上方。
   *   三个控件都放在右下角，但整列上移让出底部给底图按钮（.bm-fab，见 global.css）。
   */
  controls?: mapboxgl.IControl[];
  /** 样式就绪后回调（此时才能创建绘制工具并 push 图形） */
  onLoad: (map: mapboxgl.Map) => void;
  /** 需要展示给用户的错误（已经过滤掉无害噪声） */
  onError: (msg: string) => void;
}

/**
 * 创建一个地图实例。
 * 底图用内联 style（ArcGIS 影像），只依赖 token 有效，不依赖 mapbox 托管样式。
 */
export function createMap(o: CreateMapOptions): mapboxgl.Map {
  mapboxgl.accessToken = o.token;

  const map = new mapboxgl.Map({
    container: o.container,
    style: BASE_STYLE as unknown as mapboxgl.StyleSpecification,
    center: INITIAL_CENTER,
    zoom: INITIAL_ZOOM,
    // 关掉默认右下角署名：它会被右下角的底图按钮盖住。下面在左下角重新挂一个紧凑版。
    attributionControl: false,
  });
  // 先加自定义控件再加导航控件：同角落按加入顺序从上往下排，
  // 这样测量按钮组才压在缩放按钮的上方（见 CreateMapOptions.controls）。
  // 三处都回右下角；右下角控件整列上移由 global.css 的
  // .mapboxgl-ctrl-bottom-right { margin-bottom } 负责，让出底部给底图按钮（.bm-fab）。
  for (const c of o.controls || []) map.addControl(c, 'bottom-right');
  map.addControl(new mapboxgl.NavigationControl(), 'bottom-right');
  map.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-right');

  map.on('error', (e: unknown) => {
    const err = e as { error?: { message?: string }; message?: string };
    const msg = String(err?.error?.message || err?.message || '');
    if (isIgnorableMapError(msg)) return;
    console.error('[Mapbox error]', msg);
    o.onError(describeMapError(msg));
  });

  map.on('load', () => o.onLoad(map));

  return map;
}
