<!--
  ExportImagePanel.vue —— 把当前取景范围（视口或 A0–A6 打印纸）连底图带标注导成一张图
  （PNG / JPG，96~600 dpi）。

  几个要点写在这儿，省得以后有人「顺手优化」掉：

  1. 导出**不是瞬时的**。先要等底图下完（屏幕上这张没下完就出图，成品里底图是白的），
     然后才是高清那一段：引擎要在另建的隐藏地图里按抬高后的 zoom 重新下瓦片 ——
     ★ **这一段可能长达几十秒到几分钟**（300dpi 要另下一百多块高 z 瓦片），而且引擎
     那一层**不设超时**（等多久就多久，见 README「为什么要等」），所以遮罩上的进度
     文案会带上已等时长与整次导出的进度百分比（`正在等待底图瓦片…（已等 23 秒 · 66%）`、
     等久了是 `（已等 3 分 5 秒 · 66%）` —— 时长由引擎格式化，别在这儿自己拼秒数），
     别把它当成卡死。
     等待期间界面上唯一看得见的动静就是 App.vue 那层全局遮罩（文案走桥的
     `exportProgress`、进度条走 `exportTiles`，两者都来自引擎 `onProgress` 的中文文案
     与第二个结构化参数）—— 所以这里只管把按钮置灰，不用自己再写「导出中」的文案。

  2. 这一段的「视口 / 纸张 → 导出 px」是拿**库自己的 `planExport()`** 现算的，不在这儿
     另抄一套算式。抄一份的话，库改了取整、改了纸张口径，这里的预告数字就会跟真导出
     的结果对不上 —— 而这种不一致用户是会信的（他就是照着这行字选 600 dpi 的）。

  3. 纸张模式下屏幕上会多一圈虚线纸框（App.vue 挂的 `PaperFrame`）。那是**预览**：
     它圈住的正是成品里会有的那块地理范围。框比视口大时（A0/A1）框会超出屏幕，
     框外压暗自然看不见 —— 语义反而更清楚：「整屏都进图」。

     ★ 纸张、dpi、格式的状态都在**桥**里（`exportPaper` / `exportDpi` / `exportFormat`），
     不在这里：纸框 overlay 要按算出来的网格画分割线，跟这个面板必须读同一份，
     各存一份就会出现「框画的是 A4、导出的是 A3」。

  4. 这一版**删掉了「切块」下拉**。浏览器画布上限是个技术约束，让用户判断「A0 横 @600dpi
     该切到 A4 还是 A3」本身就是设计错误 —— 选粗了当场失败，选细了白等几倍时间。
     现在只给库一个像素预算（`TILE_PIXEL_BUDGET`），切几块是**算出来**的，这里只**显示**
     结论。用户没有任何可选项，于是也没有选错的可能。

  5. 「合并服务」那个状态点**不拦任何东西**：连不上就照常导出，只是产物从「一张大图」
     变成「一包 zip」。合并是**锦上添花**，导出本身永不因为后端挂了而失败。

  6. 后端只负责**合并前端导出的切片**，不负责地图渲染。每个切片都必须能在本机画布预算内完成；
     单块仍超预算时，降低 dpi 或缩小纸张后再导出。

  7. 「高清底图」默认**关**（与库的默认**相反**，理由见桥里 `exportHd` 那段）：关掉时底图
     拿屏幕上现成的这一级放大 —— 快；打开才另去下深层瓦片，开关一开就顶出一行「必然更久」
     的提醒。它只影响**底图**，标注层两种档位都按 dpi 真·重渲染。
