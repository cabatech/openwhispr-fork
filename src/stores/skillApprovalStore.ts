import { create } from "zustand";
import type { ToolExecutionContext } from "../services/tools/ToolRegistry";
import type { SkillProposal, SkillUpdate } from "../types/skills";
import { APPROVAL_TTL_MS, approvalKey } from "./connectorApprovalStore";
import { playSkillIcon } from "./skillsStore";

// A skill card writes only on this computer, through the skills IPC. It never goes through
// the connector approval path, which refuses signed out, on the free plan or under policy.

export type SkillApprovalState =
  | "pending"
  | "saving"
  | "saved"
  | "failed"
  | "skipped"
  | "not_saved"
  | "undone"
  /** Undo refused: the skill changed again after this card saved it. */
  | "changed_since";

interface SkillApprovalBase {
  /** approvalKey(messageId, toolCallId). */
  key: string;
  messageId: string;
  toolCallId: string;
  /** The folder it writes. */
  name: string;
  state: SkillApprovalState;
  /** The copy Undo restores, after a save that replaced a skill's folder. */
  versionId?: string;
}

/** A new skill. One named like a skill the user has updates it. */
export interface SkillCreateApproval extends SkillApprovalBase {
  kind: "create";
  /** A skill already has this name, so saving updates it. */
  replacesExisting?: boolean;
  /** What Save writes; Edit changes it. */
  draft: SkillProposal;
  /** As proposed, to tell the model whether the user edited it. */
  original: SkillProposal;
}

/** A change to one of the user's skills. */
export interface SkillUpdateApproval extends SkillApprovalBase {
  kind: "update";
  displayName: string;
  draft: SkillUpdate;
  original: SkillUpdate;
  /** The skill's text before the change, for the diff. */
  current: { description: string; instructions: string; files: Record<string, string> };
  /** One line: what changes and why. */
  intent: string;
  removals: string[];
  learnedFrom: { title: string; createdAt: string } | null;
}

export type SkillApprovalEntry = SkillCreateApproval | SkillUpdateApproval;

type SkillApprovalRequest =
  | Pick<SkillCreateApproval, "kind" | "name" | "replacesExisting" | "draft">
  | Pick<
      SkillUpdateApproval,
      "kind" | "name" | "displayName" | "draft" | "current" | "intent" | "removals" | "learnedFrom"
    >;

export type SkillApprovalOutcome =
  | { state: "saved"; name: string; edited: boolean }
  | { state: "skipped" }
  | { state: "failed" }
  | { state: "not_saved"; reason: "expired" | "conversation_ended" | "duplicate_tool_call" };

export const useSkillApprovalStore = create<{ entries: Record<string, SkillApprovalEntry> }>(
  () => ({ entries: {} })
);

