import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Project } from "../src/agency/types.js";
import {
  globWorkspaceFiles,
  grepWorkspaceFiles,
  patchWorkspaceFile,
  readWorkspaceFile,
  readWorkspaceFileSlice,
  runStudioShellCommand,
  writeWorkspaceFile,
} from "../src/agency/studio.js";

const dirs: string[] = [];

function makeProject(): { dataDir: string; project: Project } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "amb-studio-patch-"));
  dirs.push(dataDir);
  const project: Project = {
    id: "proj-patch",
    organizationId: "org-1",
    leadId: "lead-1",
    contractId: "ctr-1",
    title: "Patch Suite App",
    status: "in_progress",
    targetStack: ["react", "typescript"],
    budgetAmount: 5000,
    currency: "EUR",
    estimatedDays: 5,
    workspacePath: "projects/proj-patch",
    technicalSpecs: "",
    handoffSummary: "",
    handoffAt: Date.now(),
    deliveredAt: null,
    acceptedAt: null,
    createdBy: "operator",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  return { dataDir, project };
}

afterEach(() => {
  while (dirs.length) {
    fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

describe("Studio fuzzy patch & workspace tools", () => {
  it("applies exact, CRLF, indentation-trimmed, and 3-line block-anchor patches cleanly", () => {
    const { dataDir, project } = makeProject();

    writeWorkspaceFile(
      dataDir,
      project,
      "src/app.ts",
      "export function greet(name: string) {\r\n  const label = 'Hello';\r\n  return `${label} ${name}`;\r\n}\r\n",
    );

    // Indentation drift + LF snippet against CRLF file
    const p1 = patchWorkspaceFile(
      dataDir,
      project,
      "src/app.ts",
      "const label = 'Hello';\nreturn `${label} ${name}`;",
      "  const label = 'Bonjour';\n  return `${label}, ${name}!`;",
    );
    expect(p1.replacements).toBe(1);
    const after1 = readWorkspaceFile(dataDir, project, "src/app.ts").content;
    expect(after1).toContain("Bonjour");
    expect(after1).toContain("\r\n");

    // 3+ line block anchor match + outer markdown code fence stripping
    const p2 = patchWorkspaceFile(
      dataDir,
      project,
      "src/app.ts",
      "```ts\nexport function greet(name: string) {\n  // drifted middle line\n}\n```",
      "export function greet(name: string) {\n  return `Salut ${name}`;\n}",
    );
    expect(p2.replacements).toBe(1);
    expect(readWorkspaceFile(dataDir, project, "src/app.ts").content).toContain("Salut");
  });

  it("includes closest line hints when patch fails", () => {
    const { dataDir, project } = makeProject();
    writeWorkspaceFile(dataDir, project, "src/item.ts", "const price = 100;\nconst currency = 'XOF';\n");
    expect(() => patchWorkspaceFile(dataDir, project, "src/item.ts", "const currency = 'USD';\nconst nope = 1;", "x")).toThrow(
      /Closest lines: L2:/,
    );
  });

  it("supports line-numbered read slices, glob_files, grep_files, and governed shell allowlist", async () => {
    const { dataDir, project } = makeProject();
    const manyLines = Array.from({ length: 40 }, (_, i) => `export const v${i + 1} = ${i + 1};`).join("\n");
    writeWorkspaceFile(dataDir, project, "src/utils/math.ts", manyLines);
    writeWorkspaceFile(dataDir, project, "src/components/Card.tsx", "export function Card() { return 'ok'; }\n");

    const slice = readWorkspaceFileSlice(dataDir, project, "src/utils/math.ts", 10, 15);
    expect(slice.startLine).toBe(10);
    expect(slice.endLine).toBe(15);
    expect(slice.totalLines).toBe(40);
    expect(slice.content).toContain("10 | export const v10 = 10;");

    const globbed = globWorkspaceFiles(dataDir, project, "src/**/*.tsx");
    expect(globbed.map((g) => g.path)).toEqual(["src/components/Card.tsx"]);

    const grepped = grepWorkspaceFiles(dataDir, project, "/v(1|2)\\b/", "src/utils");
    expect(grepped.some((h) => h.path === "src/utils/math.ts" && h.line === 1)).toBe(true);

    await expect(
      runStudioShellCommand({ dataDir, project, command: "node -e 'console.log(1)' && rm -rf /" }),
    ).rejects.toThrow(/operators/i);
    await expect(
      runStudioShellCommand({ dataDir, project, command: "powershell -Command whoami" }),
    ).rejects.toThrow(/allowed dev toolchain/i);
    await expect(
      runStudioShellCommand({ dataDir, project, command: "git push origin main" }),
    ).rejects.toThrow(/read-only git/i);
    const nodeOk = await runStudioShellCommand({ dataDir, project, command: "node -v" });
    expect(nodeOk.exitCode).toBe(0);
    expect(nodeOk.output).toMatch(/^v\d+/);
  });
});
