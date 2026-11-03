import type { Output, Profile } from "./types";

export interface SubscriptionInventoryGroup {
  id: string;
  profile?: Profile;
  links: Output[];
  totalLinks: number;
}

/** Preserve inventory order and references while indexing the profile/output relation once. */
export function groupSubscriptionInventory(
  allProfiles: readonly Profile[],
  allOutputs: readonly Output[],
  profileScope: string | undefined,
  search: string,
): SubscriptionInventoryGroup[] {
  const needle = search.trim().toLocaleLowerCase();
  const matches = (value: string) => value.toLocaleLowerCase().includes(needle);
  const linkMatches = (output: Output) =>
    matches(
      `${output.name} ${output.target.adapterId} ${output.mode === "nodes-only" ? "纯节点" : "完整配置"}`,
    );
  const profileIds = new Set(allProfiles.map((profile) => profile.id));
  const linksByProfile = new Map<string, Output[]>();
  for (const output of allOutputs) {
    const id = output.profileId;
    const links = linksByProfile.get(id);
    if (links) links.push(output);
    else linksByProfile.set(id, [output]);
  }
  const groups: SubscriptionInventoryGroup[] = [];
  for (const profile of allProfiles) {
    if (profileScope && profile.id !== profileScope) continue;
    const links = linksByProfile.get(profile.id) || [];
    const visible =
      !needle || matches(profile.name) ? links : links.filter(linkMatches);
    if (
      profile.id === profileScope ||
      !needle ||
      matches(profile.name) ||
      visible.length
    )
      groups.push({
        id: profile.id,
        profile,
        links: visible,
        totalLinks: links.length,
      });
  }
  // Map insertion order matches first occurrence in the output inventory.
  // Do not deduplicate profiles: even malformed duplicate IDs keep their prior behavior.
  for (const [id, links] of linksByProfile) {
    if ((profileScope && id !== profileScope) || profileIds.has(id)) continue;
    const visible = links.filter(linkMatches);
    if (visible.length || id === profileScope)
      groups.push({ id, links: visible, totalLinks: links.length });
  }
  return groups;
}
