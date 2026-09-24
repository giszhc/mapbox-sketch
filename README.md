# @giszhc/mapbox-sketch

Mapbox GL 绘制引擎的独立源码项目，库源码位于 `src/lib`。仓库内的 `example/` 是绘制 demo；大图合并 Node 服务单独托管在 `giszhc/mapbox-cloud-print-service`。

- 41 种内置绘制类型，支持绘制、编辑和 JSON 存档。
- PNG / JPEG 高清出图，支持 A0–A6 纸张和超大图自动切片。
- `mapbox-gl` 为 peer dependency，不会打进库产物。
- demo 通过 `workspace:*` 引用本仓库的引擎包，使用根目录构建生成的 `dist/` 产物，不依赖 npm 上已发布的绘制库。

## 安装依赖

```powershell
pnpm install
```

## 开发与构建

```powershell
pnpm dev                 # 启动绘制 demo（启动前构建本地引擎）
pnpm build               # 构建绘制引擎库
pnpm build:example       # 构建 example demo（启动前构建本地引擎）
pnpm typecheck           # 检查绘制引擎类型
```

## 大图导出

`example/` 中的绘制 demo 在前端自动切片。配置服务地址后，超大图可上传 ZIP 并由独立服务合成；地址留空或服务不可用时会下载包含切片和清单的 ZIP。需要绕过本机画布尺寸限制时，可在导出面板打开「云打印」，由服务端通过 `/render` 渲染整张图片。云打印需要服务端已安装 Chromium；不可用时会显示错误，不会自动切回本机导出。后端地址在绘制页面中配置，不需要前端项目内包含 Node 服务。

### 配置绘制 Demo 的合并服务

启动 [独立合并服务](https://github.com/giszhc/mapbox-cloud-print-service) 后，在 `example/` 绘制页面打开导出面板的「合并服务 → 设置」，填写服务根地址并点击「保存并连接」。例如：

```text
http://127.0.0.1:8900
```

填写服务根地址即可，**不要**在末尾加接口路径。Demo 会先请求 `GET /health` 检查服务；大图被前端自动切成多块后，再将 ZIP 上传到 `POST /merge`。只有需要拼合切片时才会调用服务。未填写地址、探活失败或合并失败时，Demo 会下载带有切片和清单的 ZIP。打开「云打印」时则会把绘制数据和出图参数提交到 `POST /render`，由服务端返回 PNG/JPEG；请求失败时会显示具体错误。

地址保存在当前浏览器的 `localStorage` 中（键名 `mapbox-sketch-drawing-merge-url`）。部署时也可通过构建环境变量 `VITE_MERGE_URL` 预置默认地址；用户在页面保存的地址优先，保存空地址会关闭服务调用。该地址由绘制 Demo 管理，**不是** `new MapboxSketch()` 的引擎初始化参数。

公共 API 见 [API.md](./API.md)。

## GitHub Pages Demo

仓库中的 `.github/workflows/deploy-example.yml` 会在推送到 `main` 后自动构建引擎和 `example/`，并发布到 GitHub Pages。首次启用时，在 GitHub 仓库 **Settings → Pages → Build and deployment** 中将 **Source** 设为 **GitHub Actions**。Workflow 会按仓库名自动设置 Pages 子路径。
