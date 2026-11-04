/** Cap the task, never the shell or its independent context pane. */
export const contentWidth = {
  settings: "max-w-[52rem]",
  list: "max-w-[72rem]",
  workspace: "max-w-[80rem]",
} as const;
export type ContentKind = keyof typeof contentWidth;

export function routeContentKind(page: string): ContentKind | "frame" {
  if (["subscriptions", "profiles", "outputs", "settings", "account-security"].includes(page)) return "frame";
  if (["fleet", "routes", "legacy-routes"].includes(page)) return "workspace";
  return "list";
}
