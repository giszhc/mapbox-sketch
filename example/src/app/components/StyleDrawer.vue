<!--
  StyleDrawer.vue —— 右侧「样式设置」浮动面板：改**当前选中那一条**图形。

  面板里其实是三套东西，**按作用对象的类型一起筛、上下排在一起**：

    ① 上面的「绘制配置」行（`sk.cfgGroups`）：这条标注**写什么 / 长多长** ——
       路径文字的文字 / 分布方式 / 平滑曲线，引线的文字 / 角度 / 长度。
       它走引擎的 `config()`，不是样式（`applyStyle`）：每张图形的 cfg 从出生起
       就是一张合并好的完整表，没有「覆盖 / 未覆盖」之分，所以这些行**行尾没有 ●**。
       ★ 这六行原先散在左侧「🎛 绘制配置」里，是 2026-09 搬过来的：它们全都只对
         某一种类型的标注有意义，而左侧那块是「画之前先设好」的口径 —— 在左边改完，
         还得回地图上点那条线才看得见效果。放在这儿跟着选中那条一起出现，改完即见。
         留在左侧的是「画之前的开关」与「全局项」（见 ConfigPanel.vue）。

    ② 中间的几何行（`sk.geomGroups`）：这条标注**此刻摆成什么样** —— 图片标注的
       旋转角度 / 尺寸。走引擎的 `getGeom()` / `applyGeom()`（类型自己表态，见
       `GeomRow`）。它既不是配置（几何不进全局默认、新图形不会继承）也不是样式
       （没有覆盖 / 恢复默认那一说），所以同样**没有 ●**，也**不受底部的
       「↺ 恢复默认样式」影响**（那个按钮只管样式）。

    ③ 下面的样式行（`sk.styleGroups`）：这条标注**长什么样**，走 `applyStyle` /
       `resetStyle`（单图形覆盖），行尾 ● 标出这条图形自己改过哪几项。
       ★ 颜色行里**只有富文本的「背景底色」可以清空**（清空 = 设成空串 = 不垫底 ——
         它的出厂值是纯白，所以「清空」是唯一能关掉那块底板的动作）。别的颜色键没有
         「无色」这个取值，清空一律忽略 —— 判据写在行上（`StyleRow.clearable`），
         不在这里写死键名。

  为什么单独放到右边而不是挤在左侧面板里：
    左侧面板宽 320px，而这些行有二十来条，每条都是「标签 + 控件 + 状态位」一行。
    挤在左面板里只能一条一条往下堆，把「手绘 / 列表 / 数据」全推到屏幕外；
    放右边则是一整列纵向空间，还能顺带在每行尾巴上标出「这条图形自己改过没」。

  ★ 两套都只列**当前这条图形用得上**的行（纯函数在 samples.ts：`cfgGroupsFor` /
    `visibleStyleGroups`）：用不到的整个不渲染，不是置灰 —— 一个「点」下面不该有半屏
    灰的线宽、不透明度、刻度位置。四个全局项（悬停高亮色 / 手绘预览色 / 预览填充 /
    吸附记号色）同样不列：引擎读的是全局样式表，给单条图形改了不生效，列出来只能是
    四个死控件。其中悬停高亮色的控件在左侧「🎛 绘制配置」（它是交互反馈，不是某条
    标注的外观 —— 曾经每条图形都有一行，那只会让同屏几条的悬停色对不上）。

  ★ 底部「恢复默认」**只管样式**（清掉 `applyStyle` 的覆盖），不动上面的配置行与几何行 ——
    库没有「把 cfg 恢复成默认」的 API（配置行改了就是改了），几何更是没有「默认」这个
    概念（它的默认就是落地那一刻的样子）。按钮文案里写明了是「样式」。

  ★ 面板什么时候出现 / 消失，**不归本组件管** —— 桥的 `sync()` 里那条统一规则说了算：
    作用对象换了一条（点地图上的图形 / 列表里点「选中」/ 刚画完一条）就自动滑出来，
    作用对象没了（点地图空白退出编辑 / 那条被删了 / 清空）就自动收起。所以这里只留一个 ✕，
    不做别的开关。
    ★ 唯一的例外：✕ 关掉之后**作用对象并没有换人**，那条「只在换人时开」的规则不会把它
      叫回来 —— 想找回面板，得走左侧「已绘图形」里那条的「选中」（`openStyle()`）。
      那个按钮既是「选中」也是「展开」，两个语义本来就该是同一下（见 ShapeList.vue）。

  ★ 没有「只清某一个键」的按钮：库没有这个 API（`applyStyle` 只能加不能减，
    `resetStyle` 一清到底），而且面板也读不到全局基底来把某个键「写回原值」
    （`effectiveStyle` 把本图形的覆盖也算进去了）。不是漏了。
