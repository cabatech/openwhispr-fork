const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const {
  SIGNED_OUT_AUTH_MOCK,
  addTeardown,
  createRendererServer,
  installBrowserGlobals,
} = require("../lib/rendererTestHarness");

const summary = (name, displayName, description, extra = {}) => ({
  name,
  displayName,
  description,
  enabled: true,
  valid: true,
  addedAt: "2026-10-01T09:00:00.000Z",
  updatedAt: "2026-10-01T09:00:00.000Z",
  lastUsedAt: null,
  ...extra,
});

const SKILLS = [
  summary("meeting-prep", "Meeting prep", "Briefs me before meetings."),
  summary("weekly-recap", "Weekly recap", "Recaps my week on Fridays."),
];

const forModel = (name, displayName, body, files = []) => ({ name, displayName, body, files });
const READABLE = {
  "meeting-prep": forModel("meeting-prep", "Meeting prep", "Steps for meeting prep.\n"),
  "weekly-recap": forModel("weekly-recap", "Weekly recap", "Steps for the recap.\n"),
  "builtin:skill-creator": forModel("skill-creator", "Skill creator", "# Skill creator\nAsk.\n"),
};

const MEETING_PREP_BLOCK =
  '<skill_content name="meeting-prep" title="Meeting prep">\nSteps for meeting prep.\n' +
  "</skill_content>";

// The library as main serves it: the list, and a read that names only switched-on skills.
function skillsApi({ skills = SKILLS, readable = READABLE } = {}) {
  const calls = { list: 0, reads: [] };
  return {
    calls,
    api: {
      skillsList: async () => {
        calls.list += 1;
        return { skills };
      },
      skillsReadForModel: async (ref) => {
        calls.reads.push(ref);
        return readable[ref.builtin ? `builtin:${ref.name}` : ref.name] ?? null;
      },
      skillsMarkUsed: async () => {},
    },
  };
}

// Drives the real useChatStreaming hook (one synchronous render, then its sendToAI
// closure), with the stream stubbed so the test can read what each send hands the model.
// With `sender`, useChatMessageSender sits in front of it, as in the chat view.
async function renderChat(t, hookOptions = {}, { settings = {}, electronAPI = {} } = {}) {
  installBrowserGlobals(t, {
    initialStorage: { isSubscribed: "true" },
    window: { electronAPI },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-chat-streaming-skills-test-",
    mockModules: SIGNED_OUT_AUTH_MOCK,
  });
  const [{ default: viteI18next }, { initReactI18next }] = await Promise.all([
    vite.ssrLoadModule("i18next"),
    vite.ssrLoadModule("react-i18next"),
  ]);
  if (!viteI18next.isInitialized) {
    const translation = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
    );
    await viteI18next.use(initReactI18next).init({
      lng: "en",
      resources: { en: { translation } },
      interpolation: { escapeValue: false },
    });
  }

  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.10.0", policy: null });
  useSettingsStore.setState({ chatAgentMode: "openwhispr", isSignedIn: true, ...settings });

  const { useChatStreaming } = await vite.ssrLoadModule("/components/chat/useChatStreaming.ts");
  const { useChatMessageSender } = await vite.ssrLoadModule(
    "/components/chat/useChatMessageSender.ts"
  );
  await (await vite.ssrLoadModule("/i18n.ts")).default.changeLanguage("en");
  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  addTeardown(t, () => reasoningService.destroy());

  const offeredTools = [];
  const sentMessages = [];
  const endStream = async function* () {
    yield { type: "done", finishReason: "stop" };
  };
  t.mock.method(reasoningService, "processTextStreamingCloud", (messages, config) => {
    sentMessages.push(messages);
    offeredTools.push((config.tools ?? []).map((tool) => tool.name));
    return endStream();
  });
  t.mock.method(
    reasoningService,
    "processTextStreamingAI",
    (messages, _model, _provider, _config, tools) => {
      sentMessages.push(messages);
      offeredTools.push(Object.keys(tools ?? {}));
      return endStream();
    }
  );

  let messages = [];
  const setMessages = (updater) => {
    messages = typeof updater === "function" ? updater(messages) : updater;
  };
  const saved = [];
  const persistence = {
    get messages() {
      return messages;
    },
    setMessages,
    saveUserMessage: async (text) => saved.push(text),
    getSessionVersion: () => 1,
  };
  let captured = null;
  let send = null;
  function Harness() {
    captured = useChatStreaming({ messages, setMessages, ...hookOptions });
    send = useChatMessageSender({
      conversationId: 1,
      persistence,
      streaming: captured,
      createConversation: async () => 1,
    });
    return null;
  }
  renderToStaticMarkup(React.createElement(Harness));
  return {
    captured,
    send,
    saved,
    offeredTools,
    sentMessages,
    reasoningService,
    getMessages: () => messages,
    vite,
  };
}

