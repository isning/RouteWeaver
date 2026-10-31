package httpapi

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"routeweaver/internal/auth"
	"routeweaver/internal/backup"
	"routeweaver/internal/store"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

type backupRequest struct {
	Password     string `json:"password"`
	Archive      string `json:"archive"`
	Digest       string `json:"digest"`
	Confirmation string `json:"confirmation"`
}

// Each server bounds age's memory-hard passphrase work to one operation. Only
// digests and expiry times are retained after preview, never passwords/plaintext.
func (h *server) registerBackup(r chi.Router) {
	h.registerBackupWithRestore(r, func(ctx context.Context, prepared *backup.Prepared, target string, key []byte) error {
		return prepared.Restore(ctx, target, key)
	})
}

// Per-router final-operation seam keeps HTTP result/receipt tests independent of
// filesystem fault injection. Public server construction always uses real restore.
func (h *server) registerBackupWithRestore(r chi.Router, restore func(context.Context, *backup.Prepared, string, []byte) error) {
	h.registerBackupWithOperations(r, backup.CreateStream, restore)
}

// Private per-router final operations; production constructors always bind real operations.
func (h *server) registerBackupWithOperations(r chi.Router, create func(context.Context, *store.Store, string, io.Writer, backup.Limits) error, restore func(context.Context, *backup.Prepared, string, []byte) error) {
	gate := make(chan struct{}, 1)
	previews := map[string]time.Time{}
	limits, limitsError := h.opts.BackupLimits.Normalize()
	run := func(responseAllowance time.Duration, strictDeadlines bool, fn http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			select {
			case gate <- struct{}{}:
				defer func() { <-gate }()
			case <-r.Context().Done():
				return
			default:
				fail(w, 429, "another backup operation is running; try again shortly")
				return
			}
			if limitsError != nil {
				fail(w, 500, "invalid operator backup limits")
				return
			}
			withBackupDeadlinePolicy(w, r, limits.Duration, responseAllowance, strictDeadlines, fn)
		}
	}
	r.Post("/admin/backups", run(time.Second, true, func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Password string `json:"password"`
		}
		if !decode(w, r, &in) {
			return
		}
		if err := backup.ValidatePassword(in.Password); err != nil {
			fail(w, 400, err.Error())
			return
		}
		// Complete into a private ciphertext-only spool before sending 200.
		// This makes mid-export validation/disk failures visible, not downloads
		// that the UI mistakenly reports as successful complete archives.
		archive, err := os.CreateTemp("", "routeweaver-export-*.age")
		if err != nil {
			fail(w, 500, "cannot prepare encrypted backup storage")
			return
		}
		defer os.Remove(archive.Name())
		defer archive.Close()
		err = create(r.Context(), h.s, in.Password, archive, limits)
		in.Password = ""
		if err == nil && r.Context().Err() != nil {
			err = r.Context().Err()
		}
		if errors.Is(err, context.DeadlineExceeded) || err == nil && backupExportExpired(r.Context()) {
			writeBackupExportDeadline(w)
			return
		}
		if err != nil {
			if errors.Is(err, store.ErrBackupRecordLimit) {
				fail(w, 400, err.Error())
				return
			}
			fail(w, 400, "cannot create complete backup: verify store integrity, configured archive/record/row limits and available disk space; no history was omitted")
			return
		}
		info, err := archive.Stat()
		if err != nil {
			fail(w, 500, "cannot read encrypted backup")
			return
		}
		if _, err = archive.Seek(0, 0); err != nil {
			fail(w, 500, "cannot read encrypted backup")
			return
		}
		// The upfront extra window is exclusively for pre-success errors.
		// A completed archive must use the original operation deadline, not
		// the error reserve. Never renew a deadline after an expired copy.
		if backupExportExpired(r.Context()) {
			writeBackupExportDeadline(w)
			return
		}
		if r.Context().Err() != nil {
			fail(w, 400, "backup export was canceled")
			return
		}
		deadline, _ := r.Context().Deadline()
		if err := http.NewResponseController(w).SetWriteDeadline(deadline); err != nil {
			fail(w, 500, "cannot bound backup download time")
			return
		}
		if backupExportExpired(r.Context()) {
			// The tightened deadline may now be expired: do not renew it.
			writeBackupExportDeadline(w)
			return
		}
		if r.Context().Err() != nil {
			fail(w, 400, "backup export was canceled")
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", `attachment; filename="routeweaver-backup.age"`)
		w.Header().Set("Content-Length", fmt.Sprint(info.Size()))
		w.WriteHeader(http.StatusOK)
		io.Copy(w, archive)
	}))
	r.Post("/admin/backups/preview", run(0, false, func(w http.ResponseWriter, r *http.Request) {
		in, archive, finish, ok := readBackupUpload(w, r)
		if !ok {
			return
		}
		prepared, err := backup.PreviewStream(r.Context(), archive, in.Password, limits)
		in.Password = ""
		if err != nil {
			fail(w, 400, err.Error())
			return
		}
		defer prepared.Close()
		if !finish() {
			return
		}
		now := time.Now()
		for key, until := range previews {
			if now.After(until) {
				delete(previews, key)
			}
		}
		if len(previews) >= 100 {
			fail(w, 429, "too many pending restore previews; try again later")
			return
		}
		summary := prepared.Summary()
		previews[current(r).Account.ID+"/"+summary.Digest] = now.Add(10 * time.Minute)
		writeJSON(w, 200, struct {
			backup.Summary
			RestoreAvailable bool `json:"restoreAvailable"`
		}{summary, h.backupRestoreAvailable()})
	}))
	r.Post("/admin/backups/restore", run(time.Second, false, func(w http.ResponseWriter, r *http.Request) {
		if !h.backupRestoreAvailable() {
			fail(w, 409, "restore storage is not configured; ask the operator to configure a private restore directory and master key")
			return
		}
		in, archive, finish, ok := readBackupUpload(w, r)
		if !ok {
			return
		}
		if in.Confirmation != "RESTORE TO NEW STORE" {
			fail(w, 400, "confirm RESTORE TO NEW STORE after reviewing the restore impact")
			return
		}
		key := current(r).Account.ID + "/" + in.Digest
		until, seen := previews[key]
		if !seen || !time.Now().Before(until) {
			fail(w, 409, "restore preview is missing, expired or changed; preview this file again")
			return
		}
		prepared, err := backup.PreviewStream(r.Context(), archive, in.Password, limits)
		in.Password = ""
		if err != nil {
			fail(w, 400, err.Error())
			return
		}
		defer prepared.Close()
		if !finish() {
			return
		}
		if subtle.ConstantTimeCompare([]byte(prepared.Summary().Digest), []byte(in.Digest)) != 1 {
			fail(w, 409, "restore preview is missing, expired or changed; preview this file again")
			return
		}
		// Directory comes exclusively from operator configuration. Neither filename
		// nor paths contained in an uploaded document can choose a filesystem target.
		if err = os.MkdirAll(h.opts.BackupRestoreDir, 0700); err != nil {
			writeJSON(w, 500, map[string]any{"restoreOutcome": "not_published", "activated": false, "restoreReason": "restore_storage_prepare_failed", "detail": "Cannot prepare private restore storage. No new target was published; the running store is unchanged. Ask the operator to check the restore directory."})
			return
		}
		token, err := auth.Token()
		if err != nil {
			writeJSON(w, 500, map[string]any{"restoreOutcome": "not_published", "activated": false, "restoreReason": "restore_target_reservation_failed", "detail": "Cannot reserve a restore target. No new target was published; the running store is unchanged. Retry after the operator checks the service."})
			return
		}
		target := "restore_" + token + ".db"
		path := filepath.Join(h.opts.BackupRestoreDir, target)
		err = restore(r.Context(), prepared, path, h.opts.BackupRestoreKey)
		writeBackupRestoreResult(w, previews, key, target, err)
	}))
}

