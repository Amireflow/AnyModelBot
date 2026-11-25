import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { renderDeliveryReportHtml } from "./documents.js";
import type { Company, Contract, Organization, Project, ProjectDelivery, ProjectLot, QaCheck } from "./types.js";
import { resolveProjectDirectory } from "./workspace-runner.js";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dosTimeDate(ts: number): { time: number; date: number } {
  const d = new Date(ts);
  const year = Math.max(1980, d.getUTCFullYear());
  const time = ((d.getUTCHours() & 0x1f) << 11) | ((d.getUTCMinutes() & 0x3f) << 5) | ((d.getUTCSeconds() >> 1) & 0x1f);
  const date = (((year - 1980) & 0x7f) << 9) | (((d.getUTCMonth() + 1) & 0x0f) << 5) | (d.getUTCDate() & 0x1f);
  return { time, date };
}

export interface ZipInputEntry {
  name: string;
  data: Buffer;
  mtimeMs?: number;
}

/**
 * Pure Node ZIP archive builder (deflate + CRC32) with zero external binaries.
 */
export function buildZipBuffer(entries: readonly ZipInputEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const cleanName = entry.name.replaceAll("\\", "/").replace(/^\/+/, "");
    const nameBuf = Buffer.from(cleanName, "utf8");
    const crc = crc32(entry.data);
    const compressed = zlib.deflateRawSync(entry.data);
    const useDeflate = compressed.length < entry.data.length;
    const payload = useDeflate ? compressed : entry.data;
    const method = useDeflate ? 8 : 0;
    const { time, date } = dosTimeDate(entry.mtimeMs ?? Date.now());

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    localParts.push(local, payload);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    centralParts.push(central);
    offset += local.length + payload.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next"]);
const MAX_PACKAGE_FILES = 400;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

export function buildProjectZipArchive(input: {
  dataDir: string;
  organization: Organization;
  company?: Company;
  project: Project;
  contract?: Contract;
  lots: readonly ProjectLot[];
  qaChecks: readonly QaCheck[];
  deliveries: readonly ProjectDelivery[];
  lang?: string;
}): { filename: string; buffer: Buffer; fileCount: number } {
  const { workspaceDir } = resolveProjectDirectory(input.dataDir, input.project);
  const entries: ZipInputEntry[] = [];
  let totalBytes = 0;

  if (fs.existsSync(workspaceDir)) {
    const walk = (dir: string, relBase: string) => {
      if (entries.length >= MAX_PACKAGE_FILES || totalBytes >= MAX_TOTAL_BYTES) return;
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entries.length >= MAX_PACKAGE_FILES || totalBytes >= MAX_TOTAL_BYTES) break;
        if (item.isSymbolicLink()) continue;
        if (item.isDirectory()) {
          if (!SKIP_DIRS.has(item.name)) {
            walk(path.join(dir, item.name), relBase ? `${relBase}/${item.name}` : item.name);
          }
          continue;
        }
        if (!item.isFile()) continue;
        const abs = path.join(dir, item.name);
        const stat = fs.statSync(abs);
        if (stat.size > 5 * 1024 * 1024 || totalBytes + stat.size > MAX_TOTAL_BYTES) continue;
        const rel = relBase ? `${relBase}/${item.name}` : item.name;
        entries.push({ name: rel, data: fs.readFileSync(abs), mtimeMs: stat.mtimeMs });
        totalBytes += stat.size;
      }
    };
    walk(workspaceDir, "");
  }

  const reportHtml = renderDeliveryReportHtml({
    organization: input.organization,
    company: input.company,
    project: input.project,
    contract: input.contract,
    lots: input.lots,
    qaChecks: input.qaChecks,
    deliveries: input.deliveries,
    lang: input.lang,
  });
  entries.push({
    name: "DELIVERY_REPORT.html",
    data: Buffer.from(reportHtml, "utf8"),
    mtimeMs: Date.now(),
  });

  const safeSlug = input.project.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || input.project.id;
  return {
    filename: `${safeSlug}-delivery.zip`,
    buffer: buildZipBuffer(entries),
    fileCount: entries.length,
  };
}
