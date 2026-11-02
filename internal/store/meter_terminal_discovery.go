package store

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"routeweaver/internal/domain"
)

// A page examines at most 16 indexed metadata rows, including its lookahead.
// It decrypts at most 15 inbox rows and 2 MiB, never materializes raw history.
const terminalDiscoveryRows = 16
const terminalDiscoveryBytes = 2 << 20

type TerminalEvidenceLocator struct {
	StreamEpoch     string    `json:"streamEpoch"`
	Sequence        uint64    `json:"sequence,string"`
	BatchDigest     string    `json:"batchDigest"`
	EvidenceDigest  string    `json:"evidenceDigest"`
	RuntimeEpoch    string    `json:"runtimeEpoch"`
	FinalObservedAt time.Time `json:"finalObservedAt"`
	CounterCount    int       `json:"counterCount"`
}
type TerminalEvidencePage struct {
	InstanceID      string                    `json:"instanceId"`
	EnrollmentEpoch string                    `json:"enrollmentEpoch"`
	Items           []TerminalEvidenceLocator `json:"items"`
	NextCursor      string                    `json:"nextCursor,omitempty"`
	HasMore         bool                      `json:"hasMore"`
	Examined        int                       `json:"examined"`
}
type terminalDiscoveryCursor struct {
	Instance   string `json:"instance"`
	Enrollment string `json:"enrollment"`
	After      string `json:"after"`
}

func (s *Store) terminalCursorMAC(raw []byte) []byte {
	h := hmac.New(sha256.New, s.reviewKey)
	h.Write([]byte("meter-terminal-discovery-v1\x00"))
	h.Write(raw)
	return h.Sum(nil)
}
func (s *Store) encodeTerminalCursor(c terminalDiscoveryCursor) string {
	raw, _ := json.Marshal(c)
	return base64.RawURLEncoding.EncodeToString(raw) + "." + base64.RawURLEncoding.EncodeToString(s.terminalCursorMAC(raw))
}
func (s *Store) decodeTerminalCursor(encoded, instance, enrollment string) (string, error) {
	prefix := instance + ":" + enrollment + ":"
	if encoded == "" {
		return prefix, nil
	}
	if len(encoded) > 2048 {
		return "", fmt.Errorf("invalid terminal evidence cursor")
	}
	parts := strings.Split(encoded, ".")
	if len(parts) != 2 {
		return "", fmt.Errorf("invalid terminal evidence cursor")
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", fmt.Errorf("invalid terminal evidence cursor")
	}
	mac, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || !hmac.Equal(mac, s.terminalCursorMAC(raw)) {
		return "", fmt.Errorf("invalid terminal evidence cursor")
	}
	var c terminalDiscoveryCursor
	if json.Unmarshal(raw, &c) != nil || c.Instance != instance || c.Enrollment != enrollment || !strings.HasPrefix(c.After, prefix) || c.After == prefix || len(c.After) > 512 {
		return "", fmt.Errorf("terminal evidence cursor scope mismatch")
	}
	return c.After, nil
}

type terminalContextQuery struct {
	context context.Context
	tx      *sql.Tx
}

func (q terminalContextQuery) QueryRow(query string, args ...any) *sql.Row {
	return q.tx.QueryRowContext(q.context, query, args...)
}

// DiscoverMeterTerminalEvidence locates historical proof after local GC without
// requiring a remembered stream epoch. Enrollment is explicit and cursors are
// authenticated and bound to that exact scope. Custody is never settlement.
func (s *Store) DiscoverMeterTerminalEvidence(ctx context.Context, instance, enrollment, cursor string) (TerminalEvidencePage, error) {
	out := TerminalEvidencePage{InstanceID: instance, EnrollmentEpoch: enrollment, Items: []TerminalEvidenceLocator{}}
	if !domain.ValidID(instance) || !domain.ValidID(enrollment) {
		return out, fmt.Errorf("invalid terminal discovery scope")
	}
	after, err := s.decodeTerminalCursor(cursor, instance, enrollment)
	if err != nil {
		return out, err
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if err = ctx.Err(); err != nil {
		return out, err
	}
	err = s.readSnapshot(ctx, func(tx *sql.Tx) error {
		prefix := instance + ":" + enrollment + ":"
		upper := instance + ":" + enrollment + ";"
		rows, err := tx.QueryContext(ctx, `SELECT substr(id,1,513),length(id),length(data) FROM records WHERE kind='meter-inbox' AND id>=? AND id<? AND id>? ORDER BY id LIMIT ?`, prefix, upper, after, terminalDiscoveryRows)
		if err != nil {
			return err
		}
		type meta struct {
			id   string
			size int
		}
		metadata := []meta{}
		for rows.Next() {
			var m meta
			var idSize int
			if err = rows.Scan(&m.id, &idSize, &m.size); err != nil {
				rows.Close()
				return err
			}
			if idSize > 512 || len(m.id) > 512 {
				rows.Close()
				return fmt.Errorf("terminal inbox identity exceeds bound")
			}
			metadata = append(metadata, m)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		out.Examined = len(metadata)
		used := 0
		for i, m := range metadata {
			if err = ctx.Err(); err != nil {
				return err
			}
			plaintext := m.size - s.aead.NonceSize() - s.aead.Overhead()
			if plaintext < 0 || plaintext > maxTerminalInboxBytes {
				return fmt.Errorf("terminal discovery inbox exceeds record bound")
			}
			if i == terminalDiscoveryRows-1 || used+plaintext > terminalDiscoveryBytes {
				out.HasMore = true
				break
			}
			var raw json.RawMessage
			q := terminalContextQuery{context: ctx, tx: tx}
			if err = s.readBoundedTerminalInbox(q, m.id, &raw); err != nil {
				return err
			}
			used += len(raw)
			var wire terminalWireBatch
			if err = json.Unmarshal(raw, &wire); err != nil {
				return err
			}
			if wire.TerminalEvidence != nil {
				expected := fmt.Sprintf("%s:%s:%s:%d", instance, enrollment, wire.StreamEpoch, wire.Sequence)
				if m.id != expected {
					return fmt.Errorf("terminal discovery index scope mismatch")
				}
				batch := CounterBatch{InstanceID: instance, EnrollmentEpoch: enrollment, StreamEpoch: wire.StreamEpoch, Sequence: wire.Sequence, Digest: wire.Digest, Samples: wire.Samples, TerminalEvidence: wire.TerminalEvidence}
				if _, err = validateTerminalCounterBatch(batch, raw); err != nil {
					return err
				}
				var digest string
				if err = s.readBoundedTerminalReceipt(q, m.id, &digest); err != nil {
					return err
				}
				if digest != wire.Digest {
					return fmt.Errorf("terminal discovery receipt mismatch")
				}
				proof := wire.TerminalEvidence
				out.Items = append(out.Items, TerminalEvidenceLocator{StreamEpoch: wire.StreamEpoch, Sequence: wire.Sequence, BatchDigest: digest, EvidenceDigest: proof.Digest, RuntimeEpoch: proof.RuntimeEpoch, FinalObservedAt: proof.Final.ObservedAt, CounterCount: len(proof.Final.Counters)})
			}
			after = m.id
		}
		if out.HasMore {
			out.NextCursor = s.encodeTerminalCursor(terminalDiscoveryCursor{Instance: instance, Enrollment: enrollment, After: after})
		}
		return ctx.Err()
	})
	if err != nil {
		return TerminalEvidencePage{}, err
	}
	return out, nil
}
