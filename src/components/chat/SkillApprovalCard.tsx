import { useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "../icons";
import { cn } from "../lib/utils";
import { Button } from "../ui/button";
import { SkillIcon } from "../skills/SkillIcon";
import { APPROVAL_CARD_CLASS } from "./ApprovalCard";
import { useSkillChatActions } from "./skillChatActions";
import { useSkillsStore } from "../../stores/skillsStore";
import {
  saveSkillApproval,
  skipSkillApproval,
  undoSkillApproval,
  updateSkillDraft,
  type SkillApprovalEntry,
} from "../../stores/skillApprovalStore";

const FIELD_CLASS = "w-full rounded-md border border-border/70 bg-background px-2 py-1";
const INLINE_LINK_CLASS = "h-auto px-1.5 py-0";

// The draft lives in the store, so edit mode only changes how it is shown: Save always
// writes exactly what the card displays.
export function SkillApprovalCard({ entry }: { entry: SkillApprovalEntry }): ReactElement {
  const { t } = useTranslation();
  const { openSkill } = useSkillChatActions();
  const playKey = useSkillsStore((state) => state.iconPlays[entry.name] ?? 0);
  const [editing, setEditing] = useState(false);
  const [showFull, setShowFull] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const showEditor = editing && entry.state === "pending";
  const { draft } = entry;

  // Save, Skip and Undo remove the button that had focus; the card keeps it, so keyboard
  // and screen-reader users land on the result.
  const leaveEditingAndFocusCard = (): void => {
    setEditing(false);
    cardRef.current?.focus();
  };

  // Esc while editing ends editing and keeps the draft. It must not reach the assistant
  // panel, whose Esc cancels the whole turn and withdraws the card.
  const onEditorKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    setEditing(false);
  };

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      data-approval-card={entry.key}
      data-state={entry.state}
      onKeyDown={showEditor ? onEditorKeyDown : undefined}
      className={APPROVAL_CARD_CLASS}
    >
      <p className="font-medium text-foreground">{t("skills.approval.createHeader")}</p>
      <p className="text-xs text-muted-foreground">
        {entry.replacesExisting
          ? t("skills.approval.replacesExisting")
          : t("skills.approval.newSkill")}
      </p>
      <div className="mt-2 flex items-start gap-2.5">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/5 text-primary dark:bg-primary/10">
          <SkillIcon size={14} playKey={playKey} />
        </div>
        <div className="min-w-0">
          <p className="font-medium" dir="auto">
            {draft.title}
          </p>
          <p dir="auto">{draft.description}</p>
        </div>
      </div>

      {showEditor && (
        <div className="mt-2 space-y-2">
          <input
            type="text"
            aria-label={t("skills.approval.nameLabel")}
            className={FIELD_CLASS}
            dir="auto"
            value={draft.title}
            onChange={(event) => updateSkillDraft(entry.key, { title: event.target.value })}
          />
          <textarea
            aria-label={t("skills.approval.descriptionLabel")}
            className={cn(FIELD_CLASS, "min-h-16")}
            dir="auto"
            value={draft.description}
            onChange={(event) => updateSkillDraft(entry.key, { description: event.target.value })}
          />
        </div>
      )}

      <div className="mt-2">
        <button
          type="button"
          aria-expanded={showFull}
          onClick={() => setShowFull((open) => !open)}
          className="inline-flex items-center gap-1 rounded-sm text-xs text-primary/80 outline-none hover:text-primary focus-visible:ring-1 focus-visible:ring-primary/30"
        >
          <ChevronDown
            className={cn("h-3 w-3 transition-transform duration-200", showFull && "rotate-180")}
          />
          {t("skills.approval.seeFull")}
        </button>
        {showFull && (
          <pre
            dir="auto"
            className="mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap rounded-md border border-border/70 bg-background px-2.5 py-2 font-mono text-[11px] leading-relaxed text-foreground/85"
          >
            {draft.instructions}
          </pre>
        )}
      </div>

      {/* One live region for every outcome, rendered from the start so a screen reader
          announces each change. */}
      <div role="status" aria-live="polite" className="text-xs">
        {entry.state === "saving" && (
          <p className="mt-2 text-muted-foreground">{t("skills.approval.saving")}</p>
        )}
        {entry.state === "saved" && entry.versionId && (
          <p className="mt-2 text-foreground">
            {t("skills.approval.updated")} ·
            <Button
              size="sm"
              variant="link"
              className={INLINE_LINK_CLASS}
              onClick={() => {
                cardRef.current?.focus();
                void undoSkillApproval(entry.key);
              }}
            >
              {t("skills.approval.undo")}
            </Button>
          </p>
        )}
        {entry.state === "saved" && !entry.versionId && (
          <p className="mt-2 text-foreground">
            {t("skills.approval.saved")}
            {openSkill && (
              <>
                {" ·"}
                <Button
                  size="sm"
                  variant="link"
                  className={INLINE_LINK_CLASS}
                  onClick={() => openSkill(entry.name)}
                >
                  {t("skills.approval.openSkill")}
                </Button>
              </>
            )}
          </p>
        )}
        {entry.state === "undone" && (
          <p className="mt-2 text-muted-foreground">{t("skills.approval.undone")}</p>
        )}
        {entry.state === "skipped" && (
          <p className="mt-2 text-muted-foreground">{t("skills.approval.skippedCreate")}</p>
        )}
        {entry.state === "failed" && (
          <p className="mt-2 text-destructive">{t("skills.approval.failed")}</p>
        )}
        {entry.state === "not_saved" && (
          <p className="mt-2 text-muted-foreground">{t("skills.approval.notSaved")}</p>
        )}
      </div>

      {entry.state === "pending" && (
        <div className="mt-2 flex gap-2">
          <Button
            size="sm"
            onClick={() => {
              leaveEditingAndFocusCard();
              void saveSkillApproval(entry.key);
            }}
          >
            {t("skills.approval.save")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEditing((value) => !value)}>
            {editing ? t("connectors.approval.doneEditing") : t("connectors.approval.edit")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              leaveEditingAndFocusCard();
              skipSkillApproval(entry.key);
            }}
          >
            {t("common.skip")}
          </Button>
        </div>
      )}
    </div>
  );
}
