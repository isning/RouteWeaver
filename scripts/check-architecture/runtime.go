package main

import (
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Runtime adapters may use upstream SDKs, narrow policy/IPC contracts and
// the explicitly bounded diagnostic contract/executor. Neither HTTP/storage/control-plane modules nor a nested runtime
// may leak back into the core application module.
func inspectRuntimeBoundaries(root string) ([]string, error) {
	var violations []string
	for _, dir := range []string{"cmd", "internal", "runtimes"} {
		base := filepath.Join(root, dir)
		if _, err := os.Stat(base); os.IsNotExist(err) {
			continue
		}
		err := filepath.WalkDir(base, func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if entry.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			file, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly)
			if err != nil {
				return err
			}
			rel, _ := filepath.Rel(root, path)
			for _, spec := range file.Imports {
				imp, err := strconv.Unquote(spec.Path.Value)
				if err != nil {
					return err
				}
				if dir == "runtimes" {
					if strings.HasPrefix(imp, "routeweaver/internal/") && imp != "routeweaver/internal/entrypolicy" && imp != "routeweaver/internal/privateipc" && imp != "routeweaver/internal/diagnostics" && imp != "routeweaver/internal/diagnosticexec" {
						violations = append(violations, rel+": runtime may import only policy/IPC and bounded diagnostic contracts/adapters, not "+imp)
					}
				} else if strings.HasPrefix(imp, "routeweaver/runtimes/") || strings.HasPrefix(imp, "github.com/xtls/xray-core") || strings.HasPrefix(imp, "github.com/sagernet/sing-box") {
					violations = append(violations, rel+": engine SDK belongs in a separate runtime adapter: "+imp)
				}
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	return violations, nil
}
