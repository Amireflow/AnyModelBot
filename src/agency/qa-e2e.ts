import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgencyError } from "./errors.js";
import type { Project } from "./types.js";
import { resolveProjectDirectory } from "./workspace-runner.js";

export interface HeadlessBrowserInfo {
  available: boolean;
  name: string;
  executablePath: string;
}

export interface VisualE2eQaItem {
  category: "functional" | "ui_ux";
  title: string;
  status: "passed" | "failed";
  evidence: string;
  findings: string;
}

export interface VisualE2eQaResult {
  passed: boolean;
  url: string;
  browser: HeadlessBrowserInfo;
  httpStatus: number;
  responseTimeMs: number;
  title: string;
  hasViewportMeta: boolean;
  renderedTextLength: number;
  issues: string[];
  screenshots: { desktop?: string; mobile?: string };
  reportPath: string;
  summary: string;
  qaItems: VisualE2eQaItem[];
}

const RUNTIME_ERROR_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: "Unhandled Runtime Error", regex: /Unhandled Runtime Error/i },
  { label: "TypeError in DOM", regex: /Cannot read propert(?:y|ies) of (?:undefined|null)/i },
  { label: "ReferenceError in DOM", regex: /\bReferenceError:\s+[A-Za-z_$]/ },
  { label: "SyntaxError in DOM", regex: /\bSyntaxError:\s+/ },
  { label: "Bundler compilation error", regex: /\bFailed to compile\b/i },
];

export function detectHeadlessBrowser(): HeadlessBrowserInfo {
  const candidates: Array<{ name: string; paths: string[] }> =
    process.platform === "win32"
      ? [
          {
            name: "Google Chrome",
            paths: [
              "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
              "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
              path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
            ],
          },
          {
            name: "Microsoft Edge",
            paths: [
              "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
              "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
            ],
          },
        ]
      : process.platform === "darwin"
        ? [
            { name: "Google Chrome", paths: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"] },
            { name: "Microsoft Edge", paths: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"] },
          ]
        : [
            {
              name: "Chromium / Chrome",
              paths: ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"],
            },
          ];

  for (const cand of candidates) {
    for (const p of cand.paths) {
      if (p && fs.existsSync(p)) {
        return { available: true, name: cand.name, executablePath: p };
      }
    }
  }
  return { available: false, name: "Unavailable", executablePath: "" };
}

function runBrowserCmd(
  executablePath: string,
  args: string[],
  timeoutMs = 18_000,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    try {
      execFile(
        executablePath,
        args,
        { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, shell: false, windowsHide: true, encoding: "utf8" },
        (err, stdout, stderr) => {
          if (!err) {
            resolve({ exitCode: 0, stdout: stdout ?? "", stderr: stderr ?? "" });
            return;
          }
          const code = typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1;
          resolve({ exitCode: code, stdout: stdout ?? "", stderr: stderr || err.message || "browser failed" });
        },
      );
    } catch (error) {
      resolve({ exitCode: 1, stdout: "", stderr: (error as Error).message || "browser spawn failed" });
    }
  });
}

function stripTagsToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function runVisualE2eQa(input: {
  dataDir: string;
  project: Project;
  url: string;
  fetchImpl?: typeof fetch;
  skipBrowser?: boolean;
}): Promise<VisualE2eQaResult> {
  const rawUrl = String(input.url ?? "").trim();
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new AgencyError("VALIDATION_ERROR", "A valid http:// or https:// URL is required for E2E QA");
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new AgencyError("VALIDATION_ERROR", "E2E QA URL must use http or https");
  }

  const { workspaceDir, mode } = resolveProjectDirectory(input.dataDir, input.project);
  fs.mkdirSync(workspaceDir, { recursive: true });
  const ts = Date.now();
  const relDir = mode === "linked" ? `.anymodelbot/qa/e2e-${ts}` : `qa/e2e-${ts}`;
  const outDir = path.join(workspaceDir, relDir);
  fs.mkdirSync(outDir, { recursive: true });

  const fetchFn = input.fetchImpl ?? fetch;
  const startedAt = Date.now();
  let httpStatus = 0;
  let html = "";
  const issues: string[] = [];

  try {
    const res = await fetchFn(parsedUrl.toString(), {
      method: "GET",
      signal: AbortSignal.timeout(8_000),
      headers: { "user-agent": "AnyModelBot-E2E-QA/1.0" },
    });
    httpStatus = res.status;
    html = (await res.text()).slice(0, 512 * 1024);
  } catch (error) {
    issues.push(`HTTP probe failed: ${(error as Error).message || "unreachable"}`);
  }
  const responseTimeMs = Math.max(1, Date.now() - startedAt);
  if (httpStatus >= 400 || httpStatus === 0) {
    issues.push(`HTTP status ${httpStatus || 0}`);
  }

  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim().slice(0, 200) : "";
  const hasViewportMeta = /<meta\b[^>]*name=["']viewport["']/i.test(html);
  if (!hasViewportMeta && html) {
    issues.push("Missing responsive <meta name=\"viewport\"> tag");
  }

  const browser = detectHeadlessBrowser();
  const screenshots: { desktop?: string; mobile?: string } = {};
  let renderedTextLength = stripTagsToText(html).length;

  if (!input.skipBrowser && browser.available && httpStatus > 0 && httpStatus < 500) {
    const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), "amb-qa-chrome-"));
    try {
      const commonFlags = [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--hide-scrollbars",
        `--user-data-dir=${tmpProfile}`,
      ];
      const desktopAbs = path.join(outDir, "desktop.png");
      const mobileAbs = path.join(outDir, "mobile.png");

      const desktopShot = await runBrowserCmd(browser.executablePath, [
        ...commonFlags,
        "--window-size=1440,900",
        "--virtual-time-budget=2500",
        `--screenshot=${desktopAbs}`,
        parsedUrl.toString(),
      ]);
      if (desktopShot.exitCode === 0 && fs.existsSync(desktopAbs)) {
        screenshots.desktop = `${relDir}/desktop.png`.replaceAll("\\", "/");
      }

      const mobileShot = await runBrowserCmd(browser.executablePath, [
        ...commonFlags,
        "--window-size=390,844",
        "--virtual-time-budget=2500",
        `--screenshot=${mobileAbs}`,
        parsedUrl.toString(),
      ]);
      if (mobileShot.exitCode === 0 && fs.existsSync(mobileAbs)) {
        screenshots.mobile = `${relDir}/mobile.png`.replaceAll("\\", "/");
      }

      const domRun = await runBrowserCmd(browser.executablePath, [
        ...commonFlags,
        "--window-size=1440,900",
        "--virtual-time-budget=2500",
        "--dump-dom",
        parsedUrl.toString(),
      ]);
      if (domRun.exitCode === 0 && domRun.stdout) {
        const cleanDom = stripTagsToText(domRun.stdout);
        renderedTextLength = cleanDom.length;
        for (const pat of RUNTIME_ERROR_PATTERNS) {
          if (pat.regex.test(cleanDom)) {
            issues.push(`Runtime error visible in rendered DOM: ${pat.label}`);
          }
        }
        if (cleanDom.length === 0) {
          issues.push("Rendered DOM text is completely empty (blank screen risk)");
        }
      }
    } finally {
      fs.rmSync(tmpProfile, { recursive: true, force: true, maxRetries: 3, retryDelay: 80 });
    }
  }

  const functionalOk = httpStatus >= 200 && httpStatus < 400 && renderedTextLength > 0 && !issues.some((i) => /Runtime error|HTTP/i.test(i));
  const uiOk = functionalOk && (Boolean(screenshots.desktop && screenshots.mobile) || !browser.available || Boolean(input.skipBrowser)) && hasViewportMeta;
  const passed = issues.length === 0 && functionalOk;

  const reportRel = `${relDir}/report.json`.replaceAll("\\", "/");
  const qaItems: VisualE2eQaItem[] = [
    {
      category: "functional",
      title: `QA E2E HTTP & DOM (${parsedUrl.host})`,
      status: functionalOk ? "passed" : "failed",
      evidence: `HTTP ${httpStatus} (${responseTimeMs}ms), DOM=${renderedTextLength} chars, rapport=${reportRel}`,
      findings: issues.filter((i) => !/viewport/i.test(i)).join("; "),
    },
    {
      category: "ui_ux",
      title: `QA E2E Visuel Desktop & Mobile (${parsedUrl.host})`,
      status: uiOk ? "passed" : "failed",
      evidence: [
        hasViewportMeta ? "Viewport mobile OK" : "Viewport mobile absent",
        screenshots.desktop ? `Desktop: ${screenshots.desktop}` : "",
        screenshots.mobile ? `Mobile: ${screenshots.mobile}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
      findings: !hasViewportMeta ? "Missing <meta name=\"viewport\">" : "",
    },
  ];

  const reportPayload = {
    passed,
    url: parsedUrl.toString(),
    browser,
    httpStatus,
    responseTimeMs,
    title,
    hasViewportMeta,
    renderedTextLength,
    issues,
    screenshots,
    checkedAt: ts,
  };
  fs.writeFileSync(path.join(workspaceDir, reportRel), JSON.stringify(reportPayload, null, 2), "utf8");

  const summary = `E2E QA ${passed ? "OK" : "ÉCHEC"} sur ${parsedUrl.toString()} — HTTP ${httpStatus} (${responseTimeMs}ms), ${renderedTextLength} car. rendus${screenshots.desktop ? ", captures Desktop + Mobile générées" : ""}.`;
  return {
    passed,
    url: parsedUrl.toString(),
    browser,
    httpStatus,
    responseTimeMs,
    title,
    hasViewportMeta,
    renderedTextLength,
    issues,
    screenshots,
    reportPath: reportRel,
    summary,
    qaItems,
  };
}
