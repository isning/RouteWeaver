import { ScrollableTabsList } from "@/ui-patterns/scrollable-tabs-list";
import { TabsTrigger } from "@/components/ui/tabs";

export const platformSettingsTabs = [
  { key: "basic", label: "基本设置" },
  { key: "security", label: "账号安全" },
  { key: "backup", label: "备份与恢复" },
] as const;

/** The pending and ready bands use the same wrapping and touch-target geometry. */
export function PlatformSettingsTabList({
  disabled = false,
}: {
  disabled?: boolean;
}) {
  return (
    <ScrollableTabsList variant="line">
      {platformSettingsTabs.map((tab) => (
        <TabsTrigger key={tab.key} value={tab.key} disabled={disabled}>
          {tab.label}
        </TabsTrigger>
      ))}
    </ScrollableTabsList>
  );
}
