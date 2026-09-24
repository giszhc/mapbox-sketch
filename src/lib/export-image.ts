/* =====================================================================
 * export-image.ts —— 出图的**纯函数**：像素规划 + dpi 元数据写入。
 *
 * 这里刻意不 import 任何 DOM / mapbox 东西，只做四件可以被穷举的事：
 *   1) `planExport`  —— dpi / dpr / 取景范围 → 隐藏地图该多大、输出多少像素
 *   2) `paperFrame`  —— A0–A6 纸张尺寸（mm）→ 取景范围该多大（CSS 像素）
 *   3) `paperGrid` / `planExportTiles` —— 大纸切成多张完整的纸（见「分块导出」那一段）
 *   4) `applyPngDpi` / `applyJpegDpi` —— 把 dpi 写进图片文件本身的元数据
 *
 * ★ 为什么非要单独一个文件：合成与编码那半截（`drawImage` + `toBlob`）在 vitest 里
 *   **测不了** —— jsdom 没有 canvas 后端，`test/setup.ts` 装的是记录型假上下文，
 *   连 `toBlob` / `toDataURL` 都不存在。所以「错了没人会发现」的那部分逻辑
 *   （字节偏移、大端序、CRC、幂等）必须落在这种对 DOM 零依赖的纯函数上，
 *   才轮得到用例去穷举它。
 *
 * 关于「为什么 dpi 要写进文件」：`canvas.toBlob()` 出来的 PNG / JPEG **不带任何
 * 分辨率信息**，Photoshop / Word / 打印驱动一律当 72 或 96 dpi，于是「导出 300dpi」
 * 就只剩下「像素多」这一个意思，拿到打印场景里排版还是错的。所以：
 *   · PNG  → 插一个 `pHYs` 块（每米像素数，单位 = 米）
 *   · JPEG → 改 / 插 `JFIF` APP0 的密度字段（units = 1，即每英寸）
 * ===================================================================== */

/** 输出像素的换算基准：1 CSS 像素 = 96 dpi（CSS 规范里 `1in = 96px` 的定义） */
export const BASE_DPI = 96;

/*
 * ★ 这里曾经有两条上限（`MAX_EXPORT_SIDE = 8192` / `MAX_EXPORT_PIXELS = 40e6`），
 *   超出就按比例把 dpi 降下来。**2026-09-15 用户要求去掉**：导出要多少就是多少，
 *   不许悄悄降 dpi —— A1 / A0 按 300dpi 打本来就是上亿像素，被降到 161dpi 还叫
 *   「A0 300dpi」才是真的坑（拿去付印才发现不是 300）。
 *
 *   代价是**要如实说明白**：尺寸真的太大时浏览器会自己失败 —— 隐藏地图拿不到
 *   WebGL 上下文（`创建隐藏地图失败：…`）、或者 `toBlob` 给不出结果
 *   （`浏览器未能把画布编码成图片…`），两种都是中文错误、看得见。
 *   换句话说：现在是「要么给足你要的，要么明确报错」，不再有第三条路。
 *   具体门槛由浏览器 / 显存决定（Chrome 画布单边上限约 16384），不是我们能定的。
 */

/* =====================================================================
 * 底图清晰度档：高清（去下更深一级瓦片） vs 跟随当前层级（拿现成的放大）
 * ===================================================================== */

/** 会因为「压层级」而改变行为的瓦片源类型（`geojson` / `image` / `video` 没有 z 这一说） */
const TILE_SOURCE_TYPES = new Set(['vector', 'raster', 'raster-dem']);

/**
 * 把样式里每个**分块瓦片源**的 `maxzoom` 压到 `capZoom`：地图于是只认到这一级的瓦片，
 * 再往上走就靠 mapbox 的 **overzoom**（拿已有瓦片放大后重绘）—— 这正是
 * 「不导出高清底图」想要的：**不再去下更深一级的瓦片**，代价是详略度停在这一级。
 *
 * 为什么是改 `maxzoom` 而不是别的：可用的开关只有这一个。隐藏地图的 zoom 必须抬高
 * `log2(scale)`（那是「地理范围不变、像素多 scale 倍」的全部机制，见 `_createExportMap`），
 * 而**瓦片取哪一级只由源的 `maxzoom` 与地图当前 zoom 决定** —— 想让抬高后的地图去用
 * 浅一级的瓦片，唯一合法的入口就是把源的天花板压下来。
 *
 * 三条边界：
 *   · **不改入参**：`map.getStyle()` 是 `extend({}, stylesheet)` 的**浅拷贝** ——
 *     `style.sources` 与地图内部那份是同一个对象。就地改它等于改活地图（下一帧底图就糊了），
 *     所以这里只在真的要改时**另造一层** `{...style, sources: {...}}`。
 *   · **压不动就不动**：目标层级比 `minzoom` 还低时（地图缩得比数据还小时会出现），
 *     照压会让 `maxzoom < minzoom`，源直接失效 —— 宁可保持原样。
 *   · **本来就更浅就不碰**：源自己的 `maxzoom` 已经 ≤ 目标层级时它本来就在 overzoom，
 *     改了反而是把它「抬」上去。
 *
 * @param style   样式对象（`map.getStyle()` 的返回值或其副本）
 * @param capZoom 允许的最高瓦片层级。传 `map.getZoom()` —— 「当前屏幕上的那一级」
 * @returns 改过的**新**样式；没有任何源需要改时**原样返回入参**（不白造对象）
 */
