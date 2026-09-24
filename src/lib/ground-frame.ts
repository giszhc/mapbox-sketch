/* =====================================================================
 * shapes/ground-frame.ts —— 「地面平面」：把标绘算法从屏幕空间搬到地面上跑。
 *
 * ## 为什么需要它（2026-09-18 用户报「倾斜 / 旋转后形状会变形」）
 *
 * 箭头一族、弓形面、弧线、集结地、闭合曲面这些类型，几何算法都是从标绘库
 * 逐行搬来的（`plot-utils.ts` / 各自文件里的 `generate()`），**它们天生跑在
 * 屏幕坐标里**：喂进去的顶点是投影后的屏幕点、算出来的轮廓直接拿去画。
 * 于是「左右多少像素、上下多少像素」成了形状的一部分 —— 地图一带倾斜（pitch）
 * 或旋转（bearing），同样的地理跨度在屏幕上的像素差就变了，形状跟着漂。
 *
 * 修法与圆 / 扇形 / 旗那批一致：**几何在地面平面上算，再逐点投影**。
 * 这个「地面平面」是：
 *
 *   u = lng · cos(lat) · k        v = lat · k
 *
 *   · `cos(lat)` 让东西向与南北向**按米等权**（否则同一度数在两个方向上代表的
 *     实际距离不同，形状会在经度方向被拉长）；
 ⇒ 平面几何一个点都不改 ⇒ 投影出来仍是那块
 *     地面上的形状；zoom 变了 `k` 跟着变 ⇒ 放大地图时形状照旧跟着变大（与既有
 *     手感一致）；
 *   · 取 px 量级（而不是直接用经纬度数）是为了**与搬过来的算法逐点一致**：那些
 *     算式里带幂次近似（如 `getBaseLength` 的 `^0.99`）与少量绝对阈值，换量级会
 *     让比例微变。取 px 量级后，无倾斜 / 无旋转时算出来的平面坐标与旧实现喂进去
 *     的屏幕坐标**逐点相同**，金标准用例因此一条都不用改。
 *
 * ## `k` 从哪来（两条路，优先第一种）
 *
 *  1. **投影实测**（`getPitch() ≈ 0` 时）：拿一个极小的东西向偏移量一次
 *     `project`，用屏幕距离除以度数差得到 `k`。
 *     依据是「pitch = 0 时投影没有透视压缩」—— bearing 只是整体旋转，**保长**，
 *     所以这个实测值天然与 bearing 无关；而它不假设瓦片尺寸 / 投影细节，
 *     与本仓库既有口径一致（见 `math.ts` 里 `smoothStepM` 那段说明）。
 *  2. **zoom 公式**（相机一旦倾斜）：`512 · 2^zoom / (360 · cos(lat))` ——
 *     这是唯一与相机姿态无关的解析来源；倾斜之后投影实测会被透视压缩污染，
 *     不能再拿来当尺度。
 *
 * 两条路在「未倾斜」时给出同一个值（真实地图上公式与实测本就一致），
 * 所以相机姿态在 0 附近不会有跳变。
 *
 * ## 用法（各类型统一这一套）
 *
 *   const f = this.groundFrameAt(geo[0][1]);                 // 基类给的便捷方法
 *   const out = generate(toPlane(geo, f));                   // 同一套算法，原始算式不动
 *   const ring = out.map((p) => this.project(fromPlane(p, f)));   // 平面 → 经纬 → 投影
 *
 * ★ 原版跑在「y 向上」的地理坐标里，本引擎的屏幕是 y 向下 —— 搬过来时各类型都做过
 *   一次 `y` 取反。地面平面天然就是 y 向上（`v = lat` 越大越北），所以走本文件的
 *   类型**不要再取反**。
 * ★ 两条路都拿不到数（地图没就绪 / 样式没加载完）时按 `k = 1` 兜底 —— 那种情况下
 *   本来也投影不出东西，各类型会自行退回「不算几何」。
 *
 * ★ **内部工具**：与 `math.ts` 同一层，不进 `index.ts` / `core.ts` 的公共出口
 *   （自定义类型想用的话，从 `@giszhc/mapbox-sketch/shapes/ground-frame` 直接引，或按同样的
 *   口径自己换算 —— 但**别**顺手把算法搬回屏幕空间，那正是 2026-09-18 修掉的问题）。
 * ===================================================================== */
import type { LngLat, MapboxMap, ScreenPoint } from './types';

/** 一个地面平面坐标系：`u = lng · cosLat · kU`、`v = lat · kV` */
export interface GroundFrame {
  /** 该纬度的 cos 值（已夹到 ≥ 0.01，避免高纬度把东西向放大到失真） */
  cosLat: number;
  /** 「每个等距度（经度方向）」多少像素 */
  kU: number;
  /** 「每度纬度」多少像素 */
  kV: number;
}

/** 每度多少像素的解析式：世界宽度 `512 × 2^zoom` 像素铺满 360°（mercator） */
const PX_PER_DEG = (zoom: number, cosLat: number): number =>
  (512 * Math.pow(2, zoom)) / (360 * cosLat);

/** 实测用的偏移量（度）—— 取值很小，只为了量一个局部比例 */
const PROBE_DEG = 1e-6;

