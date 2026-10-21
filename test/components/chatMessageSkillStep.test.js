const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("a completed load_skill step reads Using skill · name with the skill icon", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-chat-message-skill-step-test-",
  });
  const [{ default: i18next }, { initReactI18next }] = await Promise.all([
    vite.ssrLoadModule("i18next"),
    vite.ssrLoadModule("react-i18next"),
  ]);
  if (!i18next.isInitialized) {
    const translation = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
    );
    await i18next.use(initReactI18next).init({
      lng: "en",
      resources: { en: { translation } },
      interpolation: { escapeValue: false },
    });
  }
  const { ChatMessage } = await vite.ssrLoadModule("/components/chat/ChatMessage.tsx");
  const call = (status, result) => ({
    id: `c-${status}`,
    name: "load_skill",
    arguments: JSON.stringify({ name: "meeting-prep" }),
    status,
    result,
  });
  const render = (toolCall) =>
    renderToStaticMarkup(
      React.createElement(ChatMessage, {
        messageId: "m1",
        role: "assistant",
        content: "",
        isStreaming: false,
        toolCalls: [toolCall],
      })
    );

  const done = render(call("completed", "Meeting prep"));
  assert.ok(done.includes("Using skill · Meeting prep"), done);
  assert.ok(done.includes('data-icon="skill-stack"'));

  assert.ok(render(call("executing")).includes("Loading skill…"));
});
