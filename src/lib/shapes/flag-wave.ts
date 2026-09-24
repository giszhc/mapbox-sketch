/* =====================================================================
 * shapes/flag-wave.ts —— 内置类型：FlagWaveShape「曲线标志旗标注」。
 *
 * **两击成形**（`minPts = 2` + `autoCommit`，与「矩形标注 / 标志旗标注」同一路手感）：
 *   1) 第一击＝**旗杆底端**（旗子插在哪儿）；
 *   2) 鼠标移动 → 旗子跟着长起来（橡皮筋预览）；
 *   3) 第二击＝**旗面外上角**（旗子右端竖直边的上端），定稿并退出绘制。
 *
 * ★ 与「标志旗标注」（矩形旗面）、「三角标志旗标注」（三角旗面）**同一套硬口径**
 *   （用户 2026-09-16 为前两种定的，这里逐字沿用，别改回去）：
 *   · 旗杆**永远竖直**（杆顶 x = 杆底 x，不跟着鼠标歪）；
 *   · **一点镜像都不做** —— 杆顶用鼠标 y、旗面用鼠标 x，鼠标落在杆底下方时整面旗
 *     吊在下面（与矩形 / 椭圆「拖到哪就是哪」一致）；
 *   · 第二击落点永远是**形状上的一个真实角**（这里是旗面外上角），点选手柄正好压在旗子上；
 *   · 鼠标各管一维：**左右 → 旗面宽度**（`|Δx|`）、**上下 → 旗杆高度**（`|Δy|`）。
 *
 * ★ 旗面是一块**波浪带**（用户给的参考图，2026-09-16 用 PowerShell 扫像素量出来的）：
 *
 *          ●────────────────●  ← 上边缘：一条完整正弦波（起点 / 终点都回到杆顶高度）
 *         ╱ ╲              ╱ ╲
 *        ●   ╲            ╱   ●  ← 旗面外上角 ＝ 第二击落点
 *        │    ●──────────●    │
 *        │                     │
 *        ●─────────────────────●  ← 下边缘：与上边缘**同相位**、恒差一个旗面高
 *        │
 *        ●  ← 杆底 A（第一击落点）
 *
 *   量出来的口径（参考图 210×210，取整后）：
 *     · 杆 x=29，y 从 28（杆顶）到 192；旗面右边缘是一条**竖直边**（x=180，y 28→111）；
 *     · 上下两条边**同相位、恒定等高**（逐列高度恒为 83~84）⇒ 是一条等宽波浪带，
 *       不是「上下各扭各的」；
 *     · 上边缘在整幅旗面宽度上正好走**一个完整正弦周期**：起点 / 终点都回到杆顶高度，
 *       1/4 处是谷（比杆顶低 8px）、3/4 处是峰（比杆顶高 8px）；
 *     · 振幅 8 ≈ 旗面高 84 的 9.5%（取 10%），旗面高 84 ≈ 杆高 164 的一半（取 0.5，与矩形旗同）。
 *
 *   ★ 于是「峰」会比杆顶还高出 `amp` 一截（在两点包围盒**之外**）—— `cullMargin` 要盖住它，
 *     写 0 会让旗子刚滑出屏幕上沿就被剔除。
 *
 * ★ 只存 2 个顶点却画出「一条线 + 一块波浪带」：引擎默认命中认的是两点之间那条
 *   **对角线**（画面上根本没画它），必须自己实现 `hitTest`（杆身 + 旗面环）。
 * ★ 尺寸是**几何**、不是样式：全部由两个落点推出来，所以本类型**没有尺寸样式键**。
 * ★ **主体平移不用自己实现 `dragTo`**：引擎已按「屏幕位移」搬顶点（见 `sketch.ts`
 *   的 `_moveBodyByScreen`），曲线旗这种「屏幕像素差就是全部形状」的类型天然不变形。
 * ===================================================================== */
import { distToPolyline, fmtM, gdM, pointInRing } from '../math';
import { drawDot, lineDashFor, strokePolyline } from '../paint';
import { MapboxSketch } from '../sketch';
import { MapboxShapeType } from '../sketch-shape-type';
import type { CfgKey, DrawSession, LngLat, ScreenPoint, Shape } from '../types';

/** 旗面高 ＝ 杆高 × 这个比例（与「标志旗标注」同口径） */
const BANNER_H_RATIO = 0.5;

/** 波浪振幅 ＝ 旗面高与宽度里较小的那个 × 这个比例（参考图量出来 8 / 84 ≈ 9.5%） */
const WAVE_AMP_RATIO = 0.1;

/** 一条边上采样多少段 —— 一个完整正弦周期，24 段肉眼已经看不出折线 */
const WAVE_SEGMENTS = 24;

/** 横竖两个尺寸都要 ≥ 这个像素才成形 —— 两击几乎点在同一处时画出来只是一坨 */
const MIN_SPAN_PX = 4;

