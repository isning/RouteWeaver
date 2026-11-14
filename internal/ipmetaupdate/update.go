// Package ipmetaupdate owns the optional network/cache adapter for local IP metadata.
package ipmetaupdate

import (
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"routeweaver/internal/ipmeta"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const downloadLimit int64 = 32 << 20

var cacheName = regexp.MustCompile(`^dbip-[0-9]{4}-[0-9]{2}-[0-9]+$`)

// Updater only fetches whole DB-IP Lite databases, never client addresses.
// A verified pair is committed by one atomic manifest rename, then published in
// memory. Failed downloads leave both the live snapshot and cached pair intact.
type Updater struct {
	mu      sync.Mutex
	dir     string
	db      atomic.Pointer[ipmeta.Database]
	client  *http.Client
	now     func() time.Time
	release string
}

func NewUpdater(dir string) (*Updater, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, fmt.Errorf("create IP database cache: %w", err)
	}
	u := &Updater{dir: dir, now: time.Now,
		client: &http.Client{Timeout: 90 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return fmt.Errorf("database redirects are not allowed") }}}
	// Cache corruption is recoverable: start unavailable and retry official data.
	manifest, err := os.Open(filepath.Join(dir, "current"))
	var name []byte
	if err == nil {
		name, err = io.ReadAll(io.LimitReader(manifest, 100))
		_ = manifest.Close()
	}
	if err == nil && len(name) < 100 && cacheName.Match(name) {
		if db, e := ipmeta.Open(filepath.Join(dir, string(name), "country.mmdb"), filepath.Join(dir, string(name), "asn.mmdb")); e == nil && isDBIP(db) {
			release := strings.TrimPrefix(string(name)[:len("dbip-2006-01")], "dbip-")
			if db.Sources()[0].BuiltAt.Format("2006-01") == release && db.Sources()[1].BuiltAt.Format("2006-01") == release {
				u.db.Store(db)
				u.release = release
			}
		}
	}
	return u, nil
}
func isDBIP(db *ipmeta.Database) bool {
	sources := db.Sources()
	return len(sources) == 2 && sources[0].DatabaseType == "DBIP-Country-Lite" && sources[1].DatabaseType == "DBIP-ASN-Lite (compat=GeoLite2-ASN)"
}

// Snapshot pins the currently verified immutable pair for one API response.
func (u *Updater) Snapshot() *ipmeta.Database { return u.db.Load() }

// Run checks on startup and daily. Published monthly releases are downloaded at
// most once, except when the local cache fails validation. No request IPs enter it.
func (u *Updater) Run(ctx context.Context, report func(error)) {
	for {
		if err := u.Refresh(ctx); err != nil && ctx.Err() == nil && report != nil {
			report(err)
		}
		timer := time.NewTimer(24 * time.Hour)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}
func (u *Updater) Refresh(ctx context.Context) error {
	u.mu.Lock()
	defer u.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	release := u.now().UTC().Format("2006-01")
	if u.release == release && u.Snapshot() != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	stage, err := os.MkdirTemp(u.dir, "dbip-"+release+"-")
	if err != nil {
		return fmt.Errorf("create database staging directory: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			os.RemoveAll(stage)
		}
	}()
	for _, kind := range []string{"country", "asn"} {
		if err = u.download(ctx, kind, release, filepath.Join(stage, kind+".mmdb")); err != nil {
			return err
		}
	}
	db, err := ipmeta.Open(filepath.Join(stage, "country.mmdb"), filepath.Join(stage, "asn.mmdb"))
	if err != nil || !isDBIP(db) {
		return fmt.Errorf("downloaded database pair failed MMDB validation")
	}
	for _, source := range db.Sources() {
		// Refuse a stale/substituted release or future data, even if structurally valid.
		if source.BuiltAt.UTC().Format("2006-01") != release {
			return fmt.Errorf("database release date does not match requested month")
		}
	}
	if d, e := os.Open(stage); e == nil {
		err = d.Sync()
		_ = d.Close()
		if err != nil {
			return err
		}
	} else {
		return e
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	manifest, err := os.CreateTemp(u.dir, ".current-")
	if err != nil {
		return err
	}
	manifestName := manifest.Name()
	defer os.Remove(manifestName)
	if _, err = manifest.WriteString(filepath.Base(stage)); err == nil {
		err = manifest.Sync()
	}
	closeErr := manifest.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Rename(manifestName, filepath.Join(u.dir, "current")); err != nil {
		return err
	}
	committed = true
	u.db.Store(db)
	u.release = release
	// Directory fsync makes successful replacement durable on supported systems.
	if d, e := os.Open(u.dir); e == nil {
		err = d.Sync()
		_ = d.Close()
		if err != nil {
			return fmt.Errorf("database installed but cache directory sync failed: %w", err)
		}
	} else {
		return fmt.Errorf("database installed but cache directory sync failed: %w", e)
	}
	// Only our generation names are candidates, never arbitrary cache contents.
	entries, _ := os.ReadDir(u.dir)
	for _, entry := range entries {
		if entry.IsDir() && cacheName.MatchString(entry.Name()) && entry.Name() != filepath.Base(stage) {
			_ = os.RemoveAll(filepath.Join(u.dir, entry.Name()))
		}
	}
	return nil
}
func (u *Updater) download(ctx context.Context, kind, release, path string) error {
	// Neither host nor path is configurable from a request or user-controlled URL.
	url := "https://download.db-ip.com/free/dbip-" + kind + "-lite-" + release + ".mmdb.gz"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "RouteWeaver GeoIP updater")
	res, err := u.client.Do(req)
	if err != nil {
		return fmt.Errorf("%s database download failed", kind)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("%s database download returned HTTP %d", kind, res.StatusCode)
	}
	if res.ContentLength > downloadLimit {
		return fmt.Errorf("compressed database exceeds 32 MiB")
	}
	compressed := &io.LimitedReader{R: res.Body, N: downloadLimit + 1}
	gz, err := gzip.NewReader(compressed)
	if err != nil {
		return fmt.Errorf("invalid compressed database")
	}
	defer gz.Close()
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	n, err := io.Copy(f, io.LimitReader(gz, ipmeta.MaxDatabaseBytes+1))
	if err == nil && (n > ipmeta.MaxDatabaseBytes || compressed.N <= 0) {
		err = fmt.Errorf("database exceeds size limit")
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	// io.Copy reads gzip to EOF, validating gzip CRC and length before publication.
	if err != nil {
		return fmt.Errorf("%s database failed bounded decompression: %w", kind, err)
	}
	return nil
}
