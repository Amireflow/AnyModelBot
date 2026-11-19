/**
 * 消息附件的受管副本：预约名额 → 收真实字节 → 校验 / 解码 → 就绪 → 随消息原子绑定 → 到期回收。
 *
 * - 副本在运行机器人的这台设备上（数据目录的 attachments/，随机文件名，不带原名和扩展名）；不写进文档素材存储，
 *   也不进机器人工作区。之后只读这份快照，不再沿原路径取文件。
 * - 归属按机器人 + 会话 + 对话分段；别的机器人、别的分段用不了。没发出的最长留 24 小时，随消息发出的留 30 天。
 * - 图片：服务端按文件头核对真实格式、尺寸、动画；规范化（纠正方向、去元信息、缩到 4096）由界面解码后交来，
 *   服务端再核对它是合法的 PNG / JPEG、尺寸与原图成比例，并去掉残留的元信息块。给模型的、预览的都是这一份。
 * - 文本：在这里完整解码（UTF-8 / 带 BOM 的 UTF-16），存成 UTF-8；只当资料读，不执行、不渲染、不联网。
 * - 日志只记 id、类型、字节数和错误码，不记正文、文件名和路径。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Store } from "../store/db.js";
import type { TurnImage } from "../agent/host.js";
import { logger } from "../log.js";
import { t } from "../i18n/index.js";
import { LIMITS, TEXT_TYPES, checkBatch, estimateImageTokens, estimateTextTokens, normalizedSize, type AttachmentKind, type RejectCode } from "./limits.js";
import { cleanRendition, decodeText, sniffImage } from "./sniff.js";
import type { MessageAttachment } from "../domain/attachments.js";

const log = logger("attachments");

/**
 * 接口报错的原因码（界面按它选提示）：RejectCode 之外还有
 * busy 回复进行中 · changed 条件变了（分段、修订、模型、附件状态）· vision_unsupported / vision_unknown / vision_closed 图片发不了 ·
 * conflict 同一个消息 id 换了内容 · rejected 这个消息 id 已确认未受理 · not_found · rate 太频繁 · protocol 版本对不上
 */
export type AttachmentErrorCode = RejectCode | "busy" | "changed" | "vision_unsupported" | "vision_unknown" | "vision_closed" | "conflict" | "rejected" | "not_found" | "rate" | "protocol";

export class AttachmentError extends Error {
  constructor(readonly code: AttachmentErrorCode, readonly status = 409) {
    super(code);
  }
}

export type AttachmentStatus = "reserved" | "rendition" | "ready" | "failed" | "removed" | "expired";

export interface Attachment {
  id: string;
  botId: string;
  conversationId: string;
  segment: string;
  clientId: string;
  batch: string;
  order: number;
  kind: AttachmentKind;
  name: string;
  ext: string;
  /** 原始字节（预约时是声明的，收到内容后是实际的） */
  bytes: number;
  /** 规范化 / 解码后存下的字节 */
  storedBytes: number;
  mime: string;
  width: number;
  height: number;
  origWidth: number;
  origHeight: number;
  textChars: number;
  status: AttachmentStatus;
  error: string;
  /** 内容版本：存下的那份字节的摘要 */
  version: string;
  storage: string;
  messageId: number;
  createdAt: number;
  expiresAt: number;
}

export type { MessageAttachment };

export interface SendReceipt {
  status: "accepted";
  clientMessageId: string;
  messageId: number;
  conversationId: string;
  turnId: string;
}

type Row = Record<string, unknown>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, conversation_id TEXT NOT NULL, segment TEXT NOT NULL,
  client_id TEXT NOT NULL, batch TEXT NOT NULL, ord INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, ext TEXT NOT NULL DEFAULT '',
  bytes INTEGER NOT NULL DEFAULT 0, stored_bytes INTEGER NOT NULL DEFAULT 0, mime TEXT NOT NULL DEFAULT '',
  width INTEGER NOT NULL DEFAULT 0, height INTEGER NOT NULL DEFAULT 0, orig_width INTEGER NOT NULL DEFAULT 0, orig_height INTEGER NOT NULL DEFAULT 0,
  text_chars INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', version TEXT NOT NULL DEFAULT '',
  storage TEXT NOT NULL DEFAULT '', message_id INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS attachments_client ON attachments(bot_id, client_id);
