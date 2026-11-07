# Template extraction lifecycle reconstruction, source only

Reconstructed from recovery inventory v92 summary; unavailable a9d2487 bytes were not recovered. The branch begins at integration 5b350433fec764acb47a330d750f9da20e0fb096 and includes the separately committed backup reconstruction.

Extraction now captures its source, kind and revision at the user gesture. A synchronous extraction owner excludes duplicate extraction and publication until settlement; the publication owner also excludes extraction. Re-extraction retires prior review and disables review/publication while pending. Source/type/publication-position changes and manual structure edits retire extraction errors; stale extraction success and failure cannot replace current draft state. Existing draft structure is preserved during re-extraction and on failure, allowing explicit review of that retained structure afterward. This is not a server publication idempotency or unknown-outcome fix.

Public TemplatesPage DOM test sources cover re-extraction after review, same-turn overlap in both directions, duplicate extraction, fresh review after success, and settled/delayed failures after source/type/publication-position changes. Fetch responses are synthetic; no actual template publication occurred. Existing lifecycle sources remain in place.

Read AGENTS.md, GLOSSARY.md, content-design rules, recovered tdd/tests/mocking skills and code-review guidance. The AGENTS-referenced shared skills path and recovered codebase-design text were absent; no network fetch was attempted. Public DOM and synthetic transport seams were authorized in the assignment.

Only source inspection and git diff --check ran. No tests, TypeScript, build, browser, assistive technology, Node, Go, backend, native runtime or aggregate validation ran. Historical v92 pass counts are not current evidence; no red/green or independent-review result is claimed. Independent review and executable validation remain pending.