-->
<template>
  <div class="pn-view">
    <!-- 原来这段六行的说明直接铺在控件上面，比控件本身还高（把一个设置页压成了文章）。
         收成一行小字，要读的人点开 —— 内容一字未删。 -->
    <button class="pn-toggle" :class="{ open: showHint }" @click="showHint = !showHint">
      导出说明：多久算正常 / 大纸为什么会自动切成几张 / 纸张与 dpi 的关系
    </button>
    <div v-if="showHint" class="pn-toggle-body">
      默认导出<b>所选纸张</b>那一块（纸上一毫米 ＝ 屏幕上 3.78 像素的地理范围，与 dpi 无关），
      也可以切回<b>跟随视口</b>；地图不会被挪动。会先等底图下完（没下完就导出，成品里的
      底图是白的）。<b>「高清底图」开关</b>决定之后还要不要再下一轮瓦片：关掉（默认）直接拿
      屏幕上这一级的瓦片放大，快；打开则另下深层瓦片，底图更细但<b>等多久就多久</b>，
      慢的底图服务要几分钟。
      <b>大纸在高 dpi 下整张会超出浏览器的画布上限</b>（A0 横 @300dpi 有 1.4 亿像素），
      这时系统会<b>自动切成几张完整的标准纸</b>，下面那行会写清切成了几张、每块多大
    </div>

    <div class="form-row">
      <span class="label">纸张</span>
      <el-select v-model="paper" :disabled="!alive || busy">
        <el-option value="viewport" label="跟随视口（所见即所得）" />
        <el-option v-for="o in PAPER_OPTIONS" :key="o.value" :value="o.value" :label="o.label" />
        <el-option value="custom" label="自定义（像素）" />
      </el-select>
    </div>

    <!-- 自定义纸张：直接填取景范围（CSS 像素）。与 A 系纸张同一口径，dpi 仍按原规则
         把这块范围采样成输出像素，所以这里填的不是「最终图片多大」，而是屏幕上那圈
         虚线框多大（预览里「覆盖 X×Y CSS px」显示的就是它）。
         尺寸上限 = 一张 A0（任一边 ≤ A0 长边，且较短边 ≤ A0 短边）。 -->
    <div v-if="paper === 'custom'" class="form-row">
      <span class="label">自定义尺寸</span>
      <div class="custom-size">
        <el-input-number
          v-model="customW"
          :min="1"
          :max="A0_LONG"
          :step="50"
          controls-position="right"
          size="small"
        />
        <span class="x">×</span>
        <el-input-number
          v-model="customH"
          :min="1"
          :max="A0_LONG"
          :step="50"
          controls-position="right"
          size="small"
        />
        <span class="unit">px</span>
      </div>
    </div>
    <div v-if="paper === 'custom'" class="custom-hint">
      单边长边 ≤ {{ A0_LONG }}px，且需能放入一张 A0（短边 ≤ {{ A0_SHORT }}px）
    </div>

    <div class="form-row">
      <span class="label">方向</span>
      <el-radio-group v-model="orientation" :disabled="!alive || busy || paper === 'viewport' || paper === 'custom'">
        <el-radio-button value="portrait">纵向</el-radio-button>
        <el-radio-button value="landscape">横向</el-radio-button>
      </el-radio-group>
    </div>

    <div class="form-row">
      <span class="label">格式</span>
      <el-radio-group v-model="format" :disabled="!alive || busy">
        <el-radio-button value="png">PNG</el-radio-button>
        <el-radio-button value="jpeg">JPG</el-radio-button>
      </el-radio-group>
    </div>

    <div class="form-row">
      <span class="label">分辨率</span>
      <el-select v-model="dpi" :disabled="!alive || busy">
        <el-option v-for="d in DPI_LIST" :key="d" :value="d" :label="dpiLabel(d)" />
      </el-select>
    </div>

    <!-- 底图清晰度档。★ 默认**关**（快档）—— 与库的默认（高清）故意不同，理由见桥里
         `exportHd` 那段注释：高清要另下一轮深层瓦片，动辄几分钟，不该是默认值 -->
    <div class="form-row">
      <span class="label">高清底图</span>
      <el-switch v-model="hd" :disabled="!alive || busy" />
    </div>
    <!-- 打开高清就说清后果。★ 这不是「可能」，是**必然**更久：高清那一档每次都要在隐藏
         地图里重新下瓦片（浏览器缓存帮不上 —— 那些瓦片屏幕上这一级根本没有），
         所以文案里不写「可能较久」这种含糊话 -->
    <div v-if="hd" class="hd-warn">
      高清底图会另建一张地图、按<b>抬高后的层级重新下载一轮瓦片</b>，用时明显更久
      （几分钟是常事，大纸更多）。嫌久就关掉：输出尺寸与标注清晰度完全一样，
      差别只在<b>底图</b>的详略度。
    </div>

    <!-- 这里**故意**没有「JPG 质量」那一行：引擎把 JPEG 固定按质量 1 编码，
         不留调节口 —— 加一个滑块等于邀请用户把导糊（见 sketch.ts 的 JPEG_QUALITY） -->

    <div class="preview">
      <template v-if="preview">
        <div>
          <template v-if="preview.paperText">
            纸张 {{ preview.paperText }} → 覆盖 {{ preview.frameText }}
          </template>
          <template v-else>视口 {{ preview.w }}×{{ preview.h }}</template>
          <!-- 分块时导出尺寸是**每块**的，由下面那行说；这里再说一遍整张的会打架 -->
          <template v-if="!exportGrid">
            → 导出 <b>{{ preview.outW }}×{{ preview.outH }}</b> px
          </template>
        </div>
        <div class="preview-route" :class="{ bad: !localOk }">
          <template v-if="localOk">本机导出：这一档本机可以正常出图</template>
          <template v-else>
            本机导出：<b>这一档本机出不来</b>（切到最小仍超出浏览器画布预算）——
            请降低 dpi 或换小一点的纸
          </template>
        </div>
        <!--
          自动分块的**只读**结论：用户没有可选项，所以这里没有控件，只有一句话。
          每个数字都来自库算好的 `AutoGrid`（`exportGrid`），与真正导出用的是同一份规划。
        -->
        <div v-if="exportGrid">
          整张 <b>{{ exportGrid.wholeW }}×{{ exportGrid.wholeH }}</b>
          （{{ pxText(exportGrid.wholeW * exportGrid.wholeH) }}像素）超出单块预算
          {{ budgetText }}，系统自动切成
          <b>{{ exportGrid.cols }}×{{ exportGrid.rows }} 共 {{ exportGrid.count }} 张</b>
          <!-- 跟随视口时没有块纸型：那一块不是一张标准纸，只是视口的一块 -->
          <template v-if="exportGrid.blockLabel">，每块是一张 {{ exportGrid.blockLabel }}</template>
          ，每块 <b>{{ exportGrid.tileW }}×{{ exportGrid.tileH }}</b> px @{{ dpi }}dpi
        </div>
        <!-- 「已切到 A6 封顶、每块仍超预算」这类告警（当前 dpi 列表撞不到，但那是别人
             改 dpi 列表时的地雷）—— 是提醒不是错误，所以用暖色 -->
        <div v-for="(w, i) in gridWarnings" :key="i" class="preview-warn">{{ w }}</div>
        <span v-if="preview.paperText" class="preview-note">
          视口所见不一定全进图（纸张比例与窗口不一样）
        </span>
      </template>
      <template v-else>先加载地图，这里会显示将要导出的像素尺寸</template>
    </div>

    <!-- 合并服务只负责拼接本机切片；没有地址或服务不可用时下载 ZIP。 -->
    <div v-if="exportGrid" class="merge-row">
      <span class="merge-state">
        <template v-if="merge.status === 'checking'">正在检查合并服务…</template>
        <template v-else-if="merge.status === 'ok'">合并服务已连接，导出后合并成一张大图</template>
        <template v-else-if="merge.status === 'idle'">未填写服务地址，导出后下载 zip</template>
        <template v-else>合并服务未连接，导出后下载 zip</template>
      </span>
      <button class="merge-set" type="button" @click="showMerge = !showMerge">
        {{ showMerge ? '收起' : '设置' }}
      </button>
    </div>
    <div v-if="showMerge" class="merge-box">
      <div class="merge-url">
        <input
          v-model="mergeUrlDraft"
          class="merge-input"
          spellcheck="false"
          :placeholder="MERGE_URL_PLACEHOLDER"
          @keyup.enter="applyMergeUrl"
        >
        <button class="merge-set" type="button" @click="applyMergeUrl">保存并连接</button>
      </div>
      <!-- 连不上时把地址 / 服务状态原因展示出来，便于修正配置。 -->
      <div v-if="merge.status === 'down'" class="merge-reason">{{ merge.reason }}</div>
      <div class="merge-hint">
        填写独立 Node 合并服务的地址并点击「重连」即可启用合并；留空或服务不可用时会直接下载 ZIP，
        其中包含按序号命名的切片和合并清单。
      </div>
    </div>

    <div class="actions">
      <el-button type="primary" :disabled="!alive || busy || localBlocked" @click="onExport">
        <AppIcon name="image" :size="14" />
        <template v-if="busy">导出中…</template>
        <template v-else-if="exportGrid && canMerge">导出大图（合并）</template>
        <template v-else-if="exportGrid">导出 {{ exportGrid.count }} 张（zip）</template>
        <template v-else>导出并下载</template>
      </el-button>
    </div>

    <div v-if="exportNotice" class="note export-note">
      <span>{{ exportNotice }}</span>
      <button class="note-close" title="收起这条提示" @click="clearExportNotice()">
        <AppIcon name="x" :size="12" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { PAPER_SIZES, planExport, TILE_PIXEL_BUDGET, mmToCssPx } from '@giszhc/mapbox-sketch';
