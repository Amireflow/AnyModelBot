// 消息附件的当前输入（粘贴图片、拖入图片和文本文件）：每个机器人的对话一份，换页回来还在，不同机器人互不相干。
// 流程：整批硬校验 → 本地同步占位 → 服务端原子预约 → 传真实字节 → 图片在这里解码规范化后再传一份 → 就绪。
// 加入不等于发送，就绪不等于模型已读；发送由对话页走原来的发送按钮（screens/chat.js）。
// 这里只在内存里记状态和预览用的 Blob 地址：刷新页面后从服务端取回还在的那些，不承诺重启后一定能恢复。
import { api, ApiError } from "./api.js";
import { createStore, useStore } from "./store.js";
import { getLang, t } from "./i18n.js";

export const ATTACH_PROTOCOL = 1;
const MIB = 1024 * 1024;
/** 服务端的数字读到之前先用这一份（和 src/attachments/limits.ts 一致，读到后以服务端为准） */
const DEFAULTS = { maxItems: 8, maxImages: 4, maxFileBytes: 10 * MIB, maxTotalBytes: 50 * MIB, maxTextChars: 100000, maxTextCharsTotal: 200000 };
const TEXT_EXT = ["md", "markdown", "html", "htm", "txt", "csv", "json", "log", "yaml", "yml", "xml", "css", "js", "ts", "py", "sh", "ps1", "bat", "cmd"];
const IMAGE_EXT = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", jfif: "image/jpeg", jpe: "image/jpeg" };
const IMAGE_CONVERT = ["heic", "heif", "avif", "bmp", "tif", "tiff", "svg", "svgz", "ico", "apng", "jxl", "psd"];

