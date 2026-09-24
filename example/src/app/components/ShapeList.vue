<!--
  ShapeList.vue —— 面板主体：「已标注列表」。点选聚焦 / 显示隐藏 / 删除单条。

  每条 = 类型标签 + 编号 + 一句话描述（描述由引擎的 tool.describe(shape) 给出，
  各类型自己实现，demo 不再自己按类型 switch）。

  ★ 2026-09-21 改版的两条口径：
    · **整行就是「选中」**：点一下 → 聚焦 + 右侧样式面板滑出来。行尾原来还挂着一个
      写着「选中」的小按钮，和「点这一行」是同一件事 —— 两处入口只会让人犹豫点哪个。
      行尾只留两个作用真正独立的东西：显隐、删除。
    · **列表是面板里唯一常驻的内容**：它自己撑满高度滚动，搜索框固定在它上面。
      其余功能（建型 / 设置 / 出图）都在别的视图里，见 App.vue。

  隐藏的行**留在列表里**、置灰：藏起来不等于删掉，得能一眼看出「它在、只是没显示」，
  并且随时能原样放回来。隐藏的行点下去不会有反应（地图上没有可抓的手柄），
  所以光标也跟着换掉 —— 别给「可点」的错觉。

  右侧那块样式面板改的永远是**当前选中**这一条，而且它会**自己跟着作用对象来去**：
  点地图上的图形、点这里的某一行、刚画完一条 —— 它都自动滑出来；作用对象没了就收起。
-->
<template>
  <div class="pn-main">
    <!-- 搜索：条数少的时候不出现（三条标注还要搜一次的话，那个框本身才是噪音） -->
    <div v-if="showSearch" class="pn-search">
      <el-input
        v-model="keyword"
        size="small"
        placeholder="搜索标注（类型 / 编号 / 描述）"
        clearable
      >
        <template #prefix><AppIcon name="search" :size="14" /></template>
      </el-input>
    </div>

    <div class="pn-list">
      <div v-if="shapes.length === 0" class="pn-empty">
        <b>还没有标注</b><br>
        点右上角的 <b>＋</b> 选一个类型，在地图上点按即可
      </div>
      <div v-else-if="rows.length === 0" class="pn-empty">没有匹配「{{ keyword }}」的标注</div>

      <template v-else>
        <div
          v-for="s in rows"
          :key="s.id"
          class="shape-row"
          :class="{
            on: focused && focused.id === s.id,
            off: isHidden(s.id) || !visibleAll,
          }"
          :title="`${typeLabel(s.type)} ${s.id} · ${describe(s)}`"
          @click="onRow(s)"
        >
          <!-- 第一行：类型标签（图例）+ 行尾两个动作。类型单独占一行，是为了让
               「按类型扫」这件事成立 —— 混在一行里时，标签宽度不一样会把编号与描述
               推来推去，一列下来参差不齐。 -->
          <div class="row-top">
            <!-- 类型标签配色来自 panel.css 的 .tag-<type> 全局类 -->
            <span class="tag" :class="`tag-${s.type}`">{{ typeLabel(s.type) }}</span>

            <span class="row-acts">
              <!-- 隐藏的行仍留在列表里：藏起来不等于删掉，得能原样放回来 -->
              <button
                class="row-act"
                :title="isHidden(s.id) ? '显示这条标注' : '隐藏这条标注（不画、也点不中）'"
                @click.stop="toggleHidden(s.id)"
              >
                <AppIcon :name="isHidden(s.id) ? 'eyeOff' : 'eye'" :size="14" />
              </button>
              <button class="row-act danger" title="删掉这一条" @click.stop="remove(s.id)">
                <AppIcon name="trash" :size="14" />
              </button>
            </span>
          </div>

          <!-- 第二行：编号 + 描述。描述独占整行宽度 —— 它才是这一条的实际内容
               （「5 点 · 全长 12.4 km」这种），被省略号截掉一半就等于没写 -->
          <div class="row-sub">
            <span class="sp">{{ s.id }}</span>
            <span class="desc">{{ describe(s) }}</span>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import AppIcon from './AppIcon.vue';
import { useSketchContext } from '../use-sketch';
import type { Shape } from '@giszhc/mapbox-sketch';

const sk = useSketchContext();
// ★ 同其它面板：必须解构到顶层绑定，模板里的 proxyRefs 才会自动解包
const {
  shapes, focused, typeLabel, describe, isHidden, toggleHidden, visibleAll, openStyle, remove,
} = sk;

/** 列表的本地搜索词（只过滤显示，不动引擎） */
const keyword = ref('');

/** 条数够多才给搜索框：三条标注还要搜一次的话，那个框本身就是噪音 */
const showSearch = computed(() => shapes.value.length >= 6);

const rows = computed<readonly Shape[]>(() => {
  const q = keyword.value.trim().toLowerCase();
  if (!q) return shapes.value;
  return shapes.value.filter((s) =>
    `${typeLabel(s.type)} ${s.id} ${describe(s)}`.toLowerCase().includes(q));
});

/**
 * 点行 = 选中（并展开右侧样式面板）。
 * ★ 走 `openStyle()` 而不是 `focus()`：除了聚焦，还得**把样式面板展开** ——
 *   面板被 ✕ 关掉之后，作用对象并没有换人，`sync()` 那条「只在换人时开」的规则
 *   不会把它叫回来，这里是唯一的那条路（见 use-sketch.ts 的 openStyle）。
 * ★ 总开关关掉、或这一条被隐藏时不做任何事：那时地图上没有可抓的手柄，
 *   点下去必须没反应才对（行上已有 `.off` 的视觉提示）。
 */
function onRow(s: Shape): void {
  if (!visibleAll.value || isHidden(s.id)) return;
  openStyle(s.id);
}
</script>

<style scoped>
/* 类型标签的配色与渲染在 panel.css 的 .tag-<type> 里（全局，本列表与右侧样式面板共用），
   这里不重复定义 —— 复制一份就会两边慢慢走散。
   行、按钮、空态的版式也全在 panel.css（.shape-row / .row-act），本组件不带私有版式。 */
</style>
