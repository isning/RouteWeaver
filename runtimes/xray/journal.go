package managedxray

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"routeweaver/internal/entrypolicy"
)

// Journal establishes a real zero baseline before opening any public listener.
// It is not a per-byte WAL: a crash may lose the final in-memory interval, so an
// unclean marker intentionally blocks a fresh epoch until explicit recovery.
type Journal struct {
	dir   string
	epoch string
}

func BeginJournal(dir string, s entrypolicy.Snapshot) (*Journal, error) {
	if !identifier.MatchString(s.CounterEpoch) || s.ActiveFlows != 0 || len(s.Counters) == 0 {
		return nil, errors.New("valid counter epoch required")
	}
	if !filepath.IsAbs(dir) {
		return nil, errors.New("absolute journal directory required")
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	st, err := os.Lstat(dir)
	if err != nil || !st.IsDir() || st.Mode().Perm()&0077 != 0 {
		return nil, errors.New("private journal directory required")
	}
	for _, c := range s.Counters {
		if c.CumulativeBytes != 0 || c.UploadBytes != 0 || c.DownloadBytes != 0 {
			return nil, errors.New("real zero snapshot required before runtime startup")
		}
	}
	marker := filepath.Join(dir, "running.json")
	f, err := os.OpenFile(marker, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return nil, errors.New("unclean or concurrent runtime epoch requires reconciliation")
	}
	b, _ := json.Marshal(map[string]string{"counterEpoch": s.CounterEpoch})
	_, err = f.Write(b)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return nil, err
	}
	j := &Journal{dir: dir, epoch: s.CounterEpoch}
	if err = j.write(s, "baseline"); err != nil {
		return nil, err
	}
	return j, nil
}
func (j *Journal) write(s entrypolicy.Snapshot, kind string) error {
	if s.CounterEpoch != j.epoch {
		return errors.New("journal counter epoch mismatch")
	}
	b, err := json.Marshal(s)
	if err != nil {
		return err
	}
	p := filepath.Join(j.dir, j.epoch+"."+kind+".json")
	f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	if _, err = f.Write(b); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return syncDirectory(j.dir)
}
func (j *Journal) Finish(s entrypolicy.Snapshot) error {
	if s.ActiveFlows != 0 {
		return errors.New("runtime flows must be quiescent before final snapshot")
	}
	if err := j.write(s, "final"); err != nil {
		return err
	}
	if err := os.Remove(filepath.Join(j.dir, "running.json")); err != nil {
		return err
	}
	return syncDirectory(j.dir)
}
func syncDirectory(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}
