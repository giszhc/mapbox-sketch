/* =====================================================================
 * samples.ts —— 面板元数据与 demo 自己的初始默认值。
 *
 * 纯常量，不含任何 Vue / Element Plus 依赖。四块内容：
 *   · 左侧面板的按钮与初始默认值（`DEMO_CFG` / `DRAW_BUTTONS`）
 *   · 右侧「样式设置」面板的行（`STYLE_GROUPS` / `STYLE_APPLIES`）
 *   · 右侧「样式设置」面板里**跟类型走的绘制配置行**（`CFG_GROUPS`）
 *   · 右侧「样式设置」面板里**跟类型走的几何行**（`GEOM_GROUPS`）：旋转角度 / 尺寸
 *
 * ★ 这里**不再有内置样例图形**（曾经有一组「路径文字 / 线 / 引线 / 坐标引线」的
 *   样例按钮）。要看效果就直接手绘，或者「导入 JSON」灌一份数据进来 ——
 *   样例按钮既占面板，又得跟着每一种新类型同步维护。
 * ===================================================================== */
import type { CfgKey, GeomKey, StyleKey } from '@giszhc/mapbox-sketch';

/* ---------------- 面板的初始默认值 ---------------- */

/**
 * demo 的初始默认配置。
 *
 * **只有和库的 `DEFAULT_CFG` 不一致的才用列出来** —— 库的出厂默认本身就是
 * `text:'路径文字' / smooth:true / showLine:true / spread:'spread' / angle:330 /
 * len:60`，与面板一致，不用重复。
 *
 * `showNodes` 必须留着：库的默认是不勾选，而旧版面板 `#chkNodes` 是 checked，
 * 少了它「途经点沿线标注」的默认状态就变了。
 */
export const DEMO_CFG: {
  /** 默认是否画途经点短标注（旧版 `#chkNodes` 是 checked） */
  showNodes: boolean;
} = {
  showNodes: true,
};

/* ---------------- 面板元数据 ---------------- */

/**
 * 手绘类型按钮（顺序即面板里的排列顺序）。
 *
 * ★ 排布的讲究：**手感相近的挨着放** ——
 *   · 点标注 / 文字标注 / **富文本标注**：单击即成（`autoCommit`），一个是圆点、
 *     一个是「一个点上的文字块」、最后一个是「块里每段各自带样式」的文字块；
 *   · 折线标注 / 曲线标注 / **自由线标注** / **铁路 / 国界 / 高压线 / 管道**：
 *     都是一条线 —— 前两种逐点落点（区别只在拐点圆不圆滑），自由线是**单击起点 →
 *     移动描摹 → 再单击完成**一笔画出来；最后四种也是逐点落点，但画出来的是
 *     **带状符号**（枕木 / 点划 / 杆塔 / 双线），彼此只差「图案长什么样」；
 *   · 多边形标注 / **自由面标注** / 矩形标注 / 标志旗标注 / 三角标志旗帜标注 /
 *     曲线标志旗标注：一条闭合的「区域」或一块旗面 —— 多边形逐点落、自由面描摹一笔、
 *     后面四种**两击成形**（矩形的两角、旗子的杆底与旗面角 / 尖端 / 外上角）；
 *   · 圆形 / 椭圆 / 扇形 / **集结地标注** / **闭合曲面标注**：一块「区域」—— 前三种按规则
 *     几何定（中心 + 半径 / 外接框 / 两条边），后面两种是自由曲边面（集结地**三击成形**，
 *     闭合曲面是逐点落点后双击完成、末点自动连回首点，口径同标绘库的「聚集地 / 曲线面」）。
 *   用户从前往后顺按钮点，不用跳着找。
 *
 * ★ 这里**没有** `icon` 字段（2026-09-21 删）：按钮图标由 `components/AppIcon.vue`
 *   按 `type` 现取（`<AppIcon :name="b.type" />`）。那套图标是 1.5px 线宽的线性 SVG，
 *   写进数据只能退化成字符（Emoji / Unicode 符号）—— 而正是那种混搭的字符图标
 *   要把这套 UI 清掉。数据与画法分开之后，加类型时也只在一处补图标。
 */
