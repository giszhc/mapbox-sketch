/* =====================================================================
 * pick-image.ts —— 示例页自己的「弹文件框选图片」实现（**库不碰这些东西**）。
 *
 * 单独一个文件而不是塞进 use-sketch.ts：桥要保持「纯转交」才跑得进 vitest
 * （jsdom 里弹不出系统文件框、`FileReader` 与 `Image` 的行为也跟真浏览器不一样），
 * 所以凡是碰真实 DOM 的那半边一律放在这一层 —— 与 file-io.ts 同一个理由。
 *
 * 三件事：弹框选文件 → 读成 data URL → **降采样**（图片本体要嵌进数据文件，
 * 原封不动塞一张 4000px 的照片会让导出的 JSON 变成几十 MB）。
 * ===================================================================== */
import type { PickImageResult } from '@giszhc/mapbox-sketch';

/**
 * 落地前把长边压到这个像素数（缩完再编码）。
 *
 * 1000px 是「屏幕上看足够清楚」与「文件别太大」的折中：图片标注落地最大也就
 * 200px（见 `shapes/image.ts` 的 `MAX_SIDE`），放大两倍上屏（高 dpi 屏）也够。
 */
const MAX_PICK_SIDE = 1000;

/** 有损重编码的质量。0.85 是文字 / 线条还能看清的常见下限 */
const JPEG_QUALITY = 0.85;

/**
 * 判断「要不要留 PNG」用的缩略图边长。只为看一眼有没有透明像素，
 * 所以画得越小越省 —— 32×32 = 1024 个像素，够发现成片的透明区域了。
 */
const ALPHA_PROBE = 32;

/** 把 File 读成 data URL */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(new Error(`读取文件「${file.name}」失败。`));
    r.readAsDataURL(file);
  });
}

/** 把 data URL 解成 img 元素（拿 naturalWidth / 画到 canvas 都要它） */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    // 不是图片 / 浏览器解不了（CMYK 的 jpg、TIFF…）会走到这里
    el.onerror = () => reject(new Error('这个文件不是浏览器能显示的图片格式。'));
    el.src = src;
  });
}

/**
 * 图片里有没有半透明 / 全透明的像素。
 *
 * 画成小缩略图再看：`drawImage` 缩小时会把 alpha 平均，所以成片的透明区域
 * 缩完仍然是透明的（角落里一个像素的透明也许看不出来，但那种图本来也没必要留 PNG）。
 * 直接读原图那 4000×3000 的像素就是几千万次循环，为了选个编码格式不值。
 */
function hasAlpha(img: HTMLImageElement): boolean {
  const n = ALPHA_PROBE;
  const c = document.createElement('canvas');
  c.width = n;
  c.height = n;
  const ctx = c.getContext('2d');
  if (!ctx) return false;                       // 拿不到上下文就当不透明（退回无损那条是不值当的）
  ctx.drawImage(img, 0, 0, n, n);
  const d = ctx.getImageData(0, 0, n, n).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return true;
  return false;
}

/**
 * File → `PickImageResult`：读文件、按需降采样、编码回 data URL。
 *
 * 编码格式的口径：**有透明像素的 PNG 留 PNG**（截图 / 图标多半是这种，转 JPEG
 * 会把透明底刷成黑的、文字边缘也会糊），其余一律 JPEG 0.85（照片能小一个数量级）。
 */
async function readImageFile(file: File): Promise<PickImageResult> {
  const raw = await readAsDataUrl(file);
  const img = await loadImage(raw);
  const w = img.naturalWidth || 0;
  const h = img.naturalHeight || 0;
  // 解出来的尺寸不正常（0 / NaN）：连长宽比都算不出来，只能整份退回原图，
  // 至少「图是对的、只是大」比「算出一堆 NaN 顶点」好
  if (!(w > 0) || !(h > 0)) return { dataUrl: raw, width: w || 1, height: h || 1 };

  const keepPng = file.type === 'image/png' && hasAlpha(img);
  const long = Math.max(w, h);

  // 本来就不大：原样用（**不重编码**，免得白白损失一次画质）
  if (long <= MAX_PICK_SIDE && (file.type === 'image/png' || file.type === 'image/jpeg')) {
    return { dataUrl: raw, width: w, height: h };
  }

  const k = Math.min(1, MAX_PICK_SIDE / long);
  const cw = Math.max(1, Math.round(w * k));
  const ch = Math.max(1, Math.round(h * k));
  const c = document.createElement('canvas');
  c.width = cw;
  c.height = ch;
  const ctx = c.getContext('2d');
  if (!ctx) return { dataUrl: raw, width: w, height: h };   // 没有 2d 上下文就退回原图
  ctx.drawImage(img, 0, 0, cw, ch);
  const dataUrl = keepPng ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', JPEG_QUALITY);
  // ★ 报给引擎的是**原图**的自然尺寸，不是缩略图的：长宽比由它定，
  //   而缩略图可能因为取整把比例弄歪一点点（1000/3 → 333）
  return { dataUrl, width: w, height: h };
}

/**
 * 弹系统文件框选一张图片，读好再交回去。
 *
 * 返回 `null` = 用户取消（引擎据此保持绘制态，可以再点一次）。
 * 读文件 / 解码失败则**抛错** —— 引擎会把它变成一句 `onWarn` 提示，
 * 比静默返回 null（表现为「点了没反应」）好查得多。
 *
 * ★ 「用户点了取消」没有可靠的事件：现代浏览器的 `<input>` 会发 `cancel`，
 *   而老一些的只在窗口重新获得焦点时才有反应 —— 两条路都接上。
 *   少了 focus 那条兜底，取消之后绘制态会一直卡在「等待选图」里：
 *   再点地图也不落点（`_picking` 挡着），看起来就是整个工具坏了。
 */
export function pickImageFile(): Promise<PickImageResult | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    document.body.appendChild(input);

    let done = false;
    const finish = (v: PickImageResult | null): void => {
      if (done) return;
      done = true;
      window.removeEventListener('focus', onFocus);
      input.remove();
      resolve(v);
    };
    const fail = (err: unknown): void => {
      if (done) return;
      done = true;
      window.removeEventListener('focus', onFocus);
      input.remove();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    /**
     * 窗口重新拿到焦点 ≈ 文件框已经关了。change 与 focus 谁先到**没有保证**，
     * 所以让出一个宏任务再检查；文件真的选上了的话 change 早就把 done 置上了。
     */
    const onFocus = (): void => {
      setTimeout(() => {
        if (!done && !input.files?.length) finish(null);
      }, 300);
    };
    window.addEventListener('focus', onFocus);
    input.addEventListener('cancel', () => finish(null));
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (!file) { finish(null); return; }        // 理论上走不到（change 就是选上了），兜一层
      readImageFile(file).then(finish, fail);
    });
    input.click();
  });
}
