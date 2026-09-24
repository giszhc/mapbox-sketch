/* =====================================================================
 * shapes/flag-tri.ts —— 内置类型：FlagTriShape「三角标志旗帜标注」。
 *
 * 与 `flag.ts`（矩形旗面）**同一套交互与口径**，只把旗面从矩形换成**三角形**
 * （三角旗 / 尖旗）。两击成形（`minPts = 2` + `autoCommit`，与「矩形标注」同一路手感）：
 *   1) 第一击＝**旗杆底端**；
 *   2) 鼠标移动 → 旗子跟着长起来（橡皮筋预览）；
 *   3) 第二击＝**三角旗面的尖端**，定稿并退出绘制。
 *
 * ★ 三个硬口径，与矩形旗**逐字相同**（用户 2026-09-16 两轮纠正定下来的，别改回去）：
 *   · 旗杆**永远竖直** —— 杆顶 x 与杆底相同（`A.x`），不跟着鼠标歪；
 *   · **一点镜像都不做** —— 杆顶用鼠标的 y、旗面用鼠标的 x，鼠标落在落点下方时
 *     整面旗吊在下面（与矩形 / 椭圆「拖到哪就是哪」一致）；
 *   · 第二击落点永远是**形状上的一个真实点** —— 这里是三角旗面的**尖端**，
 *     所以点选编辑时手柄正好压在旗子上（早先矩形旗那版把它镜像走，用户直接报「点跑掉了」）。
 *
 * ★ 鼠标各管一维：**左右 → 三角旗面的宽度**（`|Δx|`，即尖端离杆的距离）、
 *   **上下 → 三角旗面的高度**（`|Δy|`＝杆高的一半，见下）。
 *
 * ★ 三角旗面怎么摆（**照用户给的那张参考图量的**，2026-09-16 第三轮纠正后定稿）：
 *
 *        ●  ← 杆顶 T ＝ 三角旗面的后上角（同一个点，杆不再往上多伸一截）
 *        │╲
 *        │  ╲
 *        │    ╲
 *        │      ●  ← 尖端 ＝ 第二击落点 B（手柄就抓这儿）
 *        ●──────┘  ← 后下角 E（同一根杆上，**与尖端同高 ⇒ 底边是一条水平直线**）
 *        │
 *        ●  ← 杆底 A（第一击落点）
 *
 *   ★ **底边是直线、不是斜线**（用户原话）—— 这是这一段最要紧的一条：后下角 E 的 y
 *     与尖端**完全相同**，于是 `E → B` 就是一条水平线。上一版把尖端摆在旗面高度的正中
 *     （`E` 落在尖端下方 `span/2`），底边就成了斜的，用户一眼看出来不对。
 *
 *   ★ 旗面高 `span ≡ |Δy|`（＝上下移动多少，旗面就多高），杆顶因此落在
 *     `B.y + s·|Δy|` 处 ⇒ **尖端永远正好在一根杆的正中**，杆高 ＝ `2|Δy|`。
 *     这个比例不是拍的：用户那张参考图里量出来「旗面高 115px / 尖端到杆底 109px」，
 *     就是 1:1（杆高 224 ＝ 109 + 115）。
 *
 * ★ 尺寸是**几何**、不是样式：全部由两个落点推出来，所以本类型**没有尺寸样式键**。
 * ★ 只存 2 个顶点却画出「一条线 + 一个三角形」：引擎默认命中认的是两点之间那条
 *   **对角线**（画面上根本没画它），必须自己实现 `hitTest`（杆身 + 三角面）。
 * ★ 杆顶比两个落点都高 `span`（在两点包围盒**之外**），`cullMargin` 要把它盖住。
 * ★ **主体平移不用自己实现 `dragTo`**：引擎已按「屏幕位移」搬顶点（见 `sketch.ts`
 *   的 `_moveBodyByScreen`），三角旗这种「屏幕像素差就是全部形状」的类型天然不变形。
 * ===================================================================== */
import { distToPolyline, fmtM, gdM, pointInRing } from '../math';
import { drawDot, lineDashFor, strokePolyline } from '../paint';
import { MapboxSketch } from '../sketch';
import { MapboxShapeType } from '../sketch-shape-type';
import type { CfgKey, DrawSession, LngLat, ScreenPoint, Shape } from '../types';

/** 横竖两个尺寸都要 ≥ 这个像素才成形 —— 两击几乎点在同一处时画出来只是一坨 */
const MIN_SPAN_PX = 4;

