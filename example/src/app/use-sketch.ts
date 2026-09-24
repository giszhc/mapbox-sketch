/* =====================================================================
 * use-sketch.ts —— 引擎 ↔ Vue 响应式之间的唯一桥。
 *
 * 为什么不把引擎塞进 reactive：
 *   引擎内部是命令式的（Map + 自己持有的 Shape 对象），一旦被 Vue 深度代理，
 *   性能会塌方、而且代理后的对象与引擎内部引用脱钩，拖拽/渲染都会出问题。
 *   所以引擎实例一律放 `shallowRef`（不代理），
 *   面板读取走「版本号 + 快照」：onChange 里 `version.value++`，
 *   computed 里先读一下 version 建立依赖，再生成新的快照数组。
 *
 * 所有面板控件都通过本文件暴露的方法调引擎，组件里不出现引擎实例。
 * ===================================================================== */
import { computed, inject, ref, shallowRef } from 'vue';
import type { ComputedRef, InjectionKey } from 'vue';
import * as prefs from './export-prefs';
import {
  autoPaperGrid, autoViewportGrid, BASE_DPI, DEFAULT_CFG, DEFAULT_STYLE, MapboxSketch,
  MapboxSketchMeasure, MEASURE_TEXT_COLOR, mmToCssPx, PAPER_SIZES, planExport, planExportTiles,
} from '@giszhc/mapbox-sketch';
import type {
  AutoGrid, CfgKey, CfgPatch, ExportImageResult, GeomKey, GeomPatch, ImportResult,
  LngLat, MeasureKind, PaperOrientation, PaperSize, PaperSpec, Shape, SpreadMode, Style, StyleKey,
  StylePatch,
} from '@giszhc/mapbox-sketch';
import type { Map as MapboxMap } from 'mapbox-gl';
import { createExportMap, createMap, readToken, saveToken } from './create-map';
import {
  buildExportZip, buildMergeManifest, downloadBlob, imageFileName, zipBlobs, zipFileName,
} from './file-io';
import { fetchMergeProgress, mergeServiceUrl, uploadZipForMerge } from './merge-service';
import type { MergeProgress } from './merge-service';
import { MeasureControl } from './measure-control';
import { pickImageFile } from './pick-image';
import { fetchBasemaps, makeActive } from './basemap-service';
import { BasemapManager } from './basemap-manager';
import type { BasemapItem, ActiveBasemap } from './basemap-service';
import { cfgGroupsFor, DEMO_CFG, geomGroupsFor, visibleStyleGroups } from './samples';

/** 样式面板的作用对象（`styleTarget` 的快照；模板只读这个，不碰引擎的 Shape 对象） */
export interface StyleTarget {
  id: string;
  type: string;
  /** 类型的中文名（引擎的 typeLabel） */
  label: string;
  /** 一句话描述（引擎的 describe） */
  desc: string;
  /** 这条图形自己改过的样式键 —— 行尾那个 ● */
  overridden: ReadonlySet<StyleKey>;
}

/**
 * 批量（分块）导出里的一块产物。
 *
 * ★ 只回原始数据、**不带文件名**：名字由组件按 `imageFileName()` 生成，与
 *   `exportJSON()`（回文本、PanelFooter 自己拼名字）是同一条分工 —— 桥不碰
 *   「下载」这件浏览器的事，才跑得进 vitest。
 */
export interface ExportBatchTile {
  /** 第几块（0 起，从左到右、从上到下） */
  index: number;
  /** 一共几块 */
  total: number;
  /**
   * 第几列 / 第几行（0 起）。
   *
   * ★ 这两个值**必须从 `planExportTiles()` 原样带出来**，不能让调用方拿 `index`
   *   现算 —— 那就是第二套行列算式（`index = row × cols + col`），哪天行列口径变了
   *   （比如宽高方向反过来）只有一边会跟着改。合并包的说明书里要写 `col`/`row`，
   *   服务端**只**按它们拼图，所以算错的后果是**一张位置错乱、但能正常打开**的图。
   */
  col: number;
  row: number;
  /** 这一块的出图结果（blob / 像素 / dpi，与单张导出同一套） */
  result: ExportImageResult;
}

/** 自动分块的说明（面板文案与纸框共用）：就是库的 `AutoGrid` + 一句块纸型标签 */
export interface ExportGridInfo extends AutoGrid {
  /**
   * 块纸型标签，如 `'A2横'`；**跟随视口时是空串** —— 那里的一块不是一张标准纸，
   * 只是视口的一块，硬安一个纸型名字反而会让人以为每块能单独打印。
   */
  blockLabel: string;
}

/**
 * 一次「导出 + 合并」的结果。
 *
 * ★ 两种结局里**都带着 zip**（失败时是原样落盘的那一份），因为调用方剩下的唯一动作
 *   就是下载：成功下 `blob`，失败下 `zip`。把 zip 在这里一并交出去，调用方就不必
 *   为了「失败时还能下载」而把打包逻辑再放一份到组件里。
 */
export type ExportMergeResult =
  | { ok: true; tiles: number; blob: Blob; filename: string; notice: string; warnings: string }
  | { ok: false; reason: string; zip: Blob; zipName: string };

/** 一个「可编辑的取值」：读＝聚焦图形优先、否则回落到全局默认；写＝写回引擎 */
type Writable<T> = ComputedRef<T> & { value: T };

/**
 * 等待时长 → 中文（`42 秒` / `3 分 5 秒` / `1 小时 12 分`）。
 *
 * ★ 与引擎里那个 `fmtElapsed`（`src/lib/sketch.ts`）**故意各写一份**，不是没找到：
 *   它是引擎的私有内部件（`src/lib/index.ts` 不导出），而「已等时长」这块文案在
 *   服务端合并阶段也要用一遍 —— 合并是 demo 的事，引擎根本不知道有合并这回事。
 *   为一个文案函数把它提到公共 API 上，等于给发布出去的库多开一个口子。
 *   两份的口径由 `test/demo-bridge.spec.ts` 里那组例子钉住（同一组数字，
 *   和引擎用例里用的是同一套），改坏任意一份都会红。
 *
 * ★ 为什么非格式化不可：合并一张 A0 横 @600 是**几分钟**级，而「已等 300 秒」
 *   得在脑子里除一次 60 才知道是五分钟 —— 这行字本来就是在报「还要等多久」。
 *   一小时以上丢掉秒：到那个量级秒数既没人看、又让一个字一直跳，只是噪音。
 *   60 秒以下只报秒（别补成「0 分 42 秒」）：绝大多数导出在两分钟内结束。
 */
export function fmtElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec} 秒`;
  const m = Math.floor(sec / 60);
  if (m < 60) {
    const s = sec % 60;
    return s ? `${m} 分 ${s} 秒` : `${m} 分`;
  }
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h} 小时 ${mm} 分` : `${h} 小时`;
}

