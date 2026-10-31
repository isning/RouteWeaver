package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fixture(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	for path, content := range files {
		path = filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestGuardRejectsForbiddenImportAtPublicCommandSeam(t *testing.T) {
	p := policy{Module: "routeweaver", Allowed: map[string][]string{"domain": {}}, Forbidden: map[string][]string{"domain": {"net/http", "database/sql"}}}
	root := fixture(t, map[string]string{"internal/domain/bad.go": `package domain; import ("net/http"; "routeweaver/internal/store")`})
	got, err := inspect(root, p)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || !strings.Contains(strings.Join(got, "\n"), "domain -> store") {
		t.Fatalf("expected two independent violations, got %v", got)
	}
}

func TestGuardAllowsDeclaredDirectionAndValueParsing(t *testing.T) {
	p := policy{Module: "routeweaver", Allowed: map[string][]string{"domain": {}, "render": {"domain"}}, Forbidden: map[string][]string{"domain": {"net/http"}}}
	root := fixture(t, map[string]string{"internal/domain/id.go": `package domain; import "net"`, "internal/render/config.go": `package render; import "routeweaver/internal/domain"`})
	got, err := inspect(root, p)
	if err != nil || len(got) != 0 {
		t.Fatalf("expected declared pure dependency to pass: %v %v", got, err)
	}
}

func TestGuardRejectsUnclassifiedProductionModules(t *testing.T) {
	root := fixture(t, map[string]string{"internal/sneaky/module.go": `package sneaky`})
	got, err := inspect(root, policy{Module: "routeweaver", Allowed: map[string][]string{}})
	if err != nil || len(got) != 1 || !strings.Contains(got[0], "no explicit architecture policy") {
		t.Fatalf("missing policy must not silently pass: %v %v", got, err)
	}
}

func TestRuntimeSDKBoundaryIsExplicit(t *testing.T) {
	root := fixture(t, map[string]string{
		"internal/agent/bad.go": `package agent; import "github.com/xtls/xray-core/core"`,
		"runtimes/xray/bad.go":  `package xray; import "routeweaver/internal/store"`,
		"runtimes/xray/good.go": `package xray; import ("routeweaver/internal/entrypolicy";"routeweaver/internal/privateipc";"github.com/xtls/xray-core/core")`,
	})
	got, err := inspectRuntimeBoundaries(root)
	if err != nil || len(got) != 2 {
		t.Fatalf("expected explicit runtime violations: %v %v", got, err)
	}
}
