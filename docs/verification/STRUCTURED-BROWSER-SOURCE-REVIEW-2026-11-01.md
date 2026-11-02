# Independent E07 source review

Reviewed `3bddf0b437b5ec28a6dabbd202a1fc988574ce65` against base
`23650ca`, including the real HTTP matrix, recorded DOM red/green and the two
unrun structured-runtime browser journeys.

## Product fix

The DNS enable handler previously generated a resolver ID but assigned unrelated
`primary-dns` as the final reference. The author's recorded regression fails on
that exact mismatch. Reusing the generated ID for both fields is a minimal,
correct identity fix. It does not alter capability validation, native execution,
DNS resolution or TUN activation. Independent focused DOM execution below
includes the new retained-draft regression. No additional production edit made.

## Browser defects corrected before CI

1. The new profile has no output. Once the authoritative output inventory loads,
   `Subscriptions.tsx` labels its opener **继续配置**, not **编辑配置**. The old
   selector could only match a transient loading label, or time out after load.
   Use the exact stable **继续配置** opener. Existing actual-component workspace
   coverage independently exercises this unpublished-profile path.
2. The browser fixture used stock server version `1.14.4` as a client target.
   `render.SingBoxVersion` currently declares client configuration-schema
   compatibility `1.14.3`; `ClientRegistry.Render` rejects undeclared targets.
   The test now reads `/api/me/capabilities` from the real authenticated backend,
   requires one sing-box descriptor/one declared version plus DNS/sniff/TUN
   capabilities, and uses that declared version. This is **not an executable
   downgrade or an installation recommendation**. Runtime binary version and
   native validation remain governed by their separate existing gates.
3. Strengthened acceptance of authored edits: require exactly one saved resolver
   with the entered address/type/port, one domain-suffix rule with direct action,
   and exact rendered DNS server/final correspondence. Merely finding some DNS
   object or a matching rule value no longer passes if those edits are lost.

## Remaining review

The exact rule combobox locator follows its actual Radix `aria-controls` to the
popover and exact option text; labels match `ChoiceSelect` and `RuntimeEditor`.
No guessed footer marker or duplicate Close selector is used. Click/fill actions
retain Playwright's real actionability checks; the journey makes no geometry or
settled screenshot claim. The TUN switch uses focus + Space and checks its state.
The save-response listener precedes the UI mutation. Later reads/publication use
real authenticated HTTP, not fulfilled routes or synthetic frontend success.
Authentication uses the existing isolated normal CLI and invited ordinary user.
API preview/publication is deliberately not represented as publication-review UI
coverage; output equality after reload is not native process execution.

## Independent checks

- Exact-lock dependencies already installed with `npm ci --ignore-scripts --offline`.
- Explicit strict TypeScript for the corrected browser entrypoint: PASS.
- Browser discovery: two cases; **UNRUN** until coordinator-authorized CI.
- `profile-content-hierarchy.dom.test.tsx` and
  `subscription-workspace.dom.test.tsx`: **32/32 passed**, one worker.
- `git diff --check`: PASS.

No local browser, DNS lookup, native/TUN process, CI trigger, push or deployment.
Source-visible browser blockers were corrected; no actual browser red/green is
claimed. Author's HTTP race evidence is inspected, not falsely counted as an
independent rerun here.
