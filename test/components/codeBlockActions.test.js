const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");
const {
  SKILLS_MOCKS,
  click,
  findAll,
  label,
  mountSkillsComponent,
  settle,
} = require("../lib/skillsHarness");

const CODE = "scripts/import-to-crm.sh --file acme.md\necho done";

async function mountActions(t, { paste = false, pasteText } = {}) {
  const calls = { clipboard: [], paste: [] };
  const mounted = await mountSkillsComponent(t, {
    modulePath: "/components/chat/CodeBlockActions.tsx",
    exportName: "CodeBlockActions",
    props: { code: CODE, paste },
    api: {
      writeClipboard: async (text) => {
        calls.clipboard.push(text);
        return { success: true };
      },
      pasteText: async (text, options) => {
        calls.paste.push([text, options]);
        return pasteText ? pasteText() : { success: true, pasted: true };
      },
    },
  });
  const button = (text) =>
    findAll(mounted.container, (node) => node.tagName === "BUTTON" && label(node) === text)[0];
  return { ...mounted, calls, button };
}

const toastTitles = (toasts) => toasts.map((toast) => toast.title);

test("Copy writes the code unchanged", async (t) => {
  const { calls, button } = await mountActions(t);

  await click(button("common.copy"));
  await settle();

  assert.deepEqual(calls.clipboard, [CODE]);
  assert.ok(button("common.copied"), "the button says it copied");
});

test("Paste into app sends the code unchanged with raw on", async (t) => {
  const { calls, button, toasts } = await mountActions(t, { paste: true });

  await click(button("skills.code.paste"));
  await settle();

  assert.deepEqual(calls.paste, [[CODE, { raw: true }]]);
  assert.deepEqual(toastTitles(toasts), ["skills.code.pasted"]);
});

test("a failed paste says the text is on the clipboard", async (t) => {
  // One card, three failures: a clipboard-only paste, a missing Accessibility permission,
  // and a paste that threw before the clipboard was known to hold the code.
  const failures = [
    () => ({ success: true, pasted: false }),
    () => ({ success: false, pasted: false, code: "ACCESSIBILITY_PERMISSION_REQUIRED" }),
    () => Promise.reject(new Error("paste failed")),
  ];
  const { calls, button, toasts } = await mountActions(t, {
    paste: true,
    pasteText: () => failures.shift()(),
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await click(button("skills.code.paste"));
    await settle();
  }

  assert.deepEqual(toastTitles(toasts), Array(3).fill("skills.code.pasteFailed"));
  assert.deepEqual(calls.clipboard, [CODE], "only the throw needed the code put back");
});

test("the main chat shows Copy only on its code blocks", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installInteractiveDom(t);
  const { createRoot } = require("react-dom/client");
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-code-block-actions-chat-test-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": SKILLS_MOCKS["react-i18next"],
      "/ui/useToast": SKILLS_MOCKS["/ui/useToast"],
    },
  });
  const { ChatMessage } = await vite.ssrLoadModule("/components/chat/ChatMessage.tsx");
  root = createRoot(container);
  await React.act(async () =>
    root.render(
      React.createElement(ChatMessage, {
        messageId: "m1",
        role: "assistant",
        content: "Run this:\n\n```sh\nls -la\n```\n",
        isStreaming: false,
      })
    )
  );

  const buttons = findAll(container, (node) => node.tagName === "BUTTON").map(label);
  assert.ok(buttons.includes("common.copy"), buttons.join(", "));
  assert.ok(!buttons.includes("skills.code.paste"));
});

test("the voice panel's code blocks add Paste into app and its small print", async (t) => {
  const { button, container } = await mountActions(t, { paste: true });

  assert.ok(button("common.copy"));
  assert.ok(button("skills.code.paste"));
  assert.match(container.textContent, /skills\.code\.pasteNote/);
});
