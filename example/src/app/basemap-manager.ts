/* =====================================================================
 * basemap-manager.ts —— 把「已叠加底图」映射到 Mapbox 的 raster 图层。
 *
 * 职责（纯地图侧，不碰 Vue / 不碰接口）：
 *   · 每个激活底图的每个 layerOption → 一个 raster source + 一个 raster layer；
 *   · 叠加顺序 = 渲染 z-order（数组尾部 = 最上层）；
 *   · 透明度走栅格图层的 `raster-opacity`（0–1）；
 *   · 显隐 = 把 opacity 临时置 0（不改 stored opacity，方便恢复）；
 *   · 增 / 删 / 拖拽改序，全部靠 setActive() 一次性对账（幂等、可重复调用）。
 *
 * 为什么用「对账」而不是「增量」：叠加层数很少（个位数），每次差异计算
 * 的成本可忽略；而增量在「拖拽连续触发」「透明度滑块连续触发」时极易出现
 * 漏加漏删的竞态，对账法每帧都收敛到同一个正确状态。
 * ===================================================================== */
import type { Map as MapboxMap, RasterSourceSpecification } from 'mapbox-gl';
import type { ActiveBasemap, BasemapLayerOption } from './basemap-service';

const PREFIX = 'bm-';
const SRC_PREFIX = 'bm-src-';

/** 图层 id：`bm-{itemId}-{layerOptionIndex}`（itemId 是接口序号，无特殊字符） */
const layerId = (itemId: number, i: number): string => `${PREFIX}${itemId}-${i}`;
const sourceId = (itemId: number, i: number): string => `${SRC_PREFIX}${itemId}-${i}`;

/**
 * 把一个 layerOption 的 url 展开成 Mapbox 能用的瓦片 URL 数组。
 * Mapbox 只认 `{x}{y}{z}`，不认 Leaflet 的 `{s}` 子域名轮换 —— 所以把 `{s}`
 * 用 subdomains 逐个替换，生成 N 条 URL 交给 `tiles`，Mapbox 会自行轮询。
 * 没有 `{s}` / 没有 subdomains 就原样返回一条。
 */
function tilesOf(opt: BasemapLayerOption): string[] {
  const { url, subdomains } = opt;
  if (subdomains && subdomains.length && url.includes('{s}')) {
    return subdomains.map((s) => url.replace(/\{s\}/g, s));
  }
  return [url];
}

export class BasemapManager {
  private map: MapboxMap | null = null;
  /** 当前已对账过的激活列表（底层存一份，setOpacity / setHidden 单独改时也要用） */
  private active: ActiveBasemap[] = [];

  attach(map: MapboxMap): void {
    this.map = map;
  }

  /** 把激活列表对账到地图：增删 source/layer、设透明度、按序排 z-order */
  setActive(list: ActiveBasemap[]): void {
    this.active = list;
    const map = this.map;
    if (!map) return;

    // 期望图层（自底向上）
    const desired: { itemId: number; i: number; tiles: string[]; tileSize?: number; maxZoom?: number }[] = [];
    list.forEach((a) => {
      a.item.layerOptions.forEach((opt, i) => {
        desired.push({ itemId: a.item.id, i, tiles: tilesOf(opt), tileSize: opt.tileSize, maxZoom: opt.maxZoom });
      });
    });
    const desiredIds = desired.map((d) => layerId(d.itemId, d.i));

    // ① 删掉不再需要的图层 + source
    for (const id of this.layerIds()) {
      if (!desiredIds.includes(id)) {
        if (map.getLayer(id)) map.removeLayer(id);
        const src = this.sourceOf(id);
        if (src && map.getSource(src)) map.removeSource(src);
      }
    }

    // ② 补上缺失的、并设透明度
    desired.forEach((d) => {
      const id = layerId(d.itemId, d.i);
      const src = sourceId(d.itemId, d.i);
      if (!map.getLayer(id)) {
        if (!map.getSource(src)) {
          map.addSource(src, {
            type: 'raster',
            tiles: d.tiles,
            tileSize: d.tileSize ?? 256,
            maxzoom: d.maxZoom ?? 18,
          } as RasterSourceSpecification);
        }
        map.addLayer({ id, type: 'raster', source: src });
      }
      const a = list.find((x) => x.item.id === d.itemId);
      const op = a ? (a.hidden ? 0 : a.opacity) : 1;
      map.setPaintProperty(id, 'raster-opacity', op);
    });

    // ③ 按期望顺序排 z-order
    this.reorder(desiredIds);
  }

  /** 只改某条底图的透明度（滑块拖动时高频调用，不必整体对账） */
  setOpacity(key: string, op: number): void {
    const a = this.active.find((x) => x.key === key);
    if (a) a.opacity = op;
    const map = this.map;
    if (!map || !a) return;
    a.item.layerOptions.forEach((_, i) => {
      const id = layerId(a.item.id, i);
      if (map.getLayer(id)) map.setPaintProperty(id, 'raster-opacity', a.hidden ? 0 : op);
    });
  }

  /** 只改某条底图的显隐 */
  setHidden(key: string, hidden: boolean): void {
    const a = this.active.find((x) => x.key === key);
    if (!a) return;
    a.hidden = hidden;
    const map = this.map;
    if (!map) return;
    a.item.layerOptions.forEach((_, i) => {
      const id = layerId(a.item.id, i);
      if (map.getLayer(id)) map.setPaintProperty(id, 'raster-opacity', hidden ? 0 : a.opacity);
    });
  }

  /**
   * 按期望 id 顺序排 z-order（数组尾部 = 最上层）。
   * moveLayer(id, beforeId) 把 id 插到 beforeId「下方」——所以自顶向下遍历，
   * 先让最上层去到顶端，再让下一层插到它下方，依次类推，整摞就压在背景之上。
   */
  private reorder(ids: string[]): void {
    const map = this.map;
    if (!map || ids.length === 0) return;
    const topToBottom = [...ids].reverse();
    topToBottom.forEach((id, idx) => {
      if (!map.getLayer(id)) return;
      if (idx === 0) map.moveLayer(id); // 最上层 → 置顶
      else map.moveLayer(id, topToBottom[idx - 1]); // 其余依次插到上一层之下
    });
  }

  /** 当前本管理器添加的所有图层 id（用前缀过滤 style.layers） */
  private layerIds(): string[] {
    const map = this.map;
    if (!map) return [];
    return (map.getStyle().layers || [])
      .map((l) => l.id)
      .filter((id) => id.startsWith(PREFIX));
  }

  /** 由图层 id 反推 source id（`bm-5-0` → `bm-src-5-0`） */
  private sourceOf(layerIdStr: string): string | null {
    const m = layerIdStr.match(/^bm-(\d+)-(\d+)$/);
    if (!m) return null;
    return sourceId(Number(m[1]), Number(m[2]));
  }
}
