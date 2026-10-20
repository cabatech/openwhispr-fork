import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { refreshSkills, useSkillsStore } from "../../stores/skillsStore";
import { useToast } from "../ui/useToast";
import { SkillsHome } from "../skills/SkillsHome";

type SkillsScreen = "home" | "manage" | "upload" | "create";

interface SkillsPaneProps {
  title: string;
  /** The pane stays mounted while another section is open. */
  active: boolean;
}

export function SkillsPane({ title, active }: SkillsPaneProps): ReactElement | null {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [screen, setScreen] = useState<SkillsScreen>("home");

  // Opening the pane rereads the folder, so a skill edited outside the app shows up.
  useEffect(() => {
    if (!active) return;
    void refreshSkills().then(() => {
      if (useSkillsStore.getState().loadError) {
        toast({ title: t("skills.toasts.loadFailed"), variant: "destructive" });
      }
    });
  }, [active, t, toast]);

  if (screen !== "home") return null;
  return (
    <SkillsHome
      title={title}
      onOpenSkill={() => {}}
      onManage={() => setScreen("manage")}
      onCreate={() => setScreen("create")}
      onUpload={() => setScreen("upload")}
    />
  );
}