import type { PaperSize } from '@giszhc/mapbox-sketch';
import AppIcon from './AppIcon.vue';
import { useSketchContext } from '../use-sketch';
import { DPI_LIST as prefsDpiList } from '../export-prefs';
import { downloadBlob, imageFileName } from '../file-io';
import {
  MERGE_URL_PLACEHOLDER, mergeServiceUrl, probeMergeService, saveMergeServiceUrl,
} from '../merge-service';

const sk = useSketchContext();
// ★ 同 PanelFooter：必须解构到顶层绑定，模板里的 proxyRefs 才会自动解包
const {
  alive, exporting, viewportSize, exportNotice, clearExportNotice,
  exportPaper: paper, exportOrientation: orientation, exportPaperSpec,
  exportPaperLabel, exportPaperMm,
  exportCustomW: customW, exportCustomH: customH,
  exportDpi: dpi, exportFormat: format, exportHd: hd,
  canExportLocally,
  exportGrid, mergeSupported, mergeWait,
} = sk;

/**
 * 那段「为什么慢 / 会切成几张」的说明要不要展开（默认收着，见模板顶部那颗折叠按钮）。
 */
const showHint = ref(false);

/**
 * 遮罩该不该挂着。★ **不只是 `exporting`**：分块导出结束的那一刻 `exporting` 就还成
 * false 了，可合并才刚开始 —— 那一段是几百 MB 上传 + 几分钟服务端拼图，页面一动不动。
 * 不把它算进来的话，用户在最长的那一段等待里反而没有任何反馈。
 */
