<!--
  PanelSettings.vue —— 「设置」视图（面板主体，按需切过来）。

  面板按 2026-09-21 改版后只常驻「标注列表」一件事，其余都收进这个视图。这里放的都是
  **低频、全局**的东西：

    ① 绘图选项 —— 启用编辑 / 绘制吸附 / 显示标注（三个开关，全是「整个工具」级别的行为）
    ② 绘制配置 —— 主题色 / 悬停高亮色 / 默认线型（组件 ConfigPanel.vue）
    ③ 测量 —— 测距测面的全局配色（同在 ConfigPanel.vue 里）
    ④ 建图 —— 换 token 重新建图（TokenPanel 的 inline 形态）
    ⑤ 危险操作 —— 清空所有图形 / 销毁工具

  ★ 为什么 ① 和 ⑤ 不再住在本组件外：它们原来跟 41 个类型按钮挤在同一段里，
    要滚过一整屏按钮才够得着；现在这里（设置视图）才是它们该待的地方 ——
    画的时候看列表，不画的时候才调开关。
-->
<template>
  <div class="pn-view">
    <!-- ① 绘图选项 -->
    <div class="panel-section">
      <div class="title"><AppIcon name="pencil" />绘图选项</div>

      <div class="form-row switch">
        <span class="label">启用编辑</span>
        <el-switch v-model="editing" :disabled="!alive" />
      </div>

      <div class="form-row switch">
        <span class="label">绘制吸附</span>
        <el-switch v-model="snapping" :disabled="!alive" />
      </div>

      <div class="form-row switch">
        <span class="label">显示标注</span>
        <el-switch v-model="visibleAll" :disabled="!alive" />
      </div>
    </div>

    <!-- ② 绘制配置 + ③ 测量（两块都在 ConfigPanel 里） -->
    <ConfigPanel />

    <!-- ④ 建图 -->
    <TokenPanel variant="inline" @mount="(t) => emit('mount', t)" />

    <!-- ⑤ 危险操作：破坏性按钮离手远一点，摆在最底下 -->
    <div class="panel-section">
      <div class="title"><AppIcon name="trash" />危险操作</div>
      <div class="hint">
        清空只删图形、不动底图；销毁工具后地图还在，但要重新加载地图才能再画
      </div>
      <div class="actions">
        <el-button :disabled="!alive" @click="clearAll()">
          <AppIcon name="trash" :size="14" />清空所有图形
        </el-button>
        <el-button type="danger" plain :disabled="!alive" @click="destroyTool()">
          <AppIcon name="x" :size="14" />销毁工具
        </el-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import AppIcon from './AppIcon.vue';
import ConfigPanel from './ConfigPanel.vue';
import TokenPanel from './TokenPanel.vue';
import { useSketchContext } from '../use-sketch';

const emit = defineEmits<{ (e: 'mount', token: string): void }>();

const sk = useSketchContext();
// 这些解构出来的都是 ref / computed，在模板里会被自动解包
const { alive, editing, snapping, visibleAll, clearAll, destroyTool } = sk;
</script>

<style scoped>
/* 破坏性按钮一行排开（按钮之间不要 Element Plus 默认的外边距） */
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 2px;
}

.actions :deep(.el-button + .el-button) {
  margin-left: 0;
}
</style>