const SKILLS_ON = { skillsEnabled: true };
const MEETING_PREP = { attachedSkill: { name: "meeting-prep" } };
const BYOK = {
  chatAgentMode: "providers",
  chatAgentProvider: "openai",
  chatAgentModel: "gpt-5-mini",
};
const LOCAL_SMALL = {
  chatAgentMode: "local",
  chatAgentProvider: "qwen",
  chatAgentModel: "qwen3-1.7b-q4_k_m",
};

const userMessage = (id, content) => ({ id, role: "user", content, isStreaming: false });
const assistantMessage = (id, content) => ({ id, role: "assistant", content, isStreaming: false });
const userTurns = (sent) => sent.filter((message) => message.role === "user");
const latestUserText = (sent) => userTurns(sent).at(-1).content;
const withRequest = (block, request) => `${block}\n\nUser request:\n${request}`;

test("the saved user message is exactly what was typed", async (t) => {
  const { api } = skillsApi();
  const { send, saved, sentMessages, getMessages } = await renderChat(t, SKILLS_ON, {
    electronAPI: api,
  });

  await send("prep me for my 2pm", MEETING_PREP);

  assert.deepEqual(saved, ["prep me for my 2pm"]);
  assert.equal(getMessages()[0].content, "prep me for my 2pm");
  assert.equal(
    latestUserText(sentMessages[0]),
    withRequest(MEETING_PREP_BLOCK, "prep me for my 2pm")
  );
});

test("the skill block rides only in the latest user turn sent to the model", async (t) => {
  const { api } = skillsApi();
  const { captured, sentMessages } = await renderChat(t, SKILLS_ON, { electronAPI: api });
  const history = [
    userMessage("u1", "Hi"),
    assistantMessage("a1", "Hello! What can I do?"),
    userMessage("u2", "prep me"),
  ];

  await captured.sendToAI("prep me", history, MEETING_PREP);

  const [system, ...turns] = sentMessages[0];
  assert.doesNotMatch(system.content, /skill_content|Steps for meeting prep/);
  assert.deepEqual(
    turns.map((turn) => turn.content),
    ["Hi", "Hello! What can I do?", withRequest(MEETING_PREP_BLOCK, "prep me")]
  );
});

test("an earlier turn's skill block is not replayed", async (t) => {
  const { api } = skillsApi();
  const { captured, sentMessages } = await renderChat(t, SKILLS_ON, { electronAPI: api });
  const first = [userMessage("u1", "prep me")];
  await captured.sendToAI("prep me", first, MEETING_PREP);

  const second = [...first, assistantMessage("a1", "Done."), userMessage("u2", "and the agenda?")];
  await captured.sendToAI("and the agenda?", second, MEETING_PREP);

  assert.deepEqual(
    userTurns(sentMessages[1]).map((turn) => turn.content),
    ["prep me", withRequest(MEETING_PREP_BLOCK, "and the agenda?")]
  );
});

for (const [mode, settings] of Object.entries({ cloud: {}, byok: BYOK, local: LOCAL_SMALL })) {
  test(`an attached skill is sent on the ${mode} path`, async (t) => {
    const { api, calls } = skillsApi();
    const { captured, sentMessages, reasoningService } = await renderChat(t, SKILLS_ON, {
      settings,
      electronAPI: api,
    });

    await captured.sendToAI("prep me", [userMessage("u1", "prep me")], MEETING_PREP);

    const stream =
      mode === "cloud"
        ? reasoningService.processTextStreamingCloud
        : reasoningService.processTextStreamingAI;
    assert.equal(stream.mock.callCount(), 1);
    assert.equal(latestUserText(sentMessages[0]), withRequest(MEETING_PREP_BLOCK, "prep me"));
    // A model without tools can't ask for a file, so its files come with the skill.
    assert.deepEqual(calls.reads, [{ name: "meeting-prep", withFiles: mode === "local" }]);
  });
}

