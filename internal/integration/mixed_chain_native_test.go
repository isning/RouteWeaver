//go:build linux

package integration_test

import (
	"bytes"
	"context"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"routeweaver/internal/agent"
	"routeweaver/internal/domain"
	"routeweaver/internal/entrypolicy"
	"routeweaver/internal/render"
)

// Real rendered native processes speak RFC 1928/1929 to independent external
// peers. This proves TCP connector routing, not control-plane publication,
// remote deployment, all proxy protocols, UDP, or managed transit support.
func TestNativeMixedConnectorChainLoopback(t *testing.T) {
	for _, core := range []string{"xray", "sing-box"} {
		t.Run(core, func(t *testing.T) {
			if !strings.Contains(","+os.Getenv("ROUTEWEAVER_NATIVE_PROCESS_TESTS")+",", ","+core+",") {
				t.Skip("explicit local native process opt-in required")
			}
			binary := mixedStockBinary(t, core)
			mixedChainScenarios(t, core, binary, core, binary)
		})
	}
}

func TestManagedMixedConnectorChainLoopback(t *testing.T) {
	binary := os.Getenv("ROUTEWEAVER_MANAGED_XRAY_BIN")
	if binary == "" || !strings.Contains(","+os.Getenv("ROUTEWEAVER_NATIVE_PROCESS_TESTS")+",", ",xray,") {
		t.Skip("explicit managed binary and local Xray process opt-in required")
	}
	mixedChainScenarios(t, "managed-xray", binary, "xray", mixedStockBinary(t, "xray"))
}

func mixedStockBinary(t *testing.T, core string) string {
	t.Helper()
	dir := os.Getenv("ROUTEWEAVER_STOCK_CORE_BIN_DIR")
	if dir == "" {
		t.Fatal("selected mixed-chain process test requires exact stock-core cache; missing binary is not a pass")
	}
	_, version := mixedNativeIdentity(core)
	return filepath.Join(dir, core+"-"+version+"-linux-amd64")
}

func mixedNativeIdentity(core string) (string, string) {
	switch core {
	case "xray":
		return render.ServerAdapterXray, render.StockXrayVersion
	case "sing-box":
		return render.ServerAdapterSingBox, render.StockSingBoxVersion
	case "managed-xray":
		return render.ServerAdapterManagedXray, render.ManagedXrayVersion
	default:
		panic("unknown synthetic native core")
	}
}