/** 预览的虚线节奏（与「矩形 / 圆形标注」的手绘预览同一套观感） */
const PREVIEW_DASH: [number, number] = [3, 3];

/** 一面曲线旗的屏幕几何：杆（线）+ 旗面（波浪带） */
interface FlagWaveGeom {
  /** 旗杆：底端 → 顶端（无地图旋转时屏幕 x 相同 ⇒ 看上去竖直） */
  pole: [ScreenPoint, ScreenPoint];
  /**
   * 旗面外轮廓（闭合环，顺时针）：上边缘（西→东，正弦采样）→ 右侧竖直边 →
   * 下边缘（东→西）→ 左侧边（落在杆上，由 `closePath` 收口）。
   */
  ring: ScreenPoint[];
  /** 杆高（投影后 px） */
  h: number;
  /** 旗面宽（投影后 px） */
  w: number;
  /** 旗面高（**地面**纬度带高；下边缘 ＝ 上边缘同相位平移这么多纬度） */
  bandLat: number;
  /** 波浪振幅（**地面**纬度，上边缘相对第二点纬度上下摆动的幅度） */
  ampLat: number;
  /** 波浪振幅折算到屏幕上的最大抬升量(px)：剔除余量用它（倾斜下跟着变） */
  amp: number;
}

export class FlagWaveShape extends MapboxShapeType {
  get key(): string { return 'flagWave'; }
  get label(): string { return '曲线标志旗标注'; }
  get minPts(): number { return 2; }
  get autoCommit(): boolean { return true; }   // 杆底 + 旗面外上角两击即成（同「矩形标注」）

  cfgKeys(): CfgKey[] { return []; }           // 曲线旗没有可调开关

  get hint(): string {
    return '⚑ 绘制<b>曲线标志旗标注</b>：单击定<b>旗杆底端</b> → 移动鼠标'
      + '（<b>左右</b>改旗面宽度、<b>上下</b>改旗杆高度）→ 再次单击完成（第二击即定稿）<br />'
      + '・旗子跟着地面走：<b>没有地图旋转时杆看着竖直</b>　・第二击落点＝旗面<b>外上角</b>'
      + '（编辑时抓它改宽改高）　・旗面是<b>波浪带</b>（上下边缘同相位、等高）　・<b>Esc</b>＝取消';
  }

  /* ---------------- 几何：渲染 / 命中 / 剔除 / 预览四处共用同一份算式 ---------------- */

  /**
   * 由「杆底 a + 第二击落点 b（旗面外上角）」算出整面旗的屏幕几何；退化时返回 `null`。
   *
   * 关键**地面**点（经纬度，逐一投影）：杆底 `a`、杆顶 `(a.lng, b.lat)`、
   * 外上角 `b`；上边缘 `lat(u) = b.lat + ampLat·sin(2πu)`、经度沿 `a.lng → b.lng`
   * 线性推进；下边缘同相位、纬度低（或少）一个 `bandLat`。
   *
   *   （无地图旋转时屏幕上就是：杆竖直、上边缘一个完整正弦周期、上下两边恒等高）
   *
   * ★ 上边缘全程正好**一个完整周期**，所以左右两端都精确回到第二个点的纬度 ——
   *   参考图上量出来的就是这个。
   * ★ 下边缘 ＝ 上边缘**同相位**平移 `bandLat`（恒等高的带子），不是另扭一条。
   * ★ 渲染、`hitTest`、`cullMargin`、`preview` 全走这里 —— 各写一份的后果是
   *   「看着点中了、其实没中」，而且只有用户会发现（AGENTS.md 3.2 那条硬规矩）。
   */
  private _geometry(a: LngLat, b: LngLat): FlagWaveGeom | null {
    const A = this.project(a);
    const T = this.project([a[0], b[1]]);        // 杆顶：沿地面经线抬到第二个点的纬度
    const B = this.project(b);                   // 旗面外上角（上边缘右端）
    const w = Math.abs(B.x - T.x);               // 旗面宽（投影后 px）
    const h = Math.abs(T.y - A.y);               // 杆高（投影后 px）
    if (!(w >= MIN_SPAN_PX && h >= MIN_SPAN_PX)) return null;   // NaN / 退化一并挡掉

    // 波带在地面纬度上定义：带高 = 杆高的 0.5；下边缘从外上角往回（朝杆底那一侧）挂
    const dLat = b[1] - a[1];
    const s = dLat >= 0 ? 1 : -1;
    const cosLat = Math.max(Math.cos((a[1] * Math.PI) / 180), 0.01);
    const bandLat = Math.abs(dLat) * BANNER_H_RATIO;
    // 振幅取「带高」与「宽度（按米折算到纬度）」里较小的那个的 10%（与参考图一致）
    const ampLat = Math.min(bandLat, Math.abs(b[0] - a[0]) * cosLat) * WAVE_AMP_RATIO;

    /**
     * 上边缘在沿宽比例 `u` 处的纬度（一个完整正弦周期，两端精确回到 b 的纬度）。
     * ★ 取**负号**：参考图口径是「1/4 处是谷（低于第二点）、3/4 处是峰」——
     *   纬度升高 = 屏幕上移，所以要让 1/4 处更低，就得在那儿**减**振幅。
     */
    const topLat = (u: number) => b[1] - ampLat * Math.sin(2 * Math.PI * u);

    const ring: ScreenPoint[] = [];
    // 上边缘：西 → 东
    for (let i = 0; i <= WAVE_SEGMENTS; i++) {
      const u = i / WAVE_SEGMENTS;
      ring.push(this.project([a[0] + (b[0] - a[0]) * u, topLat(u)]));
    }
    // 下边缘：东 → 西（同相位，纬度差恒为 bandLat）
    for (let i = WAVE_SEGMENTS; i >= 0; i--) {
      const u = i / WAVE_SEGMENTS;
      ring.push(this.project([a[0] + (b[0] - a[0]) * u, topLat(u) - s * bandLat]));
    }

    return {
      pole: [A, T],
      ring,
      h,
      w,
      bandLat,
      ampLat,
      /** 峰在屏幕上的最大抬升量(px)：剔除余量要用（投影后的量，倾斜下也跟着变） */
      amp: (() => {
        let m = 0;
        const mid = (a[0] + b[0]) / 2;
        const base = this.project([mid, b[1]]).y;
        const peak = this.project([mid, b[1] + ampLat]).y;
        m = Math.max(m, Math.abs(peak - base));
        const trough = this.project([mid, b[1] - ampLat]).y;
        return Math.max(m, Math.abs(trough - base));
      })(),
    };
  }

