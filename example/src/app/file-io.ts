/* =====================================================================
 * file-io.ts —— 示例页自己的浏览器文件读写（**库不碰这些东西**）。
 *
 * 单独一个文件而不是塞进 use-sketch.ts：桥要保持「纯转交」才跑得进 vitest
 * （jsdom 没有 URL.createObjectURL，也弹不出文件选择框）。
 *
 * 读文件那半边**故意不在这里**：`<input type="file">` 由 PanelFooter 自己常驻，
 * 见那里的注释（用临时 input 的话，用户取消选择时 change 不触发，元素与监听
 * 就留在那儿了）。
 * ===================================================================== */

import type { MergeManifest } from './merge-manifest';

/** 把一段字节存成文件并触发下载（JSON 与图片共用这一条路径） */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 点完立刻 revoke，部分浏览器会把还在进行的下载掐断；排到下一个宏任务再收回
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** 把文本存成文件并触发下载 */
export function downloadText(filename: string, text: string): void {
  downloadBlob(filename, new Blob([text], { type: 'application/json;charset=utf-8' }));
}

/** 时间戳部分（导出的文件名共用）：`YYYYMMDD-HHmm`，连续导出几次不会互相覆盖 */
function stamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const d = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
  const t = `${p(now.getHours())}${p(now.getMinutes())}`;
  return `${d}-${t}`;
}

/**
 * JSON 文件名。`now` 可注入，省得为了测文件名去 mock 时间。
 */
export function jsonFileName(now: Date = new Date()): string {
  return `mapbox-sketch-${stamp(now)}.json`;
}

/** 分块导出时文件名里的块标签（索引都是**给用户看的 1 起**写法） */
export interface TileLabel {
  /** 第几块（1 起） */
  index: number;
  /** 一共几块 */
  total: number;
}

/**
 * 块标签：「不切块」与「只切出 1 块」都返回空串（文件名与旧版逐字符相同）。
 *
 * ★ 序号**按总数的位数补零**：`第1块…第16块` 不补零时，资源管理器会按字符串排序
 *   排成 1、10、11、…、2 —— 而拼版恰恰是按序号从左到右、从上到下贴的，
 *   顺序一乱就要人工重排。补零后 `第01块…第16块` 排出来就是对的。
 */
function tileTag(tile?: TileLabel | null): string {
  if (!tile || !(tile.total > 1) || !(tile.index > 0)) return '';
  const width = String(tile.total).length;
  return `-第${String(tile.index).padStart(width, '0')}块共${tile.total}块`;
}

/**
 * 图片文件名：`mapbox-sketch-20260910-1432-300dpi.png`（纸张模式多一段
 * `-A4横`：`mapbox-sketch-20260910-1432-A4横-300dpi.png`；分块导出再多一段
 * `-第01块共04块`，见 `tileTag`）。
 *
 * 把 dpi 写进文件名是有用的：同一张图导两遍不同分辨率，下载目录里一眼分得清，
 * 不必点开属性看 —— 而 dpi 恰恰是没法从画面内容上看出来的那个参数。
 * 纸张标签同理：同一次浏览导一份视口图、一份 A3 横图，光看文件名分不出谁是谁。
 *
 * @param ext 扩展名（不带点），`'png'` / `'jpg'`
 * @param dpi 实际生效的 dpi（用 `exportImage()` 返回的那个值，别报一个跟文件不符的数）
 * @param paper 纸张标签（如 `'A4横'`）；不传 / 空串时文件名与旧版**逐字符相同**
 * @param tile 分块导出的块标签；不切块时不传
 */
export function imageFileName(
  ext: string, dpi: number, paper?: string, tile?: TileLabel | null, now: Date = new Date(),
): string {
  const tag = paper ? `-${paper}` : '';
  return `mapbox-sketch-${stamp(now)}${tag}${tileTag(tile)}-${dpi}dpi.${ext}`;
}

/**
 * 整包 zip 的文件名：`mapbox-sketch-20260910-1432-A0横-4张-300dpi.zip`。
 *
 * 与 `imageFileName` 同样的道理：一本「A0 横切 4 张 @300dpi」和一本「A3 横整张 @600dpi」
 * 光看名字分不出来，而它们**确实会同时躺在下载目录里**。
 */
export function zipFileName(
  dpi: number, paper?: string, count?: number, now: Date = new Date(),
): string {
  const tag = paper ? `-${paper}` : '';
  const n = count && count > 1 ? `-${count}张` : '';
  return `mapbox-sketch-${stamp(now)}${tag}${n}-${dpi}dpi.zip`;
}

