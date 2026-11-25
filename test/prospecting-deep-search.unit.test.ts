import { afterEach, describe, expect, it, vi } from "vitest";
import { prospectWebCompanies } from "../src/agency/prospecting.js";
import type { ModelClient } from "../src/llm/client.js";
import type { QualificationProfile } from "../src/agency/types.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const PUBLIC_DNS = async (hostname: string) => {
  if (hostname === "private-node.test") return [{ address: "127.0.0.1" }];
  return [{ address: "93.184.216.34" }];
};

describe("LLM Deep Search Web Prospecting", () => {
  it("plans multi-angle queries, filters noise domains, inspects live HTML, and scores opportunities with LLM reasoning", async () => {
    const queriesSeen: string[] = [];
    let llmCall = 0;

    const mockModelClient = {
      async listModels() {
        return ["GLM-5.3"];
      },
      async streamChat(req: any) {
        llmCall += 1;
        if (llmCall === 1) {
          expect(req.messages[1].content).toContain("clinique dentaire");
          return `<think>Let me analyze the market in Dakar first.</think>
\`\`\`json
{
  "planSummary": "Recherche multi-angles ciblant les cliniques dentaires et centres médicaux disposant d'un site propre à Dakar.",
  "queries": [
    "clinique dentaire Dakar site officiel",
    "cabinet dentaire Plateau Dakar contact"
  ],
  "excludeHints": ["annuaire", "facebook"]
}
\`\`\``;
        }
        const userPayload = req.messages[1].content;
        expect(userPayload).toContain("sourire-dakar.example");
        expect(userPayload).toContain("contact@sourire-dakar.example");
        expect(userPayload).not.toContain("facebook.com");

        return `<think>Evaluating inspected websites cleanly.</think>
{
  "strategySummary": "Priorité aux cliniques sans optimisation mobile ni prise de rendez-vous en ligne.",
  "candidates": [
    {
      "domain": "sourire-dakar.example",
      "keep": true,
      "name": "Clinique Sourire Dakar",
      "industry": "Santé dentaire",
      "city": "Dakar",
      "fitScore": 91,
      "relevance": "high",
      "summary": "Clinique dentaire active au Plateau proposant implantologie et orthodontie.",
      "opportunity": "Site sans balise viewport mobile ni prise de rendez-vous en ligne — refonte mobile-first recommandée.",
      "recommendedAngle": "Proposer un audit gratuit de conversion mobile et un module de prise de RDV WhatsApp.",
      "signals": ["Contact email public", "Non responsive mobile", "HTTP 200"]
    },
    {
      "domain": "blog-sante.example",
      "keep": false,
      "name": "Blog Santé",
      "fitScore": 15,
      "relevance": "low",
      "summary": "Article générique",
      "opportunity": "",
      "recommendedAngle": "",
      "signals": ["Hors cible"]
    }
  ]
}`;
      },
    } as unknown as ModelClient;

    const mockSearch = {
      async search(q: string) {
        queriesSeen.push(q);
        if (q.includes("site officiel")) {
          return {
            backend: "exa-mcp",
            sources: [
              { title: "Clinique Sourire Dakar - Facebook", url: "https://www.facebook.com/cliniquesouriredakar", snippet: "Page sociale" },
              { title: "Clinique Sourire Dakar | Implants", url: "https://www.sourire-dakar.example/accueil", snippet: "Soins dentaires à Dakar Plateau" },
            ],
          };
        }
        return {
          backend: "exa-mcp",
          sources: [
            { title: "Top 10 dentistes - Blog Santé", url: "https://blog-sante.example/top-10", snippet: "Article comparatif" },
            { title: "Clinique Sourire Dakar - Contact", url: "https://sourire-dakar.example/contact", snippet: "Prendre rendez-vous" },
          ],
        };
      },
    };

    const mockFetch = (async (targetUrl: string) => {
      if (targetUrl.includes("sourire-dakar.example")) {
        return new Response(
          `<!doctype html><html><head><title>Clinique Sourire Dakar</title><meta name="description" content="Soins dentaires et implantologie au Plateau Dakar"></head><body><h1>Clinique Sourire Dakar</h1><p>Cabinet dentaire moderne à Dakar. Contactez-nous : <a href="mailto:contact@sourire-dakar.example">email</a></p></body></html>`,
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      return new Response("<html><head><title>Blog</title></head><body><p>Liste d'articles</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as typeof fetch;

    const profile: QualificationProfile = {
      organizationId: "org-1",
      targetIndustries: ["santé"],
      targetCountries: ["SN"],
      excludedIndustries: ["crypto"],
      requiredEvidenceDomains: ["company"],
      requireWebsite: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const res = await prospectWebCompanies({
      search: mockSearch,
      query: "clinique dentaire",
      city: "Dakar",
      mode: "deep",
      modelClient: mockModelClient,
      defaultModel: "GLM-5.3",
      hasLlmEndpoint: true,
      qualificationProfile: profile,
      agentInstructions: "Cibler uniquement les établissements médicaux privés.",
      agentRules: ["Ne jamais inventer de contact"],
      fetchImpl: mockFetch,
      lookup: PUBLIC_DNS,
    });

    expect(queriesSeen).toEqual([
      "clinique dentaire Dakar site officiel",
      "cabinet dentaire Plateau Dakar contact",
    ]);
    expect(res.backend).toBe("exa-mcp");
    expect(res.research.mode).toBe("deep_llm");
    expect(res.research.model).toBe("GLM-5.3");
    expect(res.research.filteredOutCount).toBe(1);
    expect(res.research.auditedCount).toBe(2);
    expect(res.research.strategySummary).toContain("Priorité aux cliniques");

    // Non-business blog dropped by LLM (keep=false), leaving Clinique Sourire Dakar
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0]).toMatchObject({
      domain: "sourire-dakar.example",
      name: "Clinique Sourire Dakar",
      industry: "Santé dentaire",
      city: "Dakar",
      fitScore: 91,
      relevance: "high",
    });
    expect(res.candidates[0]?.contacts?.emails).toContain("contact@sourire-dakar.example");
    expect(res.candidates[0]?.audit?.issues).toContain("missing_viewport_meta");
  });

  it("falls back cleanly to deterministic scoring when LLM returns invalid JSON or is offline", async () => {
    const brokenLlm = {
      async listModels() {
        return ["GLM-5.3"];
      },
      async streamChat() {
        return "Je ne peux pas répondre en JSON pour le moment.";
      },
    } as unknown as ModelClient;

    const res = await prospectWebCompanies({
      search: {
        async search() {
          return {
            backend: "duckduckgo",
            sources: [
              { title: "Sahel Immo Dakar", url: "https://sahel-immo.example", snippet: "Agence immobilière à Dakar" },
              { title: "Local Test Node", url: "http://private-node.test", snippet: "Private" },
            ],
          };
        },
      },
      query: "agence immobiliere",
      city: "Dakar",
      mode: "deep",
      modelClient: brokenLlm,
      defaultModel: "GLM-5.3",
      hasLlmEndpoint: true,
      fetchImpl: (async () =>
        new Response("<!doctype html><html><head><title>Sahel Immo</title></head><body>Immo Dakar</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })) as typeof fetch,
      lookup: PUBLIC_DNS,
    });

    expect(res.research.mode).toBe("deep_deterministic");
    expect(res.candidates.length).toBeGreaterThanOrEqual(1);
    expect(res.candidates[0]?.fitScore).toBeTypeOf("number");
    // Private IP SSRF target is skipped gracefully without crashing the whole search
    expect(res.research.auditedCount).toBe(1);
  });
});
