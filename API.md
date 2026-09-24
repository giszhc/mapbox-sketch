# @giszhc/mapbox-sketch · API 文档

**零运行时依赖的 Mapbox 手绘标注引擎。** 在一张 `pointer-events:none` 的全屏 canvas 覆盖层上绘制点 / 线 / 面 / 圆 / 矩形 / 椭圆 / 扇形 / 图片 / 路径文字 / 距离 / 面积 / 引线等 41 种内置标注，支持点选拖拽编辑、自动吸附、存档导入导出、高清出图。

- 包名：`@giszhc/mapbox-sketch`
- 主出口：`import … from '@giszhc/mapbox-sketch'`（含 41 种内置类型）
- 内核出口：`import … from '@giszhc/mapbox-sketch/core'`（不含内置类型，可完全 tree-shake）
- `mapbox-gl` 仅作 `peerDependency`（`>=2.0.0`），库内只 `import type`，产物里零引用

---

## 目录

- [安装与引入](#安装与引入)
- [快速开始](#快速开始)
- [MapboxSketch 主类](#mapboxsketch-主类)
  - [构造函数与选项](#构造函数与选项)
  - [静态成员](#静态成员)
  - [绘制与编辑](#绘制与编辑)
  - [图形管理](#图形管理)
  - [配置（写什么）](#配置写什么)
  - [样式（长什么样）](#样式长什么样)
  - [几何参数（摆在哪儿）](#几何参数摆在哪儿)
  - [显示与隐藏](#显示与隐藏)
  - [编辑交互开关](#编辑交互开关)
  - [绘制吸附](#绘制吸附)
  - [类型注册](#类型注册)
  - [数据存档](#数据存档)
  - [图片导出](#图片导出)
  - [渲染与生命周期](#渲染与生命周期)
- [MapboxSketchMeasure 测量工具](#mapboxsketchmeasure-测量工具)
- [MapboxShapeType 类型基类](#mapboxshapetype-类型基类)
  - [必需成员](#必需成员)
  - [可选钩子](#可选钩子)
  - [宿主接口（this 上的可用资源）](#宿主接口this-上的可用资源)
- [41 种内置类型一览](#41-种内置类型一览)
- [Style 样式键全集（21 键）](#style-样式键全集21-键)
- [Cfg 配置键全集（9 键）](#cfg-配置键全集9-键)
- [几何参数](#几何参数-1)
- [数据格式](#数据格式)
- [图片导出详解](#图片导出详解)
- [富文本行内标签语法](#富文本行内标签语法)
- [工具函数](#工具函数)
- [公共类型定义](#公共类型定义)

---

## 安装与引入

```bash
pnpm add @giszhc/mapbox-sketch mapbox-gl
# 或 npm i @giszhc/mapbox-sketch mapbox-gl / yarn add @giszhc/mapbox-sketch mapbox-gl
```

`mapbox-gl` 需你自己装（`>=2.0.0`），版本由你的项目决定。

```ts
// ESM / TypeScript（含 41 种内置类型，开箱即用）
import MapboxSketch, { MapboxSketchMeasure, MapboxShapeType } from '@giszhc/mapbox-sketch';

// 只要内核 + 自己注册类型（体积最小）
import { MapboxSketch, MapboxShapeType } from '@giszhc/mapbox-sketch/core';
```

```html
<!-- UMD / CDN，全局变量 window.MapboxSketch -->
<script src="https://unpkg.com/@giszhc/mapbox-sketch/dist/index.umd.js"></script>
```

---

## 快速开始

```ts
import mapboxgl from 'mapbox-gl';
import MapboxSketch from '@giszhc/mapbox-sketch';
import 'mapbox-gl/dist/mapbox-gl.css';

mapboxgl.accessToken = 'pk.xxxx';

const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/streets-v12',
});

map.on('load', () => {
  const tool = new MapboxSketch(map, {
    onChange: () => console.log('图形变了'),
    onWarn:  (msg) => console.warn(msg),
  });

  tool.draw('path');                                                    // 进入「路径文字」手绘
  tool.push('line', [[116.35, 39.94], [116.43, 39.94]], {}, 'my-line'); // 程序化加一条线
});

// 页面销毁时
// tool.destroy();  // 移除画布与全部事件监听，不动你的地图
```

**手势**：单击落点 → **双击**或**回车**完成 → **右键**撤销上一点 → **Esc** 取消。
悬停图形变红 → 点击进入编辑态出现顶点手柄 → 拖手柄调整、拖主体平移。

---

## MapboxSketch 主类

> 同时是 default 导出：`import MapboxSketch from '@giszhc/mapbox-sketch'`。

### 构造函数与选项

```ts
new MapboxSketch(map: mapboxgl.Map, options?: SketchOptions): MapboxSketch
```

| 参数 | 类型 | 说明 |
|---|---|---|
| `map` | `mapboxgl.Map` | 已加载完成的地图实例（必须支持 `project`） |
| `options` | `SketchOptions` | 见下表，全部可选 |

**`SketchOptions`**

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `style` | `Partial<Style>` | 合并到 `DEFAULT_STYLE` | 初始全局基础样式 |
| `defaultCfg` | `Partial<Cfg>` | 合并到 `DEFAULT_CFG` | 初始默认绘制配置 |
| `onChange` | `() => void` | — | 内部状态每次变化后回调（增删/聚焦/配置/绘制开关/拖拽结束），供外部 UI 同步 |
| `onWarn` | `(msg: string) => void` | — | 非致命提示（如落点不足） |
| `types` | `ShapeTypeCtor[]` | — | 额外注入的自定义类型构造器（亦可在运行时 `addType`） |
| `snap` | `SnapOptions` | 开启 + 12px | 手绘落点吸附（`{ enabled?, tol? }`）；不传即开启 |
| `pickImage` | `() => Promise<PickImageResult \| null>` | — | 「图片标注」选图回调，宿主弹文件框并读成 data URL；不传则该类型落不了图 |
| `createMap` | `(o: ExportMapOptions) => mapboxgl.Map` | `map.constructor` | 出图时另建隐藏地图的构造器；不传退回宿主那份 mapbox-gl |

```ts
const tool = new MapboxSketch(map, {
  style:      { pathColor: '#ff6b6b' },   // 初始样式（合并到默认之上）
  defaultCfg: { text: '默认文字' },        // 初始默认绘制配置
  onChange:   () => {},                   // 状态变化回调
  onWarn:     (msg) => {},                // 非致命提示
  types:      [MyShape],                  // 额外注入的自定义类型
  snap:       { tol: 12 },                // 手绘吸附
  pickImage:  async () => null,           // 「图片标注」弹文件框选图
  createMap:  (o) => new mapboxgl.Map(o as mapboxgl.MapOptions),  // 推荐：显式给
});
```

**`pickImage` 是「图片标注」唯一的宿主依赖**：库不碰文件 IO、不碰 DOM 文件框。单击地图时引擎回调它，宿主弹文件框、把图片读成 data URL 交回来。返回 `null` = 用户取消，引擎保持绘制态。

```ts
pickImage: async () => {
  const file = await pickFile();            // 宿主自己弹文件框
  if (!file) return null;                  // 用户取消
  const img = await loadImage(file);       // 宿主自己解码（大图顺手降采样）
  return { dataUrl: toDataURL(img), width: img.naturalWidth, height: img.naturalHeight };
},
```

### 静态成员

| 成员 | 签名 | 说明 |
|---|---|---|
| `MapboxSketch.registerType` | `(Type: ShapeTypeRegistrable) => void` | 静态注册类型（写自定义类型时在文件底部调用） |
| `MapboxSketch.registeredTypes` | `readonly ShapeTypeRegistrable[]` | 已静态注册的全部类型构造器 |

```ts
class MyShape extends MapboxShapeType { /* … */ }
MapboxSketch.registerType(MyShape);   // 全局静态注册
```

### 绘制与编辑

| 方法 | 签名 | 返回 | 说明 |
|---|---|---|---|
| `draw` | `(type: string) => void` | — | 开始手绘指定类型。类型未注册抛错；地图样式未加载完抛错。切换类型先干净退出上一个 |
| `cancel` | `() => void` | — | 取消当前进行中的手绘（Esc / 再点同一绘制按钮） |
| `isDrawing` | `() => string \| null` | 类型键 / `null` | 当前绘制中的类型键；未绘制返回 `null` |

```ts
tool.draw('path');     // 进入「路径文字」手绘
tool.isDrawing();      // 'path'
tool.cancel();         // 取消
tool.isDrawing();      // null
```

### 图形管理

| 方法 / 属性 | 签名 | 返回 | 说明 |
|---|---|---|---|
| `push` | `(type, coords, cfg?, id?, data?) => string` | 新图形 id | 程序化新增图形并聚焦。**合帧重绘**：循环灌一批只画一次 |
| `remove` | `(id: string) => void` | — | 按 id 删单个；不存在静默忽略 |
| `clear` | `() => void` | — | 清空所有图形（工具本身保留，可继续 `draw()`） |
| `focus` | `(id: string) => void` | — | 聚焦某图形（显示编辑手柄）；id 不存在或已隐藏则忽略 |
| `blur` | `() => void` | — | 退出编辑态（清空聚焦） |
| `getFocused` | `() => Shape \| null` | — | 取当前聚焦图形 |
| `has` | `(id: string) => boolean` | — | 查询某 id 是否存在 |
| `shapes` | `get` → `ReadonlyMap<string, Shape>` | — | 只读图形表 |
| `describe` | `(shape: Shape \| string) => string` | — | 一句话描述（传 id 或 Shape 对象） |

**`push` 参数**

| 参数 | 类型 | 说明 |
|---|---|---|
| `type` | `string` | 类型键（须已注册） |
| `coords` | `LngLat[]` | 顶点 `[ [lng, lat], ... ]`（未闭合；面类型首尾不重复） |
| `cfg` | `Partial<Cfg>` | 该图形专属配置，合并到默认之上（默认 = 全局默认 → 类型默认 → 本次） |
| `id` | `string` | 手动指定 id；缺省自动生成 `类型-序号`（序号是全局自增，想要稳定 id 就自己传） |
| `data` | `Record<string, ShapeDatum>` | **类型私有数据**（如图片标注的图片本体），拷一份存进 `shape.data`，不参与配置合并 |

```ts
tool.push('path', [[116.36, 39.94], [116.43, 39.94]], { nodes: ['甲', '乙'] }, 'my-path');
tool.push('point', [[116.40, 39.92]]);
tool.remove('my-path');
tool.clear();
```

> `data` **绝不能**塞进 `cfg`：`cfg` 的键会被 `config()` 写进全局默认供新图形继承，图片本体混进去会让以后新建的每条图片标注都带着上一张图。放 `data` 则天然只属于这一个图形。

### 配置（写什么）

| 方法 | 签名 | 返回 | 说明 |
|---|---|---|---|
| `config` | `(patch: Partial<Cfg>, opts?: { defaults?: boolean }) => void` | — | 改配置。`opts.defaults === false` 时只改聚焦图形、**不写全局默认**；缺省 = 既改聚焦图形又写全局默认（供下一个新图形继承） |

```ts
tool.config({ text: '新路名' });                            // 改聚焦图形 + 写全局默认
tool.config({ angle: 45 }, { defaults: false });           // 只改聚焦图形，不影响以后新建的
```

### 样式（长什么样）

| 方法 | 签名 | 返回 | 说明 |
|---|---|---|---|
| `setStyle` | `(patch: Partial<Style>) => void` | — | 改**全局基础样式**（只影响没有覆盖的图形） |
| `getStyle` | `() => Style` | 副本 | 取全局基础样式**只读副本** |
| `applyStyle` | `(patch: Partial<Style>, id?: string) => void` | — | 给**单个**图形加样式覆盖（缺省 = 聚焦图形） |
| `resetStyle` | `(id?: string) => void` | — | 清掉某图形的样式覆盖，回跟随全局 |
| `effectiveStyle` | `(id?: string) => Style` | 副本 | 取某图形最终生效样式（全局 → 类型默认 → 单图形覆盖 三层合并） |

```ts
tool.setStyle({ pathColor: '#0073ff' });                    // 全局：所有没有覆盖的线变蓝
tool.applyStyle({ pathColor: '#f00' }, 'line-1');          // 单条：line-1 单独变红
tool.effectiveStyle('line-1').pathColor;                  // '#f00'
tool.resetStyle('line-1');                                  // 清覆盖 → 回跟随全局 '#0073ff'
```

**样式三层**（后写的赢）：全局基础（`setStyle`）→ 类型专属默认（`defaultStyle()`）→ 单图形覆盖（`applyStyle` / 导入 JSON）。

> `previewColor` / `previewFill` / `snapColor` / `hoverColor` 是**全局项**：引擎从全局样式表读，`applyStyle()` 给单图形覆盖它们**静默无效**（不报错也不生效），只认 `setStyle()`。

### 几何参数（摆在哪儿）

| 方法 | 签名 | 返回 | 说明 |
|---|---|---|---|
| `getGeom` | `(id?: string) => GeomState \| null` | 几何 / `null` | 读某图形几何参数（缺省 = 聚焦图形） |
| `applyGeom` | `(patch: GeomPatch, id?: string) => boolean` | 是否真改了 | 按几何参数改某图形 |

```ts
tool.getGeom();                          // 聚焦那条
tool.getGeom('img-1');                   // 指定
tool.applyGeom({ rotateDeg: 90 });       // 改角度，缺省 = 聚焦那条
tool.applyGeom({ sizePx: 120 }, 'img-1');// 改尺寸
```

只有**图片标注**（角度 + 尺寸）与**文字标注 / 富文本标注**（只有角度）有几何可调。其它类型 `getGeom()` 返回 `null`、`applyGeom()` 返回 `false`。详见 [几何参数](#几何参数-1)。

### 显示与隐藏

隐藏 = **完全退出交互**：不画、不悬停命中、不当吸附目标、不可拖。只做「不画」是不行的——藏起来的图形还会截走点击。

| 方法 | 签名 | 说明 |
|---|---|---|
| `hide` | `(target: string \| string[]) => void` | 隐藏一个或一批 |
| `show` | `(target: string \| string[]) => void` | 显示一个或一批（`hide` 的逆操作） |
| `hideType` | `(type: string) => void` | 整类隐藏（如先关掉所有「距离标注」看清底图） |
| `showType` | `(type: string) => void` | 整类显示 |
| `isHidden` | `(id: string) => boolean` | 该图形是否被隐藏（只看自己的开关，不含全局总开关） |
| `setVisible` | `(on: boolean) => void` | 全局「显示标注」总开关 |
| `visible` | `get` → `boolean` | 总开关当前是否开着 |

```ts
tool.hide('line-3');                       // 藏一条
tool.hide(['line-3', 'area-7']);           // 藏一批（一次重绘、一次 onChange）
tool.hideType('distance');                 // 整类关掉
tool.show('line-3');                      // 放回来（数据原样）
tool.setVisible(false);                   // 全局全关
tool.visible;                             // false
```

隐藏状态是**图形数据**（`shape.hidden`），能跟着数据存后端、回灌。`push()` 是合帧的，**同一帧里 push + hide 不会先闪一下**：

```ts
rows.forEach((r) => {
  const id = tool.push(r.type, r.coords, r.cfg, r.id);
  if (r.hidden) tool.hide(id);           // 排的是同一帧，图形从未出现过
});
```

> `setVisible(false)` 是**视图开关**，从不写回 `shape.hidden`——关掉再打开，原先被单独隐藏的那些仍然是隐藏的。

### 编辑交互开关

| 方法 / 属性 | 签名 | 说明 |
|---|---|---|
| `setEditing` | `(on: boolean) => void` | 编辑开关。`true`（默认）= 点击图形进入编辑、显示手柄、可拖；`false` = 纯浏览态，点图形不选中、不出手柄、不可拖改 |
| `editing` | `get` → `boolean` | 当前是否允许编辑 |
| `dragging` | `get` → `boolean` | 是否正在拖拽 |
| `setInteractive` | `(on: boolean) => void` | 指针交互总开关。`false` = 完全让出指针（不落点、不选中、不拖拽、不响应 Esc/回车），已画图形照常显示。**同一张地图跑两个实例**时让不参与的实例关掉它 |
| `interactive` | `get` → `boolean` | 当前是否响应指针 / 键盘 |

```ts
tool.setEditing(false);   // 纯浏览态
tool.editing;             // false
tool.setInteractive(false); // 让出指针（测量工具开始测量时用）
```

编辑开关只影响**画布上点按的编辑交互**，不影响 `push()` / `applyStyle()` / `remove()` 这类 API。

### 绘制吸附

| 方法 / 属性 | 签名 | 说明 |
|---|---|---|
| `setSnap` | `(on: boolean) => void` | 吸附开关。`true`（默认）= 手绘落点自动吸到已有图形顶点 / 边线 / 当前图形已落点；按住 Alt 临时关 |
| `snapping` | `get` → `boolean` | 当前是否开启（容差走构造选项 `snap.tol`，默认 12px） |

```ts
const tool = new MapboxSketch(map, { snap: { tol: 8 } });   // 不传 = 开启 + 12px
tool.setSnap(false);                                        // 运行时关掉
tool.snapping;                                              // false
```

只管**手绘**；已提交图形的拖拽编辑不受影响。自由手绘不带吸附。

### 类型注册

| 方法 | 签名 | 返回 | 说明 |
|---|---|---|---|
| `addType` | `(def: ShapeTypeCtor \| MapboxShapeType) => MapboxShapeType` | 类型实例 | 运行时追加类型（传子类构造器或已实例化的对象）。注册后 `tool.draw(def.key)` / `tool.push(def.key, …)` 即可用 |
| `getType` | `(key: string) => MapboxShapeType \| null` | — | 取某个已注册类型实例（要调它的自定义方法时用） |
| `typeLabel` | `(key: string) => string` | — | 类型中文名（UI 列表用） |
| `typeHint` | `(key: string) => string` | — | 绘制提示 HTML（落点手势说明） |

```ts
tool.addType(MyShape);
tool.typeLabel('myShape');   // '我的标注'
tool.typeHint('myShape');    // '单击地图依次落点；双击或回车完成；Esc 取消。'
```

### 数据存档

| 方法 | 签名 | 返回 | 说明 |
|---|---|---|---|
| `exportJSON` | `(space?: number) => string` | JSON 文本 | 全局样式 + 全部图形 → JSON 文本。`space` 默认 2（缩进），传 0 得一行 |
| `importJSON` | `(data: string \| SketchData) => ImportResult` | 结果 | **追加合并**导入（字符串或已解析对象）。地图上已有的图形一条不动，文件里的接在后面；id 撞了自动换新号 |

```ts
const text = tool.exportJSON();               // 缩进 2
localStorage.setItem('sketch', text);
const r = tool.importJSON(localStorage.getItem('sketch')!);
r.added;     // 成功导入几条
r.ids;       // 实际分配到的 id（要用这个，别用文件里写的）
r.skipped;   // 跳过几条
r.styled;    // 文件里的全局样式跟本机不同、已盖上去了
r.warnings;  // 每条跳过的中文原因
```

数据外壳与字段见 [数据格式](#数据格式)。

### 图片导出

```ts
const r = await tool.exportImage({
  format: 'png',        // 'png'（默认，带透明）| 'jpeg'
  dpi: 300,             // 默认 96 = 屏幕上 1:1
  paper: { size: 'A4' },// 不给 = 跟随视口；给了就按纸张取景
  background: '#ffffff',// JPEG 底色
  hdBasemap: true,      // 默认 true = 高清底图（要另下更深一级瓦片，慢）；false = 用当前层级
  onProgress: (msg, info) => { /* 中文进度 + 结构化进度 */ },
});
```

详见 [图片导出详解](#图片导出详解)。

### 渲染与生命周期

| 方法 / 属性 | 签名 | 说明 |
|---|---|---|
| `render` | `() => void` | 立即重绘（测试 / 初始化用） |
| `requestRender` | `() => void` | 请求合帧重绘（同帧内多次调用只画一次） |
| `destroy` | `() => void` | 销毁：移除画布与全部事件监听、恢复地图双击缩放与平移、清空内部状态。调用后不可再用，地图不受影响 |
| `destroyed` | `get` → `boolean` | 是否已销毁 |

```ts
tool.requestRender();   // 改了数据后请求重绘
tool.destroy();
tool.destroyed;         // true
```

---

## MapboxSketchMeasure 测量工具

不想自己搭面板、只要「测距 / 测面」两枚按钮的量算能力，用这个开箱即用的门面。它内部自持一个**独立**的 `MapboxSketch` 实例（复用内置的「距离 / 面积标注」），与页面里已有的标注引擎互不污染对方的图形表和样式。

> 只从主出口 `@giszhc/mapbox-sketch` 导出，不进 `core`（它依赖内置的 `distance` / `area` 两个类型）。

```ts
import { MapboxSketchMeasure } from '@giszhc/mapbox-sketch';

const measure = new MapboxSketchMeasure(map, {
  style:    { pathColor: '#0073ff' },   // 测量结果的全局样式（一份，没有单条面板）
  snap:     { tol: 12 },                // 手绘吸附（同引擎级能力）
  onChange: () => {},                   // 开始/结束测量、出结果、清除时回调
  onWarn:   (msg) => {},                // 非致命提示
});

measure.distance();                      // 开始测距（单击落点，双击/回车完成，右键撤销，Esc 取消）
measure.area();                          // 开始测面（自动闭合，边中点标边长，形心标面积/周长）
measure.cancel();                        // 取消进行中的测量（已出的结果保留）
measure.clear();                         // 清空全部测量结果（工具保留，可继续测）
measure.setStyle({ pathWidth: 4 });      // 动态改全局样式
measure.destroy();                       // 销毁
```

| 方法 / 属性 | 签名 | 说明 |
|---|---|---|
| `distance` | `() => void` | 开始测距 |
| `area` | `() => void` | 开始测面 |
| `cancel` | `() => void` | 取消进行中的测量（已出结果保留） |
| `clear` | `() => void` | 清空全部测量结果 |
| `setStyle` | `(patch: Partial<Style>) => void` | 动态改全局样式 |
| `isMeasuring` | `() => MeasureKind \| null` | `'distance'` / `'area'` / `null` |
| `results` | `ReadonlyMap<string, Shape>` | 已出的结果（就是普通的 distance / area 图形） |
| `count` | `number` | 条数 |
| `destroy` | `() => void` | 销毁 |

测量文字出厂即**白字黑边**（`MEASURE_TEXT_COLOR` / `MEASURE_HALO_COLOR`），影像底图上比蓝字白边清楚。测距文字不一样：起点标「开始」、终点标「总长：xx米 / xx公里」，中间拐点标累计里程。测量不画密集刻度（`ticks` 默认 `false`），测量数据不进标注导出。

**和标注引擎共处一张地图时**：开始测量前 `tool.setInteractive(false)`，测量结束（`isMeasuring()` 回到 `null`）再开回来——否则测量期间的每次点击会被两套引擎同时解读。

---

## MapboxShapeType 类型基类

写自己的标注类型就继承它。完整规范见仓库 `AGENTS.md`。

```ts
import { MapboxSketch, MapboxShapeType, paint } from '@giszhc/mapbox-sketch';
import type { DrawSession, Shape } from '@giszhc/mapbox-sketch';

class MyShape extends MapboxShapeType {
  get key() { return 'myShape'; }
  get label() { return '我的标注'; }
  render(shape: Shape) {
    const st = this.styleFor(shape);        // 全局样式 + 该图形覆盖 + 悬停变色
    const Pts = this.projectPts(shape);     // 同帧内带缓存的投影
    paint.strokePolyline(this.ctx!, Pts, st.pathColor, st.pathWidth, null, st.lineOpacity);
  }
  preview(draw: DrawSession) { /* 手绘预览，可选 */ }
}
MapboxSketch.registerType(MyShape);
```

### 必需成员

| 成员 | 类型 | 说明 |
|---|---|---|
| `key` | `get → string` | 类型唯一键，全局不重复 |
| `label` | `get → string` | 中文名（UI 列表 / 提示用） |
| `minPts` | `get → number` | 完成绘制所需的最少落点数（默认 2） |
| `closesRing` | `get → boolean` | 完成时是否自动首尾闭合（面类为 `true`，默认 `false`） |
| `autoCommit` | `get → boolean` | 落点数达到 `minPts` 就自动完成并退出绘制（如「点」单击即成，默认 `false`） |
| `freehand` | `get → boolean` | 是否走**自由手绘**（两击一笔：单击起点 → 移动描摹 → 再单击完成，默认 `false`） |
| `hint` | `get → string` | 绘制提示条里的按键说明（可以是 HTML） |
| `cfgKeys` | `() => CfgKey[]` | 该类型会用到的 cfg 键（决定 `config()` 能把哪些面板项应用上来） |
| `render` | `(shape: Shape) => void` | 渲染一个已提交的图形 |

### 可选钩子

| 钩子 | 签名 | 默认 | 说明 |
|---|---|---|---|
| `defaultCfg` | `() => Partial<Cfg>` | `{}` | 类型专属默认配置（如「引线标注」让新图形 text 默认是「引线标注」） |
| `defaultStyle` | `() => Partial<Style>` | `{}` | 类型专属默认样式，叠在全局之上、本图形覆盖之下。只作用于本类型 |
| `normalize` | `(raw: LngLat[]) => LngLat[]` | 原样返回 | 落点完成后的二次整理（框架已先做去重/封口） |
| `preview` | `(draw: DrawSession) => void` | noop | 绘制进行中的预览 |
| `hitTest` | `(shape, x, y, Pts, tol) => boolean \| undefined` | `undefined` 走引擎默认 | 自定义「光标是否命中图形本体」。只有「存储顶点很少、却渲染出更多几何」的类型才需要 |
| `handles` | `(shape: Shape) => ScreenPoint[]` | `projectPts(shape)` | 各支手柄的屏幕位置。允许返回比 `pts` 长——多出来的下标是**派生手柄**（图片标注四个角都有缩放柄，而它只存两个角） |
| `describe` | `(shape: Shape) => string` | 引擎拼 `标签 · n 顶点` | 列表行里的一句话描述 |
| `cullMargin` | `(shape: Shape) => number` | `0` | 渲染内容可能超出「存储顶点包围盒」的像素数（供视口剔除留安全边距）。内容画在顶点之外时**必须**实现 |
| `place` | `(ctx: PlaceContext) => Promise<PlaceResult \| null>` | — | **异步落图**。实现了它的类型，单击地图时引擎调它、单击不再直接落点。返回 `null` = 用户取消，保持绘制态 |
| `dragTo` | `(ctx: DragContext) => boolean` | `false` | 拖拽中由类型自己算几何。返回 `true` = 引擎不再写 `pts`（既不做顶点跟随也不做整体平移）。只有「引擎默认那两下是错的」类型才需要 |
| `whenReady` | `(shape: Shape) => Promise<void> \| null` | `null` | 本图形还有没有异步资源没就绪（典型是没解码完的图片）。`exportImage()` 出图前 `await` 它。没异步资源的类型**别实现** |
| `vertexCursor` | `(shape, vi) => string \| null` | `null` | 光标压在第 `vi` 个顶点手柄上时该显示的鼠标样式。现成两款：`rotateCursor()` / `scaleCursor(rad)` |
| `drawHandles` | `(shape, hoverVi) => boolean` | `false` | 本图形自己画顶点手柄。返回 `true` = 引擎不再画通用白点。`hoverVi` 是此刻压着的顶点下标（没压着 = `-1`），压着的那一支要画成激活态 |
| `readGeom` | `(shape: Shape) => GeomState \| null` | `null` | 读这条图形的几何参数（`tool.getGeom()` 走它）。没「可调几何」返回 `null` |
| `writeGeom` | `(shape, patch: GeomPatch) => boolean` | `false` | 按几何参数改这条图形（`tool.applyGeom()` 走它）。返回 `true` = 真改了。★ 算几何那段要和 `dragTo` 共用同一份算式 |

### 宿主接口（`this` 上的可用资源）

继承 `MapboxShapeType` 后，在 `render` / 钩子里通过 `this` 访问：

| 成员 | 类型 | 说明 |
|---|---|---|
| `this.ctx` | `CanvasRenderingContext2D \| null` | 画布 2D 上下文 |
| `this.map` | `mapboxgl.Map`（只读） | 地图实例（投影用） |
| `this.style` | `Style \| null`（只读） | 全局基础样式对象（无覆盖未悬停时 `styleFor` 返回的就是它，**只读勿改**） |
| `this.styleFor(shape)` | `=> Style` | 取某图形最终生效样式（全局 → 类型默认 → 覆盖 → 悬停变色） |
| `this.project(ll)` | `=> ScreenPoint` | 经纬度 → 屏幕坐标（单点） |
| `this.projectPts(shape)` | `=> ScreenPoint[]` | 同帧内带缓存的批量投影（**用它别用 `shape.pts.map(this.project)`**） |
| `this.requestRender()` | `=> void` | 请求合帧重绘（别直接调 `render()`） |
| `this.pickImage()` | `=> Promise<PickImageResult \| null>` | 走宿主的选图回调（图片标注用） |
| `this.isHovered(shape)` | `=> boolean` | 该图形是否正被悬停 |
| `this.isFocused(shape)` | `=> boolean` | 该图形是否正被聚焦 |

> `styleFor(shape)` 在无覆盖且未悬停时返回**全局样式对象本身**，是只读的，别改。

---

## 41 种内置类型一览

下表 `type` 即 `tool.draw(type)` / `tool.push(type, …)` 用的键。

| type | 名称 | 画法 |
|---|---|---|
| `point` | 点标注 | 单击即成（`autoCommit`），圆点 |
| `text` | 文字标注 | 单击即成，文字块以落点为中心、可多行（`\n`）、可绕中心旋转 |
| `richText` | 富文本标注 | 同 `text`，但一行里可有若干段、各段自己的字号/颜色/加粗/高亮（见[富文本标签](#富文本行内标签语法)） |
| `line` | 折线标注 | 纯折线 |
| `curve` | 曲线标注 | 同折线落点，拐点被 Catmull-Rom 自动圆滑 |
| `freeLine` | 自由线标注 | 两击一笔（单击起点 → 移动描摹 → 再单击完成） |
| `railway` | 铁路标注 | 钢轨 + 枕木 |
| `border` | 国界/境界标注 | 点划线 |
| `powerline` | 高压线标注 | 导线 + 杆塔 |
| `pipeline` | 管道/光缆标注 | 双线（等距平行） |
| `polygon` | 多边形标注 | 淡填充 + 轮廓 |
| `freeArea` | 自由面标注 | 两击一笔圈出一块区域 |
| `rect` | 矩形标注 | 两击定对角，沿经纬线对齐 |
| `flag` | 标志旗标注 | 两击成形，杆永远竖直 |
| `flagTri` | 三角标志旗标注 | 两击成形，三角旗面 |
| `flagWave` | 曲线标志旗标注 | 两击成形，波浪带旗面 |
| `circle` | 圆形标注 | 两击：圆心 + 圆周点 |
| `ellipse` | 椭圆标注 | 两击定外接矩形对角 |
| `sector` | 扇形标注 | 三击：圆心 + 起始边 + 终止边 |
| `assembly` | 集结地标注 | 三击，四段三次贝塞尔 |
| `closedCurve` | 闭合曲面标注 | 逐点落点，闭合曲线围面 |
| `doubleArrow` | 双箭头标注 | 四击，钳击箭头 |
| `fineArrow` | 细直箭头标注 | 两击，单尖头闭合多边形 |
| `straightArrow` | 直箭头标注 | 两击，矩形杆 + 三角头 |
| `assaultDirection` | 突击方向标注 | 两击，同 fineArrow 换比例 |
| `attackArrow` | 进攻方向标注 | 多点，带箭头绸带 |
| `tailedAttackArrow` | 进攻方向尾标注 | 同上 + 燕尾 |
| `squadCombat` | 分队战斗行动标注 | 多点，带箭头绸带 |
| `tailedSquadCombat` | 分队战斗行动尾标注 | 同上 + 燕尾 |
| `lune` | 弓形面标注 | 三击，三点定圆的弓形面 |
| `arc` | 弧线标注 | 三击，三点定圆的一段圆弧 |
| `parallel` | 平行线标注 | 三击，基准线 + 平移副本 |
| `perpendicular` | 垂直线标注 | 三击，基准线 + 中点立起的垂直线 |
| `annulus` | 圆环标注 | 三击，同心双圆围出的环带 |
| `bubble` | 气泡标注 | 单击即成，白底圆角气泡 + 指向落点的小尾巴 |
| `image` | 图片标注 | 单击选图贴上，拖角等比改大小、拖内平移、拖圆柄旋转 |
| `path` | 路径文字 | 可平滑折线 + 沿线均布/自然字距文字 |
| `distance` | 距离标注 | 折线，拐点标累计里程 + 密集刻度 |
| `area` | 面积标注 | 闭合面，边中点标边长 + 形心「面积/周长」 |
| `leader` | 引线标注 | 单击定锚点，两段引线 + 恒水平文字（`text/angle/len`） |
| `leaderCoord` | 坐标引线标注 | 同引线几何，文字 = 锚点经纬度度分秒两行 |

里程 / 边长 / 面积 / 周长都是**真实测地距离**（按经纬度算），缩放平移不变、保留 2 位小数。

> **「贴地」口径**：凡是面 / 形状 / 装饰图案类标注，几何在地理空间定义、再逐点投影——地图倾斜 / 旋转时跟着地面走真实透视。例外是点状符号（`point` / `text` / `richText` / `bubble` / `image` / `leader`）：它们是屏幕尺寸的图形记号，倾斜 / 旋转时只跟着锚点走、形状不变。

---

## Style 样式键全集（21 键）

`DEFAULT_STYLE` 的全部键。`setStyle()` 改全局，`applyStyle()` 覆盖单个图形。

| 键 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `pathColor` | `string` | `'#0073ff'` | 路径线 / 多边形轮廓颜色 |
| `pathWidth` | `number` | `3` | 轮廓线宽（px） |
| `lineOpacity` | `number` | `1` | 轮廓不透明度（1 = 实色） |
| `lineType` | `LineType` | `'solid'` | 线型：`solid` / `dashed` / `dotted` / `dashDot` / `dashDotDot` / `longDash` / `shortDash` |
| `polygonFill` | `string` | `'rgba(255,255,0,0.3)'` | 面内淡填充（点 / 线不画面，用不到） |
| `textColor` | `string` | `'#1463ad'` | 沿线文字 / 引线文字颜色 |
| `textSize` | `number` | `15` | 沿线文字字号（px） |
| `haloColor` | `string` | `'rgba(255,255,255,0.95)'` | 文字 / 标注白描边颜色 |
| `haloWidth` | `number` | `2` | 文字描边宽度（px）；**0 = 不描边**。沿线文字 / 途经点 / 引线 / 边长 / 面积 / 里程共用 |
| `bgColor` | `string` | `'#ffffff'` | 富文本**整条标注**的背景底色；`''` = 不垫底。只作用于 `richText` |
| `bgRadius` | `number` | `4` | 整块背景的圆角半径（px）；0 = 方角 |
| `vertexColor` | `string` | `'#1463ad'` | 边长 / 里程文字颜色 |
| `pointColor` | `string` | `'#0073ff'` | 「点」类型圆点填充色 |
| `nodeColor` | `string` | `'#1463ad'` | 途经点短标注颜色 |
| `areaColor` | `string` | `'#1463ad'` | 多边形中心「面积」文字颜色 |
| `previewColor` | `string` | `'#e67e22'` | 手绘预览（虚线/落点）颜色 ⚠️ 全局项 |
| `previewFill` | `string` | `'rgba(230,126,34,0.16)'` | 手绘多边形预览淡填充 ⚠️ 全局项 |
| `pointRadius` | `number` | `6` | 「点」类型圆点半径（px） |
| `tickPos` | `TickPos` | `'top'` | 密集刻度位置：`'top'` / `'middle'` / `'bottom'`（距离 / 面积标注用） |
| `hoverColor` | `string` | `'#ff0000'` | 悬停时本体临时染色 ⚠️ 全局项 |
| `snapColor` | `string` | `'#1463ad'` | 吸附命中记号填充色（白描边固定） ⚠️ 全局项 |

> ⚠️ 标「全局项」的 4 个键：引擎从全局样式表读，`applyStyle()` 给单图形覆盖它们**静默无效**，只认 `setStyle()`。

```ts
// LineType 取值
type LineType = 'solid' | 'dashed' | 'dotted' | 'dashDot'
              | 'dashDotDot' | 'longDash' | 'shortDash';
```

---

## Cfg 配置键全集（9 键）

`DEFAULT_CFG` 的全部键。每个图形最终的 cfg = 全局默认 → 类型默认 → 本次显式传入。

| 键 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `text` | `string` | `'路径文字'` | 路径沿线文字 / 引线标注文字（类型不同含义不同） |
| `spread` | `'spread' \| 'tight'` | `'spread'` | 沿线文字分布：`spread` 平均铺满全线 / `tight` 紧凑自然字距（仅「路径文字」用） |
| `smooth` | `boolean` | `true` | 是否平滑曲线（仅「路径文字」用） |
| `showLine` | `boolean` | `true` | 是否画轮廓线（路径文字 / 面 / 面积标注用） |
| `showNodes` | `boolean` | `false` | 是否画途经点短标注（「路径文字」用，需配合 `nodes`） |
| `nodes` | `string[]` | `[]` | 途经点标注文字数组（与各顶点一一对应） |
| `angle` | `number` | `330` | 引线方向角度°（0~360 连续，顺时针：0=右 90=下 180=左 270=上） |
| `len` | `number` | `60` | 引线第一段长度（px） |
| `ticks` | `boolean` | `true` | 是否画密集刻度（距离 / 面积标注用；测量工具覆写成 `false`） |

---

## 几何参数

与样式（长什么样）、配置（写什么）是三套互不相干的东西：几何管「此刻摆在哪儿 / 多大 / 多斜」。

```ts
type GeomKey = 'rotateDeg' | 'sizePx';

interface GeomPatch {
  /** 旋转角度（度）：0 = 正放，顺时针为正 */
  rotateDeg?: number;
  /** 尺寸（屏幕像素）：等比图形给的是长边，短边按比例走 */
  sizePx?: number;
}

interface GeomState {
  /** 旋转角度（度）：0 = 正放，顺时针为正，落在 [0, 360) */
  rotateDeg: number;
  /** 尺寸（屏幕像素）：等比图形给的是长边。★ 可选：只有「尺寸本身可调」的类型才给 */
  sizePx?: number;
}
```

| 键 | 谁有 | 含义 |
|---|---|---|
| `rotateDeg` | 图片标注 / 文字标注 / 富文本标注 | 旋转角度。0 = 正放，顺时针为正，归一化到 `[0, 360)`。与拖圆柄是同一件事 |
| `sizePx` | 只有图片标注 | 图片长边在屏幕上的像素长度（短边按原比例走，锁等比）。与拖角改大小是同一件事 |

三条口径：
- **改中心不动**：图片绕自己中心转 / 缩；文字绕自己锚点转。
- **不参与继承**：几何不进全局默认，新画的图形不继承上一条的角度 / 尺寸。
- **没有「恢复默认」**：没有覆盖 / 未覆盖之分，`resetStyle()` 管不着它。

---

## 数据格式

`exportJSON()` / `importJSON()` 的文件外壳。`app` 与 `version` 是数据契约（`app` 固定为 `'mapbox-sketch'`，与 npm 包名是两回事；`version` 当前为 `6`）。

```jsonc
{
  "app": "mapbox-sketch",
  "version": 6,
  "style": { /* 全局基础样式，21 个键完整写出 */ },
  "shapes": [
    {
      "id": "curve",                    // 原样带回；被占用时导入端自动换新号
      "type": "path",
      "pts": [[116.3632, 39.941]],      // [lng, lat][]，与 Shape.pts 同口径
      "cfg": { /* Cfg 的 9 个键，完整写出 */ },
      "style": { "pathColor": "#0af" }, // 该图形自己的样式覆盖；null = 跟随全局
      "hidden": false,                  // 固定写出
      "data": { /* 类型私有数据，可选；如图片标注的图片本体 */ }
    }
  ]
}
```

- **导入是追加合并**：已有图形一条不动，文件里的接在后面；id 撞了自动换新号。想「整份还原」就 `clear()` 再 `importJSON()`。
- **抛错 vs 跳过**：整份文件用不了（不是 JSON / 不是对象 / 没有 `shapes` / `app` 对不上 / `version` 高于当前）→ **抛错**，抛之前一个字段都不改；壳没问题、只是某条成不了图形 → **跳过那一条**，其余照常导入。
- **结果在返回值里**，不在 `onWarn` 上（批量坏数据会有几十条提示，逐条调 `onWarn` 只会刷成最后一条）。

```ts
interface ImportResult {
  added: number;      // 成功导入几条（含被改过 id 的）
  skipped: number;    // 跳过几条
  ids: string[];      // 实际分配到的 id —— 要用这个，别用文件里写的
  styled: boolean;    // 文件里的全局样式跟本机不同、已盖上去了
  warnings: string[]; // 每条跳过的中文原因（含「id 被占用，已改为 x」）
}
```

不进文件的只有两样：**默认绘制配置**（每张图形的 `cfg` 本来就是完整的）与**「显示标注」总开关**（那是视图状态）。

> 改字段（或改某个字段的含义）必须同时 +1 `src/lib/constants.ts` 的 `SKETCH_DATA_VERSION`，否则新旧版本之间会静默丢字段而不是报错。

---

## 图片导出详解

把**取景范围**连底图带标注导成一张图（打印 / 汇报用）。取景范围默认是当前视口（所见即所得），也可指定 A0–A6 纸张。**相机一动不动**。

### ExportImageOptions

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `format` | `'png' \| 'jpeg'` | `'png'` | 图片格式。`png` 带透明通道；`jpeg` 体积小但没透明 |
| `dpi` | `number` | `96` | 目标打印分辨率。96 = 屏幕上 1:1。常用 96 / 150 / 200 / 300 / 400 / 500 / 600。输出像素 = 取景范围 CSS 尺寸 × `dpi / 96` |
| `paper` | `PaperSpec \| null` | `null` | 纸张模式。不给 = 跟随视口；给了按纸张取景 |
| `cell` | `ExportCell \| null` | `null` | 分块导出：只要取景范围里的第几块。一般直接用 `planExportTiles()` 的 `tile.cell` |
| `background` | `string` | `'#ffffff'` | JPEG 底色（JPEG 没透明通道） |
| `hdBasemap` | `boolean` | `true` | 底图要不要按**高清**导出。`false` = 拿屏幕上**当前层级**的瓦片放大，不再去下更深一级 —— 快，但底图详略度停在这一级。**只影响底图**，标注层两档都按 `dpi/96` 真·重渲染 |
| `transformStyle` | `(style) => style` | — | **样式变换钩子**：建隐藏导出地图前对样式副本做最后一步变换（在 `hdBasemap` 的 maxzoom 压制之后调用）。导出靠「容器放大 + zoom 抬 `log2(dpi/96)`」放大地理内容，但 style 里 `line-width` / `icon-size` / `text-size` 这类**屏幕像素单位不跟着放大** —— 外部通过 style 图层加载的专题标注，高 dpi 下要自己在这里乘 `dpi/96`。必须返回**新对象**（不许改入参：`getStyle()` 与活地图内部共享同一份），且只应依赖已进整张缓存指纹的量（如 `dpi` / `paper`） |
| `margin` | `number \| Partial<ExportMargin>` | — | **图廓外边距**（CSS 像素）：在地图外面留一圈边画图框 / 白边 / 指北针 / 图例。给了就把画布放大、并铺 `background` 底色。见[图廓整饰](#图廓整饰专题图) |
| `decorate` | `(ctx, info) => void` | — | **整饰绘制回调**：地图贴完、编码之前调用一次。参数几何全是**输出像素**且已算好（`info.map` = 地图区矩形）。抛错即整次导出失败 |
| `onProgress` | `(msg: string, info: ExportProgress) => void` | — | 进度回调（中文文案 + 结构化进度）。★ 高清导出不是瞬时的，不显示进度用户会以为卡了 |

> JPEG 质量固定为 1（导出是拿去打印 / 汇报的，不该为省体积在文字笔画和细线上留伪影）。

#### 底图清晰度：`hdBasemap`

高清是**拿时间换清晰度**：引擎另建一张隐藏地图、把 zoom 抬高 `log2(dpi/96)`，于是 mapbox 去抓更深一级的瓦片 —— 300dpi 常常要另下一百多块，几秒到几分钟都正常。

```ts
await tool.exportImage({ dpi: 300 });                    // 默认：高清（该等就等）
await tool.exportImage({ dpi: 300, hdBasemap: false });  // 快档：底图停当前层级
```

`false` 时底图的差别：栅格底图会发虚；矢量底图的注记仍清晰（mapbox 会对瓦片做 overzoom 重绘文字），但路网 / 面要素会变稀。**输出尺寸、取景范围、分块规划、倾斜补偿全都一样** —— 这个选项只改「底图从哪来」。

### ExportImageResult

| 字段 | 类型 | 说明 |
|---|---|---|
| `blob` | `Blob` | 图片数据。**dpi 已写进文件本体**（PNG `pHYs` / JPEG `JFIF`），丢进 PS / Word 显示的就是 `dpi` 那个值 |
| `width` | `number` | 像素宽。传了 `margin` 时是**整页**宽（含四边外边距） |
| `height` | `number` | 像素高。口径同 `width` |
| `mapRect` | `{ x, y, w, h } \| undefined` | 地图区在整页画布上的矩形（输出像素）。**只在传了 `margin` 时给出** |
| `dpi` | `number` | 实际生效 dpi。不夹取，正常 = 请求值（请求值非法时退回 96） |
| `mime` | `string` | 实际 MIME，如 `'image/png'` |
| `baseDrawn` | `boolean` | 底图有没有真画进来。`false` = 成品里只有标注层 |
| `warnings` | `string[]` | 中文告警；正常为空 |

### 纸张（A0–A6）

```ts
await tool.exportImage({ dpi: 300, paper: { size: 'A4' } });                            // A4 纵向（默认方向）
await tool.exportImage({ dpi: 300, paper: { size: 'A1', orientation: 'landscape' } }); // A1 横向
```

口径是「**纸张为准、保持屏幕比例尺**」：屏幕上 1 CSS 像素对应多少米，纸上就是多少米。**纸上一毫米 = `96/25.4 ≈ 3.7795` 个屏幕 CSS 像素的地理范围**，与 dpi 无关。

| PaperSpec | 说明 |
|---|---|
| `size` | `'A0'` … `'A6'`。不认识的退回跟随视口（不抛错，记进 `warnings`） |
| `orientation` | `'portrait'`（默认）/ `'landscape'`。非法值按纵向 |

`PAPER_SIZES`：全部纸张的规格表（mm）。`mmToCssPx(mm)`：毫米 → CSS 像素。`paperFrame(...)`：算纸框在屏幕上的位置 / 尺寸。

### 分块导出（大图）

大纸（A0 / A1）在高 dpi 下整张会撞浏览器画布上限（单边约 16384、面积约 2.68 亿像素）。切成 N 张完整小纸，每张是一次正常独立的导出。**切几块是算出来的，不由用户选**。

```ts
import {
  autoPaperGrid, autoViewportGrid, TILE_PIXEL_BUDGET,   // 自动分块
  planExportTiles, paperGrid,                            // 逐块规划
} from '@giszhc/mapbox-sketch';

TILE_PIXEL_BUDGET;   // 3.5e7 —— 每块的像素预算

const g = autoPaperGrid({ size: 'A0', orientation: 'landscape' }, 300);
// → { k, cols, rows, count, block: 'A2', wholeW, wholeH, tileW, tileH, warnings }
// g && g.count > 1 就是要走分块

const tiles = planExportTiles({
  cssW: 1920, cssH: 1080, dpr: 1, dpi: 300,
  paper: { size: 'A0', orientation: 'landscape' },
  cols: g.cols, rows: g.rows,
});
for (const t of tiles.tiles) {
  const r = await tool.exportImage({ format: 'png', dpi: 300, cell: t.cell });
  // r.blob 是第 t.index+1 块
}
```

| 函数 | 签名 | 说明 |
|---|---|---|
| `autoPaperGrid` | `(paper: PaperSpec, dpi: number) => AutoGrid \| null` | 按纸张 + dpi 算最省的分块。`null` = 判断不了（没给纸张 / 不认识 / dpi 脏）；`count === 1` = 不用切（是个结论） |
| `autoViewportGrid` | `(cssW, cssH, dpi) => AutoGrid \| null` | 跟随视口的分块（4K @600 也会切） |
| `paperGrid` | `(paper: PaperSpec, cols, rows) => PaperGrid` | 按指定块纸型切（手动选块纸型用） |
| `planExportTiles` | `(input: ExportGridInput) => ExportGrid` | 逐块算好规划（每块的 `cell` 喂给 `exportImage` 的 `cell` 选项） |
| `TILE_PIXEL_BUDGET` | `number`（3500 万） | 每块的像素预算 |

合并 N 张大图成一张：仓库 `server/` 那个 Node 服务，详见 `server/README.md`。

### 图廓整饰（专题图）

专题图 / 打印图上，地图外面还有一圈东西：**图框、白边、指北针、图例、图名**。它们不在取景范围里，所以出图时画布要比地图区大一圈 —— 这就是 `margin`（留边）+ `decorate`（画装饰）。

**为什么不自己拿成品图再合成一张**：`canvas.toBlob()` 出来的 PNG / JPEG **不带分辨率信息**，dpi 是引擎在编码前写进文件本体的。宿主自己合成就丢掉了这一步（打印出来又变成 72dpi）。所以在引擎的合成画布上画。

单位口径：`margin` 是 **CSS 像素**，与纸张那套「纸上一毫米 = 96/25.4 个 CSS 像素」同一个量纲 —— 「外框 3px」在 96dpi 与 300dpi 下出图都一样宽（各乘 `dpi/96`），与屏幕上的预览逐像素一致。

```ts
// 一张 420×297mm 的纸：外框 3px 纯黑 + 白边 10px + 地图 1px 纯黑框
const M = 13;                       // 3 + 10（CSS 像素）
const r = await tool.exportImage({
  dpi: 300,
  paper: { size: 'A3', orientation: 'landscape' },
  margin: M,                        // 也可以写成 { top, right, bottom, left }
  decorate: (ctx, g) => {
    const s = g.scale;              // 输出像素 ÷ CSS 像素（= dpi / 96），别自己算

    // ① 外框：3 CSS 像素纯黑，画在纸张边界内（描边中心线落在 1.5s 处）
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3 * s;
    ctx.strokeRect(1.5 * s, 1.5 * s, g.width - 3 * s, g.height - 3 * s);

    // ② 地图 1px 纯黑框：g.map 就是地图区在整页上的矩形
    ctx.lineWidth = 1 * s;
    ctx.strokeRect(g.map.x, g.map.y, g.map.w, g.map.h);

    // ③ 指北针 / 图例：`g.map` 给的是地图区，往内偏移即可
    ctx.fillStyle = '#c00';
    ctx.fillRect(g.map.x + 12 * s, g.map.y + g.map.h - 40 * s, 16 * s, 16 * s);
  },
});
r.width;      // 整页像素宽（含四边外边距）
r.mapRect;    // { x: margin*scale, y: margin*scale, w: 地图区宽, h: 地图区高 }
```

几条口径：

| 事项 | 说明 |
|---|---|
| 取景范围 | 不受 `margin` 影响。「这张纸覆盖哪一块」还是 `paper` / `planExport` 那一条 |
| 铺底 | 传了 `margin` 就会按 `background`（默认 `#ffffff`）铺满整页 —— 那圈没有地图内容，不铺就是透明（PNG）/ 黑边（JPEG） |
| `decorate` 抛错 | **整次导出失败**，错误原样抛给调用方。整饰画不出来这张图就是废的，静默吞掉只会让人拿到缺图例的成品 |
| `decorate` 时机 | 地图 + 标注贴完之后、**还原屏幕渲染态之前**（同步段里），所以它画的东西一定在标注之上 |
| 不传 `margin` | 输出画布就是地图区，一切与以前**逐字节相同**；`width/height` 报的还是地图区像素数，`mapRect` 不出现 |
| 分块导出 | `cell` 与 `margin` 可以同时用：每块都是「一张完整的、带整饰的小纸」 |

宿主想**自己**算整页布局（比如在 DOM 里先预览纸张）：

```ts
import { normalizeMargin, planDecorate } from '@giszhc/mapbox-sketch';

const plan = planExport({ cssW, cssH, dpr: 1, dpi: 300, paper: { size: 'A3' } });
const deco = planDecorate(plan.outW, plan.outH, normalizeMargin(13), plan.scale);
// → { width, height, mapX, mapY, margin }（全是输出像素）
```

与 `decorate` 回调里的 `info` 是**同一个算式** —— 预览与成品不会差半个框。

### 进度（ExportProgress）

```ts
interface ExportProgress {
  phase: 'waitVisible' | 'prepareMap' | 'waitTiles' | 'compose' | 'encode';
  elapsedMs: number;                                  // 从调 exportImage() 起算
  tiles?: { loaded: number; total: number };           // 尽力而为；数不出来 = undefined
}
```

`onProgress` 第二个参数用来画**真的会动的**进度条：

```ts
onProgress: (msg, info) => {
  label.textContent = msg;
  bar.style.width = info.tiles ? `${(info.tiles.loaded / info.tiles.total) * 100}%` : '';
}
```

`tiles.loaded === tiles.total` 的那一刻就是等待结束的那一刻。数不出来时退回「转圈 + 已等 N 秒」（文案里带的已等时长由 `elapsedMs` 换算，格式化为 `42 秒` / `3 分 5 秒` / `1 小时 12 分`）。**引擎不设超时**，等到下完为止——慢带宽下高清导出要几分钟是常态。

### planExport（导出前预告）

```ts
import { planExport } from '@giszhc/mapbox-sketch';

const plan = planExport({ cssW: 1280, cssH: 800, dpr: devicePixelRatio, dpi: 300 });
// → { scale, frameW, frameH, frameX, frameY, offset, outW, outH, dpi, warnings }

planExport({ cssW: 1280, cssH: 800, dpr: 1, dpi: 300, paper: { size: 'A1', orientation: 'landscape' } });
// → { frameW: 3178.58, frameH: 2245.04, frameX: -949.29, frameY: -722.52, outW: 9933, outH: 7016, dpi: 300, warnings: [] }
```

`frameX/frameY` 是取景框相对容器左上角的偏移（框以视口中心为中心，**可为负**）。想在宿主页面上画一圈和引擎一致的纸框，照它们画。

---

## 富文本行内标签语法

`richText` 标注的内容是 `cfg.text` 那一个字符串，样式写在文字里，解析发生在每帧排版——存档 / 导入导出零改动。

| 标签 | 作用 |
|---|---|
| `<b>` | 加粗 |
| `<i>` | 斜体 |
| `<u>` | 下划线 |
| `<s=24>` | 字号（px） |
| `<c=#e03131>` | 颜色（`#hex` / 颜色名 / `rgb()` / `rgba()`） |
| `<bg=#fff3bf>` | **段级**高亮条（只给这一段铺一条色带） |
| `<r=8>` | 高亮条的圆角半径（px，0 = 方角，默认 4） |
| `<bg=none>` | 把色带关到这儿为止（嵌套时用） |

- 闭标签统一写 `</>`（`</b>` 这种带名字的也认，一律闭**最内层**）。
- 一个标签里可写多项、可嵌套：`<b s=20 c=#e03131>标题</>`。
- 分隔符是空格或逗号（`<b,s=20>` 与 `<b s=20>` 等价），但 `rgba(…)` 里的逗号是色值的一部分、不按分隔符切。
- 标签**不跨行**——一行末尾漏写 `</>` 只影响这一行。
- 认不出来的 `<…>` 原样当文字显示（`<` `>` 也照样能打）。
- 段里没写字号 / 颜色的取样式面板的 `textSize` / `textColor`。

**整条标注的背景是另一件事**，在样式面板上（`bgColor` / `bgRadius`），不在标签里：画的是一整块圆角矩形（宽 = 最宽那行、高 = 全部行高之和、四周外扩 3px），铺在所有字下面。出厂纯白 `#ffffff`，不想要就清空（`''` = 不垫底）。于是两块各司其职：**整块底板**用 `bgColor` / `bgRadius`，**几个字的高亮条**用 `<bg=…>`，同一条标注里两者可同时存在。

解析器单独导出，宿主可在自己的 UI 里预览或只取纯文字：

```ts
import { parseRichText, plainOfLine, BG_RADIUS } from '@giszhc/mapbox-sketch';
```

---

## 工具函数

### `math` 命名空间

纯几何（投影无关）：弧长、平滑、折线抽稀 `simplifyPolyline`、点线距、面积等。写自定义类型时可用。

```ts
import { math } from '@giszhc/mapbox-sketch';
math.simplifyPolyline(pts, tol);   // Douglas-Peucker 抽稀
math.smoothPolyline(pts, stepM);   // 平滑（采样步长按屏幕给，别写死米数）
math.buildArc(...);                // 造弧
```

### `paint` 命名空间

canvas 原语：`strokePolyline` / `drawDot` / `rotText` / `haloText` / `measureTextCached` / `roundRectPath`，以及手柄图标 `rotateHandleIcon()` / `scaleHandleIcon(角度)`。

```ts
import { paint } from '@giszhc/mapbox-sketch';
paint.strokePolyline(ctx, Pts, color, width, null, opacity);
paint.haloText(ctx, text, x, y, opts);
paint.rotateHandleIcon(ctx, x, y, active);
paint.scaleHandleIcon(ctx, x, y, angle, active);
```

### `cursors` 手柄光标

CSS 里没有「旋转」光标，库里现造 SVG。`vertexCursor()` 的返回值。

```ts
import { rotateCursor, scaleCursor } from '@giszhc/mapbox-sketch';
// rotateCursor()        → 转圈箭头光标（CSS cursor 值）
// scaleCursor(rad)       → 跟着朝向转的双向箭头光标
```

> Safari / Firefox 根本不画 SVG 光标，所以语义还得靠 `paint.rotateHandleIcon` / `scaleHandleIcon` 一起说。

### `rich-text` 解析器

纯函数、零依赖。见[富文本行内标签语法](#富文本行内标签语法)。

### `measure` 常量

```ts
import { MEASURE_TEXT_COLOR, MEASURE_HALO_COLOR } from '@giszhc/mapbox-sketch';
// MEASURE_TEXT_COLOR  = '#ffffff'  测量文字默认填充色（白）
// MEASURE_HALO_COLOR   = '#000000'  测量文字描边色（黑）
```

### 图片导出工具函数

见[图片导出详解](#图片导出详解)：`planExport` / `planExportTiles` / `paperGrid` / `paperFrame` / `PAPER_SIZES` / `mmToCssPx` / `autoPaperGrid` / `autoViewportGrid` / `TILE_PIXEL_BUDGET` / `BASE_DPI` / `normalizeMargin` / `planDecorate`。

---

## 公共类型定义

全部从主出口和 `core` 出口导出（`export type`）。

### 坐标

```ts
type LngLat = [number, number];                 // [经度, 纬度]，顺序同 GeoJSON
interface ScreenPoint { x: number; y: number; } // CSS 像素，与 map.project 同坐标系
interface BBox { minX: number; minY: number; maxX: number; maxY: number; }
```

### 图形

```ts
type ShapeDatum = string | number;             // 类型私有数据的单个值（能原样进出 JSON）

interface Shape {
  readonly id: string;                          // 自动生成 `类型-序号`，或 push 时手动指定。不可变
  readonly type: string;                        // 类型键
  pts: LngLat[];                                // 顶点经纬度（未闭合；面类型首尾不重复）
  cfg: Cfg;                                     // 该图形生效的完整绘制配置
  style: Partial<Style> | null;                // 该图形自己的样式覆盖；null = 跟随全局
  hidden?: boolean;                             // 是否隐藏（改用 tool.hide/show）
  data?: Record<string, ShapeDatum>;            // 类型私有数据（如图片标注的图片本体）
}

type ShapeTypeCtor = new (draw: any) => unknown; // 类型构造器（继承 MapboxShapeType 的子类）
```

### 绘制会话与吸附

```ts
interface DrawSession {
  type: string;                                 // 正在绘制的类型键
  pts: LngLat[];                                // 已落下的点
  cursor: LngLat | null;                        // 橡皮筋端点的当前光标经纬度
}

type SnapKind = 'vertex' | 'edge' | 'self';     // 吸附来源

interface SnapHit {
  kind: SnapKind;                               // 只作信息用（三种记号长得一样）
  lngLat: LngLat;
}

interface SnapOptions {
  enabled?: boolean;                            // 默认 true（绘制中可按 Alt 临时关）
  tol?: number;                                 // 吸附半径（屏幕像素），默认 12
}
```

### 拖拽与异步落图

```ts
interface DragContext {                          // dragTo 钩子的入参，拖拽期间每帧一次
  shape: Shape;
  kind: 'vertex' | 'body';
  vi: number;                                   // 顶点下标；body 时为 -1
  cursor: LngLat;
  point?: ScreenPoint;
  orig: LngLat[];                               // 按下时的顶点快照（只读，改了会污染整次拖拽）
  start: LngLat;                                // 按下时的光标经纬度
  alt: boolean;
  shift: boolean;
}

interface PlaceContext { lngLat: LngLat; point?: ScreenPoint; }
interface PlaceResult { pts: LngLat[]; data?: Record<string, ShapeDatum>; }
```

### 图片导出

```ts
interface ExportImageOptions { /* 见图片导出详解 */ }
interface ExportImageResult  { /* 见图片导出详解 */ }
interface ExportProgress {
  phase: 'waitVisible' | 'prepareMap' | 'waitTiles' | 'compose' | 'encode';
  elapsedMs: number;
  tiles?: { loaded: number; total: number };
}
type ExportPhase = ExportProgress['phase'];
interface ExportTiles { loaded: number; total: number; }

// 图廓整饰（专题图）：margin 单位是 CSS 像素，decorate 拿到的几何是输出像素
interface ExportMargin { top: number; right: number; bottom: number; left: number; }
interface ExportDecorateInfo {
  width: number; height: number;                 // 整页输出像素（含四边外边距）
  dpi: number;
  scale: number;                                 // 输出像素 ÷ CSS 像素（= dpi / 96）
  map: { x: number; y: number; w: number; h: number };   // 地图区在整页上的矩形
  margin: ExportMargin;                          // 四边外边距（输出像素、整数）
}
interface DecorateLayout {                       // planDecorate() 的返回
  width: number; height: number; mapX: number; mapY: number; margin: ExportMargin;
}

interface ExportMapOptions {                    // 建隐藏地图要传给 createMap 的选项
  container: HTMLElement;
  style: ReturnType<mapboxgl.Map['getStyle']>;
  center: { lng: number; lat: number };
  zoom: number;                                 // 已补偿过：可见地图.zoom + log2(scale)
  bearing: number;
  pitch: number;
  padding: { top: number; right: number; bottom: number; left: number }; // 已按 scale 同比例放大
  maxZoom: number;                              // 已抬高过，防补偿后的 zoom 被夹掉
  preserveDrawingBuffer: true;                  // 必须 true，否则读不回画布
  interactive: false;
  attributionControl: false;
  fadeDuration: 0;
  accessToken?: string;
}
```

### 纸张与分块

```ts
type PaperOrientation = 'portrait' | 'landscape';
interface PaperSize { name: string; w: number; h: number; }   // mm
type PaperSpec = { size: string; orientation?: PaperOrientation };
interface PaperFrame { x: number; y: number; w: number; h: number; }
interface ExportCell { col: number; row: number; cols: number; rows: number; }
interface ExportPlan {
  scale: number; frameW: number; frameH: number;
  frameX: number; frameY: number;
  offset: { x: number; y: number };             // 给引擎看，宿主用 tile.cell
  outW: number; outH: number; dpi: number; warnings: string[];
}
interface ExportPlanInput { cssW: number; cssH: number; dpr: number; dpi: number; paper?: PaperSpec | null; cell?: ExportCell | null; }
interface ExportGridTile { index: number; col: number; row: number; cell: ExportCell; plan: ExportPlan; }
interface ExportGrid { cols: number; rows: number; count: number; tiles: ExportGridTile[]; }
interface ExportGridInput { cssW: number; cssH: number; dpr: number; dpi: number; paper?: PaperSpec | null; cols: number; rows: number; }
interface PaperGrid { k: number; cols: number; rows: number; count: number; block: string; wholeW: number; wholeH: number; tileW: number; tileH: number; warnings: string[]; }
interface AutoGrid extends PaperGrid {}          // autoPaperGrid / autoViewportGrid 的返回
```

### 富文本

```ts
interface RichSegment {
  text: string;                                 // 段内文字（不含标签）
  size: number | null;                          // 自己的字号；null = 跟随面板 textSize
  color: string | null;                         // 自己的字色；null = 跟随面板 textColor
  bold: boolean;
  italic: boolean;
  underline: boolean;
  bg: string | null;                            // 段级高亮底色；null = 这一段不铺
  radius: number | null;                        // 色带圆角；null = 用 BG_RADIUS（4）
}
interface RichLine { segs: RichSegment[]; }      // 一行（\n 切出来的段落）
```

### 测量与杂项

```ts
type MeasureKind = 'distance' | 'area';
interface PickImageResult { dataUrl: string; width: number; height: number; }
type TickPos = 'top' | 'middle' | 'bottom';
type SpreadMode = 'spread' | 'tight';
type StyleKey = keyof Style;
type CfgKey = keyof Cfg;
type StylePatch = Partial<Style>;
type CfgPatch = Partial<Cfg>;
```

---

## License

MIT
