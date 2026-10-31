package store

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"fmt"
	"path/filepath"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
)

// notificationReadObserver observes actual driver calls, not service counters.
// Reset only between completed operations. Rows counts successful Next calls
// (not EOF), including rows consumed inside a transaction or prepared statement.
type notificationReadObserver struct {
	queries, rows  atomic.Int64
	afterLedgerRow func(int64)
}

func (o *notificationReadObserver) Reset() { o.queries.Store(0); o.rows.Store(0) }
func (o *notificationReadObserver) Counts() (queries, rows int64) {
	return o.queries.Load(), o.rows.Load()
}

var notificationObserverSequence atomic.Uint64

// installNotificationReadObserver replaces an idle, file-backed test Store's
// pool with an instrumented connection to the SAME database. It does not reopen
// the Store or run migrations. Never install during concurrent store operations.
// The Store's normal Close/cleanup owns the replacement pool.
func installNotificationReadObserver(t *testing.T, s *Store) *notificationReadObserver {
	t.Helper()
	var file string
	if err := s.db.QueryRow(`SELECT file FROM pragma_database_list WHERE name='main'`).Scan(&file); err != nil {
		t.Fatal(err)
	}
	if file == "" {
		t.Fatal("notification read observation requires a file-backed test database")
	}
	var busyTimeout int
	if err := s.db.QueryRow(`PRAGMA busy_timeout`).Scan(&busyTimeout); err != nil {
		t.Fatal(err)
	}
	o := &notificationReadObserver{}
	name := fmt.Sprintf("notification-observer-%d", notificationObserverSequence.Add(1))
	sql.Register(name, &notificationObservedDriver{base: s.db.Driver(), observer: o, busyTimeout: busyTimeout})
	db, err := sql.Open(name, file)
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	if err = db.PingContext(context.Background()); err != nil {
		db.Close()
		t.Fatal(err)
	}
	if err = s.db.Close(); err != nil {
		db.Close()
		t.Fatal(err)
	}
	s.db = db
	return o
}

type notificationObservedDriver struct {
	base        driver.Driver
	observer    *notificationReadObserver
	busyTimeout int
}

func (d *notificationObservedDriver) Open(name string) (driver.Conn, error) {
	c, err := d.base.Open(name)
	if err != nil {
		return nil, err
	}
	// Restore the only connection-local PRAGMA established by Store.Open. WAL
	// mode is already persisted; configuring every new connection also preserves
	// behavior after the real driver discards an interrupted connection.
	if _, err = c.(driver.ExecerContext).ExecContext(context.Background(), fmt.Sprintf("PRAGMA busy_timeout=%d", d.busyTimeout), nil); err != nil {
		c.Close()
		return nil, err
	}
	return &notificationObservedConn{Conn: c, observer: d.observer}, nil
}

type notificationObservedConn struct {
	driver.Conn
	observer *notificationReadObserver
}

func (c *notificationObservedConn) Prepare(query string) (driver.Stmt, error) {
	st, err := c.Conn.Prepare(query)
	if err != nil {
		return nil, err
	}
	return &notificationObservedStmt{Stmt: st, query: query, observer: c.observer}, nil
}
func (c *notificationObservedConn) PrepareContext(ctx context.Context, query string) (driver.Stmt, error) {
	st, err := c.Conn.(driver.ConnPrepareContext).PrepareContext(ctx, query)
	if err != nil {
		return nil, err
	}
	return &notificationObservedStmt{Stmt: st, query: query, observer: c.observer}, nil
}
func (c *notificationObservedConn) BeginTx(ctx context.Context, opts driver.TxOptions) (driver.Tx, error) {
	return c.Conn.(driver.ConnBeginTx).BeginTx(ctx, opts)
}
func (c *notificationObservedConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	return c.Conn.(driver.ExecerContext).ExecContext(ctx, query, args)
}
func (c *notificationObservedConn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	ledger := notificationLedgerQuery(query, args)
	if ledger {
		c.observer.queries.Add(1)
	}
	rows, err := c.Conn.(driver.QueryerContext).QueryContext(ctx, query, args)
	if err != nil || !ledger {
		return rows, err
	}
	return &notificationObservedRows{Rows: rows, observer: c.observer}, nil
}
func (c *notificationObservedConn) Ping(ctx context.Context) error {
	return c.Conn.(driver.Pinger).Ping(ctx)
}
func (c *notificationObservedConn) ResetSession(ctx context.Context) error {
	return c.Conn.(driver.SessionResetter).ResetSession(ctx)
}
func (c *notificationObservedConn) IsValid() bool { return c.Conn.(driver.Validator).IsValid() }

type notificationObservedStmt struct {
	driver.Stmt
	query    string
	observer *notificationReadObserver
}

func (s *notificationObservedStmt) Query(args []driver.Value) (driver.Rows, error) {
	named := make([]driver.NamedValue, len(args))
	for i, v := range args {
		named[i] = driver.NamedValue{Ordinal: i + 1, Value: v}
	}
	ledger := notificationLedgerQuery(s.query, named)
	if ledger {
		s.observer.queries.Add(1)
	}
	rows, err := s.Stmt.Query(args)
	if err != nil || !ledger {
		return rows, err
	}
	return &notificationObservedRows{Rows: rows, observer: s.observer}, nil
}
func (s *notificationObservedStmt) QueryContext(ctx context.Context, args []driver.NamedValue) (driver.Rows, error) {
	ledger := notificationLedgerQuery(s.query, args)
	if ledger {
		s.observer.queries.Add(1)
	}
	rows, err := s.Stmt.(driver.StmtQueryContext).QueryContext(ctx, args)
	if err != nil || !ledger {
		return rows, err
	}
	return &notificationObservedRows{Rows: rows, observer: s.observer}, nil
}
func (s *notificationObservedStmt) ExecContext(ctx context.Context, args []driver.NamedValue) (driver.Result, error) {
	return s.Stmt.(driver.StmtExecContext).ExecContext(ctx, args)
}

