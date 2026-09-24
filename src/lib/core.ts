/* =====================================================================
 * core.ts —— 包的内核出口（`import … from '@giszhc/mapbox-sketch/core'`）。
 *
 * 与 index.ts 的唯一区别：**不引入 41 个内置类型**，因此不带任何自注册副作用。
 * 适合「只用引擎 + 自己的类型」的场景（体积最小、类型表由你自己掌控）：
 *
 *   import { MapboxSketch, MapboxShapeType } from '@giszhc/mapbox-sketch/core';
 *   class MyShape extends MapboxShapeType { … }
 *   MapboxSketch.registerType(MyShape);           // 或 tool.addType(MyShape)
 *   const tool = new MapboxSketch(map);           // 类型表里只有 MyShape
 *
 * 想要开箱可用的 41 种类型 → 用主出口 `@giszhc/mapbox-sketch`。
 * ===================================================================== */

/* 主类（default 也导出） */
export { MapboxSketch, MapboxSketch as default } from './sketch';

/* 类型基类与类型判定 / 默认命中规则 */
export {
  MapboxShapeType,
  isShapeType,
  defaultLineHit,
  defaultRingHit,
} from './sketch-shape-type';

/* 注册表 */
export { registerType, registeredTypes } from './registry';
export type { ShapeTypeRegistrable } from './registry';

/* 出厂默认值 + 数据文件版本号（导出/导入用；核心出口同样有序列化） */
export { DEFAULT_CFG, DEFAULT_STYLE, SKETCH_DATA_VERSION } from './constants';

/* 扩展用的工具集 */
export * as math from './math';
export * as paint from './paint';

/* 手柄光标（`vertexCursor()` 的返回值）：转圈箭头 / 双向箭头。
   ★ 清单与 index.ts **逐项一致** —— 只从一边导出，正是 AGENTS 里点名的那种
   「换个出口就莫名少一个」的坑。 */
export { rotateCursor, scaleCursor } from './cursors';

/* 富文本标注的内容解析（`<b>` / `<s=24>` / `<c=#e03131>`… → 行 × 段）。
   ★ 清单与 index.ts **逐项一致**（同上面那两条）：它是纯函数、零依赖，自定义类型
   想自己画一段富文本时直接用它，不必再抄一份标签语法。 */
export { parseRichText, plainOfLine, LINE_H, BG_RADIUS } from './rich-text';

/* 图片导出：像素规划与纸张换算（纯函数，宿主可用来预览「会导出多大」以及纸框该画
   在哪）。
   ★ 导出尺寸**不设上限**（2026-09-15 起）：`planExport` 不再夹取、不再降 dpi ——
   太大时由浏览器自己失败，见 index.ts 里那段。
   ★ 大纸走**分块导出**：`paperGrid()` 算网格、`planExportTiles()` 给逐块规划，
   每块是一张完整的纸；**切几块不必让宿主选** —— `autoPaperGrid()` / `autoViewportGrid()`
   按 `TILE_PIXEL_BUDGET` 反推最省的分块数，`null` 就是「不用切」（见 index.ts 那段）。
   ★ 清单与 index.ts **逐项一致**：`crc32` / `applyPngDpi` / `applyJpegDpi` 是
   `exportImage()` 内部的字节手术，两边都不导出 —— 只从一边多导出一个函数，
   正是 AGENTS 里点名的那种「换个出口就莫名少一个」的坑。 */
export {
  BASE_DPI, PAPER_SIZES, mmToCssPx, paperFrame, planExport, paperGrid, planExportTiles,
  autoPaperGrid, autoViewportGrid, TILE_PIXEL_BUDGET,
  // 图廓整饰（专题图）：清单同样与 index.ts 逐项一致
  normalizeMargin, planDecorate,
} from './export-image';
export type {
  AutoGrid, DecorateLayout, ExportCell, ExportGrid, ExportGridInput, ExportGridTile, ExportMargin,
  ExportPlan, ExportPlanInput,
  PaperFrame, PaperGrid, PaperOrientation, PaperSize, PaperSpec,
} from './export-image';

/* 全部公共类型 */
export type {
  BBox, Cfg, CfgKey, CfgPatch, DragContext, DrawSession, ExportDecorateInfo,
  ExportImageOptions, ExportImageResult,
  ExportMapOptions, ExportPhase, ExportProgress, ExportTiles, GeomKey, GeomPatch, GeomState,
  ImportResult, LngLat, MapboxMap, PickImageResult, PlaceContext, PlaceResult,
  RichLine, RichSegment,
  ScreenPoint, Shape, ShapeData, ShapeDatum, ShapeTypeCtor, ShapeTypeHooks, SketchData,
  SketchOptions, SnapHit, SnapKind, SnapOptions,
  SpreadMode, Style, StyleKey, StylePatch, TickPos,
} from './types';
export type { Arc, ArcPoint, ArcSeg } from './math';
export type { TextPaintOpts, TicksOpts } from './paint';
export type { SketchHost, MapPointerEventLike } from './internal';