const busy = computed<boolean>(() => exporting.value || mergeWait.value !== null);

/**
 * 常用打印档位 —— 列表本体在 `export-prefs.ts`（专题页的 dpi 下拉也用它，两边
 * 必须是同一份，改一处两边同时变）。这里只留首页特有的说明：
 *
 * 96 = 屏幕原样；300 = 印刷常规；400/500/600 = 高精度印刷与大幅面喷绘。
 * ★ 选了就真按这个 dpi 出图，**不会**被悄悄降下来（2026-09-15 起库里去掉了尺寸
 *   上限）。600dpi 配 A0/A1 是上亿像素、GB 级的画布 —— 那种情况现在由自动分块兜住
 *   （切成 16 块，每块 3490 万像素），分块也装不下时才是明明白白的中文报错，
 *   而不是给你一张「自称 600dpi」的小图。
 */
const DPI_LIST = prefsDpiList;

/**
 * 纸张下拉的选项（含毫米数）。从库的 `PAPER_SIZES` 现推 —— 手抄一张表就会在
 * 库改名 / 改尺寸时悄悄对不上，而这里的数字用户是照着选纸的。
 */
const PAPER_OPTIONS = (Object.keys(PAPER_SIZES) as PaperSize[]).map((k) => ({
  value: k,
  label: `${k}（${PAPER_SIZES[k][0]}×${PAPER_SIZES[k][1]}mm）`,
}));

