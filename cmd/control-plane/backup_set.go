package main

import (
	"context"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"routeweaver/internal/backup"
	"routeweaver/internal/store"
)

// runBackupSet is deliberately dispatched before any daemon initialization.
// Passwords are accepted only through a private pipe/file on standard input.
func runBackupSet(ctx context.Context, args []string, stdin io.Reader, stdout io.Writer, getenv func(string) string) error {
	if len(args) == 0 || (args[0] != "create" && args[0] != "restore") {
		return errors.New("backup-set command requires create or restore; see docs/operations/BACKUP-SETS.md")
	}
	verb := args[0]
	fs := flag.NewFlagSet("backup-set", flag.ContinueOnError)
	// flag errors may quote attacker-controlled argv, including misplaced secrets.
	fs.SetOutput(io.Discard)
	db := fs.String("db", "", "existing source database for create; fresh target database for restore")
	dir := fs.String("set-dir", "", "fresh output directory for create; complete input set for restore")
	var limits backup.SetLimits
	fs.Int64Var(&limits.TotalBytes, "total-bytes", 0, "explicit total encrypted set and logical-work byte budget")
	fs.IntVar(&limits.TotalRows, "total-rows", 0, "explicit total row budget")
	fs.Int64Var(&limits.PartBytes, "part-bytes", 0, "explicit per-part byte budget")
	fs.IntVar(&limits.PartRows, "part-rows", 0, "explicit per-part row budget")
	fs.IntVar(&limits.RecordBytes, "record-bytes", 0, "explicit maximum record bytes")
	fs.IntVar(&limits.Parts, "parts", 0, "explicit maximum parts")
	fs.DurationVar(&limits.Duration, "timeout", 0, "explicit operation deadline, at most 6h")
	fs.Int64Var(&limits.DiskBytes, "disk-bytes", 0, "explicit temporary/output disk budget")
	if fs.Parse(args[1:]) != nil || fs.NArg() != 0 {
		return errors.New("invalid backup-set command options; secrets must not be supplied as arguments; see docs/operations/BACKUP-SETS.md")
	}
	if *db == "" || *dir == "" {
		return errors.New("backup-set command requires --db and --set-dir")
	}
	if err := limits.Validate(); err != nil {
		return fmt.Errorf("backup-set budgets: %w", err)
	}
	// Validate paths and key before consuming a password or touching the source.
	canonical, err := store.CanonicalDatabasePath(*db)
	if err != nil {
		return err
	}
	key, err := hex.DecodeString(getenv("ROUTEWEAVER_MASTER_KEY"))
	if err != nil || len(key) != 32 {
		return errors.New("ROUTEWEAVER_MASTER_KEY must be 64 hexadecimal characters (32 bytes), supplied by the operator")
	}
	defer clear(key)
	if err = ctx.Err(); err != nil {
		return err
	}
	if f, ok := stdin.(*os.File); ok {
		info, e := f.Stat()
		if e != nil || info.Mode()&os.ModeCharDevice != 0 {
			return errors.New("backup-set password requires a private pipe or file on standard input, not a terminal")
		}
	}
	password, err := readBackupSetPassword(stdin)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, limits.Duration)
	defer cancel()
	if err = ctx.Err(); err != nil {
		return err
	}
	if verb == "create" {
		err = store.WithOfflineBackupSource(ctx, canonical, key, func(s *store.Store) error { return backup.CreateSet(ctx, s, password, *dir, limits) })
	} else {
		err = backup.RestoreSet(ctx, *dir, password, canonical, key, limits)
	}
	if err != nil {
		if errors.Is(err, store.ErrRestorePublicationUncertain) {
			return errors.New("backup-set publication is uncertain: preserve and inspect the target; do not retry blindly or activate it")
		}
		return fmt.Errorf("backup-set %s failed: %w", verb, err)
	}
	if verb == "create" {
		_, err = fmt.Fprintln(stdout, "Complete encrypted backup set created; retain every part and verify an isolated restore before relying on it.")
	} else {
		_, err = fmt.Fprintln(stdout, "Backup set restored to a fresh database; not activated. Verify it before a separately authorized cutover.")
	}
	return err
}

func readBackupSetPassword(r io.Reader) (string, error) {
	data, err := io.ReadAll(io.LimitReader(r, 1027))
	if err != nil {
		return "", errors.New("cannot read backup-set password")
	}
	defer clear(data)
	password := strings.TrimSuffix(strings.TrimSuffix(string(data), "\n"), "\r")
	if strings.ContainsAny(password, "\r\n") || backup.ValidatePassword(password) != nil {
		return "", errors.New("supply one valid backup password (12 or more characters, at most 1024 bytes) on private standard input")
	}
	return password, nil
}
