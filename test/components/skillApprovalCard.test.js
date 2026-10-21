const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");
const {
  SKILLS_MOCKS,
  ariaLabel,
  click,
  dispatch,
  findAll,
  label,
  settle,
  typeInto,
} = require("../lib/skillsHarness");

const PROPOSAL = {
  title: "Follow-up email from notes",
  description: "Drafts a follow-up email after a call, from that call's notes.",
  instructions: "## Steps\n1. Read the call's notes.",
  files: [],
};
const CREATE = { kind: "create", name: "follow-up-email-from-notes", draft: PROPOSAL };
const SAVED = { ok: true, name: "follow-up-email-from-notes" };

// The card on its store entry, as ToolCallItem shows it, with the skills IPC faked.
async function mountCard(t, { request = CREATE, saveResult = SAVED, openSkill } = {}) {
  let root = null;
  let approvals = null;
  const key = "m1::call-1";
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  // A card left pending keeps its 10-minute expiry timer, and with it the process, alive.
  t.after(() => {
    if (approvals?.useSkillApprovalStore.getState().entries[key]?.state === "pending") {
      approvals.skipSkillApproval(key);
    }
  });
  const calls = { save: [], undo: [] };
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        skillsSaveProposal: async (proposal) => {
          calls.save.push(proposal);
          return saveResult;
        },
        skillsUndo: async (name, versionId) => {
          calls.undo.push([name, versionId]);
          return { ok: true };
        },
      },
    },
  });
  const container = installInteractiveDom(t);
  const { createRoot } = require("react-dom/client");
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-skill-approval-card-test-",
    noExternal: ["react-i18next"],
    mockModules: SKILLS_MOCKS,
  });
  approvals = await vite.ssrLoadModule("/stores/skillApprovalStore.ts");
  const { SkillApprovalCard } = await vite.ssrLoadModule("/components/chat/SkillApprovalCard.tsx");
  const { SkillChatActionsContext } = await vite.ssrLoadModule(
    "/components/chat/skillChatActions.ts"
  );
  approvals.useSkillApprovalStore.setState({ entries: {} });
  const outcome = approvals.requestSkillApproval(
    {
      messageId: "m1",
      toolCallId: "call-1",
      signal: new AbortController().signal,
      onApprovalRequested() {},
    },
    request
  );

  function Harness() {
    const entry = approvals.useSkillApprovalStore((state) => state.entries[key]);
    return entry ? React.createElement(SkillApprovalCard, { entry }) : null;
  }
  const card = React.createElement(Harness);
  root = createRoot(container);
  await React.act(async () =>
    root.render(
      openSkill
        ? React.createElement(SkillChatActionsContext.Provider, { value: { openSkill } }, card)
        : card
    )
  );
  const buttonLabelled = (text) =>
    findAll(container, (node) => node.tagName === "BUTTON" && label(node) === text)[0];
  const fieldLabelled = (text) => findAll(container, (node) => ariaLabel(node) === text)[0];
  const cardElement = () =>
    findAll(container, (node) => node.getAttribute?.("data-approval-card") === key)[0];
  return { container, calls, outcome, approvals, key, buttonLabelled, fieldLabelled, cardElement };
}

test("the create card shows the title, description and Save skill / Edit / Skip", async (t) => {
  const { container, buttonLabelled } = await mountCard(t);

  const text = container.textContent;
  assert.match(text, /skills\.approval\.createHeader/);
  assert.match(text, /skills\.approval\.newSkill/);
  const title = findAll(container, (node) => label(node) === PROPOSAL.title)[0];
  const description = findAll(container, (node) => label(node) === PROPOSAL.description)[0];
  assert.deepEqual([title.getAttribute("dir"), description.getAttribute("dir")], ["auto", "auto"]);
  for (const name of ["skills.approval.save", "connectors.approval.edit", "common.skip"]) {
    assert.ok(buttonLabelled(name), name);
  }
});