/* =====================================================================
 * zip 打包（store 模式，不压缩）
 *
 * ★ 为什么用 store（method 0）而不是 deflate：包里装的是 PNG / JPEG，**本来就压过了**，
 *   再 deflate 一遍收益接近 0；而代价是要么引一个压缩库、要么自己写 —— 示例页为了
 *   「打个包」不值当。store 模式的 zip 是所有解压工具都认的最基本形态。
 *
 * ★ 为什么要自己写这 80 行：浏览器**没有**任何内建 API 能生成 zip（`CompressionStream`
 *   只有 gzip / deflate，没有 zip 的容器格式）。这是示例页（可以引依赖）而不是库，
 *   对库那条「零依赖」的硬规矩**不适用** —— 但既然只有这一个需求，自己写比引库干净。
 * ===================================================================== */

/** 单个文件 / 整包的 4GB 上限：再大就得 ZIP64 了，本示例不实现 */
const ZIP_MAX = 0xffffffff;

/**
 * ZIP 用的 CRC32（反射式，多项式 `0xEDB88320`）。
 *
 * ★ 与库里的 `crc32`（`export-image.ts`）是**同一套算法，故意各留一份**：
 *   库那个是 PNG `pHYs` 块的内部实现，**没有导出** —— 它是格式契约的一部分，
 *   公开出去就成了一份要长期兼容的 API。这里为了一条示例页的 zip 去改库的出口清单，
 *   属于「让公共 API 迁就内部用法」，不划算。两份都是 12 行的标准实现，且都被各自的
 *   用例用同一批标准向量钉着（`crc32('123456789') = 0xCBF43926`），不会各写各的悄悄歪掉。
 */
let CRC_TABLE: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[i] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** zip 里的一个条目 */
export interface ZipEntry {
  /** 包内文件名（可带中文） */
  name: string;
  blob: Blob;
}

/** 把 `Date` 折成 MS-DOS 的日期 / 时间字段（zip 格式从 1980 年起算） */
function dosStamp(now: Date): { time: number; date: number } {
  const time = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const date = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
  return { time, date };
}

/**
 * 把若干文件打成一个 zip（store 模式）。
 *
 * ★ 内存：图片字节**一次只驻留一张** —— CRC 必须先算出来才能写局部文件头，所以每个
 *   条目读一遍自己的 `arrayBuffer()`，算完即丢，只留下 4 字节的 CRC 与长度。
 *   装箱本身用 `Blob` 分片**引用**原 blob 拼接，不再复制一遍图片数据。
 *   （N 张大图同时驻留在调用方手里这件事避免不了 —— 那是宿主该权衡的，不是这里能解决的。）
 *
 * ★ 通用位标记恒开 `0x0800`（文件名为 UTF-8）：这批文件名里有中文（`A0横`、`第01块`），
 *   不开这一位 Windows 资源管理器会显示成乱码 —— 而这一位几乎所有解压工具都支持。
 *
 * @param now 注入的时间（写进条目的修改时间）；不传取当前时间
 */
