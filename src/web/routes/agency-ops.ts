import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgencyService } from "../../agency/service.js";
import { detectDeployAdapters } from "../../agency/deployer.js";
import {
  deleteCustomIdeProfile,
  detectInstalledIdes,
  upsertCustomIdeProfile,
} from "../../agency/ide-bridge.js";
import {
  createAgencyBackup,
  exportCompaniesCsv,
  exportLeadsCsv,
  getLlmUsageSummary,
  listAgencyBackups,
} from "../../agency/ops-tools.js";
import { browseMachineDirectories } from "../../agency/project-tracker.js";
import {
  detectLocalWhatsAppDesktop,
  normalizeWhatsAppPhone,
  openWhatsAppDesktop,
} from "../../agency/whatsapp-desktop.js";
import { resolveProjectDirectory } from "../../agency/workspace-runner.js";
import { HttpError, readJson, send, type WebContext } from "../http.js";

function decodeSeg(value: string | undefined, field: string): string {
  try {
    const decoded = decodeURIComponent(value ?? "");
    if (!decoded || decoded.length > 160) throw new Error("invalid");
    return decoded;
  } catch {
    throw new HttpError(400, `Invalid ${field}`);
  }
}

async function readObj(req: IncomingMessage, maxBytes = 1_000_000): Promise<Record<string, unknown>> {
  const body = await readJson(req, maxBytes);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "JSON body must be an object");
  }
  return body as Record<string, unknown>;
}

/**
 * Modularized Agency sub-router covering desktop channel bridges (WhatsApp Desktop),
 * machine explorer & IDE profiles, deploy adapters, backups, CSV exports, and LLM usage ledger.
 */
