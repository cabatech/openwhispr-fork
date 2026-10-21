// A local tombstone must outlive a pull, and delete pushes must never reach the
// cloud for rows that were never synced.

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const { createDb } = require("./harness/db.js");
const {
  installBrowserGlobals,
  resetBrowserGlobals,
  enableSync,
  establishValidatedAuth,
  stopSyncTimers,
  window: windowStub,
} = require("./harness/browserGlobals.js");
const { createElectronApi } = require("./harness/electronApiBridge.js");
const { createFakeCloud } = require("./harness/fakeCloud.js");
const { SyncService } = require("../../src/services/SyncService.ts");

const LOCAL_EARLY = "2026-07-20 10:00:00";

async function setup(t) {
  const db = createDb(t);
  if (!db) return null;
  resetBrowserGlobals();
  installBrowserGlobals();
  enableSync();
  const cloud = createFakeCloud();
  const api = createElectronApi(db, { cloud });
  windowStub.electronAPI = api;
  await establishValidatedAuth();
  const service = new SyncService();
  t.after(() => stopSyncTimers(service));
  return { db, cloud, api, service };
}

function updateNote(db, id, fields) {
  const keys = Object.keys(fields);
  db.db
    .prepare(`UPDATE notes SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), id);
  return db.getNote(id);
}

function silenceConsoleErrors(t) {
  t.mock.method(console, "error", () => {});
}

function attempted(db, table, id) {
  return db.db.prepare(`SELECT cloud_create_attempted AS flag FROM ${table} WHERE id = ?`).get(id)
    .flag;
}

// The database as a release without create attempts left it; reopening runs
// the upgrade.
function reopenWithoutCreateAttempts(db) {
  for (const table of ["notes", "agent_conversations"]) {
    db.db.exec(`ALTER TABLE ${table} DROP COLUMN cloud_create_attempted`);
  }
  db.db.close();
  db.initDatabase();
}

test("a local tombstone survives a pull serving a newer cloud copy", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  silenceConsoleErrors(t);

  const note = db.saveNote("Doomed", "body", "personal").note;
  const local = db.getNote(note.id);
  const cloudRow = cloud.seedNote({
    client_note_id: local.client_note_id,
    title: "Doomed",
    content: "body",
    updated_at: "2026-07-20T09:00:00.000Z",
  });
  updateNote(db, note.id, {
    cloud_id: cloudRow.id,
    sync_status: "synced",
    created_at: LOCAL_EARLY,
    updated_at: LOCAL_EARLY,
  });

  // The user deletes locally; another device edits the same note afterwards.
  db.deleteNote(note.id);
  updateNote(db, note.id, { updated_at: LOCAL_EARLY });
  cloud.seedNote({
    client_note_id: local.client_note_id,
    title: "Doomed",
    content: "edited elsewhere after the delete",
    updated_at: "2026-07-20T11:30:00.000Z",
  });

  // The delete push fails this pass, so the tombstone is still local when the
  // pull runs in the same syncAll.
  cloud.failNext("DELETE /api/notes/delete", { status: 500, error: "boom" });

  await service.syncAll(true);

  const afterPull = db.getNote(note.id);
  assert.ok(afterPull, "the tombstone row must still exist locally");
  assert.ok(
    afterPull.deleted_at,
    "the pull must not resurrect a locally deleted note over its tombstone"
  );
  assert.equal(afterPull.sync_status, "pending", "the pending delete must stay pushable");

  await service.syncAll(true);

  assert.equal(db.getNote(note.id), null, "the second pass pushes the delete and clears the row");
  assert.ok(cloud.note(cloudRow.id).deleted_at, "the cloud row ends up tombstoned");
});

test("a never-synced pending note delete makes no cloud call", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { cloud, api, service } = ctx;
  silenceConsoleErrors(t);

  // Defense in depth: getPendingNoteDeletes filters cloud_id in SQL today, so a
  // null can only arrive through a regressed query or bridge. Simulate that.
  api.getPendingNoteDeletes = async () => [
    { id: 41, cloud_id: null, client_note_id: "never-synced" },
  ];

  await service.syncAll(true);

  assert.equal(
    cloud.logFor("/api/notes/delete").length,
    0,
    "a delete without a cloud id must never reach the cloud"
  );
});

test("a never-synced pending conversation delete makes no cloud call", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { cloud, api, service } = ctx;
  silenceConsoleErrors(t);

  api.getPendingConversationDeletes = async () => [
    { id: 41, cloud_id: null, client_conversation_id: "never-synced" },
  ];

  await service.syncAll(true);

  assert.equal(
    cloud.logFor("/api/conversations/delete").length,
    0,
    "a conversation delete without a cloud id must never reach the cloud"
  );
});

test("a note create attempt is recorded only while the note keeps the identity being sent", (t) => {
  const db = createDb(t);
  if (!db) return;
  const kept = db.saveNote("Kept", "body").note;
  const forked = db.saveNote("Forked", "body").note;
  const gone = db.saveNote("Gone", "body").note;
  db.updateNote(forked.id, { client_note_id: randomUUID(), cloud_id: null });
  db.hardDeleteNote(gone.id);

  assert.deepEqual(
    db.markNoteCreatesAttempted([kept.client_note_id, forked.client_note_id, gone.client_note_id]),
    [kept.client_note_id]
  );
  assert.equal(attempted(db, "notes", kept.id), 1);
  assert.equal(attempted(db, "notes", forked.id), 0);
});

test("a chat create attempt is recorded only while the chat exists", (t) => {
  const db = createDb(t);
  if (!db) return;
  const chat = db.createAgentConversation("Chat");
  const gone = db.createAgentConversation("Gone");
  db.hardDeleteConversation(gone.id);

  assert.deepEqual(db.markConversationCreateAttempted(chat.id), { success: true });
  assert.deepEqual(db.markConversationCreateAttempted(gone.id), { success: false });
  assert.equal(attempted(db, "agent_conversations", chat.id), 1);
});

test("an upgrade counts a note whose last create failed as a create attempt", (t) => {
  const db = createDb(t);
  if (!db) return;
  const failed = db.saveNote("Failed", "body").note;
  db.markNoteSyncError(failed.id);
  const fresh = db.saveNote("Fresh", "body").note;

  reopenWithoutCreateAttempts(db);

  assert.equal(attempted(db, "notes", failed.id), 1);
  assert.equal(attempted(db, "notes", fresh.id), 0);
});

test("every note and chat create is recorded as attempted before its request is sent", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, api, service } = ctx;
  silenceConsoleErrors(t);
  const flagAtSend = new Map();
  const send = api.cloudApiRequest;
  api.cloudApiRequest = async (opts) => {
    if (opts.path === "/api/notes/create" || opts.path === "/api/notes/batch-create") {
      for (const { client_note_id: clientId } of opts.body.notes ?? [opts.body]) {
        flagAtSend.set(clientId, db.getNoteByClientId(clientId).cloud_create_attempted);
      }
    }
    if (opts.path === "/api/conversations/create") {
      const clientId = opts.body.client_conversation_id;
      flagAtSend.set(clientId, db.getConversationByClientId(clientId).cloud_create_attempted);
    }
    return send(opts);
  };

  const batched = db.saveNote("Batched", "body").note;
  const chat = db.createAgentConversation("Chat");
  db.addAgentMessage(chat.id, "user", "hello");
  await service.syncAll(true);
  const single = db.saveNote("Single", "body").note;
  await service.pushNote(single.id);
  const migrated = db.saveNote("Migrated", "body").note;
  api.getNotes = async () => [db.getNote(migrated.id)];
  await require("../../src/stores/noteStore.ts").startMigration();

  assert.deepEqual(Object.fromEntries(flagAtSend), {
    [batched.client_note_id]: 1,
    [chat.client_conversation_id]: 1,
    [single.client_note_id]: 1,
    [migrated.client_note_id]: 1,
  });
});

test("a note given a new identity after a sync pass read it is not sent under the old one", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, api, service } = ctx;
  silenceConsoleErrors(t);
  const note = db.saveNote("Forked mid-pass", "body").note;
  const oldClientId = note.client_note_id;
  const readPending = api.getPendingNotes;
  api.getPendingNotes = async (spaceKind) => {
    const pending = await readPending(spaceKind);
    if (pending.some((row) => row.id === note.id)) {
      api.getPendingNotes = readPending;
      db.updateNote(note.id, { client_note_id: randomUUID(), cloud_id: null });
    }
    return pending;
  };

  await service.syncAll(true);
  await service.syncAll(true);

  const sent = cloud
    .logFor("/api/notes/batch-create")
    .flatMap((call) => call.body.notes.map((row) => row.client_note_id));
  assert.equal(sent.includes(oldClientId), false);
  assert.equal(cloud.note(oldClientId), null);
  const synced = db.getNote(note.id);
  assert.equal(synced.sync_status, "synced");
  assert.equal(cloud.note(synced.client_note_id).id, synced.cloud_id);
});