type notificationObservedRows struct {
	driver.Rows
	observer *notificationReadObserver
}

func (r *notificationObservedRows) Next(dest []driver.Value) error {
	err := r.Rows.Next(dest)
	if err == nil {
		n := r.observer.rows.Add(1)
		if r.observer.afterLedgerRow != nil {
			r.observer.afterLedgerRow(n)
		}
	}
	return err
}
func (r *notificationObservedRows) ColumnTypeDatabaseTypeName(i int) string {
	return r.Rows.(driver.RowsColumnTypeDatabaseTypeName).ColumnTypeDatabaseTypeName(i)
}
func (r *notificationObservedRows) ColumnTypeLength(i int) (int64, bool) {
	return r.Rows.(driver.RowsColumnTypeLength).ColumnTypeLength(i)
}
func (r *notificationObservedRows) ColumnTypeNullable(i int) (bool, bool) {
	return r.Rows.(driver.RowsColumnTypeNullable).ColumnTypeNullable(i)
}
func (r *notificationObservedRows) ColumnTypePrecisionScale(i int) (int64, int64, bool) {
	return r.Rows.(driver.RowsColumnTypePrecisionScale).ColumnTypePrecisionScale(i)
}
func (r *notificationObservedRows) ColumnTypeScanType(i int) reflect.Type {
	return r.Rows.(driver.RowsColumnTypeScanType).ColumnTypeScanType(i)
}

var notificationRecordsFrom = regexp.MustCompile(`(?i)\b(?:from|join)\s+records\b`)
var notificationKindEquals = regexp.MustCompile(`(?i)\bkind\s*=\s*('ledger'|\?[0-9]*|[:@$][a-z_][a-z0-9_]*)`)
var notificationSQLParameter = regexp.MustCompile(`\?[0-9]*|[:@$][a-zA-Z_][a-zA-Z0-9_]*`)

// Match the repository's literal and bound kind equality queries, not arbitrary
// SQL syntax. Binding the unrelated record ID to "ledger" does not count. This
// test helper is intentionally not a SQL parser or a production query logger.
func notificationLedgerQuery(query string, args []driver.NamedValue) bool {
	if !notificationRecordsFrom.MatchString(query) {
		return false
	}
	match := notificationKindEquals.FindStringSubmatchIndex(query)
	if match == nil {
		return false
	}
	token := query[match[2]:match[3]]
	if strings.EqualFold(token, "'ledger'") {
		return true
	}
	if token[0] != '?' {
		for _, arg := range args {
			if arg.Name == token[1:] {
				value, ok := arg.Value.(string)
				return ok && value == "ledger"
			}
		}
		return false
	}
	ordinal, highest := 0, 0
	named := map[string]int{}
	for _, p := range notificationSQLParameter.FindAllString(query[:match[3]], -1) {
		if len(p) > 1 && p[0] == '?' {
			n, err := strconv.Atoi(p[1:])
			if err != nil {
				return false
			}
			ordinal = n
		} else if p[0] != '?' && named[p] != 0 {
			ordinal = named[p]
		} else {
			ordinal = highest + 1
			if p[0] != '?' {
				named[p] = ordinal
			}
		}
		if ordinal > highest {
			highest = ordinal
		}
	}
	for _, arg := range args {
		if arg.Ordinal == ordinal {
			value, ok := arg.Value.(string)
			return ok && value == "ledger"
		}
	}
	return false
}

func TestNotificationReadObserverMeasuresDriverReads(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "db"), make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for _, id := range []string{"a", "b", "c"} {
		if err = s.Put("ledger", id, MeterRecord{}); err != nil {
			t.Fatal(err)
		}
	}
	if err = s.Put("other", "ledger", map[string]bool{"ok": true}); err != nil {
		t.Fatal(err)
	}
	o := installNotificationReadObserver(t, s)
	if _, err = s.List("ledger"); err != nil {
		t.Fatal(err)
	}
	if q, n := o.Counts(); q != 1 || n != 3 {
		t.Fatalf("public List: queries=%d rows=%d", q, n)
	}
	o.Reset()
	if _, err = s.List("other"); err != nil {
		t.Fatal(err)
	}
	var other map[string]bool
	if err = s.Get("other", "ledger", &other); err != nil {
		t.Fatal(err)
	}
	if q, n := o.Counts(); q != 0 || n != 0 {
		t.Fatalf("unrelated reads: queries=%d rows=%d", q, n)
	}
	// Exercise literal and prepared driver paths while keeping their transaction
	// and context behavior intact. The public Store check above catches lost rows.
	tx, err := s.db.BeginTx(context.Background(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	stmt, err := tx.PrepareContext(context.Background(), `SELECT data FROM records WHERE kind=? ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer stmt.Close()
	rows, err := stmt.QueryContext(context.Background(), "ledger")
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var b []byte
		if err = rows.Scan(&b); err != nil {
			t.Fatal(err)
		}
	}
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	rows.Close()
	var b []byte
	if err = tx.QueryRowContext(context.Background(), `SELECT data FROM records WHERE kind='ledger' ORDER BY id LIMIT 1`).Scan(&b); err != nil {
		t.Fatal(err)
	}
	if q, n := o.Counts(); q != 2 || n != 4 {
		t.Fatalf("prepared/literal reads: queries=%d rows=%d", q, n)
	}
	if err = tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = s.db.QueryContext(ctx, `SELECT data FROM records WHERE kind='ledger'`); err == nil {
		t.Fatal("cancelled context accepted")
	}
}