func mixedChainScenarios(t *testing.T, core, binary, finalCore, finalBinary string) {
	t.Helper()
	for _, scenario := range []struct {
		name      string
		externals int
		listener  bool
	}{
		{"one-external-to-target", 1, false},
		{"two-external-to-target", 2, false},
		{"two-external-to-stock-listener", 2, true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			target := mixedEchoTarget(t)
			entryPort, releaseEntryPort := mixedReservePort(t)
			entry := mixedProgram("entry", core, entryPort, "00000000-0000-4000-8000-000000000081")
			programs := []domain.ServerProgram{}
			next := target.address()
			var final domain.ServerProgram
			var releaseFinalPort func()
			if scenario.listener {
				var finalPort int
				finalPort, releaseFinalPort = mixedReservePort(t)
				final = mixedProgram("last", finalCore, finalPort, "00000000-0000-4000-8000-000000000082")
				// A stock transit listener has one service credential, not per-user
				// branches. This matches the published linear-transit contract.
				final.Listener.Authentication = ""
				final.Listener.Connection.UUID = final.Principals[0].Credential.UUID
				final.Principals = nil
				final.DefaultAction = domain.ActionRef{Kind: "direct"}
				programs = append(programs, final)
				next = net.JoinHostPort("127.0.0.1", strconv.Itoa(final.Listener.Connection.Port))
			}
			peers := make([]*mixedSOCKSPeer, scenario.externals)
			for i := len(peers) - 1; i >= 0; i-- {
				peers[i] = mixedSOCKSProxy(t, next, i+1)
				next = peers[i].address()
			}
			previous := ""
			for i, peer := range peers {
				id := []string{"z-first-external", "a-second-external"}[i]
				_, portText, _ := net.SplitHostPort(peer.address())
				port, err := strconv.Atoi(portText)
				if err != nil {
					t.Fatal(err)
				}
				entry.Connectors = append(entry.Connectors, domain.ServerConnector{ID: id, Via: previous, Connection: domain.Connection{Protocol: "socks", Host: "127.0.0.1", Port: port, Username: peer.username, Password: peer.password}})
				previous = id
			}
			if scenario.listener {
				connection := final.Listener.Connection
				entry.Connectors = append(entry.Connectors, domain.ServerConnector{ID: "m-last-listener", Via: previous, Connection: connection})
				previous = "m-last-listener"
			}
			entry.Principals[0].Action = domain.ActionRef{Kind: "forward", Ref: previous}
			// IDs sort differently from route order. Reverse two declarations;
			// for three use a non-reversal permutation. Neither positional nor
			// lexical chaining can satisfy all successor/byte assertions.
			if len(entry.Connectors) > 1 {
				entry.Connectors[0], entry.Connectors[1] = entry.Connectors[1], entry.Connectors[0]
			}
			programs = append(programs, entry)
			artifacts, err := render.DefaultServers().Render(domain.ServerDeploymentIR{SchemaVersion: "1.0", ID: "mixed-native", TopologyRevision: "r1", Programs: programs})
			if err != nil {
				t.Fatal(err)
			}
			if scenario.listener {
				mixedRunProgram(t, final, finalBinary, artifacts, releaseFinalPort)
			}
			mixedRunProgram(t, entry, binary, artifacts, releaseEntryPort)

			address := net.JoinHostPort("127.0.0.1", strconv.Itoa(entryPort))
			credential := entry.Principals[0].Credential.UUID
			payload := []byte("mixed-chain/" + t.Name() + "/opaque\x00payload/" + strings.Repeat("0123456789abcdef", 256))
			prove := func(stage string) {
				t.Helper()
				beforeTarget := target.snapshot()
				before := make([]mixedWireStats, len(peers))
				for i, peer := range peers {
					before[i] = peer.snapshot()
				}
				if err := mixedRoundtrip(address, target.address(), credential, payload); err != nil {
					t.Fatalf("%s native mixed payload: %v", stage, err)
				}
				mixedAwait(t, func() bool {
					after := target.snapshot()
					if after.Accepted != beforeTarget.Accepted+1 || after.Upload-beforeTarget.Upload != int64(len(payload)) || after.Download-beforeTarget.Download != int64(len(payload)) {
						return false
					}
					for i, peer := range peers {
						after := peer.snapshot()
						if after.Authenticated != before[i].Authenticated+1 || after.Connected != before[i].Connected+1 || after.RejectedTarget != 0 || after.Target != peer.next || after.Upload-before[i].Upload < int64(len(payload)) || after.Download-before[i].Download < int64(len(payload)) {
							return false
						}
					}
					return true
				}, "each authenticated hop and exact target duplex bytes")
				for i, peer := range peers {
					t.Logf("%s hop=%d next=%s stats=%+v", stage, i+1, peer.next, peer.snapshot())
				}
			}
			prove("shuffled-declarations")

			// Unknown ingress authentication must not even touch external peers.
			beforePeer := peers[0].snapshot()
			mixedRequireDenied(t, address, target, "00000000-0000-4000-8000-000000000099", payload)
			if peers[0].snapshot().Accepted != beforePeer.Accepted {
				t.Fatal("unknown ingress principal reached an external proxy")
			}

			// Revoke only the last external peer's synthetic password. The native
			// config still presents the now-wrong credential over a real handshake.
			last := peers[len(peers)-1]
			beforeAuth := last.snapshot()
			last.rejectAuth.Store(true)
			mixedRequireDenied(t, address, target, credential, payload)
			afterAuth := last.snapshot()
			if afterAuth.RejectedAuth <= beforeAuth.RejectedAuth || afterAuth.Connected != beforeAuth.Connected {
				t.Fatalf("wrong external authentication was not observed without onward dial: before=%+v after=%+v", beforeAuth, afterAuth)
			}
			last.rejectAuth.Store(false)
			prove("authentication-restored")

			// Physically remove a required external listener. Its predecessor can
			// still be reached, but no fallback may connect or send to the target.
			beforeCut := peers[0].snapshot()
			last.close()
			mixedRequireDenied(t, address, target, credential, payload)
			if len(peers) > 1 && peers[0].snapshot().Authenticated <= beforeCut.Authenticated {
				t.Fatal("broken-middle negative did not reach the preceding external hop")
			}
			t.Log("wrong ingress credential, wrong external authentication, and removed required hop all left target connection and byte counts unchanged")
		})
	}
}

