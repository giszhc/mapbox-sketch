<!--
  ConfigPanel.vue —— 绘制配置：全局项「主题色」+「悬停高亮色」。

  ★ 这里原来有九行。2026-09 分两步清空了：
    · 路径文字 / 分布方式 / 平滑曲线 / 引线文字 / 引线角度 / 引线长度 —— 搬进了右侧
      「🎨 样式设置」（它们只对某一种类型的标注有意义，跟着选中那条走才顺手）。
      行的声明在 samples.ts 的 `CFG_GROUPS`，渲染在 StyleDrawer.vue，别在这儿再抄一份。
    · 途经点沿线标注 / 轮廓线 · 路径线 —— 直接删掉了（不再提供界面开关）。它们仍然
     是引擎的 cfg 键（`showNodes` / `showLine`），默认值照旧生效；只是面板上不再有
      它们的位置，要改只能在 `mount()` 的 defaultCfg 或导入的 JSON 里给。

  留下来的两行都是**全局项**，也正是它们不该挪去右边的原因：
    · 主题色 —— 图形本体的统一用色（线 / 圆点 / 面内淡填充），改一次所有图形一起变；
      文字颜色不跟它走（默认统一蓝）。读写桥在 use-sketch.ts 的 `themeColor` / `setThemeColor`。
    · 悬停高亮色 —— 交互反馈，不是某条标注的外观。

  版式走 panel.css 的 .form-row 栅格（标签列 88px + 控件列）。
-->
<template>
  <div class="panel-section">
    <div class="title"><AppIcon name="sliders" />绘制配置</div>
    <div class="hint">
      单条标注自己的文字 / 引线角度 / 颜色都在右侧「样式设置」里，跟着选中的那条走
    </div>

    <!-- ★ 主题色：图形本体的统一用色。写的是全局样式（pathColor / pointColor 一次写齐；
         **面内填充固定纯黄 30%，不跟主题色**），已画的图形里没做过单图形覆盖的会一起跟着变。
         文字颜色不在这里 —— 默认统一蓝（DEFAULT_STYLE，右侧样式面板可按图形覆盖）。 -->
    <div class="form-row">
      <span class="label">主题色</span>
      <el-color-picker :model-value="themeColor" :disabled="!alive" @change="onThemeColor" />
    </div>

    <!-- ★ 悬停高亮色：和主题色一样是全局项，也别照着别处改它 ——
         悬停高亮是交互反馈、不是某条标注的外观，所以它**不跟随选中图形**，也谈不上
         「预设下一个新图形的默认值」。因此它没有 canEditXxx、**不随聚焦置灰**，
         只跟「地图有没有加载」走。引擎那边同样是只读全局样式表 ——
         给单条图形 applyStyle({ hoverColor }) 是静默无效的（见 samples.ts 的 STYLE_APPLIES）。 -->
    <div class="form-row">
      <span class="label">悬停高亮色</span>
      <el-color-picker :model-value="hoverColor" :disabled="!alive" @change="onHoverColor" />
    </div>

    <!-- ★ 默认线型：新画 / 没被单图形覆盖的标注都按它画（虚线间距按线宽缩放）。
         和主题色一样是全局默认、不跟随选中图形，只跟「地图有没有加载」走。 -->
    <div class="form-row">
      <span class="label">默认线型</span>
      <el-select
        :model-value="defaultLineType"
        :disabled="!alive"
        style="width: 140px"
        @change="onDefaultLineType"
      >
        <el-option
          v-for="o in lineTypeOptions"
          :key="o.value"
          :label="o.label"
          :value="o.value"
        />
      </el-select>
    </div>
  </div>

  <!--
    📏 测量：右下角按钮组启动的测距 / 测面。测量结果**没有**右侧单条样式面板
    （测量就该是一套统一的脸色），所以它的全局样式统一放在这里改 ——
    读写桥在 use-sketch.ts 的 measureXxx / setMeasureXxx，写的是测量引擎的全局样式表。
  -->
  <div class="panel-section">
    <div class="title"><AppIcon name="ruler" />测量</div>
    <div class="hint">测距 / 测面用右下角的尺子按钮；结果可整体拖动、拖拐点微调</div>
    <div class="form-row">
      <span class="label">主题色</span>
      <el-color-picker
        :model-value="measureThemeColor"
        :disabled="!measureAlive"
        @change="onMeasureTheme"
      />
    </div>

    <div class="form-row">
      <span class="label">文字颜色</span>
      <el-color-picker
        :model-value="measureTextColor"
        :disabled="!measureAlive"
        @change="onMeasureText"
      />
    </div>

    <div class="form-row">
      <span class="label">线宽</span>
      <el-slider
        :model-value="measureLineWidth"
        :min="1"
        :max="10"
        :step="1"
        style="width: 120px"
        :disabled="!measureAlive"
        @change="onMeasureLineWidth"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import AppIcon from './AppIcon.vue';
import { useSketchContext } from '../use-sketch';

const sk = useSketchContext();
// 这些解构出来的都是 ref / computed，在模板里会被自动解包
const {
  hoverColor, setHoverColor, themeColor, setThemeColor, alive,
  defaultLineType, setDefaultLineType,
  measureAlive, measureThemeColor, setMeasureThemeColor,
  measureTextColor, setMeasureTextColor,
  measureLineWidth, setMeasureLineWidth,
} = sk;

/** 默认线型下拉选项（与 samples.ts 的 lineType 行、paint.lineDashFor 闭集保持一致） */
const lineTypeOptions = [
  { value: 'solid', label: '实线（默认）' },
  { value: 'dashed', label: '虚线（预测/预报）' },
  { value: 'dotted', label: '点线（估计）' },
  { value: 'dashDot', label: '点划线（计划）' },
  { value: 'dashDotDot', label: '双点划线（远期预测）' },
  { value: 'longDash', label: '长虚线（边界/施工）' },
  { value: 'shortDash', label: '短虚线（断裂/辅助）' },
];

/** 颜色选择器「清空」时给 null —— 清空没有语义，忽略即可（同样式面板） */
function onHoverColor(v: string | null): void {
  if (!v) return;
  setHoverColor(v);
}

/** 全局主题色（清空同样忽略） */
function onThemeColor(v: string | null): void {
  if (!v) return;
  setThemeColor(v);
}

/** 全局默认线型（清空同样忽略） */
function onDefaultLineType(v: string | null): void {
  if (!v) return;
  setDefaultLineType(v);
}

function onMeasureTheme(v: string | null): void {
  if (v) setMeasureThemeColor(v);
}

function onMeasureText(v: string | null): void {
  if (v) setMeasureTextColor(v);
}

/** el-slider 的 change 给的是 Arrayable<number>（范围模式才有数组），这里只认单值 */
function onMeasureLineWidth(v: number | number[]): void {
  if (typeof v === 'number') setMeasureLineWidth(v);
}
</script>

<style scoped>
/* 本组没有专属版式：段标题 / hint / 行栅格全部走 panel.css 的公共规则。
   （原来这里有一份 `.hint` 的局部覆盖，颜色字号与公共规则并不一致 —— 2026-09 删掉，
   统一由 panel.css 那个 `.panel-section > .hint` 说了算） */
</style>
