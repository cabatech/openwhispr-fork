import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, Terminal } from "../icons";
import { Button } from "../ui/button";
import { useToast } from "../ui/useToast";
import { useCopyFeedback } from "../../hooks/useCopyFeedback";

/** Copy for a code block in an answer, and Paste into app where a paste target exists. */
export function CodeBlockActions({
  code,
  paste = false,
}: {
  code: string;
  paste?: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const { toast } = useToast();
  // copyText writes the code exactly; copy() would trim its indentation.
  const { copied, copyText, confirmCopied } = useCopyFeedback(code);

  const copy = async (): Promise<void> => {
    if (await copyText(code)) confirmCopied(code);
  };

  // The code exactly as shown, and never an Enter, so the user chooses when it runs.
  const pasteIntoApp = async (): Promise<void> => {
    const result = await window.electronAPI?.pasteText?.(code, { raw: true }).catch(() => null);
    if (result?.success && result.pasted) {
      toast({ title: t("skills.code.pasted"), variant: "success" });
      return;
    }
    // A clipboard-only paste and a missing Accessibility permission leave it on the
    // clipboard already; after any other failure it is put there.
    if (!result) await copyText(code);
    toast({ title: t("skills.code.pasteFailed") });
  };

  return (
    <div className="mb-2 min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => void copy()}>
          {copied ? (
            <Check className="h-3.5 w-3.5 text-success" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          {copied ? t("common.copied") : t("common.copy")}
        </Button>
        {paste && (
          <Button size="sm" variant="outline" onClick={() => void pasteIntoApp()}>
            <Terminal className="h-3.5 w-3.5" />
            {t("skills.code.paste")}
          </Button>
        )}
      </div>
      {paste && (
        <p className="mt-1.5 text-[11px] text-muted-foreground/80">{t("skills.code.pasteNote")}</p>
      )}
    </div>
  );
}