func backupExportExpired(ctx context.Context) bool {
	deadline, ok := ctx.Deadline()
	return errors.Is(ctx.Err(), context.DeadlineExceeded) || !ok || !time.Now().Before(deadline)
}

func writeBackupExportDeadline(w http.ResponseWriter) {
	writeJSON(w, http.StatusServiceUnavailable, map[string]string{
		"reason": "backup_export_deadline_exceeded",
		"detail": "Backup creation reached the configured time limit; no complete backup was produced.",
	})
}

// Response allowances are reserved before work starts. Export errors alone may
// use their allowance; successful exports tighten back to the operation deadline.
// Restore uses its allowance only for an already-returned result. An already expired
// ResponseController write deadline cannot reliably be renewed. The allowance
// never changes the operation/upload budget and does not guarantee delivery:
// noninterruptible work, staging cleanup or a disconnected peer can exceed it.
func withBackupDeadlines(w http.ResponseWriter, r *http.Request, duration, responseAllowance time.Duration, fn http.HandlerFunc) {
	withBackupDeadlinePolicy(w, r, duration, responseAllowance, false, fn)
}

func withBackupDeadlinePolicy(w http.ResponseWriter, r *http.Request, duration, responseAllowance time.Duration, strict bool, fn http.HandlerFunc) {
	deadline := time.Now().Add(duration)
	controller := http.NewResponseController(w)
	if err := controller.SetReadDeadline(deadline); err != nil && (strict || !errors.Is(err, http.ErrNotSupported)) {
		fail(w, 500, "cannot bound backup upload time")
		return
	}
	if err := controller.SetWriteDeadline(deadline.Add(responseAllowance)); err != nil && (strict || !errors.Is(err, http.ErrNotSupported)) {
		fail(w, 500, "cannot bound backup response time")
		return
	}
	ctx, cancel := context.WithDeadline(r.Context(), deadline)
	defer cancel()
	fn(w, r.WithContext(ctx))
}

