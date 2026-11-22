/**
 * 消息附件的接口（网页对话 <botId>:web:console）：
 *
 *   GET    /bots/:id/attachments/state                能力协商 + 当前输入（协议版本、真实上限、格式、模型看图三态、通路、上下文预算、存储位置）
 *   POST   /bots/:id/attachments/batches              一个批次原子预约名额（JSON：只有名字、类型、大小，不带内容）
 *   PUT    /bots/:id/attachments/:att/content         这一项的真实字节（application/octet-stream，流式读、边读边核上限）
 *   PUT    /bots/:id/attachments/:att/rendition       图片规范化后的那一份（同上）
 *   DELETE /bots/:id/attachments/:att                 移除待发的一项（幂等）
 *   GET    /bots/:id/attachments/:att/content         图片预览（规范化的那一份；待发和已发共用）
 *   GET    /bots/:id/attachments/:att/download        已发的 ZIP 原文件（网页下载到当前操作的这台电脑）
 *   POST   /bots/:id/attachments/:att/save            桌面版：用系统「另存为」保存已发的 ZIP 原文件
 *   POST   /bots/:id/chat/send                        带附件的消息：核验全部条件后原子受理，回执里是消息和回合
 *   GET    /bots/:id/chat/send/:clientMessageId       断线后查原请求有没有被受理（不发第二次）
 *
 * 归属按机器人 + 会话 + 分段核对，附件 id 不可猜；只收界面交来的真实字节，不按任何路径或网址去读。
 * 改动类请求和预览都核对来源（Origin / Sec-Fetch-Site）：别的网站发不进来，也嵌不了图。
 */
import crypto from "node:crypto";
import type http from "node:http";
import path from "node:path";
import { ATTACHMENT_PROTOCOL, IMAGE_TYPES, LIMITS, SEND_VERSION, TEXT_TYPES, ZIP_EXT, maxBytesOf, type RejectCode } from "../../attachments/limits.js";
import { AttachmentError, Attachments, publicAttachment, validClientId, type AttachmentErrorCode } from "../../attachments/service.js";
import { FolderError, type FolderBinding } from "../../folders/service.js";
import { t, type MessageKey } from "../../i18n/index.js";
import { logger } from "../../log.js";
import { HttpError, consoleConvId, readJson, send, webEvent, type Route, type WebContext } from "../http.js";

const log = logger("web.attachments");

/** 二进制上传的 Content-Type（server.ts 据此放行非 JSON 的 PUT；这种类型跨站发要预检，过不了） */
export const isAttachmentUpload = (m: string, seg: string[], contentType: string): boolean =>
  m === "PUT" && seg[0] === "bots" && seg[2] === "attachments" && seg.length === 5 && (seg[4] === "content" || seg[4] === "rendition") && /^application\/octet-stream\s*(;|$)/i.test(contentType.trim());

/** 同源才行：带了 Origin 就要和 Host 一致；浏览器标了跨站的不收 */
function sameOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) return false;
    } catch {
      return false;
    }
  }
  const site = String(req.headers["sec-fetch-site"] ?? "");
  return !site || site === "same-origin" || site === "none";
}

/** 按上限读完请求体：超过就停、不落盘；30 秒没有数据或总共超过 2 分钟算读不了 */
function readBody(req: http.IncomingMessage, max: number): Promise<Buffer | "too_large"> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"]) > max) {
      req.resume();
      return resolve("too_large");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(idle);
      clearTimeout(total);
      fn();
    };
    const stalled = () => finish(() => (req.destroy(), reject(new AttachmentError("unreadable", 408))));
    let idle = setTimeout(stalled, 30_000);
    const total = setTimeout(stalled, 120_000);
    req.on("data", (c: Buffer) => {
      size += c.length;
      clearTimeout(idle);
      idle = setTimeout(stalled, 30_000);
      if (size > max) return finish(() => (req.resume(), resolve("too_large")));
      if (!done) chunks.push(c);
    });
    req.on("end", () => finish(() => resolve(Buffer.concat(chunks))));
    req.on("error", () => finish(() => reject(new AttachmentError("unreadable", 400))));
    req.on("aborted", () => finish(() => reject(new AttachmentError("unreadable", 400))));
  });
}

