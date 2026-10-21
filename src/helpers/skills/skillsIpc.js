const { isSkillFolderName } = require("./skillLibrary");

const INVALID = { ok: false, error: "invalid" };

function isUploadItem(item) {
  return Boolean(item) && typeof item.fileName === "string" && item.data instanceof Uint8Array;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isCreateInput(input) {
  return (
    Boolean(input) &&
    ["title", "description", "instructions"].every((key) => typeof input[key] === "string") &&
    Array.isArray(input.files) &&
    input.files.every(isUploadItem)
  );
}

const isOptional = (value, type) => value === undefined || typeof value === type;

function isModelRef(ref) {
  return (
    Boolean(ref) &&
    isSkillFolderName(ref.name) &&
    isOptional(ref.builtin, "boolean") &&
    isOptional(ref.file, "string") &&
    isOptional(ref.withFiles, "boolean")
  );
}

function isProposal(proposal) {
  return (
    Boolean(proposal) &&
    ["title", "description", "instructions"].every((key) => typeof proposal[key] === "string") &&
    Array.isArray(proposal.files) &&
    proposal.files.every(
      (file) => typeof file?.path === "string" && typeof file?.content === "string"
    )
  );
}

function writeErrorCode(error) {
  return ["noSpace", "permission"].includes(error?.code) ? error.code : "unknown";
}

// Every handler checks its arguments before the library runs, and every write tells each
// window to reload its list.
function registerSkillsIpc({ ipcMain, library, shell, broadcast }) {
  const changed = () => broadcast("skills-changed");

  const saved = (result) => {
    if (!result) return INVALID;
    if (result.problems) return { ok: false, problems: result.problems };
    changed();
    return { ok: true, ...result };
  };

  ipcMain.handle("skills-list", () => ({ skills: library.scan() }));

  ipcMain.handle("skills-get", (_event, name) =>
    isSkillFolderName(name) ? library.get(name) : null
  );

  ipcMain.handle("skills-read-file", (_event, name, relPath) => {
    if (!isSkillFolderName(name) || typeof relPath !== "string") return null;
    const text = library.readFile(name, relPath);
    return text === null ? null : { text };
  });

  ipcMain.handle("skills-set-enabled", (_event, name, enabled) => {
    if (!isSkillFolderName(name) || typeof enabled !== "boolean") return INVALID;
    if (!library.setEnabled(name, enabled)) return INVALID;
    changed();
    return { ok: true };
  });

  ipcMain.handle("skills-uninstall", (_event, name) => {
    if (!isSkillFolderName(name)) return INVALID;
    try {
      library.uninstall(name);
    } catch (error) {
      return { ok: false, error: writeErrorCode(error) };
    }
    changed();
    return { ok: true };
  });

  ipcMain.handle("skills-reveal", (_event, name) => {
    const folder = isSkillFolderName(name) ? library.skillDir(name) : null;
    if (!folder) return { ok: false };
    shell.showItemInFolder(folder);
    return { ok: true };
  });

  // Files cross as bytes and come back as one-time tokens, so what installs is exactly
  // what the user saw previewed.
  ipcMain.handle("skills-preview-upload", async (_event, items) => {
    if (!Array.isArray(items) || !items.every(isUploadItem)) return INVALID;
    return { items: await library.previewUploads(items) };
  });

  ipcMain.handle("skills-discard-uploads", (_event, tokens) => {
    if (!isStringArray(tokens)) return INVALID;
    library.discardUploads(tokens);
    return { ok: true };
  });

  ipcMain.handle("skills-commit-upload", (_event, request) => {
    if (!isStringArray(request?.tokens) || !isStringArray(request?.replace)) return INVALID;
    const result = library.commitUploads({ tokens: request.tokens, replace: request.replace });
    if (result.installed.length > 0) changed();
    return result;
  });

  ipcMain.handle("skills-create", (_event, input) => {
    if (!isCreateInput(input)) return INVALID;
    try {
      return saved(library.create(input));
    } catch (error) {
      return { ok: false, error: writeErrorCode(error) };
    }
  });

  ipcMain.handle("skills-add-recommended", (_event, id, copy) => {
    if (
      !isSkillFolderName(id) ||
      typeof copy?.title !== "string" ||
      typeof copy?.description !== "string"
    ) {
      return INVALID;
    }
    try {
      return saved(
        library.addRecommended(id, { title: copy.title, description: copy.description })
      );
    } catch (error) {
      return { ok: false, error: writeErrorCode(error) };
    }
  });

  ipcMain.handle("skills-read-for-model", (_event, ref) =>
    isModelRef(ref) ? library.readForModel(ref) : null
  );

  ipcMain.handle("skills-check-proposal", (_event, request) => {
    if (request?.kind !== "create" || !isProposal(request.proposal)) return INVALID;
    return library.checkProposal(request);
  });

  ipcMain.handle("skills-save-proposal", (_event, proposal) => {
    if (!isProposal(proposal)) return INVALID;
    try {
      return saved(library.saveProposal(proposal));
    } catch (error) {
      return { ok: false, error: writeErrorCode(error) };
    }
  });

  // Bookkeeping, not a change to any skill, so the windows aren't told.
  ipcMain.handle("skills-mark-used", (_event, name) => {
    if (isSkillFolderName(name)) library.markUsed(name);
  });
}

module.exports = { registerSkillsIpc };
