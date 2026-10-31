package managedxray

import (
	"encoding/json"
	"routeweaver/internal/entrypolicy"
	"testing"
)

func TestDiagnosticMappingRequiresUniqueGeneratedPrincipalPrefix(t *testing.T) {
	principal := map[string]any{"type": "field", "inboundTag": []string{"in"}, "user": []string{"subject"}, "outboundTag": "connector"}
	generic := map[string]any{"type": "field", "network": "tcp", "outboundTag": "direct"}
	descriptor := entrypolicy.Descriptor{Bindings: []entrypolicy.Binding{{SubjectID: "subject", RouteID: "route", EntryID: "entry", InboundTag: "in"}}}
	for _, test := range []struct {
		name      string
		rules     []any
		outbounds []any
		want      bool
	}{
		{"unique", []any{principal, generic}, []any{map[string]string{"tag": "connector"}, map[string]string{"tag": "direct"}}, true},
		{"principal after generic cannot define route", []any{generic, principal}, []any{map[string]string{"tag": "connector"}}, false},
		{"duplicate principal", []any{principal, principal, generic}, []any{map[string]string{"tag": "connector"}}, false},
		{"missing connector never default", []any{principal, generic}, []any{map[string]string{"tag": "direct"}}, false},
		{"duplicate outbound", []any{principal}, []any{map[string]string{"tag": "connector"}, map[string]string{"tag": "connector"}}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			native, _ := json.Marshal(map[string]any{"outbounds": test.outbounds, "routing": map[string]any{"rules": test.rules}})
			m := diagnosticRouteMap(native, descriptor)
			_, got := m["route"]
			if got != test.want {
				t.Fatalf("mapping=%+v", m)
			}
		})
	}
}
