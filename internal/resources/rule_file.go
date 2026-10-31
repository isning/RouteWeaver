package resources

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"

	"gopkg.in/yaml.v3"
	"routeweaver/internal/domain"
)

// Limits cover accepted bytes, envelope complexity, and a complete frozen output.
// Base64-encoded output records remain below the default 32 MiB backup row limit.
const MaxRuleFileBytes = 8 << 20
const MaxBundleFileBytes = 16 << 20
const MaxBundleFiles = 64
const maxRuleEntries = 100000

// RuleFile contains accepted opaque bytes, never expanded into client policy.
// Source locators and fetch credentials are deliberately not part of this value.
type RuleFile struct {
	Resource   domain.RuleResource `json:"resource"`
	Body       []byte              `json:"body"`
	Inspection string              `json:"inspection"`
}

// AcceptRuleFile validates a bounded envelope and integrity, not arbitrary native
// semantics. Only a separately invoked native parser may claim native validation.
func AcceptRuleFile(r domain.RuleResource, body []byte) (RuleFile, error) {
	if !domain.ValidID(r.ID) || r.OwnerID == "" {
		return RuleFile{}, fmt.Errorf("owned resource identity required")
	}
	if len(body) == 0 || len(body) > MaxRuleFileBytes {
		return RuleFile{}, fmt.Errorf("rule file must contain 1 to %d bytes", MaxRuleFileBytes)
	}
	sum := sha256.Sum256(body)
	digest := "sha256:" + hex.EncodeToString(sum[:])
	if r.Digest != "" && r.Digest != digest {
		return RuleFile{}, fmt.Errorf("rule file SHA-256 does not match the requested pin")
	}
	version, inspection, err := InspectRuleFile(r.Format, body)
	if err != nil {
		return RuleFile{}, err
	}
	if version > 0 {
		if r.FormatVersion != 0 && r.FormatVersion != version {
			return RuleFile{}, fmt.Errorf("rule file format version does not match its envelope")
		}
		r.FormatVersion = version
	}
	switch r.Format {
	case "mihomo-yaml", "mihomo-text", "mrs":
		if r.Behavior != "domain" && r.Behavior != "ipcidr" && r.Behavior != "classical" {
			return RuleFile{}, fmt.Errorf("Mihomo rule behavior required")
		}
		if r.Format == "mrs" && r.Behavior == "classical" {
			return RuleFile{}, fmt.Errorf("MRS cannot represent classical rules")
		}
	}
	if r.UpdatePolicy == "" {
		r.UpdatePolicy = "pinned"
	}
	r.Digest = digest
	r.SizeBytes = int64(len(body))
	r.Location = "local"
	r.URL = ""
	r.IntervalSeconds = 0
	// The immutable version also binds owner, resource identity and interpretation.
	versionBytes, _ := json.Marshal([]any{r.OwnerID, r.ID, r.Digest, r.Format, r.FormatVersion, r.Behavior})
	v := sha256.Sum256(versionBytes)
	r.AcceptedVersion = hex.EncodeToString(v[:])
	r.Revision = r.AcceptedVersion
	r.Path = RuleFilePath(r)
	if err := domain.ValidateRuleResource(r); err != nil {
		return RuleFile{}, err
	}
	return RuleFile{Resource: r, Body: append([]byte(nil), body...), Inspection: inspection}, nil
}

func RuleFilePath(r domain.RuleResource) string {
	ext := map[string]string{"sing-box-source": "json", "srs": "srs", "mihomo-yaml": "yaml", "mihomo-text": "txt", "mrs": "mrs"}[r.Format]
	if ext == "" || !strings.HasPrefix(r.Digest, "sha256:") || len(r.Digest) != 71 {
		return ""
	}
	return "rules/" + strings.TrimPrefix(r.Digest, "sha256:") + "." + ext
}

// VerifyRuleFile also validates generated delivery paths. It never reads Path.
func VerifyRuleFile(f RuleFile) error {
	accepted, err := AcceptRuleFile(f.Resource, f.Body)
	if err != nil {
		return err
	}
	a, b := accepted.Resource, f.Resource
	if a.AcceptedVersion != b.AcceptedVersion || a.Revision != b.Revision || a.SizeBytes != b.SizeBytes || a.Path != b.Path || b.Location != "local" || b.URL != "" {
		return fmt.Errorf("accepted rule file manifest integrity failed")
	}
	return nil
}

