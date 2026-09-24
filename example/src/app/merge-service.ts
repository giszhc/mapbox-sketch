/* =====================================================================
 * merge-service.ts —— 合并服务（`server/`）的浏览器侧客户端。
 *
 * 干两件事：探活（决定按钮上写「导出大图」还是「导出 N 张」）、
 * 把导出页面打好的 zip 传上去换回一张合并好的大图。
 *
 * ★ 本文件里所有函数都**不抛异常**，一律回 `{ ok: false, reason }`。
 *   调用方（桥）在合并失败时只有一个动作：把手里本来就有的 zip 落盘。
 *   让它为「网络错误 / 服务没起 / 服务端 4xx / 被浏览器拦掉 / 超时」分别写一遍
 *   try/catch，只会漏掉其中几条 —— 而那几条恰恰是「点了没反应」的来源。
 *
 * ★ 用 `XMLHttpRequest` 而不是 `fetch`：**fetch 没有上传进度**。
 *   一个几百 MB 的 zip 在内网上要传几十秒，没有进度条用户只会怀疑卡死了
 *   —— 而这里最坏的情况是几百 MB 上传 + 几分钟服务端合并，全是「页面一动不动」。
 *   XHR 有 `upload.onprogress`（上传）与 `onprogress`（下载合并图）两个事件。
 * ===================================================================== */

/**
 * 示例地址只作输入提示，不会自动连接。留空代表关闭后端合并，分块完成后直接下载 ZIP。
 */
export const MERGE_URL_PLACEHOLDER = 'http://127.0.0.1:8900';

/** localStorage 的键。带上前缀，免得与别的东西撞名 */
const STORAGE_KEY = 'mapbox-sketch-drawing-merge-url';
let sessionAddress: string | undefined;

/**
 * 上传阶段的看门狗：**连续**这么久没有任何上传进度事件就掐断。
 *
 * ★ 只在上传阶段有效，见下面 `uploadZipForMerge()` 里那两段注释 —— 服务端开始
 *   合并之后**本来就会安静好几分钟**，那不是卡住。
 */
const UPLOAD_STALL_MS = 60_000;

/**
 * 上传完成之后的兜底上限：服务端合并太久（或者中间有个代理把连接默默吃了——
 * 那种情况 TCP 不会报错）就放弃。
 *
 * 30 分钟不是拍的：本服务上限是 5.58 亿像素（A0 横 @600），那一档在实测机器上
 * 是分钟级，给它留了一个数量级的余量。再长就说明确实出问题了。
 */
const MERGE_TIMEOUT_MS = 30 * 60_000;

/** 探活的超时。探活失败**不是错误**（只意味着按钮写「导出 N 张」），所以短一点 */
const PROBE_TIMEOUT_MS = 5_000;

/* ---------------------------------------------------------------------
 * 地址
 * ------------------------------------------------------------------- */

/**
 * 当前用的合并服务地址：localStorage（用户在面板里填过）→ `VITE_MERGE_URL` → 空串。
 *
 * ★ 每一次都读 localStorage 而不是在模块加载时读一次：同一次会话里用户可以改地址，
 *   而模块级常量会把它冻住 —— 表现是「填了新地址，还是要刷新页面才生效」。
 */
export function mergeServiceUrl(): string {
  if (sessionAddress !== undefined) return sessionAddress;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved !== null) return saved.trim();
  } catch {
    // 隐私模式下 localStorage 会抛 —— 那就当没填过，用缺省值，不影响功能
  }
  const env = import.meta.env.VITE_MERGE_URL;
  return typeof env === 'string' ? env.trim() : '';
}

/** 记住用户填的地址。空串会明确关闭服务地址，覆盖构建时的 `VITE_MERGE_URL`。 */
export function saveMergeServiceUrl(url: string): void {
  sessionAddress = url.trim();
  try {
    localStorage.setItem(STORAGE_KEY, sessionAddress);
  } catch {
    // 同上：存不了就算了，本次会话里面板自己还留着那份值
  }
}