export const DRAW_BUTTONS = [
  { type: 'point', label: '点标注', title: '单击一下即生成一个圆点' },
  { type: 'text', label: '文字标注', title: '单击一下落一个文字块（无需双击），文字以该点为中心、支持多行；拖上方圆柄旋转' },
  { type: 'richText', label: '富文本标注', title: '单击一下落一个文字块（无需双击），与「文字标注」同一套交互；一行里可以有几段不同样式：<b>加粗</b>、<i>斜体</i>、<u>下划线</u>、<s=24>字号</s>、<c=#e03131>颜色</c>、<bg=#fff3bf>局部高亮条</bg>、<r=8>高亮条圆角</r>，闭标签统一写 </>。整条标注的背景（一整块）在右侧样式面板的「背景底色」里设' },
  { type: 'line', label: '折线标注', title: '单击落点连成折线（无标注）' },
  { type: 'curve', label: '曲线标注', title: '单击落点连成曲线（拐点自动圆滑），纯曲线不带文字' },
  { type: 'freeLine', label: '自由线标注', title: '单击地图定起点，再移动鼠标描摹，光标走过哪儿线就长在哪儿，再次单击即成（全程不用按住鼠标）' },
  { type: 'railway', label: '铁路标注', title: '单击落点连成一条铁路符号：实线钢轨 + 沿线枕木（枕木垂直于线、等间距铺满全线）。粗细在右侧面板调「线宽」，枕木的长短会跟着它一起变' },
  { type: 'border', label: '国界 / 境界', title: '单击落点连成一条点划线（一长划 + 一点，反复）：国界 / 省界 / 县界通用符号。不画连续底线——点划线本身就占满了整条线；粗细在右侧面板调「线宽」' },
  { type: 'powerline', label: '高压线标注', title: '单击落点连成一条高压线路符号：实线导线 + 沿线杆塔（「工」字形，两根横担沿线的方向）。与铁路刻意拉开——杆塔稀疏而高（46px 一座），枕木密集而短（9px 一根）' },
  { type: 'pipeline', label: '管道 / 光缆', title: '单击落点连成一条双线：两条永远等距平行、跟着走向弯的细线——油气管道 / 通信光缆 / 输水管的通用符号。与「平行线标注」不同：那是两段几何关系（自己摆第二条线），这是一条线状地物' },
  { type: 'polygon', label: '多边形标注', title: '落点自动闭合，淡填充成一块面' },
  { type: 'freeArea', label: '自由面标注', title: '单击地图定起点，再移动鼠标描摹圈出一块区域，再次单击即完成（末点自动连回首点；全程不用按住鼠标）' },
  { type: 'rect', label: '矩形标注', title: '单击两角定矩形（沿经纬线对齐），淡填充 + 轮廓' },
  { type: 'flag', label: '标志旗标注', title: '单击定旗杆底端 → 移动鼠标（左右改旗面宽度、上下改旗杆高度）→ 再单击完成（两击即成，同矩形标注）：旗杆永远竖直，杆顶朝鼠标那一侧；第二击落点＝旗面外侧角，编辑时抓它改宽改高' },
  { type: 'flagTri', label: '三角标志旗帜标注', title: '与「标志旗标注」同一套操作（两击成形），旗面换成三角形：单击定旗杆底端 → 移动鼠标（左右改三角旗面宽度、上下改三角旗面高度）→ 再单击定尖端；旗杆永远竖直，旗面底边是水平直线，第二击落点＝三角旗面的尖端' },
  { type: 'flagWave', label: '曲线标志旗标注', title: '与「标志旗标注」同一套操作（两击成形），旗面换成波浪带：单击定旗杆底端 → 移动鼠标（左右改旗面宽度、上下改旗杆高度）→ 再单击定旗面外上角；旗杆永远竖直，上下两条边同相位、等高，走一个完整正弦周期（尾部飘动感），第二击落点＝旗面外上角' },
  { type: 'circle', label: '圆形标注', title: '单击定圆心、再击定半径，淡填充 + 轮廓' },
  { type: 'ellipse', label: '椭圆标注', title: '两击定外接矩形对角，椭圆内接其中（沿经纬线对齐）' },
  { type: 'sector', label: '扇形标注', title: '三击定圆心 / 起始边 / 终止边，取两边较小夹角（≤180°）' },
  { type: 'assembly', label: '集结地标注', title: '三击成形（口径同「聚集地」标绘）：单击定第一点 → 移动鼠标立刻长出一整块面 → 单击定第二点 → 移动鼠标把第三点摆到位 → 第三次单击完成；三个落点都是曲线要经过的锚点（编辑时抓它们改形状）' },
  { type: 'closedCurve', label: '闭合曲面标注', title: '单击依次落点，全部拐点被圆滑成一条首尾相接的闭合曲线，围出一块面（双击 / 回车完成，末点自动连回首点）；每个落点都是曲线必经的锚点，编辑时抓它们改形状' },
  { type: 'doubleArrow', label: '双箭头标注', title: '钳击箭头：单击定左尾端 → 单击定右尾端 → 单击确认右箭头尖端 → 移动鼠标把左箭头尖端摆到位 → 第四次单击完成（四击即成）。两尾连线中点为合拢点，两个箭头头朝外、钳口在中间；四个落点都是轮廓必经的点，编辑时抓它们改形状' },
  { type: 'fineArrow', label: '细直箭头标注', title: '单尖头直箭头（亦称粗单尖头箭头）：单击定箭尾 → 移动鼠标把箭头尖端摆到位 → 第二次单击完成（两击即成）。箭身与箭头的宽度都按两点距离成比例，整条形状是一个闭合多边形；两个落点都在轮廓上，编辑时抓它们改形状' },
  { type: 'straightArrow', label: '直箭头标注', title: '粗单直箭头（块状箭头）：单击定箭尾 → 移动鼠标把箭头尖端摆到位 → 第二次单击完成（两击即成）。矩形箭杆 + 三角箭头，整条形状是一个闭合多边形；两个落点都在轮廓上，编辑时抓它们改形状' },
  { type: 'assaultDirection', label: '突击方向标注', title: '与「细直箭头标注」同一套几何（原版就是继承细直箭头、只换五个比例），只是箭身更鼓、倒刺更开、箭头更宽：单击定箭尾 → 移动鼠标把箭头尖端摆到位 → 第二次单击完成（两击即成）；两个落点都在轮廓上，编辑时抓它们改形状' },
  { type: 'attackArrow', label: '进攻方向标注', title: '带箭头的绸带：单击落下箭尾后逐点单击画出箭杆（最后一点＝箭头尖端），双击 / 回车完成。前两个点是箭尾两边，其余点被圆滑成带箭头的绸带；每个落点都是轮廓上的锚点，编辑时抓它们改形状' },
  { type: 'tailedAttackArrow', label: '进攻方向尾标注', title: '与「进攻方向标注」同一套画法（单击落箭尾、逐点画箭杆、双击 / 回车完成），区别只在箭尾凹出一个燕尾（形如 "＞" 的尾口）；每个落点都是轮廓上的锚点，编辑时抓它们改形状' },
  { type: 'squadCombat', label: '分队战斗行动标注', title: '带箭头的绸带：单击落下箭尾后逐点单击画出箭杆（最后一点＝箭头尖端），双击 / 回车完成。箭尾是从前两点算出的偏移点（两尾朝内收），其余点被圆滑成带箭头的绸带；每个落点都是轮廓上的锚点，编辑时抓它们改形状' },
  { type: 'tailedSquadCombat', label: '分队战斗行动尾标注', title: '与「分队战斗行动标注」同一套画法（单击落箭尾、逐点画箭杆、双击 / 回车完成），区别只在箭尾凹出一个燕尾（形如 "＞" 的尾口）；每个落点都是轮廓上的锚点，编辑时抓它们改形状' },
  { type: 'lune', label: '弓形面标注', title: '三点定圆的弓形面：单击定弦的一端 → 单击定弦的另一端 → 移动鼠标把第三点摆到位 → 第三次单击完成（三击即成）。三个落点都在圆弧上，弧从第三点那侧扫过（第三点摆哪边、弓形就朝哪边鼓）；每个落点都是轮廓上的锚点，编辑时抓它们改形状' },
  { type: 'arc', label: '弧线标注', title: '三点定圆的一段圆弧（口径同「弧线」标绘）：单击定弧的起点 → 单击定弧的终点 → 移动鼠标把第三点摆到位 → 第三次单击完成（三击即成）。三个落点都在弧上，弧从第三点那侧扫过（第三点摆哪边、弧就往哪边弯）；与「弓形面标注」同一套定圆算法，区别只在它是一条线、不闭合成面' },
  { type: 'parallel', label: '平行线标注', title: '两条平行等长的线段：单击定基准线两端 → 移动鼠标把平行线摆到位 → 第三次单击完成（三击即成）。平行线是基准线的平移副本（永远平行、不会画歪），第三点＝平行线的起点，编辑时拖它＝平移整条平行线' },
  { type: 'perpendicular', label: '垂直线标注', title: '基准线 + 一条与它恒成直角的垂直线（成 "⊥" 形）：单击定基准线两端 → 移动鼠标把垂直线摆到位 → 第三次单击完成（三击即成）。垂直线从基准线中点立起，第三点定它的高度与朝向；编辑时拖垂直线端点＝改高度' },
  { type: 'annulus', label: '圆环标注', title: '两击定圆心与外圆半径 → 移动鼠标定内圆半径 → 第三次单击完成（三击即成）。第三点只需给出到圆心的距离（不用精确落在半径线上）；两个半径拿反了也没关系，大的自动当外圆。淡填充 + 两圈轮廓（可只留填充），编辑时拖三个手柄分别挪圆心 / 外圆 / 内圆' },
  { type: 'bubble', label: '气泡标注', title: '单击一下即落一个白底圆角气泡（带指向落点的小尾巴，同「点 / 文字标注」单击即成）：落点＝尾巴尖端，气泡体悬在点的正上方。内容在右侧面板里改、支持多行（回车换行）；拖气泡本体＝平移' },
  { type: 'image', label: '图片标注', title: '单击地图选位置 → 弹出文件框选图片，选完直接贴上（拖角等比缩放、拖图内平移、拖上方圆柄旋转）' },
  { type: 'path', label: '路径文字', title: '折线 + 沿线平均分布文字' },
  { type: 'distance', label: '距离标注', title: '拐点累计里程 + 密集刻度' },
  { type: 'area', label: '面积标注', title: '每条边中间标边长 + 密集刻度 + 形心面积/周长' },
  { type: 'leader', label: '引线标注', title: '单击地图定锚点，两段引线 + 恒水平文字' },
  { type: 'leaderCoord', label: '坐标引线标注', title: '单击地图拾取坐标，引线上显示经/纬度度分秒两行' },
] as const;

