package store

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// Known derived indexes must be complete in both directions. Opaque future
// domain records remain lossless, but a known live feed or replay fence must not
// be restored into a state that cannot exist after an atomic repository command.
func validateBackupRelationships(v Snapshot) error {
	tokens := map[string]string{}
	for _, token := range v.Tokens {
		tokens[token.Kind+"\x00"+token.Digest] = token.RecordID
	}
	counters := map[string]int64{}
	for _, counter := range v.Counters {
		counters[counter.Kind+"\x00"+counter.ID] = counter.Value
	}
	for _, record := range v.Records {
		if err := validateBackupRelationship(record, func(kind, digest string) string { return tokens[kind+"\x00"+digest] }, func(kind, id string) (int64, bool) { v, ok := counters[kind+"\x00"+id]; return v, ok }); err != nil {
			return err
		}
	}
	return nil
}

func validateBackupRelationship(record BackupRecord, token func(string, string) string, counter func(string, string) (int64, bool)) error {
	requireFence := func(instance string, generation uint64) error {
		n, ok := counter("agent-desired", instance)
		if !ok || generation == 0 || n < 0 || uint64(n) < generation {
			return fmt.Errorf("backup replay generation fence is missing or behind accepted state")
		}
		return nil
	}

	if ownerKind, ok := strings.CutPrefix(record.Kind, "tenant/"); ok {
		owner, kind, ok := strings.Cut(ownerKind, "/")
		if ok && kind == "outputs" {
			var output struct {
				TokenDigest string `json:"tokenDigest"`
				Status      string `json:"status"`
			}
			if json.Unmarshal(record.Data, &output) != nil {
				return fmt.Errorf("invalid backup output")
			}
			if output.Status == "published" || output.TokenDigest != "" && output.Status != "revoked" {
				if output.TokenDigest == "" || token("feeds", output.TokenDigest) != owner+"/"+record.ID {
					return fmt.Errorf("backup active feed index is incomplete")
				}
			}
		}
	}
	switch record.Kind {
	case "agent-desired":
		var desired struct {
			Generation json.RawMessage `json:"generation"`
		}
		if json.Unmarshal(record.Data, &desired) != nil {
			return fmt.Errorf("invalid backup desired state")
		}
		g, e := backupGeneration(desired.Generation)
		if e != nil {
			return e
		}
		if e = requireFence(record.ID, g); e != nil {
			return e
		}
	case "published-manifests":
		var manifest struct {
			Identity struct {
				InstanceID string          `json:"instanceId"`
				Generation json.RawMessage `json:"generation"`
			} `json:"identity"`
		}
		if json.Unmarshal(record.Data, &manifest) != nil {
			return fmt.Errorf("invalid backup published manifest")
		}
		g, e := backupGeneration(manifest.Identity.Generation)
		if e != nil {
			return e
		}
		if e = requireFence(manifest.Identity.InstanceID, g); e != nil {
			return e
		}
	}
	return nil
}
func backupGeneration(raw json.RawMessage) (uint64, error) {
	text := string(raw)
	if len(raw) > 0 && raw[0] == '"' {
		if e := json.Unmarshal(raw, &text); e != nil {
			return 0, fmt.Errorf("invalid backup generation")
		}
	}
	n, e := strconv.ParseUint(text, 10, 64)
	if e != nil || n == 0 {
		return 0, fmt.Errorf("invalid backup generation")
	}
	return n, nil
}
