<!--
  PaperFrame.vue —— 屏幕上的**纸张取景框**：一圈虚线标出「这张纸会覆盖哪一块」，
  框外压暗。

  为什么要有它：纸张模式（A0–A6）导出的**不是**当前视口 —— 取景范围由纸张尺寸决定
  （纸上一毫米 ＝ 屏幕上 96/25.4 ≈ 3.78 个 CSS 像素的地理范围），窗口 16:9 而 A4 是
  1:1.414，成品里会切掉一截。没有这圈框的话，用户只能靠「导一张出来看看」才知道
  自己要的是什么，而导出一次要等几分钟。

  几个刻意的选择：

  1. **几何全部来自桥的 `exportPaperFrame`**（它又是拿库的 `planExport()` 算的），
     这里一个减法都不做。框画在哪必须与引擎实际取到哪是**同一个算式** ——
     抄一份的话，库改了居中口径，框和成品就会差半个框，而用户是照着框判断的。

  2. **`z-index: 6` 是唯一合适的档**：高于引擎自己的标注覆盖层（`z-index: 5`，
     见 sketch.ts 的 `_buildCanvas`）—— 压暗要连标注一起压暗；低于左右面板（10）、
     错误条（20）和出图遮罩（100）—— 面板与遮罩**不该**被压暗。

  3. **不随地图平移缩放动**：框的尺寸只由纸张决定，位置只由容器尺寸决定
     （`(容器宽 − 纸宽) / 2`），所以**一个地图事件都不用监听**。切换纸张 / 缩放窗口
     时由桥的 `version` 驱动重算。

  4. **「跟随视口」时整层不渲染**（那圈框就是屏幕边缘，画出来只是一圈贴边的虚线）。

  5. 框比视口大时（A0/A1）阴影自然看不见 —— 整屏都在框内，语义正好是「整屏都进图」；
     框的虚线边被 `html,body{overflow:hidden}` 裁掉，也符合预期。

  6. **自动分块**（整张超出单块像素预算，见 ExportImagePanel 文件头第 4 条）时框里多出
     切块线与每格的序号。线用**百分比**定位（`i / cols`），不是像素 —— 框的尺寸随纸张和
     窗口一直在变，算像素就得跟着重算一遍，而百分比天然跟着框走。
     序号与文件名里的块序号同源（都是 1 起、从左到右、从上到下）。

     ★ 切块线**只有纸张模式才画**（整层 `v-if="frame"`，跟随视口时 `frame` 是 null）。
       跟随视口也可能自动分块（4K @600dpi），但那时框就是屏幕边缘、压暗与虚线都没有，
       再画一堆切块线只会横在画面上碍事 —— 那种情况由面板那行文字说明切成几张。
-->
<template>
  <div v-if="frame" class="paper-frame">
    <!-- 框本身。`box-shadow` 那 9999px 的 spread 就是「框外压暗」，
         再叠一道 1px 的深色描边，浅色影像上才看得见这圈虚线（同文字白描边的思路） -->
    <div class="paper-box" :style="boxStyle">
      <!-- 自动分块时把纸**切开的地方**画出来 + 每格一个序号：用户要能一眼看出「会切成几块、
           每块盖哪」，而不是导出完解压才知道。线用百分比定位，于是框多大都自动对得上 -->
      <template v-if="grid">
        <div
          v-for="i in grid.cols - 1"
          :key="`v${i}`"
          class="cut cut-v"
          :style="{ left: `${(i / grid.cols) * 100}%` }"
        />
        <div
          v-for="j in grid.rows - 1"
          :key="`h${j}`"
          class="cut cut-h"
          :style="{ top: `${(j / grid.rows) * 100}%` }"
        />
        <span v-for="n in grid.cols * grid.rows" :key="`n${n}`" class="cut-no" :style="cellNoStyle(n)">
          {{ n }}
        </span>
      </template>
    </div>
    <!-- 角标贴在被框住的**可见**区域的左上角：框比视口大时（A0/A1）框自己的左上角
         在屏幕外，直接贴上去就永远看不见了 -->
    <span class="paper-tag" :style="tagStyle">{{ tagText }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useSketchContext } from '../use-sketch';

