/**
 * Unique mascot avatar mapping for each of the 13 Agency agents and the Executive Copilot,
 * using the built-in BotAvatar characters from ui/components/avatar.js.
 */
export const AGENT_AVATARS = {
  prospecting: "dossier",
  qualification: "data",
  commercial: "marketing",
  estimator: "finance",
  project_manager: "orange",
  architect: "purple",
  developer: "code",
  ui_ux: "design",
  qa_functional: "writing",
  qa_technical: "science",
  qa_ui_ux: "yellow",
  qa_security: "law",
  retention: "green",
};

export const COPILOT_AVATAR = "blue";

export function agentAvatarOf(role) {
  return AGENT_AVATARS[role] || COPILOT_AVATAR;
}
