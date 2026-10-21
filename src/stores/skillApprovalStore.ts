import { create } from "zustand";
import type { ToolExecutionContext } from "../services/tools/ToolRegistry";
import type { SkillProposal } from "../types/skills";
import { APPROVAL_TTL_MS, approvalKey } from "./connectorApprovalStore";
import { playSkillIcon } from "./skillsStore";

// A skill card writes only on this computer, through the skills IPC. It never goes through
// the connector approval path, which refuses signed out, on the free plan or under policy.

export type SkillApprovalState =
  "pending" | "saving" | "saved" | "failed" | "skipped" | "not_saved" | "undone";

export interface SkillApprovalEntry {
  /** approvalKey(messageId, toolCallId). */
  key: string;
  messageId: string;
  toolCallId: string;
  kind: "create";
  /** The folder it writes. */
  name: string;
  /** A skill already has this name, so saving updates it. */
  replacesExisting?: boolean;
  /** What Save writes; Edit changes it. */
  draft: SkillProposal;
  /** As proposed, to tell the model whether the user edited it. */
  original: SkillProposal;
  state: SkillApprovalState;
  /** The copy Undo restores, after a save that replaced a skill. */
  versionId?: string;
}

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

const copyProposal = (proposal: SkillProposal): SkillProposal => ({
  ...proposal,
  files: proposal.files.map((file) => ({ ...file })),
});

function proposalEdited(draft: SkillProposal, original: SkillProposal): boolean {
  return (
    draft.title !== original.title ||
    draft.description !== original.description ||
    draft.instructions !== original.instructions ||
    JSON.stringify(draft.files) !== JSON.stringify(original.files)
  );
}

function entryFor(key: string): SkillApprovalEntry | undefined {
  return useSkillApprovalStore.getState().entries[key];
}

function patchEntry(key: string, patch: Partial<SkillApprovalEntry>): void {
  useSkillApprovalStore.setState((state) => {
    const entry = state.entries[key];
    if (!entry) return state;
    return { entries: { ...state.entries, [key]: { ...entry, ...patch } } };
  });
}

function settle(
  key: string,
  outcome: SkillApprovalOutcome,
  patch: Partial<SkillApprovalEntry>
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
  request: Pick<SkillApprovalEntry, "kind" | "name" | "replacesExisting" | "draft">
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
    useSkillApprovalStore.setState((state) => ({
      entries: {
        ...state.entries,
        [key]: {
          key,
          messageId,
          toolCallId,
          ...request,
          draft: copyProposal(request.draft),
          original: copyProposal(request.draft),
          state: "pending",
        },
      },
    }));
    context.onApprovalRequested();
  });
}

export function updateSkillDraft(key: string, patch: Partial<SkillProposal>): void {
  const entry = entryFor(key);
  if (!entry || entry.state !== "pending") return;
  patchEntry(key, { draft: { ...entry.draft, ...patch } });
}

// Save writes the draft the card shows, edits included, and main checks it again first.
export async function saveSkillApproval(key: string): Promise<void> {
  const entry = entryFor(key);
  if (!entry || entry.state !== "pending") return;
  patchEntry(key, { state: "saving" });
  const result = await window.electronAPI?.skillsSaveProposal?.(entry.draft).catch(() => null);
  if (!result?.ok) {
    settle(key, { state: "failed" }, { state: "failed" });
    return;
  }
  playSkillIcon(result.name);
  settle(
    key,
    { state: "saved", name: result.name, edited: proposalEdited(entry.draft, entry.original) },
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
  if (result?.ok) patchEntry(key, { state: "undone" });
}
