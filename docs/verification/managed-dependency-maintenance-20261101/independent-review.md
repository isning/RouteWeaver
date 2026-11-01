Independent reviewer: review_managed_dependency_upgrade (2026-11-01).
No blocking finding in profile closure, dependency selection or source notices.

The retained test source is an overlay replacement of runtimes/xray/config_test.go,
not an additional production test package. To reproduce, create an absolute-path
Go overlay JSON with Replace mapping that file to independent-decoder-matrix_test.go.txt.
From runtimes/xray run:
  go test -overlay /absolute/path/to/overlay.json -v -count=1 -run TestIndependentPinDecoderMatrix .
Use the repository compiler/cache contract. Matrix compares actual upstream
conf.Config parsing and public managed.Validate/New, with positive ordinary TLS.
The log also includes ordinary managed profile tests run by the reviewer.

Reviewer independently verified go list -m all versions, byte identity of all
17 new license/notice files to selected module sources, clean diff whitespace,
and CLI check/run entering Validate before IPC/journal construction.

Retained build-info and matrix source normalize trailing whitespace only.
