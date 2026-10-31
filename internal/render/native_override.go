package render

import (
	"encoding/json"
	"fmt"
	"io"
	"reflect"
	"sort"
	"strconv"
	"strings"

	jsonpatch "github.com/evanphx/json-patch/v5"
	"gopkg.in/yaml.v3"
	"routeweaver/internal/domain"
)

// NativeOverrideReport describes the actual composed artifact, not execution.
type NativeOverrideReport struct {
	Target        Target   `json:"target"`
	RuleMode      string   `json:"ruleMode"`
	ChangedPaths  []string `json:"changedPaths"`
	ReplacedPaths []string `json:"replacedPaths"`
	Nonportable   bool     `json:"nonportable"`
	Validation    string   `json:"validation"`
}

func applyNativeOverride(p domain.ClientProfileIR, target Target, mode OutputMode, result ClientResult) (ClientResult, error) {
	o := p.NativeOverride
	if o == nil {
		return result, nil
	}
	if err := validateNativeEnvelope(o, target, mode); err != nil {
		return ClientResult{}, err
	}

	patch, err := decodeNative(o)
	if err != nil {
		return ClientResult{}, err
	}
	if len(result.Artifacts) != 1 {
		return ClientResult{}, nativeError("UNSUPPORTED", "/nativeOverride", "adapter must produce one configuration")
	}
	var base map[string]any
	if json.Unmarshal([]byte(result.Artifacts[0].Content), &base) != nil {
		return ClientResult{}, nativeError("UNSUPPORTED", "/nativeOverride", "adapter output must be JSON")
	}
	report := &NativeOverrideReport{Target: target, RuleMode: o.RuleMode, Nonportable: true, ChangedPaths: []string{}, ReplacedPaths: []string{}, Validation: "bounded-schema-and-references"}
	if err = validateNativeScope(target, patch); err != nil {
		return ClientResult{}, err
	}
	if target.AdapterID == "mihomo" {
		if err = validateMihomoPatch(patch); err != nil {
			return ClientResult{}, err
		}
	}
	changedNativePaths(base, patch, "", report)
	if err = composeNativePolicy(p, target, base, patch, o.RuleMode); err != nil {
		return ClientResult{}, err
	}
	original, _ := json.Marshal(base)
	patchJSON, _ := json.Marshal(patch)
	merged, err := jsonpatch.MergePatch(original, patchJSON)
	if err != nil {
		return ClientResult{}, nativeError("MERGE", "/nativeOverride/content", "invalid object merge")
	}
	var final map[string]any
	if json.Unmarshal(merged, &final) != nil {
		return ClientResult{}, nativeError("MERGE", "/nativeOverride/content", "invalid merged configuration")
	}
	if target.AdapterID == "mihomo" {
		if err = validateMihomoNativeDNS(final, p.Resources); err != nil {
			return ClientResult{}, err
		}
	}
	if target.AdapterID == "sing-box" {
		if err = validateSingBoxNative(final); err != nil {
			return ClientResult{}, err
		}
		report.Validation = "upstream-json-schema-and-references"
	}
	encoded, _ := json.MarshalIndent(final, "", "  ")
	result.Artifacts[0].Content = string(encoded) + "\n"
	kept := report.ReplacedPaths[:0]
	for _, path := range report.ReplacedPaths {
		if path == "/proxy-groups" || path == "/outbounds" || (target.AdapterID == "sing-box" && path == "/dns/servers") {
			continue
		}
		if (path == "/rules" || path == "/route/rules") && o.RuleMode != "replace" {
			continue
		}
		kept = append(kept, path)
	}
	report.ReplacedPaths = kept
	sort.Strings(report.ChangedPaths)
	sort.Strings(report.ReplacedPaths)
	result.NativeOverride = report
	// A native merge can replace/extend group semantics. Portable capture is not
	// evidence about the final overridden artifact, even for a runtime-only patch.
	result.Semantics = nil
	return result, nil
}

func nativeError(code, path, message string) error {
	return fmt.Errorf("NATIVE_%s: %s: %s", code, path, message)
}

// Parsing is bounded data-only. YAML aliases/anchors/custom tags, duplicate
// keys, multi-documents and non-JSON map keys are intentionally unsupported.
func decodeNative(o *domain.NativeClientOverride) (map[string]any, error) {
	if len(o.Content) > 256*1024 {
		return nil, nativeError("SIZE", "/nativeOverride/content", "maximum size is 256 KiB")
	}
	if o.Format != "json" && o.Format != "yaml" {
		return nil, nativeError("FORMAT", "/nativeOverride/format", "select JSON or YAML")
	}
	if o.Format == "json" && !json.Valid([]byte(o.Content)) {
		return nil, nativeError("SYNTAX", "/nativeOverride/content", "invalid JSON")
	}
	decoder := yaml.NewDecoder(strings.NewReader(o.Content))
	var node yaml.Node
	if decoder.Decode(&node) != nil {
		return nil, nativeError("SYNTAX", "/nativeOverride/content", "invalid YAML/JSON syntax")
	}
	count := 0
	var inspect func(*yaml.Node, int) error
	inspect = func(n *yaml.Node, depth int) error {
		count++
		if depth > 40 || count > 20000 {
			return nativeError("SIZE", "/nativeOverride/content", "document is too complex")
		}
		if n.Kind == yaml.AliasNode || n.Anchor != "" || (n.Tag != "" && !has([]string{"!!map", "!!seq", "!!str", "!!int", "!!float", "!!bool", "!!null"}, n.Tag)) {
			return nativeError("SYNTAX", "/nativeOverride/content", "aliases, anchors and custom tags are not supported")
		}
		for _, c := range n.Content {
			if err := inspect(c, depth+1); err != nil {
				return err
			}
		}
		return nil
	}
	if err := inspect(&node, 0); err != nil {
		return nil, err
	}
	var extra yaml.Node
	if decoder.Decode(&extra) != io.EOF {
		return nil, nativeError("SYNTAX", "/nativeOverride/content", "exactly one document is required")
	}
	var tree map[string]any
	if node.Decode(&tree) != nil || tree == nil {
		return nil, nativeError("SYNTAX", "/nativeOverride/content", "root must be an object with unique string keys")
	}
	raw, err := json.Marshal(tree)
	if err != nil {
		return nil, nativeError("SYNTAX", "/nativeOverride/content", "only JSON-compatible values are supported")
	}
	if json.Unmarshal(raw, &tree) != nil {
		return nil, nativeError("SYNTAX", "/nativeOverride/content", "invalid values")
	}
	return tree, nil
}