const newId = () => {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const newMessageId = newId;

const extOf = (name) => {
  const base = String(name || "").replace(/\\/g, "/").split("/").pop() || "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
};

/**
 * 和服务端同一套分类（名字 + MIME）：{ kind } 或 { reject }。
 * 是图片但收不了的回 imageConvert，不回 format——那一句只列了文本格式，会让人以为图片都不支持。
 */
export function classifyFile(name, mime, formats) {
  const ext = extOf(name);
  const type = String(mime || "").toLowerCase().split(";")[0].trim();
  const text = formats?.text || TEXT_EXT;
  if (ext in IMAGE_EXT) return type && !type.startsWith("image/") ? { reject: "format" } : { kind: "image" };
  if (IMAGE_CONVERT.includes(ext)) return { reject: "imageConvert" };
  if (text.includes(ext)) return /^(image|audio|video)\//.test(type) ? { reject: "format" } : { kind: "text" };
  if (!ext && type.startsWith("image/")) return Object.values(IMAGE_EXT).includes(type) ? { kind: "image" } : { reject: "imageConvert" };
  // 扩展名不在表里、但系统说它是图片（.jp2、相机原片…）
  if (type.startsWith("image/")) return { reject: "imageConvert" };
  return { reject: "format" };
}

/** 整批的硬条件，有一项不合格整批不加；返回最相关的原因码或 null */
export function batchProblem(files, items, limits = DEFAULTS, formats) {
  if (!files.length) return "unreadable";
  const kinds = [];
  for (const f of files) {
    const c = classifyFile(f.name, f.type, formats);
    if (c.reject) return c.reject;
    kinds.push(c.kind);
  }
  if (files.some((f) => !(f.size > 0))) return "empty";
  if (files.some((f) => f.size > limits.maxFileBytes)) return "size";
  const images = items.filter((a) => a.kind === "image").length + kinds.filter((k) => k === "image").length;
  if (items.length + files.length > limits.maxItems || images > limits.maxImages) return "count";
  if (items.reduce((n, a) => n + a.size, 0) + files.reduce((n, f) => n + f.size, 0) > limits.maxTotalBytes) return "size";
  return null;
}

/** 原因码 → 一句短提示（同一个位置只显示最相关的一句） */
export function reasonText(code) {
  const map = {
    count: "attach.limitCount", size: "attach.limitSize", format: "attach.format", imageConvert: "attach.imageConvert", empty: "attach.empty",
    unreadable: "attach.unreadable", encoding: "attach.encoding", content: "attach.content", context: "attach.context", expired: "attach.expired",
    busy: "attach.busy", changed: "attach.changed", vision_unsupported: "attach.visionUnsupported", vision_unknown: "attach.visionUnknown",
    vision_closed: "attach.visionClosed", conflict: "attach.changed", rejected: "attach.network", not_found: "attach.expired", rate: "attach.batchRejected",
    protocol: "attach.protocol", network: "attach.network", unknown: "attach.unknownResult", processing: "attach.processing", batch: "attach.batchRejected",
    clipboard: "attach.clipboardFailed", filePaste: "attach.filePaste", noBot: "attach.noBot", historyWindow: "attach.historyWindow", historyNoVision: "attach.historyNoVision",
  };
  return t(map[code] || "attach.batchRejected");
}

// —— 每个机器人的当前输入 ——
const drafts = new Map();
/** 不进渲染状态的东西：取消令牌、预览用的 Blob 地址 */
const side = new Map();
const blank = () => ({ items: [], server: null, unsupported: false, offline: false, notice: null, sending: false, unknown: null });
export function draftStore(botId) {
  if (!drafts.has(botId)) {
    drafts.set(botId, createStore(blank()));
    side.set(botId, { aborts: new Map(), urls: new Map(), noticeTimer: 0, refreshing: null });
  }
  return drafts.get(botId);
}
export const useDraft = (botId) => useStore(draftStore(botId));
const patch = (botId, fn) => draftStore(botId).set((s) => ({ ...s, ...fn(s) }));
const patchItem = (botId, cid, change) => patch(botId, (s) => ({ items: s.items.map((a) => (a.cid === cid ? { ...a, ...change } : a)) }));

/** 一句会自己消失的提示（批次被拒、粘贴不了…）；不抢正在挡发送的那句 */
export function notify(botId, code) {
  const x = side.get(botId) || (draftStore(botId), side.get(botId));
  clearTimeout(x.noticeTimer);
  patch(botId, () => ({ notice: { code, at: Date.now() } }));
  x.noticeTimer = setTimeout(() => patch(botId, () => ({ notice: null })), 6000);
}

const contentUrl = (botId, a) => `/amb/api/bots/${encodeURIComponent(botId)}/attachments/${encodeURIComponent(a.id)}/content?v=${encodeURIComponent(a.version || "")}`;
/** 已发消息里的图片地址（和待发的预览、交给模型的是同一个内容版本） */
export const sentImageUrl = contentUrl;

function fromServer(botId, r, local) {
  const status = r.status === "ready" ? "ready" : r.status === "failed" ? "failed" : r.status === "expired" ? "expired" : local?.status || "processing";
  return {
    cid: r.clientId, id: r.id, batch: r.batch, order: r.order, kind: r.kind, name: local?.name || r.name, size: r.size, status,
    error: r.status === "expired" ? "expired" : r.error || "", version: r.version, width: r.width, height: r.height, textChars: r.textChars || 0,
    url: r.kind === "image" && r.status === "ready" ? local?.url || contentUrl(botId, r) : "",
  };
}

/**
 * 读一次服务端的能力和当前输入：上限、格式、模型看图三态、通路、上下文预算、修订。
 * 本地还没拿到 id 的占位留着；服务端已经没有的（过期被清）标成过期。旧服务没有这个接口时标成不支持。
 */
export function refresh(botId) {
  const x = side.get(botId) || (draftStore(botId), side.get(botId));
  if (x.refreshing) return x.refreshing;
  x.refreshing = (async () => {
    try {
      const d = await api(`/bots/${encodeURIComponent(botId)}/attachments/state`);
      if (d.protocol !== ATTACH_PROTOCOL) return patch(botId, () => ({ unsupported: true, offline: false }));
      patch(botId, (s) => {
        const mine = new Map(s.items.map((a) => [a.cid, a]));
        // 没人在传的半截预约（刷新页面时传到一半的）：超过两分钟就让服务端释放，不留一个永远在处理的占位
        const orphan = (r) => !mine.has(r.clientId) && (r.status === "reserved" || r.status === "rendition") && Date.now() - (r.expiresAt - d.limits.draftTtlMs) > 120000;
        const rows = d.items.filter((r) => {
          if (!orphan(r)) return true;
          api(`/bots/${encodeURIComponent(botId)}/attachments/${encodeURIComponent(r.id)}`, { method: "DELETE" }).catch(() => {});
          return false;
        });
        const known = new Map(rows.map((r) => [r.clientId, r]));
        const items = [
          ...rows.map((r) => fromServer(botId, r, mine.get(r.clientId))),
          // 还在预约 / 读取的本地占位（服务端还不认识）
          ...s.items.filter((a) => !a.id && !known.has(a.cid)),
        ].sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9));
        return { server: d, items, unsupported: false, offline: false };
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) patch(botId, () => ({ unsupported: true, offline: false }));
      else if (!(e instanceof ApiError)) patch(botId, () => ({ offline: true }));
    } finally {
      x.refreshing = null;
    }
    return draftStore(botId).get();
  })();
  return x.refreshing;
}

