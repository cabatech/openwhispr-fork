import { estimateNoteTokens, planNoteChunks } from "../helpers/noteChunking";
import { HISTORY_LIMIT } from "../components/chat/historyMessages";
import type { Message } from "../components/chat/types";
import type { SkillForModel, SkillRef, SkillSummary } from "../types/skills";

/** The skills list in the system prompt: about 2% of a hosted model's context, or a 16k local one's. */
export const SKILL_CATALOG_MAX_TOKENS = { hosted: 2_000, selfHosted: 330 } as const;
/** The text of the skills one turn uses. */
export const SKILL_CONTEXT_MAX_TOKENS = { hosted: 16_000, selfHosted: 2_500 } as const;
export type SkillTier = keyof typeof SKILL_CONTEXT_MAX_TOKENS;

const SCRIPTS_NOTE = "scripts are shown to the user to run, never run by you";
const SKILL_CUT = "[The rest of this skill was cut to fit.]";
const FILE_CUT = "[The rest of this file was cut to fit.]";

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
// A skill's text is data: a closing tag inside it must not end its block early.
const asData = (text: string): string => text.replace(/<\/skill_/g, "<\\/skill_").trimEnd();
const asAttribute = (text: string): string => oneLine(text).replace(/"/g, "&quot;");
const lastUse = (skill: SkillSummary): string => skill.lastUsedAt ?? "";

// The leading whole lines of `text` that fit, marked when cut. One token stays free for the
// line break before the marker.
function cutToFit(text: string, maxTokens: number, marker: string): string {
  if (estimateNoteTokens(text) <= maxTokens) return text;
  const room = maxTokens - estimateNoteTokens(marker) - 1;
  const kept = room > 0 ? (planNoteChunks(text, room)[0] ?? "") : "";
  return kept ? `${kept}\n${marker}` : marker;
}

function filesLine(files: SkillForModel["files"], inlineFiles: boolean): string {
  if (files.length === 0) return "";
  const note = inlineFiles
    ? SCRIPTS_NOTE
    : `read one with load_skill and its file; ${SCRIPTS_NOTE}`;
  return `Files: ${files.map((file) => file.path).join(", ")} (${note})`;
}

const fileBlock = (file: SkillForModel["files"][number]): string =>
  `<skill_file path="${asAttribute(file.path)}">\n${asData(file.content ?? "")}\n</skill_file>`;

/**
 * One line per skill, most recently used first. Past the budget the least-used lose their
 * descriptions, but every name stays.
 */
export function buildSkillCatalog(skills: SkillSummary[], maxTokens: number): string {
  const ordered = [...skills].sort((a, b) =>
    lastUse(a) < lastUse(b) ? 1 : lastUse(a) > lastUse(b) ? -1 : 0
  );
  const lines = ordered.map((skill) => `- ${skill.name}: ${oneLine(skill.description)}`);
  for (
    let index = lines.length - 1;
    index >= 0 && estimateNoteTokens(lines.join("\n")) > maxTokens;
    index -= 1
  ) {
    lines[index] = `- ${ordered[index].name}`;
  }
  return lines.join("\n");
}

/**
 * A skill's instructions as data for the model. Inline files (for a model without tools) are
 * cut first, then the instructions, and either cut is marked.
 */
export function buildSkillBlock(
  skill: SkillForModel,
  maxTokens: number,
  { inlineFiles }: { inlineFiles: boolean }
): string {
  const open = `<skill_content name="${asAttribute(skill.name)}" title="${asAttribute(skill.displayName)}">`;
  const close = ["</skill_content>", filesLine(skill.files, inlineFiles)]
    .filter(Boolean)
    .join("\n");
  const inline = inlineFiles ? skill.files.filter((file) => file.content !== undefined) : [];
  const render = (body: string, included: number): string => {
    const leftOut = inline.slice(included).map((file) => file.path);
    return [
      open,
      body,
      ...inline.slice(0, included).map(fileBlock),
      ...(leftOut.length > 0 ? [`[Left out to fit: ${leftOut.join(", ")}]`] : []),
      close,
    ].join("\n");
  };

  const body = asData(skill.body);
  const fitted = cutToFit(body, maxTokens - estimateNoteTokens(render("", 0)), SKILL_CUT);
  if (fitted !== body) return render(fitted, 0);
  let included = 0;
  while (included < inline.length && estimateNoteTokens(render(body, included + 1)) <= maxTokens) {
    included += 1;
  }
  return render(body, included);
}

/** One file of a skill, read with load_skill. */
export function buildSkillFileBlock(skill: SkillForModel, path: string, maxTokens: number): string {
  const content = asData(skill.files.find((file) => file.path === path)?.content ?? "");
  const render = (text: string): string =>
    `<skill_file skill="${asAttribute(skill.name)}" path="${asAttribute(path)}">\n${text}\n</skill_file>`;
  return render(cutToFit(content, maxTokens - estimateNoteTokens(render("")), FILE_CUT));
}

function loadedSkillName(argumentsJson: string): string | null {
  try {
    const args = JSON.parse(argumentsJson);
    return typeof args?.name === "string" && !args.file ? args.name : null;
  } catch {
    return null;
  }
}

/**
 * The skills a turn uses: the attached one, then those load_skill read in the history the
 * model sees, newest first, so a full budget leaves out the oldest.
 */
export function activeSkillNames(history: Message[], attached?: SkillRef): SkillRef[] {
  const active: SkillRef[] = attached ? [attached] : [];
  const seen = new Set(attached && !attached.builtin ? [attached.name] : []);
  for (const message of history.slice(-HISTORY_LIMIT).reverse()) {
    for (const call of [...(message.toolCalls ?? [])].reverse()) {
      if (call.name !== "load_skill" || call.status !== "completed") continue;
      const name = loadedSkillName(call.arguments);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      active.push({ name });
    }
  }
  return active;
}

/** The latest user turn as only the model sees it: the skills first, then the request. */
export function withSkillContext(userText: string, blocks: string[]): string {
  return [...blocks, "", "User request:", userText].join("\n");
}
