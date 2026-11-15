package render

import (
	"encoding/json"
	"io"
	"reflect"
	"strings"

	"routeweaver/internal/domain"
)

// RenderBudgetError means background work was declined, not that the user's
// configuration is invalid. It never includes private input values.
type RenderBudgetError struct{ Stage string }

func (e *RenderBudgetError) Error() string { return "background render budget exceeded: " + e.Stage }

// Limits are per phase, not caller-configurable. No budget state is shared.
const (
	boundedTreeNodes       = 4096
	boundedTreeDepth       = 16
	boundedStringBytes     = 4096
	boundedTreeStringBytes = 16384
	boundedArtifactBytes   = 128 << 10
	boundedNativeBytes     = 4096
	boundedNativeDepth     = 8
	boundedNativeTokens    = 256
)

type renderBudget struct{}

// RenderBounded is an opt-in, conservative background contract for the audited
// built-in adapters only. It performs no I/O. It is not a wall-clock deadline;
// fixed schemas process bounded trees. Explicit Render keeps its existing limits.
// HTTP callers must separately bound materialization and stored-input reads.
func (r *ClientRegistry) RenderBounded(p domain.ClientProfileIR, target Target, mode OutputMode) (ClientResult, error) {
	b := &renderBudget{}
	switch r.adapters[target.AdapterID].(type) {
	case MihomoClient, SingBoxClient:
	default:
		return ClientResult{}, &RenderBudgetError{Stage: "adapter"}
	}
	if len(p.Endpoints) > 32 || len(p.Groups) > 8 || len(p.Rules) > 32 || len(p.Resources) > 8 || len(p.NameAllocations) > 64 {
		return ClientResult{}, &RenderBudgetError{Stage: "input"}
	}
	// Walk without serializing/copying unbounded input. This includes nested match
	// expressions, group members, runtime values and retained name allocations.
	if err := b.tree(p, "input"); err != nil {
		return ClientResult{}, err
	}
	if p.NativeOverride != nil {
		if err := b.native(p.NativeOverride); err != nil {
			return ClientResult{}, err
		}
	}
	return r.render(p, target, mode, b)
}

// A node includes map keys, struct fields and sequence elements; strings are
// bounded individually and in aggregate. Each phase starts its own fixed budget.
// Bounding before marshal also bounds escape expansion (at most six bytes/byte).
func (b *renderBudget) tree(value any, stage string) error {
	if b == nil {
		return nil
	}
	nodes, chars := 0, 0
	var walk func(reflect.Value, int) bool
	walk = func(v reflect.Value, depth int) bool {
		nodes++
		if nodes > boundedTreeNodes || depth > boundedTreeDepth {
			return false
		}
		if !v.IsValid() {
			return true
		}
		switch v.Kind() {
		case reflect.Interface, reflect.Pointer:
			if v.IsNil() {
				return true
			}
			return walk(v.Elem(), depth)
		case reflect.String:
			n := v.Len()
			chars += n
			return n <= boundedStringBytes && chars <= boundedTreeStringBytes
		case reflect.Struct:
			if v.NumField() > boundedTreeNodes-nodes {
				return false
			}
			for i := 0; i < v.NumField(); i++ {
				if !walk(reflect.ValueOf(v.Type().Field(i).Name), depth+1) || !walk(v.Field(i), depth+1) {
					return false
				}
			}
		case reflect.Map:
			if v.Len() > (boundedTreeNodes-nodes)/2 {
				return false
			}
			it := v.MapRange()
			for it.Next() {
				if !walk(it.Key(), depth+1) || !walk(it.Value(), depth+1) {
					return false
				}
			}
		case reflect.Array, reflect.Slice:
			if v.Len() > boundedTreeNodes-nodes {
				return false
			}
			for i := 0; i < v.Len(); i++ {
				if !walk(v.Index(i), depth+1) {
					return false
				}
			}
		case reflect.Bool, reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64, reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Float32, reflect.Float64:
		default:
			return false
		}
		return true
	}
	if !walk(reflect.ValueOf(value), 0) {
		return &RenderBudgetError{Stage: stage}
	}
	return nil
}
func (b *renderBudget) native(o *domain.NativeClientOverride) error {
	if b == nil {
		return nil
	}
	if o.Format != "json" || len(o.Content) > boundedNativeBytes {
		return &RenderBudgetError{Stage: "native-input"}
	}
	d := json.NewDecoder(strings.NewReader(o.Content))
	d.UseNumber()
	depth, tokens := 0, 0
	for {
		token, err := d.Token()
		if err == io.EOF {
			if tokens > 0 && depth == 0 {
				return nil
			}
			break
		}
		if err != nil {
			break
		}
		tokens++
		if tokens > boundedNativeTokens {
			break
		}
		if tokens == 1 && token != json.Delim('{') {
			break
		}
		if delim, ok := token.(json.Delim); ok {
			if delim == '{' || delim == '[' {
				depth++
				if depth > boundedNativeDepth {
					break
				}
			} else {
				depth--
				if depth == 0 {
					if _, err = d.Token(); err == io.EOF {
						return nil
					}
					break
				}
			}
		}
	}
	return &RenderBudgetError{Stage: "native-input"}
}
func (b *renderBudget) artifact(content string, stage string) error {
	if b != nil && len(content) > boundedArtifactBytes {
		return &RenderBudgetError{Stage: stage}
	}
	return nil
}
