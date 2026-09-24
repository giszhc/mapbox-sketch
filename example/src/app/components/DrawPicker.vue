<!--
  DrawPicker.vue —— 「选择标注类型」视图（面板主体）。

  41 个类型按语义分组（点与文字 / 线状 / 面状 / 箭头 / 标志旗 / 量算与引线），
  单列排布 + 顶部搜索。

  ★ 单列而不是两列：300px 的面板里两列会把「分队战斗行动尾标注」这类长名字全部截掉一半，
    而截掉的那一半正是用来区分同类类型的。单列滚起来长一点，但每一行都读得全。
  ★ 分组与顺序都在 samples.ts 的 `DRAW_GROUPS` 里（`DRAW_BUTTONS` 仍是唯一一份
    「有哪些类型」的事实来源，这里只做引用）。

  点中一个类型 = 开始绘制 + 回到列表视图；正在画的那一类会高亮。
  再点同一次 = 取消（规则在桥的 toggleDraw 里，这里不重复判断）。
-->
<template>
  <div class="pn-picker">
    <div class="pn-search">
      <el-input v-model="keyword" size="small" placeholder="搜索标注类型" clearable>
        <template #prefix><AppIcon name="search" :size="14" /></template>
      </el-input>
    </div>

    <div class="pn-scroll">
      <div v-if="groups.length === 0" class="pn-empty">没有匹配「{{ keyword }}」的类型</div>

      <div v-for="g in groups" :key="g.label" class="pn-group">
        <div class="pn-group-title">{{ g.label }}</div>
        <div class="pn-grid">
          <button
            v-for="b in g.items"
            :key="b.type"
            class="pn-type"
            :class="{ on: isDrawing(b.type) }"
            :title="b.title"
            @click="pick(b.type)"
          >
            <AppIcon :name="b.type" :size="16" />
            <span>{{ b.label }}</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import AppIcon from './AppIcon.vue';
import { useSketchContext } from '../use-sketch';
import { DRAW_BUTTONS, DRAW_GROUPS } from '../samples';

const emit = defineEmits<{ (e: 'picked'): void }>();

const sk = useSketchContext();
const { isDrawing, toggleDraw } = sk;

const keyword = ref('');

/** 类型 → 按钮元数据（label / title）。`DRAW_BUTTONS` 里的顺序不参与这里的排布 */
const byType = new Map<string, (typeof DRAW_BUTTONS)[number]>(
  DRAW_BUTTONS.map((b) => [b.type, b]),
);

/** 分组 + 过滤：搜索命中 label / title / 类型名任一处即可；空组整组不显示 */
const groups = computed(() => {
  const q = keyword.value.trim().toLowerCase();
  return DRAW_GROUPS.map((g) => ({
    label: g.label,
    items: g.types
      .map((t) => byType.get(t))
      .filter((b): b is (typeof DRAW_BUTTONS)[number] => !!b)
      .filter((b) => !q || `${b.label} ${b.title} ${b.type}`.toLowerCase().includes(q)),
  })).filter((g) => g.items.length > 0);
});

/** 选中一个类型：进入绘制，并把这个视图收掉（回到列表 —— 画完立刻能在列表里看见） */
function pick(type: string): void {
  toggleDraw(type);
  emit('picked');
}
</script>

<style scoped>
/* 分组之间的分隔、类型行的版式都在 panel.css（.pn-group / .pn-grid / .pn-type）；
   这里只补一条：滚动区自己要内边距（它是按需视图里唯一的内容，不像列表那样
   上面还压着一条搜索框） */
.pn-scroll {
  padding: 8px 10px 10px;
}
</style>