const PUT = async (botId, id, what, body, signal) => {
  const res = await fetch(`/amb/api/bots/${encodeURIComponent(botId)}/attachments/${encodeURIComponent(id)}/${what}`, {
    method: "PUT", headers: { "content-type": "application/octet-stream", "x-amb-lang": getLang() }, body, signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `HTTP ${res.status}`, res.status, data);
  return data.item;
};

/**
 * 图片规范化：按 EXIF 纠正方向、不裁剪不拉伸、最长边超过 4096 时等比缩小（小图不放大），重新编码后元信息就没了。
 * JPEG 出 JPEG，其余出 PNG（保留透明）；PNG 超过单份上限而图片又没有透明区域时改出 JPEG。
 * want：服务端按原图文件头算好的目标尺寸（已经考虑了方向）和真实格式（扩展名可能写错，以它为准）。
 */
async function normalizeImage(file, want, maxBytes) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    // 解不开的图片：回图片那一句提示（转成 PNG / JPG 再加）
    throw Object.assign(new Error("decode"), { code: "imageConvert" });
  }
  try {
    const w = want?.width || bitmap.width;
    const h = want?.height || bitmap.height;
    /** @type {any} */
    const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
    const g = canvas.getContext("2d");
    g.imageSmoothingQuality = "high";
    g.drawImage(bitmap, 0, 0, w, h);
    const encode = (type, quality) => (canvas.convertToBlob ? canvas.convertToBlob({ type, quality }) : new Promise((r) => canvas.toBlob(r, type, quality)));
    const jpeg = want?.format ? /^jpe?g$/.test(want.format) : /jpe?g$/i.test(file.type) || /\.(jpe?g|jpe|jfif)$/i.test(file.name || "");
    let out = await encode(jpeg ? "image/jpeg" : "image/png", 0.92);
    if (out && !jpeg && out.size > maxBytes) {
      const data = g.getImageData(0, 0, w, h).data;
      let opaque = true;
      for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) { opaque = false; break; }
      if (opaque) out = await encode("image/jpeg", 0.9);
    }
    if (!out) throw Object.assign(new Error("encode"), { code: "imageConvert" });
    if (out.size > maxBytes) throw Object.assign(new Error("size"), { code: "size" });
    return out;
  } finally {
    bitmap.close?.();
  }
}

async function upload(botId, item, file) {
  const x = side.get(botId);
  const ac = new AbortController();
  x.aborts.set(item.cid, ac);
  const limits = draftStore(botId).get().server?.limits || DEFAULTS;
  try {
    let bytes;
    try {
      bytes = await file.arrayBuffer();
    } catch {
      // 读不了（没有权限、云端占位还没下载、读的时候文件没了）
      throw Object.assign(new Error("read"), { code: "unreadable" });
    }
    if (ac.signal.aborted) return;
    if (bytes.byteLength !== file.size) throw Object.assign(new Error("changed"), { code: "unreadable" });
    let r = await PUT(botId, item.id, "content", bytes, ac.signal);
    if (r.status === "rendition") {
      const blob = await normalizeImage(file, r.want, limits.maxFileBytes);
      if (ac.signal.aborted) return;
      r = await PUT(botId, item.id, "rendition", blob, ac.signal);
      if (r.status === "ready") {
        // 预览用的就是刚交上去的这一份规范化字节
        const url = URL.createObjectURL(blob);
        x.urls.set(item.cid, url);
        if (ac.signal.aborted) return void URL.revokeObjectURL(url);
        patchItem(botId, item.cid, { ...fromServer(botId, r), url });
        return;
      }
    }
    if (ac.signal.aborted) return;
    patchItem(botId, item.cid, fromServer(botId, r, { name: item.name }));
  } catch (e) {
    if (ac.signal.aborted || e?.name === "AbortError") return;
    const code = e?.code || (e instanceof ApiError ? e.data?.code || "unreadable" : "network");
    patchItem(botId, item.cid, { status: "failed", error: code });
  } finally {
    x.aborts.delete(item.cid);
  }
}

