/* =====================================================================
 * cursors.ts —— 手柄光标的构造：**转圈箭头**（旋转柄）与**双向箭头**（缩放角）。
 *
 * 引擎只认「光标压在**第 i 个顶点**上」，而这个顶点在手柄语义上是「转」还是「改大小」，
 * 只有类型自己知道（图片标注：2 号顶点是旋转柄、0/1 号是缩放角）。所以光标由类型通过
 * `MapboxShapeType.vertexCursor(shape, vi)` 表态，这里提供两款现成的给它（以及任何
 * 第三方类型）直接用。
 *
 * ★ 为什么要现造 SVG，而不是给两个 CSS 关键字了事：
 *   · CSS **没有**表示「旋转」的光标 —— `grab` / `move` / `crosshair` 在用户看来都是
 *     别的意思（「拖走」/「可拖」/「精确取点」），拿它们冒充旋转，等于给了个误导；
 *   · 双向箭头只有 8 个固定方向，而图片是**转着放**的：斜 30° 的图配上正 45° 的手柄
 *     箭头，用户顺着箭头拖，走出来的方向跟箭头指的对不上。
 *   所以旋转柄给一支转圈箭头，缩放角按**当前角度**现画一支双向箭头。
 *
 * 两款都是「白芯 + 黑边」：地图底图浅色深色都有可能，单色光标总有一半场景看不清。
 * 每个光标后面都挂了一个**标准光标兜底**（CSS 光标值是逗号分隔的候选列表）：
 * Safari 不认 SVG 光标，会跳到兜底那一项，不至于变成「什么反馈都没有」。
 * ===================================================================== */

/** 光标画布边长(px)：图形都画在正中，热点也取正中 —— 光标不会相对热点「拖偏」 */
const BOX = 24;

/** 画布中心（= 热点坐标） */
const MID = BOX / 2;

/** 白芯线宽(px)：黑边是它的两倍，见 outlined() */
const CORE = 1.8;

/** 双向箭头：杆的端点离中心的距离(px) —— 箭头三角形从这里往外长 */
const SHAFT = 4.2;

/** 双向箭头：箭尖离中心的距离(px)。比 SHAFT 大出来的那段就是箭头本身 */
const TIP = 7.4;

/** 双向箭头：箭头底边的半宽(px) */
const HEAD_W = 2.0;

/** 双向箭头：杆的（白芯）线宽(px)。比旋转那支细一点，免得两条箭头挤成一坨 */
const SHAFT_W = 1.4;

/** 角度量化步长(rad)：15°。见 scaleCursor —— 它同时是那张缓存的规模上限 */
const ANGLE_STEP = Math.PI / 12;

/** 小数点后保留两位：SVG 路径里的浮点数只为了画对，多带几位只会把 data URL 撑长 */
const round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * 一笔线条画两遍 = 黑边白芯（粗黑在下、细白压在上面）。
 * 只能画两遍：一个 path 只认一个 stroke 颜色，没法既白又黑
 * （`paint-order` 管的是「填充和描边谁先在」，不是「描边里再加一层白」）。
 */
function outlined(d: string, core: number): string {
  const g = (w: number, color: string): string =>
    `<g fill="none" stroke="${color}" stroke-width="${w}"`
    + ` stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></g>`;
  return g(core * 2, '#000') + g(core, '#fff');
}

/** 箭头三角形：白底 + 黑边（画在线条之上，箭头才不会被线盖住） */
function head(d: string): string {
  return `<path d="${d}" fill="#fff" stroke="#000" stroke-width="1.4"`
    + ' stroke-linejoin="round"/>';
}

/**
 * SVG 内容 → CSS 光标值。
 *
 * ★ 整串 `encodeURIComponent`：`<` `>` `"` 当然要编，**颜色里的 `#` 更要编** ——
 *   不编的话它会被当成 URL 的 fragment 起点，浏览器静默丢弃这个光标（不报错，
 *   表现就是「写了但没生效」，极难查）。所有字符都在 ASCII 内，不用再声明 charset。
 */
function cursorUrl(inner: string, x: number, y: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${BOX}" height="${BOX}"`
    + ` viewBox="0 0 ${BOX} ${BOX}">${inner}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${x} ${y}`;
}

/* ================================================================
 * 旋转
 * ================================================================ */