/* ---------------- 样式面板（右侧）的行 ---------------- */

/** 手绘类型键（`DRAW_BUTTONS` 的实际取值）。样式适用范围用它做集合元素，写错名字编译就红 */
export type DrawType = (typeof DRAW_BUTTONS)[number]['type'];

/**
 * 绘制类型在「选择标注类型」浮层里的分组。
 *
 * ★ 为什么另一份列表：`DRAW_BUTTONS` 的顺序是「手感相近的挨着放」（见上面那段注释），
 *   两列网格里 41 个按钮连成一片时，光靠顺序分不出「这是线还是面」。分组给的是
 *   **语义层级**：先看组标题（点/线/面/箭头…），再在组里挑那一个。
 *   `DRAW_BUTTONS` 保持原样不动 —— 它还是唯一一份「有哪些类型」的事实来源，
 *   这里只做引用（`DrawType` 约束住拼写，漏一个类型下面的用例会红）。
 *
 * ★ 组内顺序与 `DRAW_BUTTONS` 里的相对顺序一致（单击即成 → 逐点 → 特殊手势），
 *   用户从前往后扫，不用跳着找。
 */
export const DRAW_GROUPS: ReadonlyArray<{ label: string; types: ReadonlyArray<DrawType> }> = [
  { label: '点与文字', types: ['point', 'text', 'richText', 'bubble', 'image'] },
  { label: '线状标注', types: ['line', 'curve', 'freeLine', 'railway', 'border', 'powerline', 'pipeline'] },
  {
    label: '面状标注',
    types: ['polygon', 'freeArea', 'rect', 'circle', 'ellipse', 'sector', 'annulus', 'assembly', 'closedCurve', 'lune'],
  },
  {
    label: '箭头',
    types: ['doubleArrow', 'fineArrow', 'straightArrow', 'assaultDirection', 'attackArrow', 'tailedAttackArrow', 'squadCombat', 'tailedSquadCombat'],
  },
  { label: '标志旗', types: ['flag', 'flagTri', 'flagWave'] },
  {
    label: '量算与引线',
    types: ['path', 'distance', 'area', 'leader', 'leaderCoord', 'parallel', 'perpendicular', 'arc'],
  },
];

/** 样式面板里的一行 */
export interface StyleRow {
  key: StyleKey;
  label: string;
  /** 控件种类：颜色（可带透明）/ 数字 / 下拉 */
  kind: 'color' | 'number' | 'select';
  /**
   * 颜色行是否要开 `show-alpha`。
   * ★ 出厂值本身就是 `rgba(…)` 的那几个键**必须**开：`el-color-picker` 不开 alpha 时
   *   选完写回去只剩 `#rrggbb`，半透明填充会当场变成实心。
   */
  alpha?: boolean;
  /**
   * 颜色行是否允许**清空**（清空 = 这个键设成空串）。
   *
   * ★ 只给「空串本身就是一个有意义的取值」的键开 —— 目前只有富文本的 `bgColor`
   *   （空串 = 不垫底；出厂是纯白，所以「清空」是唯一能把它关掉的动作）。别的颜色键
   *   清空是**没有语义**的：线色 / 字色设成空串，canvas 会拿上一次的 `fillStyle` 去画
   *   （在不同浏览器里表现还不一样），所以那一类行照旧忽略清空事件（见 StyleDrawer.vue 的 `onColor`）。
   */
  clearable?: boolean;
  hint?: string;
  /* kind === 'number' */
  min?: number;
  max?: number;
  step?: number;
  /* kind === 'select' */
  options?: ReadonlyArray<{ value: string; label: string }>;
}

/** 面板里的一个分组 */
export interface StyleGroup {
  title: string;
  rows: ReadonlyArray<StyleRow>;
}