export async function zipBlobs(entries: ZipEntry[], now: Date = new Date()): Promise<Blob> {
  const { time, date } = dosStamp(now);
  const encoder = new TextEncoder();
  const parts: BlobPart[] = [];         // 要拼进最终 Blob 的片段（图片是**引用**，不是副本）
  // ★ 显式写成 `Uint8Array<ArrayBuffer>` 而不是 `Uint8Array`：TS 5.7 起 `BlobPart`
  //   只收「背后是 ArrayBuffer」的视图（`SharedArrayBuffer` 不算），而默认的
  //   `Uint8Array` 是 `Uint8Array<ArrayBufferLike>` —— 不写这一笔，拼 Blob 那行不给过
  const central: Uint8Array<ArrayBuffer>[] = [];   // 中央目录项，攒到最后一起写
  let offset = 0;                        // 下一条局部头在包里的偏移

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    // ★ 读一遍拿 CRC / 长度；算完 `bytes` 就随本轮作用域结束而被回收
    const bytes = new Uint8Array(await entry.blob.arrayBuffer());
    const size = bytes.length;
    const crc = crc32(bytes);

    // 局部文件头（30 字节 + 文件名）
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);   // 签名
    lv.setUint16(4, 20, true);           // 解压所需版本 2.0（store 模式的最低要求）
    lv.setUint16(6, 0x0800, true);       // 通用位标记：文件名是 UTF-8
    lv.setUint16(8, 0, true);            // 压缩方法 0 = store
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);        // 压缩后大小（store 模式下两者相等）
    lv.setUint32(22, size, true);        // 原始大小
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);           // 扩展字段长度
    local.set(name, 30);

    parts.push(local, entry.blob);

    // 中央目录项（46 字节 + 文件名）—— 多出来的字段全是「这个包里有几个盘」那套，
    // 单文件 zip 一律填 0
    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);   // 签名
    cv.setUint16(4, 20, true);           // 制作版本
    cv.setUint16(6, 20, true);           // 解压所需版本
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true);           // 扩展字段
    cv.setUint16(32, 0, true);           // 注释
    cv.setUint16(34, 0, true);           // 起始磁盘号
    cv.setUint16(36, 0, true);           // 内部属性
    cv.setUint32(38, 0, true);           // 外部属性（权限位，示例页用不上）
    cv.setUint32(42, offset, true);      // 这条的局部文件头在包里的偏移
    cd.set(name, 46);
    central.push(cd);

    offset += 30 + name.length + size;
    // 4GB 上限（ZIP64 没实现）：与其给一个解不开的包，不如当场说清楚。
    // 单个条目与累计偏移都得查 —— 中央目录里的偏移字段就是 32 位的。
    if (size > ZIP_MAX || offset > ZIP_MAX) throw new Error(ZIP_TOO_BIG);
  }

  let cdSize = 0;
  for (const cd of central) cdSize += cd.length;

  // 中央目录结束记录（EOCD）—— 必须在包的最末尾
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);              // 本盘编号
  ev.setUint16(6, 0, true);              // 中央目录所在的盘
  ev.setUint16(8, central.length, true); // 本盘上的条目数
  ev.setUint16(10, central.length, true);// 总条目数
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);        // 中央目录的起始偏移
  ev.setUint16(20, 0, true);             // 注释长度

  return new Blob([...parts, ...central, eocd], { type: 'application/zip' });
}

/** 超过 4GB 的中文报错（ZIP64 没实现） */
const ZIP_TOO_BIG = '打包失败：内容超过 zip 的 4GB 上限（本示例未实现 ZIP64）。'
  + '请降低 dpi，或把纸切得更细。';

/* =====================================================================
 * 合并包：manifest.json + 各块图片
 *
 * 这一节产出的 zip 是**给合并服务读的**（见 `server/README.md`），与「大图切块」
 * 是同一批产物、两种用法：
 *   · 服务在 → 传上去，拿回一张合并好的大图；
 *   · 服务不在 → 直接落盘，解压开是按序号排好的若干张标准纸，拿去打印不用拼。
 * 所以 zip 里**始终**带着 manifest —— 它不影响手工拼版，却让「事后补一次合并」
 * 成为可能（用户把 zip 拖进兜底页就能补）。
 * ===================================================================== */

/**
 * 包内说明书的固定文件名（服务端按名字找它，**别改**）。
 *
 * ★ 服务端（`server/manifest.ts`）那边有一个**独立**的同名常量，两份是故意不共享的：
 *   契约的方向是 demo → server，且只走「HTTP 或 `import type`」，一旦这里改成
 *   从服务端再导出，demo 包里就会开始混进服务端代码。
 *   两个字符串相等这件事由 `test/merge-contract.spec.ts` 钉住 —— 写错一边就红。
 */
export const MERGE_MANIFEST_NAME = 'manifest.json';

/** 写 manifest 要的那些料：位置来自 `planExportTiles()`，尺寸来自引擎的返回 */
export interface MergeManifestInput {
  /** 纸张标签，如 `'A0横'`；跟随视口时传空串 */
  paperLabel: string;
  /** **实际生效**的 dpi（取引擎返回的 `result.dpi`，不是下拉框里选的那个） */
  dpi: number;
  format: 'png' | 'jpeg';
  cols: number;
  rows: number;
  /**
   * 地图中心点 `[lng, lat]`（可选）。只用于给合并出的 PNG 写 `iTXt(GPS)` 元数据，
   * 不参与拼图。缺省则合并图少这一条信息。
   */
  center?: [number, number];
  /** 地图级别（可选）。合并出的 PNG 写进 `iTXt(Zoom)`。 */
  zoom?: number;
  /**
   * 导出文件名（不含扩展名，可选）。合并出的 PNG 的 `iTXt(Title)` 优先用它，
   * 缺省则服务端回退成 `"merged-{宽}x{高}"`。
   */
  title?: string;
  /**
   * 逐块。`col`/`row` 必须来自 `planExportTiles()` 给的那份（`ExportGridTile`），
   * **不要用 `index` 现算** —— 那就是第二套行列算式，哪天行列口径变了（比如宽高方向
   * 反过来）只有一边会跟着改，而产物看起来完全正常。
   */
  tiles: {
    index: number; col: number; row: number;
    /** 这一块的实际像素宽（引擎返回的 `result.width`） */
    width: number;
    /** 这一块的实际像素高 */
    height: number;
    /** 包内文件名 */
    file: string;
  }[];
  now?: Date;
}

