import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { AgencyService } from "../../agency/service.js";
import { verifyMetaWebhookSignature } from "../../agency/whatsapp-cloud.js";

export const WHATSAPP_META_WEBHOOK_PATH = "/webhooks/whatsapp/meta";

export interface WhatsAppMetaWebhookConfig {
  organizationId?: string;
  phoneNumberId?: string;
  appSecret?: string;
  verifyToken?: string;
}

function equalSecret(candidate: string, expected: string): boolean {
  const a=Buffer.from(candidate,"utf8");
  const b=Buffer.from(expected,"utf8");
  return a.length===b.length && a.length>0 && timingSafeEqual(a,b);
}

function textResponse(res: ServerResponse,status: number,body: string): void {
  res.writeHead(status,{
    "content-type":"text/plain; charset=utf-8",
    "cache-control":"no-store",
    "x-content-type-options":"nosniff",
  });
  res.end(body);
}

async function readRawBody(req: IncomingMessage, maximumBytes=4_000_000): Promise<Buffer> {
  const chunks: Buffer[]=[];
  let total=0;
  for await (const chunk of req) {
    const bytes=Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total+=bytes.length;
    if (total>maximumBytes) throw new Error("WEBHOOK_BODY_TOO_LARGE");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks,total);
}

/**
 * Public Meta callback. The endpoint intentionally bypasses the desktop UI cookie token:
 * GET is gated by the independently configured verify token and POST by Meta's HMAC signature.
 */
export async function handleWhatsAppMetaWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  config: WhatsAppMetaWebhookConfig,
  service: AgencyService,
): Promise<boolean> {
  if (url.pathname!==WHATSAPP_META_WEBHOOK_PATH) return false;
  const organizationId=config.organizationId?.trim() ?? "";
  const phoneNumberId=config.phoneNumberId?.trim() ?? "";
  const appSecret=config.appSecret?.trim() ?? "";
  const verifyToken=config.verifyToken ?? "";
  if (!organizationId || !/^\d{5,30}$/.test(phoneNumberId) || !appSecret || !verifyToken) {
    textResponse(res,503,"Webhook is not configured");
    return true;
  }

  if (req.method==="GET") {
    const mode=url.searchParams.get("hub.mode") ?? url.searchParams.get("hub_mode") ?? "";
    const candidate=url.searchParams.get("hub.verify_token") ?? url.searchParams.get("hub_verify_token") ?? "";
    const challenge=url.searchParams.get("hub.challenge") ?? url.searchParams.get("hub_challenge") ?? "";
    if (mode!=="subscribe" || !challenge || challenge.length>256 || !equalSecret(candidate,verifyToken)) {
      textResponse(res,403,"Verification failed");
      return true;
    }
    textResponse(res,200,challenge);
    return true;
  }

  if (req.method!=="POST") {
    res.writeHead(405,{"allow":"GET, POST","cache-control":"no-store"}).end();
    return true;
  }
  if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] ?? ""))) {
    textResponse(res,415,"Expected application/json");
    return true;
  }

  let rawBody: Buffer;
  try { rawBody=await readRawBody(req); }
  catch (error) {
    textResponse(res,(error as Error).message==="WEBHOOK_BODY_TOO_LARGE"?413:400,"Invalid webhook body");
    return true;
  }
  const signature=String(req.headers["x-hub-signature-256"] ?? "");
  if (!verifyMetaWebhookSignature(rawBody,signature,appSecret)) {
    textResponse(res,401,"Invalid webhook signature");
    return true;
  }

  let payload: unknown;
  try { payload=JSON.parse(rawBody.toString("utf8")); }
  catch {
    textResponse(res,400,"Malformed webhook JSON");
    return true;
  }

  try {
    const result=service.processWhatsAppWebhook(organizationId,phoneNumberId,payload);
    res.writeHead(200,{
      "content-type":"application/json; charset=utf-8",
      "cache-control":"no-store",
      "x-content-type-options":"nosniff",
    });
    res.end(JSON.stringify({success:true,...result}));
  } catch {
    // Do not acknowledge malformed, mismatched or unprocessed events: Meta may retry them.
    textResponse(res,400,"Webhook processing failed");
  }
  return true;
}
