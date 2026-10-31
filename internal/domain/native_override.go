package domain

// NativeClientOverride is opaque, owner-private client intent. Only the named
// client renderer interprets Content. It is never a control-plane program,
// resource descriptor, credential source, or portable profile template.
type NativeClientOverride struct {
	SchemaVersion string             `json:"schemaVersion"`
	Namespace     string             `json:"namespace"`
	Target        NativeClientTarget `json:"target"`
	Format        string             `json:"format"`
	RuleMode      string             `json:"ruleMode"`
	Content       string             `json:"content,omitempty"`
}
type NativeClientTarget struct {
	AdapterID string `json:"adapterId"`
	Version   string `json:"version"`
}
