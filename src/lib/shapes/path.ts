/* =====================================================================
 * shapes/path.ts —— 内置类型：PathShape「路径文字」。
 *
 * 路径文字：一条可平滑的折线 + 沿线平均分布中文文字（spread 铺满 / tight
 * 紧凑字距）+ 可选途经点短标注。为保持图面干净，本类型【不】画等距竖刻度、
 * 也不在折点处标累计距离（刻度与逐点距离由「距离标注 / 面积标注」承担）。
 *
 * ★ 本文件同时是「新类型」的模板范例：继承 MapboxShapeType，实现
 *   key / label / minPts / closesRing / cfgKeys / hint / render / preview，
 *   最后调 MapboxSketch.registerType(类)。
 *   以后新增类型照抄本文件即可，无需改动主类（详见根目录 AGENTS.md）。
 * ===================================================================== */
import { buildArc, cssFont, smoothPolyline, smoothStepM } from '../math';
import { dnNormal, lineDashFor, measureTextCached, paintCharRun, rotText, strokePolyline } from '../paint';
import { MapboxSketch } from '../sketch';
import { MapboxShapeType } from '../sketch-shape-type';
import { previewPolyline } from './helpers';
import type { CharRunItem } from '../paint';
import type { CfgKey, DrawSession, Shape } from '../types';

export class PathShape extends MapboxShapeType {
  get key(): string { return 'path'; }
  get label(): string { return '路径文字'; }
  get minPts(): number { return 2; }
  get closesRing(): boolean { return false; }

  cfgKeys(): CfgKey[] {
    return ['text', 'spread', 'smooth', 'showLine', 'showNodes', 'nodes'];
  }

  get hint(): string {
    return '🖊 绘制<b>路径文字</b>：单击地图依次落点，沿线文字实时分布<br />'
      + '・<b>双击</b> 或按 <b>回车</b>＝完成　・<b>右键</b>＝撤销上一点　・<b>Esc</b>＝取消';
  }

  /** 平滑曲线会稍微鼓出顶点连线之外，剔除时留一点余量 */
  cullMargin(): number { return 20; }

  describe(shape: Shape): string {
    return `${shape.cfg.text || '（无文字）'} · ${shape.pts.length} 点`;
  }

