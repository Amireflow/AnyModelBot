import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readWorkspaceFile, runStudioAiAgent } from "../src/agency/studio.js";
import { parseStudioActions } from "../src/agency/studio-xml.js";
import type { Project } from "../src/agency/types.js";
import type { ModelClient } from "../src/llm/client.js";

const dirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amb-studio-xml-"));
  dirs.push(dir);
  return dir;
}

function makeProject(): Project {
  const now = Date.now();
  return {
    id: "proj-xml-1",
    organizationId: "org-1",
    leadId: "lead-1",
    contractId: "ctr-1",
    title: "Bcommercy Pay",
    status: "in_progress",
    targetStack: ["Vite", "React", "Tailwind"],
    budgetAmount: 1500000,
    currency: "XOF",
    estimatedDays: 10,
    technicalSpecs: "Landing page fintech Bcommercy Pay",
    workspacePath: "proj-xml-1",
    handoffSummary: "Initial",
    handoffAt: now,
    deliveredAt: null,
    acceptedAt: null,
    createdBy: "operator",
    createdAt: now,
    updatedAt: now,
  };
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("Dyad-style Studio XML action parser", () => {
  it("parses multiple XML file writes with quotes, JSX, and CSS braces in one turn", () => {
    const reply = [
      "Je crée les fichiers de l'application :",
      `<studio-write path="src/App.jsx">
import React from "react";
export default function App() {
  return <div className="hero">{"Bcommercy Pay"}</div>;
}
</studio-write>`,
      `<studio-write path="src/index.css">
body { margin: 0; font-family: "Inter", sans-serif; }
</studio-write>`,
      `<studio-patch path="index.html"><search><title>Old</title></search><replace><title>Bcommercy Pay</title></replace></studio-patch>`,
      `<studio-add-dep packages="lucide-react clsx ; rm -rf /" />`,
      `<studio-done>Application créée avec succès.</studio-done>`,
    ].join("\n");

    const parsed = parseStudioActions(reply);
    expect(parsed.format).toBe("xml");
    expect(parsed.actions).toHaveLength(5);
    expect(parsed.actions[0]).toEqual({
      tool: "write_file",
      path: "src/App.jsx",
      content: 'import React from "react";\nexport default function App() {\n  return <div className="hero">{"Bcommercy Pay"}</div>;\n}',
    });
    expect(parsed.actions[2]).toEqual({
      tool: "patch_file",
      path: "index.html",
      search: "<title>Old</title>",
      replace: "<title>Bcommercy Pay</title>",
    });
    expect(parsed.actions[3]).toEqual({
      tool: "add_dependency",
      packages: ["lucide-react", "clsx"],
    });
    expect(parsed.actions[4]).toEqual({
      tool: "finish",
      summary: "Application créée avec succès.",
    });
  });

  it("keeps backward compatibility with legacy single-JSON tool payloads", () => {
    const parsed = parseStudioActions('{"tool":"write_file","path":"app.js","content":"console.log(1);"}');
    expect(parsed.format).toBe("json");
    expect(parsed.actions).toEqual([{ tool: "write_file", path: "app.js", content: "console.log(1);" }]);
  });

  it("executes multi-file XML turns in runStudioAiAgent with zero parse_error steps", async () => {
    const dir = makeTempDir();
    const project = makeProject();

    const mockClient: ModelClient = {
      listModels: async () => ["test-model"],
      streamChat: async () => [
        `<studio-write path="index.html">
<!doctype html><html><body><h1 data-app="ok">Bcommercy Pay</h1></body></html>
</studio-write>`,
        `<studio-write path="styles.css">
body { background: #0f172a; color: #f8fafc; }
</studio-write>`,
        `<studio-done>Interface générée sans erreur.</studio-done>`,
      ].join("\n"),
    };

    const res = await runStudioAiAgent({
      dataDir: dir,
      project,
      instruction: "Crée la landing page",
      modelClient: mockClient,
      defaultModel: "test-model",
      hasLlmEndpoint: true,
    });

    expect(res.steps.some((s) => s.tool === "parse_error")).toBe(false);
    expect(res.modifiedFiles).toEqual(["index.html", "styles.css"]);
    expect(res.summary).toBe("Interface générée sans erreur.");
    expect(readWorkspaceFile(dir, project, "index.html").content).toContain("Bcommercy Pay");
    expect(readWorkspaceFile(dir, project, "styles.css").content).toContain("#0f172a");
  });

  it("handles prose-only final responses without parse_error loops", async () => {
    const dir = makeTempDir();
    const project = makeProject();

    let call = 0;
    const replies = [
      `<studio-write path="notes.txt">ok</studio-write>`,
      `Tout est bien en place dans notes.txt, prêt pour l'aperçu.`,
    ];
    const mockClient: ModelClient = {
      listModels: async () => ["test-model"],
      streamChat: async () => replies[call++] ?? "Terminé.",
    };

    const res = await runStudioAiAgent({
      dataDir: dir,
      project,
      instruction: "Crée notes.txt",
      modelClient: mockClient,
      defaultModel: "test-model",
      hasLlmEndpoint: true,
    });

    expect(res.steps.some((s) => s.tool === "parse_error")).toBe(false);
    expect(res.modifiedFiles).toEqual(["notes.txt"]);
    expect(res.summary).toContain("notes.txt");
  });
});