/**
 * 加一批文件（一次粘贴或一次投放）。先整批核硬条件，不合格一个都不加、已有输入不动；
 * 通过后同步占位（处理中的也占名额），再向服务端原子预约；之后各项各自读取，某一项出问题只标这一项。
 * 返回有没有加进去。
 */
export async function addFiles(botId, files) {
  const store = draftStore(botId);
  if (!store.get().server && !store.get().unsupported) await refresh(botId);
  let s = store.get();
  if (s.unsupported) return notify(botId, "protocol"), false;
  if (s.sending || s.unknown) return notify(botId, s.unknown ? "unknown" : "processing"), false;
  if (!s.server) return notify(botId, "network"), false;
  const problem = batchProblem(files, s.items, s.server.limits, s.server.formats);
  if (problem) return notify(botId, problem), false;
  const batch = newId();
  const base = Math.max(0, ...s.items.map((a) => a.order || 0));
  const placed = files.map((f, i) => ({
    cid: newId(), id: "", batch, order: base + 1 + i, kind: classifyFile(f.name, f.type, s.server.formats).kind, name: f.name || "", size: f.size,
    status: "processing", error: "", version: "", url: "", width: 0, height: 0, textChars: 0,
  }));
  // 同步占位：紧接着再来的一批按占了位的数量核算
  patch(botId, (cur) => ({ items: [...cur.items, ...placed], notice: null }));
  const dropBatch = () => patch(botId, (cur) => ({ items: cur.items.filter((a) => a.batch !== batch) }));
  let reserved;
  try {
    reserved = await api(`/bots/${encodeURIComponent(botId)}/attachments/batches`, {
      method: "POST",
      body: { protocol: ATTACH_PROTOCOL, segment: s.server.segment, batch, items: placed.map((a, i) => ({ clientId: a.cid, name: a.name || `image.${(files[i].type.split("/")[1] || "png").replace("jpeg", "jpg")}`, mime: files[i].type || "", size: a.size })) },
    });
  } catch (e) {
    dropBatch();
    const code = e instanceof ApiError ? e.data?.code || "batch" : "network";
    // 分段或条件变了（比如别的窗口开了新对话）：重新读一次再说
    if (code === "changed") void refresh(botId);
    notify(botId, code === "changed" ? "batch" : code);
    return false;
  }
  const byCid = new Map(reserved.items.map((r) => [r.clientId, r]));
  // 预约期间被移除的那几项：告诉服务端释放
  const alive = new Set(store.get().items.filter((a) => a.batch === batch).map((a) => a.cid));
  const jobs = [];
  placed.forEach((a, i) => {
    const r = byCid.get(a.cid);
    if (!r) return;
    if (!alive.has(a.cid)) return void api(`/bots/${encodeURIComponent(botId)}/attachments/${encodeURIComponent(r.id)}`, { method: "DELETE" }).catch(() => {});
    patchItem(botId, a.cid, { id: r.id, order: r.order });
    jobs.push(() => upload(botId, { ...a, id: r.id }, files[i]));
  });
  // 同时最多传 3 项（服务端每个机器人同时收 4 个）
  const worker = async () => {
    for (let job; (job = jobs.shift()); ) await job();
  };
  await Promise.all([worker(), worker(), worker()]);
  void refresh(botId);
  return true;
}

/** 移除一项待发的附件：立刻消失、释放名额，取消还在进行的读取和上传（迟到的结果不会让它回来）；原文件不动 */
export function removeItem(botId, cid) {
  const x = side.get(botId);
  const item = draftStore(botId).get().items.find((a) => a.cid === cid);
  if (!item) return;
  x?.aborts.get(cid)?.abort();
  const url = x?.urls.get(cid);
  if (url) (URL.revokeObjectURL(url), x.urls.delete(cid));
  patch(botId, (s) => ({ items: s.items.filter((a) => a.cid !== cid) }));
  if (item.id) api(`/bots/${encodeURIComponent(botId)}/attachments/${encodeURIComponent(item.id)}`, { method: "DELETE" }).then(() => refresh(botId)).catch(() => {});
}

