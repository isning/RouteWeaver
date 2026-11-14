// Command control-plane runs RouteWeaver's local control-plane application.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"routeweaver/internal/backup"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/ipmeta"
	"routeweaver/internal/render"
	"routeweaver/internal/store"
	"strings"
	"syscall"
	"time"
)

func main() {
	if e := run(); e != nil {
		log.Print(e)
		os.Exit(1)
	}
}
func run() error {
	if len(os.Args) > 1 && os.Args[1] == "backup-set" {
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		return runBackupSet(ctx, os.Args[2:], os.Stdin, os.Stdout, os.Getenv)
	}
	if len(os.Args) > 1 && !strings.HasPrefix(os.Args[1], "-") {
		return fmt.Errorf("unknown control-plane command")
	}
	listen := flag.String("listen", "127.0.0.1:8080", "bind address; remote interfaces require TLS")
	dbPath := flag.String("db", ".local/routeweaver.db", "encrypted SQLite database path")
	uiDir := flag.String("ui-dir", "web/dist", "built web UI directory")
	demo := flag.Bool("demo", false, "isolated ephemeral demo with known local credentials; loopback only")
	tlsCert := flag.String("tls-cert", "", "TLS certificate path")
	tlsKey := flag.String("tls-key", "", "TLS private key path")
	trustedProxies := flag.String("trusted-proxy-cidrs", "", "comma-separated IP CIDRs of trusted X-Forwarded-For proxies; empty trusts no forwarded headers")
	recoverAccount := flag.String("recover-account", "", "offline recovery of an existing administrator username; temporary password from standard input")
	recoverReason := flag.String("recover-reason", "", "required audit reason for offline account recovery")
	recoverMFA := flag.Bool("recover-disable-mfa", false, "explicitly clear lost MFA during offline account recovery")
	oidcConfigPath := flag.String("oidc-config", "", "private JSON OIDC provider and explicit subject bindings; requires --public-origin")
	publicOriginFlag := flag.String("public-origin", "", "explicit external HTTPS origin behind a Host-preserving reverse proxy")
	backupArchiveMiB := flag.Int64("backup-max-archive-mib", 1024, "maximum encrypted backup upload/download MiB (1–1024)")
	backupRecordMiB := flag.Int("backup-max-record-mib", 32, "maximum logical backup record MiB (1–128)")
	backupRows := flag.Int("backup-max-rows", 2000000, "maximum logical backup rows (1–2000000)")
	backupTimeout := flag.Duration("backup-timeout", 10*time.Minute, "bounded backup operation timeout (at most 10m)")
	countryDB := flag.String("ip-country-db", "", "optional local GeoLite2/GeoIP2 Country MMDB; no external lookups")
	asnDB := flag.String("ip-asn-db", "", "optional local GeoLite2 ASN MMDB; no external lookups")
	flag.Parse()
	if flag.NArg() != 0 {
		return fmt.Errorf("unexpected control-plane command arguments")
	}
	if (*recoverMFA || *recoverReason != "") && *recoverAccount == "" {
		return fmt.Errorf("recovery options require --recover-account")
	}
	if *demo && *recoverAccount != "" {
		return fmt.Errorf("offline recovery cannot run in demo mode")
	}
	publicOrigin, originErr := httpapi.CanonicalPublicOrigin(*publicOriginFlag)
	if originErr != nil {
		return originErr
	}
	if *demo && publicOrigin != "" {
		return fmt.Errorf("demo mode cannot advertise a public origin")
	}
	if *backupArchiveMiB < 1 || *backupArchiveMiB > 1024 || *backupRecordMiB < 1 || *backupRecordMiB > 128 || *backupRows < 1 || *backupRows > 2000000 || *backupTimeout <= 0 {
		return fmt.Errorf("backup limits must be positive and within the documented hard bounds")
	}
	backupLimits, err := (backup.Limits{ArchiveBytes: *backupArchiveMiB << 20, RecordBytes: *backupRecordMiB << 20, Rows: *backupRows, Duration: *backupTimeout}).Normalize()
	if err != nil {
		return fmt.Errorf("backup limits: %w", err)
	}
	notificationBudget, err := notificationColdBudget(os.Getenv)
	if err != nil {
		return err
	}
	host, _, e := net.SplitHostPort(*listen)
	if e != nil {
		return fmt.Errorf("invalid listen address")
	}
	ip := net.ParseIP(host)
	loopback := host == "localhost" || ip != nil && ip.IsLoopback()
	tlsEnabled := *tlsCert != "" && *tlsKey != ""
	if (*tlsCert == "") != (*tlsKey == "") {
		return fmt.Errorf("both TLS certificate and key are required")
	}
	if !loopback && !tlsEnabled {
		return fmt.Errorf("remote binding requires TLS certificate and key; use 127.0.0.1 for local development")
	}
	if *demo && !loopback {
		return fmt.Errorf("demo mode is restricted to loopback")
	}
	var key []byte
	adminToken := os.Getenv("ROUTEWEAVER_ADMIN_TOKEN")
	username, password := os.Getenv("ROUTEWEAVER_ADMIN_USERNAME"), os.Getenv("ROUTEWEAVER_ADMIN_PASSWORD")
	cleanup := func() {}
	if *demo {
		dir, e := os.MkdirTemp("", "routeweaver-demo-")
		if e != nil {
			return e
		}
		cleanup = func() { os.RemoveAll(dir) }
		*dbPath = filepath.Join(dir, "state.db")
		key = make([]byte, 32)
		if _, e = rand.Read(key); e != nil {
			cleanup()
			return e
		}
		adminToken = ""
		username = "routeweaver"
		password = "local-demo-password"
	} else {
		key, e = hex.DecodeString(os.Getenv("ROUTEWEAVER_MASTER_KEY"))
		if e != nil || len(key) != 32 {
			return fmt.Errorf("ROUTEWEAVER_MASTER_KEY must be 64 hexadecimal characters (32 bytes), supplied by the operator")
		}
		if adminToken != "" && len(adminToken) < 32 {
			return fmt.Errorf("ROUTEWEAVER_ADMIN_TOKEN must be at least 32 characters")
		}
		if (username == "") != (password == "") {
			return fmt.Errorf("supply both ROUTEWEAVER_ADMIN_USERNAME and ROUTEWEAVER_ADMIN_PASSWORD for initial setup")
		}
	}
	defer cleanup()
	canonicalPath, pathErr := store.CanonicalDatabasePath(*dbPath)
	if pathErr != nil {
		return pathErr
	}
	*dbPath = canonicalPath
	if *recoverAccount != "" {
		info, err := os.Stat(*dbPath)
		if err != nil || !info.Mode().IsRegular() {
			return fmt.Errorf("offline recovery requires an existing regular database file")
		}
	}
	releaseLock, e := acquireProcessLock(*dbPath)
	if e != nil {
		return e
	}
	defer releaseLock()
	s, e := store.Open(*dbPath, key)
	if e != nil {
		return fmt.Errorf("open state: %w", e)
	}
	defer s.Close()
	if *recoverAccount != "" {
		password, e := readRecoveryPassword(os.Stdin)
		if e != nil {
			return e
		}
		if e = s.RecoverAdministrator(*recoverAccount, password, *recoverReason, *recoverMFA, time.Now()); e != nil {
			return fmt.Errorf("offline recovery failed: %w", e)
		}
		log.Print("Offline administrator recovery committed; previous sessions revoked and password change required")
		return nil
	}
	if username != "" {
		if e = s.EnsureAdmin(username, password); e != nil {
			return fmt.Errorf("initialize administrator: %w", e)
		}
	}
	restoreDir, e := filepath.Abs(filepath.Join(filepath.Dir(*dbPath), "restore-staging"))
	if e != nil {
		return fmt.Errorf("resolve restore directory: %w", e)
	}
	proxyCIDRs := []string{}
	if strings.TrimSpace(*trustedProxies) != "" {
		proxyCIDRs = strings.Split(*trustedProxies, ",")
	}
	if *demo && *oidcConfigPath != "" {
		return fmt.Errorf("OIDC is unavailable in demo mode")
	}
	oidcProvider, err := configuredOIDC(*oidcConfigPath, publicOrigin)
	if err != nil {
		return err
	}
	ipMetadata, err := ipmeta.Open(*countryDB, *asnDB)
	if err != nil {
		return fmt.Errorf("IP metadata: %w", err)
	}
	apiOptions := httpapi.Options{IPMetadata: ipMetadata, OIDC: oidcProvider, TrustedProxyCIDRs: proxyCIDRs, PublicOrigin: publicOrigin, AdminToken: adminToken, UIDir: *uiDir, SecureCookies: tlsEnabled, BackupRestoreDir: restoreDir, BackupRestoreKey: key, BackupLimits: backupLimits}
	app := httpapi.NewWithOptions(s, render.Default(), apiOptions)
	srv := &http.Server{Addr: *listen, Handler: app, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 1 << 20}
	listener, e := listenControlPlane(context.Background(), *listen)
	if e != nil {
		return e
	}
	defer listener.Close()
	scheme := "http"
	if tlsEnabled {
		scheme = "https"
	}
	log.Printf("RouteWeaver listening at %s://%s", scheme, listener.Addr())
	if *demo {
		log.Print("Ephemeral local demo: username routeweaver; password local-demo-password. State is removed on exit.")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	independentCtx, cancelIndependent := context.WithCancel(ctx)
	independentDone := make(chan struct{})
	go func() {
		defer close(independentDone)
		httpapi.RunIndependentOutputProvisioning(independentCtx, s, apiOptions)
	}()
	defer func() { cancelIndependent(); <-independentDone }()
	coreCleanupCtx, cancelCoreCleanup := context.WithCancel(ctx)
	coreCleanupDone := make(chan struct{})
	go func() {
		defer close(coreCleanupDone)
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			cleanupCtx, cleanupCancel := context.WithTimeout(coreCleanupCtx, 5*time.Second)
			if err := s.PruneNodeResourceHistories(cleanupCtx, time.Now().UTC()); err != nil && coreCleanupCtx.Err() == nil {
				log.Print("Resource history retention cleanup failed")
			}
			cleanupCancel()
			if err := s.PruneCoreDiagnostics(time.Now().UTC()); err != nil {
				log.Print("Core diagnostic retention cleanup failed")
			}
			select {
			case <-coreCleanupCtx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	defer func() { cancelCoreCleanup(); <-coreCleanupDone }()
	notificationCtx, cancelNotifications := context.WithCancel(ctx)
	notificationsDone := make(chan struct{})
	go func() {
		defer close(notificationsDone)
		httpapi.RunNotificationsWithBudget(notificationCtx, s, time.Minute, notificationBudget, func(err error) {
			// RunNotifications supplies only sanitized operational classes.
			log.Printf("Background notifications: %v", err)
		})
	}()
	defer func() { cancelNotifications(); <-notificationsDone }()
	done := make(chan error, 1)
	go func() {
		if tlsEnabled {
			done <- srv.ServeTLS(listener, *tlsCert, *tlsKey)
		} else {
			done <- srv.Serve(listener)
		}
	}()
	select {
	case e := <-done:
		if !errors.Is(e, http.ErrServerClosed) {
			return e
		}
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if e = srv.Shutdown(shutdown); e != nil {
			srv.Close()
			return e
		}
		e = <-done
		if !errors.Is(e, http.ErrServerClosed) {
			return e
		}
	}
	return nil
}
