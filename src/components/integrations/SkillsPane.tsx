import { useEffect, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { refreshSkills } from "../../stores/skillsStore";
import { IntegrationsPane } from "./IntegrationsPane";

interface SkillsPaneProps {
  title: string;
  /** The pane stays mounted while another section is open. */
  active: boolean;
}

export function SkillsPane({ title, active }: SkillsPaneProps): ReactElement {
  const { t } = useTranslation();

  // Opening the pane rereads the folder, so a skill edited outside the app shows up.
  useEffect(() => {
    if (active) void refreshSkills();
  }, [active]);

  return (
    <IntegrationsPane title={title} description={t("skills.pane.description")}>
      {null}
    </IntegrationsPane>
  );
}