interface PendingResolution {
  resolve: (outcome: SkillApprovalOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  detach: () => void;
}

// Promise resolvers stay outside zustand state: they are not renderable.
const resolutions = new Map<string, PendingResolution>();

// The draft and the original are copies, so an edit never reaches back into the request.
const copyDraft = <T extends SkillProposal | SkillUpdate>(draft: T): T => ({
  ...draft,
  files: draft.files.map((file) => ({ ...file })),
});

function entryFor(key: string): SkillApprovalEntry | undefined {
  return useSkillApprovalStore.getState().entries[key];
}

function patchEntry(
  key: string,
  patch:
    | Partial<SkillApprovalBase & Pick<SkillCreateApproval, "replacesExisting">>
    | { draft: SkillProposal | SkillUpdate }
): void {
  useSkillApprovalStore.setState((state) => {
    const entry = state.entries[key];
    if (!entry) return state;
    // A patch keeps the entry's kind: a draft is only ever replaced by its own kind.
    return { entries: { ...state.entries, [key]: { ...entry, ...patch } as SkillApprovalEntry } };
  });
}

function settle(
  key: string,
  outcome: SkillApprovalOutcome,
  patch: Partial<SkillApprovalBase>
): void {
  const pending = resolutions.get(key);
  if (!pending) return;
  resolutions.delete(key);
  clearTimeout(pending.timer);
  pending.detach();
  patchEntry(key, patch);
  pending.resolve(outcome);
}

// The turn ending and expiry only withdraw a card that is still pending: a save in progress
// finishes, and its card shows how it went.
function withdraw(key: string, reason: "conversation_ended" | "expired"): void {
  if (entryFor(key)?.state !== "pending") return;
  settle(key, { state: "not_saved", reason }, { state: "not_saved" });
}

export function requestSkillApproval(
  context: ToolExecutionContext,
  request: SkillApprovalRequest
): Promise<SkillApprovalOutcome> {
  const { messageId, toolCallId, signal } = context;
  const key = approvalKey(messageId, toolCallId);
  if (signal.aborted) return Promise.resolve({ state: "not_saved", reason: "conversation_ended" });
  // A second request for the same message and tool call must never steal the first card.
  if (resolutions.has(key)) {
    return Promise.resolve({ state: "not_saved", reason: "duplicate_tool_call" });
  }
  return new Promise((resolve) => {
    const onAbort = (): void => withdraw(key, "conversation_ended");
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => withdraw(key, "expired"), APPROVAL_TTL_MS);
    resolutions.set(key, {
      resolve,
      timer,
      detach: () => signal.removeEventListener("abort", onAbort),
    });
    const entry = {
      key,
      messageId,
      toolCallId,
      ...request,
      draft: copyDraft(request.draft),
      original: copyDraft(request.draft),
      state: "pending",
    } as SkillApprovalEntry;
    useSkillApprovalStore.setState((state) => ({ entries: { ...state.entries, [key]: entry } }));
    context.onApprovalRequested();
  });
}

export function updateSkillDraft(
  key: string,
  patch: Partial<SkillProposal> | Partial<SkillUpdate>
): void {
  const entry = entryFor(key);
  if (!entry || entry.state !== "pending") return;
  patchEntry(key, { draft: { ...entry.draft, ...patch } as SkillProposal | SkillUpdate });
}

// Save writes the draft the card shows, edits included, and main checks it again first.
export async function saveSkillApproval(key: string): Promise<void> {
  const entry = entryFor(key);
  if (!entry || entry.state !== "pending") return;
  patchEntry(key, { state: "saving" });
  if (entry.kind === "create") {
    // An edited title can name a skill the user already has, and saving would replace it.
    // The card says so first, and the next Save confirms.
    const check = await window.electronAPI
      ?.skillsCheckProposal?.({ kind: "create", proposal: entry.draft })
      .catch(() => null);
    if (!check || !("existing" in check)) {
      settle(key, { state: "failed" }, { state: "failed" });
      return;
    }
    if (check.existing && !(entry.replacesExisting && check.name === entry.name)) {
      patchEntry(key, { state: "pending", name: check.name, replacesExisting: true });
      return;
    }
  }
  const saving =
    entry.kind === "update"
      ? window.electronAPI?.skillsApplyUpdate?.(entry.draft)
      : window.electronAPI?.skillsSaveProposal?.(entry.draft);
  const result = await saving?.catch(() => null);
  if (!result?.ok) {
    settle(key, { state: "failed" }, { state: "failed" });
    return;
  }
  if (entry.kind === "create") playSkillIcon(result.name);
  const edited = JSON.stringify(entry.draft) !== JSON.stringify(entry.original);
  settle(
    key,
    { state: "saved", name: result.name, edited },
    { state: "saved", name: result.name, versionId: result.versionId }
  );
}

export function skipSkillApproval(key: string): void {
  if (entryFor(key)?.state !== "pending") return;
  settle(key, { state: "skipped" }, { state: "skipped" });
}

/** Puts back the skill a save replaced; the tool call has already settled by then. */
export async function undoSkillApproval(key: string): Promise<void> {
  const entry = entryFor(key);
  if (!entry || entry.state !== "saved" || !entry.versionId) return;
  const result = await window.electronAPI
    ?.skillsUndo?.(entry.name, entry.versionId)
    .catch(() => null);
  // Main refuses once a later save changed the skill: undoing this one would lose that.
  if (result) patchEntry(key, { state: result.ok ? "undone" : "changed_since" });
}
