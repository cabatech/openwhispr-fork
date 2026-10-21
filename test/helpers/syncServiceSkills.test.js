// The skills half of SyncService: the real service, over a real SkillLibrary and
// DatabaseManager, with only the HTTP boundary faked.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createDb } = require("./harness/db.js");
const {
  installBrowserGlobals,
  resetBrowserGlobals,
  enableSync,
  establishValidatedAuth,
  stopSyncTimers,
  localStorage: localStorageStub,
  window: windowStub,
} = require("./harness/browserGlobals.js");
const { createElectronApi } = require("./harness/electronApiBridge.js");
const { createFakeCloud } = require("./harness/fakeCloud.js");
const { SkillLibrary } = require("../../src/helpers/skills/skillLibrary");
const { SyncService } = require("../../src/services/SyncService.ts");
const { RECOMMENDED_DIR, skillText, writeFolder, listDir } = require("./skills/libraryFixture");

async function setup(t) {
  const db = createDb(t);
  if (!db) return null;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-skill-sync-pass-"));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const library = new SkillLibrary({ userDataDir, database: db, recommendedDir: RECOMMENDED_DIR });
  resetBrowserGlobals();
  installBrowserGlobals();
  enableSync();
  const cloud = createFakeCloud();
  const api = createElectronApi(db, { cloud, skillLibrary: library });
  windowStub.electronAPI = api;
  await establishValidatedAuth();
  const service = new SyncService();
  t.after(() => stopSyncTimers(service));
  return { db, library, cloud, api, service, skillsDir: path.join(userDataDir, "skills") };
}

const create = (library, title) =>
  library.create({ title, description: `About ${title}.`, instructions: "Steps.", files: [] })
    .name;
const pendingNames = (db) => db.getPendingSkills().map((row) => row.name);
const cloudByName = (cloud) => Object.fromEntries(cloud.skills().map((row) => [row.name, row]));
const sentNames = (cloud) =>
  cloud
    .logFor("/api/skills/batch-create")
    .map((call) => call.body.entries.map((entry) => entry.name));
const silence = (t, method = "error") => t.mock.method(console, method, () => {});
const messages = (mock) =>
  mock.mock.calls.map((call) => call.arguments.map((a) => String(a?.message ?? a)).join(" "));

test("skills sync after snippets only with Cloud backup consent", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const name = create(ctx.library, "Meeting prep");

  localStorageStub.setItem("cloudBackupEnabled", "false");
  await ctx.service.syncAll(true);
  assert.equal(ctx.cloud.log.filter((call) => call.path.startsWith("/api/skills")).length, 0);
  assert.deepEqual(pendingNames(ctx.db), [name]);

  localStorageStub.setItem("cloudBackupEnabled", "true");
  await ctx.service.syncAll(true);

  const paths = ctx.cloud.log.map((call) => call.path.split("?")[0]);
  assert.ok(
    paths.indexOf("/api/skills/batch-create") > paths.lastIndexOf("/api/snippets/list"),
    "skills go after snippets"
  );
  const stored = cloudByName(ctx.cloud)[name];
  assert.equal(stored.enabled, true);
  assert.deepEqual(
    stored.files.map((file) => file.path),
    ["SKILL.md"]
  );
  assert.equal(stored.content_hash, ctx.db.getSkillStates()[0].contentHash);
  assert.deepEqual(pendingNames(ctx.db), []);
});

test("a missing skills binding aborts the pass like snippets", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const errors = silence(t);
  create(ctx.library, "Meeting prep");

  delete windowStub.electronAPI.applySkillFromCloud;
  await ctx.service.syncAll(true);

  assert.equal(ctx.cloud.logFor("/api/skills/batch-create").length, 0);
  assert.equal(localStorageStub.getItem("lastSyncedAt"), null);
  assert.ok(messages(errors).some((m) => m.includes("applySkillFromCloud")));
});

test("batches carry at most 10 skills and 3 MB", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  for (let index = 0; index < 12; index += 1) create(ctx.library, `Small ${index}`);
  for (const name of ["big-a", "big-b", "big-c", "big-d"]) {
    writeFolder(ctx.skillsDir, name, {
      "SKILL.md": skillText(name),
      "references/big.md": "x".repeat(900_000),
    });
  }

  await ctx.service.syncSkillsNow();

  const batches = sentNames(ctx.cloud);
  assert.ok(batches.every((names) => names.length <= 10));
  for (const call of ctx.cloud.logFor("/api/skills/batch-create")) {
    assert.ok(Buffer.byteLength(JSON.stringify(call.body.entries)) <= 3 * 1024 * 1024);
  }
  assert.equal(batches.flat().length, 16);
  assert.equal(ctx.cloud.skills().length, 16);
});

