/* =====================================================================
 * serialize.ts —— 数据文件的解析、校验与过滤（**全是纯函数**）。
 *
 * 为什么要单独一个文件：主类 `sketch.ts` 已经一千多行，管的是画布 / 事件 /
 * 渲染调度；而「这个文件是不是本工具导出的」「这条数据的 cfg 能不能用」
 * 跟那些一点关系都没有，是纯粹的取值判断。拆开之后主类只负责
 * 「分配 id / 写库 / 调度重绘」，两边都好读也好测。
 *
 * ★ 本文件**不 import `sketch.ts`**（与 `registry.ts` 同一个理由：打断环），
 *   只依赖 `constants.ts` 与 `types.ts`。
 * ★ 这里的类型只在本文件与主类的**局部变量**上用，绝不出现在
 *   `MapboxSketch` 的公开签名里 —— 否则打包 `.d.ts` 时会被内联或漏掉。
 * ===================================================================== */
import { DEFAULT_CFG, DEFAULT_STYLE, SKETCH_DATA_VERSION } from './constants';
import type {
  Cfg, CfgPatch, LngLat, Shape, ShapeData, ShapeDatum, SketchData, Style, StylePatch,
} from './types';

/** 数据文件的身份标记。不做成公共常量：版本号消费者要判断，这个只是内部约定 */
const APP_ID = 'mapbox-sketch';

/* ================================================================
 * 白名单规则表
 * ================================================================ */

/**
 * 一个键「长什么样才算数」。取值范围一律不管 ——
 * `pathWidth` 给 -5、`angle` 给 1000，引擎本来也不拦（那是面板的事），
 * 这里只保证进 `shape.cfg` / `shape.style` 的东西**长得像**那个类型的键。
 */
type Rule = 'string' | 'number' | 'boolean' | 'stringArray' | 'spread' | 'tickPos' | 'lineType';

/* 两个闭集。★ 不要为了少写这两行去把 types.ts 的 SpreadMode / TickPos / LineType 改成
 * 由常量推导 —— 那会让只放类型的 types.ts 反过来**引用 constants.ts 的值**，
 * 打包 .d.ts 时会出现值导入，得不偿失。重复两行字面量、注释对齐即可。 */
const SPREAD_VALUES: readonly string[] = ['spread', 'tight'];        // 同 types.ts 的 SpreadMode
const TICK_VALUES: readonly string[] = ['top', 'middle', 'bottom'];  // 同 types.ts 的 TickPos
const LINE_TYPE_VALUES: readonly string[] = ['solid', 'dashed', 'dotted', 'dashDot', 'dashDotDot', 'longDash', 'shortDash']; // 同 types.ts 的 LineType

/** 按默认值的 typeof 推导规则；`overrides` 用来特判那些 typeof 推不出来的键 */
function buildRules(
  src: Record<string, unknown>,
  overrides: Record<string, Rule> = {},
): Record<string, Rule> {
  const rules: Record<string, Rule> = {};
  for (const key of Object.keys(src)) {
    const v = src[key];
    rules[key] = overrides[key]
      || (typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string');
  }
  return rules;
}

/* ★ 白名单**从出厂默认值现场推导**，不手抄键名 ——
 *   以后给 Cfg / Style 加键，这里自动跟上，忘了改也不会把新键吃掉。 */
const CFG_RULES = buildRules(
  DEFAULT_CFG as unknown as Record<string, unknown>,
  { nodes: 'stringArray', spread: 'spread' },
);
const STYLE_RULES = buildRules(
  DEFAULT_STYLE as unknown as Record<string, unknown>,
  { tickPos: 'tickPos', lineType: 'lineType' },
);

function valueOk(v: unknown, rule: Rule): boolean {
  switch (rule) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && isFinite(v);
    case 'boolean': return typeof v === 'boolean';
    case 'stringArray': return Array.isArray(v) && v.every((x) => typeof x === 'string');
    case 'spread': return typeof v === 'string' && SPREAD_VALUES.indexOf(v) >= 0;
    case 'tickPos': return typeof v === 'string' && TICK_VALUES.indexOf(v) >= 0;
    case 'lineType': return typeof v === 'string' && LINE_TYPE_VALUES.indexOf(v) >= 0;
  }
}

/** 过滤的结果：能用的键、以及「键认识但值不能用」的那些键名（要报给调用方） */
interface Picked<T> {
  value: T;
  /** 取值不合法的键名（**不**含「不认识的键」—— 那些静默丢掉） */
  bad: string[];
}