/**
 * 攒一份 manifest。
 *
 * ★ `width`/`height` 是**各块累加**出来的，不是 `cols × tileWidth`：每一块都各自
 *   `round()` 过，加起来会比「整张一次算」多出 1~2 像素（A0 横 @600 是 +1/+2）。
 *   这个差是已知且被接受的 —— 服务端还会拿真实 PNG 再算一遍，两边必须相等，
 *   所以这里更要老老实实按累加算，而不是按名义值推。
 *
 * ★ 块不齐时**当场抛**：少一块的包服务端一定会拒，与其让用户白传几个 GB 再看到一个
 *   400，不如在本地就停下。调用方本来就该先看 `failures` 再决定要不要合并。
 */
export function buildMergeManifest(input: MergeManifestInput): MergeManifest {
  const { cols, rows, tiles } = input;
  if (tiles.length !== cols * rows) {
    throw new Error(`合并包缺块：应该有 ${cols}×${rows} = ${cols * rows} 块，`
      + `实际只有 ${tiles.length} 块。缺块时无法合并，请重新导出缺的那几块。`);
  }

  // 总宽 = 第 0 行各块的宽之和，总高 = 第 0 列各块的高之和。
  // ★ 取第 0 行 / 第 0 列就够，不需要遍历全图：`planExport` 的口径下**同一列的块等宽、
  //   同一行的块等高**（块宽只由 col 决定、块高只由 row 决定），所以第 0 行/列具备
  //   全体的宽度信息 —— 而这条「严格矩形」正是服务端要拿真实 PNG 再证一遍的事。
  const width = tiles.filter((t) => t.row === 0).reduce((a, t) => a + t.width, 0);
  const height = tiles.filter((t) => t.col === 0).reduce((a, t) => a + t.height, 0);

  const manifest: MergeManifest = {
    version: 1,
    paperLabel: input.paperLabel,
    dpi: input.dpi,
    format: input.format,
    cols,
    rows,
    // 标称值取第一块：各块因取整最多差 1 像素，写「差 1 的两块之间的某个数」毫无意义，
    // 不如给一个确定的代表值 —— 服务端反正以真实 PNG 为准。
    tileWidth: tiles[0].width,
    tileHeight: tiles[0].height,
    width,
    height,
    createdAt: (input.now ?? new Date()).toISOString(),
    tiles: tiles
      .slice()
      .sort((a, b) => a.index - b.index)   // 说明书里按序号排，人打开一眼能看懂
      .map(({ index, col, row, file }) => ({ index, col, row, file })),
  };

  // 可选元数据：给了才写进说明书，不给就省略（旧包没有这些字段也能合并）
  if (input.center) manifest.center = input.center;
  if (input.zoom != null) manifest.zoom = input.zoom;
  if (input.title) manifest.title = input.title;
  return manifest;
}

/**
 * 打合并包：`manifest.json` **排在第一个**，后面按序号跟各块。
 *
 * ★ manifest 放第一个不是随便定的：解压工具（含 Windows 资源管理器）打开列表时
 *   按包内顺序列出，说明书排在顶上，用户一眼能看到「这是个什么包、切了几块」，
 *   而不是先滚过大半屏 PNG 才发现。
 *
 * ★ `JSON.stringify(_, null, 2)` 带缩进：这份 JSON 只有几百字节，压不压缩毫无意义，
 *   而缩进过的版本用户双击就能读 —— 排查「服务端为什么拒绝我这个包」时全靠它。
 */
export async function buildExportZip(
  input: { manifest: MergeManifest; files: ZipEntry[]; now?: Date },
): Promise<Blob> {
  const json = JSON.stringify(input.manifest, null, 2);
  const head: ZipEntry = {
    name: MERGE_MANIFEST_NAME,
    blob: new Blob([json], { type: 'application/json;charset=utf-8' }),
  };
  return zipBlobs([head, ...input.files], input.now ?? new Date());
}