/** 读一个数字 getter（拿不到 / 抛错都返回 undefined） */
function num(map: MapboxMap | null | undefined, name: 'getZoom' | 'getPitch'): number | undefined {
  try {
    const fn = map?.[name];
    const v = typeof fn === 'function' ? (fn as () => number).call(map) : undefined;
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  } catch {
    return undefined;                            // 样式没就绪时有些实现在这里抛
  }
}

/**
 * 取地面平面上一段极小偏移投影后的长度（用来实测「每度多少像素」）。
 * 拿不到就返回 `null`。
 */
function probePxPerDeg(
  project: ((ll: LngLat) => ScreenPoint) | null | undefined,
  lat: number, dLng: number, dLat: number,
): number | null {
  if (!project) return null;
  try {
    const a = project([0, lat]);
    const b = project([dLng, lat + dLat]);
    const px = Math.hypot(b.x - a.x, b.y - a.y);
    const deg = Math.hypot(dLng, dLat);
    if (!Number.isFinite(px) || !(deg > 0)) return null;
    return px / deg;
  } catch {
    return null;                                 // 投影不可用
  }
}

/**
 * 取某个纬度上的地面平面。
 *
 * 两个方向的比例**分开量**：
 *   · `kU` 由东西向偏移实测、`kV` 由南北向偏移实测 —— 真实 mercator 里两者满足
 *     `kV ≈ kU`（都把 `cos(lat)` 折进去了），但**别假定投影实现一定如此**：
 *     本仓库的测试桩就是一个「1° 经度 = 1° 纬度 = N 像素」的等距圆柱投影，
 *     若两个方向共用一个比例，纬度方向上会有 `1/cos(lat)` 量级的偏差
 *     （实测 0.1° 处差 1.5e-6 相对量，正好把逐点金标准顶红）。
 *
 * @param map     地图实例（读 pitch / zoom；缺省时走 zoom 分支的兜底）
 * @param project 单点投影（用来实测比例，缺省时走 zoom 分支）
 * @param lat     定 `cos(lat)` 与比例的纬度（一般取图形的第一个顶点）
 */
export function groundFrameFor(
  map: MapboxMap | null | undefined,
  project: ((ll: LngLat) => ScreenPoint) | null | undefined,
  lat: number,
): GroundFrame {
  const cosLat = Math.max(Math.cos((lat * Math.PI) / 180), 0.01);

  // ① 未倾斜：直接用投影实测两个方向的比例
  //    （pitch = 0 时投影没有透视压缩；bearing 只是整体旋转，**保长** ⇒ 与它无关）
  const pitch = num(map, 'getPitch');
  if (!(pitch != null && pitch > 0.01)) {
    const kLng = probePxPerDeg(project, lat, PROBE_DEG, 0);   // 东西向
    const kLat = probePxPerDeg(project, lat, 0, PROBE_DEG);   // 南北向
    if (kLng && kLat) return { cosLat, kU: kLng / cosLat, kV: kLat };
  }

  // ② 已倾斜（或投影拿不到）：只能靠 zoom 公式（唯一与相机姿态无关的来源）
  //    mercator 下东西向每等距度与南北向每度的像素数是同一个数
  const zoom = num(map, 'getZoom');
  const k = PX_PER_DEG(zoom ?? 0, cosLat);
  return { cosLat, kU: k, kV: k };
}

/**
 * 平面点的手性 —— **必须与「原算法吃哪种坐标」一致**，否则出来的点序会镜像反转：
 *   · `'up'`：原算法吃的是「y 向上的地理坐标」（搬过来时做过一次 `y` 取反的类型：
 *     双箭头 / 细直箭头 / 进攻方向 / 弓形面 / 弧线 / 集结地……）→ 直接用平面 `v`；
 *   · `'down'`：原算法直接吃屏幕坐标（y 向下，没取反过的类型：直箭头 / 闭合曲面……）
 *     → 平面 `v` 取负，保持同一手性。
 * 两者的**形状**其实是同一个（差一次镜像），但点序 / 左右标注会反过来，
 * 而金标准用例逐个点对顺序，所以这里不能含糊。
 */
export type PlaneHanded = 'up' | 'down';

/** 经纬点列 → 地面平面点列（可直接喂给搬过来的算法） */
export const toPlane = (geo: LngLat[], f: GroundFrame, handed: PlaneHanded = 'up'): ScreenPoint[] =>
  geo.map((p) => ({
    x: p[0] * f.cosLat * f.kU,
    y: (handed === 'down' ? -1 : 1) * p[1] * f.kV,
  }));

/** 单个经纬点 → 地面平面点 */
export const toPlaneOne = (p: LngLat, f: GroundFrame, handed: PlaneHanded = 'up'): ScreenPoint =>
  ({
    x: p[0] * f.cosLat * f.kU,
    y: (handed === 'down' ? -1 : 1) * p[1] * f.kV,
  });

/** 地面平面点 → 经纬点（再由调用方投影） */
export const fromPlane = (p: ScreenPoint, f: GroundFrame, handed: PlaneHanded = 'up'): LngLat =>
  [p.x / (f.cosLat * f.kU), ((handed === 'down' ? -1 : 1) * p.y) / f.kV];