/**
 * 样式面板的分组与行。顺序即面板里的显示顺序。
 *
 * ★ 这里是照着库的 `DEFAULT_STYLE` 手抄的一份清单 —— 库加样式键时要同步补一行，
 *   `test/demo-style-meta.spec.ts` 会盯着（漏抄那一条会直接红）。
 *
 * 分组是按「一眼能找到」来的，不是按引擎内部结构：颜色 / 文字 / 线与面 / 点与标记。
 * 比库的 21 个样式键**少 4 行** —— `hoverColor` / `previewColor` / `previewFill` / `snapColor`
 * 是全局项（引擎读的是全局样式表，给单条图形改了不生效），列出来只能是四行死控件，
 * 所以面板里根本不列（见 `visibleStyleGroups`）。当前共 6 + 5 + 4 + 2 = 17 行。
 * 其中 `hoverColor` 的控件搬到了左侧「🎛 绘制配置」（见 ConfigPanel.vue）。
 *
 * 另一个方向：**某类型用不到的键也不列**。所以面板上真正渲染几行是**按类型现算的**，
 * 这张表只是「全部行」的声明顺序。
 */
export const STYLE_GROUPS: ReadonlyArray<StyleGroup> = [
  {
    title: '颜色',
    rows: [
      { key: 'pathColor', label: '路径线 / 轮廓', kind: 'color' },
      { key: 'textColor', label: '沿线文字 / 引线文字', kind: 'color' },
      { key: 'vertexColor', label: '边长 / 里程文字', kind: 'color' },
      { key: 'pointColor', label: '点圆点', kind: 'color' },
      { key: 'nodeColor', label: '途经点短标注', kind: 'color' },
      { key: 'areaColor', label: '面积文字', kind: 'color' },
    ],
  },
  {
    title: '文字',
    rows: [
      { key: 'textSize', label: '字号 (px)', kind: 'number', min: 8, max: 48, step: 1 },
      { key: 'haloColor', label: '白描边', kind: 'color', alpha: true, hint: '文字压在深色底图上的那圈描边' },
      {
        key: 'haloWidth',
        label: '描边宽度 (px)',
        kind: 'number',
        min: 0,
        max: 10,
        step: 0.5,
        hint: '文字外圈白边的粗细；0 = 不描边',
      },
      // ★ 下面两行**只对富文本标注出现**（见 STYLE_APPLIES）—— 它是唯一「一块文字块」
      //   带整块背景的类型。两行紧挨着放：背景和它的圆角是一件事，拆到两个分组里
      //   （比如把颜色行塞进「颜色」组、圆角行留在这儿）只会让人找不到另一半。
      //   ★ 管的是**整条标注**那一整块底板（宽 = 最宽那行、高 = 全部行高之和）；
      //     段级 `<bg=…>` 那个「几个字的高亮条」是行内标签的事，与这两行无关
      //     —— 2026-09-20 用户口径：「富文本应该是整个标注的背景，而不是某个标签的」。
      {
        key: 'bgColor',
        label: '背景底色（整块）',
        kind: 'color',
        // 半透明背景是这个控件的正经用法（字压在底板上，还得透出底图）
        alpha: true,
        // ★ 空串 = 不垫底，是「清空」之后的状态 —— 有它才关得掉出厂那块白底板
        clearable: true,
        hint: '给整条标注垫一块底色（所有行一起，宽按最宽那行算）；出厂纯白。'
          + '点色板里的「清空」＝不垫底。'
          + '想让某几个字单独高亮，用文字里的 <bg=…> 标签',
      },
      {
        key: 'bgRadius',
        label: '背景圆角 (px)',
        kind: 'number',
        min: 0,
        max: 64,
        step: 1,
        hint: '那块整块背景的圆角半径；0 = 方角。段级 <r=…> 的圆角归标签自己',
      },
    ],
  },
  {
    title: '线与面',
    rows: [
      // ★ min = 0：0 = 不描边（气泡标注的边框靠它关掉；线 / 面设 0 会画不出轮廓，
      //   那是用户自己的选择，引擎按 0 处理本就是「什么都不描」）
      { key: 'pathWidth', label: '线宽 (px)', kind: 'number', min: 0, max: 30, step: 1 },
      { key: 'lineOpacity', label: '不透明度', kind: 'number', min: 0, max: 1, step: 0.05 },
      {
        key: 'lineType',
        label: '线型',
        kind: 'select',
        options: [
          { value: 'solid', label: '实线（默认）' },
          { value: 'dashed', label: '虚线（预测/预报）' },
          { value: 'dotted', label: '点线（估计）' },
          { value: 'dashDot', label: '点划线（计划）' },
          { value: 'dashDotDot', label: '双点划线（远期预测）' },
          { value: 'longDash', label: '长虚线（边界/施工）' },
          { value: 'shortDash', label: '短虚线（断裂/辅助）' },
        ],
        hint: '实线=实测，虚线=预测，点线=估计，点划=计划，双点划=远期预测；虚线间距按线宽缩放',
      },
      { key: 'polygonFill', label: '面内填充', kind: 'color', alpha: true },
    ],
  },
  {
    title: '点与标记',
    rows: [
      { key: 'pointRadius', label: '点半径 (px)', kind: 'number', min: 2, max: 30, step: 1 },
      {
        key: 'tickPos',
        label: '密集刻度位置',
        kind: 'select',
        options: [
          { value: 'top', label: '贴线上侧（默认）' },
          { value: 'middle', label: '横穿线条' },
          { value: 'bottom', label: '贴线下侧' },
        ],
      },
    ],
  },
  // 这里曾经有个只有一行的「交互」分组（悬停高亮色）。它现在是**全局项**
  // （见下面的 STYLE_APPLIES）：悬停高亮是交互反馈，不是某条标注的外观，
  // 逐条调它只会让同屏几条图形的悬停色对不上。控件搬到了左侧「🎛 绘制配置」。
];

/**
 * 每个样式键**真正被哪些类型读取**（照 `src/lib/shapes/*.ts` 与 `sketch.ts` 核过）。
 *
 * `null` = **全局项**：引擎读的是全局样式表，给单条图形 `applyStyle` 它也不会有任何效果
 * （会静默存进 `shape.style` 里，只是永远不生效）。面板据此**根本不列**这几行 ——
 * 列出来只能是几个改了没反应的死控件。
 *
 * `Record<StyleKey, …>` 是刻意的：库加一个样式键，这里缺一个就编译不过。
 * 它同时是「哪几个是全局项」的唯一记录（见 `visibleStyleGroups`）。
 */