func mixedProgram(id, core string, port int, uuid string) domain.ServerProgram {
	adapter, version := mixedNativeIdentity(core)
	program := domain.ServerProgram{
		Instance:      domain.CoreInstance{ID: id, HostID: "loopback-fixture", AdapterID: adapter, Version: version},
		Listener:      domain.ManagedEndpoint{ID: id + "-listener", InstanceID: id, Name: "Synthetic " + id, Authentication: "principals", Connection: domain.Connection{Protocol: "vless", Host: "127.0.0.1", Port: port}},
		DefaultAction: domain.ActionRef{Kind: "reject"},
		Principals:    []domain.ServerPrincipal{{SubjectID: "mixed-" + id, AccountID: "synthetic-account", RouteID: "synthetic-route", CredentialVersion: "v1", PolicyRevision: "p1", CycleID: "cycle1", Credential: domain.PrincipalCredential{UUID: uuid}, Action: domain.ActionRef{Kind: "direct"}}},
	}
	if core != "sing-box" {
		program.DestinationPolicy = &domain.DestinationPolicy{AllowCIDRs: []string{"127.0.0.1/32"}}
	}
	return program
}

func mixedReservePort(t *testing.T) (int, func()) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	release := func() { listener.Close() }
	t.Cleanup(release)
	return listener.Addr().(*net.TCPAddr).Port, release
}