-->
<template>
  <!-- 从右边滑出来。动作方向本身就在说「这块面板是从右侧来的」，
       比凭空出现更容易看懂是同一块面板换了内容 -->
  <Transition name="drawer">
    <div v-if="styleOpen" id="styleDrawer">
      <div class="head">
        <span class="head-title"><AppIcon name="palette" />样式设置</span>
        <button class="close" title="收起样式面板" @click="closeStyle()">
          <AppIcon name="x" :size="14" />
        </button>
      </div>

      <template v-if="styleTarget">
        <!-- 作用对象：改的就是这一条 -->
        <div class="target">
          <span class="tag" :class="`tag-${styleTarget.type}`">{{ styleTarget.label }}</span>
          <span class="tid">{{ styleTarget.id }}</span>
          <span class="tdesc" :title="styleTarget.desc">{{ styleTarget.desc }}</span>
        </div>
        <div class="target-note">
          {{ styleTarget.overridden.size
            ? `本图形已单独改过 ${styleTarget.overridden.size} 项样式（行尾 ● ），其余跟随全局默认`
            : '本图形没有单独改过任何样式，全部跟随全局默认' }}
        </div>

        <!-- ★ 绘制配置行排在样式行**前面**：这两组管的是「这条标注写什么 / 长多长」
             （文字内容、引线几何），点开一条标注最常改的就是它们；样式行管「长什么样」，
             是调完前者之后的第二步 -->
        <div v-for="g in cfgGroups" :key="g.title" class="group">
          <div class="group-title">{{ g.title }}</div>
          <div v-if="g.note" class="group-note">{{ g.note }}</div>

          <div v-for="row in g.rows" :key="row.key" class="srow">
            <div class="srow-main">
              <span class="slabel" :title="row.hint || ''">{{ row.label }}</span>

              <!-- ★ 文字输入必须走 @update:model-value（每次键入即提交）：
                   el-input 在每个 input 事件后会把原生框**强制写回 model-value prop**，
                   而这里拿不到焦点回写 —— 只绑 @change 的话 prop 永远是旧值，
                   每敲一个字就被弹回去，一个字都输不进去（2026-09-11 修）。
                   也是老面板 v-model 的原行为：沿线文字边打边实时分布 -->
              <el-input
                v-if="row.kind === 'text'"
                class="cfg-text"
                size="small"
                :model-value="cfgStrOf(row.key)"
                :placeholder="row.placeholder"
                :disabled="!alive"
                @update:model-value="(v: string) => setCfgValue(row.key, v)"
              />

              <!-- 多行文字（文字标注）：回车换行就是真的换行，所以必须是 textarea ——
                   单行 el-input 会把回车吞掉。上面那条 @update:model-value 的理由在这里
                   同样成立（el-input 每次键入后强制回写 prop），一行都不能省 -->
              <el-input
                v-else-if="row.kind === 'textarea'"
                class="cfg-text"
                type="textarea"
                size="small"
                :autosize="{ minRows: 2, maxRows: 6 }"
                :model-value="cfgStrOf(row.key)"
                :placeholder="row.placeholder"
                :disabled="!alive"
                @update:model-value="(v: string) => setCfgValue(row.key, v)"
              />

              <el-input-number
                v-else-if="row.kind === 'number'"
                :model-value="cfgNumOf(row.key)"
                :min="row.min"
                :max="row.max"
                :step="row.step"
                size="small"
                controls-position="right"
                :disabled="!alive"
                @change="(v: number | undefined) => onCfgNumber(row.key, v)"
              />

              <!-- 分布方式这种只有两三个取值、且「一眼要看出现在选的是哪个」的，用单选按钮
                   而不是下拉：下拉得点开才知道选的是谁（同样是「不渲染用不到的」，见文件头） -->
              <el-radio-group
                v-else-if="row.kind === 'radio'"
                :model-value="cfgStrOf(row.key)"
                size="small"
                :disabled="!alive"
                @change="(v: unknown) => onCfgSelect(row.key, v)"
              >
                <el-radio-button
                  v-for="o in row.options || []"
                  :key="o.value"
                  :value="o.value"
                >
                  {{ o.label }}
                </el-radio-button>
              </el-radio-group>

              <el-switch
                v-else
                :model-value="!!cfgRawOf(row.key)"
                :disabled="!alive"
                @change="(v: string | number | boolean) => onCfgToggle(row.key, v)"
              />

              <!-- 配置行**没有**「本图形改过没」这个状态（每张图形的 cfg 出生就是一张
                   合并好的完整表，见 samples.ts 的 CfgRow），但这一格得留着 ——
                   不留，配置行的控件会比样式行的控件往右错 18px，两组挨着看就是歪的 -->
              <span class="dot" />
            </div>

            <!-- 角度那种「拖着试比敲数字快」的，滑块独占下面一行（数字框在上面行里） -->
            <el-slider
              v-if="row.slider"
              class="cfg-slider"
              :model-value="cfgNumOf(row.key)"
              :min="row.min"
              :max="row.max"
              :step="row.step"
              :disabled="!alive"
              @update:model-value="(v: number | number[]) => onCfgSlider(row.key, v)"
            />
          </div>
        </div>

        <!-- ★ 几何行夹在中间：上面是「这条标注写什么」、这块是「它摆成什么样」、
             下面是「它长什么样」—— 从内容到位置到外观，正好是调一条标注的三步。
             与配置行一样**没有**行尾那个 ●：几何不是「覆盖」，它就是此刻的实况 -->
        <div v-for="g in geomGroups" :key="g.title" class="group">
          <div class="group-title">{{ g.title }}</div>
          <div v-if="g.note" class="group-note">{{ g.note }}</div>

          <div v-for="row in g.rows" :key="row.key" class="srow">
            <div class="srow-main">
              <span class="slabel" :title="row.hint || ''">{{ row.label }}</span>

              <el-input-number
                :model-value="geomNumOf(row.key)"
                :min="row.min"
                :max="row.max"
                :step="row.step"
                size="small"
                controls-position="right"
                :disabled="!alive"
                @change="(v: number | undefined) => onGeomNumber(row.key, v)"
              />

              <!-- 同配置行：留着这一格，控件才不会比样式行往左错 18px（见那边的说明） -->
              <span class="dot" />
            </div>

            <el-slider
              v-if="row.slider"
              class="cfg-slider"
              :model-value="geomNumOf(row.key)"
              :min="row.min"
              :max="row.max"
              :step="row.step"
              :disabled="!alive"
              @update:model-value="(v: number | number[]) => onGeomSlider(row.key, v)"
            />
          </div>
        </div>

        <!-- ★ 只有**当前类型改得动**的键才在这儿 —— 用不到的整个不渲染，不是置灰。
             所以没有「为什么这行是灰的」这种问题，也就不需要解释文字 -->
        <div v-for="g in styleGroups" :key="g.title" class="group">
          <div class="group-title">{{ g.title }}</div>

          <div v-for="row in g.rows" :key="row.key" class="srow">
            <div class="srow-main">
              <span class="slabel" :title="row.hint || ''">{{ row.label }}</span>

              <el-color-picker
                v-if="row.kind === 'color'"
                :model-value="colorOf(row.key)"
                :show-alpha="!!row.alpha"
                :disabled="!alive"
                @change="(v: string | null) => onColor(row, v)"
              />

              <el-input-number
                v-else-if="row.kind === 'number'"
                :model-value="numOf(row.key)"
                :min="row.min"
                :max="row.max"
                :step="row.step"
                size="small"
                controls-position="right"
                :disabled="!alive"
                @change="(v: number | undefined) => onNumber(row.key, v)"
              />

              <el-select
                v-else
                :model-value="strOf(row.key)"
                size="small"
                :disabled="!alive"
                @change="(v: unknown) => onSelect(row.key, v)"
              >
                <el-option
                  v-for="o in row.options"
                  :key="o.value"
                  :value="o.value"
                  :label="o.label"
                />
              </el-select>

              <!-- 这条图形自己改过的键。比在行尾放「清除」按钮有用：一眼扫过去就知道改过哪几项 -->
              <span
                class="dot"
                :class="{ on: isOverridden(row.key) }"
                :title="isOverridden(row.key) ? '这一项被本图形单独改过' : ''"
              >●</span>
            </div>
          </div>
        </div>

        <!-- 兜底：这个类型一行都没登记（`STYLE_APPLIES` 漏了新类型就是这样）。
             正常不会出现 —— 用例钉着每种内置类型至少留一行 -->
        <div v-if="!cfgGroups.length && !geomGroups.length && !styleGroups.length" class="empty">
          这种图形还没有登记可改的样式项。
        </div>

        <div class="foot">
          <!-- ★ 只清**样式**覆盖，不动上面的配置行（库没有「把 cfg 恢复成默认」的 API）。
               所以文案里写明是「恢复默认样式」，别让人以为连引线角度、路径文字也一起回默认 -->
          <el-button
            size="small"
            :disabled="!alive || styleTarget.overridden.size === 0"
            title="清掉本图形的全部样式覆盖，恢复跟随全局默认（上面的配置行与几何行不受影响）"
            @click="resetStyle()"
          >
            <AppIcon name="reset" :size="14" />恢复默认样式（清掉这 {{ styleTarget.overridden.size }} 项）
          </el-button>
        </div>
      </template>

      <!-- 没有作用对象：一条空控件都不显示（那些控件只对某一条图形有意义）。
           正常操作下几乎见不到这一屏 —— 作用对象一没，面板自己就收起来了；
           只有「面板开着的时候把选中的那条删掉、又立刻用左侧按钮叫回来」才落到这里 -->
      <div v-else class="empty">
        没有选中的图形。在地图上点一下某个图形、或者在左侧「已绘图形」里点它的「选中」，
        这里就会列出那一条能改的文字 / 引线参数与样式项。
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import AppIcon from './AppIcon.vue';
import { useSketchContext } from '../use-sketch';
import type { CfgKey, GeomKey, StyleKey } from '@giszhc/mapbox-sketch';
import type { StyleRow } from '../samples';

