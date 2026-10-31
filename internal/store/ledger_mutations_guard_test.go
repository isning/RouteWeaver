package store

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// New raw record mutations require explicit audit. Generic writes belong in
// ledger_mutations; imports are intentionally all-or-nothing invalidating paths.
// Fixed-kind legacy/auth statements cannot address ledger and stay allowlisted.
func TestCanonicalRecordMutationInventory(t *testing.T) {
	allowed := map[string]bool{
		"ledger_mutations.go": true, "backup.go": true, "backup_stream.go": true,
	}
	fixed := map[string]bool{
		// Bootstrap writer reservation cannot match any canonical row.
		"UPDATE records SET data=data WHERE 0":                                            true,
		"INSERT INTO records(kind,id,data) VALUES('revisions',?,?)":                       true,
		"INSERT INTO records(kind,id,data) VALUES('sessions',?,?)":                        true,
		"INSERT INTO records(kind,id,data) VALUES('usage',?,?)":                           true,
		"INSERT OR IGNORE INTO records(kind,id,data) VALUES('meter-pending-history',?,?)": true,
		"DELETE FROM records WHERE kind='sessions' AND id=?":                              true,
		"UPDATE records SET data=? WHERE kind='users' AND id=?":                           true,
		"UPDATE records SET data=? WHERE kind='accounts' AND id=?":                        true,
	}
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		if strings.HasSuffix(file, "_test.go") || allowed[file] {
			continue
		}
		tree, err := parser.ParseFile(token.NewFileSet(), file, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(tree, func(n ast.Node) bool {
			literal, ok := n.(*ast.BasicLit)
			if !ok || literal.Kind != token.STRING {
				return true
			}
			sql, err := strconv.Unquote(literal.Value)
			if err != nil {
				t.Fatal(err)
			}
			upper := strings.ToUpper(strings.TrimSpace(sql))
			mutation := strings.Contains(upper, "INTO RECORDS") || strings.Contains(upper, "UPDATE RECORDS") || strings.Contains(upper, "DELETE FROM RECORDS")
			if mutation && !fixed[sql] {
				t.Errorf("unaudited canonical mutation in %s: %s", file, sql)
			}
			return true
		})
	}
}