export function capStyleSourceZoom<T extends object>(style: T, capZoom: number): T {
  if (!Number.isFinite(capZoom)) return style;
  const cap = Math.floor(capZoom);
  const srcs = (style as { sources?: unknown }).sources;
  if (!srcs || typeof srcs !== 'object') return style;

  let next: Record<string, unknown> | null = null;
  for (const [id, raw] of Object.entries(srcs as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as Record<string, unknown>;
    if (typeof s.type !== 'string' || !TILE_SOURCE_TYPES.has(s.type)) continue;

    const min = typeof s.minzoom === 'number' && Number.isFinite(s.minzoom) ? s.minzoom : 0;
    if (cap < min) continue;
    // 不给 maxzoom 的源按 mapbox 的默认（22）算 —— 那正是「会一路下到很深」的那一档
    const cur = typeof s.maxzoom === 'number' && Number.isFinite(s.maxzoom) ? s.maxzoom : Infinity;
    if (cur <= cap) continue;

    next = next ?? { ...(srcs as Record<string, unknown>) };
    next[id] = { ...s, maxzoom: cap };
  }
  return next ? ({ ...style, sources: next } as T) : style;
}

/* =====================================================================
 * 纸张：A0–A6
 *
 * 尺寸是 ISO 216 的名义值（mm），**一律按纵向存**（宽 < 高）；横向由
 * `paperFrame()` 把宽高换过来 —— 存两份就得保证两份对得上，早晚会有一处写歪。
 * ===================================================================== */

/** A0–A6 的名义尺寸（mm，纵向基准：`[宽, 高]`） */
export const PAPER_SIZES = {
  A0: [841, 1189],
  A1: [594, 841],
  A2: [420, 594],
  A3: [297, 420],
  A4: [210, 297],
  A5: [148, 210],
  A6: [105, 148],
} as const;

/** 纸张规格键 */
export type PaperSize = keyof typeof PAPER_SIZES;

/** 纸张方向：纵向（`portrait`，宽 < 高）/ 横向（`landscape`，宽 > 高） */
export type PaperOrientation = 'portrait' | 'landscape';

/** 自定义纸张：直接给取景范围（CSS 像素），绕过毫米换算。 */
export interface CustomPaper {
  /** 取景框宽（CSS 像素，>0） */
  wpx: number;
  /** 取景框高（CSS 像素，>0） */
  hpx: number;
}

/** 一次导出的纸张选择 */
export interface PaperSpec {
  /** `PaperSize` 是 A0–A6；`'custom'` 走 `custom` 字段给的像素取景范围 */
  size: PaperSize | 'custom';
  /** 缺省 = 纵向（自定义纸张忽略，尺寸已直接给定） */
  orientation?: PaperOrientation;
  /**
   * `size === 'custom'` 时必填：取景范围（CSS 像素）。
   * 与 A0–A6 同一套口径 —— 纸上 1 CSS 像素 = 屏幕 96/25.4 个 CSS 像素的地理范围，
   * 所以**与 dpi 无关**；dpi 只决定这块范围被采样成多少像素。
   */
  custom?: CustomPaper;
}

/** 纸张折算出的**取景范围**：毫米数 + 对应的 CSS 像素数 */
export interface PaperFrame {
  /** 纸张物理宽（mm，已按方向换过） */
  wmm: number;
  /** 纸张物理高（mm，已按方向换过） */
  hmm: number;
  /** 取景范围宽（CSS px） */
  frameW: number;
  /** 取景范围高（CSS px） */
  frameH: number;
}

/** 一毫米等于多少 CSS 像素：`1in = 96px` 且 `1in = 25.4mm` */
export function mmToCssPx(mm: number): number {
  return (mm / 25.4) * BASE_DPI;
}

/**
 * 纸张 → **取景范围**（CSS 像素）。
 *
 * 这是纸张模式的全部换算：**纸上一毫米 = `96/25.4 ≈ 3.7795` 个屏幕 CSS 像素的地理
 * 范围**，因此取景范围只由纸张尺寸决定，**与 dpi 无关** —— dpi 只决定这块范围被采样
 * 成多少像素（`outW = frameW × dpi/96`，等价于 `mm/25.4 × dpi`）。
 *
 * 这条口径的后果是刻意的（用户 2026-09-15 定）：屏幕上 1 CSS 像素对应多少米，纸上
 * 就是多少米，两者逐像素一致；代价是**视口所见不一定全进图**（窗口 16:9 而 A4 是
 * 1:1.414，会切掉一截）。
 *
 * 不认识的 `size` 返回 `null`（当「没给纸张」处理，不抛错 —— 同 `planExport` 的口径）。
 */
export function paperFrame(paper: PaperSpec | null | undefined): PaperFrame | null {
  if (!paper || typeof paper !== 'object') return null;
  // ★ 自定义纸张：取景范围直接由像素定，不经毫米换算（与 A 系同一口径，只是少了一步 mm→px）。
  //   脏值（缺 `custom` / 非正 / 非有限）退回 null ⇒ 当「没给纸张」，与 A 系不认识的 size 同口径。
  if (paper.size === 'custom') {
    const c = paper.custom;
    if (!c || !Number.isFinite(c.wpx) || !Number.isFinite(c.hpx) || c.wpx <= 0 || c.hpx <= 0) {
      return null;
    }
    // `wmm/hmm` 只是给 `splitCounts` 判长宽用的，按 mm↔px 反算回去即可（这里不进导出算式）。
    return { wmm: c.wpx / mmToCssPx(1), hmm: c.hpx / mmToCssPx(1), frameW: c.wpx, frameH: c.hpx };
  }
  const size = PAPER_SIZES[paper.size as PaperSize];
  if (!Array.isArray(size)) return null;
  const portrait = paper.orientation !== 'landscape';   // 缺省与非法值都按纵向
  const wmm = portrait ? size[0] : size[1];
  const hmm = portrait ? size[1] : size[0];
  return { wmm, hmm, frameW: mmToCssPx(wmm), frameH: mmToCssPx(hmm) };
}

/**
 * 分块导出的「第几块、共几块」。
 *
 * ★ 四个数装在**一个对象**里（而不是 `split` + `col/row` 两组）是刻意的：
 *   `col >= cols` 这种自相矛盾的入参根本不该有表达方式，而不是靠调用方自觉。
 *
 * 行列方向与纸面一致：`col` 向右、`row` 向下，序号从左上角 (0,0) 开始。
 */
export interface ExportCell {
  /** 第几列（0 起，向右） */
  col: number;
  /** 第几行（0 起，向下） */
  row: number;
  /** 横向一共几块 */
  cols: number;
  /** 纵向一共几块 */
  rows: number;
}

/** `planExport` 的入参 */
export interface ExportPlanInput {
  /** 可见地图容器的 CSS 宽（`跟随视口` 模式下的取景范围；纸张模式下只用来算偏移） */
  cssW: number;
  /** 可见地图容器的 CSS 高 */
  cssH: number;
  /** `window.devicePixelRatio`（非法值按 1 算） */
  dpr: number;
  /** 目标打印分辨率 */
  dpi: number;
  /**
   * 纸张（给了就走纸张模式）。**取景范围**随之变成纸张折算出来的 CSS 像素，
   * 而不是视口尺寸 —— 见 `paperFrame()`。
   */
  paper?: PaperSpec | null;
  /**
   * 分块导出的第几块（不给 = 整张不切）。给了就把**取景范围**均分成
   * `cols × rows` 格，取这一格 —— 见 `planExportTiles()`（宿主一般不该自己拼这个对象）。
   */
  cell?: ExportCell | null;
}

/** `planExport` 的结果 */
export interface ExportPlan {
  /**
   * 隐藏地图容器 / 覆盖层的放大倍数 = `(dpi/96) / dpr`。
   *
   * ★ 除 `dpr` 这一下是关键：mapbox 画布的物理尺寸恒为「容器 CSS × devicePixelRatio」
   *   （见 mapbox-gl 的 `_resizeCanvas`，那个 dpr 取自 `window` 的**活 getter**、
   *   没有任何 per-map 字段能覆盖），所以想让画布正好落在目标像素数上，
   *   容器就得按 `target/dpr` 缩放。**允许小于 1**：另建一张隐藏地图的好处之一就是
   *   高 dpr 屏上导低 dpi 时不必「只许放大」。
   */
  scale: number;
  /**
   * **取景范围**：这一次导出要覆盖的地理范围，按「屏幕 CSS 像素」量。
   *
   * 跟随视口时**恒等于** `cssW / cssH`；纸张模式时是纸张折算出来的（见 `paperFrame`）。
   */
  frameW: number;
  /** 取景范围高（CSS px） */
  frameH: number;
  /**
   * 取景框左上角**相对容器左上角**的偏移（CSS px）。
   *
   * 跟随视口时恒为 `0 / 0`；纸张模式下是 `(cssW - frameW) / 2`、`(cssH - frameH) / 2`
   * —— **可为负、可为小数**（A0 横放在 1920 窗口里 dx ≈ −1287）。
   * 分块导出时（`cell`）再加一份块心偏移，于是只有 (0,0) 那块还可能在视口中心上。
   *
   * ★ 出图时的画布原点与 demo 那圈虚线纸框都读这两个数，别各自再抄一遍减法：
   *   「框画在哪」与「图取到哪」必须是同一个算式，否则纸上与屏幕上的范围会差半个框。
   */
  frameX: number;
  /** 取景框左上角相对容器左上角的偏移（CSS px） */
  frameY: number;
  /**
   * 取景框**中心**相对视口中心的偏移（CSS px，正 = 右/下）。不切块时恒为 `0 / 0`。
   *
   * ★ `sketch.ts` 靠它判断隐藏地图该走哪条取景路径：0 就抄可见地图的 center（老路径，
   *   逐字节不变）；非 0 就必须换成 `unproject(框心)` 并把 padding 归零。
   */
  offset: { x: number; y: number };
  /**
   * **归一后的**分块参数（入参根本没给 `cell` 时是 `null`）。
   *
   * ★ 调用方要判断「到底切没切、是第几块」一律读这里，**别自己再归一一遍**：
   *   `gridCount` / `gridIndex` 那套脏值折返（0 / NaN / 越界 → 1×1 / 边界格）是
   *   `planExport` 的私有口径，抄出去就是第二套算式 —— 哪天口径变了，这里与
   *   调用方的判断就会各走各的。
   */
  cell: ExportCell | null;
  /** 输出图片的像素宽（也是隐藏地图画布的像素宽） */
  outW: number;
  /** 输出图片的像素高 */
  outH: number;
  /**
   * 实际生效的 dpi。**不再夹取**，所以正常情况恒等于请求值（取整后）；
   * 请求值是脏数（0 / 负数 / NaN）时才会退回 `BASE_DPI`。
   */
  dpi: number;
  /** 中文告警；目前只有「不认识的纸张」这一种，正常时为空数组 */
  warnings: string[];
}

/** 分块份数归一：至少 1 的整数（0 / 负 / 小数 / NaN 都退回 1） */
function gridCount(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.max(1, Math.round(n));
}

/** 分块下标归一：夹进 `[0, count - 1]` 的整数（脏值退回 0） */
function gridIndex(v: unknown, count: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(count - 1, Math.round(n));
}

/**
 * 规划一次导出：视口 + dpi → 隐藏地图多大、输出多少像素。
 *
 * 纯函数、不抛错：入参怎么脏都只给出「最接近的合法值」，把判断留给调用方
 * （`exportImage()` 会在视口为 0 时自己抛错）。
 */
export function planExport(input: ExportPlanInput): ExportPlan {
  const warnings: string[] = [];
  // 脏入参一律先归一到「安全值」，免得后面算出 NaN / Infinity 传到画布尺寸上
  const cssW = Number.isFinite(input.cssW) && input.cssW > 0 ? input.cssW : 0;
  const cssH = Number.isFinite(input.cssH) && input.cssH > 0 ? input.cssH : 0;
  const dpr = Number.isFinite(input.dpr) && input.dpr > 0 ? input.dpr : 1;
  const asked = Number.isFinite(input.dpi) && input.dpi > 0 ? input.dpi : BASE_DPI;

  // 纸张模式只换**取景范围**这一项：像素换算、缩放补偿全都不区分模式。
  // `paperFrame` 对不认识的纸张返回 null ⇒ 当「没给纸张」，退回跟随视口。
  const pf = paperFrame(input.paper);
  // 分块（`cell`）是在取景范围之上再切一刀：整块宽高各除以 cols/rows。
  // 脏入参一律归一：份数至少 1（除法里出现 0 会把整张图变成 NaN/Infinity 尺寸），
  // 下标夹进 `[0, 份数-1]`（越界的那一格与其去猜、不如给边界那一格）。
  const cols = gridCount(input.cell?.cols);
  const rows = gridCount(input.cell?.rows);
  const col = gridIndex(input.cell?.col, cols);
  const row = gridIndex(input.cell?.row, rows);
  const w = (pf ? pf.frameW : cssW) / cols;
  const h = (pf ? pf.frameH : cssH) / rows;
  // 块心相对视口中心的偏移：整块被均分后，第 col 块的中心落在
  // `(col + 0.5) / cols` 处，减去半宽就是它离中心的距离。1×1 时正好是 0。
  const offset = {
    x: (col + 0.5 - cols / 2) * w,
    y: (row + 0.5 - rows / 2) * h,
  };
  // 「给了纸张但不认识」要出声：写成 `{ size: 'a4' }`（小写）这种笔误的后果是
  // **静默**导出一张视口图 —— 用户看到的是一张正常的图，只是不是他要的那张纸。
  // （完全没给 `paper` 是正常的「跟随视口」，那种不出声。）
  if (!pf && input.paper != null && typeof input.paper === 'object') {
    const size = String((input.paper as PaperSpec).size || '（空）');
    warnings.push(`未知的纸张「${size}」（可用 A0–A6），已按跟随视口导出。`);
  }

  // 要多少给多少：**不夹取、不降 dpi**（见文件头那段）。这里只做「至少 1 像素」的下限，
  // 免得 0 / 负数的视口算出 0 或 NaN 传到画布尺寸上。
  const target = asked / BASE_DPI;

  return {
    scale: target / dpr,
    // 跟随视口时 `w/h` 就是 `cssW/cssH` 本身（一个字节都不差）—— 这条是回归的锚点
    frameW: w,
    frameH: h,
    frameX: (cssW - w) / 2 + offset.x,
    frameY: (cssH - h) / 2 + offset.y,
    offset,
    // 归一后的分块参数：入参压根没给 cell 时是 null（哪怕归一出来是 1×1），
    // 「没分块」与「分了 1×1 块」在这套代码里是同一条路径，但语义上要分得清
    cell: input.cell ? { col, row, cols, rows } : null,
    // 至少 1 像素：0 或负数的视口也得给出一张能被编码的图
    outW: Math.max(1, Math.round(w * target)),
    outH: Math.max(1, Math.round(h * target)),
    dpi: Math.round(target * BASE_DPI),
    warnings,
  };
}

/* =====================================================================
 * 图廓整饰：在地图区外面留一圈边
 *
 * 场景（专题图 / 打印图）：纸上除了地图，还要有图框、一圈白边、指北针、图例、图名。
 * 这些**不在取景范围里** —— 它们画在地图外面，所以出图时画布要比地图区大一圈。
 *
 * 为什么这件事值得进库里（而不是让宿主拿到成品图再自己合成一张）：
 * `canvas.toBlob()` 出来的 PNG / JPEG 不带分辨率信息，dpi 是引擎在编码前写进文件本体的
 * （见本文件头部）。宿主自己合成就等于放弃了那一步，拿去打印排版还是错的 ——
 * 所以引擎给一个「地图贴完、编码之前」的口子（`ExportImageOptions.decorate`），
 * 把算好的整页几何交给宿主画装饰。
 *
 * 单位口径（唯一一处容易搞混的地方）：`margin` 是 **CSS 像素**，与纸张那套
 * 「纸上一毫米 = 96/25.4 个 CSS 像素」同一个量纲；乘 `dpi/96` 之后才是输出像素。
 * 于是「外框 3px」在 96 与 300dpi 下出图都一样宽（都乘以各自的倍率），
 * 与屏幕上看到的那张预览逐像素一致。
 * ===================================================================== */

/** 图廓四边外边距（**CSS 像素**，见上面那段口径说明） */
export interface ExportMargin {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** 单边归一：非有限值 / 负数一律当 0（「没给这一边」） */
function marginEdge(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * `exportImage({ margin })` 的入参 → 四边齐全的 `ExportMargin`。
 *
 * 三种形态都认：`number`（四边同宽）、`Partial<ExportMargin>`（缺的边按 0）、
 * `null` / `undefined`（全 0 = 没有外边距）。脏值（NaN / 负数 / 字符串）当 0 ——
 * 同 `planExport` 的口径：入参怎么脏都只给出「最接近的合法值」，不抛错。
 */
export function normalizeMargin(
  m: number | Partial<ExportMargin> | null | undefined,
): ExportMargin {
  if (typeof m === 'number' || typeof m === 'string') {
    const v = marginEdge(m);
    return { top: v, right: v, bottom: v, left: v };
  }
  if (!m || typeof m !== 'object') return { top: 0, right: 0, bottom: 0, left: 0 };
  return {
    top: marginEdge(m.top),
    right: marginEdge(m.right),
    bottom: marginEdge(m.bottom),
    left: marginEdge(m.left),
  };
}

/** `planDecorate()` 的结果：整页画布尺寸 + 地图区在其中的位置（**输出像素、整数**） */
export interface DecorateLayout {
  /** 整页输出像素宽 = `outW + left + right` */
  width: number;
  /** 整页输出像素高 = `outH + top + bottom` */
  height: number;
  /** 地图区左上角在整页画布上的 x（恒等于 `margin.left`） */
  mapX: number;
  /** 地图区左上角在整页画布上的 y（恒等于 `margin.top`） */
  mapY: number;
  /** 四边外边距（输出像素、整数） */
  margin: ExportMargin;
}

/**
 * 算整饰后的画布：地图区（`outW × outH`）+ 四边外边距。
 *
 * **逐边先乘 `scale`，再按「累计边界」取整**（不是四边各自 round，也不是四边加起来乘一下）：
 * 地图像素是整数、边距是整数，于是地图区在整页画布上的位置是确定的整数，`decorate` 里画的
 * 东西与地图**逐像素对齐**，不会有半像素的缝；同时整页尺寸与纸张毫米数严格对齐。
 *
 * @param outW  地图区像素宽（`ExportPlan.outW`）
 * @param outH  地图区像素高（`ExportPlan.outH`）
 * @param margin 四边外边距（**CSS 像素**，先过 `normalizeMargin`）
 * @param scale 输出像素 ÷ CSS 像素（`dpi / 96`；脏值按 1 算）
 */
export function planDecorate(
  outW: number,
  outH: number,
  margin: ExportMargin,
  scale: number,
): DecorateLayout {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const t0 = marginEdge(margin?.top) * s;
  const r0 = marginEdge(margin?.right) * s;
  const b0 = marginEdge(margin?.bottom) * s;
  const l0 = marginEdge(margin?.left) * s;
  /*
   * ★ 取整口径：**按「累计边界」取整**，不是四边各自 round。
   *
   * 四边各自 round 的后果是整页尺寸会漂：`margin.left = margin.right = 13`、`scale = 3.125`
   * 时每边 `round(40.625) = 41`，整页 = 地图区 + 82，而 `round(26 × 3.125) = 81` ——
   * 一张 297mm 的纸出成 3509px 而不是 3508px（0.09mm 的差，但制图交付里「纸宽
   * 297mm 就该是 3508px @300dpi」是个会被人拿尺子量的事）。
   *
   * 累计法：左边距照旧 `round(left × s)`，右边距取 `round((left + right) × s) − 左边距`。
   * 于是**四边之和严格等于** `round((left + right) × s)`（纵向同理），整页尺寸与
   * 「纸张毫米数 × dpi」严格对齐；代价是左右可能差 1px（A4@300 是 41 / 40）——
   * 半个像素的偏心，比「纸大了 1px」划算得多。
   * `margin` 已归一到非负（见 `normalizeMargin`），所以拿差值出来的那一侧不会为负。
   */
  const px: ExportMargin = {
    top: Math.round(t0),
    left: Math.round(l0),
    right: Math.round(l0 + r0) - Math.round(l0),
    bottom: Math.round(t0 + b0) - Math.round(t0),
  };
  // 至少 1 像素：地图区正常不会为 0（`planExport` 已经保证了），这里只防脏入参
  const w = Math.max(1, Math.round(Number.isFinite(outW) ? outW : 0));
  const h = Math.max(1, Math.round(Number.isFinite(outH) ? outH : 0));
  return {
    width: w + px.left + px.right,
    height: h + px.top + px.bottom,
    mapX: px.left,
    mapY: px.top,
    margin: px,
  };
}

/* =====================================================================
 * 取景范围必须装得下「整个世界」
 *
 * mapbox 的 `Transform#_constrain()` 有三条**与容器尺寸有关**的硬约束（实测 3.22，
 * 压缩产物里那一段），界都是「整个世界在当前 zoom 下有多少 CSS 像素」
 * （`Transform#scale` = `512 × 2^zoom`，世界恒为正方形）：
 *
 *   if (r - c < h) a = h + c;            // 视口上边越出世界 → 把中心往下压
 *   if (r + c > d) a = d - c;            // 视口下边越出世界 → 把中心往上压
 *   if (d - h < this.height) {           // **整个世界比视口还矮**：
 *     n = this.height / (d - h);         //   把 zoom 强行抬高 n 倍
 *     a = (d + h) / 2;                   //   并把中心钉在世界正中
 *   }
 *
 * 前两条只是**平移**（相机整体挪了，画面内容跟着偏），算出差值再平移回来即可 ——
 * 见 `sketch.ts` 里 `_createExportMap` 的 `shift`。
 * 第三条**换了缩放**：平移救不回来，底图与覆盖层再也对不上，所以「取景范围比世界还高」
 * 这件事必须拦下来（见 `sketch.ts` 的守卫），不能让它把一张错图导出去。
 *
 * ★ 只按**高**判：横向超了只是多画几遍世界（mapbox 的 `renderWorldCopies` 本来就这么
 *   干），相机不动、画面不错位；纵向超了才是必错。
 * ===================================================================== */

/** mapbox 一「瓦片」的边长（CSS 像素）。世界 = `TILE_PX × 2^zoom` */
export const TILE_PX = 512;

/** 当前 zoom 下整个世界占多少 CSS 像素（与 mapbox 内部 `Transform#scale` 同值；世界是方的） */
export function worldPxAt(zoom: number): number {
  const z = Number.isFinite(zoom) ? zoom : 0;
  return TILE_PX * 2 ** z;
}

/**
 * 「取景范围高装得下世界」所需的最低 zoom。
 *
 * 反向用：`minZoomToFit(frameH)` 就是报错文案里那句「请放大到 zoom ≥ …」。
 */
export function minZoomToFit(frameH: number): number {
  const h = Number.isFinite(frameH) && frameH > 0 ? frameH : 1;
  return Math.log2(h / TILE_PX);
}

/** 这个 zoom 下取景范围装得下世界吗（`false` ⇒ 导出必错，调用方要拦） */
export function frameFitsWorld(frameH: number, zoom: number): boolean {
  // 等式处**合法**：mapbox 那条用的是 `< this.height`（严格小于），世界与视口等高时不动手
  return frameH <= worldPxAt(zoom) + 1e-9;
}

/* =====================================================================
 * 分块导出：大纸切成多张完整的纸
 *
 * 为什么值得单独一层：A0 横 @600dpi 是 5.6 亿像素，撞浏览器画布上限（面积约 2.68 亿、
 * 单边约 16384）**必失败**；@300dpi 的 1.4 亿虽然合法，三张全尺寸画布叠起来也上 GB。
 * 切成 2×2 之后每块 7022×4967 ≈ 3490 万像素，落在「稳定可出」的量级 —— 而且每块
 * **本身就是一张完整的纸**，拿去打印不用拼、也没有拼图接缝（矢量底图的注记在每张
 * 纸上各自正常摆放）。
 *
 * ★ A 系纸的级数差唯一决定网格，这是它按定义就该有的性质（每降一级面积减半、
 *   长宽比恒为 √2）：A0 横 + A2 = 2×2、A0 横 + A4 = 4×4、A0 横 + A1 = 2×1。
 *   所以「切几块」不是让用户算的，选一次块纸型就够了。
 * ===================================================================== */

/** 纸张级序（`paperGrid` 数级数差用） */
const PAPER_ORDER: PaperSize[] = ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6'];

/** `paperGrid()` 的结果：一份「这张大纸要切成几行几列」的说明书 */
export interface PaperGrid {
  /** 横向几块 */
  cols: number;
  /** 纵向几块 */
  rows: number;
  /** 每块的物理宽（mm，已按方向算好） */
  wmm: number;
  /** 每块的物理高（mm） */
  hmm: number;
  /**
   * 每块纸的**方向**。★ 不给用户选，由大纸方向与级数差唯一决定：
   * A0 横 + A1 只可能是「A1 纵向」（594.5×841mm），没有别的分法。
   */
  orientation: PaperOrientation;
}

/**
 * 大纸 + 块纸型 → 切成几行几列、每块多大（mm）。
 *
 * 级数差 `k = 块级别 − 目标级别`：长边分 `2^ceil(k/2)`、短边分 `2^floor(k/2)` 份
 * （大纸是纵向时两者对调）。每块因此恰好是那块纸的**名义尺寸**，只差 A 系取整的
 * 0.5mm（A0 横的 1/4 是 594.5×420.5mm，而 A2 的名义值是 594×420）。
 *
 * `null` = 「这块纸不比目标纸小」或纸张不认识（当「不切」处理，与 `paperFrame` 同口径）。
 */
/**
 * 级数差 `k` → 分几行几列。
 *
 * ★ 长边多分一次还是短边多分一次：让每块的长宽比贴近 1:√2 且方向与那块纸一致。
 *   奇偶决定了「长边先分」（`k` 为奇数时），这也正是 A0 横 + A1 = 2×1 而不是 1×2 的原因。
 *
 * ★ 这是**唯一**一处行列算式：`paperGrid()` 与自动分块（`autoPaperGrid` / `autoViewportGrid`）
 *   都走它。抄出第二份的话，哪天口径变了就会只有一条路被改到 —— 而那两条路的产物
 *   （块纸型的网格 vs 自动算出来的网格）恰恰是最不容易被并排比较的。
 */
function splitCounts(k: number, wide: boolean): { cols: number; rows: number } {
  const a = Math.ceil(k / 2);
  const b = Math.floor(k / 2);
  return wide ? { cols: 2 ** a, rows: 2 ** b } : { cols: 2 ** b, rows: 2 ** a };
}

export function paperGrid(paper: PaperSpec | null | undefined, block: PaperSize): PaperGrid | null {
  if (!paper || typeof paper !== 'object') return null;
  const pf = paperFrame(paper);
  if (!pf) return null;                     // 纸张不认识（`paperFrame` 的口径）
  const k = PAPER_ORDER.indexOf(block) - PAPER_ORDER.indexOf(paper.size as PaperSize);
  if (k < 1) return null;      // 块不比大纸小（或纸型不认识）⇒ 不切
  const { cols, rows } = splitCounts(k, pf.wmm >= pf.hmm);
  const wmm = pf.wmm / cols;
  const hmm = pf.hmm / rows;
  return { cols, rows, wmm, hmm, orientation: wmm > hmm ? 'landscape' : 'portrait' };
}

/** `planExportTiles()` 的入参：就是 `planExport` 的入参 + 一份网格 */
export interface ExportGridInput extends ExportPlanInput {
  /** 横向几块（`paperGrid()` 给的 cols） */
  cols: number;
  /** 纵向几块 */
  rows: number;
}

/** 分块导出里的一块 */
export interface ExportGridTile {
  /** 总序号（0 起，**从左到右、从上到下** —— 文件命名与拼版顺序都按它） */
  index: number;
  /** 第几列（0 起，向右） */
  col: number;
  /** 第几行（0 起，向下） */
  row: number;
  /**
   * 这一块的位置描述，**直接就是这个文件里 `planExport` 收的那份 `cell`** ——
   * 宿主导出时原样透传即可，不必自己拿 `col/row/总数` 再拼一个（拼错方向、
   * 把行列写反，恰好是肉眼最难发现的一类错）。
   */
  cell: ExportCell;
  /** 这一块的像素规划 */
  plan: ExportPlan;
}

/** `planExportTiles()` 的结果 */
export interface ExportGrid {
  cols: number;
  rows: number;
  /** 一共几块 = `cols × rows` */
  count: number;
  /** 逐块（顺序即 `index`） */
  tiles: ExportGridTile[];
}

/**
 * 把一次导出拆成 `cols × rows` 块，逐块给出规划。
 *
 * ★ 每一块都是拿 `planExport()` 算的（只多喂一个 `cell`），**不另抄一套像素算式**：
 *   抄一份的话，哪天取整、纸张口径或 dpi 换算变了，分块导出的结果就会和整张导出对不上
 *   —— 而这种不一致只在「切了块」时出现，正是最不容易被发现的那类。
 *
 * 相邻两块**严格相接、不重不漏**：N 块拼起来的取景范围恰好是整张不切时的取景范围。
 * 这是「完整」二字的全部保证，用例钉着。
 */
export function planExportTiles(input: ExportGridInput): ExportGrid {
  const cols = gridCount(input.cols);
  const rows = gridCount(input.rows);
  const tiles: ExportGridTile[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cell: ExportCell = { col, row, cols, rows };
      tiles.push({
        index: row * cols + col,
        col,
        row,
        cell,
        plan: planExport({ ...input, cell }),
      });
    }
  }
  return { cols, rows, count: cols * rows, tiles };
}

/* =====================================================================
 * 自动分块：不让用户选「切几块」，由「每块不超过一个像素预算」反推
 *
 * 上一版把「切几块」做成了一个下拉框，那是个设计错误：浏览器画布上限是个**技术约束**，
 * 用户既没有依据去判断「A0 横 @600dpi 该切到 A4 还是 A3」，也不该关心 —— 选粗了当场
 * 失败，选细了白等几倍时间。这里把它反了过来：**只给个预算，切几块是算出来的**。
 * ===================================================================== */

/**
 * 每块的**像素预算**（3500 万）。
 *
 * ★ 这个数不是拍的：它是 A0 横 @300dpi 切 2×2 之后每块的像素数（7022×4967 ≈ 3490 万），
 *   而那个组合是实测「稳定能出」的上限档 —— 再往上（不切的 1.4 亿）就开始看显存脸色了。
 *   所以自动分块的目标就是「每块不超过它」。
 */
export const TILE_PIXEL_BUDGET = 3.5e7;

/** 自动分块最多切 2^16 块：再多的唯一可能是入参算出了天文数字，别让循环失控 */
const MAX_AUTO_K = 16;

/** 预算归一：脏值退回默认（0 会让「每块都超预算」而一路切到底） */
function saneBudget(budget: number): number {
  return Number.isFinite(budget) && budget > 0 ? budget : TILE_PIXEL_BUDGET;
}

/**
 * 整张多少像素 → 至少要切几级（每升一级，每块面积减半）。
 *
 * ★ 用**整数循环**，不用 `Math.ceil(Math.log2(px / budget))`：后者在 `px / budget`
 *   正好是 2 的幂时有浮点陷阱 —— `Math.log2` 算出 `1.0000000000000002`，再一 `ceil`
 *   就是 2，**块数直接翻四倍**。而多切一级看起来完全「合法」（网格是对的、每块也更小），
 *   只是白等四倍时间，事后没人会去查这个数。
 */
function splitLevels(px: number, budget: number): number {
  let k = 0;
  let per = px;                    // 每块像素：每升一级减半
  while (per > budget && k < MAX_AUTO_K) {
    per /= 2;
    k++;
  }
  return k;
}

/** 像素数说成「多少万」：中文里比一长串数字好读，也够用了（这里都是百万级起） */
function wan(px: number): number {
  return Math.round(px / 1e4);
}

/** 自动分块的结果：切几级、切成几行几列、每块多大 */
export interface AutoGrid {
  /** 级数差（0 = 不切）；`paperGrid()` 收的就是它 */
  k: number;
  /** 横向几块 */
  cols: number;
  /** 纵向几块 */
  rows: number;
  /** 一共几块 = `cols × rows` */
  count: number;
  /**
   * 块纸型 —— 给文案用（「已切成 16 张 A4」）。
   * 只有**跟随视口**时是 `null`（那里的块不是一张标准纸，只是视口的一块）；
   * 纸张模式下 `k === 0` 给的是**这张纸自己** —— 「一块 = 整张纸」，不是空话。
   */
  block: PaperSize | null;
  /** 整张不切时的像素（给文案算「切了省多少」） */
  wholeW: number;
  wholeH: number;
  /** 每块的像素（各块因取整可能差 1 像素，这里给的是第一块） */
  tileW: number;
  tileH: number;
  /** 中文告警；目前只有「已切到 A6 封顶，每块仍超预算」这一种 */
  warnings: string[];
}

/**
 * 大纸 + dpi → 自动切成几块。
 *
 * `null` 只在「**判断不了**」时返回：没有纸张 / 纸张不认识 / dpi 是脏数。
 * 而「**不用切**」是 `count === 1`（`k === 0`）—— 刻意分成两回事：
 * 前者是「这函数帮不上忙」，后者是一个**结论**，而且它可能带着告警
 * （整张就超预算、偏偏又切不动了，见下面的 A6 那段）。把两者都塞进 `null`，
 * 那条告警就没地方放了。
 *
 * 宿主一般这么用：`g && g.count > 1` 就是要不要走分块那条路。
 *
 * 算法一句话：**取最少的分块数，使每块不超过预算**。A 系纸每降一级面积减半，所以切成
 * `2^k` 块后每块恰好 ≈ `整张 / 2^k ≤ 预算`；拿到 `k` 之后**复用 `splitCounts()`** 出行列，
 * 于是「自动算出来的网格」与「按块纸型选出来的网格」是同一个算式。
 */
export function autoPaperGrid(
  paper: PaperSpec | null | undefined,
  dpi: number,
  budget: number = TILE_PIXEL_BUDGET,
): AutoGrid | null {
  const pf = paperFrame(paper);
  if (!pf) return null;                       // 没有纸张 / 不认识（`paperFrame` 的口径）
  if (!Number.isFinite(dpi) || dpi <= 0) return null;
  const b = saneBudget(budget);

  // ★ 整张与每块的像素都**走 `planExport()` 现算**，不在这里另抄一遍 dpi 换算：
  //   抄一份的话，哪天取整口径变了，自动判断出来的块数就会与真正导出的像素对不上
  //   （比如以为每块 3490 万、实际 3900 万）。cssW/cssH 传 0 是刻意的 —— 纸张模式下
  //   `outW/outH` 只由纸张与 dpi 决定，与视口无关，这里没有视口可传。
  const whole = planExport({ cssW: 0, cssH: 0, dpr: 1, dpi, paper });
  const need = splitLevels(whole.outW * whole.outH, b);

  // ★ 自定义纸张没有 A 系级别：不能按「切到哪张纸」封顶，也没有「块纸型」标签。
  //   直接按预算切成任意几块（与跟随视口同口径），`block` 留 null（面板里那行
  //   「切成 N 张」本就兼容 `blockLabel` 为空的情况）。
  if (paper?.size === 'custom') {
    const { cols, rows } = splitCounts(need, pf.wmm >= pf.hmm);
    const tile = planExport({ cssW: 0, cssH: 0, dpr: 1, dpi, paper, cell: { col: 0, row: 0, cols, rows } });
    return {
      k: need, cols, rows, count: cols * rows,
      block: null,
      wholeW: whole.outW, wholeH: whole.outH,
      tileW: tile.outW, tileH: tile.outH,
      warnings: [],
    };
  }

  const idx = PAPER_ORDER.indexOf(paper!.size as PaperSize);
  if (idx < 0) return null;
  // 最多切到 A6：再往下就没有纸型能描述那块了。封顶后每块**仍可能超预算**，所以要出声。
  // （`need` 为 0 时这一夹也成立：`k` 就是 0 = 不切。）
  const k = Math.min(need, PAPER_ORDER.length - 1 - idx);
  const { cols, rows } = splitCounts(k, pf.wmm >= pf.hmm);
  const tile = planExport({ cssW: 0, cssH: 0, dpr: 1, dpi, paper, cell: { col: 0, row: 0, cols, rows } });

  const warnings: string[] = [];
  if (k < need) {
    // `idx + need` 可能越界（A6 起步时连一级都切不动），所以「本应切到哪张纸」要判一下再写，
    // 否则文案里会冒出 `undefined`。
    const target = PAPER_ORDER[idx + need];
    warnings.push(
      `整张 ${wan(whole.outW * whole.outH)} 万像素，要每块不超过 ${wan(b)} 万，`
      + (target ? `本来得切到 ${target}` : `本来还得再切 ${need} 级`)
      + `；但块纸型到 A6 为止，这里已是最细的 ${cols}×${rows}，`
      + `每块仍有 ${wan(tile.outW * tile.outH)} 万像素 —— 浏览器可能出不来。把 dpi 降一档。`,
    );
  }

  return {
    k, cols, rows, count: cols * rows,
    // k=0 时块纸型就是这张纸自己 —— 「一块 = 整张纸」，不是空话
    block: PAPER_ORDER[idx + k],
    wholeW: whole.outW, wholeH: whole.outH,
    tileW: tile.outW, tileH: tile.outH,
    warnings,
  };
}

/**
 * 跟随视口模式 + dpi → 自动切成几块。
 *
 * ★ 为什么视口模式也要切：4K 视口 @600dpi 是 12000×6750 = **8100 万像素**，超预算，
 *   而「跟随视口」是**默认模式** —— 不管它等于「默认设置下大屏高 dpi 只能失败」。
 *
 * 与纸张模式同一个算式、同一份预算，只有两点不同：块**不是**一张标准纸，所以 `block` 为
 * `null`、也没有 A6 那个封顶（视口的块数只要能压住预算就该给）。
 *
 * `null` / `count === 1` 的分工与 `autoPaperGrid()` 完全一致（见上面那段）：
 * 前者是「判断不了」，后者是「不用切」。
 */
export function autoViewportGrid(
  cssW: number,
  cssH: number,
  dpi: number,
  budget: number = TILE_PIXEL_BUDGET,
): AutoGrid | null {
  if (!Number.isFinite(dpi) || dpi <= 0) return null;
  const whole = planExport({ cssW, cssH, dpr: 1, dpi });
  // 视口为 0（没量到尺寸）时 `planExport` 会给 1×1，那种「图」连切都没得切 —— 判不了
  if (whole.outW <= 1 || whole.outH <= 1) return null;

  const k = splitLevels(whole.outW * whole.outH, saneBudget(budget));
  const { cols, rows } = splitCounts(k, whole.outW >= whole.outH);
  const tile = planExport({ cssW, cssH, dpr: 1, dpi, cell: { col: 0, row: 0, cols, rows } });
  return {
    k, cols, rows, count: cols * rows,
    block: null,
    wholeW: whole.outW, wholeH: whole.outH,
    tileW: tile.outW, tileH: tile.outH,
    warnings: [],
  };
}

/* =====================================================================
 * 字节工具
 * ===================================================================== */

/** 大端读 16 位 */
function readU16(b: Uint8Array, i: number): number {
  return (b[i] << 8) | b[i + 1];
}

/** 大端读 32 位（返回无符号） */
function readU32(b: Uint8Array, i: number): number {
  return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
}

/** 大端写 32 位 */
function writeU32(b: Uint8Array, i: number, v: number): void {
  b[i] = (v >>> 24) & 0xff;
  b[i + 1] = (v >>> 16) & 0xff;
  b[i + 2] = (v >>> 8) & 0xff;
  b[i + 3] = v & 0xff;
}

/**
 * PNG 每个 chunk 用的 CRC32（就是 ZIP 的那条多项式 `0xEDB88320`，反射式实现）。
 *
 * ★ 用它当测试锚点：标准向量 `crc32('123456789') === 0xCBF43926`，
 *   这条一过就说明整张查询表/位运算没写错，PNG 的块才敢往文件里插。
 */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

/* =====================================================================
 * PNG：pHYs
 * ===================================================================== */

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** IHDR 的数据长度固定 13；不是这个数就不是我们认识的 PNG */
const IHDR_DATA_LEN = 13;
/** pHYs 的数据长度固定 9：ppuX(4) + ppuY(4) + unit(1) */
const PHYS_DATA_LEN = 9;
/** 「IHDR 之后」的字节偏移：8(签名) + 4(长度) + 4(类型) + 13(数据) + 4(CRC) */
const AFTER_IHDR = 8 + 12 + IHDR_DATA_LEN;

/**
 * 往 PNG 里写 `pHYs`（物理像素尺寸）：每米多少像素，单位 = 米。
 *
 * 幂等 —— 已经有 `pHYs` 就**就地改**，不会插出第二个（连导两次的图里出现两个 pHYs
 * 是典型的「图能打开、就是没人发现」类 bug）。插入新块也不影响任何既有块的 CRC，
 * PNG 又没有总长字段，所以只算新块自己的 CRC 就够。
 *
 * @param bytes 一张 PNG 的字节
 * @param dpi   目标分辨率
 * @returns 新的字节；**入参不认识 / 结构不对时原样返回入参数组本身**（同一个引用）
 */
export function applyPngDpi(bytes: Uint8Array, dpi: number): Uint8Array {
  const ppu = Math.max(1, Math.round(dpi / 0.0254));    // 1 英寸 = 0.0254 米

  // 签名 + IHDR 的长度与类型都得对上；对不上说明这不是我们认识的 PNG，一个字节都别动
  if (bytes.length < AFTER_IHDR) return bytes;
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIG[i]) return bytes;
  if (readU32(bytes, 8) !== IHDR_DATA_LEN) return bytes;
  if (String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== 'IHDR') return bytes;

  // 先找现成的 pHYs
  let off = AFTER_IHDR;
  while (off + 12 <= bytes.length) {
    const len = readU32(bytes, off);
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    // 长度越界 = 文件本身已经不完整了，不再猜下去（猜就是往别人的文件里写垃圾）
    if (len > bytes.length - off - 12) return bytes;
    if (type === 'pHYs') {
      if (len !== PHYS_DATA_LEN) return bytes;
      const out = bytes.slice();
      writeU32(out, off + 8, ppu);
      writeU32(out, off + 12, ppu);
      out[off + 16] = 1;                                  // 1 = 单位是米
      writeU32(out, off + 17, crc32(out.subarray(off + 4, off + 17)));   // CRC 盖「类型 + 数据」
      return out;
    }
    off += 12 + len;
  }

  // 没有就插在 IHDR 之后（PNG 规范要求 pHYs 在 IHDR 之后、IDAT 之前）
  const chunk = new Uint8Array(12 + PHYS_DATA_LEN);
  writeU32(chunk, 0, PHYS_DATA_LEN);
  chunk[4] = 0x70; chunk[5] = 0x48; chunk[6] = 0x59; chunk[7] = 0x73;   // 'pHYs'
  writeU32(chunk, 8, ppu);
  writeU32(chunk, 12, ppu);
  chunk[16] = 1;
  writeU32(chunk, 17, crc32(chunk.subarray(4, 17)));

  const out = new Uint8Array(bytes.length + chunk.length);
  out.set(bytes.subarray(0, AFTER_IHDR), 0);
  out.set(chunk, AFTER_IHDR);
  out.set(bytes.subarray(AFTER_IHDR), AFTER_IHDR + chunk.length);
  return out;
}

/* =====================================================================
 * JPEG：JFIF 密度
 * ===================================================================== */

/** JFIF APP0 的负载长度：'JFIF\0'(5) + 版本(2) + 单位(1) + 密度(4) + 缩略图(2) */
const JFIF_PAYLOAD_LEN = 14;

/**
 * 往 JPEG 里写 JFIF 的密度字段（units = 1 即「每英寸」，Xdensity / Ydensity = dpi）。
 *
 * 浏览器 `toBlob('image/jpeg')` 出来的图**通常**带一段 JFIF APP0，但 units 是 0
 * （只给宽高比），也有些走 ICC / EXIF 而**不带** JFIF —— 两种情况都得管：
 * 有就就地改（总长度不变），没有就在 SOI 之后插一段标准的。
 * 幂等，且遇到不认识的结构**原样返回**。
 *
 * @returns 新的字节；结构不对时原样返回入参数组本身
 */
export function applyJpegDpi(bytes: Uint8Array, dpi: number): Uint8Array {
  // JFIF 的密度是两个字节，超出会回卷成 0（那比不写还糟）
  const dens = Math.min(65535, Math.max(1, Math.round(dpi)));

  if (bytes.length < 2) return bytes;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;      // 必须以 SOI 开头

  let off = 2;
  // 扫到 SOS（真正的压缩数据）为止 —— 压缩数据里到处是 0xFF，再往下扫就是解析垃圾
  let reachedEnd = false;
  while (off + 2 <= bytes.length) {
    if (bytes[off] !== 0xff) return bytes;
    const marker = bytes[off + 1];
    if (marker === 0xda || marker === 0xd9) { reachedEnd = true; break; }   // SOS / EOI
    // 无长度字段的独立标记：RSTn、TEM、SOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { off += 2; continue; }
    if (off + 4 > bytes.length) return bytes;
    const segLen = readU16(bytes, off + 2);
    if (segLen < 2 || off + 2 + segLen > bytes.length) return bytes;

    if (marker === 0xe0) {
      const p = off + 4;                                            // 负载起点
      const isJfif = p + 5 <= bytes.length
        && String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3], bytes[p + 4]) === 'JFIF\0';
      if (isJfif) {
        if (segLen < 2 + JFIF_PAYLOAD_LEN) return bytes;             // 太短，不是标准 JFIF
        const out = bytes.slice();
        out[p + 7] = 1;                                             // units = 1（每英寸）
        out[p + 8] = (dens >> 8) & 0xff;
        out[p + 9] = dens & 0xff;
        out[p + 10] = (dens >> 8) & 0xff;
        out[p + 11] = dens & 0xff;
        return out;
      }
    }
    off += 2 + segLen;
  }

  // 没扫到 SOS / EOI 说明这文件本身就是断的 —— 别往断文件里插东西
  if (!reachedEnd) return bytes;

  // 没有 JFIF：在 SOI 之后插一段标准的 APP0
  const seg = new Uint8Array(18);
  seg[0] = 0xff; seg[1] = 0xe0;
  seg[2] = 0x00; seg[3] = 16;                       // 长度字段（含自身）：2 + 14
  seg[4] = 0x4a; seg[5] = 0x46; seg[6] = 0x49; seg[7] = 0x46; seg[8] = 0x00;   // 'JFIF\0'
  seg[9] = 0x01; seg[10] = 0x01;                    // 版本 1.01
  seg[11] = 1;                                      // units = 1（每英寸）
  seg[12] = (dens >> 8) & 0xff; seg[13] = dens & 0xff;
  seg[14] = (dens >> 8) & 0xff; seg[15] = dens & 0xff;
  seg[16] = 0; seg[17] = 0;                         // 缩略图宽高都是 0

  const out = new Uint8Array(bytes.length + seg.length);
  out.set(bytes.subarray(0, 2), 0);
  out.set(seg, 2);
  out.set(bytes.subarray(2), 2 + seg.length);
  return out;
}
