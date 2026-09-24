<!--
  BasemapPanel.vue —— 右下角「底图」按钮 + 右侧滑出抽屉。

  抽屉三块能力（都在桥上，组件不碰地图）：
    ① 已叠加底图：按叠加顺序列出（UI 上层在前），可拖拽改顺序、调透明度、显隐、移除；
    ② 可选底图：按「分类」+「关键字」筛选，点「＋ 添加」即叠加（支持多底图叠在一起）；
    ③ 数据源是远程接口，拉到后填进 basemaps；默认叠加列表第 6 个（天地图影像 有注记）。

  ★ 抽屉右侧滑入，和 StyleDrawer 同一个手势（见它的注释）：从右缘滑进来比凭空出现
    更清楚是「同一块面板换了内容」。两套面板都挂在视口右侧、各管一摊，互不抢状态。
-->
<template>
  <!-- 右下角入口按钮（地图控件已上移悬在其上方，见 global.css 的 bottom-right 上推） -->
  <button class="bm-fab" :title="open ? '收起底图' : '底图'" @click="open = !open">
    <AppIcon :name="open ? 'x' : 'map'" :size="open ? 18 : 20" />
  </button>

  <Transition name="drawer">
    <div v-if="open" id="basemapPanel">
      <div class="head">
        <span class="head-title"><AppIcon name="map" />底图</span>
        <button class="close" title="收起" @click="open = false">
          <AppIcon name="x" :size="14" />
        </button>
      </div>

      <div v-if="basemapError" class="bm-err">底图列表加载失败：{{ basemapError }}</div>

      <!-- 搜索 + 分类筛选 -->
      <div class="bm-toolbar">
        <el-input v-model="keyword" size="small" placeholder="搜索底图名称 / 标签" clearable>
          <template #prefix><AppIcon name="search" :size="14" /></template>
        </el-input>
        <div class="bm-groups">
          <button class="chip" :class="{ on: group === '' }" @click="group = ''">全部</button>
          <button
            v-for="g in groups"
            :key="g"
            class="chip"
            :class="{ on: group === g }"
            :title="g"
            @click="group = g"
          >{{ g }}</button>
        </div>
      </div>

      <!-- 已叠加（拖拽排序，上层在前） -->
      <div class="bm-section">
        <div class="bm-section-title">
          已叠加（拖拽排序 · 上层在前）
          <span v-if="basemapLoading" class="bm-mini">加载中…</span>
        </div>
        <div v-if="!activeList.length" class="bm-empty">尚未叠加任何底图，从下方列表添加</div>
        <ul v-else class="bm-active">
          <li
            v-for="a in activeList"
            :key="a.key"
            class="bm-active-row"
            :class="{ dragging: dragKey === a.key }"
            draggable="true"
            @dragstart="onDragStart(a.key)"
            @dragover.prevent="onDragOver(a.key)"
            @drop="onDrop(a.key)"
            @dragend="onDragEnd"
          >
            <span class="bm-handle" title="拖拽排序"><AppIcon name="grip" :size="14" /></span>
            <span class="bm-thumb">
              <img v-if="a.item.iconUrl" :src="a.item.iconUrl" :alt="a.item.name" loading="lazy" />
              <span v-else class="bm-thumb-ph">无图</span>
            </span>
            <span class="bm-meta">
              <span class="bm-name" :title="a.item.name">{{ a.item.name }}</span>
              <span class="bm-tag">{{ a.item.group }}</span>
            </span>
            <button class="bm-eye" :title="a.hidden ? '显示' : '隐藏'" @click="setHidden(a.key, !a.hidden)">
              <AppIcon :name="a.hidden ? 'eyeOff' : 'eye'" :size="14" />
            </button>
            <button class="bm-x" title="移除" @click="remove(a.key)">
              <AppIcon name="x" :size="13" />
            </button>
            <div class="bm-opacity">
              <el-slider
                :model-value="Math.round(a.opacity * 100)"
                :min="0"
                :max="100"
                :disabled="a.hidden"
                @update:model-value="(v: number | number[]) => setOpacity(a.key, (Array.isArray(v) ? v[0] : v) / 100)"
              />
              <span class="bm-op-val">{{ a.hidden ? '—' : `${Math.round(a.opacity * 100)}%` }}</span>
            </div>
          </li>
        </ul>
      </div>

      <!-- 可选底图（分类 + 关键字） -->
      <div class="bm-section">
        <div class="bm-section-title">可选底图（{{ filtered.length }}）</div>
        <ul class="bm-list">
          <li
            v-for="b in filtered"
            :key="b.key"
            class="bm-row"
            :class="{ on: isActiveBasemap(b.key) }"
          >
            <span class="bm-thumb">
              <img v-if="b.iconUrl" :src="b.iconUrl" :alt="b.name" loading="lazy" />
              <span v-else class="bm-thumb-ph">无图</span>
            </span>
            <span class="bm-meta">
              <span class="bm-name" :title="b.name">{{ b.name }}</span>
              <span class="bm-tag">{{ b.group }}</span>
              <span v-if="b.tags.length" class="bm-tags">{{ b.tags.join(' · ') }}</span>
            </span>
            <button class="bm-add" :disabled="isActiveBasemap(b.key)" @click="toggle(b)">
              {{ isActiveBasemap(b.key) ? '已添加' : '＋ 添加' }}
            </button>
          </li>
          <li v-if="!filtered.length" class="bm-empty">没有匹配的底图</li>
        </ul>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import AppIcon from './AppIcon.vue';