test("See full skill shows the instructions", async (t) => {
  const { container, buttonLabelled } = await mountCard(t);
  const toggle = buttonLabelled("skills.approval.seeFull");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");

  await click(toggle);

  const instructions = findAll(container, (node) => node.tagName === "PRE")[0];
  assert.equal(instructions.textContent, PROPOSAL.instructions);
  assert.equal(instructions.getAttribute("dir"), "auto");
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
});

test("Edit changes what Save writes", async (t) => {
  const { calls, buttonLabelled, fieldLabelled, outcome } = await mountCard(t);

  await click(buttonLabelled("connectors.approval.edit"));
  await typeInto(fieldLabelled("skills.approval.nameLabel"), "Call follow-up");
  await typeInto(fieldLabelled("skills.approval.descriptionLabel"), "After every call.");
  await click(buttonLabelled("skills.approval.save"));
  await settle();

  assert.deepEqual(calls.save, [
    { ...PROPOSAL, title: "Call follow-up", description: "After every call." },
  ]);
  assert.deepEqual(await outcome, { state: "saved", name: SAVED.name, edited: true });
});

test("Saved shows Open skill", async (t) => {
  const opened = [];
  const { container, buttonLabelled, cardElement } = await mountCard(t, {
    openSkill: (name) => opened.push(name),
  });

  await click(buttonLabelled("skills.approval.save"));
  await settle();

  assert.match(container.textContent, /skills\.approval\.saved/);
  assert.equal(globalThis.document.activeElement, cardElement(), "focus stays on the card");
  await click(buttonLabelled("skills.approval.openSkill"));
  assert.deepEqual(opened, ["follow-up-email-from-notes"]);
});

test("without a way to open skills, a saved card offers no Open skill", async (t) => {
  const { container, buttonLabelled } = await mountCard(t);

  await click(buttonLabelled("skills.approval.save"));
  await settle();

  assert.match(container.textContent, /skills\.approval\.saved/);
  assert.equal(buttonLabelled("skills.approval.openSkill"), undefined);
});

test("a replacing save shows Updated with Undo", async (t) => {
  const { container, calls, buttonLabelled } = await mountCard(t, {
    request: { ...CREATE, replacesExisting: true },
    saveResult: { ...SAVED, versionId: "1760950800000" },
  });
  assert.match(container.textContent, /skills\.approval\.replacesExisting/);

  await click(buttonLabelled("skills.approval.save"));
  await settle();
  assert.match(container.textContent, /skills\.approval\.updated/);
  await click(buttonLabelled("skills.approval.undo"));
  await settle();

  assert.deepEqual(calls.undo, [["follow-up-email-from-notes", "1760950800000"]]);
  assert.match(container.textContent, /skills\.approval\.undone/);
  assert.equal(buttonLabelled("skills.approval.undo"), undefined);
});

test("Skip leaves the card saying nothing was saved", async (t) => {
  const { container, calls, buttonLabelled, outcome } = await mountCard(t);

  await click(buttonLabelled("common.skip"));

  assert.deepEqual(await outcome, { state: "skipped" });
  assert.match(container.textContent, /skills\.approval\.skippedCreate/);
  assert.equal(buttonLabelled("skills.approval.save"), undefined);
  assert.deepEqual(calls.save, []);
});

test("Esc while editing stops editing and doesn't reach the panel", async (t) => {
  const { approvals, key, buttonLabelled, fieldLabelled } = await mountCard(t);
  await click(buttonLabelled("connectors.approval.edit"));
  const name = fieldLabelled("skills.approval.nameLabel");

  const event = { key: "Escape" };
  await React.act(async () =>
    dispatch(name, "keydown", {
      ...event,
      stopPropagation() {
        event.stopped = true;
        this.cancelBubble = true;
      },
    })
  );

  assert.equal(event.stopped, true);
  assert.equal(fieldLabelled("skills.approval.nameLabel"), undefined, "edit mode ended");
  assert.equal(approvals.useSkillApprovalStore.getState().entries[key].state, "pending");
});
