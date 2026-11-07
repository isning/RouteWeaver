package importer

import (
	"bytes"
	"encoding/json"
	"io"
	"reflect"
	"strings"
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

// The connection DTOs use named JSON fields without embedded structs. Go's
// decoder also accepts case-folded spellings, which must not let two different
// keys overwrite the same typed setting. Map keys remain case-sensitive.
func rejectAliasedJSONFields(data []byte, target reflect.Type) error {
	for target.Kind() == reflect.Pointer {
		target = target.Elem()
	}
	if target.Kind() != reflect.Struct {
		return nil
	}
	var object map[string]json.RawMessage
	if json.Unmarshal(data, &object) != nil {
		return ErrInput
	}
	names := make([]string, target.NumField())
	for i := range names {
		field := target.Field(i)
		name, _, _ := strings.Cut(field.Tag.Get("json"), ",")
		if field.PkgPath != "" || name == "-" {
			continue
		}
		if name == "" {
			name = field.Name
		}
		names[i] = name
	}
	seen := map[int]bool{}
	for key, value := range object {
		matched := -1
		for i, name := range names {
			if name == "" {
				continue
			}
			if key == name {
				matched = i
				break
			}
			if matched < 0 && strings.EqualFold(key, name) {
				matched = i
			}
		}
		if matched < 0 {
			continue // The strict decoder reports unknown connection fields.
		}
		if seen[matched] {
			return ErrInput
		}
		seen[matched] = true
		if err := rejectAliasedJSONFields(value, target.Field(matched).Type); err != nil {
			return err
		}
	}
	return nil
}