/** 单块预算说成人话。直接读库的常量，不在这儿写死 3500 万 —— 代码改了口径，文案要跟着走 */
const budgetText = `${Math.round(TILE_PIXEL_BUDGET / 1e4)}万像素`;

/**
 * 自定义纸张的上限：放进一张 A0 纸（841×1189mm）以内。换算成取景范围（CSS 像素）
 * 就是库的 `mmToCssPx()` 那一步 —— 与 A 系纸张同一口径，不在这儿手写 4494 这种数。
 */
const A0_LONG = Math.round(mmToCssPx(1189));
const A0_SHORT = Math.round(mmToCssPx(841));

/**
 * 自定义尺寸夹进 A0：任一边 ≤ A0 长边，且较短边 ≤ A0 短边（整张能放进一张 A0）。
 * `:max` 已经拦住长边那一关，这里补短边那一关（el-input-number 表达不了「另一轴约束」）。
 */
watch([customW, customH], () => {
  if (customW.value > A0_LONG) customW.value = A0_LONG;
  if (customH.value > A0_LONG) customH.value = A0_LONG;
  if (Math.min(customW.value, customH.value) > A0_SHORT) {
    if (customW.value <= customH.value) customW.value = A0_SHORT;
    else customH.value = A0_SHORT;
  }
});

/** `AutoGrid.warnings`；没分块时是空数组（模板里 `v-for` 直接吃它，不必再判一次） */
const gridWarnings = computed<string[]>(() => exportGrid.value?.warnings ?? []);

/**
 * 「取景范围 → 导出像素」的预告。走库的 `planExport()`：取整与纸张换算都在里面，
 * 这样预告和真导出永远一致（见文件头第 2 条）。
 *
 * ★ 分块时这里**只**用来算纸张覆盖范围（`frameText`）与整张的像素数；逐块的规划
 *   不在组件里算，面板读的是桥给的 `exportGrid`（那是库算好的）——
 *   组件里再调一次 `planExportTiles()` 就是第二份逐块算式，两边迟早会不一致。
 *
 * 不返回 `plan.dpi`：那个值恒等于选中的 dpi（库里不再夹取），没有可显示的信息 ——
 * 真出现了偏差也是「预告在撒谎」，不该由这一行替它圆场。
 *
 * 尺寸相关的 reactivity 由桥负责（它在 window resize 时自增 `version`），这里
 * **不用**再挂一份 resize 监听 —— 见桥里那段注释。
 */
const preview = computed(() => {
  const { w, h } = viewportSize.value;
  if (w <= 0 || h <= 0) return null;
  const dpr = window.devicePixelRatio || 1;
  const paperSpec = exportPaperSpec.value;
  const plan = planExport({ cssW: w, cssH: h, dpr, dpi: dpi.value, paper: paperSpec });
  const mm = exportPaperMm.value;
  return {
    w, h,
    outW: plan.outW, outH: plan.outH,
    // 纸张模式那两句文案：毫米数说「这是多大的纸」（自定义没有毫米数，标签里已带 px），
    // CSS px 数说「盖住屏幕多大一块」
    paperText: paperSpec ? (mm ? `${exportPaperLabel.value} ${mm.w}×${mm.h}mm` : exportPaperLabel.value) : '',
    frameText: paperSpec
      ? `${Math.round(plan.frameW)}×${Math.round(plan.frameH)} CSS px`
      : '',
  };
});

