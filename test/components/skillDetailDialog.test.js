const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");

const { findElement } = require("../lib/interactiveDom");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const {
  ariaLabel,
  click,
  label,
  mountSkillsComponent,
  pressEscape,
  settle,
  skill,
} = require("../lib/skillsHarness");

const MARKDOWN = "---\r\nname: meeting-prep\r\ndescription: Briefs me.\r\n---\r\n\r\n## Steps\r\n";
const FILES = [
  { path: "assets/logo.png", size: 3, text: false, script: false },
  { path: "references/notes.md", size: 5, text: true, script: false },
  { path: "scripts/export.sh", size: 11, text: true, script: true },
];

async function openDetail(t, { summary = skill("meeting-prep"), confirm = false, api = {} } = {}) {
  const calls = { openChange: [], uninstalled: 0, read: [], clipboard: [], switched: [] };
  const mounted = await mountSkillsComponent(t, {
    modulePath: "/components/skills/SkillDetailDialog.tsx",
    exportName: "SkillDetailDialog",
    skills: [summary],
    api: {
      skillsGet: async (name) => ({ ...summary, name, markdown: MARKDOWN, files: FILES }),
      skillsSetEnabled: async (name, enabled) => {
        calls.switched.push([name, enabled]);
        return summary.valid ? { ok: true } : { ok: false, error: "invalid" };
      },
      skillsUninstall: async () => ({ ok: true }),
      skillsReadFile: async (name, path) => {
        calls.read.push([name, path]);
        return { text: `text of ${path}` };
      },
      writeClipboard: async (text) => {
        calls.clipboard.push(text);
        return { success: true };
      },
      ...api,
    },
    wrap: (SkillDetailDialog) => {
      function Harness() {
        const [open, setOpen] = React.useState(true);
        return React.createElement(SkillDetailDialog, {
          name: summary.name,
          open,
          initialConfirmUninstall: confirm,
          onOpenChange: (next) => {
            calls.openChange.push(next);
            setOpen(next);
          },
          onUninstalled: () => calls.uninstalled++,
        });
      }
      return React.createElement(Harness);
    },
  });
  return { ...mounted, calls };
}

const byRole = (role) => (root) => findElement(root, (node) => node.getAttribute("role") === role);
const dialog = byRole("dialog");
const alert = byRole("alert");
const toggle = byRole("switch");
const button = (root, text) =>
  findElement(root, (node) => node.tagName === "BUTTON" && label(node) === text);

test("the pop-up renders the instructions without the header block", async (t) => {
  const { container } = await openDetail(t, {
    summary: skill("meeting-prep", { displayName: "Meeting prep", description: "Briefs me." }),
  });

  const markdown = findElement(container, (node) => node.getAttribute("data-markdown") !== null);
  assert.deepEqual(
    [markdown.getAttribute("data-markdown"), markdown.textContent],
    ["hide-frontmatter", MARKDOWN]
  );
  assert.match(label(dialog(container)), /Meeting prep\s*skills\.detail\.skillLabel/);
  const withText = (text) => findElement(container, (node) => label(node) === text);
  assert.equal(withText("Meeting prep").getAttribute("dir"), "auto");
  assert.equal(withText("Briefs me.").getAttribute("dir"), "auto");
});

test("Uninstall asks in the footer first and then removes the skill", async (t) => {
  const uninstalled = [];
  const { container, toasts, calls } = await openDetail(t, {
    summary: skill("meeting-prep", { displayName: "Meeting prep" }),
    api: {
      skillsUninstall: async (name) => {
        uninstalled.push(name);
        return { ok: true };
      },
    },
  });

  await click(button(container, "skills.detail.uninstall"));
  assert.equal(
    label(alert(container)),
    'skills.detail.uninstallConfirm{"name":"Meeting prep"}common.cancelskills.detail.uninstall'
  );
  const focused = () => container.ownerDocument.activeElement;
  assert.equal(focused() === button(alert(container), "common.cancel"), true);
  assert.deepEqual(uninstalled, []);

  await click(button(alert(container), "skills.detail.uninstall"));
  await settle();

  assert.deepEqual(uninstalled, ["meeting-prep"]);
  assert.deepEqual(calls.openChange, [false]);
  assert.equal(calls.uninstalled, 1);
  assert.deepEqual(toasts, [
    {
      title: 'skills.toasts.uninstalled{"name":"Meeting prep"}',
      description: "skills.toasts.removedFromComputer",
      variant: "success",
    },
  ]);
});