export const STYLE_APPLIES: Record<StyleKey, ReadonlySet<DrawType> | null> = {
  // 画线的类型全都读这三个（圆 / 矩形 / 椭圆 / 扇形读的是轮廓描边；
  // 图片标注读的是它那圈**选中框**（静态时不画，见 shapes/image.ts），
  // 以及图片本体的不透明度）。
  // 三种标志旗（矩形旗面 / 三角旗面 / 波浪旗面）读 pathColor / pathWidth / lineOpacity：旗杆那条
  // **线**与旗面那一圈轮廓都走它们；旗面的半透明填充走 polygonFill。
  // ★ 它们都没有尺寸样式键 —— 旗子多大由两个落点的距离决定（几何），见 shapes/flag*.ts。
  // 两种自由手绘（自由线 / 自由面）同「折线 / 多边形」那套：线色 / 线宽 / 不透明度，
  // 自由面另有 polygonFill。它们同样没有尺寸键 —— 笔迹多大多长就是手指走过的路。
  // 集结地标注同「圆 / 矩形 / 椭圆 / 扇形」那一档：一圈轮廓 + 一块淡填充，也**没有尺寸键**
  // —— 面多大多鼓全由三个落点定（几何），见 shapes/assembly.ts。
  // 闭合曲面标注同一档：闭合曲边轮廓 + 淡填充，也没有尺寸键（几个锚点摆哪儿就是多大），
  // 见 shapes/closed-curve.ts。
  // 双箭头标注（钳击箭头）同这一档：一圈轮廓 + 一块淡填充，也没有尺寸键（两尾和两尖
  // 怎么摆就是多大），见 shapes/double-arrow.ts。
  // 细直箭头标注（单尖头直箭头）同这一档：一圈轮廓 + 一块淡填充，也没有尺寸键（两点的
  // 距离定大小），见 shapes/fine-arrow.ts。
  // 直箭头标注（块状箭头）同这一档：一圈轮廓 + 一块淡填充，也没有尺寸键（两点的距离定
  // 大小），见 shapes/straight-arrow.ts。
  // 突击方向标注同这一档（原版就是「细直箭头」换五个比例、继承自它），见 shapes/assault-direction.ts。
  // 进攻方向 / 进攻方向（尾）同这一档（多点绸带；后者是前者加燕尾），见 shapes/attack-arrow.ts / tailed-attack-arrow.ts。
  // 分队战斗行动 / 分队战斗行动（尾）同这一档（多点绸带；箭尾偏移 + 后者加燕尾），见 shapes/squad-combat.ts / tailed-squad-combat.ts。
  // 弓形面标注同这一档（三点定圆的弧 + 弦围出的面），见 shapes/lune.ts。
  // 弧线标注：纯线（LineString，不填充），读线色 / 线宽 / 不透明度，见 shapes/arc.ts。
  // 平行线 / 垂直线标注：同为纯线（新画类型，非移植），见 shapes/parallel.ts / perpendicular.ts。
  // 「沿路径铺图案」那一族（铁路 / 国界 / 高压线 / 管道，共用 shapes/line-deco.ts 基类）：
  // 都是线状地物，**只读线色 / 线宽 / 不透明度这三个**（管道的「双线」也是两条描边）。
  // ★ 它们没有别的样式键：`pathWidth` 在这族里不光是粗细，还是**整个符号的尺寸基准**
  //   （枕木多长、杆塔多高、两条线间距多大，全按它成比例），所以面板上调「线宽」
  //   就是调「符号大小」—— 不需要再单开一个「符号尺寸」键（同一个数两处可调只会打架）。
  // 气泡标注：体框 + 尾巴侧边读线色 / 线宽 / 不透明度；**底色读 polygonFill**
  // （类型专属默认白由 defaultStyle 钉住，面板「面内填充」可改），见 shapes/bubble.ts。
  pathColor: new Set<DrawType>(['line', 'curve', 'closedCurve', 'doubleArrow', 'fineArrow', 'straightArrow', 'assaultDirection', 'attackArrow', 'tailedAttackArrow', 'squadCombat', 'tailedSquadCombat', 'lune', 'arc', 'parallel', 'perpendicular', 'railway', 'border', 'powerline', 'pipeline', 'annulus', 'bubble', 'freeLine', 'polygon', 'freeArea', 'circle', 'rect', 'ellipse', 'sector', 'assembly', 'image', 'path', 'distance', 'area', 'leader', 'leaderCoord', 'flag', 'flagTri', 'flagWave']),
  pathWidth: new Set<DrawType>(['line', 'curve', 'closedCurve', 'doubleArrow', 'fineArrow', 'straightArrow', 'assaultDirection', 'attackArrow', 'tailedAttackArrow', 'squadCombat', 'tailedSquadCombat', 'lune', 'arc', 'parallel', 'perpendicular', 'railway', 'border', 'powerline', 'pipeline', 'annulus', 'bubble', 'freeLine', 'polygon', 'freeArea', 'circle', 'rect', 'ellipse', 'sector', 'assembly', 'image', 'path', 'distance', 'area', 'leader', 'leaderCoord', 'flag', 'flagTri', 'flagWave']),
  lineOpacity: new Set<DrawType>(['line', 'curve', 'closedCurve', 'doubleArrow', 'fineArrow', 'straightArrow', 'assaultDirection', 'attackArrow', 'tailedAttackArrow', 'squadCombat', 'tailedSquadCombat', 'lune', 'arc', 'parallel', 'perpendicular', 'railway', 'border', 'powerline', 'pipeline', 'annulus', 'bubble', 'freeLine', 'polygon', 'freeArea', 'circle', 'rect', 'ellipse', 'sector', 'assembly', 'image', 'path', 'distance', 'area', 'leader', 'leaderCoord', 'flag', 'flagTri', 'flagWave']),
  // 线型：与上面三键（pathColor / pathWidth / lineOpacity）同口径，但**刻意不含**
  // 「沿路径铺图案」那一族（railway / border / powerline / pipeline）—— 它们是符号语义，
  // 自带的枕木 / 点划 / 杆塔 / 双线就是「线型」，再叠一层虚线只会打架；也不含 image
  // （它读 pathColor / pathWidth 只为了那圈**选中框**，是编辑态 chrome）。
  // 同样不含那些「整块符号」类型（各种箭头 / 集结地 / 气泡 / 弓形 / 矩形）：它们的轮廓
  // 是符号的一部分，目前没接 lineType（见 shapes/*.ts 的 strokePolyline 调用），
  // 列出来只会是改了不生效的死控件。
  // 也不含测距 / 测面（measureDistance / measureArea）：它们是**测量实例**的类型，
  // 不在 41 种绘制按钮里（DRAW_BUTTONS），面板这边本来就列不到；它们读的是测量引擎的
  // 全局样式表（见 use-sketch.ts 的 measureXxx），lineType 走全局默认即可。
  // 下列类型才是真正读 `st.lineType` 的（含 leaderCoord：它继承 leader 的 render）。
  lineType: new Set<DrawType>(['line', 'freeLine', 'polygon', 'freeArea', 'circle', 'ellipse', 'sector', 'annulus', 'parallel', 'perpendicular', 'arc', 'curve', 'leader', 'leaderCoord', 'path', 'flag', 'flagTri', 'flagWave', 'distance', 'area']),
  polygonFill: new Set<DrawType>(['polygon', 'freeArea', 'circle', 'rect', 'ellipse', 'sector', 'assembly', 'closedCurve', 'lune', 'doubleArrow', 'fineArrow', 'straightArrow', 'assaultDirection', 'attackArrow', 'tailedAttackArrow', 'squadCombat', 'tailedSquadCombat', 'lune', 'annulus', 'bubble', 'area', 'flag', 'flagTri', 'flagWave']),
  // 有文字的：路径文字 / 引线（坐标引线继承引线的渲染）/ 文字标注 / 富文本标注 / 气泡标注。
  // 引线 2026-09-11 起回归 textColor（默认蓝，与其他文字统一；曾固定纯红）
  // 富文本标注读的是同一套键：**段自己写了 `c=` / `s=` 就压过它们**（没写就取这里）
  textColor: new Set<DrawType>(['path', 'leader', 'leaderCoord', 'text', 'richText', 'bubble']),
  textSize: new Set<DrawType>(['path', 'leader', 'leaderCoord', 'text', 'richText', 'bubble']),
  // 白描边：上面几种，外加距离 / 面积标注（它们的数字也描边）
  haloColor: new Set<DrawType>(['path', 'leader', 'leaderCoord', 'text', 'richText', 'bubble', 'distance', 'area']),
  // 描边宽度：**必须与 haloColor 逐字相同** —— 描边色在库里只用于文字描边，
  // 一共若干处绘制点，全部落在这些类型上（`test/demo-style-meta.spec.ts` 钉着这条）
  haloWidth: new Set<DrawType>(['path', 'leader', 'leaderCoord', 'text', 'richText', 'bubble', 'distance', 'area']),
  // ↓ 富文本「整条标注的背景」/ 圆角：**只有富文本标注**读这两个键 —— 它是唯一
  //   「一整块文字块」的类型（别的类型要么本来就是一块面、走 polygonFill，要么根本没有
  //   文字块这个概念）。★ 这与段级 `<bg=…>` 是两件事：面板这两行管**整块底板**
  //   （宽 = 最宽那行、高 = 全部行高之和），行内标签管**某几个字的高亮条**
  //   —— 2026-09-20 用户口径：「富文本应该是整个标注的背景，而不是某个标签的」。
  //   ★ 形状与命中：垫了底板时 `padOf()` 四周各放宽 3px（见 shapes/rich-text.ts），
  //     命中框跟着底板走 —— 这是类型内部的事，不用在这里体现。
  bgColor: new Set<DrawType>(['richText']),
  bgRadius: new Set<DrawType>(['richText']),
  // 边长 / 里程文字。★ 2026-09 起只剩这两个类型用得上它 —— 顶点圆点（曾经让面 / 距离 /
  //   引线也读这个键）全部去掉了，锚点 / 拐点现在只在编辑态以手柄出现
  vertexColor: new Set<DrawType>(['distance', 'area']),
  pointColor: new Set<DrawType>(['point']),
  pointRadius: new Set<DrawType>(['point']),
  nodeColor: new Set<DrawType>(['path']),
  areaColor: new Set<DrawType>(['area']),
  tickPos: new Set<DrawType>(['distance', 'area']),
  // ↓ 四个全局项：引擎读的是全局样式表，给单条图形 applyStyle 一律静默无效
  // 悬停高亮色曾在这张表里覆盖全部 8 种类型（那意味着「每条标注都能有自己的悬停色」）。
  // 它是交互反馈、不是某条标注的外观，现在与下面三个同一口径：只管全局那一份。
  hoverColor: null,
  previewColor: null,
  previewFill: null,
  snapColor: null,
};

