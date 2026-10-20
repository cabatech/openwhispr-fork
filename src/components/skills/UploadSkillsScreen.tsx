import { useId, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check, Code2, FileText, Info } from "../icons";
import { Button } from "../ui/button";
import { Breadcrumb } from "../ui/Breadcrumb";
import { DropZone } from "../ui/DropZone";
import { SectionLabel, SettingsPanel } from "../ui/SettingsSection";
import { useToast } from "../ui/useToast";
import { IntegrationsPane } from "../integrations/IntegrationsPane";
import { refreshSkills } from "../../stores/skillsStore";
import type { SkillUploadPreview } from "../../types/skills";
import { MAX_SKILL_BYTES, problemKey, warningKey, writeFailedToast } from "./skillCopy";

interface UploadRow {
  id: number;
  preview: SkillUploadPreview;
  /** What the user decided for a skill they already have. */
  choice?: "replace" | "skip";
}

const willInstall = (row: UploadRow) =>
  row.preview.status === "ready" ||
  (row.preview.status === "duplicate" && row.choice === "replace");

interface UploadSkillsScreenProps {
  onDone: (installed: string[]) => void;
  onBack: () => void;
}

export function UploadSkillsScreen({ onDone, onBack }: UploadSkillsScreenProps): ReactElement {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [rows, setRows] = useState<UploadRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const nextRowId = useRef(0);
  const hintId = useId();
  const toInstall = rows.filter(willInstall);

  const addFiles = async (files: File[]) => {
    const readable = files.filter((file) => file.size <= MAX_SKILL_BYTES);
    const items = await Promise.all(
      readable.map(async (file) => ({
        fileName: file.name,
        data: new Uint8Array(await file.arrayBuffer()),
      }))
    );
    const result = items.length > 0 ? await window.electronAPI?.skillsPreviewUpload?.(items) : null;
    const previews = result && "items" in result ? result.items : [];
    let next = 0;
    const added = files.map((file): UploadRow => {
      const refusal = (code: "tooLarge" | "unreadableArchive"): SkillUploadPreview => ({
        fileName: file.name,
        status: "invalid",
        problems: [{ code }],
        warnings: [],
      });
      const preview =
        file.size > MAX_SKILL_BYTES
          ? refusal("tooLarge")
          : (previews[next++] ?? refusal("unreadableArchive"));
      return { id: nextRowId.current++, preview };
    });
    setRows((current) => [...current, ...added]);
  };

  const choose = (id: number, choice?: UploadRow["choice"]) =>
    setRows((current) => current.map((row) => (row.id === id ? { ...row, choice } : row)));

  const submit = async () => {
    setSubmitting(true);
    const result = await window.electronAPI?.skillsCommitUpload?.({
      tokens: toInstall.map((row) => row.preview.token ?? ""),
      replace: toInstall
        .filter((row) => row.preview.status === "duplicate")
        .map((row) => row.preview.name ?? ""),
    });
    setSubmitting(false);
    if (!result || !("installed" in result)) {
      toast(writeFailedToast(t));
      return;
    }
    if (result.failed.length > 0) toast(writeFailedToast(t, result.failed[0].error));
    if (result.installed.length === 0) return;
    await refreshSkills();
    toast({
      title: t("skills.toasts.uploaded", { count: result.installed.length }),
      variant: "success",
    });
    onDone(result.installed);
  };

  const status = (row: UploadRow) => {
    const { preview } = row;
    if (preview.status === "invalid") {
      const [problem] = preview.problems;
      return (
        <span className="flex items-center gap-1.5 text-xs text-warning">
          <AlertTriangle size={13} className="shrink-0" />
          {t(problemKey(problem), problem.values)}
        </span>
      );
    }
    if (preview.status === "ready") {
      return (
        <span className="flex items-center gap-1.5 text-xs text-foreground">
          <Check size={13} className="text-success" />
          {t("skills.upload.ready")}
        </span>
      );
    }
    if (row.choice) {
      return (
        <>
          {row.choice === "replace" ? (
            <span className="flex items-center gap-1.5 text-xs text-foreground">
              <Check size={13} className="text-success" />
              {t("skills.upload.willReplace")}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">{t("skills.upload.skipped")}</span>
          )}
          <Button variant="link" size="sm" className="h-6 px-1" onClick={() => choose(row.id)}>
            {t("skills.upload.undo")}
          </Button>
        </>
      );
    }
    return (
      <>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Info size={13} className="text-info shrink-0" />
          {t("skills.upload.duplicate")}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2.5"
          onClick={() => choose(row.id, "replace")}
        >
          {t("skills.upload.replace")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2.5"
          onClick={() => choose(row.id, "skip")}
        >
          {t("common.skip")}
        </Button>
      </>
    );
  };

  return (
    <IntegrationsPane
      breadcrumb={
        <Breadcrumb
          label={t("skills.breadcrumb.label")}
          items={[
            { label: t("skills.breadcrumb.root"), onSelect: onBack },
            { label: t("skills.upload.crumb") },
          ]}
        />
      }
      title={t("skills.upload.title")}
      description={t("skills.upload.description")}
    >
      <DropZone
        label={t("skills.upload.drop")}
        activeLabel={t("skills.upload.dropActive")}
        hint={t("skills.upload.several")}
        onFiles={(files) => void addFiles(files)}
        onBrowse={() => inputRef.current?.click()}
        className="mt-0 py-10"
      />
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".md,.zip,.skill"
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          // Cleared so choosing the same file again still reports it.
          event.target.value = "";
          if (files.length > 0) void addFiles(files);
        }}
      />
      <ul className="mt-3 space-y-1 ps-1 text-xs text-muted-foreground/80 leading-relaxed">
        <li className="flex items-center gap-2">
          <FileText size={12} className="shrink-0 text-muted-foreground/60" />
          <span>{t("skills.upload.ruleMd")}</span>
        </li>
        <li className="flex items-center gap-2">
          <Code2 size={12} className="shrink-0 text-muted-foreground/60" />
          <span>{t("skills.upload.ruleZip")}</span>
        </li>
      </ul>
      {rows.length > 0 && (
        <div className="mt-4">
          <SectionLabel>{t("skills.upload.fileCount", { count: rows.length })}</SectionLabel>
          <SettingsPanel role="list">
            {rows.map((row) => {
              const Icon = row.preview.fileName.toLowerCase().endsWith(".md") ? FileText : Code2;
              return (
                <div
                  key={row.id}
                  role="listitem"
                  className="px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-1.5"
                >
                  <div className="flex flex-1 basis-52 min-w-0 items-center gap-2.5">
                    <Icon size={14} className="shrink-0 text-muted-foreground/70" />
                    <span dir="ltr" className="truncate font-mono text-xs text-foreground">
                      {row.preview.fileName}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">{status(row)}</div>
                  {row.preview.status !== "invalid" &&
                    row.preview.warnings.map((warning) => (
                      <p
                        key={warning.code}
                        className="basis-full ps-6 text-[11px] leading-relaxed text-muted-foreground"
                      >
                        {t(warningKey(warning), warning.values)}
                      </p>
                    ))}
                </div>
              );
            })}
          </SettingsPanel>
        </div>
      )}
      <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
        {toInstall.length === 0 && (
          <span id={hintId} className="me-1 text-xs text-muted-foreground">
            {t("skills.upload.chooseFile")}
          </span>
        )}
        <Button variant="ghost" size="sm" onClick={onBack}>
          {t("common.cancel")}
        </Button>
        <Button
          size="sm"
          disabled={toInstall.length === 0 || submitting}
          aria-describedby={toInstall.length === 0 ? hintId : undefined}
          onClick={() => void submit()}
        >
          {toInstall.length === 0
            ? t("skills.upload.submit")
            : t("skills.upload.submitCount", { count: toInstall.length })}
        </Button>
      </div>
    </IntegrationsPane>
  );
}
