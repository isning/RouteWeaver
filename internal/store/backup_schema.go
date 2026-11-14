package store

import (
	"context"
	"errors"
	"strings"
)

func validateBackupSchema(ctx context.Context, tx schemaQuerier) error {
	if err := validateRecordKeyCollation(ctx, tx); err != nil {
		return err
	}
	// Refuse an unrecognized physical schema instead of silently omitting a new
	// table introduced by another binary or migration.
	schemaRows, err := tx.QueryContext(ctx, `SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
	if err != nil {
		return err
	}
	expected := map[string]bool{"records": true, "identities": true, "token_index": true, "counters": true, "schema_migrations": true}
	derived := map[string]bool{}
	for schemaRows.Next() {
		var name string
		if err = schemaRows.Scan(&name); err != nil {
			schemaRows.Close()
			return err
		}
		if name == "usage_history" || name == "usage_history_owners" || name == "usage_history_state" || name == "usage_rebuilds" || name == "usage_projection_state" || name == "usage_windows" || name == "admission_lease_state" || name == "admission_budget_state" || name == "admission_lease_windows" || name == "admission_budget_windows" {
			derived[name] = true
			continue
		}
		if !expected[name] {
			schemaRows.Close()
			return errors.New("unsupported database table in backup")
		}
		delete(expected, name)
	}
	err = schemaRows.Err()
	schemaRows.Close()
	if err != nil {
		return err
	}
	if len(expected) != 0 {
		return errors.New("incomplete database schema")
	}

	primaryKeys := map[string][]int{"records": {1, 2, 0}, "identities": {1, 0}, "token_index": {1, 2, 0}, "counters": {1, 2, 0}, "schema_migrations": {1, 0}}
	columns := map[string][]string{"records": {"kind", "id", "data"}, "identities": {"username", "account_id"}, "token_index": {"kind", "digest", "record_id"}, "counters": {"kind", "id", "value"}, "schema_migrations": {"version", "applied_at"}}
	// Older physical databases need not have derived tables; if present, only
	// this exact rebuildable shape is accepted. They never enter logical frames.
	if derived["usage_history"] {
		columns["usage_history"] = []string{"account", "id"}
		primaryKeys["usage_history"] = []int{1, 2}
		var timeColumn int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM pragma_table_xinfo('usage_history') WHERE name='observed_second'`).Scan(&timeColumn); err != nil {
			return err
		}
		if timeColumn == 1 {
			columns["usage_history"] = append(columns["usage_history"], "observed_second")
			primaryKeys["usage_history"] = append(primaryKeys["usage_history"], 0)
		}
	}
	if derived["usage_history_owners"] {
		columns["usage_history_owners"] = []string{"account", "data"}
		primaryKeys["usage_history_owners"] = []int{1, 0}
	}
	if derived["usage_history_state"] {
		columns["usage_history_state"] = []string{"id", "generation", "data"}
		primaryKeys["usage_history_state"] = []int{1, 0, 0}
	}
	if derived["usage_rebuilds"] {
		columns["usage_rebuilds"] = []string{"account", "data"}
		primaryKeys["usage_rebuilds"] = []int{1, 0}
	}
	if derived["usage_windows"] {
		columns["usage_windows"] = []string{"account", "data"}
		primaryKeys["usage_windows"] = []int{1, 0}
	}
	if derived["usage_projection_state"] {
		columns["usage_projection_state"] = []string{"id", "version", "generation", "acknowledged"}
		primaryKeys["usage_projection_state"] = []int{1, 0, 0, 0}
	}
	for _, d := range []admissionLiveDomain{leaseLive, budgetLive} {
		if derived[d.rowsTable()] {
			columns[d.rowsTable()] = []string{"account", "data"}
			primaryKeys[d.rowsTable()] = []int{1, 0}
		}
		if derived[d.stateTable()] {
			columns[d.stateTable()] = []string{"id", "version", "generation", "acknowledged"}
			primaryKeys[d.stateTable()] = []int{1, 0, 0, 0}
		}
	}
	for table, want := range columns {
		fields, err := tx.QueryContext(ctx, `SELECT name,pk,hidden FROM pragma_table_xinfo(?) ORDER BY cid`, table)
		if err != nil {
			return err
		}
		index := 0
		for fields.Next() {
			var name string
			var primaryKey, hidden int
			if err = fields.Scan(&name, &primaryKey, &hidden); err != nil {
				fields.Close()
				return err
			}
			if index >= len(want) || name != want[index] || primaryKey != primaryKeys[table][index] || hidden != 0 {
				fields.Close()
				return errors.New("unsupported database columns in backup")
			}
			index++
		}
		err = fields.Err()
		fields.Close()
		if err != nil {
			return err
		}
		if index != len(want) {
			return errors.New("incomplete database columns in backup")
		}
	}
	var uniqueAccounts int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM pragma_index_list('identities') AS i WHERE i."unique"=1 AND (SELECT count(*) FROM pragma_index_info(i.name))=1 AND EXISTS(SELECT 1 FROM pragma_index_info(i.name) WHERE name='account_id')`).Scan(&uniqueAccounts); err != nil {
		return err
	}
	if uniqueAccounts == 0 {
		return errors.New("unsupported backup identity uniqueness constraint")
	}
	return nil
}

// Prefix reconstruction compares canonical IDs bytewise in Go. Reject alternate
// key collations rather than losing index bounds with an explicit SQL sort.
func validateRecordKeyCollation(ctx context.Context, q schemaQuerier) error {
	// Generated legacy/current schemas have no explicit COLLATE declaration.
	// A column NOCASE override can differ from its BINARY PK and would also alter
	// generic old-value lookups. Refuse such custom DDL instead of guessing it.
	var ddl []byte
	if err := q.QueryRowContext(ctx, `SELECT CASE WHEN length(CAST(sql AS BLOB))<=16384 THEN CAST(sql AS BLOB) ELSE NULL END FROM sqlite_schema WHERE type='table' AND name='records'`).Scan(&ddl); err != nil {
		return err
	}
	if len(ddl) == 0 || strings.Contains(strings.ToUpper(string(ddl)), "COLLATE") {
		return errors.New("unsupported explicit canonical record collation")
	}

	rows, err := q.QueryContext(ctx, `SELECT x.name,x.coll FROM pragma_index_list('records') AS i JOIN pragma_index_xinfo(i.name) AS x WHERE i.origin='pk' AND x."key"=1 ORDER BY x.seqno`)
	if err != nil {
		return err
	}
	defer rows.Close()
	want := []string{"kind", "id"}
	n := 0
	for rows.Next() {
		var name, coll string
		if err = rows.Scan(&name, &coll); err != nil {
			return err
		}
		if n >= len(want) || name != want[n] || !strings.EqualFold(coll, "BINARY") {
			return errors.New("unsupported canonical record key ordering")
		}
		n++
	}
	if err = rows.Err(); err != nil {
		return err
	}
	if n != len(want) {
		return errors.New("incomplete canonical record key ordering")
	}
	return nil
}
