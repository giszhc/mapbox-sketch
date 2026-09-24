<!--
  PanelFooter.vue —— 面板底部的三个动作：导入 JSON / 导出 JSON / 导出图片。

  ★ 2026-09-21 改版：原来「数据」是面板里的一段（标题 + 说明 + 两个按钮），「导出图片」
    是另外一大段（几个控件 + 长说明 + 一个主按钮），两段都要滚动才够得着。
    现在底部就一行三个按钮 —— 导入导出本身就是**一个动作**，不需要为它占一段版面。
    导出图片从这一行切到它自己的视图（App.vue 的 view === 'export'）。

  文件读写（Blob 下载、读文件）都在本组件与 file-io.ts 里，桥只负责把文本转交给引擎 ——
  这样桥在 vitest 里仍然可测，不用去碰 jsdom 没有的 URL.createObjectURL / 文件选择框。

  ★ 隐藏的文件框是**常驻**的（靠 CSS 藏），不是每次点击临时造一个：
    临时造的那个如果用户点了「取消」，`change` 根本不触发，元素和监听器就留在那儿了。
-->
<template>
  <div class="pn-foot">
    <button
      class="pn-btn"
      title="导入 JSON：把文件里的图形追加到当前地图上（已有的图形一条不动）"
      :disabled="!alive"
      @click="pick"
    >
      <AppIcon name="upload" :size="14" />导入
    </button>
    <button
      class="pn-btn"
      title="导出 JSON：当前全部图形 + 全局样式，存档一份"
      :disabled="!alive || shapes.length === 0"
      @click="onExport"
    >
      <AppIcon name="download" :size="14" />导出
    </button>
    <button
      class="pn-btn accent"
      title="导出图片：按纸张或视口出 PNG / JPG"
      :disabled="!alive"
      @click="emit('image')"
    >
      <AppIcon name="image" :size="14" />出图
    </button>

    <input
      ref="fileEl"
      class="file-hidden"
      type="file"
      accept=".json,application/json"
      @change="onFile"
    >
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import AppIcon from './AppIcon.vue';
import { useSketchContext } from '../use-sketch';
import { downloadText, jsonFileName } from '../file-io';

const emit = defineEmits<{ (e: 'image'): void }>();

const sk = useSketchContext();
// ★ 必须解构到顶层绑定，模板里的 proxyRefs 才会自动解包
const { alive, shapes, exportJSON, importJSON, showError } = sk;

const fileEl = ref<HTMLInputElement | null>(null);

function pick(): void {
  fileEl.value?.click();
}

function onExport(): void {
  const text = exportJSON();          // 失败时桥已经 showError 了
  if (text) downloadText(jsonFileName(), text);
}

async function onFile(e: Event): Promise<void> {
  const el = e.target as HTMLInputElement;
  const file = el.files && el.files[0];
  el.value = '';                      // 先清空：否则再选同一个文件不会触发 change
  if (!file) return;
  try {
    importJSON(await file.text());
  } catch (err) {
    // 读文件失败（文件被挪走 / 没权限）压根到不了引擎，和「解析失败」是两回事
    showError(`读取文件「${file.name}」失败：${(err as Error).message || String(err)}`);
  }
}
</script>

<style scoped>
/* 常驻但看不见：display:none 的程序化 click() 在现代浏览器里照样能弹出选择框 */
.file-hidden {
  display: none;
}
</style>