/**
 * 这个样式键对这条图形有没有意义 —— 面板据此决定**列不列这一行**
 * （用不到的键整个不渲染，不是置灰：置灰仍然占着版面，一个「点」下面是半屏灰的）。
 *
 * 纯函数（只依赖上面那张表），所以能被用例**穷举**过一遍：
 * 41 种类型 × 21 个键 = 861 种组合，比在界面上挨个点着看可靠得多。
 *
 * @param type 作用对象的类型键；`null` = 没有作用对象（面板这时显示占位，一行都不列）
 */
export function styleAppliesTo(type: string | null, key: StyleKey): boolean {
  if (type === null) return false;
  const types = STYLE_APPLIES[key];
  // 全局项与类型无关：点、线、面改它都一样不生效，所以一律不列
  return types !== null && types.has(type as DrawType);
}

/**
 * 面板实际要渲染的分组 —— 按作用对象的类型筛掉用不到的键。
 *
 * **一行都不剩的组整个丢掉**：留下一个光秃秃的组标题，看起来就像那一组坏了。
 * 返回的顺序沿用 `STYLE_GROUPS` 的声明顺序（筛选不改变相对次序）。
 *
 * @param type 作用对象的类型键；`null` 返回空数组
 */
export function visibleStyleGroups(type: string | null): ReadonlyArray<StyleGroup> {
  if (type === null) return [];
  const out: StyleGroup[] = [];
  for (const g of STYLE_GROUPS) {
    const rows = g.rows.filter((r) => styleAppliesTo(type, r.key));
    if (!rows.length) continue;
    // 一行都没筛掉的组原样返回（标题/行都来自同一处，Vue 那边也少一次无谓的重新渲染）
    out.push(rows.length === g.rows.length ? g : { title: g.title, rows });
  }
  return out;
}

/* ---------------- 样式面板里「跟类型走」的绘制配置行 ---------------- */

