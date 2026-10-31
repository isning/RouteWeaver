package agent

import (
	"encoding/json"
	"errors"
	"io"
	"strings"
)

// Inspect actual properties, not credential substrings. Token scanning preserves
// duplicate members: upstream Go structs may merge repeated nested objects, so
// decoding into a map and inspecting only its final value would be unsafe.
func rejectNativeMPTCP(d Desired) error {
	if d.AdapterID != "routeweaver/xray" && d.AdapterID != "routeweaver/sing-box" && d.AdapterID != "routeweaver/managed-xray" {
		return nil
	}
	for _, artifact := range d.Artifacts {
		if artifact.Path != d.EntryFile {
			continue
		}
		decoder := json.NewDecoder(strings.NewReader(artifact.Content))
		decoder.UseNumber()
		if err := scanNativeTCPValue(decoder, "", 0); err != nil {
			return err
		}
		if _, err := decoder.Token(); err != io.EOF {
			return errors.New("trailing native JSON")
		}
		return nil
	}
	return errors.New("native entry artifact missing")
}

func scanNativeTCPValue(decoder *json.Decoder, key string, depth int) error {
	// Match encoding/json's maximum nesting depth without an unbounded recursive
	// walk when token decoding is used instead of Decode into a complete value.
	if depth > 10000 {
		return errors.New("native JSON nesting exceeds limit")
	}
	token, err := decoder.Token()
	if err != nil {
		return errors.New("invalid native JSON")
	}
	if enabled, ok := token.(bool); ok && enabled && (strings.EqualFold(key, "tcpMptcp") || strings.EqualFold(key, "tcp_multi_path")) {
		return errors.New("explicit MPTCP is unsupported")
	}
	delimiter, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	switch delimiter {
	case '{':
		for decoder.More() {
			token, err = decoder.Token()
			if err != nil {
				return errors.New("invalid native JSON")
			}
			field, ok := token.(string)
			if !ok {
				return errors.New("invalid native JSON property")
			}
			if err = scanNativeTCPValue(decoder, field, depth+1); err != nil {
				return err
			}
		}
		token, err = decoder.Token()
		if err != nil || token != json.Delim('}') {
			return errors.New("invalid native JSON object")
		}
	case '[':
		for decoder.More() {
			if err = scanNativeTCPValue(decoder, "", depth+1); err != nil {
				return err
			}
		}
		token, err = decoder.Token()
		if err != nil || token != json.Delim(']') {
			return errors.New("invalid native JSON array")
		}
	default:
		return errors.New("invalid native JSON delimiter")
	}
	return nil
}
