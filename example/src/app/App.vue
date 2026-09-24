<!--
  App.vue —— 示例页面的骨架：地图容器 + 左面板 + 右侧样式面板 + 底部错误条 + 出图遮罩。

  面板的每一块都是一个独立组件，它们通过 useSketchContext() 取到同一个引擎桥，
  不直接持有引擎实例。本组件只负责：建地图容器、provide 桥、切面板视图。

  ============ 面板版式（2026-09-21 改版）============

  改版前：一张 320px 的卡从顶到底竖着堆了六段（建图 / 手绘 41 个按钮 / 绘制配置 /
  测量 / 列表 / 数据 / 导出图片），要滚三屏才看见列表 —— 而**列表才是这块面板的主角**，
  其余都是低频设置。所以现在：

    · 面板只有**一个常驻视图**：`list` —— 标注列表（含搜索、显隐、删除）。
    · 其余三件事各是一个**按需视图**，从头部两枚图标按钮 / 底部操作行切过去：
        `picker`   选择标注类型（41 个类型，分组 + 搜索）
        `settings` 绘图选项 / 绘制配置 / 测量 / 建图 / 危险操作
        `export`   导出图片（纸张 / dpi / 分块 / 合并服务）
      每个视图左上角都有返回（头部那颗 ←），切回来就还是列表。
    · 地图**还没建起来**时（首次打开、或刚点了「销毁工具」）整页只有一张居中的
      建图卡片：这时没有列表可看，把面板摆出来只会让人以为它坏了。

  版式本身全在 panel.css（.pn-head / .pn-list / .pn-foot / .pn-type…），
  这里只摆结构。地图容器铺满视口、尺寸不变，所以不需要在地图尺寸变化后调 map.resize()。