function pickKnown<T>(
  raw: unknown,
  rules: Record<string, Rule>,
): Picked<T> {
  const value: Record<string, unknown> = {};
  const bad: string[] = [];
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return { value: value as T, bad };

  const src = raw as Record<string, unknown>;
  for (const key of Object.keys(rules)) {
    if (!(key in src)) continue;
    const v = src[key];
    if (valueOk(v, rules[key])) value[key] = Array.isArray(v) ? v.slice() : v;   // 数组拷一份，别把调用方的数组接到图形上
    else bad.push(key);
  }
  return { value: value as T, bad };
}

/** 文件里的 cfg → 可用的配置补丁（只留认识的键；`bad` 是「键认识、值不合法」的） */
export function pickCfg(raw: unknown): Picked<CfgPatch> {
  return pickKnown<CfgPatch>(raw, CFG_RULES);
}

/**
 * 文件里的 style → 可用的样式覆盖。
 *
 * ★ 过滤完一个键都不剩时返回 **`null`** 而不是 `{}`：
 *   `styleFor()` 是按 `shape.style` 的**真假**决定要不要 `Object.assign` 的，
 *   `{}` 是真的 —— 每个图形每帧白做一次合并，正好把「无覆盖时返回共享引用」
 *   那条优化废掉。而 `"style": {}` 是文件里很容易出现的东西。
 */
export function pickStyle(raw: unknown): Picked<StylePatch | null> {
  const picked = pickKnown<StylePatch>(raw, STYLE_RULES);
  const empty = Object.keys(picked.value).length === 0;
  return { value: empty ? null : picked.value, bad: picked.bad };
}

/**
 * 文件里的 data → 可用的**类型私有数据**（见 `Shape.data`）。
 *
 * ★ 与 cfg / style 那两张白名单不一样：这里的键是**各个类型自己定的**，引擎压根不认识，
 *   所以没法按「认识的键」筛，只能逐个值校验（字符串 / 有限数字才收）。
 *   嵌套对象、数组、null、布尔一律丢掉并报给调用方 —— 那多半是手改文件写错了，
 *   而图片标注的 `{ image, w, h }` 里混进一个对象，报错时的现场信息就全没了。
 *
 * 空表归一成 `undefined`（同 `pickStyle` 的口径）：`{}` 是真的，
 * 会让「有没有私有数据」那个真假判断变味。
 */
export function pickData(raw: unknown): Picked<Record<string, ShapeDatum> | undefined> {
  const value: Record<string, ShapeDatum> = {};
  const bad: string[] = [];
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { value: undefined, bad };
  }
  const src = raw as Record<string, unknown>;
  for (const key of Object.keys(src)) {
    const v = src[key];
    if (typeof v === 'string' || (typeof v === 'number' && isFinite(v))) value[key] = v;
    else bad.push(key);
  }
  return { value: Object.keys(value).length ? value : undefined, bad };
}

/* ================================================================
 * 导出
 * ================================================================ */

/**
 * 图形 → 数据。**深拷贝**：`pts` 逐点拷、`cfg.nodes` 单独拷。
 *
 * ★ 导出也过一遍白名单（即下面这两个 `pickCfg` / `pickStyle`），
 *   不直接照抄 `shape`：`Cfg` 是闭集，但 `_defaults` 是被 JS 调用方
 *   `config()` 过的，塞进一个陌生键挡不住 —— 它会随 `push()` 的合并渗进
 *   `shape.cfg`，不过滤的话「导出的东西一定能原样导回来」就有漏洞了。
 *   两侧同一张表，往返不变式才是构造上成立的。
 */
export function shapeToData(shape: Shape): ShapeData {
  const cfg = Object.assign({}, DEFAULT_CFG, pickCfg(shape.cfg).value) as Cfg;
  // nodes 单独兜一层：`Object.assign({}, {nodes: []}, {nodes: undefined})` 的结果是
  // undefined，而 JSON.stringify 会把值为 undefined 的键**静默删掉** ——
  // 导出的文件少一个键、类型却还在撒谎。缺了就给空数组。
  cfg.nodes = Array.isArray(cfg.nodes) ? cfg.nodes.slice() : [];

  const out: ShapeData = {
    id: shape.id,
    type: shape.type,
    pts: shape.pts.map((p) => [p[0], p[1]] as LngLat),
    cfg,
    style: pickStyle(shape.style).value,
    hidden: !!shape.hidden,                 // 固定写出，不是可选字段：外壳形状稳定
  };

  // `data` 与 `hidden` 相反，**非空才写**：41 种类型里只有图片标注（图片本体与自然尺寸）
  // 与文字标注（旋转角 `rot`）有私有数据，
  // 给每条点 / 线 / 面都塞一个 `"data": {}` 是纯噪音（而 `hidden` 恒定写出是因为
  // 它是个有意义的布尔值，「没有」本身就是缺省态）。同 cfg / style 的口径，
  // 导出也过一遍校验：JS 调用方往 `shape.data` 里塞个对象挡不住，不过滤的话
  // 「导出的东西一定能原样导回来」这条往返不变式就有漏洞。
  const data = pickData(shape.data).value;
  if (data) out.data = data;
  return out;
}

