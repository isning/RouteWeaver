# Backup inspection reconstruction, source only

Reconstructed from recovery inventory v91 summary, not recovered bytes of f46f657. Base: 5b350433fec764acb47a330d750f9da20e0fb096.

Inspection failures now belong to the revision and active inspection that produced them. File/password edits and clear retire visible inspection errors; late failures cannot repopulate them. Starting reinspection retires the prior valid preview and confirmation, including when reinspection fails. Existing restore uncertainty and manual-review records are preserved.

Public BackupSettings DOM regression sources cover settled and delayed failures across file/password/clear changes, failure after valid inspection, successful retry requiring fresh confirmation, and the existing same-turn restore guard. Files and fetch responses are synthetic. No real archives, passwords, backend writes or native file dialog were used.

Only source inspection and git diff --check were performed. No Node, tests, TypeScript, build, browser, Go, native runtime or aggregate checks ran. There is no red/green result or current pass count; historical v91 results do not validate this reconstruction. Independent review remains pending.
