/* =====================================================================
 * shapes/flag.ts —— 内置类型：FlagShape「标志旗标注」。
 *
 * **两击成形**（`minPts = 2` + `autoCommit`，与「矩形标注」同一路手感）：
 *   1) 第一击＝**旗杆底端**（旗子插在哪儿）；
 *   2) 鼠标移动 → 旗子跟着长起来（橡皮筋预览）；
 *   3) 第二击＝**旗面外侧角**，定稿并退出绘制。
 *
 * ★★ 几何在**地理空间**定义（2026-09-18 修，与 rect / ellipse / circle / sector 同一批）：
 *   旗杆是「从杆底沿**地面经线**抬到第二点的纬度」、旗面挂在杆顶并沿**地面纬线**
 *   展开到第二点的经度 —— 三个关键地面点（杆底、杆顶 `(a.lng, b.lat)`、外侧角 `b`）
 *   与旗面下边（两点纬度的正中）在经纬度里取好，再逐一投影。
 *   无倾斜 / 无旋转时与旧画法**逐点相同**（旧版在屏幕空间量 `|Δx|`/`|Δy|`）；
 *   相机一动，旗子跟着地面走真实投影，不再随倾斜 / 旋转按屏幕单方向乱缩
 *   （用户 2026-09-18 报「旗标注还是会变形」）。
 *
 * ★ 旗杆：**没有地图旋转时看上去竖直**（杆顶与杆底同经度 ⇒ 屏幕同 x）；
 *   地图一旦带 bearing，整面旗跟着地面转 —— 这是「贴地」的本义（与 rect / ellipse 一致）。
 *
 * ★ 鼠标的移动各改一维：**东西向 → 旗面宽度**（经度差）、**南北向 → 旗杆高度**（纬度差），
 *   而「朝哪边」全部跟着第二落点走（东/西定旗面方向，南/北定杆顶方向），**一点镜像都不做** ——
 *   第二击落点永远正好落在旗子的一个角上（编辑时手柄与旗子对得上）。
 *
 * ★ 旗杆是一条**线**（`strokePolyline`）；旗面是挂在杆顶的一块**矩形** —— 上边与
 *   杆顶齐平、下边挂在两点纬度的正中。半透明填充（`polygonFill`）+ 一圈描边
 *   （`pathColor` / `pathWidth` / `lineOpacity`）。
 *
 * ★ 尺寸是**几何**、不是样式：全部由两个落点推出来，所以本类型**没有尺寸样式键** ——
 *   想画大一点就把鼠标拉远，不是去改样式。
 *
 * ★ 只存 2 个顶点却画出「一条线 + 一个四边形」：引擎默认命中只认两点之间那条线段
 *   （而**那是条对角线，旗子上根本没画它**），必须自己实现 `hitTest`（杆身 + 旗面），
 *   否则会出现「点空白处命中、点旗子上不命中」这种最招人骂的行为。
 * ★ 旗面与杆都在两个顶点的投影包围盒之外时也要算得出余量（倾斜 / 旋转下会发生），
 *   所以 `cullMargin` 按**整面旗画出来的点**量伸出量。
 *
 * ★ **主体平移不用自己实现 `dragTo`**：引擎已按「屏幕位移」搬顶点（见 `sketch.ts`
 *   的 `_moveBodyByScreen`），旗子这种「屏幕像素差就是全部形状」的类型因此天然不变形。
 *   曾经在本文件里有一份等价实现，引擎统一之后删掉了 —— 别再加回来。
 * ===================================================================== */
import { distToPolyline, fmtM, gdM, pointInRing } from '../math';
import { drawDot, lineDashFor, strokePolyline } from '../paint';
import { MapboxSketch } from '../sketch';
import { MapboxShapeType } from '../sketch-shape-type';
import type { CfgKey, DrawSession, LngLat, ScreenPoint, Shape } from '../types';

/** 旗面高 ＝ 杆高 × 这个比例（旗面上边与杆顶齐平，下边从外侧纬度往回挂这么多） */
const BANNER_H_RATIO = 0.5;

/** 横竖两个尺寸都要 ≥ 这个像素才成形 —— 两击几乎点在同一处时画出来只是一坨 */
const MIN_SPAN_PX = 4;

/** 预览的虚线节奏（与「矩形 / 圆形标注」的手绘预览同一套观感） */
const PREVIEW_DASH: [number, number] = [3, 3];