  describe(shape: Shape): string {
    if (shape.pts.length < 2) return `${this.label} · ${shape.pts.length} 点`;
    const [a, b] = shape.pts;
    // 与「矩形标注」同一套口径：报东西 / 南北两个**地理**跨度
    const w = gdM([a[0], a[1]], [b[0], a[1]]);
    const h = gdM([a[0], a[1]], [a[0], b[1]]);
    return `曲线旗 · 宽 ${fmtM(w)} × 高 ${fmtM(h)}`;
  }

  /**
   * 上边缘的**峰**比杆顶还高出 `amp` 一截（在两点包围盒**之外**），其余部分都在盒子里 ——
   * 所以余量 ＝ `amp` + 线宽一半 + 一点容差。
   *
   * ★ 算得出来才算（投影不可用时退回线宽那一档），写 0 会让旗子刚出屏就被剔除。
   */
  cullMargin(shape: Shape): number {
    const lw = this.styleFor(shape).pathWidth;
    const pad = (typeof lw === 'number' && lw > 0 ? lw : 3) / 2 + 4;
    const Pts = this.projectPts(shape);
    if (Pts.length < 2) return pad;
    const g = this._geometry(shape.pts[0], shape.pts[1]);
    return (g ? g.amp : 0) + pad;
  }

  /**
   * 自定义命中：贴着**旗杆**、或落在**旗面**里 / 贴着旗面轮廓（外扩一圈容差）
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
    if (pointInRing(x, y, g.ring)) return true;
    return distToPolyline(x, y, g.ring, true) <= tol;
  }

  /** 已提交的旗子：一条杆 + 一块半透明波浪带（悬停时 styleFor 会把 pathColor 染红） */
  render(shape: Shape): void {
    const ctx = this.ctx;
    if (!ctx || shape.pts.length < 2) return;
    const g = this._geometry(shape.pts[0], shape.pts[1]);
    if (!g) return;                              // 退化：不画
    const st = this.styleFor(shape);

    // 旗杆
    strokePolyline(ctx, g.pole, st.pathColor, st.pathWidth, lineDashFor(st.lineType, st.pathWidth), st.lineOpacity);

    // 旗面：波浪带（半透明填充 + 一圈描边）
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(g.ring[0].x, g.ring[0].y);
    for (let i = 1; i < g.ring.length; i++) ctx.lineTo(g.ring[i].x, g.ring[i].y);
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
      // 旗面：同一条闭合路径上先淡填充、再虚线描边（不重画两遍）
      ctx.beginPath();
      ctx.moveTo(g.ring[0].x, g.ring[0].y);
      for (let i = 1; i < g.ring.length; i++) ctx.lineTo(g.ring[i].x, g.ring[i].y);
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
    drawDot(ctx, B.x, B.y, 5, st.previewColor);                        // 第二击落点（旗面外上角）
    ctx.restore();                               // restore 一并复位 lineDash
  }
}

/* 自注册：import 本文件即把类型收进静态注册表 */
MapboxSketch.registerType(FlagWaveShape);