-->
<template>
  <div id="map" ref="mapEl" />

  <!--
    纸张取景框（导出面板选了 A0–A6 时出现）：「这张纸会覆盖哪一块」。
    ★ 它必须是 #map 的**兄弟节点**而不是子节点：#map 是 mapbox 的容器，往里塞
    Vue 管理的节点会和 mapbox 自己 appendChild 的画布容器共用父节点，没必要冒这个险。
    也**不写 v-if**：跟随视口时组件内部自己整层不渲染（那时框就是屏幕边缘）。
  -->
  <PaperFrame />

  <el-alert
    v-if="error"
    id="err"
    :title="error"
    type="error"
    :closable="true"
    show-icon
    @close="clearError"
  />

  <!--
    地图还没建起来：整页只有这一张卡片。
    ★ `auto` 只在**没销毁过**的时候给：首次打开时本地存了 token 就直接建图（省一次点击）；
      而从设置里点了「销毁工具」之后不能自动建 —— 那等于刚销毁就自己长回来。
      见 TokenPanel 的 auto 属性。
    ★ 卡片自己是**一层浮层**（panel.css 的 .gate：inset:0 / z-index 12），不是面板的
      「二选一分支」：面板在不在只由 alive 决定，跟卡片没有先后关系。
  -->
  <TokenPanel v-if="!alive" :auto="!destroyed" @mount="onMount" />

  <!--
    ★★ 面板**不许**放进 <Transition> 里（2026-09-21 修）。

    这里原本是「卡片 / 面板二选一」的 `mode="out-in"` 过渡，结果整块面板会不定期
    凭空消失：地图好好的、右下角底图按钮也在，就是左边什么都没有。根因是
    <Transition> 补类走的是 nextFrame（两层 requestAnimationFrame）：

      · 帧不产（标签页在后台 / 窗口被遮挡 / 正好赶上一帧重绘停顿）时，
        「旧节点离场」这一步永远完不成；
      · 而 `mode="out-in"` 是**等旧节点走完才插新节点**的 —— 于是面板要么压根
        没进 DOM，要么停在 enter-from 的 `opacity: 0` 上。两种看起来一模一样。

    面板是「必须看得见」的东西：挂载就是这一行 v-if，不许挂在动画帧上。
    出场那点动效交给样式表（panel.css 的 `#panel { animation: pn-panel-in … }`）——
    CSS 动画由时间线自己推进，不产帧时最多是「没动」，而不会「不见」。
  -->
  <div v-if="alive" id="panel">
    <header class="pn-head">
      <!-- 头部也是视图的一部分：标题 / 按钮跟着主体一起滑（同一套过渡名，两边同步） -->
      <Transition :name="swapName" mode="out-in">
        <!-- 列表视图：标题 + 条数 + 「新建」「设置」 -->
        <div v-if="view === 'list'" key="list" class="pn-head-row">
          <span class="pn-title">标注</span>
          <span class="pn-count">{{ shapes.length }}</span>
          <span class="pn-grow" />
          <button class="pn-ico" title="新建标注（先选一个类型）" @click="go('picker')">
            <AppIcon name="plus" :size="16" />
          </button>
          <button class="pn-ico" title="设置（绘图选项 / 配色 / 测量 / 建图）" @click="go('settings')">
            <AppIcon name="gear" :size="16" />
          </button>
        </div>

        <!-- 其余视图：返回 + 标题 -->
        <div v-else :key="view" class="pn-head-row">
          <button class="pn-ico" title="返回标注列表" @click="go('list')">
            <AppIcon name="back" :size="16" />
          </button>
          <span class="pn-title">{{ viewTitle }}</span>
          <span class="pn-grow" />
        </div>
      </Transition>
    </header>

    <!-- 主体：一次只挂一个视图（out-in），进出各带一点位移 -->
    <Transition :name="swapName" mode="out-in">
      <!-- ============ 常驻视图：标注列表 ============ -->
      <div v-if="view === 'list'" key="list" class="pn-listview">
        <!-- 正在绘制时的状态带（类型 + 手势提示 + 取消）。
             ★ 高度不写死、也不靠 max-height 猜：外面这层 grid 0fr → 1fr 把「长出来 /
               收回去」这件事本身做成过渡，列表是被平滑推下去的，不是被顶下去的。
             ★ `appear`：这条带多半是**跟着列表视图一起**出现的（选完类型回到列表），
               没有它，那一下就是硬切（理由与内层 v-if 的坑都写在 panel.css 的 .pn-fold 上） -->
        <Transition name="pn-fold" appear>
          <div v-if="drawingType !== null" class="pn-fold">
            <div><DrawStatus /></div>
          </div>
        </Transition>

        <ShapeList />

        <!-- 导入 / 导出的结果（一句话），带一个收起按钮 -->
        <Transition name="pn-fold" appear>
          <div v-if="notice !== ''" class="pn-fold">
            <div>
              <div class="pn-notice">
                <span>{{ noticeText }}</span>
                <button class="pn-notice-x" title="收起这条提示" @click="clearNotice()">
                  <AppIcon name="x" :size="12" />
                </button>
              </div>
            </div>
          </div>
        </Transition>

        <PanelFooter @image="go('export')" />
      </div>

      <!-- ============ 按需视图 ============ -->
      <DrawPicker v-else-if="view === 'picker'" key="picker" @picked="go('list')" />

      <PanelSettings v-else-if="view === 'settings'" key="settings" @mount="onMount" />

      <ExportImagePanel v-else key="export" />
    </Transition>
  </div>

  <!-- 右侧：样式设置（只作用于当前选中的那一条，见 StyleDrawer.vue） -->
  <StyleDrawer />

  <!-- 右下角：底图按钮 + 右侧滑出抽屉（多底图叠加 / 拖拽排序 / 透明度 / 筛选检索） -->
  <BasemapPanel v-if="alive" />

  <!--
    出图等待时的全屏遮罩。★ 这层不是装饰，是**必须的**：
    出图本身要等底图下完（屏幕上这张没下完就出图，成品里底图是白的），开着「高清底图」时
    还要在隐藏地图里另下一轮深层瓦片 —— 这几秒到几分钟里页面本身毫无动静，
    没有遮罩的话，用户看得见的只有「点了按钮，什么都没发生」，多半会再点一次。
    顺手把重复点击也挡住了（面板上的按钮另有 :disabled，两处互为兜底）。

    ★ 判据是 `exporting || mergeWait`，**不是** `exporting` 一个：分块导出跑完的那一刻
      `exporting` 就还成 false，可合并才刚开始 —— 那一段是几百 MB 上传 + 服务端拼几分钟，
      页面一动不动。只看 `exporting` 的话，用户在**最长**的那段等待里反而什么反馈都没有。
  -->
  <div v-if="exporting || mergeWait" class="busy">
    <div class="busy-box">
      <div class="busy-spin" />
      <!-- 分块导出时先说清「这是第几张」（`第 2/4 张`）：切了块之后一次导出要等好几轮，
           没有这个前缀，第 2 轮开始用户看到的就是一句和上一轮一模一样的文案，
           只会以为卡住了。文案本身由桥拼，这里只负责显示。
           ★ `mergeWait` 优先：进入合并阶段后 `exportProgress` 里那句「正在生成图片…」
             是上一阶段的**残留**，还挂着就是在撒谎。合并那句也是中文、也带已等时长
             （`正在服务端合并为一张大图…（已等 3 分 5 秒）`），由桥的计时器每秒重写一次 -->
      <div class="busy-text">{{ mergeWait || exportProgress || '正在导出…' }}</div>
      <!-- 底图瓦片进度：数得出来就画成确定的条，数不出来就是一条来回跑的不确定条。
           两种都比「转圈 + 一行不动的字」更像「它真的在干活」—— 出图这一等可能几分钟。
           条上**不再写一遍百分比**：上面那行文案里已经有了（「已等 42 秒 · 66%」，
           等久了是「已等 3 分 5 秒 · 66%」—— 时长由引擎格式化好，这里照显示即可），
           同一个数字写两遍只会让人以为是两回事。 -->
      <!-- ★ 合并阶段这条一样用得上：桥把上传进度也写进 `exportTiles`，
           于是上传时它从 0 走到 100%，上传完之后停满格 —— 那正是「服务端在拼图」的
           时长（服务端拼图期间一个字节都不发，进度无从谈起）。停满格 + 上面那行
           每秒在走的已等时长，合起来就是「它没死，就是在算」 -->
      <div class="busy-bar" :class="{ unknown: !exportTiles }">
        <span
          v-if="exportTiles"
          class="busy-bar-fill"
          :style="{ width: exportPercent + '%' }"
        />
      </div>
      <!-- 这行只负责「说清楚现在为什么慢」+「你的地图没事」这两件事，且两种情况都成立：
           等瓦片时（数得出 / 数不出）是「下完就出图」，合成 / 编码时瓦片早下完了，
           那句「正在重新下载瓦片」就不能再挂着 —— 一行不实的说明比没有说明更糟 -->
      <!-- ★ 「第 i/N 张」**只写在上面那行**（由桥拼在文案前缀里）。这里不再重复一遍：
           两行挨着的字说着同一件事，只会让人以为是两回事（同上面那条百分比注释的道理） -->
      <div class="busy-sub">
        <!-- 四种情况，「你的地图不会被改动」这句都成立，所以每行都带着它。
             合并阶段必须单列：那时 `exportTiles` 已经满了，再挂着「底图瓦片下完就出图」
             就是一句不实的话（瓦片早下完了），而一行不实的说明比没有说明更糟。
             合并阶段单列：那时本地切片已完成，继续显示「正在导出瓦片」会误导用户。 -->
        <template v-if="mergeWait">分块已传给合并服务，正在拼成一张大图，当前地图不会被改动</template>
        <template v-else-if="exportTiles">底图瓦片下完就出图，当前地图不会被改动</template>
        <template v-else>当前地图不会被改动</template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, provide, ref, watch } from 'vue';
