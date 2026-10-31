# Secret-content gate

```sh
python3 scripts/security/bootstrap.py
python3 -m unittest discover -s scripts -p test_secrets.py
python3 scripts/check-secrets.py
```

The bootstrap installs the **official Gitleaks 8.24.3 Linux amd64** executable
under ignored `bin/tools/`. Its release archive is pinned to the upstream release
checksum, and its executable bytes are checked both during installation and on
every scan. This is a reviewed version pin, not a claim to track the latest release.
No action license, GitHub token, service credential, or external upload is used.

`gitleaks.upstream.toml` and `LICENSE.gitleaks` retain exact upstream bytes. The
config checksum is checked before use. At runtime, the wrapper removes the global
path exemptions and every complete rule allowlist containing a path condition.
It does not change detector regexes, value stopwords, or rule-specific path
detectors. Removing an entire path-conditioned allowlist (rather than only its
path clause) avoids accidentally broadening an AND exemption.

## What is scanned

The default `--scope all` requires a non-shallow Git repository with HEAD:

- Current tracked files plus Git-visible untracked files (`--exclude-standard`).
  Ignored, untracked local caches/operator state are **not** claimed as scanned.
- Every index blob, including a staged change subsequently overwritten in the
  worktree. Unmerged indexes and submodules fail closed.
- Every distinct path/blob pair in every commit reachable from local refs and
  HEAD. CI must use `fetch-depth: 0`; absent remote refs, unreachable objects and
  reflogs are not part of this claim.

Blobs are read directly, not through patches or Git's text/binary classification.
This covers deleted binary-attributed files and secrets introduced only in merge
commits. Original relative paths are retained for path-specific detectors. Binary
bytes are decoded as UTF-8 (or BOM-marked UTF-16/UTF-32) with replacement and
control bytes normalized to spaces,
so plaintext tokens embedded in binary-typed files are not silently skipped.
No target-size skip limit is enabled. This does **not** decrypt data or unpack
arbitrary binary/archive formats.

The explicit `--scope tree` mode scans current source only, without claiming index
or history coverage. Outside Git it omits `.git`, `bin`, `node_modules`, `.local`,
Python caches and web build/test outputs. It is useful for a source archive, but
does not satisfy the mandatory full-history CI gate.

Symlink target strings are scanned without following the target. A source path
whose parent resolves outside the repository fails; the scanner does not read
external files. No `git add`, repository edits, or history rewrites are performed.

## Findings and narrowly reviewed exceptions

Gitleaks runs with redaction, ignored inline allow comments, a private nonexistent
ignore-file path, and an explicit pinned config. User `GITLEAKS_*` environment
overrides are removed. Raw scanner output is never emitted; temporary reports are
deleted. Findings contain only the source label, path, rule and line number.

`false-positives.json` records only a **path + rule + exact source-line SHA256** and
a review reason. Current entries cover known synthetic test keys and checksum
text. No whole file, test directory, lockfile, vendor tree, or token value is
blanket-allowlisted. A changed line or additional finding requires new review;
line-zero/path-only findings cannot receive content exceptions. Do not add an
exception for a real or uncertain credential. Revoke/rotate an actual exposed
credential through its owner before considering history cleanup.

Exit 0 means the configured scan completed without unreviewed findings; exit 1
means potential secrets; exit 2 means incomplete/invalid scanning. Missing or
modified scanner bytes, shallow history and unsupported source entries are
failures, not successful skips. Pattern detection is not credential validation or
a general security certification.

## Updating the pin

Review an official release, independently check its published checksum, update
archive/executable/config identities in `gitleaks.lock.json`, preserve the new
upstream config and license bytes, and run all actual-engine regressions plus a
complete repository scan. Review new findings individually. Do not merely relax
rules to restore a green result. The current bootstrap supports Linux amd64; other
platforms need independently verified release pins before they can be supported.
