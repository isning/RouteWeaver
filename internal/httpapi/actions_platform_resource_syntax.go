package httpapi

import (
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"unicode"
	"unicode/utf8"
)

// These gates run before the normal accepted-file verifier. They bound work,
// never normalize bytes or replace format/integrity verification.
func smallRuleJSON(body []byte) bool {
	if len(body) == 0 || len(body) > 4096 || !utf8.Valid(body) {
		return false
	}
	d := json.NewDecoder(bytes.NewReader(body))
	d.UseNumber()
	tokens := 0
	var value func(int) bool
	value = func(depth int) bool {
		tok, e := d.Token()
		if e != nil {
			return false
		}
		tokens++
		if tokens > 256 {
			return false
		}
		delim, compound := tok.(json.Delim)
		if !compound {
			return true
		}
		if (delim != '{' && delim != '[') || depth >= 8 {
			return false
		}
		seen := map[string]bool{}
		for d.More() {
			if delim == '{' {
				key, e := d.Token()
				tokens++
				if e != nil || tokens > 256 {
					return false
				}
				s, ok := key.(string)
				if !ok || seen[s] {
					return false
				}
				seen[s] = true
			}
			if !value(depth + 1) {
				return false
			}
		}
		end, e := d.Token()
		tokens++
		return e == nil && tokens <= 256 && ((delim == '{' && end == json.Delim('}')) || (delim == '[' && end == json.Delim(']')))
	}
	// Root must be an object; Token recursion above handles nested values only.
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 || trimmed[0] != '{' || !value(0) {
		return false
	}
	_, e := d.Token()
	return e == io.EOF
}

// Deliberately a flat YAML subset, not a general YAML lexer. The parser sees
// only a fixed mapping key and bounded single-line scalar list, so aliases,
// tags, implicit collections and recursive structures cannot reach it.
func smallRuleYAML(body []byte) bool {
	if len(body) == 0 || len(body) > 4096 || !utf8.Valid(body) {
		return false
	}
	text := strings.ReplaceAll(string(body), "\r\n", "\n")
	if strings.ContainsAny(text, "\r\t") {
		return false
	}
	lines := strings.Split(strings.TrimSuffix(text, "\n"), "\n")
	if len(lines) < 2 || len(lines) > 65 || lines[0] != "payload:" {
		return false
	}
	for _, line := range lines[1:] {
		if !strings.HasPrefix(line, "  - ") {
			return false
		}
		raw := line[4:]
		if len(raw) == 0 {
			return false
		}
		if raw[0] != '"' {
			return false
		}
		var scalar string
		if json.Unmarshal([]byte(raw), &scalar) != nil || len(scalar) > 256 || !utf8.ValidString(scalar) {
			return false
		}
		for _, c := range scalar {
			if unicode.IsControl(c) || c == '\u2028' || c == '\u2029' {
				return false
			}
		}
	}
	return true
}
