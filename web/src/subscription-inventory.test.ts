import { expect, it } from "vitest";
import type { Output, Profile } from "./types";
import { groupSubscriptionInventory } from "./subscription-inventory";
// Pre-index implementation: equivalence oracle for ordering, scope and partial inventories.
function previous(
  allProfiles: Profile[],
  allOutputs: Output[],
  profileScope: string | undefined,
  search: string,
) {
  const needle = search.trim().toLocaleLowerCase();
  const matches = (value: string) => value.toLocaleLowerCase().includes(needle);
  const linkMatches = (output: Output) =>
    matches(
      `${output.name} ${output.target.adapterId} ${output.mode === "nodes-only" ? "纯节点" : "完整配置"}`,
    );
  const groups: {
    id: string;
    profile?: Profile;
    links: Output[];
    totalLinks: number;
  }[] = [];
  for (const profile of allProfiles) {
    if (profileScope && profile.id !== profileScope) continue;
    const links = allOutputs.filter(
      (output) => output.profileId === profile.id,
    );
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
  const orphanLinks = allOutputs.filter(
    (output) =>
      (!profileScope || output.profileId === profileScope) &&
      !allProfiles.some((profile) => profile.id === output.profileId),
  );
  for (const id of new Set(orphanLinks.map((output) => output.profileId))) {
    const links = orphanLinks.filter((output) => output.profileId === id);
    const visible = links.filter(linkMatches);
    if (visible.length || id === profileScope)
      groups.push({ id, links: visible, totalLinks: links.length });
  }
  return groups;
}
const profile = (id: string, name = id) => ({ id, name }) as Profile;
const output = (
  id: string,
  profileId: string,
  name = id,
  mode: Output["mode"] = "full",
) =>
  ({
    id,
    profileId,
    name,
    mode,
    target: { adapterId: "mihomo", version: "1.19.32" },
  }) as Output;
it("preserves profile, link and first-seen orphan order without changing identities", () => {
  const profiles = [profile("b"), profile("a"), profile("b", "duplicate b")];
  const outputs = [
    output("orphan2", "missing2"),
    output("b1", "b"),
    output("orphan1", "missing1"),
    output("b2", "b"),
    output("orphan3", "missing2"),
    output("special", "__proto__"),
  ];
  const result = groupSubscriptionInventory(profiles, outputs, undefined, "");
  expect(result).toEqual(previous(profiles, outputs, undefined, ""));
  expect(result.map((group) => group.id)).toEqual([
    "b",
    "a",
    "b",
    "missing2",
    "missing1",
    "__proto__",
  ]);
  expect(result[0].links).toEqual([outputs[1], outputs[3]]);
  expect(result[0].profile).toBe(profiles[0]);
  expect(result[2].profile).toBe(profiles[2]);
  expect(result[3].links[1]).toBe(outputs[4]);
  expect(outputs.map((link) => link.id)).toEqual([
    "orphan2",
    "b1",
    "orphan1",
    "b2",
    "orphan3",
    "special",
  ]);
});
it("retains scoped empty groups and full counts while filtering visible links", () => {
  const profiles = [profile("p", "Work"), profile("empty")];
  const outputs = [
    output("phone", "p", "Phone"),
    output("laptop", "p", "Laptop"),
    output("orphan", "missing", "Phone", "nodes-only"),
  ];
  expect(
    groupSubscriptionInventory(profiles, outputs, "p", "  PHONE  ")[0],
  ).toMatchObject({ id: "p", links: [outputs[0]], totalLinks: 2 });
  expect(
    groupSubscriptionInventory(profiles, outputs, "empty", "no match"),
  ).toEqual([{ id: "empty", profile: profiles[1], links: [], totalLinks: 0 }]);
  expect(
    groupSubscriptionInventory(profiles, outputs, "missing", "no match"),
  ).toEqual([{ id: "missing", links: [], totalLinks: 1 }]);
  expect(groupSubscriptionInventory(profiles, outputs, "absent", "")).toEqual(
    [],
  );
  expect(
    groupSubscriptionInventory(profiles, outputs, undefined, "Work")[0].links,
  ).toEqual(outputs.slice(0, 2));
});
it("matches the previous grouping across partial, duplicate, scoped and searched inventories", () => {
  let checks = 0;
  for (let p = 0; p < 12; p++)
    for (let o = 0; o < 25; o += 3) {
      const profiles = Array.from({ length: p }, (_, i) =>
        profile(`p${i}`, `配置 Profile ${i}`),
      );
      if (p % 3 === 0 && profiles.length) profiles.push(profiles[0]);
      const outputs = Array.from({ length: o }, (_, i) =>
        output(
          `o${i}`,
          i % 11 === 0 ? `missing${i % 5}` : `p${i % Math.max(1, p)}`,
          `Phone ${i}`,
          i % 3 ? "full" : "nodes-only",
        ),
      );
      for (const scope of [undefined, "p0", "missing0", "absent", ""])
        for (const search of [
          "",
          "  Profile 1  ",
          "PHONE",
          "纯节点",
          "配置",
          "no match",
        ]) {
          expect(
            groupSubscriptionInventory(profiles, outputs, scope, search),
          ).toEqual(previous(profiles, outputs, scope, search));
          checks++;
        }
    }
  expect(checks).toBe(3240);
});
it("reads each output grouping key once instead of once for every profile", () => {
  const profiles = Array.from({ length: 100 }, (_, i) => profile(`p${i}`));
  let keys = 0;
  const outputs = Array.from({ length: 1000 }, (_, i) => ({
    ...output(`o${i}`, "unused"),
    get profileId() {
      keys++;
      return `p${i % profiles.length}`;
    },
  }));
  previous(profiles, outputs, undefined, "");
  expect(keys).toBeGreaterThan(profiles.length * outputs.length);
  keys = 0;
  const groups = groupSubscriptionInventory(profiles, outputs, undefined, "");
  expect(keys).toBe(outputs.length);
  expect(groups).toHaveLength(profiles.length);
  expect(groups.reduce((sum, group) => sum + group.totalLinks, 0)).toBe(
    outputs.length,
  );
});