func mixedRunProgram(t *testing.T, program domain.ServerProgram, source string, artifacts []domain.Artifact, releasePort func()) {
	t.Helper()
	root, err := os.MkdirTemp("", "rw-mixed-native-")
	if err != nil {
		t.Fatal(err)
	}
	retain := false
	t.Cleanup(func() {
		if t.Failed() {
			retain = true
		}
		if retain {
			t.Logf("mixed native evidence retained at %s", root)
		} else {
			os.RemoveAll(root)
		}
	})
	content, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(root, "immutable-native-core")
	if err = os.WriteFile(binary, content, 0700); err != nil {
		t.Fatal(err)
	}
	checker, err := agent.NewNativeChecker(program.Instance.AdapterID, program.Instance.Version, binary, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	supervisor, err := agent.NewProcessSupervisor(checker, agent.SupervisorOptions{AllowLocalProcess: true, StartupGrace: 150 * time.Millisecond, StopTimeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	scope := agent.Scope{NodeID: program.Instance.HostID, InstanceID: program.Instance.ID, EnrollmentEpoch: "synthetic-epoch"}
	reconciler, err := agent.Open(root, scope, agent.NewRegistry(supervisor), agent.Options{MaxLease: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	var closeBroker func() error
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := supervisor.Stop(ctx, root); err != nil {
			retain = true
			t.Errorf("owned mixed native cleanup refused; evidence retained at %s: %v", root, err)
		}
		if closeBroker != nil {
			if err := closeBroker(); err != nil {
				retain = true
				t.Errorf("mixed native broker close: %v", err)
			}
		}
		if err := reconciler.Close(); err != nil {
			retain = true
			t.Errorf("mixed native reconciler close: %v", err)
		}
	})
	if program.Instance.AdapterID == render.ServerAdapterManagedXray {
		broker, err := agent.StartAdmissionBroker(root, mixedAdmission{})
		if err != nil {
			t.Fatal(err)
		}
		closeBroker = broker.Close
	}
	var material []domain.Artifact
	for _, artifact := range artifacts {
		if strings.HasPrefix(artifact.Path, program.Instance.ID+"/") {
			material = append(material, domain.Artifact{Path: strings.TrimPrefix(artifact.Path, program.Instance.ID+"/"), Content: artifact.Content})
		}
	}
	digest, err := agent.ArtifactDigest(material)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	desired := agent.Desired{Scope: scope, AdapterID: program.Instance.AdapterID, CoreVersion: program.Instance.Version, Generation: 1, RevisionID: "r1", OperationID: "mixed-apply", Digest: digest, EntryFile: "config.json", Artifacts: material, Lease: agent.PolicyLease{Revision: "p1", IssuedAt: now.Add(-time.Second), ExpiresAt: now.Add(5*time.Minute), AccessAllowed: true, QuotaCertain: true}}
	releasePort()
	state, err := reconciler.Submit(context.Background(), desired)
	if err != nil || state.Phase != agent.ObservedConformant || state.Observed == nil || state.Observed.Identity != desired.Identity() {
		retain = true
		t.Fatalf("rendered mixed native apply: phase=%s err=%v evidence=%s", state.Phase, err, root)
	}
	// Process liveness is not listener readiness. Only a bare pre-payload
	// loopback readiness connection is retried, never a failed traffic attempt.
	address := net.JoinHostPort("127.0.0.1", strconv.Itoa(program.Listener.Connection.Port))
	mixedAwait(t, func() bool {
		conn, err := net.DialTimeout("tcp", address, 50*time.Millisecond)
		if err != nil {
			return false
		}
		conn.Close()
		return true
	}, "native listener readiness")
}

// Routing-only authority, deliberately not a control-plane or quota proof.
// Both the broker request and returned identity are bound to the synthetic entry.
type mixedAdmission struct{}

func (mixedAdmission) Acquire(_ context.Context, request entrypolicy.AdmissionRequest) (entrypolicy.Lease, error) {
	if request.SubjectID != "mixed-entry" || request.EntryID != "entry-listener" || request.CredentialVersion != "v1" || request.ClientIP != "127.0.0.1" {
		return entrypolicy.Lease{Allowed: false, Reason: "wrong-synthetic-binding"}, nil
	}
	return entrypolicy.Lease{Allowed: true, LeaseID: request.PresenceID, AccountID: "synthetic-account", RouteID: "synthetic-route", ExpiresAt: time.Now().Add(entrypolicy.MaxLease)}, nil
}
func (mixedAdmission) Release(context.Context, string) error { return nil }

func mixedRoundtrip(address, target, uuid string, payload []byte) error {
	conn, err := net.DialTimeout("tcp", address, time.Second)
	if err != nil {
		return err
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(2*time.Second))
	credential, err := hex.DecodeString(strings.ReplaceAll(uuid, "-", ""))
	if err != nil || len(credential) != 16 {
		return fmt.Errorf("invalid synthetic UUID")
	}
	host, portText, err := net.SplitHostPort(target)
	if err != nil || host != "127.0.0.1" {
		return fmt.Errorf("invalid loopback target")
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		return err
	}
	header := append([]byte{0}, credential...)
	header = append(header, 0, 1, byte(port>>8), byte(port), 1, 127, 0, 0, 1)
	if _, err := conn.Write(append(header, payload...)); err != nil {
		return err
	}
	response := make([]byte, 2+len(payload))
	if _, err := io.ReadFull(conn, response); err != nil {
		return err
	}
	if !bytes.Equal(response[:2], []byte{0, 0}) || !bytes.Equal(response[2:], payload) {
		return fmt.Errorf("VLESS response or opaque payload mismatch")
	}
	return nil
}

func mixedRequireDenied(t *testing.T, address string, target *mixedWireServer, uuid string, payload []byte) {
	t.Helper()
	before := target.snapshot()
	if err := mixedRoundtrip(address, target.address(), uuid, payload); err == nil {
		t.Fatal("failed required hop or credential silently fell back")
	}
	// The client error alone is insufficient: the still-live target must see no
	// connection or data throughout a bounded post-attempt observation window.
	until := time.Now().Add(200*time.Millisecond)
	for {
		after := target.snapshot()
		if after.Accepted != before.Accepted || after.Upload != before.Upload || after.Download != before.Download {
			t.Fatalf("denied mixed attempt reached target: before=%+v after=%+v", before, after)
		}
		if time.Now().After(until) {
			return
		}
		time.Sleep(5*time.Millisecond)
	}
}

func mixedAwait(t *testing.T, ready func() bool, description string) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for !ready() {
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for "+description)
		}
		time.Sleep(5*time.Millisecond)
	}
}