/** 开始新对话：上一段没发出的附件不带过来（服务端同时清掉） */
export function clearDraft(botId) {
  const x = side.get(botId);
  if (!x) return;
  for (const ac of x.aborts.values()) ac.abort();
  for (const url of x.urls.values()) URL.revokeObjectURL(url);
  x.urls.clear();
  patch(botId, () => ({ items: [], notice: null }));
  void refresh(botId);
}

/** 发出去并受理了的那几项从当前输入里拿掉（消息里的缩略图改用服务端地址） */
export function settleSent(botId, cids) {
  const x = side.get(botId);
  const set = new Set(cids);
  for (const cid of set) {
    const url = x?.urls.get(cid);
    // 放大预览可能还开着这张图：晚一点再回收
    if (url) (setTimeout(() => URL.revokeObjectURL(url), 30000), x.urls.delete(cid));
  }
  patch(botId, (s) => ({ items: s.items.filter((a) => !set.has(a.cid)), sending: false, unknown: null }));
  void refresh(botId);
}

export const setSending = (botId, sending) => patch(botId, () => ({ sending }));
export const setUnknown = (botId, unknown) => patch(botId, () => ({ unknown }));

/** 粗略估算文字占多少 tokens（和服务端同一个算法，只是估算） */
function textTokens(text) {
  let ascii = 0;
  let wide = 0;
  for (const ch of text) (ch.codePointAt(0) < 0x80 ? ascii++ : wide++);
  return Math.ceil(ascii / 4) + wide;
}

/**
 * 带附件时原发送按钮能不能用：{ blocked: 原因码 | "" , hint: 不挡发送的轻提示码 | "" }。
 * 条件：全部附件就绪、没有失败 / 过期项、容量和字数在限额内、含图时模型确实能看图且通路开着、上下文放得下、
 * 服务连得上、没有结果不明的上一次发送、机器人不在回复中。
 */
export function sendCheck(s, { text = "", generating = false } = {}) {
  const items = s.items;
  if (s.unsupported) return { blocked: items.length ? "protocol" : "", hint: "" };
  if (s.unknown) return { blocked: "unknown", hint: "" };
  if (!items.length) {
    const sv = s.server;
    // 没有待发附件：只说明历史图片这一轮看不看得见（不挡发送）
    if (sv?.history?.images > 0 && sv.model?.vision !== "supported") return { blocked: "", hint: "historyNoVision" };
    return { blocked: "", hint: "" };
  }
  if (s.offline || !s.server) return { blocked: "network", hint: "" };
  const bad = items.find((a) => a.status === "failed" || a.status === "expired");
  if (bad) return { blocked: bad.status === "expired" ? "expired" : bad.error || "unreadable", hint: "" };
  if (s.sending || items.some((a) => a.status !== "ready")) return { blocked: "processing", hint: "" };
  if (generating || s.server.busy) return { blocked: "busy", hint: "" };
  const { limits, model, usage, history } = s.server;
  const images = items.filter((a) => a.kind === "image").length;
  if (images) {
    if (model.channel === "closed") return { blocked: "vision_closed", hint: "" };
    if (model.vision === "unsupported") return { blocked: "vision_unsupported", hint: "" };
    if (model.vision !== "supported") return { blocked: "vision_unknown", hint: "" };
  }
  if (items.reduce((n, a) => n + (a.textChars || 0), 0) > limits.maxTextCharsTotal) return { blocked: "content", hint: "" };
  if ((usage?.tokens || 0) + textTokens(text) > model.context.tokens) return { blocked: "context", hint: "" };
  if (history?.windowed && history.images + images > limits.maxImages) return { blocked: "", hint: "historyWindow" };
  if (!images && history?.images > 0 && model.vision !== "supported") return { blocked: "", hint: "historyNoVision" };
  return { blocked: "", hint: "" };
}

/**
 * 发送带附件的消息：冻结这一刻的文字和有序的内容版本，交给服务端原子受理。
 * 返回 { ok, receipt } | { ok: false, code } | { unknown: true }（断线，结果不明：之后只查原请求，不发第二次）。
 */
