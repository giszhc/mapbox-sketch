/* =====================================================================
 * vite.config.umd.ts —— 库的 **UMD** 产物（供 CDN / `<script>` 直接引入）。
 *
 * 为什么单独一个文件：UMD 无法跨 chunk 共享模块，必须打一份完整 bundle；
 * 而且它得在 ESM/CJS 那次构建**之后**跑（`emptyOutDir: false`，别把上一次
 * 的产物清掉）。Vite 8 已不支持「一个配置文件导出配置数组」，所以拆成两份、
 * 由 `pnpm build:lib` 顺序执行。
 *
 * 产出的全局变量名是 `window.MapboxSketch`（与类名一致）。
 * ===================================================================== */
import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // UMD 也只输出库代码，不复制 demo 的 public/ 资源。
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: false, // ★ 别把 ESM/CJS/.d.ts 那一次的产物清掉
    sourcemap: true,
    minify: 'oxc', // 同 vite.config.lib.ts：Vite 8 不再自带 esbuild
    target: 'es2019',
    lib: {
      entry: r('./src/lib/index.ts'),
      name: 'MapboxSketch', // 全局变量名 → window.MapboxSketch
      formats: ['umd'],
      fileName: () => 'index.umd.js',
    },
    rollupOptions: {
      external: ['mapbox-gl'],
      output: {
        globals: { 'mapbox-gl': 'mapboxgl' },
        exports: 'named',
      },
    },
  },
});
