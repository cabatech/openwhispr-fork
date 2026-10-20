import { useId, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, FileText, Plus, X } from "../icons";
import { Button } from "../ui/button";
import { Breadcrumb } from "../ui/Breadcrumb";
import { Input, INPUT_CLASS } from "../ui/input";
import { Label } from "../ui/label";
import { LineNumberedTextarea } from "../ui/LineNumberedTextarea";
import { SettingsPanel } from "../ui/SettingsSection";
import { useToast } from "../ui/useToast";
import { cn } from "../lib/utils";
import { IntegrationsPane } from "../integrations/IntegrationsPane";
import {
  refreshSkills,
  setCreateDraft,
  useSkillsStore,
  type SkillCreateDraft,
} from "../../stores/skillsStore";
import type { SkillProblemCode } from "../../types/skills";
import { problemKey, writeFailedToast } from "./skillCopy";

type Field = "name" | "description" | "instructions";
const FIELDS: readonly Field[] = ["name", "description", "instructions"];
const EMPTY_DRAFT: SkillCreateDraft = { title: "", description: "", instructions: "", files: [] };

const currentDraft = () => useSkillsStore.getState().createDraft ?? EMPTY_DRAFT;

// The library names a problem by code; each code belongs to one of the fields.
function fieldFor(code: SkillProblemCode): Field {
  if (code.toLowerCase().includes("description")) return "description";
  if (code === "placeholder") return "instructions";
  return "name";
}

interface CreateSkillScreenProps {
  onCreated: (name: string) => void;
  onBack: () => void;
}