/** 一面旗的屏幕几何：杆（线）+ 旗面（四边形） */
interface FlagGeom {
  /** 旗杆：底端 → 顶端（无地图旋转时屏幕 x 相同 ⇒ 看上去竖直） */
  pole: [ScreenPoint, ScreenPoint];
  /**
   * 旗面四角（顺时针）：
   * `[0]` 杆顶（内侧上角）、`[1]` **外侧角＝第二击落点**、`[2]` 外侧下角、`[3]` 内侧下角。
   */
  banner: [ScreenPoint, ScreenPoint, ScreenPoint, ScreenPoint];
  /** 杆高（投影后的 px，退化判据用） */
  h: number;
  /** 旗面宽（投影后的 px，退化判据用） */
  w: number;
}

export class FlagShape extends MapboxShapeType {
  get key(): string { return 'flag'; }
  get label(): string { return '标志旗标注'; }
  get minPts(): number { return 2; }
  get autoCommit(): boolean { return true; }   // 杆底 + 旗面外角两击即成（同「矩形标注」）

  cfgKeys(): CfgKey[] { return []; }           // 标志旗没有可调开关

  get hint(): string {
    return '⚑ 绘制<b>标志旗标注</b>：单击定<b>旗杆底端</b> → 移动鼠标'
      + '（<b>左右</b>改旗面宽度、<b>上下</b>改旗杆高度）→ 再次单击完成（第二击即定稿）<br />'
      + '・旗子跟着地面走：<b>没有地图旋转时杆看着竖直</b>，地图一转旗面跟着地面转'
      + '　・第二击落点＝旗面外侧角（编辑时抓它改宽改高）　・<b>Esc</b>＝取消';
  }

  /* ---------------- 几何：渲染 / 命中 / 剔除 / 预览四处共用同一份算式 ---------------- */

  /**
   * 由「杆底 a + 第二击落点 b」算出整面旗的屏幕几何；退化（横竖都太窄）时返回 `null`。
   *
   * 三个地面点（经纬度）+ 一个中点：
   *
   *   杆底   a                          ← 第一击落点
   *   杆顶   (a.lng, b.lat)             ← 沿地面经线抬到第二个点的纬度
   *   外侧角 b                          ← ★ 第二击落点（永远在旗子上）
   *   下边纬度 (a.lat + b.lat)/2         ← 旗面从杆顶往回挂到两点纬度的正中
   *
   *   （无地图旋转时屏幕上就是：杆竖直、上边与杆顶齐平、旗面朝第二点在的那一侧展开）
   *
   * ★ 渲染、`hitTest`、`cullMargin`、`preview` 全走这里 —— 各写一份的后果是
   *   「看着点中了、其实没中」，而且只有用户会发现（AGENTS.md 3.2 那条硬规矩）。
   */
  private _geometry(a: LngLat, b: LngLat): FlagGeom | null {
    const A = this.project(a);
    const T = this.project([a[0], b[1]]);          // 杆顶
    const B = this.project(b);                     // 旗面外侧上角
    const w = Math.abs(B.x - T.x);                 // 旗面宽（投影后 px）
    const h = Math.abs(T.y - A.y);                 // 杆高（投影后 px）
    if (!(w >= MIN_SPAN_PX && h >= MIN_SPAN_PX)) return null;   // NaN / 退化一并挡掉

    // 旗面下边：从第二个点的纬度往回（朝杆底那一侧）挂 0.5 个纬度跨度 ⇒ 两点纬度的正中
    const midLat = b[1] + (a[1] - b[1]) * BANNER_H_RATIO;
    return {
      pole: [A, T],
      banner: [T, B, this.project([b[0], midLat]), this.project([a[0], midLat])],
      h,
      w,
    };
  }

  /** 整面旗画出来的所有点（杆 + 旗面四角）—— 剔除余量按它们量 */
  private _allPts(g: FlagGeom): ScreenPoint[] {
    return [g.pole[0], g.pole[1], ...g.banner];
  }

  describe(shape: Shape): string {
    if (shape.pts.length < 2) return `${this.label} · ${shape.pts.length} 点`;
    const [a, b] = shape.pts;
    // 与「矩形标注」同一套口径：报东西 / 南北两个**地理**跨度
    const w = gdM([a[0], a[1]], [b[0], a[1]]);
    const h = gdM([a[0], a[1]], [a[0], b[1]]);
    return `标志旗 · 宽 ${fmtM(w)} × 高 ${fmtM(h)}`;
  }

  /**
   * 剔除余量：整面旗超出两存储顶点包围盒的最大距离（倾斜 / 旋转下杆顶与旗面会伸出去）
   * 加上线宽一半的余量。
   */
  cullMargin(shape: Shape): number {
    const lw = this.styleFor(shape).pathWidth;
    const pad = (typeof lw === 'number' && lw > 0 ? lw : 3) / 2 + 4;
    const Pts = this.projectPts(shape);
    if (Pts.length < 2) return pad;
    const g = this._geometry(shape.pts[0], shape.pts[1]);
    if (!g) return pad;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of Pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    let reach = 0;
    for (const p of this._allPts(g)) {
      const dx = Math.max(minX - p.x, 0, p.x - maxX);
      const dy = Math.max(minY - p.y, 0, p.y - maxY);
      reach = Math.max(reach, Math.hypot(dx, dy));
    }
    return reach + pad;
  }