test("a skill over the sync caps is never pushed and stays on this computer", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  writeFolder(ctx.skillsDir, "too-big", {
    "SKILL.md": skillText("too-big"),
    "references/big.md": "x".repeat(1024 * 1024),
  });
  create(ctx.library, "Small one");

  await ctx.service.syncSkillsNow();

  assert.deepEqual(Object.keys(cloudByName(ctx.cloud)), ["small-one"]);
  assert.deepEqual(listDir(ctx.skillsDir), ["small-one", "too-big"]);
});

test("enabled state travels both ways", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const name = create(ctx.library, "Meeting prep");
  await ctx.service.syncSkillsNow();

  ctx.library.setEnabled(name, false);
  await ctx.service.syncSkillsNow();
  assert.equal(cloudByName(ctx.cloud)[name].enabled, false);
  assert.deepEqual(pendingNames(ctx.db), []);

  const stored = cloudByName(ctx.cloud)[name];
  // Switched back on from another device, a moment later.
  const later = new Date(Date.parse(stored.updated_at) + 1000).toISOString();
  ctx.cloud.setClock(() => later);
  ctx.cloud.seedSkill({ ...stored, enabled: true });
  await ctx.service.syncSkillsNow();
  assert.equal(ctx.library.scan()[0].enabled, true);
  assert.deepEqual(pendingNames(ctx.db), []);
});

test("a skill from another device appears here, and its delete removes it", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const seeded = ctx.cloud.seedSkill({
    client_skill_id: "other-device",
    name: "weekly-recap",
    enabled: true,
    content_hash: "h",
    files: [{ path: "SKILL.md", encoding: "utf8", content: skillText("weekly-recap") }],
  });

  await ctx.service.syncSkillsNow();
  assert.deepEqual(
    ctx.library.scan().map((skill) => [skill.name, skill.enabled, skill.valid]),
    [["weekly-recap", true, true]]
  );
  assert.ok(ctx.api.syncEvents.some((event) => event.name === "skills-changed"));

  ctx.cloud.deleteSkill(seeded.id);
  await ctx.service.syncSkillsNow();
  assert.deepEqual(listDir(ctx.skillsDir), []);
  assert.deepEqual(ctx.library.scan(), []);
  assert.equal(ctx.cloud.logFor("/api/skills/delete").length, 0, "the delete isn't echoed back");
});

test("uninstalling a synced skill deletes it in the cloud, then forgets it", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const name = create(ctx.library, "Meeting prep");
  await ctx.service.syncSkillsNow();

  ctx.library.uninstall(name);
  await ctx.service.syncSkillsNow();

  assert.ok(cloudByName(ctx.cloud)[name].deleted_at);
  assert.deepEqual(ctx.db.getPendingSkillDeletes(), []);
  assert.equal(
    ctx.db.db.prepare("SELECT COUNT(*) AS count FROM skills").get().count,
    0,
    "the tombstone is gone once the delete is pushed"
  );
});

test("a 409 stops the retry and a 404 clears cloud_id", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  silence(t);
  const name = create(ctx.library, "Meeting prep");
  await ctx.service.syncSkillsNow();
  const cloudId = cloudByName(ctx.cloud)[name].id;

  ctx.library.setEnabled(name, false);
  ctx.cloud.failNext("PATCH /api/skills/update", { status: 409 });
  await ctx.service.syncSkillsNow();
  assert.deepEqual(pendingNames(ctx.db), [], "a refused update isn't sent again and again");

  ctx.library.setEnabled(name, true);
  ctx.cloud.failNext("PATCH /api/skills/update", { status: 404 });
  await ctx.service.syncSkillsNow();
  const row = ctx.db.getSkillForCloudMerge({ name });
  assert.deepEqual([row.cloud_id, row.sync_status], [null, "pending"]);

  await ctx.service.syncSkillsNow();
  assert.equal(ctx.db.getSkillForCloudMerge({ name }).cloud_id, cloudId, "re-created by name");
  assert.deepEqual(pendingNames(ctx.db), []);
});

test("an older API without /api/skills (404 on list) is skipped without error", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const errors = silence(t);
  create(ctx.library, "Meeting prep");
  ctx.cloud.failWith("/api/skills/list", { status: 404 });
  ctx.cloud.failWith("/api/skills/batch-create", { status: 404 });

  await ctx.service.syncAll(true);

  assert.ok(localStorageStub.getItem("lastSyncedAt"), "the pass completes");
  assert.deepEqual(
    messages(errors).filter((m) => /skill/i.test(m)),
    []
  );
  assert.equal(localStorageStub.getItem("lastSyncedAt.skills"), null);
});