import { useSketchContext } from '../use-sketch';
import type { BasemapItem } from '../basemap-service';

const sk = useSketchContext();
const {
  basemaps, activeBasemaps, basemapLoading, basemapError, basemapGroups,
  isActiveBasemap, toggleBasemap, removeBasemap, setBasemapOpacity,
  setBasemapHidden, reorderBasemap, loadBasemaps,
} = sk;

const open = ref(false);
const keyword = ref('');
const group = ref('');
const dragKey = ref<string | null>(null);

/** 分类列表（来自桥的 computed，直接解构成 ref 用） */
const groups = basemapGroups;

/** UI 显示用：把激活列表反转，让最上层排在前面 */
const activeList = computed(() => [...activeBasemaps.value].reverse());

/** 可选列表按「分类 + 关键字」过滤（关键字命中 名称 / 分类 / 标签） */
const filtered = computed<BasemapItem[]>(() => {
  const kw = keyword.value.trim().toLowerCase();
  return basemaps.value.filter((b) => {
    if (group.value && b.group !== group.value) return false;
    if (!kw) return true;
    const hay = `${b.name} ${b.group} ${b.tags.join(' ')}`.toLowerCase();
    return hay.includes(kw);
  });
});

/** 面板挂载即拉一次列表（接口有缓存，地图 onLoad 再拉也不会重复请求） */
loadBasemaps();

function toggle(b: BasemapItem): void {
  toggleBasemap(b);
}
function remove(key: string): void {
  removeBasemap(key);
}
function setOpacity(key: string, op: number): void {
  setBasemapOpacity(key, op);
}
function setHidden(key: string, h: boolean): void {
  setBasemapHidden(key, h);
}
function onDragStart(key: string): void {
  dragKey.value = key;
}
function onDragOver(_key: string): void {
  /* 允许放置：@dragover.prevent 已阻止默认行为 */
}
function onDrop(key: string): void {
  if (dragKey.value) reorderBasemap(dragKey.value, key);
  dragKey.value = null;
}
function onDragEnd(): void {
  dragKey.value = null;
}
</script>

<style scoped>
/* 右下角入口按钮。★ 尺寸（44×44、right/bottom 20px）**不许动** —— 地图控件列
   是按它实测对齐的（见 global.css 末尾那段：两组中心 dx=0）。这里只换皮：
   圆角方形 + 主色 + 极轻阴影（原来是无边框圆形 + 纯黑投影，那是移动端 FAB 的语言，
   摆在制图工具里偏「App」而不像工具）。 */
.bm-fab {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 11;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border: 1px solid var(--c-primary);
  border-radius: var(--r-lg);
  background: var(--c-primary);
  color: #fff;
  cursor: pointer;
  box-shadow: var(--sh-2);
  transition: background-color var(--ease), border-color var(--ease);
}

.bm-fab:hover {
  background: var(--c-primary-hover);
  border-color: var(--c-primary-hover);
}

.bm-fab:active {
  background: var(--c-primary-active);
  border-color: var(--c-primary-active);
}

/* 右侧抽屉：与 StyleDrawer 同款白卡，右缘滑入 */
#basemapPanel {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 11;
  width: 340px;
  max-height: calc(100% - 24px);
  overflow: auto;
  padding: 12px 14px 14px;
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: var(--r-lg);
  box-shadow: var(--sh-2);
  font-size: 13px;
  color: var(--c-text-2);
}

.drawer-enter-active,
.drawer-leave-active {
  transition: transform 0.18s ease, opacity 0.18s ease;
}
.drawer-enter-from,
.drawer-leave-to {
  transform: translateX(calc(100% + 12px));
  opacity: 0;
}

.head {
  display: flex;
  align-items: center;
  margin-bottom: 10px;
}

.head-title {
  flex: 1;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--c-text);
  font-size: 13px;
  font-weight: 600;
}

.head-title .ico {
  color: var(--c-text-3);
}

.close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--c-text-4);
  cursor: pointer;
  transition: background-color var(--ease), color var(--ease);
}

