import { buildSkillBlock, buildSkillFileBlock } from "../../utils/skillContext";
import { requestSkillApproval, type SkillApprovalOutcome } from "../../stores/skillApprovalStore";
import type { SkillForModel, SkillProposal, SkillRef, SkillSummary } from "../../types/skills";
import type { ToolDefinition, ToolResult } from "./ToolRegistry";

const SKILL_CARD_SLOT = "skill_card";
const MAX_SKILL_CARDS_PER_ANSWER = 3;
const MAX_PROPOSAL_FILES = 20;

export interface SkillToolDeps {
  /** The user's skills that are switched on and valid; no other skill is ever read. */
  usable: SkillSummary[];
  /** Skills whose text this turn already carries. A getter: the registry outlives a send. */
  activeNames: () => ReadonlySet<string>;
  read: (ref: SkillRef & { file?: string }) => Promise<SkillForModel | null>;
  markUsed: (name: string) => void;
  /** What one load may hand the model, in estimated tokens. */
  maxTokens: number;
}

const failure = (displayText: string): ToolResult => ({ success: false, data: null, displayText });

export function createLoadSkillTool({
  usable,
  activeNames,
  read,
  markUsed,
  maxTokens,
}: SkillToolDeps): ToolDefinition {
  return {
    name: "load_skill",
    description:
      "Load one of the user's saved skills to follow it for the current request. Pass file to read one of the files a loaded skill lists.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          enum: usable.map((skill) => skill.name),
          description: "The skill's name, exactly as listed",
        },
        file: {
          type: "string",
          description: "Optional: a file the skill lists, such as references/examples.md",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    readOnly: true,

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const name = typeof args.name === "string" ? args.name : "";
      const file = typeof args.file === "string" && args.file ? args.file : undefined;
      const skill = usable.find((entry) => entry.name === name);
      if (!skill) return failure(`No skill named "${name}"`);
      if (!file && activeNames().has(name)) {
        return {
          success: true,
          data: `The ${name} skill is already loaded in this conversation. Follow it as given.`,
          displayText: skill.displayName,
        };
      }
      const loaded = await read(file ? { name, file } : { name });
      if (!loaded) {
        return failure(
          file
            ? `The ${name} skill has no file ${file} to read`
            : `The ${name} skill couldn't be read`
        );
      }
      markUsed(name);
      // A string, never an object: object results are saved with the chat as tool metadata.
      const data = file
        ? buildSkillFileBlock(loaded, file, maxTokens)
        : buildSkillBlock(loaded, maxTokens, { inlineFiles: false });
      return { success: true, data, displayText: skill.displayName };
    },
  };
}

const asText = (value: unknown): string => (typeof value === "string" ? value : "");

function proposedFiles(value: unknown): SkillProposal["files"] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((file) => typeof file?.path === "string" && typeof file?.content === "string")
    .map((file: { path: string; content: string }) => ({ path: file.path, content: file.content }));
}

function outcomeText(outcome: SkillApprovalOutcome): string {
  switch (outcome.state) {
    case "saved":
      return `Saved the ${outcome.name} skill. Tell the user it's saved and how it's used.${
        outcome.edited ? " The user edited it before saving." : ""
      }`;
    case "skipped":
      return "The user skipped it. Nothing was saved.";
    case "failed":
      return "It couldn't be saved. Say so and offer to try again.";
    case "not_saved":
      return "Nothing was saved.";
  }
}

export function createProposeSkillTool(): ToolDefinition {
  return {
    name: "propose_skill",
    description:
      "Propose a new skill for the user to save. Use it only when the user wants to make a skill. The user approves it on a card; nothing is saved before that.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          maxLength: 80,
          description: "Short and plain, such as Follow-up email from notes",
        },
        description: {
          type: "string",
          description: "What the skill does and when to use it, in one or two sentences",
        },
        instructions: {
          type: "string",
          description: "The skill's instructions, as short headed sections",
        },
        files: {
          type: "array",
          maxItems: MAX_PROPOSAL_FILES,
          description: "Optional files, such as references/examples.md",
          items: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
            additionalProperties: false,
          },
        },
      },
      required: ["title", "description", "instructions"],
      additionalProperties: false,
    },
    readOnly: false,

    async execute(args: Record<string, unknown>, context): Promise<ToolResult> {
      if (!context) return failure("A skill can only be proposed in a chat");
      if (!context.claimTurnSlot(SKILL_CARD_SLOT, MAX_SKILL_CARDS_PER_ANSWER)) {
        return failure("Only three skill cards per answer.");
      }
      const proposal: SkillProposal = {
        title: asText(args.title),
        description: asText(args.description),
        instructions: asText(args.instructions),
        files: proposedFiles(args.files),
      };
      const check = await window.electronAPI
        ?.skillsCheckProposal?.({ kind: "create", proposal })
        .catch(() => null);
      if (!check || !("problems" in check)) {
        context.releaseTurnSlot(SKILL_CARD_SLOT);
        return failure("The skill couldn't be checked");
      }
      // Problems go back to the model to fix; the user only ever sees a proposal that holds.
      if (check.problems.length > 0) {
        context.releaseTurnSlot(SKILL_CARD_SLOT);
        const codes = check.problems.map((problem) => problem.code).join(", ");
        return {
          success: true,
          data: `Not proposed: ${codes}. Fix these and call propose_skill again. Don't mention them to the user.`,
          displayText: "",
        };
      }
      const outcome = await requestSkillApproval(context, {
        kind: "create",
        name: check.name,
        replacesExisting: check.existing,
        draft: proposal,
      });
      // The card stands in for the step, so the step has no text of its own.
      return { success: true, data: outcomeText(outcome), displayText: "" };
    },
  };
}