/** 预览的虚线节奏（与「矩形 / 圆形标注」的手绘预览同一套观感） */
const PREVIEW_DASH: [number, number] = [3, 3];

/** 一面三角旗的屏幕几何：杆（竖直线）+ 三角旗面 */
interface FlagTriGeom {
  /** 旗杆：底端 → 顶端，两个点（顶端 x 与底端相同 ⇒ 杆永远竖直） */
  pole: [ScreenPoint, ScreenPoint];
  /**
   * 三角旗面三角（顺时针）：`[0]` 后上角＝杆顶、`[1]` **尖端＝第二击落点**、
   * `[2]` 后下角（与尖端**同高** ⇒ 底边水平）。三点逆序时也照样闭合。
   */
  tri: [ScreenPoint, ScreenPoint, ScreenPoint];
  /** 杆高（px，＝ 杆底到杆顶 ＝ `2|Δy|`） */
  h: number;
  /** 三角旗面宽（px，＝ 尖端到杆的距离） */
  w: number;
  /** 三角旗面高（px，＝ `|Δy|`，即杆高的一半） */
  span: number;
}

export class FlagTriShape extends MapboxShapeType {
  get key(): string { return 'flagTri'; }
  get label(): string { return '三角标志旗帜标注'; }
  get minPts(): number { return 2; }
  get autoCommit(): boolean { return true; }   // 杆底 + 尖端两击即成（同「矩形标注」）

  cfgKeys(): CfgKey[] { return []; }           // 三角旗没有可调开关

  get hint(): string {
    return '⚑ 绘制<b>三角标志旗帜标注</b>：单击定<b>旗杆底端</b> → 移动鼠标'
      + '（<b>左右</b>改三角旗面宽度、<b>上下</b>改三角旗面高度）→ 再次单击完成（第二击即定稿）<br />'
      + '・旗子跟着地面走：<b>没有地图旋转时杆看着竖直、底边看着水平</b>　'
      + '・第二击落点＝三角旗面的<b>尖端</b>（编辑时抓它改宽改高）　・<b>Esc</b>＝取消';
  }

  /* ---------------- 几何：渲染 / 命中 / 预览三处共用同一份算式 ---------------- */

  /**
   * 由「杆底 a + 第二击落点 b（尖端）」算出整面旗的屏幕几何；退化时返回 `null`。
   *
   * 四个**地面**点（经纬度、逐一投影）：
   *
   *   杆底   a                                ← 第一击落点
   *   杆顶   (a.lng, 2·b.lat − a.lat)          ← 比尖端再沿地面经线远一个纬度跨度
   *   尖端   b                                ← ★ 第二击落点（永远在旗子上）
   *   后下角 (a.lng, b.lat)                    ← 与尖端**同纬度** ⇒ 底边沿地面纬线（水平）
   *
   *   （无地图旋转时屏幕上就是：杆竖直、底边水平、尖端落在杆的正中 —— 杆高 = 2×旗面高）
   *
   * ★ **底边 `E → B` 必须水平**（user 第三轮纠正的原话是「底部是直线 不是斜线」）——
   *   在地面口径下就是「两点同纬度」，别再把尖端摆到旗面高度的正中。
   * ★ 第二击落点在杆底**另一侧（更南 / 更北）**时整套几何跟着翻过去，**一点镜像都不做** ——
   *   `tri[1]` 永远就是 `b` 本身。
   *
   * ★ 渲染、`hitTest`、`cullMargin`、`preview` 全走这里 —— 各写一份的后果是「看着点中了、
   *   其实没中」，而且只有用户会发现（AGENTS.md 3.2 那条硬规矩）。
   */
  private _geometry(a: LngLat, b: LngLat): FlagTriGeom | null {
    const A = this.project(a);
    const B = this.project(b);                                 // 尖端
    const T = this.project([a[0], 2 * b[1] - a[1]]);           // 杆顶：比尖端再远一个纬度跨度
    const E = this.project([a[0], b[1]]);                      // 后下角：与尖端同纬度 ⇒ 底边水平
    const w = Math.abs(B.x - E.x);                             // 三角旗面宽（投影后 px）
    const span = Math.abs(T.y - E.y);                          // 旗面高（投影后 px）
    if (!(w >= MIN_SPAN_PX && span >= MIN_SPAN_PX)) return null;   // NaN / 退化一并挡掉

    return {
      pole: [A, T],
      tri: [T, B, E],
      h: Math.abs(T.y - A.y),                                  // 杆高 ＝ 两倍旗面高
      w,
      span,
    };
  }

