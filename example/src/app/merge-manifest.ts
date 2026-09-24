/** ZIP 合并清单的浏览器侧契约，与独立 Node 服务的 manifest.ts 保持一致。 */
export interface MergeManifestTile {
  index: number;
  col: number;
  row: number;
  file: string;
}

/** 绘制前端写入 ZIP 的合并说明书。调整字段时需同步服务端契约版本。 */
export interface MergeManifest {
  version: 1;
  paperLabel: string;
  dpi: number;
  format: 'png' | 'jpeg';
  cols: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
  width: number;
  height: number;
  createdAt: string;
  center?: [number, number];
  zoom?: number;
  title?: string;
  tiles: MergeManifestTile[];
}