func changedNativePaths(base, patch map[string]any, path string, report *NativeOverrideReport) {
	for key, value := range patch {
		child := path + "/" + safeField(key)
		before, exists := base[key]
		if m, ok := value.(map[string]any); ok {
			prior, _ := before.(map[string]any)
			changedNativePaths(prior, m, child, report)
		} else if !reflect.DeepEqual(before, value) {
			report.ChangedPaths = append(report.ChangedPaths, child)
			if exists {
				report.ReplacedPaths = append(report.ReplacedPaths, child)
			}
		}
	}
}

func validateNativeScope(target Target, patch map[string]any) error {
	var allowed []string
	switch target.AdapterID {
	case "mihomo":
		allowed = []string{"dns", "sniffer", "tun", "profile", "ipv6", "unified-delay", "tcp-concurrent", "keep-alive-interval", "keep-alive-idle", "find-process-mode", "log-level", "rules", "proxy-groups"}
	case "sing-box":
		allowed = []string{"log", "dns", "route", "experimental", "outbounds"}
	default:
		return nativeError("UNSUPPORTED", "/nativeOverride/target", "adapter does not declare native editing")
	}
	for key := range patch {
		if !has(allowed, key) {
			return nativeError("PROTECTED_FIELD", "/"+safeField(key), "unknown or managed field; use structured profile settings")
		}
	}
	if target.AdapterID == "sing-box" {
		if route, ok := patch["route"].(map[string]any); ok {
			for _, key := range []string{"rule_set", "final"} {
				if _, exists := route[key]; exists {
					return nativeError("PROTECTED_FIELD", "/route/"+key, "managed references must be changed in structured settings")
				}
			}
		}
		if experimental, ok := patch["experimental"].(map[string]any); ok {
			for key := range experimental {
				if key != "cache_file" {
					return nativeError("PROTECTED_FIELD", "/experimental/"+safeField(key), "only client cache options are editable")
				}
			}
		}
	}
	var walk func(any, string) error
	walk = func(tree any, path string) error {
		switch v := tree.(type) {
		case nil:
			return nativeError("DELETE_CONFLICT", path, "null deletion is not supported; remove the override field to use generated settings")
		case map[string]any:
			for key, value := range v {
				lower := strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(key, "_", ""), "-", ""))
				if has([]string{"password", "passwd", "username", "uuid", "privatekey", "secret", "token", "authorization", "headers", "httpheaders", "clientsecret", "accesskey", "key", "keypath", "clientkey", "clientkeypath", "clientcertificate", "clientcertificatepath"}, lower) {
					return nativeError("CREDENTIAL_FIELD", path+"/"+safeField(key), "native extensions cannot introduce credentials or authentication headers")
				}
				if err := walk(value, path+"/"+safeField(key)); err != nil {
					return err
				}
			}
		case []any:
			for i, item := range v {
				if err := walk(item, path+"/"+strconv.Itoa(i)); err != nil {
					return err
				}
			}
		}
		return nil
	}
	return walk(patch, "")
}

// Unknown map keys may contain user data. Error paths report known identifiers
// only; never include arbitrary user key/value text in diagnostics.
func safeField(key string) string {
	if knownNativeFields()[key] {
		return key
	}
	return "[field]"
}

func validateNativeEnvelope(o *domain.NativeClientOverride, target Target, mode OutputMode) error {
	if o.SchemaVersion != "1" || o.Namespace != "routeweaver/native-client" {
		return nativeError("ENVELOPE", "/nativeOverride", "unsupported namespace or schema version")
	}
	if o.Target.AdapterID != target.AdapterID || o.Target.Version != target.Version {
		return nativeError("TARGET_MISMATCH", "/nativeOverride/target", "remove or explicitly retarget native edits before changing client/version")
	}
	if mode != FullConfig {
		return nativeError("MODE_CONFLICT", "/nativeOverride", "native edits require full configuration; remove them explicitly for nodes-only")
	}
	if o.RuleMode != "prepend" && o.RuleMode != "append" && o.RuleMode != "replace" {
		return nativeError("RULE_MODE", "/nativeOverride/ruleMode", "select prepend, append or replace")
	}
	return nil
}

type NativeCapability struct {
	SchemaVersion string   `json:"schemaVersion"`
	Namespace     string   `json:"namespace"`
	Formats       []string `json:"formats"`
	RuleModes     []string `json:"ruleModes"`
	Scope         string   `json:"scope"`
	Validation    string   `json:"validation"`
}

func nativeCapability(validation string) *NativeCapability {
	return &NativeCapability{SchemaVersion: "1", Namespace: "routeweaver/native-client", Formats: []string{"json", "yaml"}, RuleModes: []string{"prepend", "append", "replace"}, Scope: "full", Validation: validation}
}