// InspectRuleFile checks public source envelopes with mature JSON/YAML parsers.
// Binary files get bounded magic/version checks only; decompression is not run.
func InspectRuleFile(format string, body []byte) (int, string, error) {
	bad := func() (int, string, error) {
		return 0, "", fmt.Errorf("invalid or excessive %s rule file envelope", format)
	}
	if len(body) == 0 || len(body) > MaxRuleFileBytes {
		return bad()
	}
	switch format {
	case "sing-box-source":
		if !boundedJSON(body) {
			return bad()
		}
		var v struct {
			Version int               `json:"version"`
			Rules   []json.RawMessage `json:"rules"`
		}
		if json.Unmarshal(body, &v) != nil || v.Version < 1 || v.Version > 5 || v.Rules == nil || len(v.Rules) > maxRuleEntries {
			return bad()
		}
		for _, r := range v.Rules {
			var object map[string]json.RawMessage
			if json.Unmarshal(r, &object) != nil || object == nil {
				return bad()
			}
		}
		return v.Version, "bounded-json-envelope", nil
	case "mihomo-yaml":
		var doc yaml.Node
		decoder := yaml.NewDecoder(bytes.NewReader(body))
		if decoder.Decode(&doc) != nil || !boundedYAML(&doc, 0, new(int)) {
			return bad()
		}
		var extra yaml.Node
		if decoder.Decode(&extra) != io.EOF {
			return bad()
		}
		var v struct {
			Payload []string `yaml:"payload"`
		}
		if doc.Decode(&v) != nil || v.Payload == nil || len(v.Payload) > maxRuleEntries {
			return bad()
		}
		return 0, "bounded-yaml-envelope", nil
	case "mihomo-text":
		if !utf8.Valid(body) || bytes.IndexByte(body, 0) >= 0 || bytes.Count(body, []byte("\n")) > maxRuleEntries {
			return bad()
		}
		if strings.HasPrefix(strings.TrimSpace(string(body)), "<") {
			return bad()
		}
		return 0, "bounded-utf8-text", nil
	case "srs":
		if len(body) < 5 || string(body[:3]) != "SRS" || body[3] < 1 || body[3] > 5 {
			return bad()
		}
		return int(body[3]), "opaque-srs-header-and-sha256", nil
	case "mrs":
		if len(body) < 5 || !bytes.Equal(body[:4], []byte{0x28, 0xb5, 0x2f, 0xfd}) {
			return bad()
		}
		return 0, "opaque-mrs-frame-header-and-sha256", nil
	default:
		return bad()
	}
}

func boundedJSON(body []byte) bool {
	d := json.NewDecoder(bytes.NewReader(body))
	depth, n := 0, 0
	for {
		tok, err := d.Token()
		if err == io.EOF {
			return depth == 0
		}
		if err != nil {
			return false
		}
		n++
		if n > 400000 {
			return false
		}
		if delim, ok := tok.(json.Delim); ok {
			switch delim {
			case '{', '[':
				depth++
				if depth > 64 {
					return false
				}
			case '}', ']':
				depth--
			}
		}
	}
}
func boundedYAML(n *yaml.Node, depth int, count *int) bool {
	*count++
	if depth > 64 || *count > 400000 || n.Kind == yaml.AliasNode || n.Anchor != "" {
		return false
	}
	for _, child := range n.Content {
		if !boundedYAML(child, depth+1, count) {
			return false
		}
	}
	return true
}

// FetchRuleFile accepts only bytes returned by the same bounded, SSRF-pinned
// fetcher used for subscription imports. A supplied digest is a mandatory pin.
func (f *Fetcher) FetchRuleFile(ctx context.Context, url string, request domain.RuleResource) (RuleFile, error) {
	fetched, err := f.Fetch(ctx, url)
	if err != nil {
		return RuleFile{}, err
	}
	return AcceptRuleFile(request, fetched.Body)
}
