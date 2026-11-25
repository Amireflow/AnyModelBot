import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AgencyError } from "./errors.js";

export interface LocalWhatsAppStatus {
  available: boolean;
  platform: NodeJS.Platform;
  method: "uwp_protocol" | "desktop_exe" | "macos_app" | "linux_desktop" | "web_fallback";
  appName: string;
  installLocation?: string;
  protocolSupported: boolean;
}

const COUNTRY_CALLING_CODES: Record<string, string> = {
  SN: "221",
  FR: "33",
  CI: "225",
  CM: "237",
  MA: "212",
  ML: "223",
  BF: "226",
  BJ: "229",
  TG: "228",
  GN: "224",
  GA: "241",
  CG: "242",
  CD: "243",
  TN: "216",
  DZ: "213",
  US: "1",
  CA: "1",
  BE: "32",
  CH: "41",
  GB: "44",
};

const CACHE_TTL_MS = 30_000;
let cachedStatus: { at: number; value: LocalWhatsAppStatus } | null = null;

export function detectLocalWhatsAppDesktop(forceRefresh = false): LocalWhatsAppStatus {
  const now = Date.now();
  if (!forceRefresh && cachedStatus && now - cachedStatus.at < CACHE_TTL_MS) {
    return cachedStatus.value;
  }

  let result: LocalWhatsAppStatus = {
    available: false,
    platform: process.platform,
    method: "web_fallback",
    appName: "WhatsApp Web (wa.me)",
    protocolSupported: false,
  };

  if (process.platform === "win32") {
    try {
      const out = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "(Get-AppxPackage -Name '*WhatsAppDesktop*' | Select-Object -First 1).InstallLocation",
        ],
        { timeout: 3500, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
      ).trim();
      if (out) {
        result = {
          available: true,
          platform: process.platform,
          method: "uwp_protocol",
          appName: "WhatsApp Desktop",
          installLocation: out,
          protocolSupported: true,
        };
      }
    } catch {
      /* check standalone Windows exe below */
    }

    if (!result.available) {
      const localAppData = process.env.LOCALAPPDATA || "";
      const candidates = [
        localAppData ? path.join(localAppData, "WhatsApp", "WhatsApp.exe") : "",
        localAppData ? path.join(localAppData, "Programs", "WhatsApp", "WhatsApp.exe") : "",
      ].filter(Boolean);
      const foundExe = candidates.find((p) => fs.existsSync(p));
      if (foundExe) {
        result = {
          available: true,
          platform: process.platform,
          method: "desktop_exe",
          appName: "WhatsApp Desktop",
          installLocation: foundExe,
          protocolSupported: true,
        };
      }
    }
  } else if (process.platform === "darwin") {
    const macApp = "/Applications/WhatsApp.app";
    if (fs.existsSync(macApp)) {
      result = {
        available: true,
        platform: process.platform,
        method: "macos_app",
        appName: "WhatsApp Desktop",
        installLocation: macApp,
        protocolSupported: true,
      };
    }
  } else {
    for (const cmd of ["whatsapp-desktop", "whatsapp"]) {
      try {
        const out = execFileSync("which", [cmd], {
          timeout: 1500,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        if (out) {
          result = {
            available: true,
            platform: process.platform,
            method: "linux_desktop",
            appName: "WhatsApp Desktop",
            installLocation: out,
            protocolSupported: true,
          };
          break;
        }
      } catch {
        /* try next binary */
      }
    }
  }

  cachedStatus = { at: now, value: result };
  return result;
}

export function normalizeWhatsAppPhone(rawPhone: string, defaultCountryCode = "SN"): { e164: string; digits: string } {
  const cleaned = String(rawPhone ?? "").replace(/[\s().-]/g, "").trim();
  if (!cleaned) {
    throw new AgencyError("VALIDATION_ERROR", "Invalid WhatsApp phone number");
  }

  let digits = "";
  if (cleaned.startsWith("+")) {
    digits = cleaned.slice(1).replace(/\D/g, "");
  } else if (cleaned.startsWith("00")) {
    digits = cleaned.slice(2).replace(/\D/g, "");
  } else {
    const rawDigits = cleaned.replace(/\D/g, "");
    const cc = COUNTRY_CALLING_CODES[String(defaultCountryCode ?? "SN").trim().toUpperCase()] ?? "221";
    if (rawDigits.startsWith(cc) && rawDigits.length >= cc.length + 7) {
      digits = rawDigits;
    } else {
      const subscriber = rawDigits.startsWith("0") ? rawDigits.slice(1) : rawDigits;
      digits = `${cc}${subscriber}`;
    }
  }

  if (!/^[1-9][0-9]{7,14}$/.test(digits)) {
    throw new AgencyError("VALIDATION_ERROR", "Invalid WhatsApp phone number");
  }

  return { e164: `+${digits}`, digits };
}

export function buildWhatsAppDesktopUri(
  phone: string,
  text?: string,
  defaultCountryCode = "SN",
): { e164: string; digits: string; desktopUri: string; webUrl: string } {
  const { e164, digits } = normalizeWhatsAppPhone(phone, defaultCountryCode);
  const cleanText = String(text ?? "").replace(/\0/g, "").trim().slice(0, 4_000);
  const encodedText = cleanText ? encodeURIComponent(cleanText) : "";
  const desktopUri = encodedText ? `whatsapp://send?phone=${digits}&text=${encodedText}` : `whatsapp://send?phone=${digits}`;
  const webUrl = encodedText ? `https://wa.me/${digits}?text=${encodedText}` : `https://wa.me/${digits}`;
  return { e164, digits, desktopUri, webUrl };
}

export function openWhatsAppDesktop(input: {
  phone: string;
  text?: string;
  defaultCountryCode?: string;
  dryRun?: boolean;
}): {
  opened: boolean;
  dryRun: boolean;
  e164: string;
  digits: string;
  desktopUri: string;
  webUrl: string;
  status: LocalWhatsAppStatus;
} {
  const built = buildWhatsAppDesktopUri(input.phone, input.text, input.defaultCountryCode);
  const status = detectLocalWhatsAppDesktop();
  const targetUri = status.protocolSupported ? built.desktopUri : built.webUrl;

  if (!input.dryRun) {
    if (process.platform === "win32") {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", "Start-Process -FilePath $env:AMB_WA_URI"],
        {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          shell: false,
          env: { ...process.env, AMB_WA_URI: targetUri },
        },
      );
      child.unref();
    } else if (process.platform === "darwin") {
      const child = spawn("open", [targetUri], {
        detached: true,
        stdio: "ignore",
        shell: false,
      });
      child.unref();
    } else {
      const child = spawn("xdg-open", [targetUri], {
        detached: true,
        stdio: "ignore",
        shell: false,
      });
      child.unref();
    }
  }

  return {
    opened: true,
    dryRun: Boolean(input.dryRun),
    e164: built.e164,
    digits: built.digits,
    desktopUri: built.desktopUri,
    webUrl: built.webUrl,
    status,
  };
}
