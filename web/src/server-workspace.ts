export type ServerWorkspaceSection = "overview" | "cores" | "records" | "diagnostics";
const sections: readonly string[] = ["overview", "cores", "records", "diagnostics"];

/** URL state carries identity and view only, never credentials or edits. */
export function serverWorkspaceHash(hostId: string, instanceId?: string, section: ServerWorkspaceSection = instanceId ? "cores" : "overview") {
  const query = new URLSearchParams({ host: hostId });
  if (instanceId) query.set("instance", instanceId);
  if (section !== (instanceId ? "cores" : "overview")) query.set("section", section);
  return `#servers?${query}`;
}

export function readServerWorkspace(hash: string): { hostId: string | null; instanceId: string | null; section: ServerWorkspaceSection } | null {
  if (hash.split("?")[0] !== "#servers") return null;
  const query = new URLSearchParams(hash.split("?")[1] || "");
  if (["host", "instance", "section"].some((key) => query.getAll(key).length > 1)) return null;
  const hostId = query.get("host");
  const instanceId = query.get("instance");
  if ((!hostId && (query.has("host") || query.has("instance") || query.has("section"))) || (query.has("instance") && !instanceId)) return null;
  const section = query.get("section") || (instanceId ? "cores" : "overview");
  if (!sections.includes(section)) return null;
  return { hostId, instanceId, section: section as ServerWorkspaceSection };
}
