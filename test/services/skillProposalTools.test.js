const test = require("node:test");
const assert = require("node:assert/strict");
const { installBrowserGlobals } = require("../lib/rendererTestHarness");

const ARGS = {
  title: "Follow-up email from notes",
  description: "Drafts a follow-up email after a call, from that call's notes.",
  instructions: "## Steps\n1. Read the call's notes.\n",
};

// Main as it answers: a check, then a save only once the user approves.
function fakeElectron({ problems = [], saveResult } = {}) {
  const calls = { check: [], save: [] };
  return {
    calls,
    api: {
      skillsCheckProposal: async (request) => {
        calls.check.push(request);
        return { name: "follow-up-email-from-notes", existing: false, problems };
      },
      skillsSaveProposal: async (proposal) => {
        calls.save.push(proposal);
        return saveResult ?? { ok: true, name: "follow-up-email-from-notes" };
      },
    },
  };
}

async function setup(t, electron = fakeElectron()) {
  installBrowserGlobals(t, { window: { electronAPI: electron.api } });
  const { createProposeSkillTool } = await import("../../src/services/tools/skillTools.ts");
  const approvals = await import("../../src/stores/skillApprovalStore.ts");
  const { createToolExecutionScope } = await import(
    "../../src/components/chat/toolExecutionScope.ts"
  );
  approvals.useSkillApprovalStore.setState({ entries: {} });
  const scope = createToolExecutionScope();
  t.after(() => scope.abort());
  let next = 0;
  const propose = (args = ARGS) => {
    next += 1;
    const toolCallId = `call-${next}`;
    const result = createProposeSkillTool().execute(
      args,
      scope.createContext({ messageId: "m1", toolCallId })
    );
    return { result, key: `m1::${toolCallId}` };
  };
  const entry = (key) => approvals.useSkillApprovalStore.getState().entries[key];
  const settled = () => new Promise((resolve) => setImmediate(resolve));
  return { propose, entry, approvals, calls: electron.calls, settled };
}

test("skill tools are offered signed out and on the free plan", async () => {
  const { createToolRegistry } = await import("../../src/services/tools/index.ts");

  const registry = createToolRegistry({
    isSignedIn: false,
    calendarConnected: false,
    cloudBackupEnabled: false,
    webSearchEnabled: false,
    skills: {
      usable: [],
      activeNames: () => new Set(),
      read: async () => null,
      markUsed() {},
      maxTokens: 2_500,
    },
  });

  assert.ok(registry.get("propose_skill"));
  assert.equal(registry.get("email_draft"), undefined);
});

test("nothing is written before Save skill", async (t) => {
  const { propose, entry, approvals, calls, settled } = await setup(t);

  const { result, key } = propose();
  await settled();

  assert.equal(entry(key).state, "pending");
  assert.deepEqual(calls.check, [{ kind: "create", proposal: { ...ARGS, files: [] } }]);
  assert.deepEqual(calls.save, []);
  await approvals.saveSkillApproval(key);
  assert.deepEqual(await result, {
    success: true,
    data: "Saved the follow-up-email-from-notes skill. Tell the user it's saved and how it's used.",
    displayText: "",
  });
  assert.equal(calls.save.length, 1);
});

test("a proposal with problems never shows a card and tells the model what to fix", async (t) => {
  const electron = fakeElectron({ problems: [{ code: "placeholder" }, { code: "tooLarge" }] });
  const { propose, entry } = await setup(t, electron);

  const { result, key } = propose();

  assert.deepEqual(await result, {
    success: true,
    data:
      "Not proposed: placeholder, tooLarge. Fix these and call propose_skill again. " +
      "Don't mention them to the user.",
    displayText: "",
  });
  assert.equal(entry(key), undefined);
});

test("a fourth card in one answer is refused", async (t) => {
  const { propose, entry, approvals, settled } = await setup(t);

  const cards = [propose(), propose(), propose()];
  const fourth = propose();
  await settled();

  assert.deepEqual(
    cards.map(({ key }) => entry(key).state),
    ["pending", "pending", "pending"]
  );
  assert.deepEqual(await fourth.result, {
    success: false,
    data: null,
    displayText: "Only three skill cards per answer.",
  });
  for (const { key } of cards) approvals.skipSkillApproval(key);
});

test("the model hears what the user did with the card", async (t) => {
  const { propose, approvals, settled } = await setup(t);

  const edited = propose();
  const skipped = propose();
  await settled();
  approvals.updateSkillDraft(edited.key, { title: "Call follow-up" });
  await approvals.saveSkillApproval(edited.key);
  approvals.skipSkillApproval(skipped.key);

  assert.equal(
    (await edited.result).data,
    "Saved the follow-up-email-from-notes skill. Tell the user it's saved and how it's used. " +
      "The user edited it before saving."
  );
  assert.equal((await skipped.result).data, "The user skipped it. Nothing was saved.");
});

test("a save that fails tells the model to offer another try", async (t) => {
  const { propose, approvals, settled } = await setup(
    t,
    fakeElectron({ saveResult: { ok: false, error: "noSpace" } })
  );

  const card = propose();
  await settled();
  await approvals.saveSkillApproval(card.key);

  assert.equal((await card.result).data, "It couldn't be saved. Say so and offer to try again.");
});
