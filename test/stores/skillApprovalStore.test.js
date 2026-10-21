const test = require("node:test");
const assert = require("node:assert/strict");
const { installBrowserGlobals } = require("../lib/rendererTestHarness");

const load = () => import("../../src/stores/skillApprovalStore.ts");

const PROPOSAL = {
  title: "Follow-up email from notes",
  description: "Drafts a follow-up email after a call, from that call's notes.",
  instructions: "## Steps\n1. Read the call's notes.\n",
  files: [],
};

// The skills IPC as main serves it, with the connector calls a skill card must never make.
function fakeElectron(saveResult = { ok: true, name: "follow-up-email-from-notes" }) {
  const calls = { save: [], undo: [], connector: [] };
  const connector = (name) => async () => {
    calls.connector.push(name);
    return {};
  };
  return {
    calls,
    api: {
      skillsSaveProposal: async (proposal) => {
        calls.save.push(proposal);
        return saveResult;
      },
      skillsUndo: async (name, versionId) => {
        calls.undo.push([name, versionId]);
        return { ok: true };
      },
      connectorPrepare: connector("connectorPrepare"),
      connectorCommit: connector("connectorCommit"),
      connectorCancel: connector("connectorCancel"),
    },
  };
}

function context(toolCallId, controller = new AbortController()) {
  let requested = 0;
  return {
    controller,
    requestedCount: () => requested,
    value: {
      messageId: "m1",
      toolCallId,
      signal: controller.signal,
      onApprovalRequested: () => {
        requested += 1;
      },
    },
  };
}

const CREATE = { kind: "create", name: "follow-up-email-from-notes", draft: PROPOSAL };

async function freshStore(t, electron = fakeElectron()) {
  installBrowserGlobals(t, { window: { electronAPI: electron.api } });
  const store = await load();
  store.useSkillApprovalStore.setState({ entries: {} });
  const entryOf = (toolCallId) =>
    store.useSkillApprovalStore.getState().entries[`m1::${toolCallId}`];
  return { store, entryOf, calls: electron.calls };
}

test("a request shows a pending entry and settles once", async (t) => {
  const { store, entryOf, calls } = await freshStore(t);
  const ctx = context("call-1");

  const outcome = store.requestSkillApproval(ctx.value, CREATE);

  const pending = entryOf("call-1");
  assert.deepEqual(
    [pending.state, pending.kind, pending.name, pending.draft, pending.original],
    ["pending", "create", "follow-up-email-from-notes", PROPOSAL, PROPOSAL]
  );
  assert.equal(ctx.requestedCount(), 1);
  await store.saveSkillApproval(pending.key);
  await store.saveSkillApproval(pending.key);
  store.skipSkillApproval(pending.key);

  assert.deepEqual(await outcome, {
    state: "saved",
    name: "follow-up-email-from-notes",
    edited: false,
  });
  assert.equal(entryOf("call-1").state, "saved");
  assert.equal(calls.save.length, 1);
});

test("Skip and expiry resolve without writing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { store, entryOf, calls } = await freshStore(t);

  const skipped = store.requestSkillApproval(context("call-1").value, CREATE);
  store.skipSkillApproval(entryOf("call-1").key);
  const expired = store.requestSkillApproval(context("call-2").value, CREATE);
  t.mock.timers.tick(10 * 60 * 1000);

  assert.deepEqual(await skipped, { state: "skipped" });
  assert.deepEqual(await expired, { state: "not_saved", reason: "expired" });
  assert.deepEqual(
    [entryOf("call-1").state, entryOf("call-2").state],
    ["skipped", "not_saved"]
  );
  assert.deepEqual(calls.save, []);
});

test("a cancelled turn withdraws a pending card", async (t) => {
  const { store, entryOf, calls } = await freshStore(t);
  const ctx = context("call-1");

  const outcome = store.requestSkillApproval(ctx.value, CREATE);
  ctx.controller.abort();

  assert.deepEqual(await outcome, { state: "not_saved", reason: "conversation_ended" });
  assert.equal(entryOf("call-1").state, "not_saved");
  await store.saveSkillApproval(entryOf("call-1").key);
  assert.deepEqual(calls.save, [], "a withdrawn card can't be saved");

  const aborted = new AbortController();
  aborted.abort();
  assert.deepEqual(await store.requestSkillApproval(context("call-2", aborted).value, CREATE), {
    state: "not_saved",
    reason: "conversation_ended",
  });
  assert.equal(entryOf("call-2"), undefined);
});

test("saving writes the edited draft and reports the edit", async (t) => {
  const { store, entryOf, calls } = await freshStore(t);

  const outcome = store.requestSkillApproval(context("call-1").value, CREATE);
  const { key } = entryOf("call-1");
  store.updateSkillDraft(key, { title: "Call follow-up", description: "After calls." });
  await store.saveSkillApproval(key);

  assert.deepEqual(calls.save, [
    { ...PROPOSAL, title: "Call follow-up", description: "After calls." },
  ]);
  assert.deepEqual(await outcome, {
    state: "saved",
    name: "follow-up-email-from-notes",
    edited: true,
  });
  assert.equal(entryOf("call-1").original.title, PROPOSAL.title);
});

test("a save main refuses shows as failed", async (t) => {
  const electron = fakeElectron({ ok: false, error: "noSpace" });
  const { store, entryOf } = await freshStore(t, electron);

  const outcome = store.requestSkillApproval(context("call-1").value, CREATE);
  await store.saveSkillApproval(entryOf("call-1").key);

  assert.deepEqual(await outcome, { state: "failed" });
  assert.equal(entryOf("call-1").state, "failed");
});

test("a duplicate tool call doesn't steal the first card", async (t) => {
  const { store, entryOf } = await freshStore(t);

  const first = store.requestSkillApproval(context("call-1").value, CREATE);
  const duplicate = await store.requestSkillApproval(context("call-1").value, {
    ...CREATE,
    name: "other",
  });

  assert.deepEqual(duplicate, { state: "not_saved", reason: "duplicate_tool_call" });
  assert.equal(entryOf("call-1").name, "follow-up-email-from-notes");
  store.skipSkillApproval(entryOf("call-1").key);
  assert.deepEqual(await first, { state: "skipped" });
});

test("approving a skill card never calls the connector IPC", async (t) => {
  const { store, entryOf, calls } = await freshStore(t);

  const saved = store.requestSkillApproval(context("call-1").value, CREATE);
  await store.saveSkillApproval(entryOf("call-1").key);
  const skipped = store.requestSkillApproval(context("call-2").value, CREATE);
  store.skipSkillApproval(entryOf("call-2").key);
  const ctx = context("call-3");
  const withdrawn = store.requestSkillApproval(ctx.value, CREATE);
  ctx.controller.abort();
  await Promise.all([saved, skipped, withdrawn]);

  assert.deepEqual(calls.connector, []);
});

test("a save that replaced a skill keeps its version, and Undo puts it back", async (t) => {
  const electron = fakeElectron({
    ok: true,
    name: "follow-up-email-from-notes",
    versionId: "1760950800000",
  });
  const { store, entryOf, calls } = await freshStore(t, electron);

  void store.requestSkillApproval(context("call-1").value, { ...CREATE, replacesExisting: true });
  await store.saveSkillApproval(entryOf("call-1").key);
  assert.equal(entryOf("call-1").versionId, "1760950800000");
  await store.undoSkillApproval(entryOf("call-1").key);

  assert.deepEqual(calls.undo, [["follow-up-email-from-notes", "1760950800000"]]);
  assert.equal(entryOf("call-1").state, "undone");
});