export function attachmentsRoutes(ctx: WebContext): Route {
  const { app, live, startLive, runLive } = ctx;
  const svc: Attachments = app.attachments;

  const fail = (res: http.ServerResponse, e: AttachmentError) => send(res, e.status, { error: t(`attachments.err_${e.code}` as MessageKey), code: e.code });

  /** 这个对话实际会用的模型（会话选的 → 机器人默认 → 全局默认 → 列表第一个），和运行时的选法一致 */
  async function modelOf(botId: string): Promise<string> {
    const bot = app.store.getBot(botId)!;
    const conv = app.store.getConversation(consoleConvId(botId));
    const m = conv?.model || bot.defaultModel || app.config.llm.defaultModel;
    if (m) return m;
    return (await app.runtime.listModels().catch(() => [] as string[]))[0] ?? "";
  }

  /** 模型这一侧的条件：看图三态、图片通路、上下文预算；revision 变了说明条件变了 */
  async function modelState(botId: string) {
    const id = await modelOf(botId);
    const routed = id ? app.routeModel(botId, id) : "";
    const [vision, known] = id ? await Promise.all([app.visionOf(routed), app.contextOf(routed)]) : ["unknown" as const, undefined];
    const channel = app.imageChannel(botId);
    const context = { tokens: known ?? LIMITS.fallbackContextTokens, estimated: known === undefined };
    const revision = crypto.createHash("sha256").update(JSON.stringify([id, routed, vision, channel, context.tokens])).digest("hex").slice(0, 16);
    return { id, routed, vision, channel, context, revision };
  }

  const zipOk = () => app.agent.available;

  const busy = (botId: string) => {
    const conv = consoleConvId(botId);
    return live.list(conv).length > 0 || app.runtime.busySince(conv) !== undefined || app.agent.turnsInProgress.has(conv);
  };

  /** 系统提示词和工具定义先占掉的部分（估算）：代理路径另有一份固定的系统提示词和工具定义 */
  const baseTokens = (botId: string) => Math.ceil((app.store.getBot(botId)?.systemPrompt.length ?? 0) * 0.8) + (app.agent.available ? 4000 : 256);

  async function state(botId: string) {
    const conv = consoleConvId(botId);
    const model = await modelState(botId);
    const items = svc.draft(botId, conv);
    const ready = items.filter((a) => a.status === "ready");
    return {
      protocol: ATTACHMENT_PROTOCOL,
      sendVersion: SEND_VERSION,
      limits: LIMITS,
      formats: { text: Object.keys(TEXT_TYPES), image: Object.keys(IMAGE_TYPES), zip: [ZIP_EXT] },
      /** ZIP 要靠代理的文件工具处理：代理模式关着时不收（界面提示开启代理模式） */
      zip: zipOk(),
      /** 文本附件由运行机器人的这台设备完整解码后交给模型 */
      textReading: true,
      /** 副本存在哪：运行机器人的设备（数据目录），不是浏览器所在的电脑 */
      storage: "bot-device",
      segment: svc.segmentOf(conv),
      revision: svc.revision(botId, conv),
      items: items.map(publicAttachment),
      model: { id: model.id, revision: model.revision, vision: model.vision, channel: model.channel, context: model.context },
      usage: { tokens: baseTokens(botId) + svc.estimate(ready, "", model.vision === "supported"), textChars: ready.reduce((n, a) => n + a.textChars, 0) },
      // windowed：纯对话路径每次请求只带最近 4 张还在的图片；代理路径的历史在代理会话里
      history: { images: svc.sentImages(botId, conv), windowed: !app.agent.available },
      busy: busy(botId),
    };
  }

  return async (req, res, url, seg, _p, m) => {
    if (seg[0] !== "bots" || seg.length < 4) return false;
    const isAtt = seg[2] === "attachments";
    const isSend = seg[2] === "chat" && seg[3] === "send";
    if (!isAtt && !isSend) return false;
    const botId = decodeURIComponent(seg[1]);
    if (!app.store.getBot(botId)) throw new HttpError(404, t("web.botNotFound"));
    if (!sameOrigin(req)) return send(res, 403, { error: t("attachments.err_origin"), code: "origin" });
    const conv = consoleConvId(botId);

    try {
      if (isAtt && seg.length === 4 && seg[3] === "state" && m === "GET") return send(res, 200, await state(botId));

      if (isAtt && seg.length === 4 && seg[3] === "batches" && m === "POST") {
        const b = await readJson(req);
        if (Number(b.protocol) !== ATTACHMENT_PROTOCOL) throw new AttachmentError("protocol", 426);
        app.store.ensureConversation(botId, "web", "console", "控制台");
        const r = svc.reserve(botId, conv, { segment: String(b.segment ?? ""), batch: String(b.batch ?? ""), items: Array.isArray(b.items) ? b.items : [] }, { zipOk: zipOk() });
        // 逐项：加进去的照常返回，不合格的各带原因（界面汇总成一句「部分文件未添加」）
        return send(res, 200, { items: r.items.map(publicAttachment), rejected: r.rejected, revision: svc.revision(botId, conv) });
      }

      if (isAtt && seg.length === 5 && (seg[4] === "content" || seg[4] === "rendition") && m === "PUT") {
        const id = decodeURIComponent(seg[3]);
        const target = svc.get(botId, id);
        if (!target) throw new AttachmentError("not_found", 404);
        const release = svc.beginUpload(botId);
        try {
          // ZIP 原文件最多 50 MiB；图片 / 文本、规范化后的图片 10 MiB
          const data = await readBody(req, seg[4] === "content" ? maxBytesOf(target.kind) : LIMITS.maxFileBytes);
          const item = data === "too_large" ? svc.reject(botId, id, "size") : seg[4] === "content" ? svc.receive(botId, id, data) : svc.rendition(botId, id, data);
          return send(res, 200, { item: publicAttachment(item), revision: svc.revision(botId, conv) });
        } finally {
          release();
        }
      }

      if (isAtt && seg.length === 4 && m === "DELETE") {
        svc.remove(botId, decodeURIComponent(seg[3]));
        return send(res, 200, { ok: true, revision: svc.revision(botId, conv) });
      }

      // 图片预览：只给就绪的图片（规范化的那一份），不给文本正文；不让浏览器猜类型、不当页面执行
      if (isAtt && seg.length === 5 && seg[4] === "content" && m === "GET") {
        const a = svc.get(botId, decodeURIComponent(seg[3]));
        const data = a?.kind === "image" ? svc.read(a) : undefined;
        if (!a || !data) throw new AttachmentError(a ? "expired" : "not_found", 404);
        res.writeHead(200, {
          "content-type": a.mime === "image/jpeg" ? "image/jpeg" : "image/png",
          "content-length": data.length,
          "cache-control": "private, max-age=3600, immutable",
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; sandbox",
          "cross-origin-resource-policy": "same-origin",
        });
        return res.end(data);
      }

      // 已发的 ZIP：保存原文件到当前操作的这台电脑（网页下载 / 桌面版另存为）；不解压、不执行。到期、无权只给一句原因
      if (isAtt && seg.length === 5 && (seg[4] === "download" ? m === "GET" : seg[4] === "save" && m === "POST")) {
        const a = svc.get(botId, decodeURIComponent(seg[3]));
        if (!a || a.kind !== "zip" || !a.messageId) throw new AttachmentError("not_found", 404);
        const file = svc.fileOf(a);
        if (!file) throw new AttachmentError("expired", 410);
        const name = a.name.toLowerCase().endsWith(".zip") ? a.name : `${a.name}.zip`;
        if (seg[4] === "save") {
          if (!app.desktop?.saveFileAs) throw new HttpError(400, t("web.desktopOnly"));
          return send(res, 200, await app.desktop.saveFileAs(file, name));
        }
        const data = svc.read(a);
        if (!data) throw new AttachmentError("expired", 410);
        res.writeHead(200, {
          "content-type": "application/zip",
          "content-length": data.length,
          "content-disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(path.basename(name))}`,
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; sandbox",
          "cross-origin-resource-policy": "same-origin",
        });
        return res.end(data);
      }

      if (isSend && seg.length === 5 && m === "GET") {
        const id = decodeURIComponent(seg[4]);
        if (!validClientId(id)) throw new AttachmentError("not_found", 404);
        const r = svc.querySend(botId, id);
        return send(res, 200, r.status === "accepted" ? { ...r.receipt, live: !!live.get(conv, r.receipt.turnId) } : { status: r.status });
      }

      if (isSend && seg.length === 4 && m === "POST") {
        const b = await readJson(req);
        if (Number(b.version) !== SEND_VERSION) throw new AttachmentError("protocol", 426);
        const clientMessageId = String(b.clientMessageId ?? "");
        const text = String(b.text ?? "").trim();
        const refs: Array<{ id: string; version: string }> = (Array.isArray(b.attachments) ? b.attachments : []).map((a: any) => ({ id: String(a?.id ?? ""), version: String(a?.version ?? "") }));
        if (!validClientId(clientMessageId) || !refs.length || refs.length > LIMITS.maxItems) throw new AttachmentError("changed", 400);
        const segment = String(b.segment ?? "");
        // 工作文件夹的选择 id 也固定进这个消息 id：同一个 id 换了目录算冲突，网络重试不会读到之后的新选择
        const folderId = "folder" in b ? String(b.folder ?? "") : undefined;
        const digest = Attachments.digest({ text, segment, attachments: refs, folder: folderId });
        // 同一个消息 id：内容相同返回原回执（连点、断线重发都不会建第二条消息、不重复执行）
        const prior = svc.beginSend(botId, clientMessageId, digest);
        if (prior) return send(res, 200, { ...prior, duplicate: true, live: !!live.get(conv, prior.turnId) });
        try {
          // 正在回复：带附件的消息不并进这一轮，也不自动排队
          if (busy(botId)) throw new AttachmentError("busy");
          // 点发送那一刻的工作文件夹：和服务端现在的选择对不上就不受理
          let folder: FolderBinding | null;
          try {
            folder = folderId === undefined ? (app.folders.current(conv) ?? null) : app.folders.bind(conv, folderId);
          } catch (e) {
            if (e instanceof FolderError) return send(res, 409, { error: t("folders.err_changed"), code: "folderChanged" });
            throw e;
          }
          const atts = svc.verify(botId, conv, { segment, revision: String(b.revision ?? ""), attachments: refs });
          const model = await modelState(botId);
          if (String(b.modelRevision ?? "") !== model.revision) throw new AttachmentError("changed");
          if (atts.some((a) => a.kind === "image")) {
            if (model.channel === "closed") throw new AttachmentError("vision_closed");
            if (model.vision !== "supported") throw new AttachmentError(model.vision === "unsupported" ? "vision_unsupported" : "vision_unknown");
          }
          if (baseTokens(botId) + svc.estimate(atts, text, true) > model.context.tokens) throw new AttachmentError("context");
          // 上面等过模型资料：绑定前同步再核一次忙碌和附件（之后到回执之间没有任何等待）
          if (busy(botId)) throw new AttachmentError("busy");
          svc.verify(botId, conv, { segment, revision: String(b.revision ?? ""), attachments: refs });
          const receipt = svc.bind(botId, conv, clientMessageId, digest, text, atts, "");
          const turn = startLive(botId, "");
          svc.setTurn(botId, clientMessageId, turn.id);
          const message = app.store.getMessage(receipt.messageId);
          const composed = svc.compose(message?.attachments ?? [], botId, text, { images: true });
          const ev = webEvent(botId, text);
          ev.prepared = { messageId: receipt.messageId, text: composed.text, images: composed.images };
          ev.folder = folder;
          turn.folder = folder?.id ?? "";
          void runLive(turn, ev);
          return send(res, 200, { ...receipt, turnId: turn.id, live: true });
        } finally {
          svc.settle(botId, clientMessageId);
        }
      }
    } catch (e) {
      if (e instanceof AttachmentError) {
        if (e.status >= 500) log.warn("attachment request failed", { code: e.code });
        return fail(res, e);
      }
      throw e;
    }
    return false;
  };
}

export type { AttachmentErrorCode, RejectCode };
