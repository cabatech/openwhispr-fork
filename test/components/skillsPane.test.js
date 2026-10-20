const test = require("node:test");
const assert = require("node:assert/strict");

const React = require("react");

const { findElement } = require("../lib/interactiveDom");
const {
  ariaLabel,
  click,
  dispatch,
  label,
  mountSkillsComponent,
  pressEscape,
  settle,
  skill,
} = require("../lib/skillsHarness");

async function renderPane(t, skills) {
  return mountSkillsComponent(t, {
    modulePath: "/components/integrations/SkillsPane.tsx",
    exportName: "SkillsPane",
    skills,
    props: { title: "Skills", active: true },
    api: {
      skillsGet: async (name) => ({
        ...skills.find((entry) => entry.name === name),
        markdown: "---\nname: x\n---\n",
        files: [],
      }),
      skillsUninstall: async () => ({ ok: true }),
    },
  });
}

const find = (root, predicate) => findElement(root, predicate);
const heading = (container) => find(container, (node) => node.tagName === "H2");
const gear = (container) => find(container, (node) => ariaLabel(node) === "skills.pane.manage");
const buttonStarting = (root, text) =>
  find(root, (node) => node.tagName === "BUTTON" && label(node).startsWith(text));
const dialog = (container) => find(container, (node) => node.getAttribute("role") === "dialog");
const focused = (container) => container.ownerDocument.activeElement;

test("the gear opens Manage and the breadcrumb comes back to it", async (t) => {
  const { container } = await renderPane(t, [skill("meeting-prep")]);
  assert.equal(label(heading(container)), "Skills");

  await click(gear(container));
  assert.equal(label(heading(container)), "skills.manage.title");

  await click(buttonStarting(container, "skills.breadcrumb.root"));
  assert.equal(label(heading(container)), "Skills");
  assert.equal(focused(container) === gear(container), true);
});

test("Esc on a screen goes back, and focus returns to the See link that opened it", async (t) => {
  const seven = Array.from({ length: 7 }, (_, index) => skill(`skill-${index + 1}`));
  const { container } = await renderPane(t, seven);

  await click(buttonStarting(container, "skills.pane.seeOne"));
  assert.equal(label(heading(container)), "skills.manage.title");

  await pressEscape(find(container, (node) => node.tagName === "INPUT"));
  assert.equal(label(heading(container)), "Skills");
  assert.equal(focused(container) === buttonStarting(container, "skills.pane.seeOne"), true);
});

test("a card on home opens its detail pop-up", async (t) => {
  const { container } = await renderPane(t, [skill("meeting-prep")]);

  await click(find(container, (node) => ariaLabel(node).startsWith("skills.pane.cardLabel")));
  await settle();

  assert.match(label(dialog(container)), /meeting prep/);
});

test("Esc in the detail pop-up closes it without leaving Manage", async (t) => {
  const { container } = await renderPane(t, [skill("meeting-prep")]);
  await click(gear(container));
  await click(buttonStarting(container, "meeting prep"));
  await settle();
  assert.ok(dialog(container));

  await pressEscape(find(dialog(container), (node) => node.getAttribute("role") === "switch"));

  assert.equal(dialog(container), null);
  assert.equal(label(heading(container)), "skills.manage.title");
});

test("after an uninstall from the pop-up, focus moves to the screen's heading", async (t) => {
  const { container } = await renderPane(t, [skill("meeting-prep")]);
  await click(gear(container));
  await click(find(container, (node) => label(node) === "skills.menu.uninstall"));
  await settle();
  const confirm = find(container, (node) => node.getAttribute("role") === "alert");

  await click(buttonStarting(confirm, "skills.detail.uninstall"));
  await settle();

  assert.equal(dialog(container), null);
  assert.equal(focused(container) === heading(container), true);
});

test("an upload goes home, plays each new icon and focuses the first new card", async (t) => {
  let listed = [];
  const file = { name: "a.md", size: 3, arrayBuffer: async () => new ArrayBuffer(3) };
  const { container, store } = await mountSkillsComponent(t, {
    modulePath: "/components/integrations/SkillsPane.tsx",
    exportName: "SkillsPane",
    props: { title: "Skills", active: true },
    api: {
      skillsList: async () => ({ skills: listed }),
      skillsPreviewUpload: async () => ({
        items: [
          {
            fileName: "a.md",
            status: "ready",
            token: "token-a",
            name: "weekly-recap",
            displayName: "Weekly recap",
            problems: [],
            warnings: [],
          },
        ],
      }),
      skillsCommitUpload: async () => {
        listed = [skill("weekly-recap"), skill("older-skill")];
        return { installed: ["weekly-recap"], failed: [] };
      },
    },
  });

  await click(buttonStarting(container, "skills.pane.addMenu.upload"));
  assert.equal(label(heading(container)), "skills.upload.title");
  const zone = find(container, (node) => node.getAttribute("role") === "button");
  await React.act(async () => dispatch(zone, "drop", { dataTransfer: { files: [file] } }));
  await settle();
  await click(buttonStarting(container, "skills.upload.submitCount"));
  await settle();

  assert.equal(label(heading(container)), "Skills");
  const first = find(container, (node) => ariaLabel(node).startsWith("skills.pane.cardLabel"));
  assert.match(ariaLabel(first), /weekly recap/);
  assert.equal(focused(container) === first, true);
  assert.deepEqual(store.useSkillsStore.getState().iconPlays, { "weekly-recap": 1 });
});
