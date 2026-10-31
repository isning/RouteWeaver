package agent

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestNativeActivationRejectsExplicitUnsupportedMPTCP(t *testing.T) {
	for _, target := range []struct{ id, version, versionOutput, key string }{
		{"routeweaver/xray", "26.3.27", "Xray 26.3.27", "tcpMptcp"},
		{"routeweaver/sing-box", "1.14.3", "1.14.3", "tcp_multi_path"},
	} {
		t.Run(target.id, func(t *testing.T) {
			for _, config := range []string{
				fmt.Sprintf(`{"inbounds":[{"streamSettings":{"sockopt":{"%s":true}}}]}`, target.key),
				fmt.Sprintf(`{"outbounds":[{"nested":{"%s":true}}]}`, target.key),
				fmt.Sprintf(`{"inbounds":[{"%s":false,"%s":true}]}`, target.key, target.key),
				fmt.Sprintf(`{"inbounds":[{"streamSettings":{"sockopt":{"%s":true},"sockopt":{}}}]}`, target.key),
				fmt.Sprintf(`{"inbounds":[{"%s":true}]}`, strings.ToUpper(target.key)),
				fmt.Sprintf(`{} {"%s":true}`, target.key),
				`{} trailing-garbage`,
			} {
				checker, err := NewNativeChecker(target.id, target.version, fakeCore(t, fmt.Sprintf("echo '%s'", target.versionOutput)), time.Second)
				if err != nil {
					t.Fatal(err)
				}
				r := openTest(t, t.TempDir(), checker)
				d := nativeDesired(t, target.id, target.version)
				d.Artifacts[0].Content = config
				d.Digest, _ = ArtifactDigest(d.Artifacts)
				state, err := r.Submit(context.Background(), d)
				if err == nil || errors.Is(err, ErrUnsupportedActivation) || state.NativeChecked || state.Phase != ValidationFailed {
					t.Fatalf("explicit MPTCP reached native validation: %+v err=%v", state, err)
				}
			}
		})
	}
}

func TestNativeTCPPolicyDoesNotInterpretCredentialStringsAsOptions(t *testing.T) {
	for _, config := range []string{
		`{"inbounds":[{"streamSettings":{"sockopt":{"tcpMptcp":false}}}]}`,
		`{"inbounds":[{"settings":{"password":"{\"tcpMptcp\":true}","users":["tcpMptcp",true]}}]}`,
	} {
		checker, err := NewNativeChecker("routeweaver/xray", "26.3.27", fakeCore(t, `echo 'Xray 26.3.27'`), time.Second)
		if err != nil {
			t.Fatal(err)
		}
		r := openTest(t, t.TempDir(), checker)
		d := nativeDesired(t, "routeweaver/xray", "26.3.27")
		d.Artifacts[0].Content = config
		d.Digest, _ = ArtifactDigest(d.Artifacts)
		state, err := r.Submit(context.Background(), d)
		if !errors.Is(err, ErrUnsupportedActivation) || !state.NativeChecked {
			t.Fatalf("ordinary config/string rejected: %+v %v", state, err)
		}
	}
}
