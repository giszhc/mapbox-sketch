/* =====================================================================
 * shapes/free-area.ts —— 内置类型：FreeAreaShape「自由面标注」。
 *
 * 自由面：**在地图上单击起点，移动鼠标描摹，再单击一次完成** —— 圈出一块区域，
 * 末点自动连回首点闭合成面。区别于「多边形标注」要在每个角上单击一次、双击收尾 ——
 * 这一块是「随手圈一块」，角点不由用户显式指定。
 *
 * ★ 手势是**引擎级**能力，本文件没有任何事件代码：类型只需声明 `freehand = true`，
 *   引擎就把「第一击起笔 / 移动采样 / 第二击成图」那套接上（见 `sketch.ts` 的 `_beginBrush`）。
 *   闭合由 `closesRing = true` 交给引擎与渲染两端（提交前去掉重复的末点、渲染时补回首点）。
 *
 * ★ 顶点分两步得到，别把两件事混起来：
 *   · **采样**（引擎，`FREEHAND_MIN_PX = 3px`）：保证不漏掉手上的动作；
 *   · **抽稀**（本文件 `normalize()` → `simplifyFreehand`）：保证别存一堆没用的点。
 *
 * 渲染与「多边形标注」完全一致（淡面填充 + 闭合轮廓，不写面积周长）。
 * ===================================================================== */
import { fillRing, lineDashFor, strokePolyline } from '../paint';
import { MapboxSketch } from '../sketch';
import { MapboxShapeType } from '../sketch-shape-type';
import { previewFreehand, simplifyFreehand } from './helpers';
import type { CfgKey, DrawSession, LngLat, Shape } from '../types';

export class FreeAreaShape extends MapboxShapeType {
  get key(): string { return 'freeArea'; }
  get label(): string { return '自由面标注'; }
  get minPts(): number { return 3; }            // 少于此数连不成一块面
  get closesRing(): boolean { return true; }

  /** ★ 声明走自由手绘：引擎据此换上「单击起点 → 移动描摹 → 再单击完成」那套手势 */
  get freehand(): boolean { return true; }

  cfgKeys(): CfgKey[] { return ['showLine']; }  // 同「多边形标注」：可只留填充、不画轮廓

  get hint(): string {
    return '✍ 绘制<b>自由面标注</b>：在地图上<b>单击起点</b>，然后<b>移动鼠标描摹</b>圈出一块区域，'
      + '<b>再次单击即完成</b>（末点自动连回首点）<br />'
      + '・全程<b>不用按住鼠标</b>　・<b>Esc</b>＝取消<br />'
      + '・画完后选中它即可拖动各顶点微调，面形实时跟着变';
  }

  describe(shape: Shape): string {
    return `${this.label} · ${shape.pts.length} 顶点`;
  }

  /** 落点完成后的抽稀：把采样出来的几百个点碾到「偏离不超过 1.5px」 */
  normalize(raw: LngLat[]): LngLat[] {
    return simplifyFreehand(this, raw);
  }

  /** 已提交的自由面：淡面填充 + 闭合轮廓（纯区域，不带文字数字） */
  render(shape: Shape): void {
    const ctx = this.ctx;
    const st = this.styleFor(shape);
    const cfg = shape.cfg;
    if (shape.pts.length < 3 || !ctx) return;

    const ring = this.projectPts(shape);          // 屏幕顶点（走投影缓存）
    fillRing(ctx, ring, st.polygonFill);          // 1) 面内淡填充（画在轮廓线之下）
    // 2) 闭合轮廓线（可隐藏）—— 末点连回首点由这里补，存储的顶点里没有那个重复点
    if (cfg.showLine !== false) {
      strokePolyline(ctx, ring.concat([ring[0]]), st.pathColor, st.pathWidth, lineDashFor(st.lineType, st.pathWidth), st.lineOpacity);
    }

    // ★ 顶点圆点不画（同「多边形标注」）：面的轮廓自己就说清了形状，
    //   而手绘的顶点有几十上百个，画出来是一圈蓝点糊在边上。
  }

  /** 手绘预览：实线笔迹 + ≥3 点时先铺上淡填充（收笔后会怎么填，画的时候就看得见） */
  preview(draw: DrawSession): void {
    previewFreehand(this, draw, true);
  }
}

/* 自注册：import 本文件即把类型收进静态注册表（见 registry.ts） */
MapboxSketch.registerType(FreeAreaShape);
