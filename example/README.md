# 地图标注绘制项目

这是绘制引擎的 demo 前端，不包含专题页面。它位于仓库的 `example/` 目录，通过 pnpm workspace 依赖本仓库根包，并引用根目录构建生成的 `dist/` 产物，不依赖 npm 上已发布的绘制库。

## 启动与构建

在本仓库根目录运行：

```powershell
pnpm dev
pnpm build:example
```

在仓库根目录执行命令。应用启动/构建前会先构建本地绘制引擎。应用使用 Mapbox GL，首次使用需在页面设置中填写 Access Token。

## 大纸导出

超出单张画布预算时，前端会自动切片并逐块导出。导出面板里的「合并服务」设置可填写 Node 服务地址：

- 地址可用时，前端上传 ZIP，由服务合成 PNG / JPEG 并返回；
- 地址留空时，不访问后端，直接下载包含切片和清单的 ZIP；
- 地址不可用或合并失败时，同样回退为下载 ZIP。

只负责合并和云打印的 Node 服务单独托管在 `giszhc/mapbox-cloud-print-service`，默认地址是 `http://127.0.0.1:8900`。在导出设置中填写服务地址即可；前端项目本身不包含或启动后端。

需要绕过本机画布尺寸限制时，在导出面板打开「云打印」。服务端通过 `/render` 渲染整张 PNG/JPEG，需预先安装 Chromium。若云打印服务未就绪或请求失败，页面会显示错误，不会自动改用本机出图。

部署到 GitHub Pages 时，根目录的 GitHub Actions workflow 会自动构建并发布本 Demo；首次部署需先在仓库 Settings → Pages 中将 Source 设为 GitHub Actions。