// Classify the completed operation, not the context or response-write result.
// A receipt blocks direct replay only; another preview is not reconciliation.
func writeBackupRestoreResult(w http.ResponseWriter, previews map[string]time.Time, key, target string, err error) {
	if err == nil {
		delete(previews, key)
		writeJSON(w, 201, map[string]any{"status": "restored", "target": target, "activated": false, "message": "Verified new store created in the configured restore directory. The running store is unchanged. Stop the service and explicitly select the restored database with the configured master key before restarting."})
		return
	}
	if errors.Is(err, store.ErrRestorePublicationUncertain) {
		delete(previews, key)
		writeJSON(w, 500, map[string]any{"restoreOutcome": "uncertain", "target": target, "activated": false, "detail": "The new restore target may exist, but its final state could not be confirmed. The running store is unchanged. Ask the operator to check restore storage and confirm this attempt has stopped before starting another restore."})
		return
	}
	status := http.StatusInternalServerError
	reason := "restore_publication_failed"
	detail := "No new restore target was published by this attempt. The running store is unchanged. Check restore storage before retrying."
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		status = http.StatusServiceUnavailable
		reason = "restore_prepublication_cancelled"
		detail = "The restore stopped before publishing a new target. The running store is unchanged. Check the backup limits and available resources before retrying."
	}
	writeJSON(w, status, map[string]any{"restoreOutcome": "not_published", "activated": false, "restoreReason": reason, "detail": detail})
}

func (h *server) backupRestoreAvailable() bool {
	return filepath.IsAbs(h.opts.BackupRestoreDir) && len(h.opts.BackupRestoreKey) == 32
}
func readBackup(w http.ResponseWriter, r *http.Request) (backupRequest, []byte, bool) {
	var in backupRequest
	if !decode(w, r, &in) {
		return in, nil, false
	}
	if len(in.Archive) > base64.StdEncoding.EncodedLen(backup.MaxArchiveBytes) {
		fail(w, 413, "backup exceeds the 16 MiB archive limit")
		return in, nil, false
	}
	if strings.ContainsAny(in.Archive, "\r\n") {
		fail(w, 400, "backup must use canonical base64 encoding")
		return in, nil, false
	}
	archive, err := base64.StdEncoding.Strict().DecodeString(in.Archive)
	in.Archive = ""
	if err != nil || len(archive) == 0 {
		fail(w, 400, "invalid backup file encoding")
		return in, nil, false
	}
	return in, archive, true
}

// Multipart metadata must precede the one archive part, so passphrases never
// enter URLs/headers and the server never invokes ParseMultipartForm (which can
// spill unencrypted fields to disk). Remaining parts are rejected after EOF.
func readBackupUpload(w http.ResponseWriter, r *http.Request) (backupRequest, io.Reader, func() bool, bool) {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data") {
		in, b, ok := readBackup(w, r)
		return in, bytes.NewReader(b), func() bool { return true }, ok
	}
	var in backupRequest
	bad := func() (backupRequest, io.Reader, func() bool, bool) {
		fail(w, 400, "invalid backup multipart upload; send metadata followed by one archive file")
		return in, nil, nil, false
	}
	mr, err := r.MultipartReader()
	if err != nil {
		return bad()
	}
	metadata, err := mr.NextPart()
	if err != nil || metadata.FormName() != "metadata" || metadata.FileName() != "" {
		return bad()
	}
	raw, err := io.ReadAll(io.LimitReader(metadata, 4097))
	defer clear(raw)
	if err != nil || len(raw) > 4096 {
		return bad()
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var extra any
	if decoder.Decode(&in) != nil || decoder.Decode(&extra) != io.EOF || in.Archive != "" {
		return bad()
	}
	clear(raw)
	metadata.Close()
	part, err := mr.NextPart()
	if err != nil || part.FormName() != "archive" || part.FileName() == "" {
		return bad()
	}
	return in, part, func() bool {
		if _, err := mr.NextPart(); err != io.EOF {
			fail(w, 400, "backup upload contains unexpected extra parts")
			return false
		}
		return true
	}, true
}