const sk = useSketchContext();
// ★ 同其它面板：必须解构到顶层绑定，模板的 proxyRefs 才会自动解包
const {
  alive, styleOpen, closeStyle, styleTarget, styleValues, styleGroups,
  applyStyle, resetStyle,
  cfgGroups, cfgValueOf, setCfgValue,
  geomGroups, geomValueOf, setGeomValue,
} = sk;

function isOverridden(key: StyleKey): boolean {
  return !!styleTarget.value?.overridden.has(key);
}

/* ---------------- 配置行的回显值（走桥上那套 cfgValueOf，不是 styleValues） ---------------- */
function cfgRawOf(key: CfgKey): unknown {
  return cfgValueOf(key);
}
function cfgStrOf(key: CfgKey): string {
  const v = cfgRawOf(key);
  return v == null ? '' : String(v);
}
function cfgNumOf(key: CfgKey): number {
  const v = Number(cfgRawOf(key));
  return Number.isFinite(v) ? v : 0;
}

/* ---------------- 配置行的写回 ----------------
 * 一律**只把值交给桥**（`setCfgValue`），组件不碰引擎。哪个键有什么讲究（比如
 * 「引线文字」要带 `defaults:false`）全在 use-sketch.ts 里 —— 那是引擎侧的规矩，
 * 让面板去记「哪个键特殊」等于把同一件事写两处，早晚对不上（见那边的注释）。 */