test("an attached skill on a local model is cut to 2,500 tokens, files first", async (t) => {
  const { estimateNoteTokens } = await import("../../src/helpers/noteChunking.js");
  const body = Array.from({ length: 150 }, (_, index) => `Step ${index + 1}: check it.`).join("\n");
  const file = (filePath, content) => ({
    path: filePath,
    size: content.length,
    text: true,
    script: false,
    content,
  });
  const { api } = skillsApi({
    readable: {
      "meeting-prep": forModel("meeting-prep", "Meeting prep", body, [
        file("references/a.md", "A".repeat(3_000)),
        file("references/b.md", "B".repeat(9_000)),
      ]),
    },
  });
  const { captured, sentMessages } = await renderChat(t, SKILLS_ON, {
    settings: LOCAL_SMALL,
    electronAPI: api,
  });

  await captured.sendToAI("prep me", [userMessage("u1", "prep me")], MEETING_PREP);

  const [block] = latestUserText(sentMessages[0]).split("\n\nUser request:\n");
  assert.ok(estimateNoteTokens(block) <= 2_500, String(estimateNoteTokens(block)));
  assert.ok(block.includes(`${body}\n<skill_file path="references/a.md">`), "the body is whole");
  assert.ok(block.includes("[Left out to fit: references/b.md]"));
});

test("with skills off, nothing changes", async (t) => {
  const { api, calls } = skillsApi();
  const history = [userMessage("u1", "prep me")];
  const off = await renderChat(t, {}, { electronAPI: api });
  await off.captured.sendToAI("prep me", history, MEETING_PREP);
  const today = await renderChat(t, {}, { electronAPI: {} });
  await today.captured.sendToAI("prep me", history);

  assert.deepEqual(off.sentMessages, today.sentMessages);
  assert.deepEqual(off.offeredTools, today.offeredTools);
  assert.deepEqual(calls, { list: 0, reads: [] });
});

test("a request text or selection and an attached skill compose in that order", async (t) => {
  const { api } = skillsApi();
  const { captured, sentMessages, vite } = await renderChat(t, SKILLS_ON, { electronAPI: api });
  const { buildAgentRequestText } = await vite.ssrLoadModule("/utils/agentSelectionContext.ts");
  const selectedContext = { text: "The long paragraph.", sourceMessageId: "a1" };

  await captured.sendToAI("Summary", [userMessage("u1", "Summary")], {
    ...MEETING_PREP,
    requestText: "Summarize the open note.",
  });
  await captured.sendToAI("shorter", [userMessage("u1", "shorter")], {
    ...MEETING_PREP,
    selectedContext,
  });

  assert.equal(
    latestUserText(sentMessages[0]),
    withRequest(MEETING_PREP_BLOCK, "Summarize the open note.")
  );
  assert.equal(
    latestUserText(sentMessages[1]),
    withRequest(MEETING_PREP_BLOCK, buildAgentRequestText("shorter", selectedContext))
  );
});

test("the attached creator learns the user's skills, connected apps and tool use", async (t) => {
  const creator = { attachedSkill: { name: "skill-creator", builtin: true } };
  const cloud = skillsApi();
  const tools = await renderChat(t, { ...SKILLS_ON, allowConnectors: true }, {
    electronAPI: cloud.api,
  });
  const { useConnectorStatusStore } = await tools.vite.ssrLoadModule(
    "/stores/connectorStatusStore.ts"
  );
  useConnectorStatusStore.setState({
    statuses: { slack: { id: "slack", connected: true }, linear: { id: "linear" } },
    loaded: true,
  });
  await tools.captured.sendToAI("Make a skill", [userMessage("u1", "Make a skill")], creator);

  const block = latestUserText(tools.sentMessages[0]).split("\n\nUser request:\n")[0];
  assert.ok(block.startsWith('<skill_content name="skill-creator" title="Skill creator">\n'));
  assert.ok(
    block.endsWith(
      "</skill_content>\nThe user's skills (name: when to use it):\n" +
        "- meeting-prep: Briefs me before meetings.\n- weekly-recap: Recaps my week on Fridays.\n" +
        "Connected apps: Slack"
    ),
    block
  );
  assert.deepEqual(cloud.calls.reads, [{ name: "skill-creator", builtin: true, withFiles: false }]);

  // Connected but not usable here: a surface without connectors lists none.
  const local = skillsApi({ skills: [] });
  const noTools = await renderChat(t, SKILLS_ON, {
    settings: LOCAL_SMALL,
    electronAPI: local.api,
  });
  const localStatus = await noTools.vite.ssrLoadModule("/stores/connectorStatusStore.ts");
  localStatus.useConnectorStatusStore.setState({
    statuses: { slack: { id: "slack", connected: true } },
    loaded: true,
  });
  await noTools.captured.sendToAI("Make a skill", [userMessage("u1", "Make a skill")], creator);
  assert.ok(
    latestUserText(noTools.sentMessages[0]).includes(
      "</skill_content>\nThe user has no skills yet.\nConnected apps: none\n" +
        "This model can't call tools.\n\nUser request:\nMake a skill"
    )
  );
});
