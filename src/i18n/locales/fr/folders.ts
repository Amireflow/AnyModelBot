import type { TranslatedCatalog } from "../../index.js";
export default {
  err_notAllowed: "Cet emplacement ne peut pas être utilisé. Choisissez un dossier de projet spécifique.",
  err_unavailable: "Impossible d'accéder à ce dossier. Sélectionnez-le à nouveau.",
  err_system: "Le système a bloqué l'accès à ce dossier. Vérifiez ses autorisations d'accès et réessayez.",
  err_desktopOnly: "Choisissez un dossier dans l'application de bureau sur la machine du bot.",
  err_changed: "Les conditions d'envoi ont changé. Vérifiez-les et réessayez.",
  promptFolderGone: "[Le dossier de travail « {name} » lié à ce message n'est plus disponible ({reason}) : ne lisez ni n'écrivez de fichiers portant le même nom ailleurs, ne basculez pas vers un autre dossier et ne modifiez pas de fichiers pendant ce tour. Informez l'utilisateur que le dossier n'est plus disponible et qu'il doit le sélectionner à nouveau.]",
  reasonUnavailable: "il a disparu, a été remplacé ou n'est pas un dossier",
  reasonSystem: "le système bloque son accès",
  reasonNotAllowed: "cet emplacement ne peut pas servir de dossier de travail",
} satisfies TranslatedCatalog["folders"];
