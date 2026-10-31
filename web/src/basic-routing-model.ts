import { clientTarget } from "./client-targets";
import type { Overview, PlatformEntry, Profile, Source } from "./types";

export const chatGPTDomains = [
  "chatgpt.com",
  "openai.com",
  "oaistatic.com",
  "oaiusercontent.com",
];
export interface BasicChoice {
  id: string;
  label: string;
  section: "平台线路" | "我的机场";
  sourceId?: string;
  platformEntryId?: string;
  rateMicros?: number;
}
export interface BasicSelection {
  name: string;
  adapterId: string;
  chatEndpointId: string;
  defaultEndpointId: string;
}
export function basicChoices(
  entries: PlatformEntry[],
  sources: Source[],
  routes: Overview["routes"],
): BasicChoice[] {
  const choices: BasicChoice[] = entries.map((entry) => {
    const rate = routes.find((route) => route.id === entry.routeId)?.rateMicros;
    return {
      id: entry.id,
      label: `${entry.name}${rate === undefined ? " · 倍率未提供" : ` · ${rate / 1000000}×`}`,
      section: "平台线路",
      platformEntryId: entry.id,
      rateMicros: rate,
    };
  });
  for (const source of sources) {
    if (!source.enabled) continue;
    for (const endpoint of source.snapshot?.endpoints ||
      source.endpoints ||
      []) {
      choices.push({
        id: endpoint.id,
        label: `${source.name} · ${endpoint.name}`,
        section: "我的机场",
        sourceId: source.id,
      });
    }
  }
  // Ambiguous IDs must not pick one source merely because it came first.
  return choices.filter(
    (choice) => choices.filter((other) => other.id === choice.id).length === 1,
  );
}
export function basicProfile(
  base: Profile,
  selection: BasicSelection,
  choices: BasicChoice[],
): Profile {
  const selected = [selection.chatEndpointId, selection.defaultEndpointId].map(
    (id) => choices.find((c) => c.id === id),
  );
  const refs = (id: string) => (id ? [{ kind: "endpoint", ref: id }] : []);
  return {
    ...base,
    name: selection.name,
    target: clientTarget(selection.adapterId),
    mode: "full",
    collectionId: undefined,
    sourceIds: [
      ...new Set(selected.flatMap((c) => (c?.sourceId ? [c.sourceId] : []))),
    ],
    platformEntryIds: [
      ...new Set(
        selected.flatMap((c) =>
          c?.platformEntryId ? [c.platformEntryId] : [],
        ),
      ),
    ],
    ir: {
      ...base.ir,
      name: selection.name,
      endpoints: [],
      resources: [],
      groups: [
        {
          id: "basic_chatgpt",
          name: "ChatGPT",
          kind: "manual",
          members: refs(selection.chatEndpointId),
        },
        {
          id: "basic_default",
          name: "其他流量",
          kind: "manual",
          members: refs(selection.defaultEndpointId),
        },
      ],
      rules: chatGPTDomains.map((domain, index) => ({
        id: `basic_chatgpt_${index}`,
        match: { op: "domain-suffix", value: domain },
        action: { kind: "group", ref: "basic_chatgpt" },
      })),
      defaultAction: { kind: "group", ref: "basic_default" },
    },
  };
}
// Recognize only this bounded generated shape. Additional rules, group behavior,
// native overrides or resources belong in the existing full editor, never a
// lossy projection. Unrelated runtime settings remain intact when basic choices change.
export function basicSelection(profile: Profile): BasicSelection | null {
  const ir = profile.ir;
  if (
    profile.mode !== "full" ||
    profile.collectionId ||
    ir.nativeOverride ||
    ir.resources.length ||
    ir.groups.length !== 2 ||
    ir.rules.length !== chatGPTDomains.length ||
    ir.defaultAction.kind !== "group" ||
    ir.defaultAction.ref !== "basic_default"
  )
    return null;
  const selected: string[] = [];
  for (const [index, id] of ["basic_chatgpt", "basic_default"].entries()) {
    const group = ir.groups.find((g) => g.id === id);
    if (
      !group ||
      group.name !== ["ChatGPT", "其他流量"][index] ||
      group.kind !== "manual" ||
      group.dynamic ||
      group.testUrl ||
      group.intervalSeconds ||
      group.toleranceMs ||
      group.strategy ||
      group.members.length !== 1 ||
      group.members[0].kind !== "endpoint" ||
      !group.members[0].ref
    )
      return null;
    selected.push(group.members[0].ref);
  }
  if (
    !ir.rules.every(
      (rule, index) =>
        rule.id === `basic_chatgpt_${index}` &&
        rule.match.op === "domain-suffix" &&
        rule.match.value === chatGPTDomains[index] &&
        !rule.match.children?.length &&
        rule.action.kind === "group" &&
        rule.action.ref === "basic_chatgpt",
    )
  )
    return null;
  if (!profile.sourceIds?.length && !profile.platformEntryIds?.length)
    return null;
  if (
    profile.target.adapterId !== "mihomo" &&
    profile.target.adapterId !== "sing-box"
  )
    return null;
  if (profile.target.version !== clientTarget(profile.target.adapterId).version)
    return null;
  if (ir.endpoints.length) {
    const selectedPlatform = selected.filter((id) =>
      profile.platformEntryIds?.includes(id),
    );
    const selectedSources = selected
      .filter((id) => !selectedPlatform.includes(id))
      .map(
        (id) =>
          ir.endpoints.find((endpoint) => endpoint.id === id)?.provenance?.[0]
            ?.sourceId,
      );
    const sameSet = (left: string[], right: string[]) =>
      left.length === new Set(left).size &&
      left.length === new Set(right).size &&
      left.every((value) => right.includes(value));
    if (
      selectedSources.some((id) => !id) ||
      !sameSet(profile.sourceIds || [], selectedSources as string[]) ||
      !sameSet(profile.platformEntryIds || [], selectedPlatform)
    )
      return null;
    if (
      ir.endpoints.some(
        (endpoint) =>
          !profile.platformEntryIds?.includes(endpoint.id) &&
          (endpoint.origin !== "imported" ||
            !endpoint.provenance?.length ||
            endpoint.provenance.some(
              (ref) => !profile.sourceIds?.includes(ref.sourceId),
            )),
      )
    )
      return null;
  }
  return {
    name: profile.name,
    adapterId: profile.target.adapterId,
    chatEndpointId: selected[0],
    defaultEndpointId: selected[1],
  };
}
