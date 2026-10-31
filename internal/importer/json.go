package importer

import (
	"bytes"
	"encoding/json"
	"io"
)

// JSON permits duplicate member spelling syntactically but import semantics
// must not depend on which parser wins. Reject duplicates and excessive depth.
func validateJSON(data []byte) error {
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	var value func(int) error
	value = func(depth int) error {
		if depth > 64 {
			return ErrInput
		}
		token, err := d.Token()
		if err != nil {
			return ErrInput
		}
		delim, ok := token.(json.Delim)
		if !ok {
			return nil
		}
		switch delim {
		case '{':
			seen := map[string]bool{}
			for d.More() {
				key, err := d.Token()
				if err != nil {
					return ErrInput
				}
				name, ok := key.(string)
				if !ok || seen[name] {
					return ErrInput
				}
				seen[name] = true
				if err = value(depth + 1); err != nil {
					return err
				}
			}
			token, err = d.Token()
			if err != nil || token != json.Delim('}') {
				return ErrInput
			}
		case '[':
			for d.More() {
				if err = value(depth + 1); err != nil {
					return err
				}
			}
			token, err = d.Token()
			if err != nil || token != json.Delim(']') {
				return ErrInput
			}
		default:
			return ErrInput
		}
		return nil
	}
	if err := value(0); err != nil {
		return err
	}
	if _, err := d.Token(); err != io.EOF {
		return ErrInput
	}
	return nil
}
