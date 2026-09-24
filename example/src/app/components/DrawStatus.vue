<!--
  DrawStatus.vue —— 「正在绘制」状态条。贴在列表顶上，只在真的在画的时候出现。

  两个部分：
    · 第一行 —— 当前类型 + 「取消」。类型名走引擎的 typeLabel()，图标按类型名取；
    · 第二行 —— 该类型的按键提示（来自 `tool.typeHint()`，**含 HTML**，故 v-html）。
      ★ 它是「现在点地图会发生什么」的即时说明，必须一眼看见：
        折线要双击结束、矩形只要两击、自由线是「单击 → 描摹 → 再单击」……
        这些手势彼此不一样，不给提示就只能靠试。

  为什么单独一个组件：绘制状态要从**任何视图**都看得见（列表视图里也会有人正在画），
  而它的数据只跟引擎有关，跟哪块面板都无关。
-->
<template>
  <div v-if="shown" class="pn-draw">
    <div class="pn-draw-top">
      <AppIcon :name="shown.type" :size="15" />
      <span>正在绘制 · {{ typeLabel(shown.type) }}</span>
      <button class="pn-draw-x" title="取消绘制（Esc）" @click="cancel">取消</button>
    </div>
    <div v-if="shown.hint" class="pn-draw-hint" v-html="shown.hint" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import AppIcon from './AppIcon.vue';
import { useSketchContext } from '../use-sketch';

const sk = useSketchContext();
const { drawingType, drawHint, typeLabel, toggleDraw } = sk;

/**
 * 最后一份「真的在画」的内容快照。
 * ★ 收起动画期间渲染的是它，不是实时的 `drawingType`：外层 `.pn-fold` 的 0fr 过渡
 *   要量「内容有多高」，`drawingType` 一归零就把内容摘掉的话，1fr 当场等于 0，
 *   那条 75px 的带子会被一帧收完（实测：26px → 0px 只花 1 帧，看着就是「啪」地消失）。
 *   渲染快照之后，收起时字还在、带子慢慢缩，收完整个组件随外层一起被摘掉。
 */
const last = ref<{ type: string; hint: string } | null>(null);

/** 显示用的内容：真在画时用实时值（提示可能是随手势变的），否则用快照 */
const shown = computed(() =>
  drawingType.value ? { type: drawingType.value, hint: drawHint.value } : last.value,
);

watch(
  [drawingType, drawHint],
  () => {
    if (drawingType.value) last.value = { type: drawingType.value, hint: drawHint.value };
  },
  { immediate: true },
);

/** 再点一次同一类型 = 取消（与选择器里那颗按钮同一条规则，见 use-sketch 的 toggleDraw） */
function cancel(): void {
  const t = drawingType.value;
  if (t) toggleDraw(t);
}
</script>