  /**
   * 自定义命中：贴着**旗杆**、或落在**旗面**里 / 贴着旗面轮廓（外扩一圈容差）
   * 即算命中本体，使旗子可悬停变红 / 聚焦后拖它平移、拖两个落点改宽改高。
   *
   * ★ 不能用引擎默认那套：默认认的是两个存储顶点之间那条**对角线**，而旗子上
   *   根本没画这条线 —— 照默认来的话就是「点在空白处命中、点在旗面上不命中」。
   */
  hitTest(shape: Shape, x: number, y: number, Pts: ScreenPoint[], tol: number): boolean | undefined {
    if (Pts.length !== 2) return undefined;      // 形态超出预期 → 交回默认规则
    const g = this._geometry(shape.pts[0], shape.pts[1]);
    if (!g) return distToPolyline(x, y, Pts, false) <= tol;   // 退化：贴着两点连线就算
    if (distToPolyline(x, y, g.pole, false) <= tol) return true;
    if (pointInRing(x, y, g.banner)) return true;
    return distToPolyline(x, y, g.banner, true) <= tol;
  }

  /** 已提交的旗子：一条杆 + 一块半透明旗面（悬停时 styleFor 会把 pathColor 染红） */
  render(shape: Shape): void {
    const ctx = this.ctx;
    if (!ctx || shape.pts.length < 2) return;
    const g = this._geometry(shape.pts[0], shape.pts[1]);
    if (!g) return;                              // 退化：不画
    const st = this.styleFor(shape);

    // 旗杆
    strokePolyline(ctx, g.pole, st.pathColor, st.pathWidth, lineDashFor(st.lineType, st.pathWidth), st.lineOpacity);

    // 旗面：四边形（半透明填充 + 一圈描边）
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(g.banner[0].x, g.banner[0].y);
    for (let i = 1; i < g.banner.length; i++) ctx.lineTo(g.banner[i].x, g.banner[i].y);
    ctx.closePath();
    ctx.fillStyle = st.polygonFill;
    ctx.fill();
    // ★ 描边用 pathColor 而不是 pointColor：悬停高亮染的正是它（见基类 styleFor），
    //   换 key 的话旗子就「点上去毫无反应」了
    ctx.globalAlpha = st.lineOpacity;
    ctx.lineWidth = st.pathWidth;
    ctx.strokeStyle = st.pathColor;
    ctx.stroke();
    ctx.restore();
  }

  /** 手绘预览：第一击落定后，旗子跟着鼠标东西长宽、南北长高（虚线 + 淡填充） */
  preview(draw: DrawSession): void {
    const ctx = this.ctx, st = this.style;
    if (!ctx || !st) return;

    const anchor = draw.pts[0] ?? draw.cursor;   // 一击未落：光标处点一下示意起点
    if (!anchor) return;
    const A = this.project(anchor);
    if (!draw.cursor || !draw.pts.length) {
      ctx.save();
      ctx.globalAlpha = 0.6;
      drawDot(ctx, A.x, A.y, 5, st.previewColor);
      ctx.restore();
      return;
    }
    const g = this._geometry(anchor, draw.cursor);

    ctx.save();
    ctx.globalAlpha = 0.6;
    if (g) {
      // 旗杆：一条虚线
      strokePolyline(ctx, g.pole, st.previewColor, 3, PREVIEW_DASH);
      // 旗面：同一条闭合路径上先淡填充、再虚线描边（不重画两遍）
      ctx.beginPath();
      ctx.moveTo(g.banner[0].x, g.banner[0].y);
      for (let i = 1; i < g.banner.length; i++) ctx.lineTo(g.banner[i].x, g.banner[i].y);
      ctx.closePath();
      ctx.fillStyle = st.previewFill;
      ctx.fill();
      ctx.strokeStyle = st.previewColor;
      ctx.lineWidth = 3;
      ctx.setLineDash(PREVIEW_DASH);
      ctx.stroke();
    }
    drawDot(ctx, A.x, A.y, 5, st.previewColor);                        // 杆底（已落点）
    const B = this.project(draw.cursor);
    drawDot(ctx, B.x, B.y, 5, st.previewColor);                        // 第二击落点（定宽定高）
    ctx.restore();                               // restore 一并复位 lineDash
  }
}

/* 自注册：import 本文件即把类型收进静态注册表 */
MapboxSketch.registerType(FlagShape);
