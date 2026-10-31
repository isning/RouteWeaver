package store_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"routeweaver/internal/service"
	"routeweaver/internal/store"
)

type processAdmissionInput struct{ Path, Presence, IP string }
type processAdmissionResult struct {
	Decision store.AdmissionDecision
	Error    string
}

// Real independent test processes contend through SQLite, not one Go mutex.
// Child credentials and records are synthetic and confined to a temporary DB.
func TestAdmissionClaimsAcrossProcesses(t *testing.T) {
	if child := os.Getenv("ROUTEWEAVER_TEST_ADMISSION_CHILD"); child != "" {
		var input processAdmissionInput
		if err := json.Unmarshal([]byte(child), &input); err != nil {
			t.Fatal(err)
		}
		s, err := store.Open(input.Path, bytes.Repeat([]byte{21}, 32))
		if err != nil {
			t.Fatal(err)
		}
		defer s.Close()
		fmt.Println("ready")
		if !bufio.NewScanner(os.Stdin).Scan() {
			t.Fatal("missing parent release")
		}
		decision, err := s.AcquireAdmission(store.AdmissionScope{NodeID: "node", InstanceID: "instance", EnrollmentEpoch: "enrollment"}, admissionRequest("entry1", input.IP, input.Presence), time.Now().UTC())
		result := processAdmissionResult{Decision: decision}
		if err != nil {
			result.Error = err.Error()
		}
		if err = json.NewEncoder(os.Stdout).Encode(result); err != nil {
			t.Fatal(err)
		}
		return
	}
	for _, mode := range []string{"last-ip", "last-stream", "last-quota-byte"} {
		t.Run(mode, func(t *testing.T) {
			s, path, _, _, _ := admissionFixture(t)
			plan := service.Plan{ID: "plan", Name: "Plan", RouteIDs: []string{"route"}, OnlineIPLimit: 1, EntryRateBPS: 1024}
			if mode == "last-stream" {
				plan.ConnectionLimit = 1
			}
			if mode == "last-quota-byte" {
				plan.QuotaBytes = 1
			}
			if err := s.PutServicePlan(plan); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			commands := make([]*exec.Cmd, 2)
			t.Cleanup(func() {
				for _, cmd := range commands {
					if cmd != nil && cmd.Process != nil && cmd.ProcessState == nil {
						_ = cmd.Process.Kill()
						_ = cmd.Wait()
					}
				}
			})
			readers := make([]*bufio.Scanner, 2)
			errorsOut := make([]bytes.Buffer, 2)
			releases := make([]func(), 2)
			failChild := func(i int, message string) {
				t.Helper()
				cancel()
				var remaining []string
				for readers[i].Scan() {
					remaining = append(remaining, readers[i].Text())
				}
				waitErr := commands[i].Wait()
				t.Fatalf("child %d %s; wait=%v; stdout=%s; stderr=%s", i, message, waitErr, strings.Join(remaining, "\n"), errorsOut[i].String())
			}
			for i := range commands {
				ip := "192.0.2.1"
				if mode == "last-ip" {
					ip = fmt.Sprintf("192.0.2.%d", i+1)
				}
				input, _ := json.Marshal(processAdmissionInput{Path: path, Presence: fmt.Sprintf("process-%d", i), IP: ip})
				cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestAdmissionClaimsAcrossProcesses$", "-test.count=1", "-test.timeout=30s")
				cmd.Env = append(os.Environ(), "ROUTEWEAVER_TEST_ADMISSION_CHILD="+string(input))
				cmd.Stderr = &errorsOut[i]
				stdin, err := cmd.StdinPipe()
				if err != nil {
					t.Fatal(err)
				}
				stdout, err := cmd.StdoutPipe()
				if err != nil {
					t.Fatal(err)
				}
				commands[i] = cmd
				readers[i] = bufio.NewScanner(stdout)
				releases[i] = func() { fmt.Fprintln(stdin, "claim"); stdin.Close() }
				if err = cmd.Start(); err != nil {
					t.Fatal(err)
				}
			}
			for i, reader := range readers {
				if !reader.Scan() || reader.Text() != "ready" {
					failChild(i, "not ready: "+reader.Text())
				}
			}
			for _, release := range releases {
				release()
			}
			allowed := 0
			var granted uint64
			for i, reader := range readers {
				if !reader.Scan() {
					failChild(i, fmt.Sprintf("no result: %v", reader.Err()))
				}
				var result processAdmissionResult
				if err := json.Unmarshal(reader.Bytes(), &result); err != nil {
					t.Fatalf("child result: %s: %v", reader.Text(), err)
				}
				if err := commands[i].Wait(); err != nil {
					t.Fatalf("child %d: %v; %s", i, err, errorsOut[i].String())
				}
				if result.Error != "" {
					t.Fatal(result.Error)
				}
				if result.Decision.Allowed {
					allowed++
					if result.Decision.ByteBudget != nil {
						granted += *result.Decision.ByteBudget
					}
				}
			}
			if allowed != 1 {
				t.Fatalf("%s admitted %d competing processes, want 1", mode, allowed)
			}
			if mode == "last-quota-byte" && granted != 1 {
				t.Fatalf("reserved %d raw bytes, want exactly 1", granted)
			}
			status, err := s.AdmissionStatus("account", time.Now().UTC())
			if err != nil || status.ActiveStreams != 1 || len(status.OnlineIPs) != 1 {
				t.Fatalf("durable claims: %+v %v", status, err)
			}
		})
	}
}
