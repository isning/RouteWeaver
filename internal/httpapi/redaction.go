package httpapi

import (
	"encoding/json"
	"net/url"
	"regexp"
	"routeweaver/internal/domain"
	"strings"
)

var credentialUUID = regexp.MustCompile(`(?i)^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)

func redactArtifact(content string) string {
	var tree any
	if json.Unmarshal([]byte(content), &tree) != nil {
		return "[preview redaction unavailable]"
	}
	redactTree(tree)
	b, e := json.MarshalIndent(tree, "", "  ")
	if e != nil {
		return "[preview redaction unavailable]"
	}
	return string(b)
}
func redactTree(tree any) {
	switch v := tree.(type) {
	case map[string]any:
		for k, value := range v {
			key := strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(k, "_", ""), "-", ""))
			secret := key == "password" || key == "pass" || key == "user" || key == "passwd" || key == "username" || key == "uuid" || key == "privatekey" || key == "shortid" || key == "shortids" || key == "headers"
			if key == "id" {
				s, _ := value.(string)
				secret = credentialUUID.MatchString(s)
			}
			if secret {
				switch value.(type) {
				case []any:
					v[k] = []any{"[REDACTED]"}
				default:
					v[k] = "[REDACTED]"
				}
				continue
			}
			if text, ok := value.(string); ok {
				v[k] = redactURL(text)
			} else {
				redactTree(value)
			}
		}
	case []any:
		for i, x := range v {
			if text, ok := x.(string); ok {
				v[i] = redactURL(text)
			} else {
				redactTree(x)
			}
		}
	}
}
func redactEndpoint(e domain.ClientEndpoint) domain.ClientEndpoint {
	b, _ := json.Marshal(e)
	var out domain.ClientEndpoint
	json.Unmarshal(b, &out)
	out.Connection.Username = ""
	out.Connection.Password = ""
	out.Connection.UUID = ""
	if out.Connection.Transport != nil {
		out.Connection.Transport.Headers = nil
	}
	if out.Connection.TLS != nil && out.Connection.TLS.Reality != nil {
		out.Connection.TLS.Reality.ShortID = ""
	}
	return out
}
func redactTenantRecord(kind string, raw json.RawMessage) json.RawMessage {
	switch kind {
	case "resources":
		var v ownedRuleResource
		if json.Unmarshal(raw, &v) != nil {
			return json.RawMessage(`{}`)
		}
		v.URL = redactURL(v.URL)
		b, _ := json.Marshal(resourceMetadata(v))
		return b
	case "sources":
		var v Source
		if json.Unmarshal(raw, &v) != nil {
			return raw
		}
		v = sourceView(v, false)
		b, _ := json.Marshal(v)
		return b
	case "profiles":
		var v Profile
		if json.Unmarshal(raw, &v) != nil {
			return raw
		}
		if v.IR.NativeOverride != nil {
			v.IR.NativeOverride.Content = ""
		}
		for i := range v.IR.Endpoints {
			v.IR.Endpoints[i] = redactEndpoint(v.IR.Endpoints[i])
		}
		b, _ := json.Marshal(v)
		return b
	}
	return raw
}

// Native DNS/health-check URLs can carry credentials outside named secret keys.
// This edits only preview copies, never the renderer artifact or stored intent.
func redactURL(text string) string {
	if !strings.Contains(text, "://") && !strings.HasPrefix(text, "/") {
		return text
	}
	u, err := url.Parse(text)
	if err != nil {
		return text
	}
	if u.User == nil && u.RawQuery == "" && u.Fragment == "" {
		return text
	}
	if u.User != nil {
		u.User = url.User("[REDACTED]")
	}
	if u.RawQuery != "" {
		u.RawQuery = "[REDACTED]"
	}
	if u.Fragment != "" {
		u.Fragment = "[REDACTED]"
	}
	return u.String()
}
