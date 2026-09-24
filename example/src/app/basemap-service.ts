/* =====================================================================
 * basemap-service.ts —— 底图列表的接口与数据模型（demo 专属）。
 *
 * 底图全部来自远程接口 https://map-assets.geoyt.cn/basemap/getList ，
 * 每个底图由若干「瓦片服务」组成（如「矢量 + 注记」是两条 layerOption）。
 * 本文件只负责：拉数据、归一化、生成稳定 key，以及把 `{s}` 子域名展开成
 * 多个瓦片 URL（Mapbox 的 raster source 不认 `{s}`，只认 `{x}{y}{z}`）。
 *
 * 不再内置任何写死的单张影像：默认叠加「列表第 6 个」（天地图影像 有注记），
 * 由 loadBasemaps() 在拉到列表后定。
 * ===================================================================== */

/** 单个瓦片服务的配置（接口原样字段） */
export interface BasemapLayerOption {
  url: string;
  subdomains?: string[];
  serverType?: string;
  maxZoom?: number;
  tileSize?: number;
}

/** 一个底图（接口里的一条） */
export interface BasemapItem {
  /** 接口里的序号，用作 Mapbox 图层 / source 的稳定 id（不含特殊字符） */
  id: number;
  name: string;
  group: string;
  opacity: number;
  tags: string[];
  iconUrl: string;
  layerOptions: BasemapLayerOption[];
  /** 人类可读的稳定标识（group / name / tags），用于去重与激活判断 */
  key: string;
}

/** 已叠加到底图上的一条：指向某个 BasemapItem，带自身的透明度与显隐 */
export interface ActiveBasemap {
  key: string;
  item: BasemapItem;
  /** 透明度 0–1 */
  opacity: number;
  /** 是否隐藏（隐藏 = 透明度临时置 0，不改变 opacity 以便恢复） */
  hidden: boolean;
}

const API_URL = 'https://map-assets.geoyt.cn/basemap/getList';

/** 接口原始结构（只列用到的字段） */
interface RawBasemap {
  name: string;
  group: string;
  opacity: number;
  checked?: boolean;
  tags: string[];
  iconUrl: string;
  layerOptions: BasemapLayerOption[];
}

/** 稳定 key：group / name / tags 拼起来，能区分「有注记 / 无注记」这类同名项 */
function keyOf(r: RawBasemap): string {
  const tag = r.tags && r.tags.length ? ` / ${r.tags.join(',')}` : '';
  return `${r.group} / ${r.name}${tag}`;
}

function normalize(r: RawBasemap, i: number): BasemapItem {
  return {
    id: i,
    name: r.name,
    group: r.group,
    opacity: typeof r.opacity === 'number' && r.opacity > 0 && r.opacity <= 1 ? r.opacity : 1,
    tags: r.tags || [],
    iconUrl: r.iconUrl,
    layerOptions: (r.layerOptions || []).map((o) => ({
      url: o.url,
      subdomains: o.subdomains,
      serverType: o.serverType,
      maxZoom: o.maxZoom,
      tileSize: o.tileSize,
    })),
    key: keyOf(r),
  };
}

let cache: BasemapItem[] | null = null;

/**
 * 拉取底图列表（带内存缓存：多次调用只请求一次）。
 * @throws 网络 / 格式错误，由调用方落到界面提示
 */
export async function fetchBasemaps(): Promise<BasemapItem[]> {
  if (cache) return cache;
  const res = await fetch(API_URL, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`底图列表接口返回 ${res.status}`);
  const raw = (await res.json()) as RawBasemap[];
  if (!Array.isArray(raw)) throw new Error('底图列表接口返回格式异常');
  cache = raw.map(normalize);
  return cache;
}

/** 把一个 BasemapItem 变成「已叠加」状态 */
export function makeActive(item: BasemapItem, opacity = 1): ActiveBasemap {
  return { key: item.key, item, opacity, hidden: false };
}