/** 去掉结尾的斜杠再拼路径，免得配成 `http://host:8899/` 时拼出 `//health` */
function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

/**
 * 这个地址算不算「本机」。
 *
 * 用途只有一个：`https` 页面调 `http://局域网IP` 会被浏览器**直接拦掉**（混合内容），
 * 而 `http://localhost` / `127.0.0.1` / `[::1]` 是规范里明确豁免的。撞上时给一句
 * 人话，比让用户对着一个语焉不详的「网络错误」猜半天强得多。
 */
function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}

/**
 * 请求发出**之前**就能判定的失败：地址根本不是一个 URL、或者会被浏览器拦掉。
 * 回一句中文，或者 `null`（= 可以发）。
 */
function blockedReason(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `合并服务地址「${url}」不是一个合法的网址。`;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `合并服务地址「${url}」的协议是 ${parsed.protocol}，只支持 http / https。`;
  }
  if (typeof location !== 'undefined' && location.protocol === 'https:'
    && parsed.protocol === 'http:' && !isLoopback(url)) {
    return '页面是 https，浏览器会拦掉 http 的合并服务（只有 http://localhost 豁免）。'
      + '请把这个页面的地址改成合并服务的地址（http://IP:端口/），或给服务配上 https。';
  }
  return null;
}

/* ---------------------------------------------------------------------
 * 探活
 * ------------------------------------------------------------------- */

export interface MergeHealth {
  /** 服务端是否正忙（有一张图在合并）。并发是 1，忙时新请求会立刻 429 */
  busy: boolean;
  maxUploadMb: number;
  maxBandMb: number;
  /** 服务端云打印是否可用（render harness 与 Playwright 均已就绪） */
  render?: boolean;
  /** 云打印不可用时的服务端原因 */
  renderReason?: string;
}

export type MergeProbe = { ok: true; health: MergeHealth } | { ok: false; reason: string };

/**
 * 探活。**失败不是异常**，只说明「这次不发合并请求」。
 *
 * 用 `fetch` 而不是 XHR：这是一个几十字节的 GET，不需要进度，而 `AbortSignal.timeout`
 * 一行就能给出超时。上传那半截仍然必须是 XHR（见文件头）。
 */