  describe(shape: Shape): string {
    if (shape.pts.length < 2) return `${this.label} · ${shape.pts.length} 点`;
    const [a, b] = shape.pts;
    // 与「矩形标注」同一套口径：报东西 / 南北两个**地理**跨度
    const w = gdM([a[0], a[1]], [b[0], a[1]]);
    const h = gdM([a[0], a[1]], [a[0], b[1]]);
    return `三角旗 · 宽 ${fmtM(w)} × 高 ${fmtM(h)}`;
  }

  /**
   * 杆顶比两个落点都靠外 `span`（**超出两点包围盒**），其余部分都在盒子里 ——
   * 所以余量 ＝ `span` + 线宽一半 + 一点容差。
   *
   * ★ 算得出来才算（投影不可用时退回线宽那一档），写 0 会让旗子刚出屏就被剔除。
   */
  cullMargin(shape: Shape): number {
    const lw = this.styleFor(shape).pathWidth;
    const pad = (typeof lw === 'number' && lw > 0 ? lw : 3) / 2 + 4;
    const Pts = this.projectPts(shape);
    if (Pts.length < 2) return pad;
    const g = this._geometry(shape.pts[0], shape.pts[1]);
    if (!g) return pad;
    // 杆顶在两点包围盒之外（倾斜 / 旋转下还会更多），按整面旗画出来的点量伸出量
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of Pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    let reach = 0;
    for (const p of [g.pole[0], g.pole[1], ...g.tri]) {
      const dx = Math.max(minX - p.x, 0, p.x - maxX);
      const dy = Math.max(minY - p.y, 0, p.y - maxY);
      reach = Math.max(reach, Math.hypot(dx, dy));
    }
    return reach + pad;
  }

  /**
   * 自定义命中：贴着**旗杆**、或落在**三角旗面**里 / 贴着它的边（外扩一圈容差）
   * 即算命中本体，使旗子可悬停变红 / 聚焦后拖它平移、拖两个落点改宽改高。
   *
   * ★ 不能用引擎默认那套：默认认的是两个存储顶点之间那条**对角线**，而旗面上
   *   根本没画这条线 —— 照默认来的话就是「点在空白处命中、点在旗面上不命中」。
   */
  hitTest(shape: Shape, x: number, y: number, Pts: ScreenPoint[], tol: number): boolean | undefined {
    if (Pts.length !== 2) return undefined;      // 形态超出预期 → 交回默认规则
    const g = this._geometry(shape.pts[0], shape.pts[1]);
    if (!g) return distToPolyline(x, y, Pts, false) <= tol;   // 退化：贴着两点连线就算
    if (distToPolyline(x, y, g.pole, false) <= tol) return true;
    if (pointInRing(x, y, g.tri)) return true;
    return distToPolyline(x, y, g.tri, true) <= tol;
  }

  /** 已提交的旗子：一条竖杆 + 一块半透明三角旗面（悬停时 styleFor 会把 pathColor 染红） */
  render(shape: Shape): void {
    const ctx = this.ctx;
    if (!ctx || shape.pts.length < 2) return;
    const g = this._geometry(shape.pts[0], shape.pts[1]);
    if (!g) return;                              // 退化：不画
    const st = this.styleFor(shape);

    // 旗杆
    strokePolyline(ctx, g.pole, st.pathColor, st.pathWidth, lineDashFor(st.lineType, st.pathWidth), st.lineOpacity);

    // 三角旗面：半透明填充 + 一圈描边
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(g.tri[0].x, g.tri[0].y);
    for (let i = 1; i < g.tri.length; i++) ctx.lineTo(g.tri[i].x, g.tri[i].y);
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

  /** 手绘预览：第一击落定后，旗子跟着鼠标左右长宽、上下长高（虚线 + 淡填充） */
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
      // 三角旗面：同一条闭合路径上先淡填充、再虚线描边（不重画两遍）
      ctx.beginPath();
      ctx.moveTo(g.tri[0].x, g.tri[0].y);
      for (let i = 1; i < g.tri.length; i++) ctx.lineTo(g.tri[i].x, g.tri[i].y);
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
    drawDot(ctx, B.x, B.y, 5, st.previewColor);                        // 第二击落点（尖端）
    ctx.restore();                               // restore 一并复位 lineDash
  }
}

/* 自注册：import 本文件即把类型收进静态注册表 */
MapboxSketch.registerType(FlagTriShape);
