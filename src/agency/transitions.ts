import { AgencyError } from "./errors.js";
import type { LeadStage } from "./types.js";

const TRANSITIONS: Record<LeadStage, readonly LeadStage[]> = {
  new: ["researching", "archived"],
  researching: ["new", "qualified", "lost", "archived"],
  qualified: ["researching", "contact_pending", "lost", "archived"],
  contact_pending: ["qualified", "contacted", "lost"],
  contacted: ["qualified", "engaged", "lost"],
  engaged: ["contacted", "opportunity", "lost"],
  opportunity: ["engaged", "proposal", "lost"],
  proposal: ["opportunity", "won", "lost"],
  won: ["archived"],
  lost: ["qualified", "archived"],
  archived: [],
};

export function canTransitionLead(from: LeadStage, to: LeadStage): boolean {
  return Object.hasOwn(TRANSITIONS, from) && TRANSITIONS[from].includes(to);
}

export function assertLeadTransition(from: LeadStage, to: LeadStage): void {
  if (!canTransitionLead(from, to)) {
    throw new AgencyError("INVALID_TRANSITION", `Lead cannot move from ${from} to ${to}`, { from, to });
  }
}