/**
 * 面板里的一行**绘制配置**（Cfg）。
 *
 * ★ 和上面的 `StyleRow` 分成两张表，不是多此一举：
 *   1) key 取自**不同的类型**（`CfgKey` / `StyleKey`），控件也不同（配置要输入框、单选、
 *      开关，样式只有取色 / 数字 / 下拉）；
 *   2) 语义不一样 —— 样式键是「本图形覆盖 + 可恢复全局默认」，配置键不是
 *      （每张图形的 `cfg` 从出生起就是一张合并好的完整表，没有「覆盖 / 未覆盖」之分，
 *      面板行尾那个 `●` 对配置行不成立）。
 *   硬塞进一张表，`visibleStyleGroups` 和样式面板那套「按类型筛 / 标状态位」的纯函数
 *   就得长出一堆分支，而这正是它们能被用例穷举的原因。
 *
 * ★ 这些行**曾经在左侧「🎛 绘制配置」**，按「全局面板，改的是新建默认值」那套讲。
 *   搬过来的理由：它们全都**只对某一种类型的标注有意义**（路径文字的文字 / 分布 / 平滑、
 *   引线的文字 / 角度 / 长度），而左侧那块是「画之前先设好」的口径 —— 用户在左侧改了值、
 *   还得回到地图上去点那条线才看得见效果。放进右侧就跟着选中那条一起出现，改完即见。
 *   留在左侧的三行（途经点沿线标注 / 轮廓线 / 悬停高亮色）是**画之前的开关**或**全局项**，
 *   见 `ConfigPanel.vue`。
 */
export interface CfgRow {
  key: CfgKey;
  label: string;
  /**
   * 这一行对哪些类型有意义。
   * ★ 写在**行**上而不是组上：同一个组里可能长短不一 ——「引线文字」只对引线标注有意义
   *   （坐标引线标注的文字是自动算出来的经纬度，不给手改），而同一组的「引线角度 / 长度」
   *   两种引线都要用。
   */
  types: ReadonlyArray<DrawType>;
  /**
   * `text` = 单行输入框 / `textarea` = **多行**输入框（回车换行；文字标注 / 富文本标注
   * 的文字用它）
   * / `number` / `radio` / `switch`。
   */
  kind: 'text' | 'textarea' | 'number' | 'radio' | 'switch';
  /** 鼠标停在标签上时的说明（一句话） */
  hint?: string;
  /** `kind === 'text' | 'textarea'` 的占位提示 */
  placeholder?: string;
  /* kind === 'number' */
  min?: number;
  max?: number;
  step?: number;
  /** 数字行是否在下面配一条滑块（角度那种「拖着试」比敲数字快的） */
  slider?: boolean;
  /* kind === 'radio' */
  options?: ReadonlyArray<{ value: string; label: string }>;
}

/** 面板里的一个**配置**分组 */
export interface CfgGroup {
  title: string;
  /** 组标题下面那行小字：这类标注「怎么用」。空 = 不显示 */
  note?: string;
  rows: ReadonlyArray<CfgRow>;
}

/**
 * 配置行的分组与声明顺序 —— 面板里**排在样式行前面**。
 *
 * 为什么排前面：这两组管的是「这条标注**写什么、长多长**」（文字内容、引线几何），
 * 是用户点开一条标注最常要改的东西；样式行管的是「长什么样」，是调完前者之后的第二步。
 *
 * `test/demo-style-meta.spec.ts` 钉着这张表：每行都落在合法类型上、radio 行有默认选项、
 * 以及**每种类型实际渲染哪几行**（界面上一行多了 / 少了，跟「这个版本就这样」长得一模一样）。
 */
export const CFG_GROUPS: ReadonlyArray<CfgGroup> = [
  {
    title: '路径文字标注',
    note: '文字沿折线平均铺开；「紧凑字距」保持自然间距、只在线长放不下时才压缩。',
    rows: [
      {
        key: 'text',
        label: '路径文字',
        types: ['path'],
        kind: 'text',
        placeholder: '沿线文字（输入即生效）',
      },
      {
        key: 'spread',
        label: '分布方式',
        types: ['path'],
        kind: 'radio',
        options: [
          { value: 'spread', label: '铺满全线' },
          { value: 'tight', label: '紧凑字距' },
        ],
      },
      {
        key: 'smooth',
        label: '平滑曲线',
        types: ['path'],
        kind: 'switch',
        hint: '把折线拐点圆滑后再沿线铺字；关掉则文字沿原始折线摆放',
      },
    ],
  },
  {
    title: '引线标注',
    note: '角度只决定引线走向，文字始终水平正向。坐标引线标注的文字不用手打（自动取锚点经纬度）。',
    rows: [
      {
        key: 'text',
        label: '引线文字',
        types: ['leader'],
        kind: 'text',
        placeholder: '例：人民广场 · 东北入口',
      },
      {
        key: 'angle',
        label: '引线角度 °',
        types: ['leader', 'leaderCoord'],
        kind: 'number',
        min: 0,
        max: 360,
        step: 1,
        slider: true,
        hint: '顺时针：0=右 90=下 180=左 270=上',
      },
      {
        key: 'len',
        label: '引线长度 (px)',
        types: ['leader', 'leaderCoord'],
        kind: 'number',
        min: 10,
        max: 300,
        step: 1,
      },
    ],
  },
  {
    title: '文字标注',
    note: '文字以落点为中心摆开；**回车换行 ＝ 多行**（行距随字号）。'
      + '颜色与字号在下面的样式行里调，旋转角度在「几何参数」里调。'
      + '整块文字一个样式 —— 要**一行里几种字号 / 颜色**请用「富文本标注」。',
    rows: [
      {
        key: 'text',
        label: '文字内容',
        types: ['text'],
        kind: 'textarea',
        placeholder: '输入文字，回车换行（支持多行）',
      },
    ],
  },
  {
    title: '富文本标注',
    note: '与「文字标注」同一套交互，区别是**一行里可以有几种样式**：'
      + '<b> 加粗、<i> 斜体、<u> 下划线、<s=24> 字号、<c=#e03131> 颜色、'
      + '<bg=#fff3bf> 局部高亮条、<r=8> 高亮条圆角（<bg=none> 关掉高亮条），'
      + '闭标签统一写 </>（可嵌套、可写在一起：<b s=20 c=#e03131>）。'
      + '认不出来的 <…> 原样当文字显示；没写字号 / 颜色的段取下面的样式行。'
      + '★ 整条标注的背景（一整块）是样式行里的「背景底色」，与这儿的高亮条是两件事。',
    rows: [
      {
        key: 'text',
        label: '富文本内容',
        types: ['richText'],
        kind: 'textarea',
        placeholder: '例：<b s=22>标题</> <bg=#fff3bf r=6>高亮</>小字（回车换行）',
      },
    ],
  },
  {
    title: '气泡标注',
    note: '落点＝尾巴尖端，气泡体悬在点的正上方；**回车换行 ＝ 多行**。'
      + '文字颜色 / 字号与边框在下面的样式行里调。',
    rows: [
      {
        key: 'text',
        label: '气泡文字',
        types: ['bubble'],
        kind: 'textarea',
        placeholder: '输入气泡文字，回车换行（支持多行）',
      },
    ],
  },
];

