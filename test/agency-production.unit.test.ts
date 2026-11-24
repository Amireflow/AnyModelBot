import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgencyError, AgencyService, AgencyStore, evaluateQaGate } from "../src/agency/index.js";

describe("Agency Production, QA Gate, Delivery, Retention, and Orchestrator (Lot B)", () => {
  let store: AgencyStore;
  let service: AgencyService;
  let clock: number;
  let seq: number;
  let orgId: string;
  let signedPaidContractId: string;
  let unsignedContractId: string;
  let unpaidContractId: string;
  let leadId: string;

  beforeEach(() => {
    clock = 1_800_000_000_000;
    seq = 0;
    store = new AgencyStore(":memory:");
    service = new AgencyService(store, { now: () => clock, id: () => `prod-${++seq}` });

    orgId = service.createOrganization({ name: "Amireflow Agency", currency: "EUR" }, "owner-1").id;
    service.addMember(orgId, "owner-1", "dev-1", "member");
    const company = service.createCompany(orgId, "owner-1", { name: "Atelier Horizon", countryCode: "SN" });
    const contact = service.createContact(orgId, "owner-1", { companyId: company.id, displayName: "Awa", email: "awa@horizon.example" });
    leadId = service.createLead(orgId, "owner-1", { companyId: company.id, contactId: contact.id }).id;

    service.upsertNeedsQualification(orgId, "dev-1", leadId, {
      problemStatement: "Need a B2B client portal with billing",
      solutionType: "web_app",
      mustHaveFeatures: ["Dashboard", "Invoices"],
      clientConfirmed: true,
    });

    const createAcceptedQuote = (title: string) => {
      const { quote } = service.createQuote(orgId, "dev-1", {
        leadId,
        title,
        lines: [{ label: title, quantity: 1, unitPrice: 3000, unitCost: 1400, estimatedDays: 12 }],
      });
      const req = service.requestQuoteApproval(orgId, "dev-1", quote.id, "Send quote");
      service.decideApproval(orgId, "owner-1", req.approval.id, "approved", req.approval.payloadHash, "Margin verified");
      service.sendQuote(orgId, "dev-1", quote.id);
      service.recordQuoteDecision(orgId, "dev-1", quote.id, "accepted");
      return quote.id;
    };

    const q1 = createAcceptedQuote("Portail Client B2B");
    const c1 = service.createContractFromQuote(orgId, "dev-1", { quoteId: q1, depositAmount: 900 });
    const c1App = service.requestContractApproval(orgId, "dev-1", c1.id, "Approve contract signature");
    service.decideApproval(orgId, "owner-1", c1App.approval.id, "approved", c1App.approval.payloadHash, "Approved");
    service.markContractSigned(orgId, "owner-1", c1.id);
    service.recordContractDeposit(orgId, "owner-1", c1.id, "paid", "VIR-2026-001");
    signedPaidContractId = c1.id;

    const q2 = createAcceptedQuote("Unsigned Contract Quote");
    unsignedContractId = service.createContractFromQuote(orgId, "dev-1", { quoteId: q2, depositAmount: 500 }).id;

    const q3 = createAcceptedQuote("Unpaid Deposit Quote");
    const c3 = service.createContractFromQuote(orgId, "dev-1", { quoteId: q3, depositAmount: 500 });
    const c3App = service.requestContractApproval(orgId, "dev-1", c3.id, "Sign without deposit");
    service.decideApproval(orgId, "owner-1", c3App.approval.id, "approved", c3App.approval.payloadHash, "Approved");
    service.markContractSigned(orgId, "owner-1", c3.id);
    unpaidContractId = c3.id;
  });

  afterEach(() => store.close());

  it("enforces contract signature, deposit payment, and workspace path safety on handoff", () => {
    expect(() => service.createProjectFromContract(orgId, "dev-1", { contractId: unsignedContractId }))
      .toThrowError(AgencyError);
    expect(() => service.createProjectFromContract(orgId, "dev-1", { contractId: unpaidContractId }))
      .toThrowError(AgencyError);
    expect(() => service.createProjectFromContract(orgId, "dev-1", {
      contractId: signedPaidContractId,
      workspacePath: "../../etc/passwd",
    })).toThrowError(AgencyError);

    const project = service.createProjectFromContract(orgId, "dev-1", {
      contractId: signedPaidContractId,
      targetStack: ["typescript", "sqlite", "preact"],
    });
    expect(project.status).toBe("handoff_pending");
    expect(project.workspacePath).toBe(`workspaces/projects/${signedPaidContractId}`);
    expect(project.budgetAmount).toBe(3000);
    expect(project.estimatedDays).toBe(12);

    expect(() => service.createProjectFromContract(orgId, "dev-1", { contractId: signedPaidContractId }))
      .toThrowError(AgencyError);
  });

  it("manages lots, evidence requirements, execution briefs, and owner-approved scope changes", () => {
    const project = service.createProjectFromContract(orgId, "dev-1", { contractId: signedPaidContractId });
    service.transitionProject(orgId, "dev-1", project.id, "scoping");
    service.transitionProject(orgId, "dev-1", project.id, "in_progress");

    const lot = service.createProjectLot(orgId, "dev-1", project.id, {
      title: "Lot 1 - Auth & Dashboard",
      acceptanceCriteria: ["Login works", "Tenant isolated"],
      ownerRole: "developer",
      estimatedHours: 16,
    });

    // Cannot mark verified without evidenceSummary
    expect(() => service.updateProjectLot(orgId, "dev-1", project.id, lot.id, { status: "verified" }))
      .toThrowError(AgencyError);

    const verifiedLot = service.updateProjectLot(orgId, "dev-1", project.id, lot.id, {
      status: "verified",
      actualHours: 14,
      evidenceSummary: "vitest auth.unit.test.ts: 12/12 passed",
    });
    expect(verifiedLot.status).toBe("verified");

    const briefRes = service.generateLotExecutionBrief(orgId, "dev-1", project.id, lot.id, "claude");
    expect(briefRes.brief).toContain(project.workspacePath);
    expect(briefRes.brief).toContain("Login works");
    expect(briefRes.detectedTools.some((t) => t.id === "node" && t.available)).toBe(true);

    // Scope change requires owner approval matching hash
    const sc = service.proposeScopeChange(orgId, "dev-1", project.id, {
      title: "Add PDF invoice export",
      budgetDelta: 650,
      daysDelta: 3,
    });
    expect(() => service.applyApprovedScopeChange(orgId, "owner-1", project.id, sc.id)).toThrowError(AgencyError);

    const scReq = service.requestScopeChangeApproval(orgId, "dev-1", project.id, sc.id, "Client requested PDF export");
    service.decideApproval(orgId, "owner-1", scReq.approval.id, "approved", scReq.approval.payloadHash, "Approved addendum");

    const applied = service.applyApprovedScopeChange(orgId, "owner-1", project.id, sc.id);
    expect(applied.scopeChange.status).toBe("applied");
    expect(applied.project.budgetAmount).toBe(3650);
    expect(applied.project.estimatedDays).toBe(15);
  });

  it("blocks production delivery until QA gate passes across all 4 disciplines and enforces deploy approval", () => {
    const project = service.createProjectFromContract(orgId, "dev-1", { contractId: signedPaidContractId });
    service.transitionProject(orgId, "dev-1", project.id, "scoping");
    service.transitionProject(orgId, "dev-1", project.id, "in_progress");
    const lot = service.createProjectLot(orgId, "dev-1", project.id, { title: "Core Build" });

    // Gate blocked before lot verification and QA checks
    expect(() => service.prepareDelivery(orgId, "dev-1", project.id, {})).toThrowError(AgencyError);

    // Passing QA check requires non-empty evidence
    expect(() => service.recordQaCheck(orgId, "dev-1", project.id, {
      lotId: lot.id,
      category: "functional",
      title: "Functional smoke",
      status: "passed",
      evidence: "   ",
    })).toThrowError(AgencyError);

    // Direct evaluateQaGate also blocks checks without evidence
    const syntheticGate = evaluateQaGate(
      [{ ...lot, status: "verified" }],
      [{
        id: "c1", organizationId: orgId, projectId: project.id, lotId: lot.id,
        category: "functional", title: "Empty evidence", status: "passed",
        evidence: "", findings: "", checkedBy: "qa", checkedAt: clock, createdAt: clock, updatedAt: clock,
      }],
    );
    expect(syntheticGate.readyForDelivery).toBe(false);
    expect(syntheticGate.missingEvidenceChecks).toBe(1);

    service.updateProjectLot(orgId, "dev-1", project.id, lot.id, {
      status: "verified",
      evidenceSummary: "Build and lot tests passed",
    });
    service.transitionProject(orgId, "dev-1", project.id, "qa_review");

    for (const [category, title, evidence] of [
      ["functional", "User journey checks", "e2e/functional.log: 8/8 ok"],
      ["technical", "Typecheck & vitest", "npm run typecheck: 0 errors; vitest 45/45"],
      ["ui_ux", "Responsive & i18n check", "desktop + mobile screenshots verified"],
      ["security", "Tenant isolation & hash check", "security suite 10/10 passed"],
    ] as const) {
      service.recordQaCheck(orgId, "dev-1", project.id, { lotId: lot.id, category, title, status: "passed", evidence });
    }

    const gate = service.evaluateProjectQaGate(orgId, "dev-1", project.id);
    expect(gate.readyForDelivery).toBe(true);
    expect(gate.missingCategories).toHaveLength(0);

    const prepared = service.prepareDelivery(orgId, "dev-1", project.id, {
      environmentUrl: "https://portal.horizon.example",
      releaseNotes: "v1.0.0 production release",
    });
    expect(prepared.delivery.version).toBe(1);

    // Member cannot deploy without owner deploy_production approval
    expect(() => service.markDeliveryDeployed(orgId, "owner-1", project.id, prepared.delivery.id)).toThrowError(AgencyError);

    const deployReq = service.requestDeliveryApproval(orgId, "dev-1", project.id, prepared.delivery.id, "Deploy v1.0.0");
    expect(deployReq.approval.action).toBe("deploy_production");
    service.decideApproval(orgId, "owner-1", deployReq.approval.id, "approved", deployReq.approval.payloadHash, "QA gate verified");

    // Non-owner cannot execute production deploy
    expect(() => service.markDeliveryDeployed(orgId, "dev-1", project.id, prepared.delivery.id)).toThrowError(AgencyError);

    const deployed = service.markDeliveryDeployed(orgId, "owner-1", project.id, prepared.delivery.id);
    expect(deployed.delivery.status).toBe("deployed");
    expect(deployed.project.status).toBe("delivered");

    const accepted = service.recordClientAcceptance(orgId, "dev-1", project.id, prepared.delivery.id, true, "Validated by client");
    expect(accepted.delivery.status).toBe("accepted");
    expect(accepted.project.status).toBe("accepted");

    // Post-delivery retention follow-ups
    const followUp = service.scheduleFollowUp(orgId, "dev-1", project.id, {
      type: "satisfaction",
      dueAt: clock + 7 * 86_400_000,
      notes: "J+7 check-in",
    });
    expect(followUp.status).toBe("scheduled");
    const completedFu = service.updateFollowUpStatus(orgId, "dev-1", followUp.id, "completed", "NPS 10/10 + maintenance interest");
    expect(completedFu.status).toBe("completed");

    // Multi-agent roster & missions & KPIs
    const profiles = service.listAgentProfiles(orgId, "dev-1");
    expect(profiles).toHaveLength(13);
    expect(profiles.filter((p) => p.independentFromBuild && p.role.startsWith("qa_"))).toHaveLength(4);
    expect(profiles.filter((p) => p.role.startsWith("qa_") && !p.canWriteCode)).toHaveLength(4);

    const mission = service.createMission(orgId, "dev-1", {
      projectId: project.id,
      agentRole: "qa_security",
      title: "Verify production tenant headers",
      preferredTool: "node",
    });
    expect(mission.brief).toContain(project.workspacePath);
    const doneMission = service.updateMissionStatus(orgId, "dev-1", mission.id, "completed", "All checks passed", ["reports/security.json"]);
    expect(doneMission.status).toBe("completed");

    const metrics = service.getMetrics(orgId, "dev-1");
    expect(metrics.contractsSigned).toBe(2);
    expect(metrics.projectsTotal).toBe(1);
    expect(metrics.projectsDelivered).toBe(1);
    expect(metrics.projectsAccepted).toBe(1);
    expect(metrics.qaFirstPassRate).toBe(100);
    expect(metrics.pendingFollowUps).toBe(0);
    expect(metrics.openMissions).toBe(0);

    // Tenant isolation & audit hash integrity
    const otherOrg = service.createOrganization({ name: "Other Org" }, "other-owner").id;
    expect(() => service.getProject(otherOrg, "other-owner", project.id)).toThrowError(AgencyError);
    expect(store.verifyAuditChain(orgId).valid).toBe(true);
  });
});