/**
 * 全局基础样式 → 数据。**整份带走**（不是「只写改过的键」）：这张表得能扛住版本升级 ——
 * 库以后改了 `DEFAULT_STYLE`，老文件导回来也必须是当初那个样子。没有样式覆盖的图形
 * 跟随的正是这份全局样式，少写一个键就等于把它的颜色交给「导入时那台机器的默认值」。
 *
 * 仍然过一遍白名单：`_style` 是 `Object.assign({}, DEFAULT_STYLE, options.style)` 来的，
 * 构造时塞进来的陌生键不该跟着文件走。过滤后缺的键用 `DEFAULT_STYLE` 补齐 ——
 * 这样函数名里的「Global」才有意义：返回的一定是一份**完整**的 `Style`。
 */
export function styleToData(style: Style): Style {
  return Object.assign({}, DEFAULT_STYLE, pickStyle(style).value || {});
}

/** 文件里的 style → 可用的全局样式（补全缺失的键；不认识 / 取值不合法的丢掉） */
export function pickGlobalStyle(raw: unknown): Style {
  return Object.assign({}, DEFAULT_STYLE, pickStyle(raw).value || {});
}

/** 全部图形 → 文件外壳。键序固定，所以「导出→导入→再导出」是逐字节相同的 */
export function toSketchData(shapes: Iterable<Shape>, style: Style): SketchData {
  const list: ShapeData[] = [];
  for (const s of shapes) list.push(shapeToData(s));
  return {
    app: APP_ID,
    version: SKETCH_DATA_VERSION,
    style: styleToData(style),
    shapes: list,
  };
}

/* ================================================================
 * 导入：外壳
 * ================================================================ */

/** 解壳的结果。两个值都**仍是 `unknown`** —— 壳合法不等于里面每条 / 每个键合法 */
export interface ParsedFile {
  /** 文件里的全局样式；`undefined` = 文件没带（v1 老文件 / 手写的）→ 不动导入方的 */
  style: unknown;
  shapes: unknown[];
}

/**
 * 校验文件外壳，返回外壳里的内容（元素**仍是 `unknown`** —— 壳合法不等于每条合法）。
 *
 * 这一层只管「整份文件还能不能用」：不能 → **抛错**，消息写清哪里不对。
 * 抛错之前**一个字段都不改**，调用方（`importJSON`）也就天然满足
 * 「抛错时引擎状态一点不动」。
 */
export function parseSketchData(raw: unknown): ParsedFile {
  let doc: unknown = raw;
  if (typeof raw === 'string') {
    try {
      doc = JSON.parse(raw);
    } catch (err) {
      throw new Error(`导入的数据不是合法的 JSON：${(err as Error).message}`);
    }
  }

  if (doc == null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('导入的数据必须是一个对象（形如 {"app":"mapbox-sketch","version":1,"shapes":[…]}）。');
  }

  const obj = doc as Record<string, unknown>;

  // app 写了就必须对；没写视为本工具的文件（手写的文件不该被拒）。
  // 选错文件是常事，所以这一条直接抛而不是逐条跳过 —— 否则会得到
  // 「一条也没导进来，也不知道为什么」的体验。
  if (obj.app != null && obj.app !== APP_ID) {
    throw new Error(`这不是 mapbox-sketch 导出的数据文件（app = "${String(obj.app)}"）。`);
  }

  // version 没写视为第 1 版；写了就不能比当前引擎支持的还高 ——
  // 让新版本导出的字段在旧版本里被静默丢掉，比报错难查得多。
  const version = obj.version == null ? 1 : obj.version;
  if (typeof version === 'number' && version > SKETCH_DATA_VERSION) {
    throw new Error(
      `数据版本 ${version} 高于当前引擎支持的 ${SKETCH_DATA_VERSION}，请升级 mapbox-sketch 后再导入。`,
    );
  }

  if (!Array.isArray(obj.shapes)) {
    throw new Error('导入的数据里没有 shapes 数组，可能不是 mapbox-sketch 导出的文件。');
  }
  // style 写成不是对象的东西时**不抛**：它只影响外观，不影响「这份数据能不能用」，
  // 交给 pickGlobalStyle 归零即可（抛错会把整份数据的图形也一起拒掉，不值）
  return { style: obj.style, shapes: obj.shapes };
}