import AppIcon from './components/AppIcon.vue';
import TokenPanel from './components/TokenPanel.vue';
import DrawStatus from './components/DrawStatus.vue';
import DrawPicker from './components/DrawPicker.vue';
import PanelSettings from './components/PanelSettings.vue';
import ShapeList from './components/ShapeList.vue';
import PanelFooter from './components/PanelFooter.vue';
import ExportImagePanel from './components/ExportImagePanel.vue';
import PaperFrame from './components/PaperFrame.vue';
import StyleDrawer from './components/StyleDrawer.vue';
import BasemapPanel from './components/BasemapPanel.vue';
import { SKETCH_KEY, useSketch } from './use-sketch';

const sk = useSketch();
provide(SKETCH_KEY, sk);

const { error, clearError, exporting, exportProgress, exportTiles, mergeWait } = sk;
const { alive, destroyed, shapes, notice, clearNotice, drawingType } = sk;

/** 面板当前显示哪个视图：列表（常驻）/ 选择类型 / 设置 / 导出图片 */
type PanelView = 'list' | 'picker' | 'settings' | 'export';
const view = ref<PanelView>('list');

/**
 * 这次切换是不是「返回」（回到列表）。
 * 只用来决定过渡方向：进子视图从右滑入、返回从左滑入 —— 方向对了，
 * 用户不用读标题也知道自己是往前还是往回。
 */
