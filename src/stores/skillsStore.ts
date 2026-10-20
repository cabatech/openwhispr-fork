import { create } from "zustand";
import type { SkillSummary, SkillUploadItem } from "../types/skills";

/** What Create skill holds, kept here so it survives leaving the page. */
export interface SkillCreateDraft {
  title: string;
  description: string;
  instructions: string;
  files: SkillUploadItem[];
}

interface SkillsState {
  skills: SkillSummary[];
  loaded: boolean;
  loadError: boolean;
  createDraft: SkillCreateDraft | null;
  /** Bumped to play a skill's icon once; see components/skills/SkillIcon. */
  iconPlays: Record<string, number>;
}

export const useSkillsStore = create<SkillsState>(() => ({
  skills: [],
  loaded: false,
  loadError: false,
  createDraft: null,
  iconPlays: {},
}));

let subscribed = false;
let loading: Promise<void> | null = null;
let reloadRequested = false;

// The library rereads its folder on every list, so an edit made outside the app shows up
// when the window comes back into focus.
function subscribe(): void {
  if (subscribed) return;
  subscribed = true;
  window.electronAPI?.onSkillsChanged?.(() => void refreshSkills());
  window.addEventListener("focus", () => void refreshSkills());
}

/** Reloads the list. A refresh asked for during a load runs once that load finishes. */
export function refreshSkills(): Promise<void> {
  subscribe();
  if (loading) {
    reloadRequested = true;
    return loading;
  }
  loading = (async () => {
    try {
      do {
        reloadRequested = false;
        const result = await window.electronAPI?.skillsList?.();
        useSkillsStore.setState({ skills: result?.skills ?? [], loaded: true, loadError: false });
      } while (reloadRequested);
    } catch {
      useSkillsStore.setState({ loadError: true });
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** Loads the list once per window. */
export async function ensureSkills(): Promise<void> {
  subscribe();
  if (!useSkillsStore.getState().loaded) await refreshSkills();
}

export function setCreateDraft(createDraft: SkillCreateDraft | null): void {
  useSkillsStore.setState({ createDraft });
}

export function playSkillIcon(name: string): void {
  useSkillsStore.setState((state) => ({
    iconPlays: { ...state.iconPlays, [name]: (state.iconPlays[name] ?? 0) + 1 },
  }));
}

/** Switching a skill on plays its icon; a skill that needs fixing can't be switched on. */
export async function setSkillEnabled(name: string, enabled: boolean): Promise<boolean> {
  const result = await window.electronAPI?.skillsSetEnabled?.(name, enabled);
  if (!result?.ok) return false;
  useSkillsStore.setState((state) => ({
    skills: state.skills.map((skill) => (skill.name === name ? { ...skill, enabled } : skill)),
  }));
  if (enabled) playSkillIcon(name);
  return true;
}
