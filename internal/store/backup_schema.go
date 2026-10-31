package store

import (
	"context"
	"database/sql"
	"errors"
)

func validateBackupSchema(ctx context.Context, tx *sql.Tx) error {
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
		if name == "usage_projection_state" || name == "usage_windows" || name == "admission_lease_state" || name == "admission_budget_state" || name == "admission_lease_windows" || name == "admission_budget_windows" {
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
		fields, err := tx.QueryContext(ctx, `SELECT name,pk FROM pragma_table_info(?) ORDER BY cid`, table)
		if err != nil {
			return err
		}
		index := 0
		for fields.Next() {
			var name string
			var primaryKey int
			if err = fields.Scan(&name, &primaryKey); err != nil {
				fields.Close()
				return err
			}
			if index >= len(want) || name != want[index] || primaryKey != primaryKeys[table][index] {
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
