import { expect, it } from "vitest";
import {
  parsePublicationEnvelope,
  validatePublicationResult,
  validatePublicationLookup,
} from "./publication-request";
const request = {
  leaseSeconds: 300,
  accessAllowed: true,
  quotaCertain: true,
  expectedFingerprint: "a".repeat(64),
};
const envelope = {
  version: 1 as const,
  actorId: "admin-a",
  deploymentId: "path-a",
  operationId: "request-a",
  request,
};
const accepted = {
  operationId: "request-a",
  deploymentId: "path-a",
  status: "publication-accepted",
  nativeChecked: false,
  instances: [
    {
      instanceId: "instance-a",
      generation: "9007199254740993",
      operationId: "agent-a",
      revisionId: "revision-a",
    },
  ],
};
it("validates bounded exact nonsecret storage and exact echoed request", () => {
  expect(parsePublicationEnvelope(JSON.stringify(envelope))).toEqual(envelope);
  expect(
    validatePublicationLookup({ request, result: accepted }, envelope),
  ).toEqual(accepted);
  for (const input of [
    null,
    [],
    { ...envelope, version: 2 },
    { ...envelope, csrfToken: "forbidden" },
    { ...envelope, request: { ...request, leaseSeconds: 29 } },
    { ...envelope, request: { ...request, accessAllowed: "true" } },
    {
      ...envelope,
      request: { ...request, expectedFingerprint: "A".repeat(64) },
    },
  ])
    expect(parsePublicationEnvelope(JSON.stringify(input))).toBeNull();
  expect(parsePublicationEnvelope(" ".repeat(2049))).toBeNull();
  expect(
    validatePublicationLookup(
      { request: { ...request, leaseSeconds: 301 }, result: accepted },
      envelope,
    ),
  ).toBeNull();
});
it("retains canonical positive int64 generation strings without Number rounding", () => {
  for (const generation of ["1", "9007199254740993", "9223372036854775807"]) {
    const result = {
      ...accepted,
      instances: [{ ...accepted.instances[0], generation }],
    };
    expect(validatePublicationResult(result, envelope)).toEqual(result);
  }
  for (const generation of [
    1,
    "0",
    "01",
    "-1",
    "+1",
    "1e3",
    "9223372036854775808",
    "1.0",
  ])
    expect(
      validatePublicationResult(
        { ...accepted, instances: [{ ...accepted.instances[0], generation }] },
        envelope,
      ),
    ).toBeNull();
});
it("refuses malformed or mismatched terminal outcomes and only known rejection codes", () => {
  for (const value of [
    { ...accepted, operationId: "other" },
    { ...accepted, deploymentId: "other" },
    { ...accepted, nativeChecked: true },
    { ...accepted, instances: [] },
    { ...accepted, instances: [...accepted.instances, ...accepted.instances] },
    { ...accepted, status: "applied" },
  ])
    expect(validatePublicationResult(value, envelope)).toBeNull();
  for (const code of ["SERVER_DRAFT_CHANGED", "PUBLICATION_REJECTED"])
    expect(
      validatePublicationResult(
        {
          operationId: envelope.operationId,
          deploymentId: envelope.deploymentId,
          status: "definitively-rejected",
          nativeChecked: false,
          code,
          detail: "此次提交未被接收。",
        },
        envelope,
      ),
    ).not.toBeNull();
  expect(
    validatePublicationResult(
      {
        operationId: envelope.operationId,
        deploymentId: envelope.deploymentId,
        status: "definitively-rejected",
        nativeChecked: false,
        code: "UNKNOWN",
        detail: "拒绝",
      },
      envelope,
    ),
  ).toBeNull();
});