const isBack = ref(false);

/** 视图切换的过渡名（两套方向，见 panel.css 的 .pn-swap / .pn-back） */
const swapName = computed<string>(() => (isBack.value ? 'pn-back' : 'pn-swap'));

/**
 * 切视图的唯一入口。
 * ★ 别在模板里写成 `view = 'picker'`：那样过渡名不会跟着变（方向永远是「前进」），
 *   返回时内容会朝反方向滑 —— 一个说不上哪里怪、但一看就不对的细节。
 */
function go(next: PanelView): void {
  if (next === view.value) return;
  isBack.value = next === 'list';
  view.value = next;
}

/** 非列表视图的标题（返回按钮旁边那行字） */
const viewTitle = computed<string>(() => {
  if (view.value === 'picker') return '选择类型';
  if (view.value === 'settings') return '设置';
  return '导出图片';
});

/**
 * 提示条上那句话。收起动画期间**留着上一句**：
 * 直接绑 `notice` 的话，`clearNotice()` 那一刻字先没了、只剩 8px 内边距在缩，
 * 看着还是「啪」地一下 —— 而 .pn-fold 的 0fr 过渡要量的正是「内容有多高」。
 */
const noticeText = ref('');
watch(notice, (v) => {
  if (v) noticeText.value = v;
});

const mapEl = ref<HTMLElement | null>(null);

/**
 * 进度条的宽度百分比。`exportTiles` 为 `null`（数不出来）、或者 `total` 是 0（理论上
 * 不会：数不出总数的表引擎直接当没有）时都算 0 —— 那时条走的是 `unknown` 那套来回跑的动画。
 */
const exportPercent = computed(() => {
  const t = exportTiles.value;
  if (!t || t.total <= 0) return 0;
  return Math.round((t.loaded / t.total) * 100);
});

/** TokenPanel 填好 token 后回调：容器在这里，所以由本组件真正建图 */
function onMount(token: string): void {
  const el = mapEl.value;
  if (!el) return;
  // 重新建图后回到列表（设置视图那一套是上一张地图的上下文）。
  // 走 `go()` 而不是直接写 view：这里等价于「返回」，方向才对
  go('list');
  sk.mount(el, token);
}

// 页面卸载时销毁引擎与地图，避免事件监听 / rAF 泄漏
onBeforeUnmount(() => sk.teardown());
</script>