/* ================================================================
 * 导入：逐条
 * ================================================================ */

/** 一条**通过了校验**的数据。`id` 只表示「文件里写了个能用的字符串」，是否被占用由主类判断 */
export interface ImportItem {
  type: string;
  id: string | null;
  pts: LngLat[];
  cfg: CfgPatch;
  style: StylePatch | null;
  hidden: boolean;
  /** 类型私有数据（见 `Shape.data`）；一个可用的值都没有时是 `undefined` */
  data?: Record<string, ShapeDatum>;
  /** 字段级问题（序号已写进文案）：键取值不合法之类，**该条仍然导入** */
  warnings: string[];
}

export type ReadResult =
  | { ok: true; item: ImportItem }
  | { ok: false; reason: string };

function readPts(raw: unknown): LngLat[] | null {
  if (!Array.isArray(raw)) return null;
  const out: LngLat[] = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length < 2) return null;
    const lng = p[0];
    const lat = p[1];
    // ★ 数值必须自己校验：`push()` 只拷不查，`[[0,"x"]]` 会一路流到 map.project
    //   变成 NaN 静默烂掉。JSON.parse 生不出 NaN，但对象入参能。
    if (typeof lng !== 'number' || typeof lat !== 'number') return null;
    if (!isFinite(lng) || !isFinite(lat)) return null;
    out.push([lng, lat]);
  }
  return out;
}

/**
 * 校验单条数据。
 *
 * 分界：**这条能不能成图形**。成不了 → `ok: false` + 中文原因（主类计入 `skipped`）；
 * 能成图形、只是某个字段不能用（比如 `spread` 写了个不认识的值）→ 丢掉那个字段、
 * 记一条 warning，该条**照常导入**。整份文件坏成一片才值得让人重导一次，
 * 一条数据的某个字段手抖写错不该连累它自己。
 *
 * `minPts` 的检查**不在这里**：那要查类型注册表，是主类的事。
 * 但它必须在 `push()` **之前**做完 —— `push` 对顶点不够是**抛错**的，
 * 漏检一条就会让整批导入中断。
 */
export function readShapeData(raw: unknown, index: number): ReadResult {
  const at = `第 ${index + 1} 条数据`;
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: `${at}不是对象，已跳过。` };
  }

  const src = raw as Record<string, unknown>;
  if (typeof src.type !== 'string' || !src.type) {
    return { ok: false, reason: `${at}缺少 type（或不是字符串），已跳过。` };
  }

  const pts = readPts(src.pts);
  if (!pts) return { ok: false, reason: `${at}（${src.type}）的顶点不是合法的坐标数组，已跳过。` };

  const warnings: string[] = [];

  let id: string | null = null;
  if (src.id != null) {
    if (typeof src.id === 'string' && src.id) id = src.id;
    else warnings.push(`${at}的 id 不是非空字符串，已自动分配。`);
  }

  const pickedCfg = pickCfg(src.cfg);
  if (src.cfg != null && (typeof src.cfg !== 'object' || Array.isArray(src.cfg))) {
    warnings.push(`${at}的 cfg 不是对象，已改用当前默认配置。`);
  } else if (pickedCfg.bad.length) {
    warnings.push(`${at}的 cfg.${pickedCfg.bad.join(' / ')} 取值不合法，已改用当前默认值。`);
  }

  const pickedStyle = pickStyle(src.style);
  if (src.style != null && (typeof src.style !== 'object' || Array.isArray(src.style))) {
    warnings.push(`${at}的 style 不是对象，已忽略。`);
  } else if (pickedStyle.bad.length) {
    warnings.push(`${at}的 style.${pickedStyle.bad.join(' / ')} 取值不合法，已忽略。`);
  }

  const pickedData = pickData(src.data);
  if (src.data != null && (typeof src.data !== 'object' || Array.isArray(src.data))) {
    warnings.push(`${at}的 data 不是对象，已忽略。`);
  } else if (pickedData.bad.length) {
    warnings.push(`${at}的 data.${pickedData.bad.join(' / ')} 取值不合法，已忽略。`);
  }

  return {
    ok: true,
    item: {
      type: src.type,
      id,
      pts,
      cfg: pickedCfg.value,
      style: pickedStyle.value,
      hidden: src.hidden === true,
      data: pickedData.value,
      warnings,
    },
  };
}

/** 「第 3 条数据的 id "x" 已被占用」这类文案，主类分配完 id 之后自己也能拼 */
export function idTakenWarning(index: number, from: string, to: string): string {
  return `第 ${index + 1} 条数据的 id "${from}" 已被占用，已改为 "${to}"。`;
}