/** 这个配置行对这条图形有没有意义 */
export function cfgAppliesTo(type: string | null, row: CfgRow): boolean {
  return type !== null && row.types.includes(type as DrawType);
}

/* ---------------- 样式面板里「跟类型走」的几何行 ---------------- */

/**
 * 面板里的一行**几何参数**（当前选中那条图形的「摆成什么样」）。
 *
 * ★ 第三套行，与上面两套都不是一回事，所以也没并进那两张表（见 `GeomKey` 那段）：
 *   · 配置行（`CfgRow`）改的是「这条标注写什么 / 长多长」，会顺带写进全局默认供新图形继承；
 *   · 样式行（`StyleRow`）改的是外观，能单图形覆盖、也能一键恢复跟随全局；
 *   · 几何行改的是**此刻摆在哪儿 / 多大 / 多斜** —— 每条图形各不相同、不参与任何继承，
 *     也不该有「恢复默认」这个动作（它的「默认」就是它落地那一刻的样子，没有意义）。
 *   落到界面上有两条看得见的差别：几何行**没有行尾那个 ●**（不是覆盖），也**不受
 *   底部「↺ 恢复默认样式」影响**（那个按钮只管样式）。
 *
 * 目前有三类图形有几何可调：图片标注（转了多大、缩了多少）与文字标注 / 富文本标注
 * （转了多大）。
 * 控件一律是数字框（+ 可选滑块）——
 * 角度与长度都是数字，所以这里不设 `kind`：等真出现非数字的几何参数（比如「左右翻转」
 * 这种开关）再加，那时才有第二个分支可写。
 */
export interface GeomRow {
  key: GeomKey;
  label: string;
  /** 这一行对哪些类型有意义（写法同 `CfgRow.types`：写在行上，同一个组里长短可以不一） */
  types: ReadonlyArray<DrawType>;
  /** 鼠标停在标签上时的说明（一句话） */
  hint?: string;
  min: number;
  max: number;
  step: number;
  /** 是否在下面配一条滑块（「拖着试」比敲数字快的那些） */
  slider?: boolean;
}

/** 面板里的一个**几何**分组 */
export interface GeomGroup {
  title: string;
  /** 组标题下面那行小字：这一组调的是什么。空 = 不显示 */
  note?: string;
  rows: ReadonlyArray<GeomRow>;
}

/**
 * 几何行的分组与声明顺序 —— 面板里排在配置行**后面**、样式行**前面**。
 *
 * 为什么夹在中间：上面那块是「这条标注写什么」、这块是「它摆成什么样」、
 * 下面那块才是「它长什么样」—— 从内容到位置到外观，正好是调一条标注的三步。
 *
 * `test/demo-style-meta.spec.ts` 钉着这张表（键是不是合法 `GeomKey`、范围有没有写歪、
 * 每种类型实际渲染几行）—— 界面上少一行跟「这个版本就这样」长得一模一样。
 */
export const GEOM_GROUPS: ReadonlyArray<GeomGroup> = [
  {
    title: '几何参数',
    note: '调的是**你眼前这条标注**：角度 0 = 正放（顺时针为正）；改它不动中心 ——'
      + '图片绕自己的中心转、绕自己的中心缩，文字（含富文本）绕自己的锚点转。',
    rows: [
      {
        key: 'rotateDeg',
        label: '旋转角度 °',
        types: ['image', 'text', 'richText'],
        min: 0,
        max: 360,
        step: 1,
        slider: true,
        hint: '0 = 正放（不转），顺时针为正；与拖那个圆柄是同一件事',
      },
      {
        key: 'sizePx',
        label: '尺寸（长边 px）',
        types: ['image'],
        min: 8,
        max: 1000,
        step: 1,
        slider: true,
        hint: '图片长边在屏幕上的长度；短边按原比例跟着走（等比锁定）',
      },
    ],
  },
];

/** 这个几何行对这条图形有没有意义 */
export function geomAppliesTo(type: string | null, row: GeomRow): boolean {
  return type !== null && row.types.includes(type as DrawType);
}

/**
 * 面板实际要渲染的几何分组 —— 按作用对象的类型筛掉用不到的行。
 *
 * 与 `cfgGroupsFor` / `visibleStyleGroups` 是**同一套口径**：一行都不剩的组整个丢掉
 * （留一个光秃秃的组标题，看起来就像那一组坏了），顺序沿用 `GEOM_GROUPS` 的声明顺序。
 *
 * @param type 作用对象的类型键；`null` 返回空数组（面板这时显示占位文案）
 */
export function geomGroupsFor(type: string | null): ReadonlyArray<GeomGroup> {
  if (type === null) return [];
  const out: GeomGroup[] = [];
  for (const g of GEOM_GROUPS) {
    const rows = g.rows.filter((r) => geomAppliesTo(type, r));
    if (!rows.length) continue;
    // 一行都没筛掉的组原样返回（同那两张表）
    out.push(rows.length === g.rows.length ? g : { title: g.title, note: g.note, rows });
  }
  return out;
}

/**
 * 面板实际要渲染的配置分组 —— 按作用对象的类型筛掉用不到的行。
 *
 * 与 `visibleStyleGroups` 是**同一套口径**：一行都不剩的组整个丢掉（留一个光秃秃的
 * 组标题，看起来就像那一组坏了），顺序沿用 `CFG_GROUPS` 的声明顺序。
 *
 * @param type 作用对象的类型键；`null` 返回空数组（面板这时显示占位文案）
 */
export function cfgGroupsFor(type: string | null): ReadonlyArray<CfgGroup> {
  if (type === null) return [];
  const out: CfgGroup[] = [];
  for (const g of CFG_GROUPS) {
    const rows = g.rows.filter((r) => cfgAppliesTo(type, r));
    if (!rows.length) continue;
    // 一行都没筛掉的组原样返回（同 `visibleStyleGroups`）
    out.push(rows.length === g.rows.length ? g : { title: g.title, note: g.note, rows });
  }
  return out;
}
