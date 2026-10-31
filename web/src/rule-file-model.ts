import type { RuleResource } from "./types";
// Resource summaries include inspection metadata that is not client IR input.
export function ruleResourceReference(r: RuleResource): RuleResource {
  const {
    id,
    name,
    ownerId,
    revision,
    digest,
    format,
    formatVersion,
    behavior,
    location,
    path,
    url,
    visibility,
    updatePolicy,
    intervalSeconds,
    acceptedVersion,
    sizeBytes,
  } = r;
  return {
    id,
    name,
    ownerId,
    revision,
    digest,
    format,
    formatVersion,
    behavior,
    location,
    path,
    url,
    visibility,
    updatePolicy,
    intervalSeconds,
    acceptedVersion,
    sizeBytes,
  };
}
