/* =====================================================================
 * measure.ts —— MapboxSketchMeasure「测量工具」。
 *
 * 一个开箱即用的测量门面：不碰引擎的类型注册表、不造 UI 面板，
 * 内部自持一个**独立的** MapboxSketch 实例（与调用方自己的标注引擎互不相干，
 * 各有各的画布与图形表），复用内置的「距离标注 / 面积标注」两种类型：
 *
 *   import { MapboxSketchMeasure } from '@giszhc/mapbox-sketch';
 *   const measure = new MapboxSketchMeasure(map);
 *   measure.distance();   // 开始测距（单击落点，双击/回车完成）
 *   measure.area();       // 开始测面
 *   measure.clear();      // 清空全部测量结果（工具保留，可继续测）
 *   measure.destroy();    // 销毁（移除画布与事件，地图不受影响）
 *
 * 为什么是「包一层」而不是塞进 MapboxSketch：
 *   测量是「临时工具」的典型形态 —— 要跟页面里已有的标注引擎同时存在、
 *   互不污染对方的图形表与样式。独立实例天然做到这一点；两个实例共用
 *   一张地图时的指针冲突，由 MapboxSketch.setInteractive() 解决
 *   （测量开始时让宿主调用方把主引擎 setInteractive(false)，见 demo）。
 *
 * ★ 只从主出口 `@giszhc/mapbox-sketch` 导出，不进 `core`：它依赖内置的
 *   'distance' / 'area' 两个类型，而类型注册靠 shapes/ 的自注册副作用，
 *   core 出口没有它们。
 * ===================================================================== */
import { MapboxSketch } from './sketch';
import { MeasureAreaShape, MeasureDistanceShape } from './measure-shapes';
import type {
  MapboxMap, MeasureKind, Shape, SnapOptions, Style, StylePatch,
} from './types';

/** 测量文字描边的默认颜色：黑 —— 在影像底图上白描边反而吃掉笔画 */
export const MEASURE_HALO_COLOR = '#000000';

/** 测量文字的默认填充色：白（配黑描边），标注引擎的蓝色文字不受影响 */
export const MEASURE_TEXT_COLOR = '#ffffff';

/** `new MapboxSketchMeasure(map, options)` 的选项 */
export interface MeasureOptions {
  /** 测量结果的初始样式，合并到出厂默认之上（测量的样式是全局统一的一份） */
  style?: StylePatch;
  /** 手绘落点吸附（同引擎级能力）；不传 = 开启 + 12px 容差 */
  snap?: SnapOptions;
  /** 状态每次变化后回调（开始/结束测量、出结果、清除），供外部 UI 同步 */
  onChange?: () => void;
  /** 非致命提示（如点数不足），参数为字符串 */
  onWarn?: (msg: string) => void;
}

export class MapboxSketchMeasure {
  /** 内部持有的独立引擎实例。测量的一切都委托给它 */
  private _tool: MapboxSketch;

  /**
   * @param map   已加载完成的 mapboxgl.Map 实例
   * @param options 见 {@link MeasureOptions}
   */
  constructor(map: MapboxMap, options: MeasureOptions = {}) {
    this._tool = new MapboxSketch(map, {
      // 测量的文字配色出厂即「白字黑边」（只影响测量实例；想换色用 options.style
      // 或 setStyle 覆盖）。vertexColor 管测距的里程文字，areaColor 管测面的边长 /
      // 面积 / 周长 —— 两个键写齐才是「测量的文字」这个整体
      style: {
        haloColor: MEASURE_HALO_COLOR,
        vertexColor: MEASURE_TEXT_COLOR,
        areaColor: MEASURE_TEXT_COLOR,
        ...options.style,
      },
      snap: options.snap,
      onChange: options.onChange,
      onWarn: options.onWarn,
      // 测量不画密集刻度：量算读数就在拐点 / 边中点旁，刻度只会把线弄毛。
      // 标注引擎不受影响 —— 那边保持出厂的 ticks:true（见 types.ts 的 Cfg.ticks）
      defaultCfg: { ticks: false },
    });
    // 换上测量的文字变体（见 measure-shapes.ts）：
    //   测距 —— 起点「开始」、终点「总长：…」；测面 —— 边长加「边长：」前缀。
    // 实例级 addType，不碰静态注册表 —— 标注引擎的「距离标注 / 面积标注」原样不动
    this._tool.addType(MeasureDistanceShape);
    this._tool.addType(MeasureAreaShape);
  }

  /* ================================================================
   * 公开 API
   * ================================================================ */

  /**
   * 开始【测距】：单击地图依次落点，双击 / 回车完成，右键撤销上一点，Esc 取消。
   * 起点标「开始」，中间拐点标累计里程，终点标「总长：xx米 / xx公里」（单位自适应），
   * 文字黑描边。不画密集刻度。
   *
   * 若当前正在测面，会自动切到测距（进行中的测面预览作废，已出的结果不受影响）。
   */
  distance(): void {
    this._tool.draw('measureDistance');
  }

  /**
   * 开始【测面】：单击落点自动闭合，双击 / 回车完成。每条边中点标
   * 「边长：xx米 / xx公里」（单位自适应），形心标面积 / 周长，白字黑边，无刻度。
   *
   * 若当前正在测距，会自动切到测面（同上，已出的结果不受影响）。
   */
  area(): void {
    this._tool.draw('measureArea');
  }

  /**
   * 取消进行中的测量（Esc 同义）。**已出的测量结果保留**。
   * 没有进行中的测量时是安全的空操作。
   */
  cancel(): void {
    this._tool.cancel();
  }

  /** 清空全部测量结果。工具本身保留，可继续 distance() / area() */
  clear(): void {
    this._tool.clear();
  }

  /**
   * 销毁测量工具：移除画布与全部事件监听、恢复地图双击缩放。
   * 调用后本工具不可再用（地图不受影响）。
   */
  destroy(): void {
    this._tool.destroy();
  }

  /**
   * `destroy()` 的别名 —— 「destory」是个高频手误，历史上不少库用户会打错。
   * 保留这个拼写让写错的调用照常工作；新代码请用 destroy()。
   */
  destory(): void {
    this.destroy();
  }

  /** 动态改测量结果的全局样式（如主题色、线宽）；合并进全局表并立即重绘 */
  setStyle(patch: StylePatch): void {
    this._tool.setStyle(patch);
  }

  /** 测量当前生效的完整全局样式（只读副本） */
  getStyle(): Style {
    return this._tool.getStyle();
  }

  /**
   * 当前进行中的测量类型；没有进行中的测量时为 null。
   * 外部 UI 据此高亮「测距 / 测面」按钮。
   */
  isMeasuring(): MeasureKind | null {
    if (this._tool.destroyed) return null;
    const t = this._tool.isDrawing();
    if (t === 'measureDistance') return 'distance';
    return t === 'measureArea' ? 'area' : null;
  }

  /** 已出的测量结果（只读快照数组） */
  get results(): Shape[] {
    return [...this._tool.shapes.values()];
  }

  /** 已出的测量结果条数（外部 UI 据此启用 / 置灰「清除」按钮） */
  get count(): number {
    return this._tool.shapes.size;
  }

  /** 是否已销毁 */
  get destroyed(): boolean {
    return this._tool.destroyed;
  }

  /**
   * 内部引擎实例（高级用法逃生口：focus / exportJSON / addType 自定义类型等）。
   * ★ 拿到它之后不要 draw() 别的图形类型 —— 那会破坏「这里只有测量结果」的约定。
   */
  get engine(): MapboxSketch {
    return this._tool;
  }
}