test("a failed uninstall keeps the pop-up open and says why", async (t) => {
  const { container, toasts, calls } = await openDetail(t, {
    api: { skillsUninstall: async () => ({ ok: false, error: "permission" }) },
  });

  await click(button(container, "skills.detail.uninstall"));
  await click(button(alert(container), "skills.detail.uninstall"));
  await settle();

  assert.deepEqual(calls.openChange, []);
  assert.deepEqual(toasts, [
    {
      title: "skills.toasts.writeFailed",
      description: "skills.toasts.writeFailedPermission",
      variant: "destructive",
    },
  ]);
});

test("Esc in the confirm cancels it, and Esc again closes the pop-up", async (t) => {
  const { container, calls } = await openDetail(t);

  await click(button(container, "skills.detail.uninstall"));
  await pressEscape(button(alert(container), "common.cancel"));
  assert.equal(alert(container), null);
  assert.deepEqual(calls.openChange, []);
  const uninstall = button(container, "skills.detail.uninstall");
  assert.equal(container.ownerDocument.activeElement === uninstall, true);

  await pressEscape(uninstall);
  assert.deepEqual(calls.openChange, [false]);
  assert.equal(dialog(container), null);
});

test("opening on its confirm focuses Cancel", async (t) => {
  const { container } = await openDetail(t, { confirm: true });

  const cancel = button(alert(container), "common.cancel");
  assert.equal(container.ownerDocument.activeElement === cancel, true);
});

test("scripts are labelled Shown, never run and binary files have no Copy button", async (t) => {
  const { container, calls } = await openDetail(t);
  const row = (path) =>
    findElement(
      container,
      (node) =>
        node.tagName === "DIV" &&
        node.childNodes.some((child) => child.tagName === "SPAN" && label(child) === path)
    );
  const copyButton = (path) =>
    findElement(row(path), (node) => node.tagName === "BUTTON" && ariaLabel(node).includes(path));

  assert.match(label(row("scripts/export.sh")), /skills\.detail\.neverRun/);
  assert.doesNotMatch(label(row("references/notes.md")), /skills\.detail\.neverRun/);
  assert.equal(copyButton("assets/logo.png"), null);
  for (const path of FILES.map((file) => file.path)) {
    const pathText = findElement(
      row(path),
      (node) => node.tagName === "SPAN" && label(node) === path
    );
    assert.equal(pathText.getAttribute("dir"), "ltr", path);
  }

  const copy = copyButton("references/notes.md");
  assert.equal(ariaLabel(copy), 'skills.detail.copyFile{"path":"references/notes.md"}');
  await click(copy);
  await settle();
  assert.deepEqual(calls.read, [["meeting-prep", "references/notes.md"]]);
  assert.deepEqual(calls.clipboard, ["text of references/notes.md"]);
  const copied = findElement(row("references/notes.md"), (node) => node.tagName === "BUTTON");
  assert.equal(ariaLabel(copied), "common.copied");
});

test("switching a skill on plays its icon once; switching it off doesn't", async (t) => {
  const { container, store, calls } = await openDetail(t, {
    summary: skill("meeting-prep", { enabled: false }),
  });
  const icon = () =>
    findElement(dialog(container), (node) => node.getAttribute("data-icon") === "skill-stack");
  const playing = () => /skill-icon-play/.test(icon().getAttribute("class") ?? "");
  assert.equal(playing(), false);
  assert.equal(ariaLabel(toggle(container)), 'skills.detail.toggle{"name":"meeting prep"}');

  await click(toggle(container));
  await settle();
  assert.equal(playing(), true);
  const played = icon();

  await click(toggle(container));
  await settle();
  assert.deepEqual(calls.switched, [
    ["meeting-prep", true],
    ["meeting-prep", false],
  ]);
  assert.equal(icon() === played, true);
  assert.equal(store.useSkillsStore.getState().iconPlays["meeting-prep"], 1);
});

test("an invalid skill's switch is disabled and its problem is shown", async (t) => {
  const { container } = await openDetail(t, {
    summary: skill("broken", { valid: false, problem: { code: "missingDescription" } }),
  });

  assert.equal(toggle(container).getAttribute("disabled"), "");
  assert.match(
    label(dialog(container)),
    /skills\.detail\.problem\{"reason":"skills\.problems\.missingDescription"\}/
  );
});

test("the reveal label follows the platform", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-platform-label-test-" });
  const { showInFolderLabelKey } = await vite.ssrLoadModule("/utils/platform.ts");

  assert.deepEqual(
    ["darwin", "win32", "linux"].map((platform) => showInFolderLabelKey(platform)),
    [
      "controlPanel.history.showInFolder",
      "controlPanel.history.showInFolderWindows",
      "controlPanel.history.showInFolderLinux",
    ]
  );
});
