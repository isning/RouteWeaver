package store

import "encoding/json"

// Unknown non-advisory actions are also protected from an older reader that
// ignores provider admission entirely. Domain validation still controls which
// policies this binary can activate; this function is only the downgrade fence.
func providerRecordNeedsFence(kind string, raw json.RawMessage) (bool, error) {
	if kind != "node-observability" {
		return false, nil
	}
	var state struct {
		Config struct {
			Provider *struct {
				ExhaustionAction string `json:"exhaustionAction"`
			} `json:"provider"`
		} `json:"config"`
	}
	if err := json.Unmarshal(raw, &state); err != nil {
		return false, err
	}
	return state.Config.Provider != nil && state.Config.Provider.ExhaustionAction != "" && state.Config.Provider.ExhaustionAction != "advisory", nil
}
