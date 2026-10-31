package agent

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func fakeCore(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "fixture-core")
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"+body+"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	return p
}
func nativeDesired(t *testing.T, id, version string) Desired {
	d := testDesired(t, 1)
	d.AdapterID = id
	d.CoreVersion = version
	return d
}
func TestNativeCheckIsNotRuntimeApplication(t *testing.T) {
	binary := fakeCore(t, `if [ "$1" = "version" ]; then echo "Xray 26.3.27 (fixture)"; exit 0; fi
[ "$1" = "run" ] && [ "$2" = "-test" ] && [ "$3" = "-format" ] && [ "$4" = "json" ] && [ "$5" = "-config" ] && [ -f "$6" ] || exit 5`)
	a, err := NewNativeChecker("routeweaver/xray", "26.3.27", binary, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	r := openTest(t, t.TempDir(), a)
	st, err := r.Submit(context.Background(), nativeDesired(t, "routeweaver/xray", "26.3.27"))
	if !errors.Is(err, ErrUnsupportedActivation) || !st.NativeChecked || st.Observed != nil || st.Phase != Blocked {
		t.Fatalf("native validation falsely applied: %+v %v", st, err)
	}
	if _, err = os.Lstat(filepath.Join(r.Root(), "current")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("validation switched active pointer: %v", err)
	}
}
func TestNativeVersionFailureAndOutputAreBounded(t *testing.T) {
	cases := []struct {
		name, script string
		timeout      time.Duration
	}{
		{"version_mismatch", `echo "sing-box version 999"`, time.Second},
		{"timeout", `if [ "$1" = "version" ]; then echo 1.14.3; else exec sleep 5; fi`, 30 * time.Millisecond},
		{"output_limit", `if [ "$1" = "version" ]; then echo 1.14.3; else head -c 100000 /dev/zero; fi`, time.Second},
		{"secret_error", `if [ "$1" = "version" ]; then echo 1.14.3; else echo SECRET_FIXTURE_PASSWORD >&2; exit 1; fi`, time.Second},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a, err := NewNativeChecker("routeweaver/sing-box", "1.14.3", fakeCore(t, tc.script), tc.timeout)
			if err != nil {
				t.Fatal(err)
			}
			r := openTest(t, t.TempDir(), a)
			start := time.Now()
			st, err := r.Submit(context.Background(), nativeDesired(t, "routeweaver/sing-box", "1.14.3"))
			if err == nil || st.Phase != ValidationFailed || strings.Contains(err.Error(), "SECRET_FIXTURE") {
				t.Fatalf("bad failure: %+v %v", st, err)
			}
			if time.Since(start) > 2*time.Second {
				t.Fatal("command was not bounded")
			}
		})
	}
}
func TestNativePinnedBinariesWhenExplicitlyAvailable(t *testing.T) {
	dir := os.Getenv("ROUTEWEAVER_CORE_BIN_DIR")
	if dir == "" {
		t.Skip("native binaries not configured; fixture tests are not native-core evidence")
	}
	for _, tc := range []struct{ id, version, binary, config string }{{"routeweaver/xray", "26.3.27", "xray", `{"inbounds":[],"outbounds":[{"protocol":"freedom","tag":"direct"}]}`}, {"routeweaver/sing-box", "1.14.3", "sing-box", `{"inbounds":[],"outbounds":[{"type":"direct","tag":"direct"}]}`}} {
		t.Run(tc.binary, func(t *testing.T) {
			a, err := NewNativeChecker(tc.id, tc.version, filepath.Join(dir, tc.binary), 5*time.Second)
			if err != nil {
				t.Fatal(err)
			}
			r := openTest(t, t.TempDir(), a)
			d := nativeDesired(t, tc.id, tc.version)
			d.Artifacts[0].Content = tc.config
			d.Digest, _ = ArtifactDigest(d.Artifacts)
			st, err := r.Submit(context.Background(), d)
			if !errors.Is(err, ErrUnsupportedActivation) || !st.NativeChecked || st.Observed != nil {
				t.Fatalf("native check: %+v %v", st, err)
			}
		})
	}
}
