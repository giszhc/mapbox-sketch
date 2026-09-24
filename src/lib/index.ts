/* =====================================================================
 * index.ts —— 包的主出口（`import … from '@giszhc/mapbox-sketch'`）。
 *
 * 导出的东西：
 *   · MapboxSketch      主类（同时是 default 导出）
 *   · MapboxShapeType   类型基类，第三方扩展要 extends 它
 *   · 41 个内置类型类     同时触发自注册（import 本文件即全部可用）
 *   · math / paint      命名空间形式的几何工具与 canvas 原语
 *   · 全部公共类型       见 types.ts
 *
 * 只要引擎内核、不要内置类型 → 用 `import … from '@giszhc/mapbox-sketch/core'`。
 * ===================================================================== */

/* 主类（default 也导出，方便 `import MapboxSketch from '@giszhc/mapbox-sketch'`） */
export { MapboxSketch, MapboxSketch as default } from './sketch';

/* 测量工具：门面 + 它专用的渲染变体（测距文字「开始 / 总长：…」） */
export {
  MapboxSketchMeasure, MEASURE_HALO_COLOR, MEASURE_TEXT_COLOR,
} from './measure';
export type { MeasureOptions } from './measure';
export { MeasureDistanceShape, MeasureAreaShape, fmtTotal, fmtEdge } from './measure-shapes';

/* 类型基类与类型判定/默认命中规则（写自定义类型要用） */
export {
  MapboxShapeType,
  isShapeType,
  defaultLineHit,
  defaultRingHit,
} from './sketch-shape-type';

/* 注册表（自注册用的就是它；一般由各类型文件自行调用）。
 * 两个出口都要导出 registerType / registeredTypes —— 否则从 core 写好的代码
 * 换成主出口时会莫名少一个函数。 */
export { registerType, registeredTypes } from './registry';
export type { ShapeTypeRegistrable } from './registry';

/* 出厂默认值（外部 UI 想在建实例前回显默认值时用；**不要直接改这两个对象**） */
export { DEFAULT_CFG, DEFAULT_STYLE, SKETCH_DATA_VERSION } from './constants';

/* 41 个内置类型：导出类 + 顺带完成自注册 */
export * from './shapes';

/* 扩展用的工具集：`math.buildArc(...)` / `paint.haloText(...)` */
export * as math from './math';
export * as paint from './paint';

/* 手柄光标（`vertexCursor()` 的返回值）：转圈箭头 / 双向箭头。
   类型自己想给某个手柄换光标时直接调它们，不必手写一串 SVG data URL。 */
export { rotateCursor, scaleCursor } from './cursors';

/* 富文本标注的内容解析（`<b>` / `<s=24>` / `<c=#e03131>`… → 行 × 段）。
   ★ 纯函数、零依赖：宿主要在自己的 UI 里预览这段富文本（比如把标签渲染成带样式的
   预览）或者只要「去掉标签的纯文字」都能用它，不必自己去啃 `shapes/rich-text.ts`
   里那份排版代码。语法说明见 `rich-text.ts` 的文件头。 */
export { parseRichText, plainOfLine, LINE_H, BG_RADIUS } from './rich-text';

/* 图片导出：像素规划与纸张换算（纯函数）。
   `planExport` 可用来预览会导出多大、纸框画在哪 —— 宿主要在屏幕上画一圈虚线纸框就
   直接读它返回的 `frameX/frameY/frameW/frameH`，别另抄一套算式。
   `PAPER_SIZES` / `mmToCssPx` 给宿主自己拼纸张下拉框、算毫米数用。
   ★ 导出尺寸**不设上限**（2026-09-15 起）：要多少像素给多少，太大时由浏览器自己报错，
   引擎不再悄悄降 dpi。宿主若想拦一道，自己拿 `outW/outH` 估一下。
   ★ 大纸的出路是**分块导出**：`paperGrid()` 算「这张大纸切成几行几列、每块多大」，
   `planExportTiles()` 给出逐块的规划（每块的 `cell` 喂给 `exportImage` 的 `cell` 选项），
   每块是一张完整的纸、拿出去打印不用拼。
   ★ 但**切几块不该让宿主去选**（浏览器画布上限是个技术约束，用户没有依据判断）：`autoPaperGrid()`
   与 `autoViewportGrid()` 按 `TILE_PIXEL_BUDGET`（3500 万像素）反推最省的分块数，返回 `null`
   就是「不用切」—— 可以直接当成开关用。
   ★ 只导出这几项：同文件的 `crc32` / `applyPngDpi` / `applyJpegDpi` 是 `exportImage()`
   内部的字节手术，**故意不公开** —— 它们没有独立的使用场景，公开出去就成了一份要
   长期兼容的格式契约。core.ts 里导出的是同一份清单，两边必须保持一致。 */
export {
  BASE_DPI, PAPER_SIZES, mmToCssPx, paperFrame, planExport, paperGrid, planExportTiles,
  autoPaperGrid, autoViewportGrid, TILE_PIXEL_BUDGET,
  // 图廓整饰（专题图）：外边距归一 + 整页画布规划。
  // 宿主自己画整饰时用 `planDecorate` 算「整页多大、地图贴在哪」，别另抄一套减法 ——
  // 与 `decorate` 回调里的 `info` 是同一个算式。
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
  ImportResult, LngLat, MapboxMap, MeasureKind, PickImageResult, PlaceContext, PlaceResult,
  RichLine, RichSegment,
  ScreenPoint, Shape, ShapeData, ShapeDatum, ShapeTypeCtor, ShapeTypeHooks, SketchData,
  SketchOptions, SnapHit, SnapKind, SnapOptions,
  SpreadMode, Style, StyleKey, StylePatch, TickPos, LineType,
} from './types';
export type { Arc, ArcPoint, ArcSeg } from './math';
export type { CharRunItem, TextPaintOpts, TicksOpts } from './paint';
export type { LeaderLayout } from './shapes/leader';
export type { SketchHost, MapPointerEventLike } from './internal';
