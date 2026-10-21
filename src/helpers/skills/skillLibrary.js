const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const debugLogger = require("../debugLogger");
const {
  SKILL_LIMITS,
  parseSkillMarkdown,
  validateSkillFiles,
  displayNameFor,
  slugifySkillName,
  buildSkillMarkdown,
  replaceFrontmatterValue,
  replaceSkillBody,
  isTextFile,
  isScriptPath,
  contentHash,
} = require("./skillFormat");
const { readSkillArchive, isSafeArchivePath, hasClashingPaths } = require("./skillArchive");

const ARCHIVE_EXTENSIONS = new Set([".zip", ".skill"]);
const FINDER_JUNK = ".DS_Store";
// Ships with the app, read-only, and never listed in the library.
const BUILTIN_DIR = path.join(__dirname, "builtin");
const SKILL_CREATOR = "skill-creator";
// File text a model read may carry, and what an assistant proposal may write.
const MODEL_FILES_MAX_BYTES = 200 * 1024;
const PROPOSAL_LIMITS = { maxFiles: 20, maxFileBytes: 200 * 1024, maxBytes: 1024 * 1024 };
// Copies kept per skill for Undo, newest first; older ones are deleted.
const VERSIONS_KEPT = 5;

// A name the library can address on disk: one path segment that isn't hidden. Wider than
// SKILL_NAME_PATTERN, so a folder dropped in under any name can still be shown and removed.
function isSkillFolderName(name) {
  return (
    typeof name === "string" &&
    !name.startsWith(".") &&
    !name.includes("/") &&
    isSafeArchivePath(name)
  );
}