function onCfgNumber(key: CfgKey, v: number | undefined): void {
  if (typeof v !== 'number' || !Number.isFinite(v)) return;
  setCfgValue(key, v);
}

function onCfgSelect(key: CfgKey, v: unknown): void {
  if (typeof v !== 'string' || !v) return;
  setCfgValue(key, v);
}

/** 开关。★ Element Plus 的 switch 回调声明是 `string | number | boolean`，如实收下再判 */
function onCfgToggle(key: CfgKey, v: string | number | boolean): void {
  setCfgValue(key, !!v);
}

/** 滑块。`range` 未开时给的是数字，但声明里带 `number[]`，如实收下再判 */
function onCfgSlider(key: CfgKey, v: number | number[]): void {
  if (typeof v !== 'number' || !Number.isFinite(v)) return;
  setCfgValue(key, v);
}

/* ---------------- 几何行的回显与写回（走桥上那套 geomValueOf / setGeomValue） ----------------
 * 回显值可能是 `null`（读不到几何：没有作用对象 / 类型没有可调几何）——那时这一组本来
 * 也不渲染，但控件仍然要求一个数字，所以退回 0；**写回一律经过桥的数字校验**，
 * 不会因为这里退回 0 就把 0 写进图形。 */
function geomNumOf(key: GeomKey): number {
  const v = geomValueOf(key);
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function onGeomNumber(key: GeomKey, v: number | undefined): void {
  if (typeof v !== 'number' || !Number.isFinite(v)) return;
  setGeomValue(key, v);
}

/** 滑块。`range` 未开时给的是数字，但声明里带 `number[]`，如实收下再判（同 onCfgSlider） */
function onGeomSlider(key: GeomKey, v: number | number[]): void {
  if (typeof v !== 'number' || !Number.isFinite(v)) return;
  setGeomValue(key, v);
}

/* ---------------- 样式行的回显值 ---------------- */
function rawOf(key: StyleKey): unknown {
  return styleValues.value ? styleValues.value[key] : undefined;
}
function colorOf(key: StyleKey): string {
  const v = rawOf(key);
  return v == null ? '' : String(v);
}
function numOf(key: StyleKey): number {
  const v = Number(rawOf(key));
  return Number.isFinite(v) ? v : 0;
}
function strOf(key: StyleKey): string {
  const v = rawOf(key);
  return v == null ? '' : String(v);
}

/* ---------------- 写回（只作用于当前选中那一条） ---------------- */
/**
 * 颜色选择器。
 *
 * 清空（`el-color-picker` 给 `null`）**默认忽略** —— 绝大多数颜色键没有「无色」这个取值：
 * 线色 / 字色设成空串，canvas 会拿上一次的 `fillStyle` 接着画，而那是上一帧画过什么
 * 决定的（不同浏览器还不一样），等于把「清空」变成「颜色随机」。
 * 只有行上标了 `clearable` 的键（目前只有富文本的 `bgColor`：空串 = 不垫底，出厂是纯白）才把
 * 清空当成一次正经写回。**判据在行上、不在这里写死键名** —— 以后再加这类键，
 * 只需在 samples.ts 的 `STYLE_GROUPS` 里标一下。
 */
function onColor(row: StyleRow, v: string | null): void {
  if (!v) {
    if (row.clearable) applyStyle({ [row.key]: '' });
    return;
  }
  applyStyle({ [row.key]: v });
}

function onNumber(key: StyleKey, v: number | undefined): void {
  if (typeof v !== 'number' || !Number.isFinite(v)) return;
  applyStyle({ [key]: v });
}

function onSelect(key: StyleKey, v: unknown): void {
  if (typeof v !== 'string' || !v) return;
  applyStyle({ [key]: v });
}
</script>

<style scoped>
#styleDrawer {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 10;
  width: 300px;
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

/* 滑入 / 滑出：整块从屏幕右缘（自己宽度 + 那 12px 间隙）滑到位。
   面板是 position:absolute 挂在视口上的，滑出去时会撑出可滚动区域，
   所以 global.css 里给 html/body 上了 overflow:hidden。 */
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
  font-size: 12px;
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

/* 作用对象：一块浅底小卡，一眼看出「下面这些行改的是它」。
   类型标签的配色来自 panel.css 的 .tag-<type> 全局类。 */
.target {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  background: var(--c-hover);
  border-radius: var(--r-sm);
  font-size: 12px;
}

.tid {
  flex: none;
  color: var(--c-text);
  font-weight: 600;
}

.tdesc {
  flex: 1;
  min-width: 0;
  color: var(--c-text-4);
  font-size: 11px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.target-note {
  margin: 6px 0 8px;
  color: var(--c-text-3);
  font-size: 11px;
  line-height: 1.6;
}

.group {
  margin-top: 10px;
  border-top: 1px solid var(--c-border-soft);
  padding-top: 8px;
}

.group-title {
  margin-bottom: 3px;
  color: var(--c-text-3);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

/* 配置组的「怎么用」小字（只有配置组有，样式组没有）。跟 .target-note 一个口径：
   它是说明、不是控件，所以压到 11px 弱灰，且**不抢在行前面** —— 行才是主角 */
.group-note {
  margin: 2px 0 5px;
  color: var(--c-text-4);
  font-size: 11px;
  line-height: 1.6;
}

.srow {
  margin: 6px 0;
}

.srow-main {
  display: flex;
  align-items: center;
  gap: 8px;
}

.slabel {
  flex: 1;
  min-width: 0;
  color: var(--c-text-2);
  font-size: 12px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* 「本图形改过这一项」的状态位。亮起时用主色 —— 它是标记，不是警告 */
.dot {
  flex: none;
  width: 10px;
  color: var(--c-border);
  font-size: 10px;
  text-align: center;
}

.dot.on {
  color: var(--c-primary);
}

.foot {
  margin-top: 12px;
  border-top: 1px solid var(--c-border-soft);
  padding-top: 10px;
}

.empty {
  color: var(--c-text-4);
  font-size: 12px;
  line-height: 1.7;
}

:deep(.el-input-number) {
  width: 108px;
}

:deep(.el-select) {
  width: 160px;
}

/* 输入框（路径文字 / 引线文字）。★ 宽度写在**自己的类**上，不能直接给 `:deep(.el-input)` ——
   `el-input-number` 内部也是一个 `.el-input`，一刀切会把数字框内部撑到 160px，
   溢出它 108px 的外壳 */
:deep(.cfg-text) {
  width: 160px;
}

/* 单选按钮（分布方式）：两个按钮 + 标签要挤进 300px 的面板 */
:deep(.el-radio-group),
:deep(.el-switch) {
  flex: none;
}

:deep(.el-radio-button__inner) {
  padding: 5px 8px;
  font-size: 12px;
}

/* 角度那条滑块：标签行下面独占一行。左起 6px（别贴着「引线角度 °」这几个字），
   右边留出状态位那一格（.dot 10px + 两个 .srow-main 的 gap）—— 不留的话滑块右端会比
   上面那排数字框多伸出去 18px，一列控件右缘参差不齐 */
.cfg-slider {
  margin: 2px 0 0 6px;
  width: calc(100% - 24px);
}
</style>