/** 像素数说成人话：中文里「3488万」/「1.4亿」比 `34.9M` 好读，也更像打印行业的口径 */
function pxText(n: number): string {
  if (n >= 1e8) return `${Math.round(n / 1e7) / 10}亿`;
  return `${Math.round(n / 1e4)}万`;
}

/* ---------------------------------------------------------------------
 * 合并服务的探活与地址
 * ------------------------------------------------------------------- */

type MergeState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'ok' }
  | { status: 'down'; reason: string };

const merge = ref<MergeState>({ status: 'idle' });
const mergeUrlDraft = ref(mergeServiceUrl());
const showMerge = ref(false);

/**
 * 探活。**永远不抛**（`probeMergeService` 的口径），也永远不弹错误条 ——
 * 连不上服务不是错误，只是「这次导出会给你 zip」。
 *
 * ★ 竞态：用户连点几次「重连」时，几个探测会并发跑。用一个自增的序号丢弃过期结果 ——
 *   否则先发的那个慢响应后到，会把状态改回一个已经过时的结论。
 */
let probeSeq = 0;
async function probe(): Promise<void> {
  const seq = ++probeSeq;
  const url = mergeUrlDraft.value.trim();
  if (!url) {
    merge.value = { status: 'idle' };
    return;
  }
  merge.value = { status: 'checking' };
  const r = await probeMergeService(url);
  if (seq !== probeSeq) return;
  merge.value = r.ok ? { status: 'ok' } : { status: 'down', reason: r.reason };
}

/** 地址栏变了重新探测；留空时回到 ZIP 导出状态。 */
function applyMergeUrl(): void {
  saveMergeServiceUrl(mergeUrlDraft.value.trim());
  void probe();
}

/**
 * 挂载时把存下来的地址回填一次。
 *
 * `mergeUrlDraft` 的初值已经读过 `mergeServiceUrl()`，为什么还要再读一遍？
 * 因为**用户可能在另一个标签页里改过**（localStorage 是跨标签页共享的），
 * 而 `onMounted` 时组件才真正落地 —— 这一次读的成本是一个字符串，收益是
 * 「刷新一下就能用」和「得先点一下设置」的差别。
 */
onMounted(() => {
  const saved = mergeServiceUrl();
  if (saved !== mergeUrlDraft.value) mergeUrlDraft.value = saved;
  void probe();
});

/** 这次导出会不会走「合并」那条路：能合并 + 服务在 + 确实分了块 */
const canMerge = computed<boolean>(() => merge.value.status === 'ok' && mergeSupported.value);

/* ---------------------------------------------------------------------
 * 本机可导出性
 * ------------------------------------------------------------------- */

/** 当前这一档 dpi 在本机能不能正常出图（算式在桥里，见 `canExportLocally`） */
const localOk = computed<boolean>(() => canExportLocally(dpi.value));

/**
 * 「本机肯定出不来」→ 导出按钮置灰。
 * 只在库自己的规划**明确报警**（切到最小仍超预算）时才置灰，不做任何猜测 ——
 *   宁可让用户点下去看库那句中文错误，也不要靠一个自己推的条件把人挡在外面。
 */
const localBlocked = computed<boolean>(() => !localOk.value);

/**
 * 分辨率下拉里的文案。本机出不来时直接说明需要降低 dpi 或更换纸张 ——
 * 用户是在**选 dpi 的那一刻**需要知道这件事，而不是选完之后去看别处的提示。
 */