const sk = useSketchContext();
// ★ 同 ShapeList：必须解构到顶层绑定，模板里的 proxyRefs 才会自动解包
const {
  exportPaperFrame: frame, exportPaperLabel: label, exportPaperMm: mm, exportGrid: grid,
} = sk;

/**
 * 第 `n` 格序号角标的定位（`n` 是**给用户看的 1 起**序号，与文件名里的块序号同源）。
 *
 * 行列换算与桥/库一致：从左到右、从上到下，`index = row × cols + col`。
 * 角标贴在该格左上角**内侧**几像素 —— 贴正角上会与外框虚线/切块线糊在一起。
 */
function cellNoStyle(n: number): Record<string, string> {
  const g = grid.value;
  if (!g) return {};
  const i = n - 1;
  const col = i % g.cols;
  const row = Math.floor(i / g.cols);
  return {
    left: `calc(${(col / g.cols) * 100}% + 4px)`,
    top: `calc(${(row / g.rows) * 100}% + 4px)`,
  };
}

const boxStyle = computed(() => {
  const f = frame.value;
  if (!f) return undefined;
  return {
    // 相对**视口**左上角。`#map` 是 inset:0 铺满视口的（global.css），所以容器的
    // 左上角就是视口的左上角 —— 桥给的那份偏移可以原样用。哪天 #map 不再铺满，
    // 就得改成读容器的 getBoundingClientRect() 再补上这个偏移。
    left: `${f.x}px`,
    top: `${f.y}px`,
    width: `${f.w}px`,
    height: `${f.h}px`,
  };
});

const tagStyle = computed(() => {
  const f = frame.value;
  if (!f) return undefined;
  const { w: vw, h: vh } = sk.viewportSize.value;
  // 夹进视口：框比视口大时取屏幕边缘，比视口小则贴着框的左上角内侧
  const left = Math.max(6, Math.min(f.x + 6, vw - 6));
  const top = Math.max(6, Math.min(f.y + 6, vh - 6));
  return { left: `${left}px`, top: `${top}px` };
});

/** 角标文案：`A4纵 210×297mm`（与文件名里那段标签同源） */
const tagText = computed(() => {
  const m = mm.value;
  return m ? `${label.value} ${m.w}×${m.h}mm` : label.value;
});
</script>

<style scoped>
/* fixed inset:0 = 视口；pointer-events:none 保证不挡地图与面板的交互 */
.paper-frame {
  position: fixed;
  inset: 0;
  z-index: 6;
  pointer-events: none;
}

/* 框外压暗 + 白色虚线边。★ 这两样都是**功能性**的，不参与上面的 UI 降噪：
   压暗是「框外不进图」的唯一提示，白虚线是框界 —— 去掉任何一个，用户就只能靠
   「导一张出来看看」判断取景范围（一次要等几分钟）。 */
.paper-box {
  position: absolute;
  border: 1px dashed rgba(255, 255, 255, 0.95);
  /* 第一道是「框外压暗」，第二道是虚线自己的深色描边（浅底图上白虚线看不见） */
  box-shadow: 0 0 0 9999px rgba(15, 23, 42, 0.34), 0 0 0 1px rgba(15, 23, 42, 0.3);
}

/* 切块线。深色描边同虚线框的思路：浅色影像上纯白线看不见 */
.cut {
  position: absolute;
  background: rgba(255, 255, 255, 0.8);
  box-shadow: 0 0 0 1px rgba(15, 23, 42, 0.28);
}

.cut-v {
  top: 0;
  bottom: 0;
  width: 1px;
}

.cut-h {
  left: 0;
  right: 0;
  height: 1px;
}

/* 每格的序号角标：深灰蓝（slate-900）而不是纯黑 —— 与本 UI 的深色文字同源，
   压在影像上也比纯黑柔一点 */
.cut-no {
  position: absolute;
  padding: 0 5px;
  border-radius: 4px;
  background: rgba(15, 23, 42, 0.72);
  color: #fff;
  font-size: 10px;
  line-height: 15px;
  font-variant-numeric: tabular-nums;
}

.paper-tag {
  position: absolute;
  padding: 2px 7px;
  border-radius: 5px;
  background: rgba(15, 23, 42, 0.78);
  color: #fff;
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
  box-shadow: var(--sh-1);
}
</style>