export async function probeMergeService(url: string): Promise<MergeProbe> {
  const blocked = blockedReason(url);
  if (blocked) return { ok: false, reason: blocked };
  try {
    const res = await fetch(joinUrl(url, '/health'), { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, reason: `合并服务回了 ${res.status}。` };
    const h = await res.json() as Partial<MergeHealth>;
    return {
      ok: true,
      health: {
        busy: h.busy === true,
        maxUploadMb: Number(h.maxUploadMb) || 0,
        maxBandMb: Number(h.maxBandMb) || 0,
        render: h.render === true,
        renderReason: typeof h.renderReason === 'string' ? h.renderReason : '',
      },
    };
  } catch (err) {
    // 连不上 / 超时 / 回的 body 不是 JSON —— 对调用方都是同一件事：这次别发合并请求。
    // 但仍然把底层原因留在括号里：用户自己填错地址时，这就是唯一的线索。
    return { ok: false, reason: `连不上合并服务（${(err as Error).name || '网络错误'}）。` };
  }
}

/* ---------------------------------------------------------------------
 * 进度（服务端在拼图 / 渲染时报的「第几块」）
 * ------------------------------------------------------------------- */

/** 读进度的超时。**必须短**：它一秒钟问一次，慢一点就直接跳过这一跳 */
const PROGRESS_TIMEOUT_MS = 3_000;

/**
 * 服务端当前这一单的进度快照（对应 `server/progress.ts` 的 `ProgressSnapshot`）。
 *
 * ★ 为什么要它：`POST /merge` 是**一路阻塞到出完图**才回响应的
 *   （几百 MB 的图，中间一个字节都不发）。页面上那句「已等 2 分 14 秒」对用户
 *   等于「它是不是死了」。有了这个接口，等待期间能显示**真的在往前走的数字**。
 */
export interface MergeProgress {
  /** 服务端在跑的是哪一单：渲染中 / 拼合中 */
  job: 'merge' | 'render';
  /** 服务端写好的中文，页面直接显示（如「正在拼合（3/16 块）」） */
  label: string;
  done: number;
  total: number;
  /** 这一单从开始到现在的毫秒数 */
  elapsedMs: number;
}

/**
 * 读一次进度。**不抛**，读不到就回 `null`（页面继续显示兜底文案 + 已等时长）。
 *
 * 读不到的情形一律归为同一种：服务没起、被跨域拦掉、这是个**老版本的服务端**
 * （没有 `/progress` 路由，回 404）、服务端正忙到没空答（大图的同步解码会
 * 短暂占住事件循环，请求超时）。对调用方都是「这一跳没有新消息」，不必区分。
 *
 * ★ `cache: 'no-store'` 不能省：这是个每秒都要变的状态查询，被 HTTP 缓存住
 *   会让进度条**停在某一格不动**，比没有进度条更糟。
 */
export async function fetchMergeProgress(url: string): Promise<MergeProgress | null> {
  if (blockedReason(url)) return null;
  try {
    const res = await fetch(joinUrl(url, '/progress'), {
      cache: 'no-store',
      signal: AbortSignal.timeout(PROGRESS_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const p = await res.json() as Partial<MergeProgress>;
    if (p.job !== 'merge' && p.job !== 'render') return null; // 'idle' / 其它 → 没在跑
    return {
      job: p.job,
      label: typeof p.label === 'string' ? p.label : '',
      done: Number(p.done) || 0,
      total: Number(p.total) || 0,
      elapsedMs: Number(p.elapsedMs) || 0,
    };
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------------
 * 上传 zip → 换回一张大图
 * ------------------------------------------------------------------- */

export interface MergeResult {
  /** 合并好的 PNG */
  blob: Blob;
  /** 服务端捎来的一句话（峰值内存提示之类）；可能为空串 */
  notice: string;
  /** 服务端捎来的警告（文件名对不上、包里有多余文件…）；可能为空串 */
  warnings: string;
}

export type MergeUpload = { ok: true; result: MergeResult } | { ok: false; reason: string };

export interface MergeUploadInput {
  url: string;
  zip: Blob;
  /** 上传进度。`total` 为 `null` = 算不出总大小（此时只报已传字节） */
  onProgress?: (loaded: number, total: number | null) => void;
}

/**
 * 把 zip 传上去、拿回合并图。**任何一步不成都回 `{ ok: false, reason }`，绝不抛。**
 *
 * `reason` 一律是中文，且尽量是**用户能照着做**的话（服务端的 `{ error }` 就是为此写的，
 * 这里原样带出来）。
 *
 * ---------------------------------------------------------------------
 * ★ 关于响应头：`X-Merge-Notice` / `X-Merge-Warnings` 是服务端**额外**暴露给脚本的
 *   （普通响应头默认不给 `getResponseHeader` 读），而且内容只能是 ASCII —— 中文是
 *   `encodeURIComponent` 过的，这里要解回来。
 *
 * ★ 关于落盘时机：响应**没有 `Content-Length`**（deflate 之后多大不可预知），走 chunked。
 *   所以必须等整个 body 收完（`onload`）才能落盘 —— 中途断掉时 `onload` 根本不会触发，
 *   也就不会留下半个打不开的 PNG。这条是服务端 `res.destroy()` 那半截设计的前提。
 */
export function uploadZipForMerge(input: MergeUploadInput): Promise<MergeUpload> {
  const { url, zip, onProgress } = input;
  const blocked = blockedReason(url);
  if (blocked) return Promise.resolve({ ok: false, reason: blocked });

  return new Promise<MergeUpload>((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', joinUrl(url, '/merge'));
    xhr.setRequestHeader('Content-Type', 'application/zip');
    xhr.responseType = 'blob';
    xhr.timeout = 0;                     // 总时长不设上限，由下面两段看门狗分别管
    let settled = false;
    let uploading = true;
    let lastTick = Date.now();

    const done = (v: MergeUpload) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      resolve(v);
    };

    /* ★ 看门狗分两段，这是**关键**：
          · 上传阶段：连续 60 秒没有任何进度事件 ⇒ 真的卡住了（对端不见了但 TCP 半开着）；
          · 上传完成之后：服务端正在解压 + 拼图 + deflate，**本来就一个字节都不发**，
            几十秒到几分钟没有动静是正常的。这时只有「总时长」这一条上限。

       ★ 顺序也是关键：**先 `done()` 再 `abort()`**。`abort()` 会**同步**触发 `onabort`，
         而 `onabort` 里那句是通用的「合并请求已被中断。」—— 先 abort 的话它当场就把 Promise
         结掉了，这里精心写的那句「上传超过 60 秒没有任何进展，请确认合并服务还在运行」
         永远轮不到用户看见。而那片「请确认服务还在运行」恰恰是唯一能照着做的话。 */
    const watchdog = setInterval(() => {
      const idle = Date.now() - lastTick;
      if (uploading) {
        if (idle > UPLOAD_STALL_MS) {
          done({ ok: false, reason: `上传超过 ${UPLOAD_STALL_MS / 1000} 秒没有任何进展，已中断。请确认合并服务还在运行。` });
          xhr.abort();
        }
        return;
      }
      if (idle > MERGE_TIMEOUT_MS) {
        done({ ok: false, reason: `服务端合并超过 ${MERGE_TIMEOUT_MS / 60000} 分钟仍没有回数据，已中断。` });
        xhr.abort();
      }
    }, 1000);

    const tick = () => { lastTick = Date.now(); };

    xhr.upload.onprogress = (e) => {
      tick();
      onProgress?.(e.loaded, e.lengthComputable ? e.total : null);
    };
    xhr.upload.onload = () => {
      uploading = false;
      tick();
      onProgress?.(zip.size, zip.size);
    };
    // 下载合并图这一段也算「有进展」：慢链路下几十秒收一个 GB 是正常的
    xhr.onprogress = () => { tick(); };

    xhr.onerror = () => done({
      ok: false,
      reason: '连不上合并服务（网络错误）。请确认服务还在运行、地址填对了。',
    });
    xhr.ontimeout = () => done({ ok: false, reason: '合并请求超时。' });
    // `abort()` 是我们自己调的（看门狗），那条路已经 `done()` 过了，这里只是兜底
    xhr.onabort = () => done({ ok: false, reason: '合并请求已被中断。' });

    xhr.onload = async () => {
      if (settled) return;
      if (xhr.status !== 200) {
        // ★ 错误响应体也是 blob（`responseType='blob'` 一视同仁），要先读成文本再解析。
        //   服务端的 `{ error }` 是**写给人看的**，能原样带出去就别自己另编一句。
        let msg = `合并服务回了 ${xhr.status}。`;
        try {
          const text = await xhr.response.text();
          const parsed = JSON.parse(text) as { error?: string };
          if (parsed.error) msg = parsed.error;
        } catch {
          // 不是 JSON（例如反代吐的 502 页面）—— 那就用上面那句带状态码的话
        }
        done({ ok: false, reason: msg });
        return;
      }
      done({
        ok: true,
        result: {
          blob: xhr.response as Blob,
          notice: decodeHeader(xhr, 'x-merge-notice'),
          warnings: decodeHeader(xhr, 'x-merge-warnings'),
        },
      });
    };

    xhr.send(zip);
  });
}

/** 读一个「中文被 `encodeURIComponent` 过」的响应头；读不到 / 解不开就回空串 */
function decodeHeader(xhr: XMLHttpRequest, name: string): string {
  const v = xhr.getResponseHeader(name);
  if (!v) return '';
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}