function isInside(base, candidate) {
  const relative = path.relative(base, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function writeError(error) {
  const code =
    error?.code === "ENOSPC"
      ? "noSpace"
      : ["EACCES", "EPERM", "EROFS"].includes(error?.code)
        ? "permission"
        : "unknown";
  return Object.assign(new Error(`Couldn't write the skill: ${error?.message}`), { code });
}

function byPath(a, b) {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

// Lists a skill folder without following links; any link makes the skill unreadable.
function walkSkillFolder(root) {
  const files = [];
  let bytes = 0;
  let newest = 0;
  const pending = [""];
  while (pending.length > 0) {
    const relDir = pending.pop();
    const dir = relDir ? path.join(root, ...relDir.split("/")) : root;
    newest = Math.max(newest, fs.lstatSync(dir).mtimeMs);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === FINDER_JUNK) continue;
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) return { unreadable: true };
      if (entry.isDirectory()) {
        pending.push(relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const fullPath = path.join(dir, entry.name);
      const stats = fs.lstatSync(fullPath);
      files.push({ path: relPath, fullPath, size: stats.size });
      bytes += stats.size;
      newest = Math.max(newest, stats.mtimeMs);
      if (files.length > SKILL_LIMITS.maxFiles) return { files, bytes, tooMany: true };
    }
  }
  return { files, bytes, tooMany: false, fingerprint: `${files.length}:${bytes}:${newest}` };
}

function folderProblem(name, code) {
  return {
    name,
    displayName: displayNameFor(name, null),
    description: "",
    problems: [{ code }],
    warnings: [],
    hash: null,
  };
}

function toSummary(inspected, state) {
  const [problem] = inspected.problems;
  return {
    name: state.name,
    displayName: inspected.displayName,
    description: inspected.description,
    enabled: state.enabled,
    valid: !problem,
    ...(problem ? { problem } : {}),
    addedAt: state.createdAt,
    updatedAt: state.updatedAt,
    lastUsedAt: state.lastUsedAt,
  };
}

function sizeProblem(files) {
  if (files.length > SKILL_LIMITS.maxFiles) return { code: "tooManyFiles" };
  const bytes = files.reduce((total, file) => total + file.data.length, 0);
  return bytes > SKILL_LIMITS.maxBytes ? { code: "tooLarge" } : null;
}

function readBuiltin(name) {
  const markdown = fs.readFileSync(path.join(BUILTIN_DIR, name, "SKILL.md"), "utf8");
  const { data, body } = parseSkillMarkdown(markdown);
  return { name, displayName: displayNameFor(name, data?.metadata), body, files: [] };
}

// The files an assistant proposal adds, as written: SKILL.md comes from its instructions.
function proposalFiles(files) {
  if (files.length > PROPOSAL_LIMITS.maxFiles) return { problem: { code: "tooManyFiles" } };
  const entries = files.map((file) => ({
    path: file.path.replace(/^\.\//, ""),
    data: Buffer.from(file.content),
  }));
  const unsafe = entries.find((entry) => !isSafeArchivePath(entry.path));
  if (unsafe) return { problem: { code: "unsafePath", values: { path: unsafe.path } } };
  if (hasClashingPaths(["SKILL.md", ...entries.map((entry) => entry.path)])) {
    return { problem: { code: "unsafePath" } };
  }
  return { files: entries };
}

function proposalSizeProblem(files) {
  let bytes = 0;
  for (const file of files) {
    if (file.data.length > PROPOSAL_LIMITS.maxFileBytes) return { code: "tooLarge" };
    bytes += file.data.length;
  }
  return bytes > PROPOSAL_LIMITS.maxBytes ? { code: "tooLarge" } : null;
}

const foldPath = (relPath) => relPath.normalize("NFC").toLowerCase();

function versionIds(folder) {
  if (!fs.existsSync(folder)) return [];
  return fs
    .readdirSync(folder)
    .filter((entry) => /^\d+$/.test(entry))
    .map(Number)
    .sort((a, b) => a - b);
}

/**
 * The user's skills: one folder each under userData/skills, which is the only copy of a
 * skill's content. The database keeps only each skill's on/off state.
 */
class SkillLibrary {
  constructor({ userDataDir, database, recommendedDir }) {
    this.skillsDir = path.join(userDataDir, "skills");
    this.versionsDir = path.join(userDataDir, "skill-versions");
    this.database = database;
    this.recommendedDir = recommendedDir;
    this.inspected = new Map();
    this.uploads = new Map();
  }

  scan() {
    fs.mkdirSync(this.skillsDir, { recursive: true });
    const found = new Map();
    for (const entry of fs.readdirSync(this.skillsDir, { withFileTypes: true })) {
      // Hidden names include the staging and trash folders of a write in progress. A name the
      // app can't address, such as a Windows device name, is left alone too: it couldn't be
      // opened, switched or removed from here.
      if (!isSkillFolderName(entry.name)) continue;
      if (entry.isSymbolicLink()) found.set(entry.name, folderProblem(entry.name, "unreadable"));
      else if (entry.isDirectory()) found.set(entry.name, this._inspect(entry.name));
    }
    for (const name of this.inspected.keys()) {
      if (!found.has(name)) this.inspected.delete(name);
    }

    const states = new Map(this.database.getSkillStates().map((state) => [state.name, state]));
    for (const [name, inspected] of found) {
      const state = states.get(name);
      // A folder that appeared outside the app stays off until the user switches it on.
      if (!state)
        this.database.upsertSkillState(name, { enabled: false, contentHash: inspected.hash });
      else if (inspected.hash && inspected.hash !== state.contentHash) {
        this.database.upsertSkillState(name, { contentHash: inspected.hash });
      }
    }
    for (const name of states.keys()) {
      if (!found.has(name)) this.database.deleteSkillState(name);
    }

    return this.database
      .getSkillStates()
      .filter((state) => found.has(state.name))
      .map((state) => toSummary(found.get(state.name), state));
  }

  get(name) {
    const summary = this.scan().find((skill) => skill.name === name);
    if (!summary) return null;
    const folder = this.skillDir(name);
    const walked = folder ? walkSkillFolder(folder) : { unreadable: true };
    if (walked.unreadable) return { ...summary, markdown: "", files: [] };

    const readAll = !walked.tooMany && walked.bytes <= SKILL_LIMITS.maxBytes;
    let markdown = "";
    const files = [];
    for (const file of walked.files) {
      if (file.path === "SKILL.md") {
        if (file.size <= SKILL_LIMITS.maxBytes) {
          markdown = fs.readFileSync(file.fullPath).toString("utf8");
        }
        continue;
      }
      const data = readAll ? fs.readFileSync(file.fullPath) : null;
      files.push({
        path: file.path,
        size: file.size,
        text: data ? isTextFile(data) : false,
        script: isScriptPath(file.path),
      });
    }
    return { ...summary, markdown, files: files.sort(byPath) };
  }

  readFile(name, relPath) {
    if (typeof relPath !== "string" || !isSafeArchivePath(relPath)) return null;
    const folder = this.skillDir(name);
    if (!folder) return null;
    const filePath = path.join(folder, ...relPath.replace(/^\.\//, "").split("/"));
    try {
      const stats = fs.lstatSync(filePath);
      if (!stats.isFile() || stats.size > SKILL_LIMITS.maxBytes) return null;
      // A folder on the way could still be a link, so the real path must stay in the skill.
      if (!isInside(folder, fs.realpathSync(filePath))) return null;
      const data = fs.readFileSync(filePath);
      return isTextFile(data) ? data.toString("utf8") : null;
    } catch {
      return null;
    }
  }

  setEnabled(name, enabled) {
    const skill = this.scan().find((entry) => entry.name === name);
    if (!skill || (enabled && !skill.valid)) return false;
    return this.database.setSkillEnabled(name, enabled);
  }

  uninstall(name) {
    if (!isSkillFolderName(name)) return;
    const trash = path.join(this.skillsDir, `.trash-${crypto.randomUUID()}`);
    try {
      fs.renameSync(path.join(this.skillsDir, name), trash);
    } catch (error) {
      if (error.code !== "ENOENT") throw writeError(error);
    }
    this._removeQuietly(trash);
    this._removeQuietly(path.join(this.versionsDir, name));
    this.inspected.delete(name);
    this.database.deleteSkillState(name);
  }

  skillDir(name) {
    if (!isSkillFolderName(name)) return null;
    const folder = path.join(this.skillsDir, name);
    try {
      if (!fs.lstatSync(folder).isDirectory()) return null;
      const realFolder = fs.realpathSync(folder);
      return isInside(fs.realpathSync(this.skillsDir), realFolder) ? realFolder : null;
    } catch {
      return null;
    }
  }

  async previewUploads(items) {
    const batchNames = new Set();
    const previews = [];
    for (const item of items) {
      previews.push(await this._previewUpload(item, batchNames));
    }
    return previews;
  }

  commitUploads({ tokens, replace }) {
    const installed = [];
    const failed = [];
    for (const token of tokens) {
      const upload = this.uploads.get(token);
      if (!upload) {
        failed.push({ fileName: "", error: "unknown" });
        continue;
      }
      if (this._exists(upload.name) && !replace.includes(upload.name)) {
        this.uploads.delete(token);
        continue;
      }
      try {
        this._install(upload.name, upload.files);
      } catch (error) {
        // The token stays, so the same upload can be tried again.
        failed.push({ fileName: upload.fileName, error: error.code });
        continue;
      }
      this.uploads.delete(token);
      // Listed once, even when a later upload in the same go replaced it.
      if (!installed.includes(upload.name)) installed.push(upload.name);
    }
    return { installed, failed };
  }

  // A previewed upload is held until it installs or the screen that previewed it lets go.
  discardUploads(tokens) {
    for (const token of tokens) this.uploads.delete(token);
  }

  create({ title, description, instructions, files }) {
    const cleanTitle = title.trim();
    if (!cleanTitle) return { problems: [{ code: "missingName" }] };
    const unsafe = files.find(
      (file) => file.fileName.includes("/") || !isSafeArchivePath(file.fileName)
    );
    if (unsafe) return { problems: [{ code: "unsafePath", values: { path: unsafe.fileName } }] };
    const attachments = files.map((file) => ({
      path: `${isScriptPath(file.fileName) ? "scripts" : "references"}/${file.fileName}`,
      data: Buffer.from(file.data),
    }));
    // Two files on one path would leave only the last one written.
    if (hasClashingPaths(attachments.map((file) => file.path))) {
      return { problems: [{ code: "unsafePath" }] };
    }
    const name = slugifySkillName(cleanTitle, this._takenNames());
    const skillFiles = [
      {
        path: "SKILL.md",
        data: Buffer.from(
          buildSkillMarkdown({ name, title: cleanTitle, description, instructions })
        ),
      },
      ...attachments,
    ];
    const limit = sizeProblem(skillFiles);
    if (limit) return { problems: [limit] };
    const { problems } = validateSkillFiles(skillFiles, { source: "app" });
    if (problems.length > 0) return { problems };
    this._install(name, skillFiles);
    return { name };
  }

  // A shipped starter skill, with its title and description in the user's language.
  addRecommended(id, { title, description }) {
    if (!isSkillFolderName(id)) return null;
    let shipped;
    try {
      shipped = fs.readFileSync(path.join(this.recommendedDir, id, "SKILL.md"), "utf8");
    } catch {
      return null;
    }
    if (this._exists(id)) return { name: id };
    const markdown = buildSkillMarkdown({
      name: id,
      title,
      description,
      instructions: parseSkillMarkdown(shipped).body,
    });
    const files = [{ path: "SKILL.md", data: Buffer.from(markdown) }];
    const { problems } = validateSkillFiles(files, { source: "app" });
    if (problems.length > 0) return { problems };
    this._install(id, files);
    return { name: id };
  }

  // What the assistant reads: the built-in creator, or a skill that is on and valid.
  readForModel({ name, builtin, file, withFiles }) {
    if (builtin) return name === SKILL_CREATOR ? readBuiltin(name) : null;
    const skill = this.get(name);
    if (!skill?.enabled || !skill.valid) return null;
    const files = skill.files.map((entry) => ({ ...entry }));
    if (file !== undefined) {
      const entry = files.find((candidate) => candidate.path === file && candidate.text);
      const content = entry ? this.readFile(name, file) : null;
      if (content === null) return null;
      entry.content = content;
    } else if (withFiles) {
      let room = MODEL_FILES_MAX_BYTES;
      for (const entry of files) {
        if (!entry.text) continue;
        if (entry.size > room) break;
        const content = this.readFile(name, entry.path);
        if (content === null) continue;
        entry.content = content;
        room -= entry.size;
      }
    }
    const { body } = parseSkillMarkdown(skill.markdown);
    return { name, displayName: skill.displayName, body, files };
  }

  // Checked before the user sees a card, so the assistant can fix what it proposed. An update
  // needs a skill that is on and valid; null means there's none to change.
  checkProposal(request) {
    if (request.kind === "update") {
      const updated = this._updatedSkill(request.update);
      return updated && { name: request.update.name, existing: true, problems: updated.problems };
    }
    const { name, existing, problems } = this._proposedSkill(request.proposal);
    return { name, existing, problems };
  }

  // An approved proposal. One named like a skill the user has updates it, keeping a version.
  saveProposal(proposal) {
    const { name, existing, problems, files } = this._proposedSkill(proposal);
    if (problems.length > 0) return { problems };
    if (!existing) {
      this._install(name, files);
      return { name };
    }
    const versionId = this._withVersion(name, () => this._writeSkillFolder(name, files));
    this._stamp(name, files, { enabled: true });
    return { name, versionId };
  }

  // An approved change to a skill that is on and valid: the header keeps every other line,
  // and every file it doesn't change stays byte for byte.
  applyUpdate(update) {
    const updated = this._updatedSkill(update);
    if (!updated || updated.problems.length > 0) return updated && { problems: updated.problems };
    const versionId = this._withVersion(update.name, () =>
      this._writeSkillFolder(update.name, updated.files)
    );
    this._stamp(update.name, updated.files, {});
    return { name: update.name, versionId };
  }

  // Puts a kept copy back in one swap, then forgets it. False when there is no such copy, or
  // when a later save made a newer one: putting this one back would lose that change.
  undo(name, versionId) {
    const versionDir = path.join(this.versionsDir, name, versionId);
    if (!fs.existsSync(versionDir)) return false;
    if (versionIds(path.join(this.versionsDir, name)).at(-1) !== Number(versionId)) return false;
    const walked = walkSkillFolder(versionDir);
    if (walked.unreadable) return false;
    const files = walked.files.map((file) => ({
      path: file.path,
      data: fs.readFileSync(file.fullPath),
    }));
    this._writeSkillFolder(name, files);
    this._stamp(name, files, {});
    this._removeQuietly(versionDir);
    return true;
  }

  // A copy of the skill as it is now, for Undo to put back. Ids only grow, so the newest
  // copies are always the ones kept.
  saveVersion(name) {
    const folder = path.join(this.versionsDir, name);
    const kept = versionIds(folder);
    const versionId = String(Math.max(Date.now(), (kept.at(-1) ?? 0) + 1));
    fs.cpSync(path.join(this.skillsDir, name), path.join(folder, versionId), { recursive: true });
    for (const old of kept.slice(0, Math.max(0, kept.length + 1 - VERSIONS_KEPT))) {
      this._removeQuietly(path.join(folder, String(old)));
    }
    return versionId;
  }

  markUsed(name) {
    this.database.markSkillUsed(name);
  }

  _inspect(name) {
    let walked;
    try {
      walked = walkSkillFolder(path.join(this.skillsDir, name));
    } catch (error) {
      debugLogger.warn("Could not read a skill folder", { name, error: error.message }, "skills");
      return folderProblem(name, "unreadable");
    }
    if (walked.unreadable) return folderProblem(name, "unreadable");
    if (walked.tooMany) return folderProblem(name, "tooManyFiles");
    if (walked.bytes > SKILL_LIMITS.maxBytes) return folderProblem(name, "tooLarge");

    const cached = this.inspected.get(name);
    if (cached?.fingerprint === walked.fingerprint) return cached;
    let files;
    try {
      files = walked.files.map((file) => ({
        path: file.path,
        data: fs.readFileSync(file.fullPath),
      }));
    } catch (error) {
      debugLogger.warn("Could not read a skill's files", { name, error: error.message }, "skills");
      return folderProblem(name, "unreadable");
    }
    const inspected = {
      ...validateSkillFiles(files, { folderName: name, source: "disk" }),
      hash: contentHash(files),
      fingerprint: walked.fingerprint,
    };
    this.inspected.set(name, inspected);
    return inspected;
  }

  async _previewUpload({ fileName, data }, batchNames) {
    const refuse = (problems) => ({ fileName, status: "invalid", problems, warnings: [] });
    if (data.length > SKILL_LIMITS.maxBytes) return refuse([{ code: "tooLarge" }]);
    const extension = path.extname(fileName).toLowerCase();
    let files;
    let rootFolder = null;
    if (extension === ".md") {
      files = [{ path: "SKILL.md", data: Buffer.from(data) }];
    } else if (ARCHIVE_EXTENSIONS.has(extension)) {
      const archive = await readSkillArchive(Buffer.from(data));
      if (archive.problems.length > 0) return refuse(archive.problems);
      ({ files, rootFolder } = archive);
    } else {
      return refuse([{ code: "unsupportedFile" }]);
    }

    const result = validateSkillFiles(files, {
      folderName: rootFolder ?? undefined,
      source: "upload",
    });
    if (result.problems.length > 0) return refuse(result.problems);
    const duplicate = batchNames.has(result.name) || this._exists(result.name);
    batchNames.add(result.name);
    const token = crypto.randomUUID();
    this.uploads.set(token, {
      fileName,
      name: result.name,
      files,
    });
    return {
      fileName,
      status: duplicate ? "duplicate" : "ready",
      token,
      name: result.name,
      displayName: result.displayName,
      problems: [],
      warnings: result.warnings,
    };
  }

  _proposedSkill({ title, description, instructions, files }) {
    const cleanTitle = title.trim();
    // A title one of the user's skills shows updates that skill. Any other gets a folder of its
    // own, as Create does: titles with no Latin letters all slug to the same fallback name.
    const existingName = this._skillTitled(cleanTitle);
    const name = existingName ?? slugifySkillName(cleanTitle, this._takenNames());
    const existing = existingName !== null;
    const refuse = (problem) => ({ name, existing, problems: [problem], files: [] });
    if (!cleanTitle) return refuse({ code: "missingName" });
    const attachments = proposalFiles(files);
    if (attachments.problem) return refuse(attachments.problem);
    const skillFile = buildSkillMarkdown({ name, title: cleanTitle, description, instructions });
    const skillFiles = [{ path: "SKILL.md", data: Buffer.from(skillFile) }, ...attachments.files];
    const limit = proposalSizeProblem(skillFiles);
    if (limit) return refuse(limit);
    const { problems } = validateSkillFiles(skillFiles, { source: "app" });
    return { name, existing, problems, files: skillFiles };
  }

  _updatedSkill({ name, description, instructions, files }) {
    const skill = this.get(name);
    if (!skill?.enabled || !skill.valid) return null;
    const refuse = (problem) => ({ problems: [problem], files: [] });
    const changed = proposalFiles(files);
    if (changed.problem) return refuse(changed.problem);
    let markdown = skill.markdown;
    if (description !== undefined) {
      markdown = replaceFrontmatterValue(markdown, "description", description.trim());
    }
    if (instructions !== undefined) markdown = replaceSkillBody(markdown, instructions);
    const skillFile = { path: "SKILL.md", data: Buffer.from(markdown) };
    // The skill's size was checked when it arrived; the change is held to proposal limits.
    const limit = proposalSizeProblem(
      instructions !== undefined ? [skillFile, ...changed.files] : changed.files
    );
    if (limit) return refuse(limit);
    const replaced = new Set(changed.files.map((file) => foldPath(file.path)));
    const kept = walkSkillFolder(this.skillDir(name))
      .files.filter((file) => file.path !== "SKILL.md" && !replaced.has(foldPath(file.path)))
      .map((file) => ({ path: file.path, data: fs.readFileSync(file.fullPath) }));
    const skillFiles = [skillFile, ...kept, ...changed.files];
    if (hasClashingPaths(skillFiles.map((file) => file.path))) {
      return refuse({ code: "unsafePath" });
    }
    const size = sizeProblem(skillFiles);
    if (size) return refuse(size);
    const { problems } = validateSkillFiles(skillFiles, { folderName: name, source: "app" });
    return { problems, files: skillFiles };
  }

  // Keeps a version, then writes; a failed write leaves the skill and its versions as they were.
  _withVersion(name, write) {
    const versionId = this.saveVersion(name);
    try {
      write();
    } catch (error) {
      this._removeQuietly(path.join(this.versionsDir, name, versionId));
      throw error;
    }
    return versionId;
  }

  _install(name, files) {
    this._writeSkillFolder(name, files);
    this._stamp(name, files, { enabled: true });
  }

  _stamp(name, files, state) {
    this.inspected.delete(name);
    this.database.upsertSkillState(name, { ...state, contentHash: contentHash(files) });
  }

  // Writes into a staging folder, then swaps it in, so a failure never leaves half a skill.
  _writeSkillFolder(name, files) {
    const staging = path.join(this.skillsDir, `.staging-${crypto.randomUUID()}`);
    const target = path.join(this.skillsDir, name);
    let trash = null;
    try {
      for (const file of files) {
        const destination = path.join(staging, ...file.path.split("/"));
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, file.data);
      }
      if (this._exists(name)) {
        trash = path.join(this.skillsDir, `.trash-${crypto.randomUUID()}`);
        fs.renameSync(target, trash);
      }
      fs.renameSync(staging, target);
    } catch (error) {
      this._removeQuietly(staging);
      if (trash && fs.existsSync(trash) && !this._exists(name)) {
        try {
          fs.renameSync(trash, target);
        } catch (restoreError) {
          debugLogger.error(
            "Could not put a skill back after a failed write",
            { name, trash, error: restoreError.message },
            "skills"
          );
        }
      }
      debugLogger.error("Failed to write a skill", { name, error: error.message }, "skills");
      throw writeError(error);
    }
    if (trash) this._removeQuietly(trash);
  }

  _skillTitled(title) {
    const key = (text) => text.trim().replace(/\s+/g, " ").normalize("NFC").toLowerCase();
    return this.scan().find((skill) => key(skill.displayName) === key(title))?.name ?? null;
  }

  _exists(name) {
    try {
      fs.lstatSync(path.join(this.skillsDir, name));
      return true;
    } catch {
      return false;
    }
  }

  _takenNames() {
    fs.mkdirSync(this.skillsDir, { recursive: true });
    return new Set(fs.readdirSync(this.skillsDir).map((name) => name.toLowerCase()));
  }

  _removeQuietly(target) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch (error) {
      debugLogger.warn(
        "Could not remove a skill folder",
        { target, error: error.message },
        "skills"
      );
    }
  }
}

module.exports = { SkillLibrary, isSkillFolderName };
