import { buildSkillBlock, buildSkillFileBlock } from "../../utils/skillContext";
import type { SkillForModel, SkillRef, SkillSummary } from "../../types/skills";
import type { ToolDefinition, ToolResult } from "./ToolRegistry";

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

const notRead = (displayText: string): ToolResult => ({ success: false, data: null, displayText });

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
      if (!skill) return notRead(`No skill named "${name}"`);
      if (!file && activeNames().has(name)) {
        return {
          success: true,
          data: `The ${name} skill is already loaded in this conversation. Follow it as given.`,
          displayText: skill.displayName,
        };
      }
      const loaded = await read(file ? { name, file } : { name });
      if (!loaded) {
        return notRead(
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
