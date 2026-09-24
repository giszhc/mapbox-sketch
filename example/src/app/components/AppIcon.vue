<!--
  AppIcon.vue —— demo 的**唯一**图标来源。

  一套 24×24 网格的线性图标：`fill: none` + `stroke: currentColor`，圆头圆角，
  **视觉线宽恒为 1.5px**（见 `strokeWidth` 的反算 —— 24 网格的数值随显示尺寸缩放，
  同一个 `stroke-width` 在 16px 和 11px 两处画出来的粗细差一倍）。

  为什么要有这个文件：
    · 面板上原来混着彩色 Emoji（🗺️ ✏ 🎨 🗑 👁）与零散 Unicode 符号（⚑ ∿ ⊥ ⌖），
      两套设计语言、几个色系挤在一起，跟「专业制图工具」的克制感正相反。
      现在全部走这一份图标集，**任何地方都不再直接写 Emoji**。
    · 41 个绘制类型按钮的图标按类型名取（`<AppIcon :name="b.type" />`），
      与 `samples.ts` 里 `DRAW_BUTTONS[].type` 同键 —— 加新类型时这里补一条即可，
      不需要在数据里塞图标字符。

  颜色一律跟着 CSS 的 `color` 走（currentColor）：默认 #64748B、hover #334155、
  激活态 #1677FF 全由使用处的 CSS 决定，图标本身不认颜色。

  尺寸：默认 16px（面板正文、按钮内），列表行小按钮传 14，角标传 20。
-->
<template>
  <svg
    class="ico"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <template v-for="(p, i) in parts" :key="i">
      <path
        v-if="p.t === 'p'"
        :d="p.d"
        :stroke-dasharray="p.dash"
        :fill="p.fill ? 'currentColor' : 'none'"
      />
      <circle
        v-else-if="p.t === 'c'"
        :cx="p.cx"
        :cy="p.cy"
        :r="p.r"
        :fill="p.fill ? 'currentColor' : 'none'"
      />
      <ellipse v-else-if="p.t === 'e'" :cx="p.cx" :cy="p.cy" :rx="p.rx" :ry="p.ry" />
      <rect v-else :x="p.x" :y="p.y" :width="p.w" :height="p.h" :rx="p.fr" />
    </template>
  </svg>
</template>

<script setup lang="ts">
import { computed } from 'vue';

/** 一个图元。字段全部可选：按 `t` 取用哪些由模板里的分支决定（不用联合类型，模板里 narrowing 不可靠） */
interface Part {
  /** p = path / c = circle / e = ellipse / r = round-rect */
  t: 'p' | 'c' | 'e' | 'r';
  d?: string;
  cx?: number;
  cy?: number;
  r?: number;
  rx?: number;
  ry?: number;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  /** 圆角矩形的圆角半径 */
  fr?: number;
  /** 虚线（国界那种） */
  dash?: string;
  /** 实心（圆点、锚点） */
  fill?: boolean;
}

const props = withDefaults(defineProps<{
  /** 图标名：通用 UI 名或 41 个绘制类型名 */
  name: string;
  /** 显示边长（px） */
  size?: number;
  /** 覆盖线宽（不传 = 按 size 反算，保证视觉线宽 1.5px） */
  strokeWidth?: number;
}>(), { size: 16, strokeWidth: undefined });

/** 短帮手：path / 实心圆 / 空心圆 / 椭圆 / 圆角矩形 */
const p = (d: string, extra?: Partial<Part>): Part => ({ t: 'p', d, ...extra });
const c = (cx: number, cy: number, r: number, fill = false): Part => ({ t: 'c', cx, cy, r, fill });
const dot = (cx: number, cy: number, r = 1.5): Part => c(cx, cy, r, true);
const e = (cx: number, cy: number, rx: number, ry: number): Part => ({ t: 'e', cx, cy, rx, ry });
const box = (x: number, y: number, w: number, h: number, fr = 1.5): Part => ({ t: 'r', x, y, w, h, fr });

/**
 * 图标表。
 *
 * 绘制类型那 41 条取的是**类型名**（与 `samples.ts` 的 `DRAW_BUTTONS[].type` 同键），
 * 画的是该类标注的几何抽象 —— 「点 / 线 / 面 / 箭头 / 旗 / 沿线符号」六族，
 * 同族用同一套视觉母题，只改比例，这样 41 个图标摆成两列网格时不会各自为政。
 */
