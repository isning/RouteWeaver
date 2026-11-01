package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// ErrUnsupportedSchema prevents an older binary from initializing a database it
// does not understand. Database upgrades are offline operations, not hot DDL.
var ErrUnsupportedSchema = errors.New("database schema is not supported by this version; use a matching binary or restore a compatible backup")

// Migration 3 is a semantic downgrade fence for provider admission guards.
// The portable backup frame format remains version 2; the migration history
// carries the minimum reader capability independently of that envelope.
const maxSchemaMigrationVersion = 3
const providerSuspensionMigrationVersion = 3

type schemaQuerier interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func validateMigrationVersions(ctx context.Context, q schemaQuerier) error {
	rows, err := q.QueryContext(ctx, `SELECT version FROM schema_migrations ORDER BY version`)
	if err != nil {
		return err
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var version int
		if err = rows.Scan(&version); err != nil {
			return err
		}
		n++
		if version != n || version > maxSchemaMigrationVersion {
			return fmt.Errorf("unsupported migration version %d", version)
		}
	}
	if err = rows.Err(); err != nil {
		return err
	}
	if n == 0 {
		return errors.New("missing migration history")
	}
	return nil
}

// Only the original records-only database and the explicitly supported migrated
// shapes can be initialized. Missing arbitrary tables is not a repair strategy.
func validateExistingSchema(ctx context.Context, q schemaQuerier) error {
	rows, err := q.QueryContext(ctx, `SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
	if err != nil {
		return err
	}
	var tables []string
	for rows.Next() {
		var name string
		if err = rows.Scan(&name); err != nil {
			rows.Close()
			return err
		}
		tables = append(tables, name)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if len(tables) == 0 {
		return nil
	}
	if len(tables) == 1 && tables[0] == "records" {
		fields, err := q.QueryContext(ctx, `SELECT name,pk,hidden FROM pragma_table_xinfo('records') ORDER BY cid`)
		if err != nil {
			return err
		}
		defer fields.Close()
		want := []string{"kind", "id", "data"}
		keys := []int{1, 2, 0}
		i := 0
		for fields.Next() {
			var name string
			var pk, hidden int
			if err = fields.Scan(&name, &pk, &hidden); err != nil {
				return err
			}
			if i >= len(want) || name != want[i] || pk != keys[i] || hidden != 0 {
				return errors.New("unsupported legacy records schema")
			}
			i++
		}
		if err = fields.Err(); err != nil {
			return err
		}
		if i != len(want) {
			return errors.New("incomplete legacy records schema")
		}
		fields.Close()
		return validateRecordKeyCollation(ctx, q)
	}
	if err = validateBackupSchema(ctx, q); err != nil {
		return err
	}
	return validateMigrationVersions(ctx, q)
}

func unsupportedSchema(err error) error {
	return fmt.Errorf("%w: %v", ErrUnsupportedSchema, err)
}
