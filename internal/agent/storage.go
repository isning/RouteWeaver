package agent

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"routeweaver/internal/controlprotocol"
	"strings"
	"time"
)

type journal struct {
	ReportSequence        uint64                         `json:"reportSequence,string,omitempty"`
	PolicyRefresh         *controlprotocol.PolicyRefresh `json:"policyRefresh,omitempty"`
	PolicyIssuedHighWater time.Time                      `json:"policyIssuedHighWater,omitempty"`
	LatestPolicy          *PolicyLease                   `json:"latestPolicy,omitempty"`
	Schema                int                            `json:"schema"`
	Scope                 Scope                          `json:"scope"`
	State                 State                          `json:"state"`
	Payload               *Desired                       `json:"payload,omitempty"`
	LastValid             *Desired                       `json:"lastValid,omitempty"`
	RequestDigest         string                         `json:"requestDigest,omitempty"`
	Stage                 string                         `json:"stage,omitempty"`
	PreviousStage         string                         `json:"previousStage,omitempty"`
	LastWallTime          time.Time                      `json:"lastWallTime"`
}

// atomicWrite fsyncs file contents before rename and the directory after rename.
// The root must be private, local, trusted storage supporting these operations.
func atomicWrite(name string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(name)
	f, err := os.CreateTemp(dir, ".write-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if err = f.Chmod(mode); err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Rename(tmp, name); err != nil {
		return err
	}
	return syncDir(dir)
}
func syncDir(dir string) error {
	f, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}
func writeJSON(name string, value any) error {
	b, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return atomicWrite(name, b, 0600)
}
func readJSON(name string, value any) error {
	f, err := os.Open(name)
	if err != nil {
		return err
	}
	defer f.Close()
	d := json.NewDecoder(io.LimitReader(f, 20<<20))
	d.DisallowUnknownFields()
	if err = d.Decode(value); err != nil {
		return err
	}
	var extra any
	if err = d.Decode(&extra); err != io.EOF {
		return errors.New("trailing state JSON")
	}
	return nil
}
func stageFiles(root string, d Desired) (string, error) {
	parent := filepath.Join(root, "revisions")
	if err := os.MkdirAll(parent, 0700); err != nil {
		return "", err
	}
	dir, err := os.MkdirTemp(parent, fmt.Sprintf("g%d-", d.Generation))
	if err != nil {
		return "", err
	}
	complete := false
	defer func() {
		if !complete {
			os.RemoveAll(dir)
		}
	}()
	for _, a := range d.Artifacts {
		name := filepath.Join(dir, filepath.FromSlash(a.Path))
		if err = os.MkdirAll(filepath.Dir(name), 0700); err != nil {
			return "", err
		}
		if err = atomicWrite(name, []byte(a.Content), 0600); err != nil {
			return "", err
		}
	}
	if err = syncDir(dir); err != nil {
		return "", err
	}
	if err = syncDir(parent); err != nil {
		return "", err
	}
	complete = true
	return filepath.Join("revisions", filepath.Base(dir)), nil
}
func currentStage(root string) (string, error) {
	p, err := os.Readlink(filepath.Join(root, "current"))
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if !validStage(p) {
		return "", errors.New("unsafe active pointer")
	}
	return p, nil
}
func validStage(p string) bool {
	return p != "" && filepath.Clean(p) == p && !filepath.IsAbs(p) && strings.HasPrefix(p, "revisions"+string(filepath.Separator)) && filepath.Base(p) == strings.TrimPrefix(p, "revisions"+string(filepath.Separator))
}
func switchStage(root, stage string) error {
	if stage == "" {
		err := os.Remove(filepath.Join(root, "current"))
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return syncDir(root)
	}
	if !validStage(stage) {
		return errors.New("invalid staged directory")
	}
	f, err := os.CreateTemp(root, ".current-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	f.Close()
	os.Remove(tmp)
	defer os.Remove(tmp)
	if err = os.Symlink(stage, tmp); err != nil {
		return err
	}
	if err = os.Rename(tmp, filepath.Join(root, "current")); err != nil {
		return err
	}
	return syncDir(root)
}
func verifyStage(root, stage string, d Desired) error {
	if !validStage(stage) {
		return errors.New("invalid stage")
	}
	for _, a := range d.Artifacts {
		name := filepath.Join(root, stage, filepath.FromSlash(a.Path))
		info, err := os.Lstat(name)
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return errors.New("artifact is not a regular file")
		}
		b, err := os.ReadFile(name)
		if err != nil {
			return err
		}
		if string(b) != a.Content {
			return errors.New("staged artifact changed")
		}
	}
	return nil
}
