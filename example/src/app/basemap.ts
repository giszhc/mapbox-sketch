/* =====================================================================
 * basemap.ts —— 示例用的底图样式骨架。
 *
 * 不再写死任何一张底图：底图全部由 BasemapManager 从接口拉取后动态挂上
 * （见 basemap-service.ts / basemap-manager.ts）。这里只保留一个最轻的
 * style —— 一层浅色背景，避免「还没加载任何底图」时地图是黑屏。
 * 本文件属于示例（demo），不进发布产物。
 * ===================================================================== */

/** 最轻量 style：只有一层背景，底图瓦片由 BasemapManager 动态 addSource / addLayer */
export const BASE_STYLE = {
  version: 8 as const,
  sources: {},
  layers: [
    { id: 'bg', type: 'background' as const, paint: { 'background-color': '#e8eef2' } },
  ],
};

/** 示例地图的初始视野：`[经度, 纬度]` = 108°E, 34°N（中国中部一带） */
export const INITIAL_CENTER: [number, number] = [108, 34];
/** 初始级别 3 —— 全国尺度的概览视野 */
export const INITIAL_ZOOM = 3;
