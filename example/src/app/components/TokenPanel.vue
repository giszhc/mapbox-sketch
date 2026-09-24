<!--
  TokenPanel.vue —— Mapbox Access Token 输入，两种形态：

    · variant="gate"（默认）—— 地图**还没建起来**时的整屏建图卡片。
      这时整页只有这一件事可做，所以左面板 / 底图按钮全让位，屏幕正中一张卡片。
      `onMounted` 时若本地已存 token 就直接建图（老 demo 的行为，少一次点击）。

    · variant="inline" —— 「设置」视图里的一行（换 token / 重新加载地图）。
      ★ 这一形态**绝不自动建图**：设置视图只在地图已经建好之后才打得开，
        自动提交等于「一进设置就把地图重下一遍」。

  token 存在 localStorage 的 'mapbox_token' 键下（老版本 demo 用的也是这个键，
  改名字会把用户已经存好的 token 弄丢），下次打开自动回填。

  地图容器元素归 App.vue 所有，所以这里只把 token 交给父级，
  由父级调 useSketch().mount(容器, token)。
-->
<template>
  <!-- 形态 A：整屏建图卡片 -->
  <div v-if="variant === 'gate'" class="gate">
    <div class="gate-card">
      <div class="gate-title">
        <AppIcon name="compass" :size="17" />加载地图
      </div>
      <div class="gate-sub">
        填一个 Mapbox Access Token 就开始（本机 mapbox-sketch 示例页）
      </div>
      <div class="pn-field">
        <el-input
          v-model="tokenInput"
          placeholder="pk.…"
          clearable
          @keyup.enter="submit"
        />
        <el-button type="primary" @click="submit">加载地图</el-button>
      </div>
      <div class="gate-foot">
        token 只存在本机浏览器里（<b>localStorage</b>），下次打开自动建图
      </div>
    </div>
  </div>

  <!-- 形态 B：设置里的一行 -->
  <div v-else class="panel-section">
    <div class="title"><AppIcon name="compass" />建图</div>
    <div class="hint">换 token 后点右侧按钮重新建图；当前地图上的图形会全部丢掉</div>
    <div class="pn-field">
      <el-input
        v-model="tokenInput"
        placeholder="pk.…"
        clearable
        @keyup.enter="submit"
      />
      <el-button type="primary" @click="submit">
        {{ alive ? '重新加载' : '加载地图' }}
      </el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import AppIcon from './AppIcon.vue';
import { useSketchContext } from '../use-sketch';

const props = withDefaults(defineProps<{
  variant?: 'gate' | 'inline';
  /**
   * 卡片形态下：本地存了 token 就自动建图（省一次点击）。
   * ★ 由调用方决定给不给 —— **「销毁工具」之后不能再自动建**（那等于刚销毁就自己长回来），
   *   见 App.vue 里 `:auto="!destroyed"`。
   */
  auto?: boolean;
}>(), { variant: 'gate', auto: false });

const sk = useSketchContext();
const alive = sk.alive;

const emit = defineEmits<{ (e: 'mount', token: string): void }>();

const tokenInput = ref(sk.readToken());

function submit(): void {
  const t = tokenInput.value.trim();
  if (!t) {
    sk.showError('请先填写 Mapbox Access Token。');
    return;
  }
  emit('mount', t);
}

// 已有 token 时自动建图（与老 demo 行为一致）。
// ★ 只有卡片形态 + 调用方开了 `auto` 才这么做 —— 见 props 里那段注释。
onMounted(() => {
  if (props.variant === 'gate' && props.auto && tokenInput.value.trim()) submit();
});
</script>
