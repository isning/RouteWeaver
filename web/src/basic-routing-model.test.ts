import { expect, it } from "vitest";
import {
  basicChoices,
  basicProfile,
  basicSelection,
} from "./basic-routing-model";
import { emptyProfile } from "./model";
import type { Source } from "./types";

const sources: Source[] = [
  {
    id: "airport",
    name: "My airport",
    kind: "text",
    enabled: true,
    snapshot: {
      endpoints: [
        {
          id: "tokyo",
          name: "Tokyo",
          origin: "imported",
          connection: { protocol: "socks", host: "example.test", port: 1080 },
        },
      ],
    },
  },
];
it("builds actual platform ChatGPT and private-airport default choices without copying connection credentials", () => {
  const choices = basicChoices(
    [
      {
        id: "entry",
        name: "FRA → UK",
        routeId: "route",
        credentialVersion: "1",
        status: "configured-unverified",
      },
    ],
    sources,
    [{ id: "route", name: "FRA → UK", rateMicros: 2000000 }],
  );
  const draft = basicProfile(
    emptyProfile(),
    {
      name: "Daily",
      adapterId: "mihomo",
      chatEndpointId: "entry",
      defaultEndpointId: "tokyo",
    },
    choices,
  );
  expect(draft.platformEntryIds).toEqual(["entry"]);
  expect(draft.sourceIds).toEqual(["airport"]);
  expect(draft.ir.endpoints).toEqual([]);
  expect(draft.ir.groups.map((g) => [g.name, g.members])).toEqual([
    ["ChatGPT", [{ kind: "endpoint", ref: "entry" }]],
    ["其他流量", [{ kind: "endpoint", ref: "tokyo" }]],
  ]);
  expect(draft.ir.defaultAction).toEqual({
    kind: "group",
    ref: "basic_default",
  });
  expect(draft.ir.rules.map((r) => r.match.value)).toEqual([
    "chatgpt.com",
    "openai.com",
    "oaistatic.com",
    "oaiusercontent.com",
  ]);
  expect(basicSelection(draft)).toEqual({
    name: "Daily",
    adapterId: "mihomo",
    chatEndpointId: "entry",
    defaultEndpointId: "tokyo",
  });
  expect(choices.find((c) => c.id === "entry")?.label).toContain("2×");
});
it("never reduces an arbitrary advanced profile into basic routing", () => {
  const profile = basicProfile(
    emptyProfile(),
    {
      name: "Daily",
      adapterId: "mihomo",
      chatEndpointId: "tokyo",
      defaultEndpointId: "tokyo",
    },
    basicChoices([], sources, []),
  );
  profile.ir.rules.push({
    id: "extra",
    match: { op: "domain-suffix", value: "work.example" },
    action: { kind: "reject" },
  });
  expect(basicSelection(profile)).toBeNull();
  profile.ir.rules.pop();
  profile.ir.groups[0].kind = "fallback";
  expect(basicSelection(profile)).toBeNull();
  profile.ir.groups[0].kind = "manual";
  profile.ir.nativeOverride = {
    schemaVersion: "1",
    namespace: "routeweaver/native-client",
    target: profile.target,
    format: "json",
    ruleMode: "append",
    content: '{"dns":{}}',
  };
  expect(basicSelection(profile)).toBeNull();
});
it("does not invent choices from disabled, empty or unaccepted sources", () => {
  expect(
    basicChoices(
      [],
      [
        { ...sources[0], enabled: false },
        { id: "empty", name: "Empty", kind: "url", enabled: true },
      ],
      [],
    ),
  ).toEqual([]);
});
it("keeps extra source scope and unsupported target revisions in the advanced editor", () => {
  const p = basicProfile(
    emptyProfile(),
    {
      name: "Daily",
      adapterId: "mihomo",
      chatEndpointId: "tokyo",
      defaultEndpointId: "tokyo",
    },
    basicChoices([], sources, []),
  );
  p.ir.endpoints = [
    {
      ...sources[0].snapshot!.endpoints[0],
      provenance: [
        { sourceId: "airport", snapshotId: "snapshot", endpointId: "tokyo" },
      ],
    },
  ];
  expect(basicSelection(p)).not.toBeNull();
  p.sourceIds!.push("additional-source");
  expect(basicSelection(p)).toBeNull();
  p.sourceIds!.pop();
  p.target.version = "older-custom-target";
  expect(basicSelection(p)).toBeNull();
});