export async function submit(botId, text, clientMessageId, retried = false) {
  const fresh = await refresh(botId);
  const s = fresh || draftStore(botId).get();
  if (s.offline || !s.server) return { ok: false, code: "network" };
  const check = sendCheck({ ...s, sending: false }, { text });
  if (check.blocked) return { ok: false, code: check.blocked };
  const items = s.items;
  let res;
  try {
    res = await fetch(`/amb/api/bots/${encodeURIComponent(botId)}/chat/send`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-amb-lang": getLang() },
      body: JSON.stringify({ version: s.server.sendVersion, clientMessageId, text, segment: s.server.segment, revision: s.server.revision, modelRevision: s.server.model.revision, attachments: items.map((a) => ({ id: a.id, version: a.version })) }),
    });
  } catch {
    return { unknown: true, cids: items.map((a) => a.cid) };
  }
  const data = await res.json().catch(() => null);
  if (res.ok && data?.status === "accepted") return { ok: true, receipt: data, cids: items.map((a) => a.cid) };
  // 网关超时、连接中断的应答：受理与否不明
  if (res.status >= 500 || !data) return { unknown: true, cids: items.map((a) => a.cid) };
  // 修订刚好在这一刻变了（没有受理）：重新读一次当前输入，核对后用同一个消息 id 再交一次
  if (data.code === "changed" && !retried) return submit(botId, text, clientMessageId, true);
  if (data.code === "changed" || data.code === "expired") void refresh(botId);
  return { ok: false, code: data.code || "changed" };
}

/** 查原请求有没有被受理：accepted（带回执）/ pending / none（确认未受理）/ offline（还是连不上） */
export async function querySend(botId, clientMessageId) {
  try {
    const d = await api(`/bots/${encodeURIComponent(botId)}/chat/send/${encodeURIComponent(clientMessageId)}`);
    return d.status === "accepted" ? { status: "accepted", receipt: d } : { status: d.status === "pending" ? "pending" : "none" };
  } catch {
    return { status: "offline" };
  }
}

// —— 剪贴板与拖放里有什么 ——

/** 真实的系统文件拖动：带 Files，且不是从网页里拖出来的图片 / 链接（那种带 text/html 或网址） */
export function isFileDrag(dt) {
  const types = [...(dt?.types || [])];
  return types.includes("Files") && !types.includes("text/html");
}

/** 投放里的文件：目录不展开（整批按不支持的格式拒绝） */
export function droppedFiles(dt) {
  const items = [...(dt?.items || [])].filter((i) => i.kind === "file");
  const hasDir = items.some((i) => {
    try {
      return (i.webkitGetAsEntry?.() || i.getAsEntry?.())?.isDirectory;
    } catch {
      return false;
    }
  });
  return { files: [...(dt?.files || [])], hasDir };
}

/**
 * 一次粘贴里有什么：images 是剪贴板实际给出的图片字节；otherFiles 是普通文件的复制对象（不支持粘贴）；
 * realText 表示剪贴板里另有真正的普通文字（不是文件名、文件路径或文件 URI）——这时文字照常粘贴，图片另外加入。
 */
export function readPaste(cd) {
  const files = [...(cd?.files || [])];
  const images = files.filter((f) => /^image\//i.test(f.type));
  const otherFiles = files.filter((f) => !/^image\//i.test(f.type));
  const types = [...(cd?.types || [])];
  const plain = (cd?.getData?.("text/plain") || "").trim();
  const uris = (cd?.getData?.("text/uri-list") || "").trim();
  const lines = plain.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const fileish = !plain || plain === uris || lines.every((l) => /^file:\/\//i.test(l) || files.some((f) => f.name && (l === f.name || l.endsWith("/" + f.name) || l.endsWith("\\" + f.name))));
  // 剪贴板说有图片或文件，却一个字节也没给（没有权限、系统没交出来）
  const promised = types.includes("Files") || types.some((x) => /^image\//i.test(x));
  return { images, otherFiles, realText: !fileish, failed: promised && !files.length && fileish, hasFiles: files.length > 0 };
}

/**
 * 整个窗口对带文件的拖动都拦掉浏览器的默认行为（打开文件、离开当前页面）：在侧栏、设置页、没有对话的地方松开也不会打开文件、
 * 不切机器人。只有标了 data-drop-zone 的对话主区接收；别处显示成不可放。输入框里拖动选中的文字不带文件，不受影响。
 */
export function installDropGuard() {
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  window.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    const zone = e.target instanceof Element && e.target.closest("[data-drop-zone]");
    const handled = e.defaultPrevented;
    if (!handled) e.preventDefault();
    // 对话主区自己定了能不能放；别处一律不可放
    if (!zone || !handled) e.dataTransfer.dropEffect = "none";
  });
  window.addEventListener("drop", (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
}
