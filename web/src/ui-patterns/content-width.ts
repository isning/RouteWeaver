/** Cap the task, never the shell or its independent context pane. */
export const contentWidth = {
  settings: "max-w-[52rem]",
  list: "max-w-[72rem]",
  table: "max-w-[100rem]",
  workspace: "max-w-[80rem]",
} as const;
export type ContentKind = keyof typeof contentWidth;

export function routeContentKind(page: string): ContentKind | "frame" {
  if (
    [
      "subscriptions",
      "profiles",
      "outputs",
      "settings",
      "account-security",
    ].includes(page)
  )
    return "frame";
  if (["fleet", "routes", "legacy-routes"].includes(page)) return "workspace";
  // Wide inventories need room for columns. Reading/card lists and the
  // subscription workspace retain the narrower task width.
  if (
    [
      "sources",
      "resources",
      "nodes",
      "users",
      "services",
      "activity",
      "published-routes",
      "notifications",
    ].includes(page)
  )
    return "table";
  return "list";
}