/**
 * 转圈箭头：缺口在正**下**方的圆弧 + 贴在弧左端、指着顺时针方向的箭头。
 * 数值是按 24×24 的框**手算好**的（圆心 (12,12)、半径 5.5、缺口 60°、弧走 300°）——
 * 动弧的起止点就得连箭头三角形一起重算，只改一半会画出一支歪箭头。
 *
 * ★ 缺口朝下（原先朝上）：与画布上那支 `paint.rotateHandleIcon` 是同一个样子，
 *   用户 2026-09-14 报「图标反了」之后两处一起翻的 —— 缺口朝上时整支图标读起来像
 *   「从图片这头往下压」，翻到下方才像「绕着图片转」。翻法 = 点 `(x,y) → (24−x, 24−y)`，
 *   圆弧直径的**两个端点对调、方向（顺时针）不变**，所以下面两串数字就是原值各减 24 取负。
 */
const ARC = 'M9.25 16.76A5.5 5.5 0 1 1 14.75 16.76';
const ARC_HEAD = 'M6.48 15.16L8.25 18.49L10.25 15.03Z';

/** 只有一支、没有角度参数，所以造一次就存下来（每次调用都重新 encode 一遍纯属浪费） */
let rotateCache = '';

/**
 * 旋转手柄的光标：转圈箭头。
 *
 * 兜底用 `crosshair` 而不是 `grab` / `move`：后两者在用户看来是「把这个东西拖走」，
 * 而这个柄拖起来转的是图形自己 —— 宁可少说一点，也别给一个会把人带偏的暗示。
 */
export function rotateCursor(): string {
  if (!rotateCache) {
    rotateCache = `${cursorUrl(outlined(ARC, CORE) + head(ARC_HEAD), MID, MID)}, crosshair`;
  }
  return rotateCache;
}

/* ================================================================
 * 缩放
 * ================================================================ */

/** 角度（量化后）→ 光标字符串。量化到 15° 一档，所以最多 12 项，不需要淘汰 */
const scaleCache = new Map<number, string>();

/**
 * 双向箭头：一条斜穿中心的杆 + 两端的箭头。
 *
 * @param rad 屏幕角度（弧度，`Math.atan2(dy, dx)` 那种：0 = 正右，顺时针为正，
 *            因为屏幕 y 轴向下）。传「这条对角线是什么方向」即可，正负无所谓 ——
 *            双向箭头是轴对称的，函数内部会先折到 [0,180)。
 */
export function scaleCursor(rad: number): string {
  // 轴对称：+180° 与 0° 是同一支（不折的话缓存会平白多一倍条目）
  let a = rad % Math.PI;
  if (a < 0) a += Math.PI;
  // ★ 量化到 15° 一档：手柄光标跟着图形朝向转，但没人看得出 15° 的差别，
  //   而缓存表从此**有上限**（12 档），图形转到哪儿都不会造出新的 data URL
  a = Math.round(a / ANGLE_STEP) * ANGLE_STEP;
  if (a >= Math.PI) a = 0;            // 量化后才可能正好落到 180°，它与 0° 是同一条轴
  const hit = scaleCache.get(a);
  if (hit) return hit;
  // 兜底挑最接近的那个标准双向箭头：0°~90° 那一半是「↖↘」（nwse），其余是「↗↙」（nesw）
  const s = `${cursorUrl(scaleGlyph(a), MID, MID)},`
    + ` ${a < Math.PI / 2 ? 'nwse-resize' : 'nesw-resize'}`;
  scaleCache.set(a, s);
  return s;
}

/** 双向箭头的 SVG 内容：杆（白芯黑边）+ 两个箭头（白底黑边） */
function scaleGlyph(a: number): string {
  const c = Math.cos(a), s = Math.sin(a);
  /** 轴上「离中心 k 像素」的那个点 */
  const at = (k: number): [number, number] => [round2(MID + k * c), round2(MID + k * s)];
  const [x1, y1] = at(-SHAFT);
  const [x2, y2] = at(SHAFT);
  let out = outlined(`M${x1} ${y1}L${x2} ${y2}`, SHAFT_W);
  for (const dir of [-1, 1]) {
    const [bx, by] = at(dir * SHAFT);            // 箭头底边中点 = 杆的端点
    const [tx, ty] = at(dir * TIP);              // 箭尖
    // 底边两角：从底边中点沿**法线**各偏 HEAD_W（法线 = 轴向转 90°，与 dir 无关）
    const lx = round2(bx - HEAD_W * s), ly = round2(by + HEAD_W * c);
    const rx = round2(bx + HEAD_W * s), ry = round2(by - HEAD_W * c);
    out += head(`M${tx} ${ty}L${lx} ${ly}L${rx} ${ry}Z`);
  }
  return out;
}
