/* =====================================================================
 * measure-control.ts —— 地图右下角的「测量」按钮组（demo 专属 UI）。
 *
 * 一个 mapbox IControl：白底圆角小组件，和自带的缩放按钮**同款皮肤** ——
 * 直接借用 mapbox-gl.css 的 .mapboxgl-ctrl-group 样式，自己一个像素都不画。
 * 在 create-map.ts 里它**先于** NavigationControl addControl('bottom-right')，
 * 同一角落的控件按加入顺序从上往下排，所以它恰好落在缩放按钮上方。
 *
 * 按钮只发事件、不持有引擎：测量的启停走 use-sketch.ts 的桥，
 * 本控件只提供 setActive / setHasResults 两个回显口（高亮当前模式、
 * 没结果时「清除」置灰）。
 * ===================================================================== */
import type { IControl } from 'mapbox-gl';
import type { MeasureKind } from '@giszhc/mapbox-sketch';

/** 按钮回调集 */
export interface MeasureControlOptions {
  /** 点「测距」 */
  onDistance(): void;
  /** 点「测面」 */
  onArea(): void;
  /** 点「清除」 */
  onClear(): void;
}

/** 内联 SVG 图标（stroke 跟 currentColor 走，active 反色自动成立） */
const ICON_DISTANCE =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 16.5 16.5 3.5l4 4L7.5 20.5z '
  + 'M8.2 11.8l2 2 M11.2 8.8l2 2 M14.2 5.8l2 2" fill="none" stroke="currentColor" '
  + 'stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"/></svg>';
const ICON_AREA =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.2 19.8 8v8L12 20.8 4.2 16V8z '
  + 'M12 3.2v17.6 M4.2 8 12 12l7.8-4 M12 12v8.8" fill="none" stroke="currentColor" '
  + 'stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" opacity="0.9"/></svg>';
const ICON_CLEAR =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 7h15 M9.5 7V4.8h5V7 '
  + 'M6.5 7l1 13h9l1-13 M10 10.8v5.4 M14 10.8v5.4" fill="none" stroke="currentColor" '
  + 'stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"/></svg>';

export class MeasureControl implements IControl {
  private _container: HTMLElement | null = null;
  private _btnDistance: HTMLButtonElement | null = null;
  private _btnArea: HTMLButtonElement | null = null;
  private _btnClear: HTMLButtonElement | null = null;

  constructor(private readonly o: MeasureControlOptions) {}

  /** `IControl.onAdd(map)` 的地图参数这里用不上：三个按钮都只发事件，不读地图状态 */
  onAdd(): HTMLElement {
    const group = document.createElement('div');
    group.className = 'mapboxgl-ctrl mapboxgl-ctrl-group measure-ctrl';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', '测量工具');

    const mk = (title: string, icon: string, cb: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.title = title;
      b.setAttribute('aria-label', title);
      b.innerHTML = icon;
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        cb();
      });
      group.appendChild(b);
      return b;
    };
    this._btnDistance = mk('测距：单击地图依次落点，双击或回车完成', ICON_DISTANCE, this.o.onDistance);
    this._btnArea = mk('测面：单击地图圈一个区域，双击或回车完成', ICON_AREA, this.o.onArea);
    this._btnClear = mk('清除全部测量结果', ICON_CLEAR, this.o.onClear);

    this._container = group;
    return group;
  }

  onRemove(): void {
    this._container?.remove();
    this._container = null;
    this._btnDistance = this._btnArea = this._btnClear = null;
  }

  /** 高亮当前测量模式；null = 都不亮（测量结束） */
  setActive(kind: MeasureKind | null): void {
    this._btnDistance?.classList.toggle('measure-btn-active', kind === 'distance');
    this._btnArea?.classList.toggle('measure-btn-active', kind === 'area');
  }

  /** 有没有测量结果（没有时「清除」置灰） */
  setHasResults(has: boolean): void {
    if (this._btnClear) this._btnClear.disabled = !has;
  }
}