export async function handleAgencyOpsRoutes(params: {
  ctx: WebContext;
  service: AgencyService;
  actor: string;
  organizationId: string;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  seg: string[];
  method: string;
}): Promise<boolean> {
  const { ctx, service, actor, organizationId, req, res, url, seg, method } = params;

  if (seg[2] === "whatsapp" && seg[3] === "desktop") {
    if (seg.length === 5 && seg[4] === "status" && method === "GET") {
      service.getOrganization(organizationId, actor);
      const refresh = url.searchParams.get("refresh") === "1";
      send(res, 200, { status: detectLocalWhatsAppDesktop(refresh) });
      return true;
    }
    if (seg.length === 5 && seg[4] === "open" && method === "POST") {
      const org = service.getOrganization(organizationId, actor);
      const body = await readObj(req);
      const contactId = typeof body.contactId === "string" ? body.contactId.trim() : "";
      const contact = contactId ? service.getContact(organizationId, actor, contactId) : undefined;
      const rawPhone =
        typeof body.phone === "string" && body.phone.trim() ? body.phone.trim() : (contact?.phone || "");
      if (!rawPhone) throw new HttpError(400, "A valid phone number or contact with a phone number is required");
      const normalized = normalizeWhatsAppPhone(rawPhone, org.countryCode);
      const messageText = typeof body.text === "string" ? body.text : "";
      const purpose = typeof body.purpose === "string" ? body.purpose : "marketing";
      const conversationId = typeof body.conversationId === "string" ? body.conversationId.trim() : "";
      const recorded = service.recordWhatsAppDesktopOpen(organizationId, actor, {
        contactId: contact?.id,
        recipientE164: normalized.e164,
        purpose,
        conversationId: conversationId || undefined,
        messageText,
        recordMessage: body.recordMessage !== false,
      });
      const launched = openWhatsAppDesktop({
        phone: normalized.e164,
        text: messageText,
        defaultCountryCode: org.countryCode,
        dryRun: body.dryRun === true,
      });
      send(res, 200, {
        ...launched,
        ...(recorded.recordedMessage ? { message: recorded.recordedMessage } : {}),
      });
      return true;
    }
  }

  if (seg[2] === "machine" && seg.length === 4 && seg[3] === "browse" && method === "GET") {
    service.getOrganization(organizationId, actor);
    const dir = url.searchParams.get("path") ?? undefined;
    send(res, 200, browseMachineDirectories(dir));
    return true;
  }

  if (seg[2] === "ide") {
    service.getOrganization(organizationId, actor);
    const dataDir = ctx.app?.config?.dataDir ?? process.cwd();
    if (seg.length === 4 && seg[3] === "tools" && method === "GET") {
      const refresh = url.searchParams.get("refresh") === "1";
      send(res, 200, { items: detectInstalledIdes(dataDir, refresh) });
      return true;
    }
    if (seg.length === 4 && seg[3] === "profiles" && method === "POST") {
      const body = await readObj(req);
      const profile = upsertCustomIdeProfile(dataDir, {
        id: typeof body.id === "string" ? body.id : undefined,
        name: String(body.name ?? ""),
        category: body.category === "cli_agent" ? "cli_agent" : "ide",
        executable: String(body.executable ?? ""),
        openDirArgs: Array.isArray(body.openDirArgs) ? body.openDirArgs.map(String) : undefined,
        openFileArgs: Array.isArray(body.openFileArgs) ? body.openFileArgs.map(String) : undefined,
        promptArgs: Array.isArray(body.promptArgs) ? body.promptArgs.map(String) : undefined,
      });
      send(res, 201, { profile, items: detectInstalledIdes(dataDir, true) });
      return true;
    }
    if (seg.length === 5 && seg[3] === "profiles" && method === "DELETE") {
      const id = decodeSeg(seg[4], "ide profile id");
      const result = deleteCustomIdeProfile(dataDir, id);
      send(res, 200, { ...result, items: detectInstalledIdes(dataDir, true) });
      return true;
    }
  }

  if (seg[2] === "deploy" && seg.length === 4 && seg[3] === "adapters" && method === "GET") {
    service.getOrganization(organizationId, actor);
    const dataDir = ctx.app?.config?.dataDir ?? process.cwd();
    const pid = url.searchParams.get("projectId") ?? "";
    const projectDir = pid
      ? resolveProjectDirectory(dataDir, service.getProject(organizationId, actor, pid)).workspaceDir
      : undefined;
    send(res, 200, { items: detectDeployAdapters(projectDir) });
    return true;
  }

  if (seg[2] === "ops") {
    service.getOrganization(organizationId, actor);
    const dataDir = ctx.app?.config?.dataDir ?? process.cwd();
    if (seg.length === 4 && seg[3] === "backups") {
      if (method === "GET") {
        send(res, 200, { items: listAgencyBackups(dataDir) });
        return true;
      }
      if (method === "POST") {
        send(res, 201, { backup: createAgencyBackup(dataDir), items: listAgencyBackups(dataDir) });
        return true;
      }
    }
    if (seg.length === 4 && seg[3] === "llm-usage" && method === "GET") {
      send(res, 200, { summary: getLlmUsageSummary(dataDir, organizationId) });
      return true;
    }
    if (seg.length === 5 && seg[3] === "export" && method === "GET") {
      const collectPaged = <T>(fetchPage: (offset: number) => { items: T[]; total: number }) => {
        const all: T[] = [];
        for (let offset = 0; offset < 500; offset += 100) {
          const p = fetchPage(offset);
          all.push(...p.items);
          if (p.items.length < 100 || all.length >= p.total) break;
        }
        return all;
      };
      if (seg[4] === "companies.csv") {
        const companies = collectPaged((offset) => service.searchCompanies(organizationId, actor, { limit: 100, offset }));
        const csv = exportCompaniesCsv(companies);
        res.writeHead(200, {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": 'attachment; filename="companies.csv"',
          "cache-control": "no-store",
        });
        res.end(csv);
        return true;
      }
      if (seg[4] === "leads.csv") {
        const companies = collectPaged((offset) => service.searchCompanies(organizationId, actor, { limit: 100, offset }));
        const leads = collectPaged((offset) => service.searchLeads(organizationId, actor, { limit: 100, offset }));
        const csv = exportLeadsCsv(leads, companies);
        res.writeHead(200, {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": 'attachment; filename="leads.csv"',
          "cache-control": "no-store",
        });
        res.end(csv);
        return true;
      }
    }
  }

  if (seg[2] === "execution-node" && seg.length === 3 && method === "GET") {
    service.getOrganization(organizationId, actor);
    send(res, 200, { status: ctx.app?.executionNode?.status?.() ?? null });
    return true;
  }

  return false;
}