CREATE INDEX IF NOT EXISTS attachments_draft ON attachments(bot_id, conversation_id, message_id);
CREATE TABLE IF NOT EXISTS attachment_sends (
  bot_id TEXT NOT NULL, client_message_id TEXT NOT NULL, digest TEXT NOT NULL, message_id INTEGER NOT NULL,
  conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
  PRIMARY KEY(bot_id, client_message_id));
`;

const ID = /^[A-Za-z0-9_-]{8,64}$/;
/** 界面给的标识（附件、批次、消息）：长度有限的普通字符 */
export const validClientId = (v: unknown): v is string => typeof v === "string" && ID.test(v);
const newId = () => crypto.randomBytes(16).toString("base64url");

/** 显示用的文件名：只留最后一段，去掉控制字符，限长；只进数据库和界面，不当路径用 */
function displayName(name: unknown): string {
  const base = String(name ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  const clean = [...base.replace(/[\x00-\x1f\x7f]/g, "").trim()].slice(0, 200).join("");
  return clean || "file";
}

export class Attachments {
  private revisions = new Map<string, number>();
  private readonly boot = crypto.randomBytes(4).toString("hex");
  private uploads = new Map<string, number>();
  private rate = new Map<string, { at: number; n: number }>();
  /** 发送请求的受理状态（同一个客户端消息 id）：pending 正在核验 · rejected 已确认未受理（之后才到的原请求不再受理） */
  private sends = new Map<string, "pending" | "rejected">();
  private timer?: NodeJS.Timeout;

  constructor(private store: Store, private dir: string, private now: () => number = Date.now) {
    store.db.exec(SCHEMA);
  }

  // ---------- 当前输入 ----------

  /** 对话分段：用户主动开新对话的次数与时刻；开了新对话，旧分段的待发附件不跟过来 */
  segmentOf(conversationId: string): string {
    const times = this.store.manualSegmentTimes(conversationId);
    return `s${times.length}-${times.at(-1) ?? 0}`;
  }

  private key(botId: string, conversationId: string): string {
    return `${botId}\n${conversationId}`;
  }
  /** 当前输入的修订：每次增删、状态变化加一；界面发送时带上，对不上说明条件变了 */
  revision(botId: string, conversationId: string): string {
    return `${this.boot}-${this.revisions.get(this.key(botId, conversationId)) ?? 0}`;
  }
  private bump(botId: string, conversationId: string): void {
    const k = this.key(botId, conversationId);
    this.revisions.set(k, (this.revisions.get(k) ?? 0) + 1);
  }

  /** 当前输入里的附件（占着名额的：处理中、就绪、失败、过期都算；已移除的不算），按加入顺序 */
  draft(botId: string, conversationId: string): Attachment[] {
    const rows = this.store.db
      .prepare("SELECT * FROM attachments WHERE bot_id = ? AND conversation_id = ? AND message_id = 0 AND segment = ? AND status != 'removed' ORDER BY ord, created_at")
      .all(botId, conversationId, this.segmentOf(conversationId)) as Row[];
    return rows.map(toAttachment);
  }

  get(botId: string, id: string): Attachment | undefined {
    if (!ID.test(id)) return undefined;
    const r = this.store.db.prepare("SELECT * FROM attachments WHERE id = ? AND bot_id = ?").get(id, botId) as Row | undefined;
    return r ? toAttachment(r) : undefined;
  }

  private tx<T>(fn: () => T): T {
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const v = fn();
      this.store.db.exec("COMMIT");
      return v;
    } catch (e) {
      this.store.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** 预约太频繁（绕开界面刷接口）：每个机器人每分钟 120 次 */
  private throttle(botId: string): void {
    const now = this.now();
    const r = this.rate.get(botId);
    if (!r || now - r.at > 60_000) return void this.rate.set(botId, { at: now, n: 1 });
    if (++r.n > 120) throw new AttachmentError("rate", 429);
  }

  /**
   * 一个批次原子预约名额：整批的硬条件（类型、空文件、单份大小、数量、合计）有一项不合格就一个都不加。
   * 同步完成（一个事务），两批同时来争最后一个名额只有一批成功。同一批重发（clientId 相同）返回原来那几项。
   */
  reserve(botId: string, conversationId: string, req: { segment: string; batch: string; items: Array<{ clientId: string; name: string; mime: string; size: number }> }): Attachment[] {
    this.throttle(botId);
    if (!validClientId(req.batch) || !Array.isArray(req.items) || !req.items.length || req.items.length > LIMITS.maxItems || !req.items.every((i) => i && validClientId(i.clientId))) throw new AttachmentError("unreadable", 400);
    if (new Set(req.items.map((i) => i.clientId)).size !== req.items.length) throw new AttachmentError("unreadable", 400);
    if (req.segment !== this.segmentOf(conversationId)) throw new AttachmentError("changed");
    return this.tx(() => {
      const known = req.items.map((i) => this.store.db.prepare("SELECT * FROM attachments WHERE bot_id = ? AND client_id = ?").get(botId, i.clientId) as Row | undefined);
      if (known.every(Boolean)) return known.map((r) => toAttachment(r!));
      if (known.some(Boolean)) throw new AttachmentError("changed");
      const cur = this.draft(botId, conversationId);
      const items = req.items.map((i) => ({ name: displayName(i.name), mime: String(i.mime ?? ""), size: Math.floor(Number(i.size)) }));
      const checked = checkBatch(items, { items: cur.length, images: cur.filter((a) => a.kind === "image").length, bytes: cur.reduce((n, a) => n + a.bytes, 0) });
      if (!checked.ok) throw new AttachmentError(checked.code);
      const now = this.now();
      let ord = (cur.at(-1)?.order ?? 0) + 1;
      const out: Attachment[] = [];
      items.forEach((f, i) => {
        const id = newId();
        this.store.db
          .prepare("INSERT INTO attachments(id, bot_id, conversation_id, segment, client_id, batch, ord, kind, name, ext, bytes, status, created_at, expires_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)")
          .run(id, botId, conversationId, req.segment, req.items[i].clientId, req.batch, ord++, checked.kinds[i].kind, f.name, checked.kinds[i].ext, f.size, now, now + LIMITS.draftTtlMs);
        out.push(this.get(botId, id)!);
      });
      this.bump(botId, conversationId);
      log.info("attachments reserved", { bot: botId, count: out.length, bytes: items.reduce((n, f) => n + f.size, 0) });
      return out;
    });
  }

  /** 同一个机器人同时在收的上传不超过 4 个 */
  beginUpload(botId: string): () => void {
    const n = this.uploads.get(botId) ?? 0;
    if (n >= 4) throw new AttachmentError("rate", 429);
    this.uploads.set(botId, n + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const left = (this.uploads.get(botId) ?? 1) - 1;
      if (left > 0) this.uploads.set(botId, left);
      else this.uploads.delete(botId);
    };
  }

  private fail(a: Attachment, code: RejectCode): Attachment {
    this.store.db.prepare("UPDATE attachments SET status = 'failed', error = ? WHERE id = ? AND status IN ('reserved', 'rendition')").run(code, a.id);
    this.bump(a.botId, a.conversationId);
    log.warn("attachment rejected", { id: a.id, kind: a.kind, bytes: a.bytes, code });
    return this.get(a.botId, a.id)!;
  }

  /** 上传超限等在路由里就能定的问题：把还在等内容的这一项标成失败 */
  reject(botId: string, id: string, code: RejectCode): Attachment {
    const a = this.get(botId, id);
    if (!a) throw new AttachmentError("not_found", 404);
    if (a.messageId || (a.status !== "reserved" && a.status !== "rendition")) throw new AttachmentError("changed");
    return this.fail(a, code);
  }

  /** 还在等内容的那一项；已移除、已失败、已绑定的不再接收（迟到的结果不让它复活） */
  private waiting(botId: string, id: string, status: AttachmentStatus): Attachment {
    const a = this.get(botId, id);
    if (!a) throw new AttachmentError("not_found", 404);
    if (a.messageId || a.status !== status) throw new AttachmentError("changed");
    if (a.expiresAt <= this.now()) throw new AttachmentError("expired");
    return a;
  }

  /**
   * 收到一项的真实字节（已在路由里按上限读完）。文本在这里解码并就绪；图片核对文件头后等界面交规范化的那一份。
   * 单项的问题只标这一项失败，同批其他项不受影响。
   */
  receive(botId: string, id: string, data: Buffer): Attachment {
    const a = this.waiting(botId, id, "reserved");
    if (!data.length) return this.fail(a, "empty");
    if (data.length > LIMITS.maxFileBytes) return this.fail(a, "size");
    // 实际字节和声明的不一样：按实际的重新核算合计
    const others = this.draft(botId, a.conversationId).filter((x) => x.id !== a.id).reduce((n, x) => n + x.bytes, 0);
    if (others + data.length > LIMITS.maxTotalBytes) return this.fail(a, "size");
    if (a.kind === "image") {
      const info = sniffImage(data);
      if (!info || IMAGE_FORMAT_EXT[info.format].every((e) => e !== a.ext)) return this.fail(a, "format");
      if (info.animated) return this.fail(a, "imageConvert");
      if (Math.max(info.width, info.height) > LIMITS.maxImageEdge || info.width * info.height > LIMITS.maxImagePixels) return this.fail(a, "size");
      const turned = info.orientation >= 5;
      this.store.db.prepare("UPDATE attachments SET status = 'rendition', bytes = ?, orig_width = ?, orig_height = ? WHERE id = ?").run(data.length, turned ? info.height : info.width, turned ? info.width : info.height, a.id);
      this.bump(botId, a.conversationId);
      return this.get(botId, id)!;
    }
    const decoded = decodeText(data);
    if (!decoded.ok) return this.fail(a, decoded.code);
    if (decoded.chars > LIMITS.maxTextChars) return this.fail({ ...a, bytes: data.length }, "content");
    const stored = Buffer.from(decoded.text, "utf8");
    return this.store_(a, stored, { bytes: data.length, mime: "text/plain; charset=utf-8", textChars: decoded.chars });
  }

  /** 图片规范化后的那一份（PNG / JPEG、方向已纠正、不超过 4096）：核对后去掉元信息存下 */
  rendition(botId: string, id: string, data: Buffer): Attachment {
    const a = this.waiting(botId, id, "rendition");
    if (!data.length || data.length > LIMITS.maxFileBytes) return this.fail(a, "size");
    const clean = cleanRendition(data);
    if (!clean) return this.fail(a, "format");
    const want = normalizedSize(a.origWidth, a.origHeight);
    // 不裁剪、不拉伸、不放大：尺寸必须是原图等比缩放的结果（取整差一个像素以内）
    if (Math.abs(clean.width - want.width) > 1 || Math.abs(clean.height - want.height) > 1) return this.fail(a, "format");
    return this.store_(a, clean.data, { bytes: a.bytes, mime: clean.mime, width: clean.width, height: clean.height });
  }

  private store_(a: Attachment, data: Buffer, meta: { bytes: number; mime: string; width?: number; height?: number; textChars?: number }): Attachment {
    const storage = crypto.randomBytes(18).toString("hex");
    const version = crypto.createHash("sha256").update(data).digest("hex").slice(0, 24);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = path.join(this.dir, storage);
    try {
      fs.writeFileSync(file, data, { mode: 0o600, flag: "wx" });
    } catch (e) {
      log.warn("attachment save failed", { id: a.id, code: (e as NodeJS.ErrnoException).code });
      return this.fail(a, "unreadable");
    }
    // 写盘期间被移除了：不留文件，也不复活
    const done = this.store.db
      .prepare("UPDATE attachments SET status = 'ready', bytes = ?, stored_bytes = ?, mime = ?, width = ?, height = ?, text_chars = ?, version = ?, storage = ? WHERE id = ? AND status = ? AND message_id = 0")
      .run(meta.bytes, data.length, meta.mime, meta.width ?? 0, meta.height ?? 0, meta.textChars ?? 0, version, storage, a.id, a.status);
    if (!Number(done.changes)) {
      fs.rmSync(file, { force: true });
      throw new AttachmentError("changed");
    }
    this.bump(a.botId, a.conversationId);
    log.info("attachment ready", { id: a.id, kind: a.kind, bytes: meta.bytes, stored: data.length });
    return this.get(a.botId, a.id)!;
  }

  /** 移除一项待发的附件（幂等）：立刻释放名额，删掉无引用的副本；已随消息发出的不在这里删 */
  remove(botId: string, id: string): void {
    const a = this.get(botId, id);
    if (!a || a.messageId || a.status === "removed") return;
    this.store.db.prepare("UPDATE attachments SET status = 'removed', storage = '' WHERE id = ? AND message_id = 0").run(id);
    if (a.storage) fs.rmSync(path.join(this.dir, a.storage), { force: true });
    this.bump(botId, a.conversationId);
  }

  /** 开始新对话：上一段没发出的附件不带过来 */
  dropDraft(botId: string, conversationId: string): void {
    const rows = this.store.db.prepare("SELECT * FROM attachments WHERE bot_id = ? AND conversation_id = ? AND message_id = 0 AND status != 'removed'").all(botId, conversationId) as Row[];
    for (const r of rows) this.remove(botId, String(r.id));
  }

  /** 读一份就绪副本的字节（预览、交给模型）；不在了返回 undefined */
  read(a: Attachment | undefined): Buffer | undefined {
    if (!a || a.status !== "ready" || !a.storage || !/^[0-9a-f]{36}$/.test(a.storage)) return undefined;
    try {
      return fs.readFileSync(path.join(this.dir, a.storage));
    } catch {
      return undefined;
    }
  }

  // ---------- 发送 ----------

  private sendKey(botId: string, clientMessageId: string): string {
    return `${botId}\n${clientMessageId}`;
  }

  receipt(botId: string, clientMessageId: string): { digest: string; receipt: SendReceipt } | undefined {
    const r = this.store.db.prepare("SELECT * FROM attachment_sends WHERE bot_id = ? AND client_message_id = ?").get(botId, clientMessageId) as Row | undefined;
    return r && { digest: String(r.digest), receipt: { status: "accepted", clientMessageId, messageId: Number(r.message_id), conversationId: String(r.conversation_id), turnId: String(r.turn_id) } };
  }

  /**
   * 断线后查原请求有没有被受理：accepted 带原消息和回合；pending 还在核验；none 确认未受理——
   * 同时记下这个 id，之后才到的原请求不会再被受理（界面可以放心用原发送按钮再发）。
   */
  querySend(botId: string, clientMessageId: string): { status: "accepted"; receipt: SendReceipt } | { status: "pending" | "none" } {
    const done = this.receipt(botId, clientMessageId);
    if (done) return { status: "accepted", receipt: done.receipt };
    const k = this.sendKey(botId, clientMessageId);
    if (this.sends.get(k) === "pending") return { status: "pending" };
    // 记着的 id 有上限：超过就丢最早的（那些请求早就不会再到了）
    if (this.sends.size >= 2000) for (const old of this.sends.keys()) { if (this.sends.get(old) === "rejected") { this.sends.delete(old); break; } }
    this.sends.set(k, "rejected");
    return { status: "none" };
  }

  static digest(req: { text: string; segment: string; attachments: Array<{ id: string; version: string }> }): string {
    return crypto.createHash("sha256").update(JSON.stringify([req.text, req.segment, req.attachments.map((a) => [a.id, a.version])])).digest("hex");
  }

  /**
   * 同一个消息 id 的发送：内容相同返回原回执（不再建第二条消息）；内容变了是冲突；已确认未受理的不再受理。
   * 都不是就登记为正在核验，调用方最后必须 settle()。
   */
  beginSend(botId: string, clientMessageId: string, digest: string): SendReceipt | undefined {
    const done = this.receipt(botId, clientMessageId);
    if (done) {
      if (done.digest !== digest) throw new AttachmentError("conflict");
      return done.receipt;
    }
    const k = this.sendKey(botId, clientMessageId);
    const s = this.sends.get(k);
    if (s === "rejected") throw new AttachmentError("rejected");
    if (s === "pending") throw new AttachmentError("busy");
    this.sends.set(k, "pending");
    return undefined;
  }
  /** 受理后登记这条消息的回合（断线后界面按它接回原回合） */
  setTurn(botId: string, clientMessageId: string, turnId: string): void {
    this.store.db.prepare("UPDATE attachment_sends SET turn_id = ? WHERE bot_id = ? AND client_message_id = ?").run(turnId, botId, clientMessageId);
  }
  settle(botId: string, clientMessageId: string): void {
    const k = this.sendKey(botId, clientMessageId);
    if (this.sends.get(k) === "pending") this.sends.delete(k);
  }

  /**
   * 受理前核对这次发送引用的附件：正好是当前输入里的全部附件、顺序一致、都就绪、内容版本没变、副本还在、配额内。
   * 返回按顺序排好的附件。
   */
  verify(botId: string, conversationId: string, req: { segment: string; revision: string; attachments: Array<{ id: string; version: string }> }): Attachment[] {
    if (req.segment !== this.segmentOf(conversationId) || req.revision !== this.revision(botId, conversationId)) throw new AttachmentError("changed");
    const cur = this.draft(botId, conversationId);
    if (!req.attachments.length || cur.length !== req.attachments.length) throw new AttachmentError("changed");
    const now = this.now();
    cur.forEach((a, i) => {
      const want = req.attachments[i];
      if (a.id !== want.id || a.version !== want.version) throw new AttachmentError("changed");
      if (a.expiresAt <= now || a.status === "expired") throw new AttachmentError("expired");
      if (a.status !== "ready" || !a.storage || !fs.existsSync(path.join(this.dir, a.storage))) throw new AttachmentError(a.status === "ready" ? "expired" : "changed");
    });
    if (cur.length > LIMITS.maxItems || cur.filter((a) => a.kind === "image").length > LIMITS.maxImages) throw new AttachmentError("count");
    if (cur.some((a) => a.bytes > LIMITS.maxFileBytes || a.storedBytes > LIMITS.maxFileBytes) || cur.reduce((n, a) => n + a.bytes, 0) > LIMITS.maxTotalBytes) throw new AttachmentError("size");
    if (cur.reduce((n, a) => n + a.textChars, 0) > LIMITS.maxTextCharsTotal) throw new AttachmentError("content");
    return cur;
  }

  /**
   * 原子绑定：一个事务里存下用户消息、把这些附件绑到它上面（改成 30 天后到期）、记下回执。
   * 绑定前再核一次每一项仍是就绪的待发状态；有一项不对就整个回滚，不会留下没有附件的空壳消息。
   */
  bind(botId: string, conversationId: string, clientMessageId: string, digest: string, text: string, atts: Attachment[], turnId: string): SendReceipt {
    return this.tx(() => {
      const now = this.now();
      const refs: MessageAttachment[] = atts.map((a) => ({ id: a.id, kind: a.kind, name: a.name, size: a.bytes, version: a.version, ...(a.kind === "image" ? { width: a.width, height: a.height } : {}) }));
      const messageId = this.store.addMessage(conversationId, "user", text, undefined, { attachments: refs });
      for (const a of atts) {
        const r = this.store.db
          .prepare("UPDATE attachments SET message_id = ?, expires_at = ? WHERE id = ? AND bot_id = ? AND message_id = 0 AND status = 'ready' AND version = ?")
          .run(messageId, now + LIMITS.sentTtlMs, a.id, botId, a.version);
        if (!Number(r.changes)) throw new AttachmentError("changed");
      }
      this.store.db.prepare("INSERT INTO attachment_sends(bot_id, client_message_id, digest, message_id, conversation_id, turn_id, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)").run(botId, clientMessageId, digest, messageId, conversationId, turnId, now);
      this.bump(botId, conversationId);
      log.info("attachments bound to a message", { bot: botId, messageId, count: atts.length });
      return { status: "accepted" as const, clientMessageId, messageId, conversationId, turnId };
    });
  }

  // ---------- 交给模型 ----------

  /** 估算这条消息占多少 tokens（附件正文 + 图片 + 用户的话）；只是估算 */
  estimate(atts: Attachment[], text: string, withImages: boolean): number {
    let n = estimateTextTokens(text);
    for (const a of atts) {
      if (a.kind === "image") n += withImages ? estimateImageTokens(a.width, a.height) : 16;
      else {
        // 按存下的全文估算，再加标记行
        const data = this.read(a);
        n += (data ? estimateTextTokens(data.toString("utf8")) : a.textChars) + 48;
      }
    }
    return n;
  }

  /**
   * 一条消息的附件写成给模型的文字和图片，按加入顺序：文本文件是带来源标记的完整内容（标记里的记号从附件 id 算出，
   * 文件内容仿造不了），图片在文字里留一行位置、图像本身随消息给。images=false（模型不看图）时只留位置说明。
   * 副本不在了（过期）的写一行说明，不拿文件名冒充内容。
   */
  compose(refs: MessageAttachment[], botId: string, userText: string, opts: { images: boolean; maxImages?: number }): { text: string; images: TurnImage[] } {
    const lines: string[] = [];
    const images: TurnImage[] = [];
    let n = 0;
    for (const ref of refs) {
      n++;
      const a = this.get(botId, ref.id);
      const data = a && a.version === ref.version ? this.read(a) : undefined;
      if (ref.kind === "image") {
        if (data && opts.images && images.length < (opts.maxImages ?? LIMITS.maxImages)) {
          images.push({ data: data.toString("base64"), mimeType: a!.mime === "image/jpeg" ? "image/jpeg" : "image/png" });
          lines.push(t("attachments.promptImage", { n }));
        } else lines.push(t(data ? "attachments.promptImageOmitted" : "attachments.promptExpired", { n, name: t("attachments.promptImageName") }));
        continue;
      }
      if (!data) {
        lines.push(t("attachments.promptExpired", { n, name: ref.name }));
        continue;
      }
      const mark = crypto.createHash("sha256").update(ref.id).digest("hex").slice(0, 10);
      const type = TEXT_TYPES[a!.ext] ?? "text";
      lines.push(`<<<FILE ${n} ${mark} name=${JSON.stringify(ref.name)} type=${type} chars=${a!.textChars}>>>`, data.toString("utf8"), `<<<END FILE ${n} ${mark}>>>`);
    }
    const head = refs.some((r) => r.kind === "text") ? t("attachments.promptIntro") : "";
    return { text: [head, ...lines, userText].filter(Boolean).join("\n"), images };
  }

  // ---------- 回收 ----------

  /** 这个会话当前分段里已发出的图片数（提示「较早图片未随本轮发送」「当前模型不会接收历史图片」用） */
  sentImages(botId: string, conversationId: string): number {
    const r = this.store.db.prepare("SELECT COUNT(*) AS n FROM attachments WHERE bot_id = ? AND conversation_id = ? AND segment = ? AND message_id > 0 AND kind = 'image' AND status = 'ready'").get(botId, conversationId, this.segmentOf(conversationId)) as Row;
    return Number(r?.n ?? 0);
  }

  /**
   * 到期回收：没发出的过了 24 小时、随消息发出的过了 30 天，删掉副本并标成过期（界面提示重新添加）；
   * 上传到一半就没了下文的（10 分钟）标成失败；移除的、过期很久的记录清掉。删副本收不回模型已经收到的内容。
   */
  sweep(): void {
    const now = this.now();
    const db = this.store.db;
    const due = db.prepare("SELECT * FROM attachments WHERE expires_at <= ? AND status NOT IN ('expired', 'removed')").all(now) as Row[];
    for (const r of due) {
      const done = db.prepare("UPDATE attachments SET status = 'expired', storage = '' WHERE id = ? AND expires_at <= ?").run(String(r.id), now);
      if (Number(done.changes) && r.storage) fs.rmSync(path.join(this.dir, String(r.storage)), { force: true });
      if (Number(done.changes)) this.bump(String(r.bot_id), String(r.conversation_id));
    }
    const stale = db.prepare("SELECT * FROM attachments WHERE message_id = 0 AND status IN ('reserved', 'rendition') AND created_at <= ?").all(now - 10 * 60_000) as Row[];
    for (const r of stale) this.fail(toAttachment(r), "unreadable");
    db.prepare("DELETE FROM attachments WHERE message_id = 0 AND status IN ('removed', 'expired', 'failed') AND created_at <= ?").run(now - 2 * LIMITS.draftTtlMs);
    db.prepare("DELETE FROM attachment_sends WHERE created_at <= ?").run(now - LIMITS.sentTtlMs);
    if (due.length) log.info("attachments expired", { count: due.length });
    // 数据库里没有记录的文件（崩溃时写到一半）：超过一天的清掉
    try {
      const known = new Set((db.prepare("SELECT storage FROM attachments WHERE storage != ''").all() as Row[]).map((r) => String(r.storage)));
      for (const f of fs.readdirSync(this.dir)) {
        if (known.has(f)) continue;
        const file = path.join(this.dir, f);
        if (now - fs.statSync(file).mtimeMs > 24 * 3600_000) fs.rmSync(file, { force: true });
      }
    } catch {
      /* 目录还没建 */
    }
  }

  start(): void {
    this.sweep();
    this.timer = setInterval(() => {
      try {
        this.sweep();
      } catch (e) {
        log.warn("attachment sweep failed", { message: (e as Error).message.slice(0, 200) });
      }
    }, 30 * 60_000);
    this.timer.unref?.();
  }
  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 删除机器人、清空对话时：副本和记录一起删 */
  dropBot(botId: string, conversationId?: string): void {
    const rows = (conversationId
      ? this.store.db.prepare("SELECT storage FROM attachments WHERE bot_id = ? AND conversation_id = ?").all(botId, conversationId)
      : this.store.db.prepare("SELECT storage FROM attachments WHERE bot_id = ?").all(botId)) as Row[];
    for (const r of rows) if (r.storage) fs.rmSync(path.join(this.dir, String(r.storage)), { force: true });
    if (conversationId) {
      this.store.db.prepare("DELETE FROM attachments WHERE bot_id = ? AND conversation_id = ?").run(botId, conversationId);
      this.store.db.prepare("DELETE FROM attachment_sends WHERE bot_id = ? AND conversation_id = ?").run(botId, conversationId);
    } else {
      this.store.db.prepare("DELETE FROM attachments WHERE bot_id = ?").run(botId);
      this.store.db.prepare("DELETE FROM attachment_sends WHERE bot_id = ?").run(botId);
    }
  }
}

const IMAGE_FORMAT_EXT: Record<string, string[]> = { png: ["png"], jpeg: ["jpg", "jpeg"], webp: ["webp"], gif: ["gif"] };

function toAttachment(r: Row): Attachment {
  return {
    id: String(r.id), botId: String(r.bot_id), conversationId: String(r.conversation_id), segment: String(r.segment),
    clientId: String(r.client_id), batch: String(r.batch), order: Number(r.ord), kind: String(r.kind) as AttachmentKind, name: String(r.name), ext: String(r.ext),
    bytes: Number(r.bytes), storedBytes: Number(r.stored_bytes), mime: String(r.mime), width: Number(r.width), height: Number(r.height),
    origWidth: Number(r.orig_width), origHeight: Number(r.orig_height), textChars: Number(r.text_chars),
    status: String(r.status) as AttachmentStatus, error: String(r.error), version: String(r.version), storage: String(r.storage),
    messageId: Number(r.message_id), createdAt: Number(r.created_at), expiresAt: Number(r.expires_at),
  };
}

/**
 * 给界面的一项：不可猜的 id、类型、原始 / 存下的字节、状态、内容版本、到期时间、图片的内部尺寸、文本的字数。
 * 不带存储名和任何路径；图片的原名只留在后台，不给界面显示。
 */
export function publicAttachment(a: Attachment) {
  return {
    id: a.id, clientId: a.clientId, batch: a.batch, order: a.order, kind: a.kind,
    name: a.kind === "image" ? "" : a.name,
    size: a.bytes, storedBytes: a.storedBytes, status: a.status, error: a.error, version: a.version, expiresAt: a.expiresAt,
    ...(a.kind === "image" ? { width: a.width, height: a.height, origWidth: a.origWidth, origHeight: a.origHeight, want: a.origWidth ? normalizedSize(a.origWidth, a.origHeight) : undefined } : { textChars: a.textChars }),
  };
}