const ICONS: Record<string, Part[]> = {
  /* ---------------- 通用 UI ---------------- */
  // 建图：罗盘（原 🧭）
  compass: [c(12, 12, 8.5), p('M15.6 8.4 13.6 13.6 8.4 15.6 10.4 10.4z')],
  // 手绘（原 ✏）
  pencil: [
    p('M4 20l.9-4.2L15.6 5.1a2 2 0 0 1 2.8 0l.5.5a2 2 0 0 1 0 2.8L8.2 19.1z'),
    p('M14 6.7l3.3 3.3'),
  ],
  // 绘制配置（原 🎛）
  sliders: [
    p('M4 8h8'), p('M19 8h1'), p('M4 16h2'), p('M13 16h7'),
    c(15.5, 8, 2), c(10.5, 16, 2),
  ],
  // 测量（原 📏）
  ruler: [
    box(2.5, 8.5, 19, 7, 1.5),
    p('M7 8.5v3'), p('M11 8.5v3'), p('M15 8.5v3'), p('M19 8.5v3'),
  ],
  // 已绘图形（原 📋）
  list: [
    dot(5.5, 7, 1.1), dot(5.5, 12, 1.1), dot(5.5, 17, 1.1),
    p('M9.5 7h10'), p('M9.5 12h10'), p('M9.5 17h10'),
  ],
  // 数据（原 💾）
  database: [
    e(12, 6.4, 7.5, 3),
    p('M4.5 6.4v11.2c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6.4'),
    p('M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3'),
  ],
  // 样式设置（原 🎨）—— 抽象调色盘：一圈 + 四枚色点
  palette: [
    c(12, 12, 8.5),
    dot(9, 9.2, 1.2), dot(15, 9.2, 1.2), dot(8.8, 14.8, 1.2), dot(13.8, 15.4, 1.2),
  ],
  // 底图（原 🗺️）
  map: [
    p('M3.5 6.6 9 4.6l6 2.4 5.5-2v13l-5.5 2-6-2.4-5.5 2z'),
    p('M9 4.6v13'), p('M15 7v13'),
  ],
  search: [c(11, 11, 6.4), p('M15.6 15.6 20.5 20.5')],
  eye: [
    p('M2.6 12S6.2 6.2 12 6.2 21.4 12 21.4 12 17.8 17.8 12 17.8 2.6 12 2.6 12z'),
    c(12, 12, 2.7),
  ],
  eyeOff: [
    p('M4 4l16 16'),
    p('M9.9 9.8A2.9 2.9 0 0 0 12 14.9a2.9 2.9 0 0 0 2.2-1.1'),
    p('M6.5 7.4C4 8.9 2.6 12 2.6 12s3.6 5.8 9.4 5.8c1.6 0 3-.4 4.2-1'),
    p('M18.5 15.3c1.9-1.5 2.9-3.3 2.9-3.3S17.8 6.2 12 6.2c-.7 0-1.4.1-2 .3'),
  ],
  trash: [
    p('M4.5 7h15'), p('M9.5 7V4.6h5V7'),
    p('M6.6 7l1 12.9h8.8l1-12.9'),
    p('M10.2 10.4v6'), p('M13.8 10.4v6'),
  ],
  x: [p('M6.2 6.2 17.8 17.8'), p('M17.8 6.2 6.2 17.8')],
  download: [p('M12 3.6v11.2'), p('M8 11l4 3.6 4-3.6'), p('M4.5 19.4h15')],
  upload: [p('M12 19.4V8.2'), p('M8 11.6 12 8l4 3.6'), p('M4.5 4.6h15')],
  target: [
    c(12, 12, 7.5), c(12, 12, 2),
    p('M12 2v3.4'), p('M12 18.6V22'), p('M2 12h3.4'), p('M18.6 12H22'),
  ],
  // 拖拽排序手柄（原 ⠿ 盲文点）
  grip: [
    dot(9, 7, 1.1), dot(15, 7, 1.1), dot(9, 12, 1.1),
    dot(15, 12, 1.1), dot(9, 17, 1.1), dot(15, 17, 1.1),
  ],
  reset: [p('M4.2 12a7.8 7.8 0 1 0 2.4-5.6'), p('M4 4.4v5.6h5.6')],
  check: [p('M5 12.5 9.6 17 19 7')],
  // 新建（面板头部的「＋」）
  plus: [p('M12 5.2v13.6'), p('M5.2 12h13.6')],
  // 设置（齿轮：双圈 + 八根短齿，面板头部的齿轮按钮）
  gear: [
    c(12, 12, 6.6), c(12, 12, 2.6),
    p('M12 5.4V2.9'), p('M12 18.6v2.5'), p('M5.4 12H2.9'), p('M18.6 12h2.5'),
    p('M7.3 7.3 5.6 5.6'), p('M16.7 16.7l1.7 1.7'), p('M16.7 7.3l1.7-1.7'), p('M7.3 16.7 5.6 18.4'),
  ],
  // 返回（视图左上角）
  back: [p('M19 12H5.4'), p('M10.6 6.4 5 12l5.6 5.6')],

  /* ---------------- 点 / 文字 ---------------- */
  // 点标注：中心实心点 + 外圈
  point: [c(12, 12, 6.4), dot(12, 12, 2.2)],
  text: [p('M4.5 6.4h15'), p('M12 6.4v11.2'), p('M9.4 17.6h5.2')],
  richText: [
    p('M3.4 6.4h8'), p('M7.4 6.4v11.2'),
    p('M14.6 8.4h5.8'), p('M14.6 12h5.8'), p('M14.6 15.6h3.6'),
  ],
  bubble: [box(3.4, 5.6, 17.2, 10, 2.4), p('M9 15.6v3.9L12.6 15.6')],

  /* ---------------- 线 ---------------- */
  line: [
    p('M3.4 18 8.4 9l5 5.6L20.6 6'),
    dot(3.4, 18), dot(8.4, 9), dot(13.4, 14.6), dot(20.6, 6),
  ],
  curve: [p('M3.4 17.4C7 8.6 11.6 20 20.6 6.6'), dot(3.4, 17.4), dot(20.6, 6.6)],
  freeLine: [p('M3.2 16.4c2-5.6 3.6-7.6 5.2-3s3.2 1.6 4.8-2.8 4-5.2 7.6-5.6')],
  path: [
    p('M3 16.4c4.6 0 5.2-9 9-9s4.4 9 9 9'),
    p('M8 14h3.2'), p('M14 9.6h3.2'),
  ],
  distance: [
    box(2.6, 8.6, 18.8, 6.8, 1.5),
    p('M7 8.6v2.6'), p('M11 8.6v2.6'), p('M15 8.6v2.6'), p('M19 8.6v2.6'),
  ],
  area: [
    p('M4.4 7.4h15.2v9.2H4.4z'),
    p('M8.4 7.4v2.2'), p('M12 7.4v2.2'), p('M15.6 7.4v2.2'),
    p('M8.4 16.6v-2.2'), p('M15.6 16.6v-2.2'),
  ],
  leader: [
    p('M4.4 19 10 13.4'), p('M10 13.4h10'), p('M10 13.4V9.2'),
  ],
  leaderCoord: [
    p('M4.4 19 10 13.4h10'),
    p('M11.4 10.6h6.6'), p('M11.4 16.2h6.6'),
  ],

  /* ---------------- 面 ---------------- */
  polygon: [p('M12 4 20 9.6 17 19.6H7L4 9.6z')],
  freeArea: [p('M4 15.4c1-6 4.6-9.6 8-6.6s4.6 5 7.6 1.6c.6 6-3 9.6-7.6 9.6S5 20 4 15.4z')],
  closedCurve: [p('M9 4.8c4.6-1.4 9.4 1.6 10.2 6s-2.6 8-7.2 9-9.6-1.8-9.8-6.4S4.4 6.2 9 4.8z')],
  rect: [box(4, 6.6, 16, 11, 1.4)],
  circle: [c(12, 12, 7.6)],
  ellipse: [e(12, 12, 8.6, 5.9)],
  annulus: [c(12, 12, 8), c(12, 12, 4)],
  sector: [p('M12 12 12 4.5A7.5 7.5 0 0 1 15.8 18.5z')],
  lune: [p('M3.6 16.2A9.4 9.4 0 0 1 20.4 16.2z')],
  arc: [p('M3.6 16.4A9.4 9.4 0 0 1 20.4 16.4')],
  // 集结地：一块面 + 圆上三个锚点（三击成形的口径）
  assembly: [
    c(12, 12, 7.6),
    dot(12, 4.9, 1.4), dot(6.5, 15, 1.4), dot(17.5, 15, 1.4),
  ],

  /* ---------------- 沿线符号 ---------------- */
  railway: [p('M5.6 4v16'), p('M18.4 4v16'), p('M3.6 8h16.8'), p('M3.6 13h16.8'), p('M3.6 18h16.8')],
  border: [p('M3 12h18', { dash: '4.5 2.2 1 2.2' })],
  powerline: [
    p('M6 20.6V10'), p('M18 20.6V10'),
    p('M3 10h18'), p('M12 10v10.6'), p('M9.2 20.6h5.6'),
  ],
  pipeline: [p('M3 9.4h18'), p('M3 14.6h18'), p('M7.4 9.4v5.2'), p('M16.6 9.4v5.2')],
  parallel: [p('M3.6 8.6h13.4'), p('M7 15.4h13.4')],
  perpendicular: [p('M3.6 18h16.8'), p('M12 18V5.4')],

  /* ---------------- 旗 ---------------- */
  flag: [p('M6 3.6v16.8'), p('M6 4.6h11.6l-2.6 3.8 2.6 3.8H6')],
  flagTri: [p('M6 3.6v16.8'), p('M6 4.6 16.6 9 6 13.4z')],
  flagWave: [p('M6 3.6v16.8'), p('M6 6.6c4-2 7 2.6 11 0v7.6c-4 2.6-7-2-11 0z')],

  /* ---------------- 箭头 ---------------- */
  doubleArrow: [
    p('M3.6 12h16.8'),
    p('M7.2 8.4 3.6 12l3.6 3.6'),
    p('M16.8 8.4 20.4 12l-3.6 3.6'),
  ],
  fineArrow: [p('M3.6 12h13.4'), p('M13 8.5 20.4 12 13 15.5z')],
  straightArrow: [p('M4 9.5h8V6.5L20.5 12 12 17.5V14.5H4z')],
  assaultDirection: [p('M4 11h6.6V6.4L20.5 12 10.6 17.6V13H4z')],
  attackArrow: [
    p('M3.6 9c4.6-3.2 9.2-3.2 13 0'),
    p('M3.6 15c4.6 3.2 9.2 3.2 13 0'),
    p('M16 8.4 20.4 12 16 15.6'),
  ],
  tailedAttackArrow: [
    p('M6.6 9.4 4 12l2.6 2.6'),
    p('M6.6 9c3.6-2.6 7.6-2.6 11 0'),
    p('M6.6 15c3.6 2.6 7.6 2.6 11 0'),
    p('M17 8.4 21 12l-4 3.6'),
  ],
  squadCombat: [p('M3.6 12h8.6'), p('M12 8 20.4 12 12 16z')],
  tailedSquadCombat: [
    p('M3.4 9 6.4 12l-3 3'), p('M6.4 12h5.4'), p('M11.6 8 20.4 12l-8.8 4z'),
  ],

  /* ---------------- 图片 ---------------- */
  image: [
    box(3.4, 5.6, 17.2, 12.8, 2),
    c(8.6, 10, 1.5),
    p('M4.4 16.6 9 12.2l3.6 3.4L15.4 13l4.6 4'),
  ],
};

/** 认不出的名字退回一个中性方块，不抛错（新类型先加数据、后补图标时不会白屏） */
const FALLBACK: Part[] = [box(4, 4, 16, 16, 2.4), dot(12, 12, 1.2)];

const parts = computed<Part[]>(() => ICONS[props.name] ?? FALLBACK);

/**
 * 线宽按尺寸反算：24 网格的数值会随显示尺寸一起缩放，所以固定 `stroke-width` 在
 * 16px 与 11px 两处画出来粗细差一倍。这里换算出「视觉恒定 1.5px」的网格值。
 */
const strokeWidth = computed<number>(
  () => props.strokeWidth ?? Math.round((1.5 * 24 / props.size) * 10) / 10,
);
</script>

<style scoped>
.ico {
  display: block;
  flex: none;
  /* 图标跟着文字走，不参与基线对齐的偏移 */
  vertical-align: middle;
}
</style>