  /**
   * 已提交路径文字：轮廓线 + 途经点 + 沿线平均分布文字。
   *
   * ★ 这里**不画**顶点圆点。路径文字的落点密、又铺着一串沿线文字，常驻圆点会把
   *   图面糊掉。要看拐点在哪，点击图形进编辑态即可 —— 引擎会自己叠一层可拖动的
   *   顶点手柄（`_drawHandles`），那才是「拐点」该出现的时候。
   */
  render(shape: Shape): void {
    const ctx = this.ctx;
    const st = this.styleFor(shape);   // 全局样式 + 该图形自己覆盖的样式（只读）
    const cfg = shape.cfg;
    const orig = shape.pts;
    if (orig.length < 2 || !ctx) return;

    // 1) 平滑或直连 → 经纬度折点 → 屏幕坐标 → 弧长参数化（文字定位需要弧长）
    //    不平滑时直接用存储顶点，不必先拷贝一份
    const rawV = this.projectPts(shape);   // 原始顶点（途经点锚点 + 量比例尺；走投影缓存）
    const geo = cfg.smooth ? smoothPolyline(orig, smoothStepM(orig, rawV)) : orig;
    const Pts = geo.map((g) => this.project(g));
    const arc = buildArc(Pts);
    if (!arc) return;

    // 2) 轮廓线（可选隐藏：只留文字浮在地图上方）
    if (cfg.showLine !== false) {
      strokePolyline(ctx, Pts, st.pathColor, st.pathWidth, lineDashFor(st.lineType, st.pathWidth), st.lineOpacity);
    }

    // 3) 途经点短标注：锚定原始顶点、沿该处切线旋转浮在线侧（需 showNodes + nodes）
    if (cfg.showNodes && cfg.nodes && cfg.nodes.length && rawV.length) {
      cfg.nodes.forEach((txt, i) => {
        if (i >= rawV.length || txt == null || txt === '') return;
        const p = rawV[i];
        const nxt = rawV[i + 1] || rawV[i];
        const prv = rawV[i - 1] || rawV[i];
        let ang = i < rawV.length - 1
          ? Math.atan2(nxt.y - p.y, nxt.x - p.x)
          : Math.atan2(p.y - prv.y, p.x - prv.x);
        // ★ 同上：短标注也按「屏幕上朝左就把整条翻 180°」归一，否则地图一转标签就倒过来
        if (Math.cos(ang) < 0) ang += Math.PI;
        const n = dnNormal(ang);
        rotText(ctx, p.x + n.x * 11, p.y + n.y * 11, ang, txt, {
          size: 13, fill: st.nodeColor, halo: st.haloColor, width: st.haloWidth,
        });
      });
    }

    // 4) 沿线平均分布文字（spread 平均铺满 / tight 紧凑自然字距）
    //
    // 分两步：先把每个字画在哪儿全算出来（位置只依赖字宽与弧长），再整串交给
    // `paintCharRun` 一次画完。逐字各调一次 paintChar 的话，那些「整串都一样」的
    // canvas 状态（字号 / 线宽 / 字色 / 描边色…）会被重复设 7 遍 —— 这里是每帧的
    // 热路径，一帧上千个字，省下的就是上千次冗余赋值。
    const text = (cfg.text || '').trim();
    if (!text) return;
    const chars = Array.from(text);
    const size = st.textSize;
    const FONT = cssFont(size);
    const natural = chars.map((c) => measureTextCached(ctx, c, FONT));
    const spread = cfg.spread === 'spread';
    const total = arc.total;
    const run: CharRunItem[] = [];
    /** 记下第 i 个字画在弧长 p 处 */
    const put = (i: number, p: { x: number; y: number; ang: number }) => {
      run.push({ ch: chars[i], x: p.x, y: p.y, ang: p.ang });
    };

    if (spread) {
      /* ---- 平均铺满全线：字按自然宽排布，多余空隙均匀分到字间，
       *      首字左缘贴线头、末字右缘贴线尾，无头尾空。 ---- */
      const n = chars.length;
      const sumW = natural.reduce((a, b) => a + b, 0);
      if (n === 1) {
        put(0, arc.at(total / 2));
      } else if (sumW >= total) {
        // 字太多放不下：退回等步长重叠铺（保头尾不越界）
        const step = total / n;
        for (let i = 0; i < n; i++) put(i, arc.at((i + 0.5) * step));
      } else {
        const gapEach = (total - sumW) / (n - 1);     // 均匀插到字与字之间
        let x = 0;                                     // 每个字左缘的弧长位置
        for (let i = 0; i < n; i++) {
          put(i, arc.at(x + natural[i] / 2));
          x += natural[i] + gapEach;
        }
      }
    } else {
      /* ---- 紧凑自然字距：字间距 = 自然字宽，整串居中放在线中央 ---- */
      const sumW = natural.reduce((a, b) => a + b, 0);
      if (sumW <= 0) return;
      const base = (total - sumW) / 2;                 // 串首在弧长上的位置（居中）
      let acc = 0;
      for (let i = 0; i < chars.length; i++) {
        const center = acc + natural[i] / 2;
        acc += natural[i];
        put(i, arc.at(base + center));
      }
    }
    // ★ 可读性归一（2026-09-18 修）：地图一旋转，同一条路径在屏幕上可能变成「从右往左」，
    //   此时切线角跑到 ±180° 附近 —— 字形会**上下颠倒**、整串还读成反的（用户实测：
    //   「旋转后文字会跟着线跑，文字还会变成反的」）。
    //   修法：整串按位置**反着配字**（第 i 个位置放第 n−1−i 个字）并给每个字转 180°，
    //   于是屏幕上依旧是「从左往右读、字是正的」。判据取**这串字自己中段**的切线方向
    //   （`cos < 0` 即屏幕上朝左），所以一条拐回去的路径上，两段文字各自正着。
    if (run.length) {
      const mid = run[run.length >> 1];
      if (Math.cos(mid.ang) < 0) {
        const shown = run.map((c) => c.ch).reverse();
        for (let i = 0; i < run.length; i++) {
          run[i] = {
            ch: shown[i], x: run[i].x, y: run[i].y, ang: run[i].ang + Math.PI,
          };
        }
      }
    }
    paintCharRun(ctx, run, { fill: st.textColor, halo: st.haloColor, size, width: st.haloWidth });
  }

  /** 手绘预览：虚线折线 + 落点圆点 */
  preview(draw: DrawSession): void {
    previewPolyline(this, draw);
  }
}

/* 自注册：import 本文件即把类型收进静态注册表（见 registry.ts） */
MapboxSketch.registerType(PathShape);