export function CreateSkillScreen({ onCreated, onBack }: CreateSkillScreenProps): ReactElement {
  const { t } = useTranslation();
  const { toast } = useToast();
  const draft = useSkillsStore((state) => state.createDraft) ?? EMPTY_DRAFT;
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [leaving, setLeaving] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const controls = {
    name: useRef<HTMLInputElement>(null),
    description: useRef<HTMLTextAreaElement>(null),
    instructions: useRef<HTMLTextAreaElement>(null),
  };
  const baseId = useId();
  const fieldId = (field: Field) => `${baseId}-${field}`;
  const errorId = (field: Field) => `${baseId}-${field}-error`;
  const hintId = `${baseId}-description-hint`;

  const filled = Boolean(
    draft.title.trim() && draft.description.trim() && draft.instructions.trim()
  );
  const dirty = Boolean(
    draft.title.trim() ||
    draft.description.trim() ||
    draft.instructions.trim() ||
    draft.files.length
  );

  const update = (field: Field, patch: Partial<SkillCreateDraft>) => {
    setCreateDraft({ ...currentDraft(), ...patch });
    if (errors[field]) setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const showErrors = (next: Partial<Record<Field, string>>) => {
    setErrors(next);
    const first = FIELDS.find((field) => next[field]);
    if (first) controls[first].current?.focus();
  };

  const addFiles = async (files: File[]) => {
    const added = await Promise.all(
      files.map(async (file) => ({
        fileName: file.name,
        data: new Uint8Array(await file.arrayBuffer()),
      }))
    );
    const current = currentDraft();
    setCreateDraft({ ...current, files: [...current.files, ...added] });
  };

  const removeFile = (index: number) => {
    const current = currentDraft();
    setCreateDraft({ ...current, files: current.files.filter((_, at) => at !== index) });
  };

  // A half-written skill asks before it's left, by any way out.
  const requestLeave = () => (dirty ? setLeaving(true) : onBack());

  const discard = () => {
    setCreateDraft(null);
    onBack();
  };

  const keepEditing = () => {
    setLeaving(false);
    controls.name.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || (!leaving && !dirty)) return;
    // Handled here, so the pane doesn't go back as well.
    event.preventDefault();
    event.stopPropagation();
    setLeaving(!leaving);
  };

  const create = async () => {
    const missing: Partial<Record<Field, string>> = {};
    if (!draft.title.trim()) missing.name = t("skills.create.nameMissing");
    if (!draft.description.trim()) missing.description = t("skills.create.descriptionMissing");
    if (!draft.instructions.trim()) missing.instructions = t("skills.create.instructionsMissing");
    if (Object.keys(missing).length > 0) {
      showErrors(missing);
      return;
    }

    setSaving(true);
    const result = await window.electronAPI?.skillsCreate?.(draft);
    setSaving(false);
    if (result?.ok) {
      setCreateDraft(null);
      // Listed before going home, so its card is there to play and take focus.
      await refreshSkills();
      toast({
        title: t("skills.toasts.created", { name: draft.title.trim() }),
        variant: "success",
      });
      onCreated(result.name);
      return;
    }
    if (result && "problems" in result) {
      const next: Partial<Record<Field, string>> = {};
      for (const problem of result.problems) {
        next[fieldFor(problem.code)] ??= t(problemKey(problem), problem.values);
      }
      showErrors(next);
      return;
    }
    toast(writeFailedToast(t, result && "error" in result ? result.error : undefined));
  };

  const fieldError = (field: Field) =>
    errors[field] && (
      <p id={errorId(field)} className="text-xs text-destructive">
        {errors[field]}
      </p>
    );
  const invalidProps = (field: Field) =>
    errors[field] ? { "aria-invalid": true, "aria-describedby": errorId(field) } : {};

  return (
    <div onKeyDown={onKeyDown}>
      <IntegrationsPane
        breadcrumb={
          <Breadcrumb
            label={t("skills.breadcrumb.label")}
            items={[
              { label: t("skills.breadcrumb.root"), onSelect: requestLeave },
              { label: t("skills.create.crumb") },
            ]}
          />
        }
        title={t("skills.create.title")}
        description={t("skills.create.description")}
      >
        <SettingsPanel>
          <div className="px-4 py-3 space-y-2">
            <Label htmlFor={fieldId("name")} className="text-xs block">
              {t("skills.create.name")}
            </Label>
            <Input
              ref={controls.name}
              id={fieldId("name")}
              type="text"
              dir="auto"
              value={draft.title}
              onChange={(event) => update("name", { title: event.target.value })}
              placeholder={t("skills.create.namePlaceholder")}
              className="h-9 px-3 py-2 text-sm"
              {...invalidProps("name")}
            />
            {fieldError("name")}
          </div>
          <div className="px-4 py-3 space-y-2">
            <Label htmlFor={fieldId("description")} className="text-xs block">
              {t("skills.create.descriptionLabel")}
            </Label>
            <textarea
              ref={controls.description}
              id={fieldId("description")}
              dir="auto"
              rows={2}
              value={draft.description}
              onChange={(event) => update("description", { description: event.target.value })}
              placeholder={t("skills.create.descriptionPlaceholder")}
              className={cn(INPUT_CLASS, "h-auto min-h-16 resize-none text-sm leading-relaxed")}
              aria-describedby={errors.description ? errorId("description") : hintId}
              aria-invalid={errors.description ? true : undefined}
            />
            <p id={hintId} className="text-[11px] text-muted-foreground/70 leading-relaxed">
              {t("skills.create.descriptionHint")}
            </p>
            {fieldError("description")}
          </div>
          <div className="px-4 py-3 space-y-2">
            <Label htmlFor={fieldId("instructions")} className="text-xs block">
              {t("skills.create.instructions")}
            </Label>
            <LineNumberedTextarea
              ref={controls.instructions}
              id={fieldId("instructions")}
              value={draft.instructions}
              onChange={(instructions) => update("instructions", { instructions })}
              placeholder={t("skills.create.instructionsPlaceholder")}
              invalid={Boolean(errors.instructions)}
              describedBy={errors.instructions ? errorId("instructions") : undefined}
            />
            {draft.files.length > 0 && (
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {draft.files.map((file, index) => (
                  <li
                    key={`${file.fileName}-${index}`}
                    className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border/70 bg-card ps-2.5 pe-1 text-xs text-foreground dark:border-white/10 dark:bg-surface-2"
                  >
                    <FileText size={12} className="text-muted-foreground/70" />
                    <span dir="ltr" className="font-mono text-[11px]">
                      {file.fileName}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeFile(index)}
                      aria-label={t("skills.create.removeFile", { path: file.fileName })}
                      className="flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground/70 hover:bg-foreground/8 hover:text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring/30"
                    >
                      <X size={11} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => fileInput.current?.click()}
              className="h-7 px-2.5 -ms-1 mt-1.5 text-muted-foreground"
            >
              <Plus className="h-3.5 w-3.5" />
              {t("skills.create.addFile")}
            </Button>
            <input
              ref={fileInput}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = "";
                if (files.length > 0) void addFiles(files);
              }}
            />
            {fieldError("instructions")}
          </div>
        </SettingsPanel>
        <div className="sticky bottom-0 z-10 mt-4 bg-background border-t border-border/70 dark:border-white/10 py-3">
          {leaving && (
            <div
              role="alert"
              className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-warning/30 bg-warning/5 dark:bg-warning/10 ps-3.5 pe-2 py-2"
            >
              <AlertTriangle size={15} className="shrink-0 text-warning" />
              <p className="flex-1 min-w-0 text-xs text-foreground/85 leading-relaxed">
                {t("skills.create.unsaved")}
              </p>
              <Button variant="ghost" size="sm" onClick={keepEditing}>
                {t("skills.create.keepEditing")}
              </Button>
              <Button variant="outline" size="sm" onClick={discard}>
                {t("skills.create.discard")}
              </Button>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex-1" />
            <Button variant="ghost" size="sm" onClick={requestLeave}>
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              aria-disabled={!filled}
              disabled={saving}
              onClick={() => void create()}
              className={cn(!filled && "cursor-not-allowed opacity-50")}
            >
              {t("skills.create.submit")}
            </Button>
          </div>
        </div>
      </IntegrationsPane>
    </div>
  );
}
