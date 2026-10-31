# Versioned reusable templates and presets

RW-20 implements the confirmed M01 / D06 reuse policy at the template library,
user configuration, renderer and published subscription seams.

## Library and privacy contract

An administrator publishes a typed `processing-preset` or `client-profile` spec.
Each successful publication appends the next integer version in one database
transaction. `expectedVersion` must equal the current latest version; an existing
version cannot be replaced or deleted through this API. Versions include a
content digest, publisher identity and publication time. Template kind cannot
change between versions.

The shared schema is an allowlist, not arbitrary JSON with suspicious keys
removed. It has no connection credentials, source IDs, subscription links,
resource URLs/paths, transit configuration, native configuration blobs, or owner
records. Endpoint and rule-file dependencies are named binding slots. The user
binds those slots to records already materialized within their own profile.
Unknown fields, unbound/extra slots and foreign-tenant references are rejected.

`POST /api/admin/templates/sanitize` creates a reviewable safe projection of the
administrator's own collection or profile. Connections and resource descriptors
become generic slots; imported endpoint names/IDs and source provenance are not
copied. Health-check URLs become a fixed public URL. Source-specific filters and
connection-overriding processing steps are rejected rather than silently broadened
or exported. Arbitrary text deliberately authored by an administrator is not a
content-classification/DLP guarantee; the structural secret-bearing fields are
absent by construction.

## Selection and upgrades

- Independent copy: the materialized configuration is tenant-owned and never
  consults upstream again. Its provenance remains visible but update preview is
  rejected.
- Pinned reference: the applied version stays fixed even if the library advances.
  An explicit `version` in preview/apply can review and advance that pin without
  discarding personal edits.
- Following reference: a new version produces a candidate only. Nothing is
  silently changed; the user reviews and explicitly applies its digest.

Selection targets an existing owned collection or profile. Initial profile
selection explicitly adopts the selected template's default action and runtime;
existing policy groups/rules retain precedence on same-ID conflicts. Selecting
the same library again (for example to switch follow to pinned) uses the existing
baseline and preserves local runtime/default-action edits too. For updates,
all personal changes use the three-way policy below. Selecting a full-profile
spec for nodes-only delivery is rejected, not advertised as a lossless conversion.

The update preview may supply replacement slot bindings when a new version adds
or changes slots. The same bindings and `previewDigest` must be sent when applying.
Missing bindings leave the accepted configuration untouched.

## Deterministic conflict policy

The accepted upstream baseline, current tenant values and next upstream baseline
are merged by stable identity, not display names.

1. Personal modification or deletion of a step, group or rule wins over upstream
   replacement/deletion of that same ID. A same-ID personal addition also wins.
2. Unmodified items follow upstream additions, modifications and deletions.
3. If the user changed list membership or order, their ordering is retained and
   newly introduced upstream items append in upstream order. Otherwise upstream
   ordering is used. Preview lists preserved personal paths.
4. Default action, mixed listener port, sniff, DNS intent and TUN intent are
   independently compared. A locally changed field wins. DNS and TUN are atomic
   intent values, not blind recursive JSON merges.
5. Endpoints, secrets, source/collection bindings, resource descriptors, profile
   identity/name and selected client target remain tenant-local. No update changes
   an unrelated profile.

A user can edit the resulting normal profile/collection using its ordinary editor.
No separate override blob has to be manually kept in sync with those edits.

## Validation, persistence and publication

Processing candidates run through the real ordered source pipeline, then the
selected target renderer. Existing profiles using that collection are also
materialized and rendered against the candidate endpoints. Full-profile
candidates bind owned records, merge personal policy, and render the exact chosen
adapter/version. Unsupported target behavior returns an incompatible preview.

Preview is read-only. Its digest covers the exact upstream version, applied
baseline, local record, resolved candidate and target. Apply recomputes it, then
atomically compares both the target and relationship record before committing
both writes. Concurrent edits/rebinding require a fresh preview; failures cannot
partially advance the relationship.

Applying updates a draft, never a published output or access link. Publication
continues through the existing explicit subscription publication endpoint. A
failed candidate, failed apply or failed publication retains the last valid
published artifact. An unrenderable library version is not a universal claim of
compatibility; library publication checks typed shape and domain invariants, while
selection checks concrete private bindings and the actual target.

HTTP preview reports `nativeChecked: false`: it invokes the compiler, not a child
core process. The pinned native acceptance test separately traverses library
selection, followed update, native parser validation and publication on Mihomo
1.19.32 and sing-box 1.14.3. Parser acceptance is not deployment, network reachability
or runtime enforcement proof. Private resource URL delivery and local bundles
retain the renderer/publication limitations already documented by those modules.

## API

- GET `/api/templates`: latest versions.
- GET `/api/templates/{id}/versions`: immutable history.
- POST `/api/admin/templates`: `{id,name,kind,expectedVersion,spec}`.
- POST `/api/admin/templates/sanitize`: `{kind,targetId}`.
- POST `/api/me/templates/{id}/select`:
  `{version,mode,targetId,bindings?,target?}`. `target` applies to processing presets;
  client-profile templates keep the profile's selected target.
- GET `/api/me/template-bindings`: provenance without private baselines/secrets.
- POST `/api/me/template-bindings/{id}/preview`: `{bindings?,version?}`.
- POST `/api/me/template-bindings/{id}/apply`: `{previewDigest,bindings?,version?}`.

Binding IDs returned by the API identify one current relationship per target.
Selecting a different template explicitly replaces that relationship, not the
published output. A library's version 0 in selection resolves to its latest version
at selection time; a pinned selection then stores the concrete version.