function dpiLabel(d: number): string {
  return !canExportLocally(d)
    ? `${d} dpi（本机导不出）`
    : `${d} dpi`;
}

/* ---------------------------------------------------------------------
 * 导出
 * ------------------------------------------------------------------- */

/** 扩展名：JPEG 惯例用 `.jpg` */
const ext = computed(() => (format.value === 'jpeg' ? 'jpg' : 'png'));

async function onExport(): Promise<void> {
  // 下载放组件里（而不是桥）：桥要保持纯转交才跑得进 vitest，
  // 而 jsdom 没有 URL.createObjectURL —— 同 PanelFooter 的分工
  const grid = exportGrid.value;

  if (!grid) {
    const r = await sk.exportImage();
    if (!r) return;                    // 失败时桥已经 showError 了
    // 纸张标签进文件名：同一次浏览导一份视口图、一份 A3 横图，光看名字分不出谁是谁
    downloadBlob(imageFileName(ext.value, r.dpi, exportPaperLabel.value), r.blob);
    return;
  }

  // 分块：一次点出 N 张（**不**弹 N 次下载 —— 浏览器会拦「密集下载」，
  // 用户在拦下来的那一刻已经不知道丢的是哪几张了）
  const tiles = await sk.exportImageBatch();
  if (!tiles || !tiles.length) return; // 一张都没出来时桥已经 showError 了

  // 合并的编排全在桥里（缺块不上传、失败落 zip、PNG/JPG 都发请求），这里只剩「下哪一份」。
  // ★ 成功与失败**都带着一份 Blob 回来**，所以下面两个分支各自只有一句下载。
  const merged = await sk.mergeExportedTiles(tiles, grid);
  if (merged.ok) {
    downloadBlob(merged.filename, merged.blob);
    // 服务端捎来的两句话（峰值内存提示、文件名对不上的警告）并进摘要行 ——
    // 它们只跟着这次响应来，不写下来用户就永远看不到
    const extra = [merged.notice, merged.warnings].filter(Boolean).join(' ');
    exportNotice.value = `已把 ${merged.tiles} 块合并成一张 ${merged.filename}。`
      + (extra ? ` ${extra}` : '');
    return;
  }

  downloadBlob(merged.zipName, merged.zip);
  exportNotice.value = `未合并：${merged.reason}已改为下载 zip（${merged.zipName}），`
    + '解压后按序号拼版。';
}
</script>

<style scoped>
/* 纸张方向 / 格式那两个单选组要占满控件列（两个按钮等分）—— 这一段唯一的版式要求 */
.form-row :deep(.el-radio-group) {
  width: 100%;
}

.form-row :deep(.el-radio-button) {
  flex: 1;
}

.form-row :deep(.el-radio-button__inner) {
  width: 100%;
  padding: 5px 4px;
  font-size: 12px;
}

/* 自定义尺寸那一行：两个数字框 + × + 单位并排 */
.custom-size {
  display: flex;
  align-items: center;
  gap: 6px;
}

.custom-size :deep(.el-input-number) {
  width: 116px;
}

.custom-size .x {
  color: var(--c-text-3);
}

.custom-size .unit {
  color: var(--c-text-3);
  font-size: 12px;
}

/* 自定义尺寸上限提示：三级灰小字，跟在控件行下面 */
.custom-hint {
  margin: -2px 0 2px;
  padding-left: 64px;
  color: var(--c-text-4);
  font-size: 10px;
}

/* 导出预告：一块浅底只读信息。里面的数字是用户据以选纸、选 dpi 的依据，
   所以单独加深（--c-text）—— 说明文字仍是三级灰，两者不在一个亮度档上。 */
.preview {
  margin: 9px 0 2px;
  padding: 8px 10px;
  background: var(--c-hover);
  border: 1px solid var(--c-border-soft);
  border-radius: var(--r-md);
  color: var(--c-text-3);
  font-size: 11px;
  line-height: 1.65;
}