.close:hover {
  background: var(--c-hover-strong);
  color: var(--c-text-2);
}

.bm-err {
  margin-bottom: 8px;
  padding: 7px 9px;
  background: var(--c-danger-bg);
  border: 1px solid #fecaca;
  border-radius: var(--r-sm);
  color: #b91c1c;
  font-size: 12px;
}

.bm-toolbar {
  margin-bottom: 8px;
}

.bm-groups {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

/* 分类筛选 chip。★ 这是本 UI 里唯一允许用胶囊的控件（筛选标签本来就是胶囊语义），
   其余按钮一律 6px 圆角。选中态用浅蓝底 + 蓝字，不铺实心主色。 */
.chip {
  padding: 2px 10px;
  border: 1px solid var(--c-border);
  border-radius: var(--r-pill);
  background: var(--c-surface);
  color: var(--c-text-3);
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
  transition: background-color var(--ease), border-color var(--ease), color var(--ease);
}

.chip:hover {
  background: var(--c-hover);
  border-color: var(--c-border-strong);
  color: var(--c-text);
}

.chip.on,
.chip.on:hover {
  background: var(--c-primary-bg);
  border-color: var(--c-primary-border);
  color: var(--c-primary);
  font-weight: 500;
}

.bm-section {
  margin-top: 10px;
  border-top: 1px solid var(--c-border-soft);
  padding-top: 9px;
}

.bm-section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  color: var(--c-text-3);
  font-size: 11px;
  font-weight: 600;
}

.bm-mini {
  color: var(--c-text-4);
  font-weight: 400;
}

.bm-empty {
  color: var(--c-text-4);
  font-size: 12px;
  line-height: 1.6;
}

/* 已叠加列表：每行可拖拽 */
.bm-active,
.bm-list {
  list-style: none;
}

.bm-active-row {
  display: grid;
  grid-template-columns: 16px 40px 1fr auto auto;
  grid-template-rows: auto auto;
  align-items: center;
  gap: 4px 6px;
  padding: 6px 8px;
  border-radius: var(--r-sm);
  cursor: grab;
  transition: background-color var(--ease);
}

.bm-active-row:hover {
  background: var(--c-hover);
}

.bm-active-row.dragging {
  opacity: 0.5;
}

.bm-active-row:active {
  cursor: grabbing;
}

.bm-handle {
  grid-row: 1 / 3;
  display: flex;
  align-items: center;
  color: var(--c-text-4);
  cursor: grab;
}

.bm-thumb {
  grid-row: 1 / 3;
  width: 40px;
  height: 40px;
  border-radius: 5px;
  overflow: hidden;
  background: var(--c-hover-strong);
}

.bm-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.bm-thumb-ph {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  color: var(--c-text-4);
  font-size: 11px;
}

.bm-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.bm-name {
  color: var(--c-text);
  font-size: 12px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.bm-tag {
  color: var(--c-text-3);
  font-size: 11px;
}

/* 行内图标按钮：无框，靠 hover 底表达可点 */
.bm-eye,
.bm-x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 3px;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--c-text-3);
  cursor: pointer;
  transition: background-color var(--ease), color var(--ease);
}

.bm-eye:hover {
  background: var(--c-hover-strong);
  color: var(--c-text);
}

.bm-x:hover {
  background: var(--c-danger-bg);
  color: var(--c-danger);
}

.bm-opacity {
  grid-column: 3 / 6;
  display: flex;
  align-items: center;
  gap: 8px;
}

.bm-op-val {
  flex: none;
  width: 34px;
  text-align: right;
  color: var(--c-text-3);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

:deep(.bm-opacity .el-slider) {
  flex: 1;
  margin: 0;
}

/* 可选列表：每行一个添加按钮 */
.bm-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--r-sm);
  transition: background-color var(--ease);
}

.bm-row:hover {
  background: var(--c-hover);
}

.bm-row.on {
  opacity: 0.6;
}

.bm-row .bm-meta {
  flex: 1;
}

.bm-tags {
  color: var(--c-text-4);
  font-size: 10px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* 「＋ 添加」：主色描边 + 蓝字，hover 才铺一层浅蓝底（不铺实心主色） */
.bm-add {
  flex: none;
  padding: 3px 10px;
  border: 1px solid var(--c-primary-border);
  border-radius: var(--r-sm);
  background: var(--c-surface);
  color: var(--c-primary);
  font-size: 12px;
  line-height: 16px;
  cursor: pointer;
  transition: background-color var(--ease), border-color var(--ease), color var(--ease);
}

.bm-add:hover:not(:disabled) {
  background: var(--c-primary-bg);
  border-color: var(--c-primary);
}

.bm-add:disabled {
  border-color: var(--c-border);
  background: var(--c-surface);
  color: var(--c-text-disabled);
  cursor: default;
}
</style>
