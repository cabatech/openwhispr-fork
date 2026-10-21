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

const isProposalFiles = (files) =>
  Array.isArray(files) &&
  files.every((file) => typeof file?.path === "string" && typeof file?.content === "string");

function isProposal(proposal) {
  return (
    Boolean(proposal) &&
    ["title", "description", "instructions"].every((key) => typeof proposal[key] === "string") &&
    isProposalFiles(proposal.files)
  );
}

function isUpdate(update) {
  return (
    Boolean(update) &&
    isSkillFolderName(update.name) &&
    isOptional(update.description, "string") &&
    isOptional(update.instructions, "string") &&
    isProposalFiles(update.files)
  );
}

function isProposalRequest(request) {
  if (request?.kind === "create") return isProposal(request.proposal);
  return request?.kind === "update" && isUpdate(request.update);
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
    if (!isProposalRequest(request)) return INVALID;
    return library.checkProposal(request) ?? INVALID;
  });

  ipcMain.handle("skills-save-proposal", (_event, proposal) => {
    if (!isProposal(proposal)) return INVALID;
    try {
      return saved(library.saveProposal(proposal));
    } catch (error) {
      return { ok: false, error: writeErrorCode(error) };
    }
  });

  ipcMain.handle("skills-apply-update", (_event, update) => {
    if (!isUpdate(update)) return INVALID;
    try {
      return saved(library.applyUpdate(update));
    } catch (error) {
      return { ok: false, error: writeErrorCode(error) };
    }
  });

  ipcMain.handle("skills-undo", (_event, name, versionId) => {
    if (!isSkillFolderName(name) || typeof versionId !== "string" || !/^\d+$/.test(versionId)) {
      return INVALID;
    }
    try {
      if (!library.undo(name, versionId)) return INVALID;
    } catch (error) {
      return { ok: false, error: writeErrorCode(error) };
    }
    changed();
    return { ok: true };
  });

  // Bookkeeping, not a change to any skill, so the windows aren't told.
  ipcMain.handle("skills-mark-used", (_event, name) => {
    if (isSkillFolderName(name)) library.markUsed(name);
  });

  // Cloud backup, driven by the renderer's SyncService as for snippets. A pull tells the
  // windows once, at its end, through skills-broadcast-updated.
  const { database } = library;
  const isCloudEntry = (entry) => typeof entry?.name === "string";
  ipcMain.handle("skills-get-pending", () => {
    // A rescan first, so an edit or removal made outside the app is sent too.
    library.scan();
    return database.getPendingSkills();
  });
  ipcMain.handle("skills-get-pending-deletes", () => database.getPendingSkillDeletes());
  ipcMain.handle("skills-export-for-cloud", (_event, name) =>
    isSkillFolderName(name) ? library.exportForCloud(name) : null
  );
  ipcMain.handle("skills-get-for-cloud-merge", (_event, entry) =>
    isCloudEntry(entry) ? database.getSkillForCloudMerge(entry) : null
  );
  ipcMain.handle("skills-apply-from-cloud", (_event, entry) =>
    isCloudEntry(entry) ? library.applyFromCloud(entry) : false
  );
  ipcMain.handle(
    "skills-mark-synced",
    (_event, name, cloudId, serverUpdatedAt, expectedHash, expectedEnabled) => {
      if (!isSkillFolderName(name) || typeof cloudId !== "string") return null;
      return database.markSkillSynced(
        name,
        cloudId,
        serverUpdatedAt,
        expectedHash,
        expectedEnabled
      );
    }
  );
  ipcMain.handle("skills-hard-delete", (_event, name) =>
    isSkillFolderName(name) ? database.hardDeleteSkillState(name) : null
  );
  ipcMain.handle("skills-clear-cloud-id", (_event, name) =>
    isSkillFolderName(name) ? database.clearSkillCloudId(name) : null
  );
  ipcMain.handle("skills-broadcast-updated", () => changed());
}

module.exports = { registerSkillsIpc };