.preview b {
  color: var(--c-text);
  font-weight: 600;
}

/* 纸张模式多出来的那句提醒：换行显示，别把上面那行算式挤散 */
.preview-note {
  display: block;
  margin-top: 3px;
  color: var(--c-text-4);
}

/* 每块像素偏大时的提示：是**提醒**不是错误，所以用琥珀而不是红 */
.preview-warn {
  margin-top: 3px;
  color: #b45309;
}

/* 预告里那行「这次从哪出图 / 本机行不行」。本机出不来时同样是暖色 ——
   它和「切块了」那种提醒不同，是「点下去也不会成功」 */
.preview-route {
  margin-top: 3px;
}

.preview-route.bad {
  color: #b45309;
}

.preview-route.bad b {
  color: inherit;
}

/* 「高清底图」开着时的提醒：这一档**必然**更久（不是「可能」），所以给它一块独立的
   浅琥珀底，不至于被旁边的普通说明淹掉。颜色同 `.preview-warn`（没给琥珀色变量，
   那里也是这么写的）。 */
.hd-warn {
  margin: 6px 0 2px;
  padding: 7px 9px;
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: var(--r-md);
  color: #b45309;
  font-size: 11px;
  line-height: 1.65;
}

.hd-warn b {
  color: #92400e;
  font-weight: 600;
}

/* 合并服务那一行：状态左、设置按钮右 */
.merge-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  font-size: 11px;
  color: var(--c-text-3);
}

.merge-state {
  flex: 1;
}

/* 「设置 / 重连」这类附庸小按钮：ghost 质感，不跟主操作抢注意力 */
.merge-set {
  flex: none;
  padding: 1px 7px;
  border: 1px solid var(--c-border);
  border-radius: 4px;
  background: var(--c-surface);
  color: var(--c-text-3);
  font-size: 11px;
  cursor: pointer;
  transition: background-color var(--ease), border-color var(--ease), color var(--ease);
}

.merge-set:hover {
  background: var(--c-hover);
  border-color: var(--c-border-strong);
  color: var(--c-text);
}

.merge-box {
  margin-top: 6px;
  padding: 8px 10px;
  background: var(--c-hover);
  border: 1px solid var(--c-border-soft);
  border-radius: var(--r-md);
  font-size: 11px;
  line-height: 1.65;
  color: var(--c-text-3);
}

.merge-url {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* 原生 input（不是 el-input）：自己画同一套边框与焦点圈，免得在同一块面板里出现两种输入框 */
.merge-input {
  flex: 1;
  min-width: 0;
  padding: 3px 7px;
  border: 1px solid var(--c-border);
  border-radius: var(--r-sm);
  background: var(--c-surface);
  color: var(--c-text-2);
  font: inherit;
  transition: border-color var(--ease), box-shadow var(--ease);
}

.merge-input:hover {
  border-color: var(--c-border-strong);
}

.merge-input:focus {
  outline: none;
  border-color: var(--c-primary);
  box-shadow: var(--sh-focus);
}

/* 连不上的原因：这是用户唯一能照着做的那句话，别让它跟下面的通用说明糊成一片 */
.merge-reason {
  margin-top: 5px;
  color: #b45309;
}

.merge-hint {
  margin-top: 5px;
  color: var(--c-text-4);
}

.merge-hint code {
  padding: 0 4px;
  border: 1px solid var(--c-border);
  border-radius: 4px;
  background: var(--c-surface);
  color: var(--c-text-2);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10px;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.export-note {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin-top: 6px;
  color: var(--c-text-2);
}

.export-note span {
  flex: 1;
  word-break: break-all;
}

.note-close {
  flex: none;
  padding: 0 2px;
  border: none;
  background: none;
  color: var(--c-text-4);
  font-size: 11px;
  cursor: pointer;
  transition: color var(--ease);
}

.note-close:hover {
  color: var(--c-text-3);
}
</style>
