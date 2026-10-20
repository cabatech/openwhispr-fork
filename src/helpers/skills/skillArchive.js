const unzipper = require("unzipper");
const { SKILL_LIMITS, WINDOWS_RESERVED_NAME } = require("./skillFormat");

const SKILL_FILE_NAME = "skill.md";

function isSafeArchivePath(raw) {
  if (/[\u0000-\u001f]/.test(raw) || raw.includes("\\")) return false;
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) return false;
  return raw
    .replace(/^\.\//, "")
    .split("/")
    .every(
      (segment) =>
        segment !== "" &&
        segment !== "." &&
        segment !== ".." &&
        !/[<>:"|?*]/.test(segment) &&
        !/[ .]$/.test(segment) &&
        !WINDOWS_RESERVED_NAME.test(segment)
    );
}

function isJunk(entryPath) {
  return entryPath.startsWith("__MACOSX/") || entryPath.split("/").pop() === ".DS_Store";
}

function isSymlinkEntry(entry) {
  return ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000;
}

// Paths a case-insensitive disk would write to the same place, or a file where a folder goes.
function hasClashingPaths(paths) {
  const files = new Set();
  const folders = new Set();
  for (const entryPath of paths) {
    const key = entryPath.normalize("NFC").toLowerCase();
    if (files.has(key)) return true;
    files.add(key);
    const segments = key.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) {
      folders.add(segments.slice(0, depth).join("/"));
    }
  }
  return [...files].some((key) => folders.has(key));
}

// The central directory's sizes can lie, so the cap counts the bytes actually read.
async function readCapped(entry, budget) {
  const chunks = [];
  let size = 0;
  for await (const chunk of entry.stream()) {
    size += chunk.length;
    // Leaving the loop destroys the stream, so nothing past the cap is inflated.
    if (size > budget.remaining) throw Object.assign(new Error("tooLarge"), { code: "tooLarge" });
    chunks.push(chunk);
  }
  budget.remaining -= size;
  return Buffer.concat(chunks);
}

function refuse(code) {
  return { files: [], rootFolder: null, problems: [{ code }] };
}

/**
 * Reads a .zip or .skill archive into a skill's files, relative to the skill root with
 * SKILL.md at "SKILL.md". Every entry is checked from the listing before any is read.
 */
async function readSkillArchive(buffer, { limits: overrides } = {}) {
  const limits = { ...SKILL_LIMITS, ...overrides };
  let directory;
  try {
    directory = await unzipper.Open.buffer(buffer);
  } catch {
    return refuse("unreadableArchive");
  }

  const entries = directory.files.filter(
    (entry) => entry.type !== "Directory" && !isJunk(entry.path)
  );
  if (entries.some((entry) => !isSafeArchivePath(entry.path))) return refuse("unsafePath");
  if (entries.some(isSymlinkEntry)) return refuse("symlink");
  const paths = entries.map((entry) => entry.path.replace(/^\.\//, ""));
  if (hasClashingPaths(paths)) return refuse("unsafePath");
  if (entries.length > limits.maxFiles) return refuse("tooManyFiles");

  const skillFiles = paths.filter(
    (entryPath) => entryPath.split("/").pop().toLowerCase() === SKILL_FILE_NAME
  );
  if (skillFiles.length === 0) return refuse("noSkillFile");
  if (skillFiles.length > 1) return refuse("multipleSkillFiles");
  const skillSegments = skillFiles[0].split("/");
  if (skillSegments.length > 2) return refuse("skillFileTooDeep");
  const rootFolder = skillSegments.length === 2 ? skillSegments[0] : null;
  if (rootFolder && paths.some((entryPath) => !entryPath.startsWith(`${rootFolder}/`))) {
    return refuse("skillFileTooDeep");
  }
  const declaredBytes = entries.reduce((total, entry) => total + entry.uncompressedSize, 0);
  if (declaredBytes > limits.maxBytes) return refuse("tooLarge");

  const budget = { remaining: limits.maxBytes };
  const files = [];
  try {
    for (const [index, entry] of entries.entries()) {
      const entryPath = paths[index];
      const relative = rootFolder ? entryPath.slice(rootFolder.length + 1) : entryPath;
      const data = await readCapped(entry, budget);
      files.push({ path: entryPath === skillFiles[0] ? "SKILL.md" : relative, data });
    }
  } catch (error) {
    return refuse(error.code === "tooLarge" ? "tooLarge" : "unreadableArchive");
  }
  return { files, rootFolder, problems: [] };
}

module.exports = { readSkillArchive, isSafeArchivePath, hasClashingPaths };
