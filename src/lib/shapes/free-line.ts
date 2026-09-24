/* =====================================================================
 * shapes/free-line.ts —— 内置类型：FreeLineShape「自由线标注」。
 *
 * 自由线：**在地图上单击起点，移动鼠标描摹，再单击一次完成** —— 光标走过哪儿线就长在
 * 哪儿。区别于「折线标注」要在每个拐点上单击一次、双击收尾 —— 这条线是「随手一笔」，
 * 拐点不由用户显式指定。
 *
 * ★ 手势是**引擎级**能力，本文件没有任何事件代码：类型只需声明 `freehand = true`，
 *   引擎就把「第一击起笔 / 移动采样 / 第二击成图」那套接上（见 `sketch.ts` 的 `_beginBrush`）。
 *   对这条类型：双击、右键撤销全部不生效，起笔到收笔之间地图平移被锁住、也不吸附。
 *
 * ★ 顶点分两步得到，别把两件事混起来：
 *   · **采样**（引擎，`FREEHAND_MIN_PX = 3px`）：保证不漏掉手上的动作；
 *   · **抽稀**（本文件 `normalize()` → `simplifyFreehand`）：保证别存一堆没用的点。
 *
 * 与「折线标注」的渲染完全一致（纯线条、不带文字刻度）—— 区别只在**怎么得到顶点**。
 * ===================================================================== */
import { lineDashFor, strokePolyline } from '../paint';
import { MapboxSketch } from '../sketch';
import { MapboxShapeType } from '../sketch-shape-type';
import { previewFreehand, simplifyFreehand } from './helpers';
import type { CfgKey, DrawSession, LngLat, Shape } from '../types';

export class FreeLineShape extends MapboxShapeType {
  get key(): string { return 'freeLine'; }
  get label(): string { return '自由线标注'; }
  get minPts(): number { return 2; }
  get closesRing(): boolean { return false; }

  /** ★ 声明走自由手绘：引擎据此换上「单击起点 → 移动描摹 → 再单击完成」那套手势 */
  get freehand(): boolean { return true; }

  cfgKeys(): CfgKey[] { return []; }           // 自由线：仅一条线，无可调开关

  get hint(): string {
    return '✎ 绘制<b>自由线标注</b>：在地图上<b>单击起点</b>，然后<b>移动鼠标描摹</b>，'
      + '光标走过哪儿线就长在哪儿，<b>再次单击即完成</b><br />'
      + '・全程<b>不用按住鼠标</b>　・<b>Esc</b>＝取消<br />'
      + '・画完后选中它即可拖动各顶点微调，线条实时跟着变';
  }

  describe(shape: Shape): string {
    return `${this.label} · ${shape.pts.length} 点`;
  }

  /** 落点完成后的抽稀：把采样出来的几百个点碾到「偏离不超过 1.5px」 */
  normalize(raw: LngLat[]): LngLat[] {
    return simplifyFreehand(this, raw);
  }

  /** 已提交的自由线：只有一条圆头折线（顶点圆点同「折线标注」—— 编辑态才由手柄出现） */
  render(shape: Shape): void {
    const ctx = this.ctx;
    const st = this.styleFor(shape);
    if (shape.pts.length < 2 || !ctx) return;
    strokePolyline(ctx, this.projectPts(shape), st.pathColor, st.pathWidth, lineDashFor(st.lineType, st.pathWidth), st.lineOpacity);
  }

  /** 手绘预览：实线笔迹（不画落点圆点 —— 采样点 3px 一个，画点就成毛虫了） */
  preview(draw: DrawSession): void {
    previewFreehand(this, draw, false);
  }
}

/* 自注册：import 本文件即把类型收进静态注册表（见 registry.ts） */
MapboxSketch.registerType(FreeLineShape);
