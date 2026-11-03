// Node-only synthetic grouping benchmark, not a browser or hosted latency test.
// Node 24+: node web/scripts/measure-subscription-grouping.mjs
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { groupSubscriptionInventory } from "../src/subscription-inventory.ts";
// The replaced pre-index algorithm, retained only to make the comparison reproducible.
function previous(allProfiles, allOutputs, profileScope, search) {
  const needle = search.trim().toLocaleLowerCase();
  const matches = (value) => value.toLocaleLowerCase().includes(needle);
  const linkMatches = (output) =>
    matches(
      `${output.name} ${output.target.adapterId} ${output.mode === "nodes-only" ? "纯节点" : "完整配置"}`,
    );
  const groups = [];
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
const fixtures = (p, o) => [
  Array.from({ length: p }, (_, i) => ({
    id: `p${i}`,
    name: `配置 Profile ${i}`,
  })),
  Array.from({ length: o }, (_, i) => ({
    id: `o${i}`,
    profileId: i % 11 === 0 ? `missing${i % 5}` : `p${i % Math.max(1, p)}`,
    name: `Phone ${i}`,
    target: { adapterId: i % 2 ? "mihomo" : "sing-box" },
    mode: i % 3 ? "full" : "nodes-only",
  })),
];
const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const benchmarks = [];
for (const [p, o] of [
  [10, 50],
  [200, 2000],
  [1000, 10000],
]) {
  const [profiles, outputs] = fixtures(p, o);
  assert.deepEqual(
    groupSubscriptionInventory(profiles, outputs, undefined, ""),
    previous(profiles, outputs, undefined, ""),
  );
  for (let i = 0; i < 5; i++) {
    previous(profiles, outputs, undefined, "");
    groupSubscriptionInventory(profiles, outputs, undefined, "");
  }
  const old = [],
    indexed = [];
  let digest = 0;
  for (let i = 0; i < 15; i++) {
    let start = performance.now();
    digest += previous(profiles, outputs, undefined, "").length;
    old.push(performance.now() - start);
    start = performance.now();
    digest += groupSubscriptionInventory(
      profiles,
      outputs,
      undefined,
      "",
    ).length;
    indexed.push(performance.now() - start);
  }
  benchmarks.push({
    profiles: p,
    outputs: o,
    samples: 15,
    oldMedianMs: median(old),
    indexedMedianMs: median(indexed),
    digest,
  });
}
console.log(
  JSON.stringify(
    {
      condition:
        "Local Node synthetic arrays; 5 warmups and 15 alternating samples per size. Grouping only: excludes React rendering, DOM, network, auth, module startup and hosted latency. No absolute timing acceptance threshold.",
      runtime: process.version,
      benchmarks,
    },
    null,
    2,
  ),
);
