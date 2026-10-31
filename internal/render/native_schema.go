package render

import (
	"embed"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

//go:embed schemas/*.json
var nativeSchemas embed.FS

// Deny all external schema resolution, including filesystem URLs. Only trusted
// embedded schemas are compiled; user $ref/$schema fields are inert instance data.
type noNativeSchemaLoad struct{}

func (noNativeSchemaLoad) Load(string) (any, error) {
	return nil, fmt.Errorf("external schema loading is disabled")
}

var schemasOnce sync.Once
var compiledNativeSchemas map[string]*jsonschema.Schema
var nativeSchemaError error

func nativeSchema(name string) (*jsonschema.Schema, error) {
	schemasOnce.Do(func() {
		compiledNativeSchemas = map[string]*jsonschema.Schema{}
		for _, name := range []string{"mihomo-1.19.32-override.json", "sing-box-1.14.3.json"} {
			data, err := nativeSchemas.ReadFile("schemas/" + name)
			if err != nil {
				nativeSchemaError = err
				return
			}
			document, err := jsonschema.UnmarshalJSON(strings.NewReader(string(data)))
			if err != nil {
				nativeSchemaError = err
				return
			}
			compiler := jsonschema.NewCompiler()
			compiler.UseLoader(noNativeSchemaLoad{})
			uri := "https://routeweaver.invalid/schemas/" + name
			if err = compiler.AddResource(uri, document); err != nil {
				nativeSchemaError = err
				return
			}
			compiledNativeSchemas[name], err = compiler.Compile(uri)
			if err != nil {
				nativeSchemaError = err
				return
			}
		}
	})
	return compiledNativeSchemas[name], nativeSchemaError
}
func validateMihomoPatch(patch map[string]any) error {
	return validateNativeSchema("mihomo-1.19.32-override.json", patch)
}
func validateSingBoxNative(final map[string]any) error {
	return validateNativeSchema("sing-box-1.14.3.json", final)
}
func validateNativeSchema(name string, document map[string]any) error {
	schema, err := nativeSchema(name)
	if err != nil {
		return nativeError("SCHEMA_UNAVAILABLE", "/nativeOverride", "embedded schema could not be compiled")
	}
	if err = schema.Validate(document); err != nil {
		path := "/nativeOverride/content"
		if issue, ok := err.(*jsonschema.ValidationError); ok {
			for len(issue.Causes) > 0 {
				issue = issue.Causes[0]
			}
			if len(issue.InstanceLocation) > 0 {
				path = ""
				var node any = document
				for _, part := range issue.InstanceLocation {
					label := safeField(part)
					switch current := node.(type) {
					case map[string]any:
						node = current[part]
					case []any:
						if index, err := strconv.Atoi(part); err == nil && index >= 0 && index < len(current) {
							label = strconv.Itoa(index)
							node = current[index]
						} else {
							node = nil
						}
					default:
						node = nil
					}
					path += "/" + label
				}
			}
		}
		return nativeError("SCHEMA", path, "value or field is not supported by the selected target schema")
	}
	return nil
}

// Field labels are trusted schema identifiers, not arbitrary user object keys.
// This also keeps error and change-report paths useful without echoing secrets.
var knownNativeFields = sync.OnceValue(func() map[string]bool {
	fields := map[string]bool{"proxies": true, "rule-providers": true, "proxy-providers": true, "nativeOverride": true, "content": true, "target": true}
	var walk func(any)
	walk = func(value any) {
		switch v := value.(type) {
		case map[string]any:
			if properties, ok := v["properties"].(map[string]any); ok {
				for key := range properties {
					fields[key] = true
				}
			}
			for _, child := range v {
				walk(child)
			}
		case []any:
			for _, child := range v {
				walk(child)
			}
		}
	}
	for _, name := range []string{"mihomo-1.19.32-override.json", "sing-box-1.14.3.json"} {
		data, _ := nativeSchemas.ReadFile("schemas/" + name)
		var schema any
		if json.Unmarshal(data, &schema) == nil {
			walk(schema)
		}
	}
	return fields
})
