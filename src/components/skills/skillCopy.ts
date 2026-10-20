import type { TFunction } from "i18next";
import type {
  SkillIssue,
  SkillProblemCode,
  SkillWarningCode,
  SkillWriteError,
} from "../../types/skills";

/** The starter skills shipped in src/helpers/skills/recommended, by folder name. */
export const RECOMMENDED_SKILL_IDS = [
  "action-items-to-linear",
  "meeting-summary-to-slack",
  "one-on-one-prep",
  "decision-log",
] as const;

const WRITE_ERROR_REASONS: Partial<Record<SkillWriteError, string>> = {
  noSpace: "skills.toasts.writeFailedNoSpace",
  permission: "skills.toasts.writeFailedPermission",
};

/** The toast for a save that failed, with its reason when there is one. */
export function writeFailedToast(t: TFunction, error?: string) {
  const reason = error ? WRITE_ERROR_REASONS[error as SkillWriteError] : undefined;
  return {
    title: t("skills.toasts.writeFailed"),
    ...(reason ? { description: t(reason) } : {}),
    variant: "destructive" as const,
  };
}

export function problemKey(issue: SkillIssue<SkillProblemCode>): string {
  return `skills.problems.${issue.code}`;
}

export function warningKey(issue: SkillIssue<SkillWarningCode>): string {
  return `skills.warnings.${issue.code}`;
}
