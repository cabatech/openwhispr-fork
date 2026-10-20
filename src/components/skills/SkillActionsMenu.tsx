import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Copy, FolderOpen, MoreHorizontal, Trash2 } from "../icons";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { useToast } from "../ui/useToast";
import { useCopyFeedback } from "../../hooks/useCopyFeedback";
import { getCachedPlatform, showInFolderLabelKey } from "../../utils/platform";
import type { SkillSummary } from "../../types/skills";

// A row's ⋯ menu items, as ConversationItem's.
const ITEM_CLASS = "text-xs gap-2 rounded-lg px-2.5 py-1.5 cursor-pointer focus:bg-foreground/5";

interface SkillActionsMenuProps {
  skill: SkillSummary;
  /** Adds Uninstall, which Manage shows and the detail pop-up keeps in its footer. */
  onUninstall?: () => void;
}

export function SkillActionsMenu({ skill, onUninstall }: SkillActionsMenuProps): ReactElement {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { copyText } = useCopyFeedback("");

  // Copies SKILL.md exactly as it's stored, so it pastes into another app unchanged.
  const copyMarkdown = async () => {
    const detail = await window.electronAPI?.skillsGet?.(skill.name);
    const copied = detail ? await copyText(detail.markdown) : false;
    toast(
      copied
        ? { title: t("skills.toasts.copiedMarkdown"), variant: "success" }
        : { title: t("skills.toasts.copyFailed"), variant: "destructive" }
    );
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("skills.detail.more", { name: skill.displayName })}
          className="h-7 w-7 px-0 rounded-full text-muted-foreground/70 hover:text-foreground"
        >
          <MoreHorizontal size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4} className="min-w-44">
        <DropdownMenuItem
          onSelect={() => void window.electronAPI?.skillsReveal?.(skill.name)}
          className={ITEM_CLASS}
        >
          <FolderOpen size={12} className="text-muted-foreground/80" />
          {t(showInFolderLabelKey(getCachedPlatform()))}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void copyMarkdown()} className={ITEM_CLASS}>
          <Copy size={12} className="text-muted-foreground/80" />
          {t("skills.menu.copyMarkdown")}
        </DropdownMenuItem>
        {onUninstall && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={onUninstall}
              className="text-xs gap-2 rounded-lg px-2.5 py-1.5 text-destructive focus:text-destructive focus:bg-destructive/10 cursor-pointer"
            >
              <Trash2 size={12} />
              {t("skills.menu.uninstall")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
