/* =====================================================================
 * vite.config.lib.ts —— **库（发布物）** 的构建配置（ESM + CJS + .d.ts）。
 *
 * 为什么是两个文件而不是单文件多 mode：`vite build --mode lib` 仍会解析根
 * index.html、仍会跑 vue / ElementPlus 插件，只是被 if 包住；哪天忘了包，
 * Vue 就混进库产物了。两个文件 = 两套插件数组，物理隔离。
 *
 * 为什么 UMD 在另一个文件里（vite.config.umd.ts）：Vite 8 的配置加载器
 * 不再接受「导出一个配置数组」（内部用 `Object.prototype.toString` 判
 * `[object Object]`，数组会被判为非法配置而直接抛错）。所以改成两个配置文件、
 * 由 `pnpm build:lib` 顺序跑两遍。
 *
 * 产出（dist/，即 package.json 里 files 的全部内容）：
 *   index.mjs / index.cjs / index.d.ts   ← 全量，含 41 个内置类型
 *   core.mjs  / core.cjs  / core.d.ts    ← 不含内置类型，可完全 tree-shake
 *   （UMD 的 index.umd.js 由 vite.config.umd.ts 追加产出）
 *
 * 零运行时依赖：源码里 mapbox-gl 只写 `import type`（tsconfig 开了
 * verbatimModuleSyntax 强制这一点），构建后必然被擦除。下面的 external 只是
 * 双保险 —— 万一有人手滑写成值导入，会当场报外部依赖，而不是静默打包进来。
 * ===================================================================== */
import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';
import dts from 'vite-plugin-dts';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** 多入口：库主体 + 无内置类型的 core */
const entries = {
  index: r('./src/lib/index.ts'),
  core: r('./src/lib/core.ts'),
};

export default defineConfig({
  // 库包不携带 demo 的 public/ 资源（字体、sprite 等）。
  publicDir: false,
  plugins: [
    dts({
      tsconfigPath: r('./tsconfig.lib.json'),
      include: ['src/lib'],
      // ★ 必须是 bundleTypes —— 旧名 rollupTypes 在 vite-plugin-dts 5.x 里
      //   已被**静默忽略**（没有弃用警告），写成旧名会 quietly 退化成
      //   「按文件逐个输出 .d.ts」，package.json 里指向的 dist/index.d.ts 就不存在了。
      //   它由 @microsoft/api-extractor 驱动，是个耗时操作。
      //   开启后 insertTypesEntry 会被自动置为 true，无需再显式写。
      bundleTypes: true,
    }),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    // Vite 8 起不再自带 esbuild，写 'esbuild' 会因找不到该包而构建失败；
    // 默认压缩器已换成 oxc（基于 rolldown 的那套）。
    minify: 'oxc',
    target: 'es2020',
    lib: {
      // 多入口：库主体 + 无内置类型的 core（走 build.lib 而不是手写
      // rollupOptions.output 数组 —— Vite 8 下后者会产出空壳文件）
      entry: entries,
      formats: ['es', 'cjs'],
      fileName: (format, name) => `${name}.${format === 'es' ? 'mjs' : 'cjs'}`,
    },
    rollupOptions: {
      external: ['mapbox-gl'],
      output: { exports: 'named' },
    },
  },
});
