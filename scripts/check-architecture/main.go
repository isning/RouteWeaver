// Command check-architecture checks repository dependency direction without
// loading dependencies, executing code, or needing access to native cores.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

type policy struct {
	Module    string              `json:"module"`
	Allowed   map[string][]string `json:"allowed"`
	Forbidden map[string][]string `json:"forbidden_imports"`
}

func inspect(root string, p policy) ([]string, error) {
	var violations []string
	err := filepath.WalkDir(filepath.Join(root, "internal"), func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		parts := strings.Split(filepath.ToSlash(rel), "/")
		if len(parts) < 3 {
			return fmt.Errorf("unclassified internal source: %s", rel)
		}
		module := parts[1]
		allowed, classified := p.Allowed[module]
		if !classified {
			violations = append(violations, rel+": module has no explicit architecture policy")
			return nil
		}
		file, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly)
		if err != nil {
			return err
		}
		for _, spec := range file.Imports {
			imp, err := strconv.Unquote(spec.Path.Value)
			if err != nil {
				return err
			}
			for _, forbidden := range p.Forbidden[module] {
				if imp == forbidden || strings.HasPrefix(imp, forbidden+"/") {
					violations = append(violations, fmt.Sprintf("%s: %s cannot import %s", rel, module, imp))
				}
			}
			prefix := p.Module + "/internal/"
			if !strings.HasPrefix(imp, prefix) {
				continue
			}
			target := strings.Split(strings.TrimPrefix(imp, prefix), "/")[0]
			ok := target == module
			for _, a := range allowed {
				if target == a {
					ok = true
				}
			}
			if !ok {
				violations = append(violations, fmt.Sprintf("%s: forbidden dependency %s -> %s", rel, module, target))
			}
		}
		return nil
	})
	sort.Strings(violations)
	return violations, err
}

func main() {
	root := flag.String("root", ".", "repository root")
	flag.Parse()
	data, err := os.ReadFile(filepath.Join(*root, "scripts", "architecture-policy.json"))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	var p policy
	if err := json.Unmarshal(data, &p); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	violations, err := inspect(*root, p)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	runtimeViolations, err := inspectRuntimeBoundaries(*root)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	violations = append(violations, runtimeViolations...)
	if len(violations) != 0 {
		for _, v := range violations {
			fmt.Fprintln(os.Stderr, v)
		}
		os.Exit(1)
	}
	fmt.Println("Architecture imports: passed (production Go imports; not a complete effect or security proof)")
}