export function useSketch() {
  /* ---------------- 引擎与地图 ---------------- */
  /** 地图实例（shallowRef：绝不深度代理第三方对象） */
  const map = shallowRef<MapboxMap | null>(null);
  /** 绘制引擎实例 */
  const tool = shallowRef<MapboxSketch | null>(null);
  /** 状态版本号：引擎每次 onChange 自增，用来给 computed 建立依赖 */
  const version = ref(0);
  /**
   * 窗口尺寸变了也自增一次：地图容器的 CSS 尺寸是 mapbox 自己管的，**Vue 看不见** ——
   * 于是 `viewportSize` 这个 computed 在缩放窗口后会一直返回旧尺寸。
   *
   * 谁在乎：导出面板那行「视口 → 导出 px」的预告，以及屏幕上那圈虚线纸框
   * （它的位置是 `(容器宽 − 纸宽) / 2`，两个数都跟着窗口走）。真正导出用的是引擎
   * 当场读的尺寸，从来不受影响 —— 但这两处显示错了会实打实地误导人。
   *
   * 挂在 `useSketch()` 上（而不是各组件自己挂一份）：这是**同一条**事实，
   * 两个消费者各挂一份就会有一份忘记加。App.vue 里只调一次，生命周期同页面。
   */
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => { version.value += 1; });
  }
  /** 是否有过地图但工具已被销毁（用于列表占位文案） */
  const destroyed = ref(false);

  /* ---------------- 底图（多底图叠加 / 拖拽排序 / 透明度 / 筛选检索） ----------------
   *
   * 数据来自远程接口（basemap-service），图层由 BasemapManager 直接落到 Mapbox。
   * 这里只持有「已叠加列表」与「全量可选列表」两份响应式状态、以及把用户操作翻译
   * 成 Manager 调用的薄方法 —— 不碰地图 API（那部分全在 basemap-manager.ts）。
   *
   * ★ activeBasemaps 的数组顺序 = 叠加顺序（尾部在最上层）。UI 里为了「上层在前」会
   *   把它 reverse 后再渲染，但拖拽 / 透明度改的都是这一份原始顺序。
   */
  /** 全量可选底图（接口拉到后填入） */
  const basemaps = ref<BasemapItem[]>([]);
  /** 已叠加到底图的底图（顺序 = 叠加顺序，尾 = 最上） */
  const activeBasemaps = ref<ActiveBasemap[]>([]);
  const basemapLoading = ref(false);
  const basemapError = ref('');
  /** Mapbox 图层管理器（非响应式：命令式对象，绝不进 Vue 代理） */
  let basemapMgr: BasemapManager | null = null;

  /** 把当前激活列表对账到地图（Manager 未挂上时静默无操作） */
  function applyActive(): void {
    basemapMgr?.setActive(activeBasemaps.value);
  }

  /**
   * 拉取底图列表，并在首次加载时定默认叠加（列表第 6 个：天地图影像 有注记）。
   * 接口带内存缓存，重复调用只请求一次；地图未就绪时只填数据、等 onLoad 再 apply。
   */
  async function loadBasemaps(): Promise<void> {
    basemapLoading.value = true;
    basemapError.value = '';
    try {
      const list = await fetchBasemaps();
      basemaps.value = list;
      if (activeBasemaps.value.length === 0 && list.length > 5) {
        activeBasemaps.value = [makeActive(list[5], 1)];
      }
      applyActive();
    } catch (err) {
      basemapError.value = (err as Error).message || String(err);
    } finally {
      basemapLoading.value = false;
    }
  }

  /** 某个底图是否已叠加 */
  function isActiveBasemap(key: string): boolean {
    return activeBasemaps.value.some((a) => a.key === key);
  }

  /** 切换叠加 / 移除某条底图（已叠加则移除，否则按接口给的 opacity 加上） */
  function toggleBasemap(item: BasemapItem): void {
    const arr = activeBasemaps.value.slice();
    const idx = arr.findIndex((a) => a.key === item.key);
    if (idx >= 0) arr.splice(idx, 1);
    else arr.push(makeActive(item, item.opacity > 0 && item.opacity <= 1 ? item.opacity : 1));
    activeBasemaps.value = arr;
    applyActive();
  }

  /** 直接移除某条已叠加底图 */
  function removeBasemap(key: string): void {
    activeBasemaps.value = activeBasemaps.value.filter((a) => a.key !== key);
    applyActive();
  }

  /** 改某条已叠加底图的透明度（滑块 0–100 → 0–1） */
  function setBasemapOpacity(key: string, op: number): void {
    const a = activeBasemaps.value.find((x) => x.key === key);
    if (!a) return;
    a.opacity = op;
    activeBasemaps.value = activeBasemaps.value.slice(); // 触发响应式
    basemapMgr?.setOpacity(key, op);
  }

  /** 切换某条已叠加底图的显隐（隐藏 = 透明度临时置 0，不丢 stored opacity） */
  function setBasemapHidden(key: string, hidden: boolean): void {
    const a = activeBasemaps.value.find((x) => x.key === key);
    if (!a) return;
    a.hidden = hidden;
    activeBasemaps.value = activeBasemaps.value.slice();
    basemapMgr?.setHidden(key, hidden);
  }

  /**
   * 拖拽改序：把 srcKey 移到 tgtKey 当前的位置（数组内 splice，顺序 = 叠加顺序）。
   * 用 key 而非下标：UI 里是 reverse 后的显示顺序，下标对不上。
   */
  function reorderBasemap(srcKey: string, tgtKey: string): void {
    const arr = activeBasemaps.value.slice();
    const from = arr.findIndex((a) => a.key === srcKey);
    const to = arr.findIndex((a) => a.key === tgtKey);
    if (from < 0 || to < 0 || from === to) return;
    const [m] = arr.splice(from, 1);
    arr.splice(to, 0, m);
    activeBasemaps.value = arr;
    applyActive();
  }

  /** 可选列表里的分类（去重，保持出现顺序） */
  const basemapGroups = computed<string[]>(() => {
    const s = new Set<string>();
    for (const b of basemaps.value) s.add(b.group);
    return [...s];
  });

  /* ---------------- 从引擎同步过来的状态 ---------------- */
  const focusedId = ref<string | null>(null);
  const drawingType = ref<string | null>(null);

  /* ---------------- 测量（独立于上面标注引擎的第二实例） ---------------- */
  /** 测量工具实例（同样是 shallowRef：绝不深度代理） */
  const measure = shallowRef<MapboxSketchMeasure | null>(null);
  /** 当前进行中的测量类型；null = 没在测 */
  const measuringType = ref<MeasureKind | null>(null);
  /** 已出的测量结果条数（「清除」按钮据此置灰 / 启用） */
  const measureCount = ref(0);
  /** 右下角那组测量按钮（地图销毁时随 map.remove() 一起没了，这里只留引用做回显） */
  let measureCtl: MeasureControl | null = null;

  /* ---------------- 界面上要展示的提示 ---------------- */
  /** 右上角错误条内容；空串 = 不显示 */
  const error = ref('');

  function showError(msg: string): void {
    error.value = msg || '';
  }
  function clearError(): void {
    error.value = '';
  }

  /**
   * 引擎状态变化 → 同步到 Vue（构造时作为 onChange 传进去）。
   *
   * ★ 顺带让右侧样式面板「跟着作用对象来去」：换了一条图形就自动滑出来，作用对象没了
   *   （点地图空白退出编辑 / 那条被删了 / 清空）就自动收起。用户点图形本来就是为了改它 ——
   *   还得再回左侧够那个「🎨 样式设置」按钮，是白白多一下。
   *
   *   只在**换人**时动面板：拖手柄、改样式这些回调里作用对象没变，不能把已经 ✕ 关掉的
   *   面板又弹回来（那比不自动弹还烦）。
   *
   *   放在 sync() 而不是散在各个操作里，是因为它对所有来源一视同仁：地图点选、列表里点
   *   「选中」、刚画完一条新图形（push 会把自己设成聚焦）、导入结束后的还原…… 全走这里。
   *
   *   连续调用也是对的：导入 N 条会一路把面板开开关关，而 Vue 的渲染是异步的，
   *   同一个 tick 里只有**最后那次**会真的渲染 —— 不会看到面板闪一下。
   */
  function sync(): void {
    const t = tool.value;
    if (!t) return;
    const f = t.getFocused();
    const id = f ? f.id : null;
    if (id !== focusedId.value) {
      focusedId.value = id;
      styleOpen.value = id !== null;
    }
    drawingType.value = t.isDrawing();
    version.value += 1;
  }

  /* ---------------- 派生状态（只读快照） ---------------- */

  /** 工具是否可用（存在且未销毁） */
  const alive = computed<boolean>(() => {
    const t = tool.value;
    return !!t && !t.destroyed;
  });

  /** 已绘图形快照。★ 只在引擎变化后（version 变了）才重算，不做深度监听 */
  const shapes = computed<Shape[]>(() => {
    version.value; // 建立依赖：引擎 onChange 时自增
    const t = tool.value;
    if (!t) return [];
    return [...t.shapes.values()].map((s) => ({
      ...s,
      pts: s.pts.map((p) => [p[0], p[1]] as LngLat),
      cfg: { ...s.cfg },
    }));
  });

  /** 当前聚焦（选中）的图形快照 */
  const focused = computed<Shape | null>(() => {
    version.value;
    return shapes.value.find((s) => s.id === focusedId.value) || null;
  });

  /** 聚焦图形的类型键（没聚焦时为 null） */
  const focusedType = computed<string | null>(() => (focused.value ? focused.value.type : null));

  /**
   * 取当前默认配置（无聚焦图形时面板回显它）。
   *
   * 工具还没建（首次 mount 之前、或已销毁）时回落到库的出厂默认值 ——
   * 否则面板里所有开关都会读成空串，mount() 又会把它们当成 defaultCfg 传进去，
   * 把 boolean / number 键全部写坏。
   *
   * 回落时再叠一层 demo 自己的初始值（见 samples.ts 的 DEMO_CFG）：这些是旧版
   * 面板控件上写死的初始值，库不认识它们。**必须在 fallback 里叠**，因为 mount()
   * 正是从这里读初值的，而那一刻工具还没建出来。
   */
  function defaults(): Record<CfgKey, unknown> {
    const t = tool.value;
    if (t) return t.getDefaults() as unknown as Record<CfgKey, unknown>;
    return { ...DEFAULT_CFG, ...DEMO_CFG } as unknown as Record<CfgKey, unknown>;
  }

  /**
   * 造一个「读聚焦图形 / 回落到全局默认」的可写取值。
   * @param key      配置键
   * @param onlyType 只在这个类型聚焦时才读图形自己的值（其余情况读默认）
   *
   * 注：引线文字**不用**这个工厂，它有「没有聚焦就显示空」的特殊语义，
   * 见下面单独定义的 `leaderText`。
   */
  function cfgRef<K extends CfgKey>(
    key: K,
    onlyType?: string | string[],
  ): Writable<Shape['cfg'][K]> {
    const types = onlyType == null ? null : (Array.isArray(onlyType) ? onlyType : [onlyType]);
    return computed({
      get: () => {
        version.value;
        const f = focused.value;
        if (f && (!types || types.includes(f.type))) return f.cfg[key];
        return defaults()[key] as Shape['cfg'][K];
      },
      set: (v: Shape['cfg'][K]) => {
        const t = tool.value;
        if (!t) return;
        t.config({ [key]: v } as CfgPatch);
      },
    }) as Writable<Shape['cfg'][K]>;
  }

  /* ---------------- 面板绑定用的可写取值 ---------------- */
  const pathText = cfgRef('text', 'path');
  const spread = cfgRef('spread', 'path');
  const smooth = cfgRef('smooth', 'path');
  const showNodes = cfgRef('showNodes', 'path');
  const showLine = cfgRef('showLine', ['path', 'polygon', 'freeArea', 'circle', 'rect', 'ellipse', 'sector', 'assembly', 'closedCurve', 'doubleArrow', 'fineArrow', 'straightArrow', 'assaultDirection', 'attackArrow', 'tailedAttackArrow', 'squadCombat', 'tailedSquadCombat', 'lune', 'annulus', 'area']);
  /**
   * 引线文字。**语义和别的项不一样，所以不走 `cfgRef`**：它只反映「当前聚焦的
   * 那一条普通引线」，没聚焦引线时显示**空**。
   *
   * 不能回落到全局默认文字 —— 那是「路径文字」用的（默认是「路径文字」这个占位串），
   * 回落到它会让那个已置灰的输入框显示一个跟引线毫无关系的值。新引线的文字也不是
   * 从这里来的，而是 `leader.ts` 自己的 `defaultCfg()`（「引线标注」）。
   *
   * 写回时 `defaults:false`：只改聚焦的那条引线，不污染全局默认文字。
   */
  const leaderText = computed({
    get: () => {
      version.value;
      const f = focused.value;
      return f && f.type === 'leader' ? (f.cfg.text ?? '') : '';
    },
    set: (v: string) => {
      tool.value?.config({ text: v }, { defaults: false });
    },
  });
  /**
   * 文字标注 / 富文本标注的文字（`'text'` / `'richText'` 类型 × `text` 键 ——
   * 名字绕，但这两个撞名是引擎那边定的：类型键，而「写什么」的配置键也叫 `text`）。
   *
   * ★ 两个类型共用一个键，是因为**它们写的是同一件东西**（一串可换行的文字）：
   *   富文本多出来的只是一小撮行内标签（`<b>` / `<s=24>` / `<c=#e03131>` / `<bg=#fff3bf>`…），
   *   那串标签本身就是 `cfg.text` 的内容，另开一个键反而会多出一份要同步的存档字段。
   *
   * 与 `leaderText` **同一套口径、同一套理由**：不走 `cfgRef`（它读不到时回落到全局
   * 默认文字「路径文字」—— 那跟文字标注没有半点关系），写回也带 `defaults:false`
   * （只改聚焦的这一条，不把文案写进被各类型共享的全局默认）。
   * 新画的文字来自 `text.ts` / `rich-text.ts` 各自的 `defaultCfg()`。
   */
  const textText = computed({
    get: () => {
      version.value;
      const f = focused.value;
      return f && (f.type === 'text' || f.type === 'richText') ? (f.cfg.text ?? '') : '';
    },
    set: (v: string) => {
      tool.value?.config({ text: v }, { defaults: false });
    },
  });
  /**
   * 气泡标注的文字（同上面两个的口径）：不走 `cfgRef`（回落到全局默认文字
   * 「路径文字」跟气泡没有半点关系），写回带 `defaults:false`。
   * 新画的气泡的文字来自 `bubble.ts` 自己的 `defaultCfg()`（「气泡标注」）。
   */
  const bubbleText = computed({
    get: () => {
      version.value;
      const f = focused.value;
      return f && f.type === 'bubble' ? (f.cfg.text ?? '') : '';
    },
    set: (v: string) => {
      tool.value?.config({ text: v }, { defaults: false });
    },
  });

  /** 角度 / 长度：引线与坐标引线共用；没聚焦任何图形时可预设给下一个 */
  const leaderAngle = cfgRef('angle', ['leader', 'leaderCoord']);
  const leaderLen = cfgRef('len', ['leader', 'leaderCoord']);

  /* ---------------- 样式面板里的「绘制配置」行 ----------------
   *
   * 与下面那块样式行**并排渲染**（`cfgGroups` 排在 `styleGroups` 前面），但底层是两套东西：
   * 样式行走 `applyStyle`（本图形覆盖），配置行走 `config()`（合并进图型自己的 cfg，
   * 并顺手更新全局默认，好让下一条新图形继承）。
   *
   * ★ 组件只把 `(row.key, 新值)` 丢进来，哪个键有什么讲究**全留在本文件** ——
   *   最典型的是「引线文字」要带 `defaults:false`（见 `leaderText`）：那是引擎侧的规矩，
   *   让面板去记「哪个键特殊」等于把同一件事写两处，早晚对不上。
   */
  const cfgGroups = computed(() => cfgGroupsFor(styleTarget.value?.type ?? null));

  /**
   * 配置行的回显值。`text` 一个键两种语义，按当前聚焦的类型分派 ——
   * 与写回（`setCfgValue`）用的是同一个判据，两边不会跑偏。
   */
  function cfgValueOf(key: CfgKey): unknown {
    version.value; // 建立依赖：同本文件其它 computed，引擎回调过才重算
    switch (key) {
      case 'text':
        // 一个 cfg 键多种语义，按当前聚焦的类型分派 —— 与写回（`setCfgValue`）同一个判据
        if (focusedType.value === 'leader') return leaderText.value;
        // 文字标注与富文本标注共用 `textText`（写的是同一件东西，见那段注释）
        if (focusedType.value === 'text' || focusedType.value === 'richText') return textText.value;
        if (focusedType.value === 'bubble') return bubbleText.value;
        return pathText.value;
      case 'spread':
        return spread.value;
      case 'smooth':
        return smooth.value;
      case 'angle':
        return leaderAngle.value;
      case 'len':
        return leaderLen.value;
      // ↓ 这三个键目前**没有面板行**（`showNodes` / `showLine` 的开关在左侧
      //   「🎛 绘制配置」，`nodes` 是随数据一起来的顶点文字、不给手改），
      //   但仍然登记全 —— 漏一个就是「面板上这一行点了没反应」那种查不出来的坏法，
      //   不值得为了少写三行留个口子。哪天给它们加行，这里不用再动。
      case 'showNodes':
        return showNodes.value;
      case 'showLine':
        return showLine.value;
      case 'nodes':
        return focused.value?.cfg.nodes ?? defaults().nodes;
      case 'ticks':
        // 密集刻度开关（距离 / 面积标注）。面板上没有这一行 —— 测量工具靠
        // defaultCfg { ticks:false } 关、标注引擎保持出厂 true，不给手改入口
        return focused.value?.cfg.ticks ?? defaults().ticks;
      default:
        // ★ 新加 CfgKey 时这里是编译错误，而不是「面板上这一行点了没反应」。
        //   配置行的读写是两张同构的 switch，都得补上（下面那个也一样）。
        return assertCfgKeyHandled(key);
    }
  }

  /**
   * 配置键的穷尽性检查 —— **新加一个 `CfgKey` 而没在上面两个 switch 里登记时，这里编译不过**。
   * 少了它，漏掉的那个键在界面上表现为「面板里这一行点了没反应」，而这跟「这个版本
   * 就长这样」长得一模一样，没人会去报 bug。运行时只有 `any` 之类的漏网之鱼能走到。
   */
  function assertCfgKeyHandled(key: never): never {
    throw new Error(`没有登记的配置键：${String(key)}`);
  }

  /** 配置行的写回（只作用于当前聚焦的那条，理由见本段注释） */
  function setCfgValue(key: CfgKey, v: unknown): void {
    const t = tool.value;
    if (!t) return;
    switch (key) {
      case 'text':
        // ★ 引线 / 文字标注 / 富文本标注 / 气泡的文字都走 `defaults:false`：只改聚焦的
        //   那一条，不把它们的文案写进被各类型共享的全局默认（那会让下一张「路径文字」
        //   沿用引线的文字 / 文字标注的文字）。
        //   路径文字没这个顾虑，照旧连全局默认一起改 —— 与搬过来之前完全一致。
        if (focusedType.value === 'leader' || focusedType.value === 'text'
          || focusedType.value === 'richText' || focusedType.value === 'bubble') {
          t.config({ text: String(v) }, { defaults: false });
        } else t.config({ text: String(v) });
        return;
      case 'spread':
        t.config({ spread: v as SpreadMode });
        return;
      case 'smooth':
        t.config({ smooth: !!v });
        return;
      case 'angle':
        t.config({ angle: Number(v) });
        return;
      case 'len':
        t.config({ len: Number(v) });
        return;
      // 同 `cfgValueOf`：这三个键没有面板行，照样登记全
      case 'showNodes':
        t.config({ showNodes: !!v });
        return;
      case 'showLine':
        t.config({ showLine: !!v });
        return;
      case 'nodes':
        // 顶点文字是一串数组，只认数组（面板上没有这一行，留着给以后可能的批量编辑）
        if (Array.isArray(v)) t.config({ nodes: v.map(String) });
        return;
      case 'ticks':
        // 同上：面板上没有这一行，只为穷举登记（见 cfgValueOf 的 ticks）
        if (typeof v === 'boolean') t.config({ ticks: v });
        return;
      default:
        assertCfgKeyHandled(key);
    }
  }

  /* ---------------- 样式面板里的「几何」行 ----------------
   *
   * 第三套行：改的是**当前选中那条图形的几何**（旋转角度 / 尺寸），走引擎的
   * `getGeom()` / `applyGeom()`。它与上面那两套都不是一回事（见 samples.ts 的 `GeomRow`）：
   * 几何是「此刻摆成什么样」，既不进全局默认（不是 cfg），也没有覆盖 / 恢复默认那一说
   * （不是样式）—— 所以组件那边它既没有行尾那个 ●，也不受「↺ 恢复默认样式」影响。
   */
  const geomGroups = computed(() => geomGroupsFor(styleTarget.value?.type ?? null));

  /**
   * 几何行的回显值。**没有作用对象、或类型没有可调几何时都返回 `null`** ——
   * 后者在界面上表现为这一组不渲染（`geomGroupsFor` 已经筛过），所以这里返回 null
   * 只是「读不到」，不是「要显示 0」：控件那边会把 null 当空值处理，不会把 0 写回去。
   */
  function geomValueOf(key: GeomKey): number | null {
    version.value; // 建立依赖：同本文件其它 computed，引擎回调过才重算
    const t = tool.value;
    const s = t ? t.getFocused() : null;
    if (!t || !s) return null;
    const g = t.getGeom(s.id);
    // `?? null`：`GeomState` 里只有「尺寸本身可调」的类型才给 `sizePx`（见类型定义），
    // 而「读不到」在这里的含义就是「显示空」—— 控件那边把 null 当空值，不会把 0 写回去
    return g ? (g[key] ?? null) : null;
  }

  /**
   * 几何行的写回（只作用于当前聚焦的那条）。
   *
   * ★ 这里**没有** `setCfgValue` 那种 per-key 的 switch 讲究（cfg 的 `text` 要带
   *   `defaults:false` 是有原因的，几何键没有这种事），所以一个 cast 就够 ——
   *   `GeomPatch` 的键全是数字。
   *
   * ★ 「空值」必须显式拦住，不能只靠 `isFinite`：输入框被清空时 el-input-number 给的是
   *   `null`（有时是 `''`），而 **`Number(null)` 和 `Number('')` 都是 `0`** —— 0 在这
   *   几个几何键上是个货真价实的值，于是「清空输入框」会把图片当场转回正放 / 缩到最小。
   *   这类毛病一点错都不报，只表现为「图片自己动了」。（`undefined` 是 NaN，能靠
   *   isFinite 拦住，但 null / '' 拦不住 —— 2026-09-14 就是这么漏过去的。）
   */
  function setGeomValue(key: GeomKey, v: unknown): void {
    const t = tool.value;
    if (!t) return;
    if (v == null || v === '') return;
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    t.applyGeom({ [key]: n } as GeomPatch);
  }

  /* ---------------- 样式（右侧「样式设置」面板） ----------------
   *
   * ★ 这一块**直接问引擎要当前聚焦的那条**（`tool.getFocused()`），而不是用上面的
   *   `focused` / `focusedId` 镜像。两条理由：
   *   1) 面板的每一个动作（改值 / 恢复默认 / 打「已改」标记）都以「引擎此刻聚焦谁」为准，
   *      镜像只是同一次 onChange 的快照，多一层就多一次对不上的机会；
   *   2) 镜像要靠 `sync()` 才更新，而 `sync()` 只有引擎回调时才跑 —— 那样这几个方法
   *      就没法在 vitest 里带着「已选中某条图形」的前提测（见 test/demo-bridge.spec.ts）。
   *   读引擎字段的函数照本文件的老规矩，开头先读一下 `version` 建立依赖
   *   （同 `isHidden`）—— 少了它，切了选中项面板不会重画。
   */

  /** 面板是否展开 */
  const styleOpen = ref(false);

  /**
   * 选中某条图形，并把样式面板展开 —— 「已绘图形」列表里那个「选中」按钮走的就是这里。
   *
   * ★ `id` 是必填的，而且**没有「再点一次＝收起」**（曾经有，那还是它当独立开关按钮时
   *   的手感）：面板自动开合长在 `sync()` 里、只在换人时动，所以「关掉面板 + 仍然选着同一条」
   *   之后，只有这个函数能把它叫回来。做成 toggle 的话，用户点「选中」想找回面板，
   *   结果反而把它关了 —— 这条路就彻底堵死。
   */
  function openStyle(id: string): void {
    const t = tool.value;
    if (!t) {
      showError('请先加载地图后再设置样式。');
      return;
    }
    t.focus(id);
    styleOpen.value = true;
  }

  function closeStyle(): void {
    styleOpen.value = false;
  }

  /**
   * 面板的作用对象 —— 引擎当前聚焦图形的一份**普通快照**。
   * 不返回引擎那个 Shape 本身：它是要被模板读的，而模板里的对象会被 Vue 记进依赖图
   *（同理 `shapes` 快照，见文件头）。`null` = 没有作用对象，面板显示占位。
   */
  const styleTarget = computed<StyleTarget | null>(() => {
    version.value; // 建立依赖：引擎回调过才重算（焦点、样式都要它）
    const t = tool.value;
    const s = t ? t.getFocused() : null;
    if (!t || !s) return null;
    return {
      id: s.id,
      type: s.type,
      label: t.typeLabel(s.type),
      desc: t.describe(s),
      // 这条图形自己改过的键（行尾那个 ●）。空覆盖 `{}` 与 null 一样算「没改过」
      overridden: new Set(Object.keys(s.style || {}) as StyleKey[]),
    };
  });

  /**
   * 面板要回显的「最终生效样式」（全局 + 本图形的覆盖）；没有作用对象时为 `null`。
   *
   * 用引擎的 `effectiveStyle()`（不传 id = 它自己解析当前聚焦）：**只读副本**，
   * 直接拿给控件回显，写回走 `applyStyle`。
   */
  const styleValues = computed<Style | null>(() => {
    version.value;
    const t = tool.value;
    return t && t.getFocused() ? t.effectiveStyle() : null;
  });

  /**
   * 面板此刻真正要渲染的分组 —— **只列当前类型改得动的键**
   * （用不到的键整个不渲染；四个全局项也一概不列 —— 其中悬停高亮色的控件在左侧面板）。
   *
   * 判断本身是纯函数（在 samples.ts，只依赖 `STYLE_APPLIES` 那张表），
   * 这里只负责把「当前作用对象是什么类型」喂给它 —— 而那正是 `styleTarget`，
   * 所以本 computed 依赖 `styleTarget` 就够，不必自己再读一遍 `version`。
   */
  const styleGroups = computed(() => visibleStyleGroups(styleTarget.value?.type ?? null));

  /** 改当前聚焦图形的单个样式键（只影响它自己，同类型其它图形不受影响） */
  function applyStyle(patch: StylePatch): void {
    const t = tool.value;
    const s = t ? t.getFocused() : null;
    if (!t || !s) return;
    t.applyStyle(patch, s.id);
  }

  /** 清掉当前聚焦图形的样式覆盖，恢复跟随全局默认 */
  function resetStyle(): void {
    const t = tool.value;
    const s = t ? t.getFocused() : null;
    if (!t || !s) return;
    t.resetStyle(s.id);
  }

  /**
   * 悬停高亮色（**全局项**，左侧「🎛 绘制配置」那一个控件）。
   *
   * ★ 它和上面那套「只改当前选中那一条」不是一回事：悬停高亮是交互反馈，不是某条标注的
   *   外观，所以引擎**只读全局样式表**，`applyStyle({ hoverColor })` 是静默无效的。
   *   这里读的也必须是全局那一份（`getStyle()`），不能拿 `styleValues`（那是「全局 +
   *   本图形覆盖」的合并结果）。
   *
   * ★ 读引擎而不是在 demo 这边存一份初值：`importJSON()` 会用文件里的全局样式把引擎那份
   *   **整个换掉**，存下来的初值当场变成旧值 —— 界面上会一直显示一个引擎里已经不是的颜色。
   *   老规矩，getter 开头先读 `version` 建立依赖（引擎回调换过全局样式时才会重算）。
   */
  const hoverColor = computed<string>(() => {
    version.value;
    const t = tool.value;
    if (!t || t.destroyed) return DEFAULT_STYLE.hoverColor;
    return t.getStyle().hoverColor;
  });

  /** 改全局悬停高亮色（所有标注一起变） */
  function setHoverColor(v: string): void {
    const t = tool.value;
    if (!t || !v) return;
    t.setStyle({ hoverColor: v });
    version.value += 1;       // setStyle 不回调 onChange，手动刷新一下面板
  }

  /**
   * 主题色（左侧「🎛 绘制配置」的控件）—— **线条与圆点的统一用色**：
   * 线 / 轮廓（pathColor）、点的圆点（pointColor）都从它派生，改一次已画未画的所有图形一起变。
   * ★ **面内填充不跟它走** —— 所有面一律纯黄 30%（`DEFAULT_STYLE.polygonFill`，用户 2026-09-17 口径）。
   *
   * 文字颜色**不跟**主题色走（默认统一蓝，见 DEFAULT_STYLE），悬停高亮 /
   * 吸附记号是交互反馈、也不跟。
   *
   * 读回显以 `pathColor` 为准（主题色就是写进它的），所以导入 JSON
   * 换过全局样式后，拾色器显示的也是文件带来的那份 —— 与 hoverColor 同一套口径：
   * 读引擎而不是在 demo 这边存初值，getter 开头先读 `version` 建立依赖。
   */
  const themeColor = computed<string>(() => {
    version.value;
    const t = tool.value;
    if (!t || t.destroyed) return DEFAULT_STYLE.pathColor;
    return t.getStyle().pathColor;
  });

  /**
   * 改全局主题色：线条（pathColor）+ 圆点（pointColor）一次写齐。
   * ★ 面内填充**不跟主题色走** —— 要求是「所有面一律纯黄 30%」，所以这里不碰 polygonFill。
   * 已画图形里没有单图形覆盖的会跟着变（有覆盖的保持自己的，样式系统本来就是这个优先级）。
   */
  function setThemeColor(v: string): void {
    const t = tool.value;
    if (!t || !v) return;
    t.setStyle({ pathColor: v, pointColor: v });
    version.value += 1;       // setStyle 不回调 onChange，手动刷新一下面板
  }

  /**
   * 全局默认线型（左侧「🎛 绘制配置」的控件）—— 新画 / 没被单图形覆盖的标注都按它画。
   * 读回显以 `lineType` 为准，读引擎而不是在 demo 这边存初值（getter 开头先读 `version` 建立依赖）。
   */
  const defaultLineType = computed<string>(() => {
    version.value;
    const t = tool.value;
    if (!t || t.destroyed) return DEFAULT_STYLE.lineType;
    return t.getStyle().lineType;
  });

  /** 改全局默认线型：所有没被单图形覆盖的标注一起变 */
  function setDefaultLineType(v: string): void {
    const t = tool.value;
    if (!t || !v) return;
    t.setStyle({ lineType: v as never });
    version.value += 1;       // setStyle 不回调 onChange，手动刷新一下面板
  }

  /* ---------------- 图形列表 ---------------- */
  function focus(id: string): void {
    tool.value?.focus(id);
  }
  function remove(id: string): void {
    tool.value?.remove(id);
  }
  function typeLabel(type: string): string {
    return tool.value ? tool.value.typeLabel(type) : type;
  }
  function describe(shape: Shape): string {
    return tool.value ? tool.value.describe(shape) : '';
  }

  /* ---------------- 手绘 ---------------- */
  /** 进入 / 切换 / 取消手绘（再点一次同一类型 = 取消） */
  function toggleDraw(type: string): void {
    const t = tool.value;
    if (!t) {
      showError('请先加载地图后再绘制。');
      return;
    }
    try {
      const cur = t.isDrawing();
      if (cur) t.cancel(); // 无论当前在画哪种，先取消
      if (cur !== type) t.draw(type); // 只对「另一种 / 没在画」才开启
    } catch (err) {
      showError((err as Error).message || String(err));
    }
  }

  /** 某手绘按钮是否处于「正在画这一类」的高亮态 */
  function isDrawing(type: string): boolean {
    return drawingType.value === type;
  }

  /** 当前绘制类型的按键提示（HTML） */
  const drawHint = computed(() => {
    const d = drawingType.value;
    const t = tool.value;
    return d && t ? t.typeHint(d) : '';
  });

  /* ---------------- 测量 ---------------- */
  /**
   * 测量状态同步（测量引擎 onChange 回调走这里）。
   * 除了刷新按钮高亮 / 清除键置灰，还要负责一件事：测量结束的瞬间把指针还给
   * 标注引擎（startMeasure 里被 setInteractive(false) 收走的那份）。
   */
  function syncMeasure(): void {
    const m = measure.value;
    const kind = m && !m.destroyed ? m.isMeasuring() : null;
    measuringType.value = kind;
    measureCount.value = m && !m.destroyed ? m.count : 0;
    measureCtl?.setActive(kind);
    measureCtl?.setHasResults(measureCount.value > 0);
    const t = tool.value;
    if (!kind && t && !t.destroyed && !t.interactive) t.setInteractive(true);
  }

  /** 测量工具是否可用 */
  const measureAlive = computed<boolean>(() => {
    const m = measure.value;
    return !!m && !m.destroyed;
  });

  /**
   * 开始 / 结束一种测量（再点一次进行中的那枚 = 结束，同类型按钮的 toggle 手感）。
   * 开始时把标注引擎 setInteractive(false)：两张画布叠在同一张地图上，
   * 不让出指针的话，测量期间的每次点击会被两套引擎同时解读 —— 点中标注会莫名
   * 进入编辑、Esc 会串台。结束由 syncMeasure 自动还回去。
   */
  function startMeasure(kind: MeasureKind): void {
    const m = measure.value;
    if (!m || m.destroyed) {
      showError('请先加载地图后再测量。');
      return;
    }
    try {
      if (m.isMeasuring() === kind) {
        m.cancel();
      } else {
        const t = tool.value;
        if (t && !t.destroyed && t.interactive) t.setInteractive(false);
        if (kind === 'distance') m.distance();
        else m.area();
      }
    } catch (err) {
      showError((err as Error).message || String(err));
    }
  }

  /** 清空全部测量结果（测量工具保留，可继续测）。按钮在没结果时是置灰的，这里再兜一层 */
  function clearMeasure(): void {
    measure.value?.clear();
  }

  /* -- 测量的全局样式（左侧「🎛 绘制配置」统一设置；测量结果没有单条样式面板） --
   * 口径与标注引擎的 themeColor / setThemeColor 一致：读引擎而不是本地存初值，
   * getter 先读 version 建立依赖；setStyle 不回调 onChange，写完手动 version+1。
   * 「文字色」一个控件同时写 vertexColor（测距的里程）与 areaColor（测面的面积/周长）
   * —— 测量场景里它们就该是一个颜色，分两个控件是给使用者找事。 */

  const measureThemeColor = computed<string>(() => {
    version.value;
    const m = measure.value;
    if (!m || m.destroyed) return DEFAULT_STYLE.pathColor;
    return m.getStyle().pathColor;
  });

  function setMeasureThemeColor(v: string): void {
    const m = measure.value;
    if (!m || m.destroyed || !v) return;
    m.setStyle({ pathColor: v });   // 面内填充固定纯黄 30%，不跟主题色（同 setThemeColor）
    version.value += 1;
  }

  const measureTextColor = computed<string>(() => {
    version.value;
    const m = measure.value;
    if (!m || m.destroyed) return MEASURE_TEXT_COLOR;   // 测量出厂是白字（标注那边才是蓝）
    return m.getStyle().vertexColor;
  });

  function setMeasureTextColor(v: string): void {
    const m = measure.value;
    if (!m || m.destroyed || !v) return;
    m.setStyle({ vertexColor: v, areaColor: v });
    version.value += 1;
  }

  const measureLineWidth = computed<number>(() => {
    version.value;
    const m = measure.value;
    if (!m || m.destroyed) return DEFAULT_STYLE.pathWidth;
    return m.getStyle().pathWidth;
  });

  function setMeasureLineWidth(v: number): void {
    const m = measure.value;
    if (!m || m.destroyed || !isFinite(v)) return;
    m.setStyle({ pathWidth: Math.min(10, Math.max(1, Math.round(v))) });
    version.value += 1;
  }

  /* ---------------- 数据存档（导出 / 导入） ---------------- */
  /**
   * 导入结果的一行摘要（面板里那行小字）；空串 = 不显示。
   *
   * 汇总放在这里而不是组件里：`ImportResult` 是引擎的返回值，怎么把它翻译成人话
   * 属于「桥」的职责，组件只管显示。失败仍然走右上角的 `error` 条，不混进这一行。
   */
  const notice = ref('');

  function clearNotice(): void {
    notice.value = '';
  }

  /** 导入结果 → 一行中文摘要。逐条原因可能几十条，只展开第一条、其余报个数 */
  function summarize(r: ImportResult): string {
    // 套用了文件里的全局样式会连带改掉**已有**图形里没覆盖的那些，必须说出来
    const styleNote = r.styled ? '并套用了文件里的全局样式' : '';
    if (r.added === 0 && r.skipped === 0) {
      return r.styled ? '文件里没有任何图形，已套用它的全局样式。' : '文件里没有任何图形。';
    }
    if (r.added === 0) {
      const why = r.warnings[0] ? `　·　${r.warnings[0]}` : '';
      const note = r.styled ? '（文件里的全局样式已套用）' : '';
      return `一条都没导进来：${r.skipped} 条全被跳过。${note}${why}`;
    }
    const head = `已导入 ${r.added} 条${r.skipped ? `，跳过 ${r.skipped} 条` : ''}${styleNote}。`;
    if (!r.warnings.length) return head;
    const tag = r.warnings.length > 1 ? `提示（共 ${r.warnings.length} 条）` : '提示';
    return `${head}${tag}：${r.warnings[0]}`;
  }

  /** 把当前所有图形导成 JSON 文本；没引擎 / 引擎抛错时返回 `''`（原因走 error 条） */
  function exportJSON(): string {
    const t = tool.value;
    if (!t) {
      showError('请先加载地图后再导出。');
      return '';
    }
    try {
      return t.exportJSON();
    } catch (err) {
      showError((err as Error).message || String(err));
      return '';
    }
  }

  /**
   * 把 JSON 文本交给引擎（**追加合并**，已有一条不动）；没引擎 / 抛错时返回 `null`。
   * 引擎抛的中文消息直接落到 error 条上，不再自己编一遍。
   */
  function importJSON(text: string): ImportResult | null {
    const t = tool.value;
    if (!t) {
      showError('请先加载地图后再导入。');
      return null;
    }
    try {
      const r = t.importJSON(text);
      // 导入成功（哪怕只进来一条）就把地图直接缩放到这批数据的范围：
      // 用户刚灌进来的图形立刻出现在视野里，不用再手动拖找。
      if (r.added > 0) fitToShapes(r.ids);
      notice.value = summarize(r);
      // 导进来了就把上一次的失败提示收掉 —— 摘要里已经说清这次的结果，
      // 右上角还挂着上一份坏文件的报错会让人以为这次也没成
      if (r.added > 0) clearError();
      return r;
    } catch (err) {
      notice.value = '';
      showError((err as Error).message || String(err));
      return null;
    }
  }

  /**
   * 把地图视角缩放到指定一批图形的经纬度范围（导入后自动定位用）。
   *
   * ★ 只框「这批刚导入的」：导入是**追加**语义，已有的图形一个不动，视角也不必被带着
   *   跳到全集 —— 否则导入一个远处的标注会把眼前已画的东西整片推出屏幕。
   *   范围是这批图形**所有顶点**的经纬度最小/最大，正是「数据范围」的字面意思
   *   （文字/圆点等单点图形就是它那个锚点；这跟导出时不另算包络、只取顶点的口径一致）。
   *
   * ★ 退化兜底：这批图形退化成**一个点**或**一条经线/纬线**（bbox 某个方向跨度≈0）时，
   *   直接 `fitBounds` 会把镜头拉到最高 zoom、贴死在那一点上 —— 那不是「看清数据」，
   *   是「放大到失焦」。这种情况退化为「定位到中心 + 一个能看清标注的默认级别」。
   *
   * ★ `duration` 不传 = 用 mapbox 默认缓动：用户说的是「直接缩放」（不需要再手动操作），
   *   不是「无动画瞬移」，平滑过去体验更顺；`padding` 留边让图形不贴边、看得全。
   */
  function fitToShapes(ids: string[]): void {
    const m = map.value;
    const t = tool.value;
    if (!m || !t || ids.length === 0) return;
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    for (const id of ids) {
      const s = t.shapes.get(id);
      if (!s) continue;
      for (const p of s.pts) {
        const lng = p[0];
        const lat = p[1];
        if (lng < minLng) minLng = lng;
        if (lat < minLat) minLat = lat;
        if (lng > maxLng) maxLng = lng;
        if (lat > maxLat) maxLat = lat;
      }
    }
    if (!Number.isFinite(minLng) || !Number.isFinite(minLat)) return;
    // 两个方向都几乎没有跨度 ⇒ 退化（全是点 / 缩成一条线）：定位中心、给个能看清的级别
    if (maxLng - minLng < 1e-9 && maxLat - minLat < 1e-9) {
      m.setCenter([minLng, minLat]);
      if (m.getZoom() > 12) m.setZoom(12);
      return;
    }
    m.fitBounds(
      [[minLng, minLat], [maxLng, maxLat]] as [LngLat, LngLat],
      { padding: 80, maxZoom: 18 },
    );
  }

  /* ---------------- 图片导出 ---------------- */
  /**
   * 正在出图。★ 它是**桥自己**的状态，不是从引擎读的 —— 引擎没有暴露这个开关；
   * 这里要给按钮置灰、给全屏遮罩上 `v-if`，需要一个响应式的值。
   *
   * 也别想从 `error` / `exportNotice` 推：那两者在出图那几秒里还是**上一次**的内容，
   * 拿它们当「正在忙」的判据，遮罩要么不出现、要么上一次导出完就再也不消失。
   */
  const exporting = ref(false);

  /** 出图进度文案（引擎的 `onProgress` 给的中文），显示在全局遮罩上 */
  const exportProgress = ref('');

  /**
   * 出图时的**底图瓦片进度**：已经下了多少块 / 一共多少块（遮罩拿它算百分比、
   * 画那条确定进度条）；`null` = 数不出来。
   *
   * ★ 它是**尽力而为**的：引擎数的真·mapbox-gl 内部那张瓦片表，测试替身 / 样式还没就绪 /
   *   一块瓦片都还没请求时都给不出来。遮罩据此在「确定的条」与「来回跑的不确定条」之间
   *   切换 —— 给不出来的**不是错误**，别拿它去报错，更别拦着导出。
   *
   * 界面上的百分比**只有一处在写**（遮罩那行文案，由引擎给）：这里存的是原始块数，
   * 想改口径（比如换成「还剩几分钟」）在本桥或组件里改成一致的即可。
   */
  const exportTiles = ref<{ loaded: number; total: number } | null>(null);

  /**
   * 出图结果的一行摘要（面板里那行小字）；空串 = 不显示。
   *
   * ★ 和 `notice`（导入摘要）**分开各一个**：两者虽然长得很像，但分别渲染在
   *   「💾 数据」段和「🖼 导出图片」段里。共用一个的话，导出完一行「已导出
   *   4000×2500 px」会出现在「数据」段里，而真正该显示它的那一段是空的 —— 用户
   *   只会觉得「点了没反应，倒是那边冒出来一句不相干的话」。
   */
  const exportNotice = ref('');

  function clearExportNotice(): void {
    exportNotice.value = '';
  }

  const viewportSize = computed<{ w: number; h: number }>(() => {
    version.value; // 建立依赖：本文件所有读引擎/地图状态的 computed 都是这个写法
    const m = map.value;
    const c = m ? m.getContainer() : null;
    return { w: c ? c.clientWidth : 0, h: c ? c.clientHeight : 0 };
  });

  /* ---------------- 纸张（A0–A6）与屏幕上的那圈虚线纸框 ---------------- */

  /** 纸张下拉的取值：`'viewport'` = 跟随视口；`'custom'` = 自定义像素尺寸；其余是 A0–A6 */
  type PaperChoice = PaperSize | 'viewport' | 'custom';

  /**
   * 当前选的纸。默认 **跟随视口**（所见即所得，2026-09-21 用户改）—— 不再默认 A4。
   *
   * ★ 状态放在**桥**里而不是面板组件里：纸框 overlay（App.vue 那一层）与导出面板
   *   要读同一份，各存一份就会「框画的是 A4、导出的是 A3」。
   */
  const exportPaper = ref<PaperChoice>('viewport');
  /** 纸张方向。**跟随视口时无意义**（面板里置灰），但值保留着，切回去还是原来那个 */
  const exportOrientation = ref<PaperOrientation>('portrait');

  /**
   * 自定义纸张的取景范围（CSS 像素）。仅在 `exportPaper === 'custom'` 时生效；
   * 与 A 系纸张同一口径：纸上 1 CSS 像素 = 屏幕 96/25.4 个 CSS 像素的地理范围，与 dpi 无关。
   * 默认 1000×1000（一个不算太大、单块通常能直接出的入门尺寸）。
   */
  const exportCustomW = ref(1000);
  const exportCustomH = ref(1000);

  /** `exportPaper` → 给引擎的 `paper` 选项；跟随视口时是 `null`（= 不传这一项） */
  const exportPaperSpec = computed<PaperSpec | null>(() => {
    const p = exportPaper.value;
    if (p === 'viewport') return null;
    if (p === 'custom') {
      // ★ 自定义尺寸不允许超过 A0：任一边 ≤ A0 长边，且较短边 ≤ A0 短边
      //   （即整张矩形能放进一张 A0 纸，无论横纵）。面板那边已用 `:max` + watch 夹过一次，
      //   这里再夹一遍是兜底（防止程序化改值绕过 UI）。
      const A0_LONG = Math.round(mmToCssPx(1189));
      const A0_SHORT = Math.round(mmToCssPx(841));
      let w = Math.max(1, Math.min(A0_LONG, Number.isFinite(exportCustomW.value) ? exportCustomW.value : 1));
      let h = Math.max(1, Math.min(A0_LONG, Number.isFinite(exportCustomH.value) ? exportCustomH.value : 1));
      if (Math.min(w, h) > A0_SHORT) {
        if (w <= h) w = A0_SHORT; else h = A0_SHORT;
      }
      return { size: 'custom', custom: { wpx: w, hpx: h } };
    }
    return { size: p, orientation: exportOrientation.value };
  });

  /** 纸张标签（文件名与纸框角标共用）：`'A4横'` / `'自定义 1000×1000px'`；跟随视口时是空串 */
  const exportPaperLabel = computed<string>(() => {
    const p = exportPaperSpec.value;
    if (!p) return '';
    if (p.size === 'custom') {
      const c = p.custom!;
      return `自定义 ${c.wpx}×${c.hpx}px`;
    }
    return `${p.size}${p.orientation === 'landscape' ? '横' : '纵'}`;
  });

  /** 纸张的物理毫米尺寸；跟随视口 / 自定义时是 null（自定义没毫米数，标签里已带像素） */
  const exportPaperMm = computed<{ w: number; h: number } | null>(() => {
    const p = exportPaperSpec.value;
    if (!p || p.size === 'custom') return null;
    const box = PAPER_SIZES[p.size];
    const landscape = p.orientation === 'landscape';
    return { w: landscape ? box[1] : box[0], h: landscape ? box[0] : box[1] };
  });

  /**
   * 屏幕上那圈虚线纸框的几何（CSS px，**相对地图容器左上角**）；跟随视口时为 null。
   *
   * ★ 走库的 `planExport()` 现算，**不在这儿另抄一套减法**：纸框画在哪必须与引擎
   *   实际取到哪是同一个算式，抄一份的话库改了取整 / 改了居中口径，框和成品就会
   *   差半个框 —— 而用户是**照着那圈框**判断纸能装下什么的。
   *
   * 取景范围与 dpi 无关（纸上一毫米恒等于 96/25.4 个 CSS 像素的地理范围），所以
   * 这里随便给一档 dpi 都得到同一块矩形；它也不随地图平移缩放变，只跟窗口尺寸与
   * 纸张选择有关 —— 所以**不需要监听任何地图事件**。
   */
  const exportPaperFrame = computed<{ x: number; y: number; w: number; h: number } | null>(() => {
    const paper = exportPaperSpec.value;
    const { w, h } = viewportSize.value;
    if (!paper || w <= 0 || h <= 0) return null;
    const plan = planExport({ cssW: w, cssH: h, dpr: 1, dpi: BASE_DPI, paper });
    return { x: plan.frameX, y: plan.frameY, w: plan.frameW, h: plan.frameH };
  });

  /* ---------------- 自动分块：不让用户选「切几块」，由像素预算反推 ---------------- */

  /**
   * 导出用的 dpi 与格式。
   *
   * ★ 这两个**必须住在桥里**，不能像以前那样留在面板组件的 `ref(300)` 里：
   *   自动分块依赖 dpi（dpi 翻倍 ⇒ 面积 ×4 ⇒ 可能多切一级），而屏幕上那圈纸框
   *   也要按算出来的网格画分割线 —— 它读的是桥。dpi 不搬进来，就会出现
   *   「改了 dpi，屏幕上的网格不跟着变」，而**用户正是照着那圈框判断要不要导的**。
   *   纸型（`exportPaper`）早就住在桥里，就是同一条约束。
   *
   * 这两个 ref 搬到 `export-prefs.ts`（**模块级单例**），桥与导出面板始终读取同一份设置。
   */
  const exportDpi = prefs.exportDpi;
  const exportFormat = prefs.exportFormat;

  /**
   * 底图要不要按**高清**导出（→ `ExportImageOptions.hdBasemap`）。
   *
   * ★ 这里的缺省是 **false（不要高清）**，与库的缺省（`true`）**故意不同**。
   *   两边说的不是一件事：库那边是「不认识这个选项的老调用方行为不许变」，
   *   这里是一个**产品决定** —— 高清档要另下一百多块深层瓦片、动辄几分钟（用户
   *   2026-09-22 报「点了导出 8 分钟还在转」正是这一档），把它当默认值等于让每次
   *   导出都赌一次网络。所以默认走快档，想要清晰底图的人自己去勾，勾之前也会看到
   *   那行「会久」的提醒（面板里 `hdWarn`）。
   *
   * ★ 它必须住在**桥**里（同 `exportDpi` 那段注释）：本地单张与本地分块
   *   两条路都要读它，各存一份必然出现「面板勾的是高清、实际却按快档出图」。
   */
  const exportHd = ref(false);

  /** 云打印开关：开启后整次出图由服务端渲染，本机不切片、不做本地回退。 */
  const exportCloud = ref(false);

  /**
   * 本机（浏览器）能不能把这一档 dpi 正常导出来。
   *
   * 判据用的是库自己的**像素预算**（`TILE_PIXEL_BUDGET`，3500 万）：`autoPaperGrid()` /
   * `autoViewportGrid()` 按预算反推切几块，**切完还带告警**（「已切到 A6 封顶仍超预算」）
   * 就说明每块都还超预算 —— 那一档撞的是浏览器的画布 / 内存上限，不是「慢一点」的事。
   * 当前独立服务只负责合并，不能替浏览器渲染超预算的单块；那种情况需要降低 dpi 或缩小纸张。
   *
   * ★ **不另抄一套算式**：这里问的是库的规划函数，与面板那行预告、与真导出用的是同一份
   *   —— 各算各的必然会「面板说能导、点了导不出来」。
   * ★ 返回 `true` 的含义只是「本机的规划不超预算」，**不等于**「一定成功」：
   *   显存、内存、倾斜视角下的大纸（整张超 1.5 亿像素）都可能让真导出报错 ——
   *   那些错都由库给明确中文，这里不越权预测。
   */
  function canExportLocally(d: number): boolean {
    const { w, h } = viewportSize.value;
    if (w <= 0 || h <= 0) return false;
    const paper = exportPaperSpec.value;
    const g = paper ? autoPaperGrid(paper, d) : autoViewportGrid(w, h, d);
    // `null` = 不用切（整张就在预算内）；有网格就看它报没报警
    return !g || g.warnings.length === 0;
  }

  /**
   * 自动分块的网格；`null` = **不切**（面板与纸框据此整段不显示）。
   *
   * ★ 上一版这里是「用户选块纸型 → `paperGrid()`」，那是个设计错误：浏览器画布上限是个
   *   **技术约束**，用户既没有依据判断「A0 横 @600dpi 该切到 A4 还是 A3」，也不该关心
   *   —— 选粗了当场失败，选细了白等几倍时间。现在反过来：只给库一个像素预算，
   *   切几块是算出来的（见 `autoPaperGrid` 那段注释）。
   *
   * ★ 卡片里返回的 `count === 1` 被**在这里压成 `null`**：库把「不用切」与「判断不了」
   *   分成两回事是有道理的（前者可能带告警），但**面板做的是同一个动作** —— 不切。
   *   压平这一下让上层的 `v-if="exportGrid"` 保持「切了块」这一个意思。
   *   （所以 `count === 1` 时那条「已切到 A6 封顶仍超预算」的告警会看不到 —— 那种情况
   *   当前 dpi 列表配 A6 撞不到，见库里的注释。）
   *
   * ★ 跟随视口也要能切：4K 视口 @600dpi 是 8100 万像素，超预算，而「跟随视口」是
   *   **默认模式** —— 不管它等于「默认设置下大屏高 dpi 只能失败」。
   */
  const exportGrid = computed<ExportGridInfo | null>(() => {
    const dpi = exportDpi.value;
    const paper = exportPaperSpec.value;
    const g = paper
      ? autoPaperGrid(paper, dpi)
      : autoViewportGrid(viewportSize.value.w, viewportSize.value.h, dpi);
    if (!g || g.count <= 1) return null;
    // 块的方向由**每块的像素**（不是毫米）判：跟随视口时 `block` 是 null，只有像素可依，
    // 而两种模式下这个判据恰好给出同一个答案（块宽是长边时就往横里分）。
    const blockLabel = g.block
      ? `${g.block}${g.tileW >= g.tileH ? '横' : '纵'}`
      : '';
    return { ...g, blockLabel };
  });

  /**
   * 批量导出进行到第几张（给全屏遮罩显示「第 2/4 张」）；`null` = 没在批量导出。
   *
   * ★ 与 `exportTiles`（瓦片块数）**不是一回事**：那个是引擎在下一张图的瓦片时
   *   报的「这几十/几百块瓦片下了多少」，这个是桥自己数的「一共几张纸出完了」。
   *   同一次导出里两个都有意义，遮罩上也是两句不同的话。
   */
  const exportBatch = ref<{ index: number; total: number } | null>(null);

  /**
   * 「正在传给合并服务 / 等服务端合并」时遮罩上那行字；`null` = 没在合并。
   *
   * ★ 单独一个（而不是复用 `exportProgress`）：分块导出刚结束时 `exporting` 已经是
   *   false，可**合并才刚开始** —— 那一段是几百 MB 上传 + 几分钟服务端拼图，
   *   全程页面一动不动。不复用是因为两者的生命周期不重叠，而遮罩要在这两段**都**
   *   挂着（`App.vue` 里是 `exporting || mergeWait`）。
   */
  const mergeWait = ref<string | null>(null);

  /**
   * 服务端进度的轮询器：每秒问一次 `GET /progress`，把「第几块」交给调用方写进遮罩。
   *
   * ★ 为什么必须轮询：`POST /merge` 是**一路阻塞到出完图**才回
   *   响应（几百 MB 的图，中间一个字节都不发）。没有它，页面上唯一会动的只有
   *   「已等 N 分 N 秒」——用户看不出它是在干活还是已经死了（这正是这次要修的症状）。
   *
   * ★ 读不到（服务没起 / 老版本服务端没这个路由 / 忙到没答上来）**什么都不做**：
   *   继续用兜底文案 + 已等时长，表现与没有这个功能时完全一致。
   *
   * @returns 停止轮询的函数 —— 调用方**必须在 finally 里调**，否则遮罩会被一直重写。
   */
  function startServerProgress(opts: {
    url: string;
    /** 每一跳（约 1 秒）回调一次；`progress` 为 `null` = 这一跳没拿到服务端进度 */
    onTick: (progress: MergeProgress | null, elapsedMs: number) => void;
  }): () => void {
    const started = Date.now();
    let latest: MergeProgress | null = null;
    let inFlight = false;
    const tick = () => {
      opts.onTick(latest, Date.now() - started);
      // ★ 上一跳还没回来就跳过这一跳：大图解码期间服务端可能几秒答不上来，
      //   堆一串请求只会让它们全都超时，而且最后回来的那个可能是**旧的**数字。
      if (inFlight) return;
      inFlight = true;
      void fetchMergeProgress(opts.url).then((p) => {
        latest = p;
      }).finally(() => { inFlight = false; });
    };
    tick();                                             // 立刻写一次，别等满一秒才有字
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }

  /**
   * 当前设置下分块导出的产物**能不能合并**。
   *
   * PNG 走分带流式（服务端零依赖自研解码器，分带省内存）；JPEG 走整帧在内存拼好再编码
   * （`jpeg-js`，纯 JS 无原生依赖），内存占用更高但超大图会被 `planMerge` 挡在 503。
   * 两种格式现在都支持，所以页面都会发合并请求。
   */
  const mergeSupported = computed<boolean>(() => exportFormat.value === 'png' || exportFormat.value === 'jpeg');

  /**
   * 出图结果的摘要（面板里那行小字）。同 `summarize()`：翻译成人话是桥的职责。
   */
  function summarizeExport(r: ExportImageResult): string {
    const kind = r.mime === 'image/jpeg' ? 'JPG' : 'PNG';
    // 纸张模式点名是哪张纸：同一段视口导 A4 与导 A3，px 数不一样但都得说清
    const label = exportPaperLabel.value;
    const head = `已导出 ${label ? `${label} ` : ''}${r.width}×${r.height} px / ${r.dpi} dpi ${kind}。`;
    if (!r.warnings.length) {
      return r.baseDrawn ? head : `${head}（底图没能合进来，图里只有标注层）`;
    }
    const tag = r.warnings.length > 1 ? `提示（共 ${r.warnings.length} 条）` : '提示';
    return `${head}${tag}：${r.warnings[0]}`;
  }

  /**
   * 把当前视口连底图带标注导成一张图；失败返回 `null`（原因走 error 条）。
   *
   * ★ 这是一个**可能几十秒到几分钟**的等待，两段：引擎先要等可见地图把瓦片下完（刚打开
   *   页面就点导出时这一段最明显 —— 不等的话成品里底图是空白的），然后在另建的隐藏地图里
   *   按抬高的 zoom **重新下一百多块瓦片**（300dpi 时）。好处是可见地图从头到尾一个字节都
   *   没被碰过（相机、尺寸、用户选中全都原样），代价就是慢 —— 所以进度走 `exportProgress`
   *   （等待文案里会带已等秒数与瓦片块数，别让用户以为卡死了）+ `exportTiles`（遮罩上那条
   *   进度条），等待期间由界面上的遮罩兜住。
   *   引擎那一层**不设超时**（等多久就多久，理由见 README「为什么要等」）。
   *
   * 并发由引擎兜底（第二次调用会抛中文错误），这里再置一次 `exporting` 让按钮先灰掉：
   * 用户点不出第二次，就不会撞上那个错误。
   */
  async function exportImage(): Promise<ExportImageResult | null> {
    const t = tool.value;
    if (!t) {
      showError('请先加载地图后再导出图片。');
      return null;
    }
    // 格式与 dpi 从桥读（它们住在桥里，见 `exportDpi` 那段注释）
    const format = exportFormat.value;
    const dpi = exportDpi.value;
    if (exporting.value) return null;   // 按钮已置灰，这里只是兜底
    exporting.value = true;
    exportProgress.value = '正在准备导出…';
    clearError();
    exportNotice.value = '';            // 上一次的结果先收掉，别和这一次的进度混着看
    try {
      // 没有质量参数：JPEG 由引擎固定按质量 1 编码（面板上也就没有对应控件）
      // `paper` 为 null（跟随视口）时传进去等于没传 —— 引擎的口径是「没有纸张就是
      // 老行为」，所以这里不必分支，两种模式共用一条调用。
      const r = await t.exportImage({
        format,
        dpi,
        paper: exportPaperSpec.value,
        // 底图档位也住在桥里（同 dpi / 格式，见 `exportHd` 那段注释）
        hdBasemap: exportHd.value,
        onProgress: (msg, info) => {
          exportProgress.value = msg;
          exportTiles.value = info.tiles ?? null;   // 数不出来就是 null → 遮罩画不确定条
        },
      });
      exportNotice.value = summarizeExport(r);
      return r;
    } catch (err) {
      // 失败走右上角/底部的 error 条（和别处一致），摘要行里不留半截话
      exportNotice.value = '';
      showError((err as Error).message || String(err));
      return null;
    } finally {
      exporting.value = false;
      exportProgress.value = '';
      exportTiles.value = null;
    }
  }

  /**
   * 批量导出的一句话摘要（面板里那行小字）。同 `summarizeExport`：翻译成人话是桥的职责。
   *
   * 「每块 7022×4967」取的是**第一块**的像素数：各块因取整最多差 1 像素，逐块列出来
   * 只会把一行字撑成三行，反而看不出「每块都一样大」这个真正有用的信息。
   *
   * 块纸型（`A4横`）也写进这句：用户手上立刻会多出 16 个文件，而「每块是一张完整的
   * A4」正是他决定打不打得出来的依据 —— 这个信息**不该**只留在导出前的那行预告里，
   * 导出完那句话已经把预告行盖过去了。
   */
  function summarizeExportBatch(
    done: ExportBatchTile[], grid: ExportGridInfo, failures: string[],
  ): string {
    const r = done[0].result;
    const kind = r.mime === 'image/jpeg' ? 'JPG' : 'PNG';
    // 跟随视口时纸张标签是空串 —— 这里点明「跟随视口」，否则那句会以「2×2 = 每块…」开头
    const label = exportPaperLabel.value || '跟随视口';
    const block = grid.blockLabel ? `${grid.blockLabel} ` : '';
    const size = `${label} ${grid.cols}×${grid.rows}`
      + ` = 每块 ${block}${r.width}×${r.height} px / ${r.dpi} dpi ${kind}`;
    if (!failures.length) {
      const head = `已导出 ${done.length} 张（${size}）。`;
      return r.baseDrawn ? head : `${head}（底图没能合进来，图里只有标注层）`;
    }
    // ★ 部分失败时**逐块说清是哪一块**：用户要凭这句话决定重导哪一张。
    return `已导出 ${done.length}/${done[0].total} 张（${size}），`
      + `有 ${failures.length} 处失败：${failures.join('；')}`;
  }

  /**
   * 把当前纸张**切成多张完整的纸**逐张导出（点一次，出去一叠图）。
   *
   * 用途只有一个：大纸在高 dpi 下整张会撞浏览器的画布上限（单边约 16384、面积约
   * 2.68 亿像素），A0 横 @300dpi 的 1.4 亿虽然合法，三张全尺寸画布叠起来也上 GB。
   * 切成 2×2 后每块 3490 万像素，落在「稳定可出」的量级 —— **而每块本身就是一张完整的
   * 纸**，拿去打印不用拼，矢量底图的注记也在每张纸上各自正常摆放（没有拼图接缝）。
   *
   * ★ 一块失败**不中断整批**：剩下那几块照样出。大图导出动辄几分钟，因为第 7 块撞了
   *   一次上下文丢失就把前 6 块全扔掉，是最招人恨的失败方式。所以：
   *   · 逐块 `catch`，失败记进 `failures`，继续下一块；
   *   · **只有一块都没出来**才 `showError`（部分失败写进摘要行，见 `summarizeExportBatch`）
   *     —— 否则用户会以为整批没出，把已经拿到的 3 张也扔了。
   *
   * 返回**原始数据**（blob + 序号），文件名与下载由组件负责：与 `exportJSON()` 同一条
   * 分工，桥不碰浏览器那半截才跑得进 vitest。
   */
  async function exportImageBatch(): Promise<ExportBatchTile[] | null> {
    const t = tool.value;
    if (!t) {
      showError('请先加载地图后再导出图片。');
      return null;
    }
    if (exporting.value) return null;           // 兜底，同 exportImage
    const format = exportFormat.value;
    const dpi = exportDpi.value;
    const grid = exportGrid.value;
    const paper = exportPaperSpec.value;
    const { w, h } = viewportSize.value;
    // ★ 这里**不要求 paper 非空**：跟随视口同样可能超预算（4K @600dpi 是 8100 万像素），
    //   而它是默认模式 —— 拦掉它等于「默认设置下大屏高 dpi 只能失败」。
    //   `paper` 为 null 时 `planExport` 的口径就是「没有纸张 = 跟随视口」，正好。
    if (!grid || w <= 0 || h <= 0) return null;

    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    // 逐块的规划走库的 `planExportTiles()`：面板的预告、引擎拿到的 `cell`、
    // 这里循环的次序**全是同一份**，三处不会各算各的（这是「不另抄一套算式」的要点）。
    const tiles = planExportTiles({
      cssW: w, cssH: h, dpr, dpi, paper, cols: grid.cols, rows: grid.rows,
    });

    exporting.value = true;
    clearError();
    exportNotice.value = '';
    const done: ExportBatchTile[] = [];
    const failures: string[] = [];
    try {
      for (const tile of tiles.tiles) {
        const no = tile.index + 1;
        exportBatch.value = { index: no, total: tiles.count };
        exportProgress.value = `第 ${no}/${tiles.count} 张 · 正在准备导出…`;
        exportTiles.value = null;
        try {
          const result = await t.exportImage({
            format, dpi, paper, cell: tile.cell,
            hdBasemap: exportHd.value,       // 同上：底图档位由桥统一决定
            onProgress: (msg, info) => {
              // 引擎的文案原样跟在后面：它说的「已等 N 秒 · N%」是**这一张**的进度
              exportProgress.value = `第 ${no}/${tiles.count} 张 · ${msg}`;
              exportTiles.value = info.tiles ?? null;
            },
          });
          // `col`/`row` 原样从 `planExportTiles()` 带出来 —— 说明书与拼版都只认它们
          done.push({ index: tile.index, col: tile.col, row: tile.row, total: tiles.count, result });
        } catch (err) {
          failures.push(`第 ${no} 块：${(err as Error).message || String(err)}`);
        }
      }
    } finally {
      exporting.value = false;
      exportProgress.value = '';
      exportTiles.value = null;
      exportBatch.value = null;
    }

    if (!done.length) {
      exportNotice.value = '';   // 摘要行里不留半截话（同 exportImage）
      showError(`共 ${tiles.count} 张都没能导出。${failures[0] || ''}`);
      return null;
    }
    exportNotice.value = summarizeExportBatch(done, grid, failures);
    return done;
  }

  /**
   * 把一批分块导出的产物**合并成一张大图**（走 `server/` 那个服务）。
   *
   * 编排放在桥里而不是面板里，图的就是这一份能被用例钉住 —— 这里面每一条都是
   * 「做错了用户会白等几分钟才发现」的那种决定：
   *   · **缺块根本不上传**（本地就知道，为什么还要白传几百 MB）；
   *   · **任何失败都落到 zip**（导出本身永不因为后端挂了而失败）；
   *   · PNG / JPG 都发合并请求（见 `mergeSupported`，JPG 走整帧编码）。
   *
   * 返回的两种结局里都带着一份 `Blob`：成功是合并图，失败是原样的 zip。
   * 于是组件那半截只剩「下载哪一份」，而它连 `URL.createObjectURL` 之外的事都不必知道
   * （下载留在组件里是因为 jsdom 没有 `createObjectURL`，同 `exportJSON` 的分工）。
   *
   * ★ 先把 zip 打好再决定发不发：成功路径上这份 zip 是白打的（几百 MB 的 memcpy，
   *   但 PNG 已经压过了，打 zip 是 store 模式、**不压缩**，很快），可失败路径上
   *   它就是用户唯一拿到的东西 —— 为省那点 memcpy 而让失败路径拿不出包，不值当。
   *
   * @param now 只影响文件名，可注入（用例要钉住文件名，不想去 mock 时间）
   */
  async function mergeExportedTiles(
    tiles: ExportBatchTile[],
    grid: ExportGridInfo,
    opts: { now?: Date } = {},
  ): Promise<ExportMergeResult> {
    const now = opts.now ?? new Date();
    const first = tiles[0];
    const dpi = first.result.dpi;                 // 引擎返回的**实际** dpi，不是选中的那个
    const label = exportPaperLabel.value;
    const ext = first.result.mime === 'image/jpeg' ? 'jpg' : 'png';
    const zipName = zipFileName(dpi, label, tiles.length, now);

    const files = tiles.map((t) => ({
      name: imageFileName(ext, dpi, label, { index: t.index + 1, total: t.total }, now),
      blob: t.result.blob,
    }));

    /* -- ① 缺块：本地就拦下，不浪费一次上传 --------------------------------- */

    const missing: number[] = [];
    for (let i = 0; i < grid.count; i++) {
      if (!tiles.some((t) => t.index === i)) missing.push(i + 1);
    }
    if (missing.length) {
      // 说明书要逐块 `col`/`row`，缺一块就写不出来（`buildMergeManifest` 会当场抛），
      // 服务端也一定会拒 —— 所以这里连 zip 里的说明书都不放，只给各块原样打包，
      // 用户解压开照样能按序号手工拼。
      const zip = await zipBlobs(files, now);
      return {
        ok: false,
        reason: `缺 ${missing.length} 块（第 ${missing.join('、')} 块）导不出来，缺块无法合并，`
          + '请重新导出这几块。',
        zip,
        zipName,
      };
    }

    /* -- ② 打合并包（含说明书）--------------------------------------------- */

    const manifest = buildMergeManifest({
      paperLabel: label,
      dpi,
      // ★ 报**真实的**格式：这里是 JPG 时写 'png' 会让服务端拿 PNG 解码器去解 JPEG，
      //   报出来的错离真正的原因十万八千里。JPG 现在也支持（整帧编码），但格式必须如实填。
      format: first.result.mime === 'image/jpeg' ? 'jpeg' : 'png',
      cols: grid.cols,
      rows: grid.rows,
      tiles: tiles.map((t, i) => ({
        index: t.index, col: t.col, row: t.row,
        width: t.result.width, height: t.result.height,
        file: files[i].name,
      })),
      // 给合并图写的 PNG 元数据：中心点 / 级别来自当前地图，标题用导出文件名（去扩展名）
      center: map.value ? [map.value.getCenter().lng, map.value.getCenter().lat] : undefined,
      zoom: map.value ? map.value.getZoom() : undefined,
      title: imageFileName(ext, dpi, label, null, now).replace(/\.(png|jpg)$/i, ''),
      now,
    });
    const zip = await buildExportZip({ manifest, files, now });

    // 未配置服务地址时不尝试连接任何默认服务，直接把完整分块包交给调用方下载。
    const serviceUrl = mergeServiceUrl();
    if (!serviceUrl) {
      return { ok: false, reason: '未填写合并服务地址。', zip, zipName };
    }

    /* -- ③ 上传 + 合并 ------------------------------------------------------ */

    mergeWait.value = '正在上传分块包…';
    // 上传阶段（有字节进度）文案由 `onProgress` 那条路管；上传完了才轮到服务端进度接管
    let uploaded = false;
    // 一秒一跳：重写「已等 N 分 N 秒」+ 读服务端报的「拼到第几块」。
    // 服务端拼图期间**一个字节都不发**，没有这些会走的数字，用户看到的就是一块不动的画面。
    const stopPoll = startServerProgress({
      url: serviceUrl,
      onTick: (p, elapsed) => {
        if (!uploaded) return;                        // 上传还没完：文案归 onProgress 管
        // 服务端有真进度就用它，没有（老版本服务端 / 忙到没答上来）退回兜底那句
        const base = p && p.label ? p.label : '服务端正在拼成一张大图…';
        mergeWait.value = `${base}（已等 ${fmtElapsed(elapsed)}）`;
        // 上传时这条条走的是**字节**，这里换成**块数** —— 两段都是「干到几分之几」
        if (p && p.total > 0) exportTiles.value = { loaded: p.done, total: p.total };
      },
    });
    try {
      const res = await uploadZipForMerge({
        url: serviceUrl,
        zip,
        onProgress: (loaded, total) => {
          // 上传阶段让遮罩上那条**确定**的进度条动起来。`total` 算不出（少见）时给 null，
          // 遮罩会退回「来回跑的不确定条」—— 给 `{loaded, total: 0}` 会画成一条卡在 0% 的
          // 确定条，那比不确定条更像「死了」。
          exportTiles.value = total ? { loaded, total } : null;
          if (!mergeWait.value) mergeWait.value = '正在上传分块包…';
          if (total !== null && loaded >= total) uploaded = true;
        },
      });
      if (!res.ok) return { ok: false, reason: res.reason, zip, zipName };
      return {
        ok: true,
        tiles: tiles.length,
        blob: res.result.blob,
        // 合并图的文件名**就是**单张整图那个名字 —— 它本来就是「那张整图」
        // （没有 `-第N块共M块` 那段，正是它与各个分块的区别）
        filename: imageFileName(ext, dpi, label, null, now),
        notice: res.result.notice,
        warnings: res.result.warnings,
      };
    } finally {
      // ★ 轮询器必须在这里停：漏了它每秒都会把刚清空的 `mergeWait` 重写回去，
      //   遮罩就永远挂着 —— 「页面看起来死了」的另一种写法。
      stopPoll();
      mergeWait.value = null;
      exportTiles.value = null;
    }
  }

  /** 将当前绘制数据、地图视角与出图参数交给独立服务 `/render` 云打印。 */
  async function exportServerSide(): Promise<boolean> {
    const t = tool.value;
    const m = map.value;
    if (!t || !m) { showError('请先加载地图后再导出图片。'); return false; }
    if (exporting.value) return false;

    const serviceUrl = mergeServiceUrl();
    if (!serviceUrl) {
      showError('请先在导出面板中设置合并服务地址，再启用云打印。');
      return false;
    }

    const { w, h } = viewportSize.value;
    if (w <= 0 || h <= 0) {
      showError('地图容器尺寸为 0，无法出图（容器可能还没显示）。');
      return false;
    }

    const dpi = exportDpi.value;
    const format = exportFormat.value;
    const paper = exportPaperSpec.value;
    const center = m.getCenter();
    const payload = {
      sketch: t.exportJSON(),
      viewport: { w, h },
      view: {
        center: [center.lng, center.lat] as [number, number],
        zoom: m.getZoom(),
        bearing: m.getBearing(),
        pitch: m.getPitch(),
      },
      token: readToken(),
      style: m.getStyle(),
      dpi,
      format,
      paper,
      hdBasemap: exportHd.value,
    };

    exporting.value = true;
    exportProgress.value = '正在请求服务端云打印…';
    clearError();
    exportNotice.value = '';
    mergeWait.value = '正在请求服务端云打印…';
    const stopPoll = startServerProgress({
      url: serviceUrl,
      onTick: (progress, elapsed) => {
        const label = progress?.label || '服务端正在渲染与合并…';
        mergeWait.value = `${label}（已等 ${fmtElapsed(elapsed)}）`;
        exportTiles.value = progress && progress.total > 0
          ? { loaded: progress.done, total: progress.total }
          : null;
      },
    });

    try {
      const response = await fetch(`${serviceUrl.replace(/\/+$/, '')}/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        let message = `云打印失败（HTTP ${response.status}）。`;
        try {
          const body = await response.json() as { error?: string };
          if (body.error) message = body.error;
        } catch { /* 反向代理可能返回 HTML 错误页，保留状态码提示 */ }
        showError(message);
        return false;
      }

      const expectedMime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
      const responseMime = response.headers.get('Content-Type')?.split(';', 1)[0].trim();
      if (responseMime !== expectedMime) {
        showError(`云打印返回了 ${responseMime || '未知格式'}，预期 ${expectedMime}。`);
        return false;
      }

      const blob = await response.blob();
      const ext = format === 'jpeg' ? 'jpg' : 'png';
      downloadBlob(imageFileName(ext, dpi, exportPaperLabel.value), blob);
      exportNotice.value = `已由服务端云打印：${w}×${h} CSS px @${dpi}dpi。`;
      return true;
    } catch (error) {
      showError(`连不上云打印服务（${(error as Error).message || String(error)}）。请检查服务地址、跨域设置和服务状态。`);
      return false;
    } finally {
      stopPoll();
      mergeWait.value = null;
      exportTiles.value = null;
      exporting.value = false;
      exportProgress.value = '';
    }
  }

  /* ---------------- 清空 / 销毁 / 编辑开关 ---------------- */
  /**
   * 清空所有图形。
   * 样式面板会跟着收起 —— 引擎的 `clear()` 会把聚焦对象清掉，`sync()` 见了就收，
   * 这里不显式关（同一条规则只写在一处）。
   */
  function clearAll(): void {
    tool.value?.clear();
  }

  /** 销毁绘制工具（地图仍在，可再点「加载地图」重建） */
  function destroyTool(): void {
    const t = tool.value;
    if (!t) return;
    try {
      t.destroy();
      tool.value = null;
      focusedId.value = null;
      drawingType.value = null;
      destroyed.value = true;
      closeStyle();           // 引擎没了，还挂着一块陈列死状态的面板说不通
      version.value += 1;
    } catch (err) {
      showError((err as Error).message || String(err));
    }
  }

  function setEditing(on: boolean): void {
    tool.value?.setEditing(on);
    version.value += 1;       // 引擎不会为纯编辑开关回调 onChange，手动刷新一下面板
  }

  /**
   * 编辑开关的**可写取值**。
   * 必须是 computed 而不是裸 ref —— 面板里 `v-model="editing"` 直接写 ref 的话
   * 只会改到 Vue 这边的状态，引擎的 setEditing() 根本不会被调用。
   *
   * ★ getter 里的 `version.value;` 不能省。`tool` 是 `shallowRef`（见文件头：
   *   引擎实例绝不能被 Vue 深度代理），所以 `tool.value.editing` 读的是**未被追踪**
   *   的普通属性 —— 这个 computed 的依赖里只有 `tool` 本身。少了这一行，下面 setter
   *   里那次 `version.value += 1` 就没人订阅：引擎确实切了，computed 却一直返回
   *   旧缓存值，开关会「弹回去」，看起来就是**点了没反应**。
   *   这也是本文件所有 computed 的统一写法（`shapes` / `focused` / `cfgRef` … 都先读 version）。
   */
  const editing = computed({
    get: () => {
      version.value; // 建立依赖：setter 自增 version 时本 computed 才会重算
      return !!tool.value && tool.value.editing;
    },
    set: (on: boolean) => setEditing(on),
  });

  function setSnapping(on: boolean): void {
    tool.value?.setSnap(on);
    version.value += 1;       // 同 setEditing：引擎不会为纯吸附开关回调 onChange
  }

  /** 绘制吸附开关的可写取值。写法和 `editing` 完全一致（含 getter 里那句 version.value） */
  const snapping = computed({
    get: () => {
      version.value;
      return !!tool.value && tool.value.snapping;
    },
    set: (on: boolean) => setSnapping(on),
  });

  /**
   * 该图形是否被隐藏（列表行据此置灰、切眼睛图标）。
   *
   * 走引擎的 `isHidden(id)`（O(1) 查表）而不是在 `shapes` 快照里 find —— 列表每行都要问一次，
   * find 会把它变成 O(N²)。`version.value;` 不能省：引擎实例在 shallowRef 里，
   * 这个函数在模板里被调用时全靠它建立依赖（同本文件其它 computed）。
   */
  function isHidden(id: string): boolean {
    version.value;
    return !!tool.value?.isHidden(id);
  }

  /**
   * 切换单个图形的显示 / 隐藏（列表里的眼睛按钮）。
   * 引擎改完会走 `onChange` → `sync()` 自增 version，所以这里**不用**手动刷新。
   */
  function toggleHidden(id: string): void {
    const t = tool.value;
    if (!t) return;
    if (t.isHidden(id)) t.show(id);
    else t.hide(id);
  }

  function setVisibleAll(on: boolean): void {
    tool.value?.setVisible(on);
    version.value += 1;       // 同 setEditing：总开关是纯视图开关，引擎不回调 onChange
  }

  /**
   * 全局「显示标注」总开关的可写取值。
   * ★ 它**不动**各图形自己的隐藏状态 —— 关掉再打开，原先被单独隐藏的那些仍然是隐藏的
   *   （引擎侧 `setVisible` 只读不改 `shape.hidden`，见 sketch.ts）。
   */
  const visibleAll = computed({
    get: () => {
      version.value;
      return !!tool.value && tool.value.visible;
    },
    set: (on: boolean) => setVisibleAll(on),
  });

  /* ---------------- 地图生命周期 ---------------- */
  /** 销毁工具与地图（换 token / 组件卸载时用） */
  function unmount(): void {
    if (tool.value) {
      try { tool.value.destroy(); } catch { /* 已经坏掉的实例，忽略 */ }
      tool.value = null;
    }
    if (measure.value) {
      try { measure.value.destroy(); } catch { /* 同上 */ }
      measure.value = null;
    }
    measuringType.value = null;
    measureCount.value = 0;
    measureCtl = null;      // 控件 DOM 随 map.remove() 一起移除
    if (map.value) {
      map.value.remove();
      map.value = null;
    }
    closeStyle();
  }

  /**
   * 建图并在样式就绪后创建绘制引擎。
   * @param container 地图容器元素
   * @param token     Mapbox Access Token（会存进 localStorage）
   */
  function mount(container: HTMLElement, token: string): void {
    const trimmed = token.trim();
    if (!trimmed) {
      showError('请先填写 Mapbox Access Token。');
      return;
    }
    clearError();
    clearNotice();          // 换一张地图＝换一个会话，上一次的导入摘要不该留在这儿
    clearExportNotice();    // 出图摘要同理（视口尺寸也变了，那份 px 数已经不成立）
    unmount();
    destroyed.value = false;
    saveToken(trimmed);

    // 测量按钮组：先于地图创建，随 controls 注入（先加的在上面 → 压在缩放按钮上方）
    measureCtl = new MeasureControl({
      onDistance: () => startMeasure('distance'),
      onArea: () => startMeasure('area'),
      onClear: () => clearMeasure(),
    });

    map.value = createMap({
      container,
      token: trimmed,
      controls: [measureCtl],
      onError: showError,
      onLoad: (m) => {
        clearError();
        // 引擎的初始默认配置 = 面板当前的值（面板就是这个状态的唯一来源）
        tool.value = new MapboxSketch(m, {
          // 出图要在隐藏容器里另建一张地图，而库自己不 import mapbox-gl（零依赖），
          // 所以由示例把构造器递进去（见 create-map.ts 的 createExportMap）
          createMap: createExportMap,
          // 「图片标注」选中后要弹系统文件框、读文件、降采样 —— 库不碰文件 IO，
          // 这段整个由宿主提供（见 pick-image.ts）
          pickImage: pickImageFile,
          defaultCfg: {
            text: pathText.value,
            spread: spread.value,
            smooth: smooth.value,
            showNodes: showNodes.value,
            showLine: showLine.value,
            angle: leaderAngle.value,
            len: leaderLen.value,
          },
          onChange: sync,
          onWarn: showError,
        });
        // 测量是**第二个**独立实例：与标注引擎各画各的、互不污染。
        // 指针的让出与归还见 startMeasure / syncMeasure。
        measure.value = new MapboxSketchMeasure(m, {
          onChange: syncMeasure,
          onWarn: showError,
        });
        // 地图加载完**不预置任何图形**：画布是空的，一切图形要么手绘、
        // 要么由「导入 JSON」灌进来
        // 底图管理器挂上地图：先应用当前激活列表（若 loadBasemaps 已先回来，
        // 此时就直接把默认那条画上），再去拉列表定默认。
        basemapMgr = new BasemapManager();
        basemapMgr.attach(m);
        applyActive();
        void loadBasemaps();
        syncMeasure();
        sync();
      },
    });
  }

  /** 页面卸载时整体清理（避免地图与事件监听泄漏） */
  function teardown(): void {
    unmount();
    clearNotice();
    destroyed.value = false;
    focusedId.value = null;
    drawingType.value = null;
    version.value += 1;
  }

  return {
    /* 引擎 / 地图 */
    map, tool, alive, destroyed, version,
    /* 引擎回调。暴露出来是给用例用的：面板的自动开合长在 sync() 里，替身引擎叫不动它，
       只能直接模拟一次 onChange（见 test/demo-bridge.spec.ts 的 engineChanged） */
    sync,
    /* 提示 */
    error, showError, clearError,
    notice, clearNotice,
    /* 派生状态 */
    shapes, focused, focusedType,
    /* 可写取值（都只给右侧样式面板的配置行用；`showNodes` / `showLine` 面板上已经没有
       行，只在本文件的 `mount()` 与 `cfgValueOf` / `setCfgValue` 里用，不再往外暴露） */
    pathText, spread, smooth,
    leaderText, leaderAngle, leaderLen,
    /* 样式 */
    styleTarget, styleValues, styleGroups, applyStyle, resetStyle,
    /* 样式面板里「跟类型走」的绘制配置行（排在样式行前面） */
    cfgGroups, cfgValueOf, setCfgValue,
    /* 样式面板里「跟类型走」的几何行（配置行之后、样式行之前） */
    geomGroups, geomValueOf, setGeomValue,
    /* 全局样式（悬停高亮色 / 主题色 / 默认线型：全局项，不在上面那套里） */
    hoverColor, setHoverColor,
    themeColor, setThemeColor,
    defaultLineType, setDefaultLineType,
    /* 样式面板（右侧） */
    styleOpen, openStyle, closeStyle,
    /* 列表 */
    focus, remove, typeLabel, describe,
    /* 底图（多底图叠加 / 拖拽排序 / 透明度 / 筛选检索） */
    basemaps, activeBasemaps, basemapLoading, basemapError, basemapGroups,
    loadBasemaps, isActiveBasemap, toggleBasemap, removeBasemap,
    setBasemapOpacity, setBasemapHidden, reorderBasemap,
    /* 显示 / 隐藏 */
    isHidden, toggleHidden, visibleAll,
    /* 手绘 */
    toggleDraw, isDrawing, drawHint, drawingType,
    /* 测量（独立第二实例：启停 / 清除 / 状态回显 / 全局样式） */
    measureAlive, measuringType, measureCount, startMeasure, clearMeasure,
    measureThemeColor, setMeasureThemeColor,
    measureTextColor, setMeasureTextColor,
    measureLineWidth, setMeasureLineWidth,
    /* 数据存档 */
    exportJSON, importJSON,
    /* 图片导出 */
    exportImage, exportImageBatch,
    exporting, exportProgress, exportTiles, exportBatch,
    viewportSize, exportNotice, clearExportNotice,
    /* 纸张（A0–A6 / 自定义像素）与屏幕上那圈虚线纸框 */
    exportPaper, exportOrientation, exportPaperSpec, exportPaperLabel, exportPaperMm,
    exportCustomW, exportCustomH,
    exportPaperFrame,
    /* 导出的格式与分辨率（住在桥里：自动分块与纸框都要读，见 exportDpi 那段注释） */
    exportDpi, exportFormat,
    /* 底图档位（高清 / 当前层级）。三条出图路径都要读，见 exportHd 那段注释 */
    exportHd,
    /* 云打印：整单交给服务端 `/render`，见 exportServerSide */
    exportCloud, exportServerSide,
    /* 本机可导出性判断 */
    canExportLocally,
    /* 自动分块 + 服务端合并 */
    exportGrid, mergeSupported, mergeWait, mergeExportedTiles,
    /* 工具操作 */
    clearAll, destroyTool, editing, setEditing, snapping, setSnapping,
    /* 地图生命周期 */
    mount, unmount, teardown, readToken,
  };
}

export type SketchContext = ReturnType<typeof useSketch>;

/** App.vue 用 `provide(SKETCH_KEY, sk)` 注入一次；子组件靠 `useSketchContext()` 取用 */
export const SKETCH_KEY: InjectionKey<SketchContext> = Symbol('mapbox-sketch-demo');

/** 子组件里取用 */
export function useSketchContext(): SketchContext {
  const ctx = inject(SKETCH_KEY);
  if (!ctx) throw new Error('useSketchContext() 必须在 App.vue 的 provide 之下使用。');
  return ctx;
}
