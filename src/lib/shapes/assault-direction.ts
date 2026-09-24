/* =====================================================================
 * shapes/assault-direction.ts —— 内置类型：AssaultDirectionShape「突击方向标注」。
 *
 * ★★ 几何**照搬**标绘库 mapbox-plot 的 `src/gispace/plot/AssaultDirection.js`
 *   （＝ openlayers-plot 的 `P.PlotTypes.ASSAULT_DIRECTION`，那个 demo 的按钮中文名
 *   「突击方向」）。用户 2026-09-17 要求新增。
 *
 * ★ 原版全文只有这么点东西：
 *
 *     P.Plot.AssaultDirection = function(points){
 *         goog.base(this, []);
 *         this.type = P.PlotTypes.ASSAULT_DIRECTION;
 *         this.tailWidthFactor = 0.2;
 *         this.neckWidthFactor = 0.25;
 *         this.headWidthFactor = 0.3;
 *         this.headAngle = Math.PI / 4;
 *         this.neckAngle = Math.PI * 0.17741;
 *         this.setPoints(points);
 *     };
 *     goog.inherits(P.Plot.AssaultDirection, P.Plot.FineArrow);
 *
 *   —— **它就是「细直箭头」换五个比例因子**，`generate` / `fixPointCount = 2` /
 *   退化分支全部继承自 `FineArrow`，几何一行没动。
 *   ⇒ 所以这里**也照原版那样继承**：`AssaultDirectionShape extends FineArrowShape`，
 *     只覆盖 `factors()`（外加 key / label / hint）。几何仍留在 `fine-arrow.ts`
 *     （那份与 FineArrow 原版逐点 Hausdorff ≤ 8.04e-14px，含 y 轴翻面），
 *     这里**不再抄一份**，免得同一条手性算式有两处会各自漂移。
 *
 * ## 与「细直箭头」的差别（就是那五个数）
 *
 * | 因子 | 细直箭头 | 突击方向 |
 * |---|---|---|
 * | `tailWidthFactor` | 0.15 | **0.2** |
 * | `neckWidthFactor` | 0.2 | **0.25** |
 * | `headWidthFactor` | 0.25 | **0.3** |
 * | `headAngle` | `π/8.5` | **`π/4`** |
 * | `neckAngle` | `π/13` | **`π × 0.17741`** |
 *
 * ⇒ 直观效果：箭身更鼓、倒刺张得更开、箭头更宽 —— 与原版「突击方向」一致。
 * ★ 仍然是 **7 点闭合多边形**、仍然要 **y 轴取反**（继承 `_ring`，原版有手性分支）。
 *
 * ★ **存储顶点＝用户点的 2 个点**（形状只在渲染期算，不写回 `pts`）。
 * ★ **顶点圆点不要在这里画**（见 AGENTS 4 节）；绘制中的落点除外。
 * ===================================================================== */
import { MapboxSketch } from '../sketch';
import { FineArrowShape, type FineArrowFactors } from './fine-arrow';

/** 原版 `AssaultDirection` 构造函数的五个因子（其余全继承 `FineArrow`） */
const ASSAULT_DIRECTION_FACTORS: FineArrowFactors = {
  tailWidthFactor: 0.2,
  neckWidthFactor: 0.25,
  headWidthFactor: 0.3,
  headAngle: Math.PI / 4,
  neckAngle: Math.PI * 0.17741,
};

export class AssaultDirectionShape extends FineArrowShape {
  get key(): string { return 'assaultDirection'; }
  get label(): string { return '突击方向标注'; }

  /** 只换五个比例因子，几何仍走 `FineArrowShape._ring`（含 y 轴翻面） */
  protected factors(): FineArrowFactors { return ASSAULT_DIRECTION_FACTORS; }

  get hint(): string {
    return '⇛ 绘制<b>突击方向标注</b>：单击定<b>箭尾</b> → 移动鼠标把<b>箭头尖端</b>摆到位 → '
      + '第二次单击完成（两击即成）<br />'
      + '・轮廓与「细直箭头标注」是同一套几何，只是箭身更鼓、倒刺更开、箭头更宽（原版就是继承细直箭头换五个比例）<br />'
      + '・落的两点都在轮廓上，编辑时拖它们改形状　・<b>Esc</b>＝取消';
  }
}

/* 自注册：import 本文件即把类型收进静态注册表 */
MapboxSketch.registerType(AssaultDirectionShape);
