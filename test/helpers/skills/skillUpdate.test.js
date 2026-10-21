const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { replaceFrontmatterValue } = require("../../../src/helpers/skills/skillFormat");
const { setup, writeFolder, readSkill, listDir } = require("./libraryFixture");

const NAME = "enterprise-call-playbook";
// A hand-written header: a folded description, a comment, an unknown key, metadata and CRLF.
const SKILL_MD = [
  "---",
  `name: ${NAME}`,
  "description: >",
  "  Preps me for enterprise calls.",
  "  Use before a call.",
  "# kept: a comment",
  "when_to_use: Before calls",
  "metadata:",
  '  display_name: "Enterprise call playbook"',
  '  version: "3"',
  "---",
  "",
  "## Steps",
  "Ask about budget.",
  "",
].join("\r\n");
const OTHER_FILES = {
  "references/objections.md": "# Objections\n- We don't offer SSO.\n",
  "agents/openai.yaml": "interface:\n  display_name: Playbook\n",
  "assets/logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]),
};

function playbook(t) {
  const context = setup(t);
  writeFolder(context.skillsDir, NAME, { "SKILL.md": SKILL_MD, ...OTHER_FILES });
  context.library.scan();
  context.database.setSkillEnabled(NAME, true);
  return { ...context, versionsDir: path.join(context.userDataDir, "skill-versions", NAME) };
}

function snapshot(folder) {
  const files = {};
  const walk = (relDir) => {
    for (const entry of fs.readdirSync(path.join(folder, relDir), { withFileTypes: true })) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(relPath);
      else files[relPath] = fs.readFileSync(path.join(folder, relPath)).toString("base64");
    }
  };
  walk("");
  return files;
}

const SSO = {
  name: NAME,
  description: "Preps me for enterprise calls, SSO pricing included.",
  instructions: "## Steps\nAsk about budget.\nHave the SSO answer ready.",
  files: [{ path: "references/objections.md", content: "# Objections\n- SSO: Enterprise.\n" }],
};

test("an update keeps every other frontmatter line byte for byte", (t) => {
  const { library, skillsDir } = playbook(t);

  library.applyUpdate(SSO);

  assert.equal(
    readSkill(skillsDir, NAME),
    [
      "---",
      `name: ${NAME}`,
      'description: "Preps me for enterprise calls, SSO pricing included."',
      "# kept: a comment",
      "when_to_use: Before calls",
      "metadata:",
      '  display_name: "Enterprise call playbook"',
      '  version: "3"',
      "---",
      "",
      "## Steps",
      "Ask about budget.",
      "Have the SSO answer ready.",
      "",
    ].join("\r\n")
  );
  const skillDir = path.join(skillsDir, NAME);
  assert.equal(
    fs.readFileSync(path.join(skillDir, "references/objections.md"), "utf8"),
    "# Objections\n- SSO: Enterprise.\n"
  );
  for (const relPath of ["agents/openai.yaml", "assets/logo.png"]) {
    const stored = fs.readFileSync(path.join(skillDir, relPath));
    assert.ok(stored.equals(Buffer.from(OTHER_FILES[relPath])), relPath);
  }
  assert.equal(library.scan()[0].valid, true);
});

test("a missing description key is added before the closing line", () => {
  assert.equal(
    replaceFrontmatterValue("---\nname: recap\n---\n\nBody\n", "description", 'Says "hi".'),
    '---\nname: recap\ndescription: "Says \\"hi\\"."\n---\n\nBody\n'
  );
  assert.throws(() => replaceFrontmatterValue("# No header\n", "description", "x"));
});

test("an update keeps a version and Undo restores it exactly", (t) => {
  const { library, skillsDir, versionsDir } = playbook(t);
  const before = snapshot(path.join(skillsDir, NAME));

  const { versionId } = library.applyUpdate(SSO);
  assert.deepEqual(snapshot(path.join(versionsDir, versionId)), before);
  assert.notDeepEqual(snapshot(path.join(skillsDir, NAME)), before);

  library.undo(NAME, versionId);

  assert.deepEqual(snapshot(path.join(skillsDir, NAME)), before);
  assert.deepEqual(listDir(versionsDir), [], "the restored copy is gone");
  assert.equal(library.scan()[0].enabled, true);
});

test("only the five newest versions are kept", (t) => {
  const { library, versionsDir } = playbook(t);

  const ids = [];
  for (let round = 1; round <= 7; round += 1) {
    ids.push(library.applyUpdate({ ...SSO, instructions: `Round ${round}`, files: [] }).versionId);
  }

  assert.deepEqual(listDir(versionsDir), [...ids].sort().slice(2));
  assert.equal(new Set(ids).size, 7);
});

test("uninstall removes the skill's versions", (t) => {
  const { library, versionsDir } = playbook(t);
  library.applyUpdate(SSO);
  assert.equal(listDir(versionsDir).length, 1);

  library.uninstall(NAME);

  assert.equal(fs.existsSync(versionsDir), false);
});

test("a failed update leaves the skill and its versions as they were", (t) => {
  const { library, skillsDir, versionsDir } = playbook(t);
  const { versionId } = library.applyUpdate(SSO);
  const skill = snapshot(path.join(skillsDir, NAME));
  t.mock.method(fs, "renameSync", () => {
    throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
  });

  assert.throws(() => library.applyUpdate({ ...SSO, instructions: "Lost" }), { code: "noSpace" });
  t.mock.restoreAll();

  assert.deepEqual(snapshot(path.join(skillsDir, NAME)), skill);
  assert.deepEqual(listDir(versionsDir), [versionId]);
  assert.deepEqual(
    listDir(skillsDir).filter((name) => name.startsWith(".")),
    [],
    "no staging or trash folder"
  );
});

test("an update needs a switched-on, valid skill and is checked like a proposal", (t) => {
  const { library, database } = playbook(t);
  const check = (update) => library.checkProposal({ kind: "update", update });

  assert.deepEqual(check(SSO), { name: NAME, existing: true, problems: [] });
  assert.deepEqual(check({ ...SSO, instructions: "[TODO: ask]" }).problems, [
    { code: "placeholder" },
  ]);
  assert.deepEqual(
    check({ ...SSO, files: [{ path: "../escape.md", content: "x" }] }).problems.map(
      (problem) => problem.code
    ),
    ["unsafePath"]
  );
  assert.deepEqual(
    library.applyUpdate({ ...SSO, description: "<b>bold</b>" }).problems.map((p) => p.code),
    ["descriptionAngleBrackets"]
  );
  database.setSkillEnabled(NAME, false);
  assert.equal(check(SSO), null);
  assert.equal(library.applyUpdate(SSO), null);
});
