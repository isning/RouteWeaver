package httpapi

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"routeweaver/internal/auth"
	"routeweaver/internal/domain"
	"routeweaver/internal/importer"
	"routeweaver/internal/store"
)

// A source owns at most one candidate. Its private snapshot and exact input
// manifest are encrypted with the source record and never appear in summaries.
// Inputs/Sets are legacy review metadata; current application recomputes its CAS.
// Rejection, another fetch, or an edit replaces that bounded pending state.
type SourceCandidate struct {
	ID          string                   `json:"id"`
	CreatedAt   time.Time                `json:"createdAt"`
	Diff        SourceDiff               `json:"diff"`
	Affected    []SourceImpact           `json:"affected"`
	Diagnostics []importer.Diagnostic    `json:"diagnostics,omitempty"`
	Snapshot    *domain.SourceSnapshot   `json:"snapshot,omitempty"`
	Inputs      []sourceCandidateInput   `json:"inputs,omitempty"`
	Sets        []store.RecordSetCompare `json:"sets,omitempty"`
}
type sourceCandidateInput struct {
	Kind     string          `json:"kind"`
	ID       string          `json:"id"`
	Expected json.RawMessage `json:"expected"`
}
type SourceChange struct {
	BeforeConnection string   `json:"beforeConnection,omitempty"`
	AfterConnection  string   `json:"afterConnection,omitempty"`
	ID               string   `json:"id"`
	Name             string   `json:"name"`
	Fields           []string `json:"fields,omitempty"`
}
type SourceDiff struct {
	Added             []SourceChange `json:"added"`
	Removed           []SourceChange `json:"removed"`
	ConnectionChanged []SourceChange `json:"connectionChanged"`
	Renamed           []SourceChange `json:"renamed"`
	BeforeCount       int            `json:"beforeCount"`
	AfterCount        int            `json:"afterCount"`
	Reordered         bool           `json:"reordered,omitempty"`
}
type SourceImpact struct {
	Kind        string `json:"kind"`
	ID          string `json:"id"`
	Name        string `json:"name"`
	ProfileName string `json:"profileName,omitempty"`
	Reason      string `json:"reason"`
}

func sourceDiff(before, after *domain.SourceSnapshot) SourceDiff {
	diff := SourceDiff{Added: []SourceChange{}, Removed: []SourceChange{}, ConnectionChanged: []SourceChange{}, Renamed: []SourceChange{}}
	redactLabel := sourceLabelRedactor(before, after)
	connectionLabel := func(e domain.ClientEndpoint) string {
		return redactLabel(e.Connection.Protocol + " · " + net.JoinHostPort(e.Connection.Host, strconv.Itoa(e.Connection.Port)))
	}
	old := map[string]domain.ClientEndpoint{}
	next := map[string]domain.ClientEndpoint{}
	if before != nil {
		diff.BeforeCount = len(before.Endpoints)
		for _, e := range before.Endpoints {
			old[e.ID] = e
		}
	}
	if after != nil {
		diff.AfterCount = len(after.Endpoints)
		for _, e := range after.Endpoints {
			next[e.ID] = e
		}
	}
	if after != nil {
		for _, e := range after.Endpoints {
			prior, found := old[e.ID]
			change := SourceChange{ID: e.ID, Name: redactLabel(e.Name), AfterConnection: connectionLabel(e)}
			if !found {
				diff.Added = append(diff.Added, change)
				continue
			}
			if fields := changedConnectionFields(prior.Connection, e.Connection); len(fields) > 0 {
				change.Fields = fields
				change.BeforeConnection = connectionLabel(prior)
				diff.ConnectionChanged = append(diff.ConnectionChanged, change)
			}
			if prior.Name != e.Name {
				diff.Renamed = append(diff.Renamed, SourceChange{ID: e.ID, Name: change.Name, AfterConnection: connectionLabel(e), Fields: []string{"name"}})
			}
		}
	}
	if before != nil {
		for _, e := range before.Endpoints {
			if _, found := next[e.ID]; !found {
				diff.Removed = append(diff.Removed, SourceChange{ID: e.ID, Name: redactLabel(e.Name), BeforeConnection: connectionLabel(e)})
			}
		}
	}
	if before != nil && after != nil && len(diff.Added) == 0 && len(diff.Removed) == 0 {
		for i, e := range before.Endpoints {
			if after.Endpoints[i].ID != e.ID {
				diff.Reordered = true
				break
			}
		}
	}
	return diff
}

// Values are compared privately. Only fixed schema field paths are exposed.
func changedConnectionFields(before, after domain.Connection) []string {
	var left, right map[string]any
	b, _ := json.Marshal(before)
	a, _ := json.Marshal(after)
	json.Unmarshal(b, &left)
	json.Unmarshal(a, &right)
	fields := []string{}
	var walk func(string, map[string]any, map[string]any)
	walk = func(prefix string, l, r map[string]any) {
		keys := map[string]bool{}
		for k := range l {
			keys[k] = true
		}
		for k := range r {
			keys[k] = true
		}
		for k := range keys {
			if reflect.DeepEqual(l[k], r[k]) {
				continue
			}
			name := prefix + k
			lm, lok := l[k].(map[string]any)
			rm, rok := r[k].(map[string]any)
			if lok && rok {
				walk(name+".", lm, rm)
			} else {
				fields = append(fields, name)
			}
		}
	}
	walk("", left, right)
	sort.Strings(fields)
	return fields
}

// Construct one redactor per comparison rather than scanning all credentials
// for every label in a large feed. Longest matches take priority.
func sourceLabelRedactor(snapshots ...*domain.SourceSnapshot) func(string) string {
	secrets := map[string]bool{}
	for _, snapshot := range snapshots {
		if snapshot == nil {
			continue
		}
		for _, e := range snapshot.Endpoints {
			if e.Connection.Transport != nil {
				for _, secret := range e.Connection.Transport.Headers {
					if secret != "" {
						secrets[secret] = true
					}
				}
			}
			for _, secret := range []string{e.Connection.Username, e.Connection.Password, e.Connection.UUID} {
				if secret != "" {
					secrets[secret] = true
				}
			}
			if e.Connection.TLS != nil && e.Connection.TLS.Reality != nil && e.Connection.TLS.Reality.ShortID != "" {
				secrets[e.Connection.TLS.Reality.ShortID] = true
			}
		}
	}
	keys := make([]string, 0, len(secrets))
	for secret := range secrets {
		keys = append(keys, secret)
	}
	sort.Slice(keys, func(i, j int) bool { return len(keys[i]) > len(keys[j]) })
	pairs := make([]string, 0, len(keys)*2)
	for _, secret := range keys {
		pairs = append(pairs, secret, "[REDACTED]")
	}
	redactor := strings.NewReplacer(pairs...)
	return func(label string) string { return redactURL(redactor.Replace(label)) }
}
func sameSourceSnapshot(before, after *domain.SourceSnapshot, diff SourceDiff) bool {
	return before != nil && after != nil && before.SourceName == after.SourceName && len(diff.Added) == 0 && len(diff.Removed) == 0 && len(diff.ConnectionChanged) == 0 && len(diff.Renamed) == 0 && !diff.Reordered
}

func (h *server) sourceDependencies(owner string, inputs *templateInputs, kind string) ([]json.RawMessage, error) {
	raws, err := h.s.TenantList(owner, kind)
	if err != nil {
		return nil, err
	}
	if len(raws) > 2000 {
		return nil, fmt.Errorf("too many dependent records to review this source update")
	}
	set := store.RecordSetCompare{Kind: store.TenantKind(owner, kind), IDs: []string{}}
	for _, raw := range raws {
		var identity struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(raw, &identity) != nil || identity.ID == "" {
			return nil, fmt.Errorf("cannot read source dependencies")
		}
		set.IDs = append(set.IDs, identity.ID)
		inputs.records[set.Kind+"\x00"+identity.ID] = store.RecordCompare{Kind: set.Kind, ID: identity.ID, Expected: raw}
	}
	inputs.sets = append(inputs.sets, set)
	return raws, nil
}

type sourcePreviewReader struct {
	inputs *templateInputs
	source Source
}

func (r sourcePreviewReader) TenantGet(owner, kind, id string, out any) error {
	if owner == r.source.OwnerID && kind == "sources" && id == r.source.ID {
		b, err := json.Marshal(r.source)
		if err != nil {
			return err
		}
		return json.Unmarshal(b, out)
	}
	return r.inputs.TenantGet(owner, kind, id, out)
}
func groupEndpoints(group domain.PolicyGroup, endpoints []domain.ClientEndpoint) []string {
	ids := []string{}
	for _, member := range group.Members {
		ids = append(ids, member.Kind+":"+member.Ref)
	}
	if group.Dynamic != nil {
		for _, e := range endpoints {
			if domain.MatchesEndpoint(e, *group.Dynamic) {
				ids = append(ids, "endpoint:"+e.ID)
			}
		}
	}
	return ids
}
func includesSource(profile Profile, sourceID string, collections map[string]bool) bool {
	if collections[profile.CollectionID] {
		return true
	}
	for _, id := range profile.SourceIDs {
		if id == sourceID {
			return true
		}
	}
	for _, e := range profile.IR.Endpoints {
		for _, ref := range e.Provenance {
			if ref.SourceID == sourceID {
				return true
			}
		}
	}
	return false
}
func (h *server) sourceImpacts(before, after Source, inputs *templateInputs, diff SourceDiff) ([]SourceImpact, bool, error) {
	impacts := []SourceImpact{}
	selectionChanged := false
	collections, err := h.sourceDependencies(after.OwnerID, inputs, "collections")
	if err != nil {
		return nil, false, err
	}
	profiles, err := h.sourceDependencies(after.OwnerID, inputs, "profiles")
	if err != nil {
		return nil, false, err
	}
	outputs, err := h.sourceDependencies(after.OwnerID, inputs, "outputs")
	if err != nil {
		return nil, false, err
	}
	oldReader := sourcePreviewReader{inputs, before}
	newReader := sourcePreviewReader{inputs, after}
	affectedCollections := map[string]bool{}
	changed := map[string]bool{}
	for _, e := range diff.Removed {
		changed[e.ID] = true
	}
	for _, e := range diff.ConnectionChanged {
		changed[e.ID] = true
	}
	for _, raw := range collections {
		var c domain.Collection
		json.Unmarshal(raw, &c)
		relevant := false
		for _, ref := range c.Sources {
			relevant = relevant || ref.SourceID == after.ID
		}
		if !relevant {
			continue
		}
		affectedCollections[c.ID] = true
		oldResult, oldErr := h.resolveCollectionWithReader(after.OwnerID, c, oldReader)
		newResult, newErr := h.resolveCollectionWithReader(after.OwnerID, c, newReader)
		d := sourceDiff(&domain.SourceSnapshot{Endpoints: oldResult.Endpoints}, &domain.SourceSnapshot{Endpoints: newResult.Endpoints})
		if oldErr != nil || newErr != nil || len(d.Added)+len(d.Removed)+len(d.ConnectionChanged)+len(d.Renamed) > 0 || d.Reordered {
			impacts = append(impacts, SourceImpact{Kind: "collection", ID: c.ID, Name: c.Name, Reason: "source-options-changed"})
			selectionChanged = selectionChanged || oldErr != nil || newErr != nil || len(d.Removed) > 0 || len(d.ConnectionChanged) > 0
		}
	}
	affectedProfiles := map[string]bool{}
	for _, raw := range profiles {
		var p Profile
		json.Unmarshal(raw, &p)
		if !includesSource(p, after.ID, affectedCollections) {
			continue
		}
		affectedProfiles[p.ID] = true
		impacts = append(impacts, SourceImpact{Kind: "profile", ID: p.ID, Name: p.Name, Reason: "draft-inputs-changed"})
		var oldP, newP Profile
		json.Unmarshal(raw, &oldP)
		json.Unmarshal(raw, &newP)
		oldErr := h.materializeProfileWithReader(after.OwnerID, &oldP, oldReader)
		newErr := h.materializeProfileWithReader(after.OwnerID, &newP, newReader)
		effectiveChanged := map[string]bool{}
		for id := range changed {
			effectiveChanged[id] = true
		}
		d := sourceDiff(&domain.SourceSnapshot{Endpoints: oldP.IR.Endpoints}, &domain.SourceSnapshot{Endpoints: newP.IR.Endpoints})
		for _, e := range d.Removed {
			effectiveChanged[e.ID] = true
		}
		for _, e := range d.ConnectionChanged {
			effectiveChanged[e.ID] = true
		}
		for _, e := range d.Added {
			effectiveChanged[e.ID] = true
		}
		affectedGroups := map[string]bool{}
		parentGroups := map[string][]string{}
		queue := []string{}
		for _, group := range p.IR.Groups {
			affected := false
			for _, member := range group.Members {
				affected = affected || (member.Kind == "endpoint" && effectiveChanged[member.Ref])
				if member.Kind == "group" {
					parentGroups[member.Ref] = append(parentGroups[member.Ref], group.ID)
				}
			}
			if group.Dynamic != nil {
				affected = affected || oldErr != nil || newErr != nil || !reflect.DeepEqual(groupEndpoints(group, oldP.IR.Endpoints), groupEndpoints(group, newP.IR.Endpoints))
				for _, e := range oldP.IR.Endpoints {
					affected = affected || (effectiveChanged[e.ID] && domain.MatchesEndpoint(e, *group.Dynamic))
				}
			}
			if affected {
				affectedGroups[group.ID] = true
				queue = append(queue, group.ID)
			}
		}
		// Include enclosing groups once, even for invalid draft cycles.
		for len(queue) > 0 {
			child := queue[0]
			queue = queue[1:]
			for _, parent := range parentGroups[child] {
				if !affectedGroups[parent] {
					affectedGroups[parent] = true
					queue = append(queue, parent)
				}
			}
		}
		for _, group := range p.IR.Groups {
			if affectedGroups[group.ID] {
				selectionChanged = true
				impacts = append(impacts, SourceImpact{Kind: "group", ID: group.ID, Name: group.Name, ProfileName: p.Name, Reason: "selected-options-changed"})
			}
		}
		selected := func(a domain.ActionRef) bool {
			return (a.Kind == "endpoint" && effectiveChanged[a.Ref]) || (a.Kind == "group" && affectedGroups[a.Ref])
		}
		if selected(p.IR.DefaultAction) {
			selectionChanged = true
			impacts = append(impacts, SourceImpact{Kind: "default", ID: p.ID, Name: p.Name, Reason: "default-option-changed"})
		}
		for _, rule := range p.IR.Rules {
			if selected(rule.Action) {
				selectionChanged = true
				impacts = append(impacts, SourceImpact{Kind: "rule", ID: rule.ID, Name: p.Name, Reason: "rule-option-changed"})
			}
		}
	}
	for _, raw := range outputs {
		var output Output
		json.Unmarshal(raw, &output)
		if affectedProfiles[output.ProfileID] && output.Status == "published" {
			impacts = append(impacts, SourceImpact{Kind: "subscription", ID: output.ID, Name: output.Name, Reason: "published-unchanged"})
		}
	}
	return impacts, selectionChanged, nil
}

func sameSourceDiagnostics(a, b []importer.Diagnostic) bool {
	return (len(a) == 0 && len(b) == 0) || reflect.DeepEqual(a, b)
}

// Missing modes belong to legacy records and use the automatic default. This
// projection does not apply an already pending candidate on a read.
func sourceApplyMode(mode string) string {
	if mode == "" {
		return "auto"
	}
	return mode
}
func validSourceApplyMode(mode string) bool { return mode == "auto" || mode == "manual" }

// The history is server-owned, bounded and count-only: credentials, endpoint
// labels and full snapshots are never copied into the persistent summary.
func recordSourceApplication(source *Source, snapshot *domain.SourceSnapshot, diagnostics []importer.Diagnostic, diff SourceDiff, now time.Time, mode string) {
	source.Snapshot = snapshot
	source.Diagnostics = diagnostics
	source.UpdatedAt = now
	source.RefreshStatus = "accepted"
	event := SourceApplyEvent{ID: source.Revision, AppliedAt: now, Mode: mode, BeforeCount: diff.BeforeCount, AfterCount: diff.AfterCount, Added: len(diff.Added), Removed: len(diff.Removed), ConnectionChanged: len(diff.ConnectionChanged), Renamed: len(diff.Renamed), Reordered: diff.Reordered}
	history := make([]SourceApplyEvent, 0, 20)
	history = append(history, event)
	remaining := source.ApplyHistory
	if len(remaining) > 19 {
		remaining = remaining[:19]
	}
	source.ApplyHistory = append(history, remaining...)
}

func (h *server) prepareSourceUpdate(before Source, after *Source, inputs *templateInputs) error {
	candidateSnapshot := after.Snapshot
	after.Snapshot = before.Snapshot
	diff := sourceDiff(before.Snapshot, candidateSnapshot)
	if sameSourceSnapshot(before.Snapshot, candidateSnapshot, diff) && sameSourceDiagnostics(before.Diagnostics, after.Diagnostics) {
		after.RefreshStatus = "unchanged"
		return nil
	}
	proposed := *after
	proposed.Snapshot = candidateSnapshot
	impacts, _, err := h.sourceImpacts(before, proposed, inputs, diff)
	if err != nil {
		return err
	}
	// A successful explicit first import is immediately usable in either mode.
	// Later updates obey the selected application policy, not a hidden risk gate.
	if before.Snapshot == nil || sourceApplyMode(after.ApplyMode) == "auto" {
		recordSourceApplication(after, candidateSnapshot, after.Diagnostics, diff, time.Now().UTC(), sourceApplyMode(after.ApplyMode))
		return nil
	}
	token, err := auth.Token()
	if err != nil {
		return err
	}
	candidate := &SourceCandidate{ID: "c_" + token, CreatedAt: time.Now().UTC(), Diff: diff, Affected: impacts, Diagnostics: after.Diagnostics, Snapshot: candidateSnapshot}
	encoded, err := json.Marshal(candidate)
	if err != nil {
		return err
	}
	if len(encoded) > 16<<20 {
		return fmt.Errorf("source update exceeds size limit; reduce dependent configurations before retrying")
	}
	after.Candidate = candidate
	after.Diagnostics = before.Diagnostics
	after.UpdatedAt = before.UpdatedAt
	after.RefreshStatus = "review-required"
	return nil
}

func sourceView(source Source, reveal bool) Source {
	// Copy through JSON so presentation redaction cannot mutate accepted state.
	b, _ := json.Marshal(source)
	var v Source
	json.Unmarshal(b, &v)
	v.ApplyMode = sourceApplyMode(v.ApplyMode)
	// Legacy records may lack a status/code. Only a recognized classification
	// attached to an explicit current failure is public, including owner reveal.
	if v.RefreshStatus != "failed" || v.LastError == "" || !knownSourceFailureCode(v.LastErrorCode) {
		v.LastErrorCode = ""
	}
	if !reveal {
		v.Content = ""
		v.URL = ""
		if v.Snapshot != nil {
			redactLabel := sourceLabelRedactor(v.Snapshot)
			for i := range v.Snapshot.Endpoints {
				v.Snapshot.Endpoints[i] = redactEndpoint(v.Snapshot.Endpoints[i])
				endpoint := &v.Snapshot.Endpoints[i]
				endpoint.Name = redactLabel(endpoint.Name)
				if endpoint.Connection.Transport != nil {
					endpoint.Connection.Transport.Path = redactURL(endpoint.Connection.Transport.Path)
					endpoint.Connection.Transport.ServiceName = redactURL(endpoint.Connection.Transport.ServiceName)
				}
			}
		}
	}
	if v.Candidate != nil {
		v.Candidate.Snapshot = nil
		v.Candidate.Inputs = nil
		v.Candidate.Sets = nil
	}
	return v
}
func (h *server) sourceCandidate(w http.ResponseWriter, r *http.Request) {
	var source Source
	if err := h.s.TenantGet(current(r).Account.ID, "sources", chi.URLParam(r, "id"), &source); err != nil {
		storeError(w, err)
		return
	}
	if source.Candidate == nil {
		fail(w, 404, "no source update is waiting to be applied")
		return
	}
	if strings.HasSuffix(r.URL.Path, "/reveal") {
		writeJSON(w, 200, map[string]any{"candidateId": source.Candidate.ID, "sourceRevision": source.Revision, "snapshot": source.Candidate.Snapshot})
		return
	}
	writeJSON(w, 200, sourceView(source, false))
}
func (h *server) decideSourceCandidate(w http.ResponseWriter, r *http.Request) {
	var decision struct {
		CandidateID    string `json:"candidateId"`
		SourceRevision string `json:"sourceRevision"`
	}
	if !decode(w, r, &decision) {
		return
	}
	owner := current(r).Account.ID
	id := chi.URLParam(r, "id")
	var raw json.RawMessage
	if err := h.s.TenantGet(owner, "sources", id, &raw); err != nil {
		storeError(w, err)
		return
	}
	var source Source
	if json.Unmarshal(raw, &source) != nil {
		fail(w, 500, "cannot read source update")
		return
	}
	if source.Candidate == nil || decision.CandidateID != source.Candidate.ID || decision.SourceRevision == "" || decision.SourceRevision != source.Revision {
		fail(w, 409, "source update changed; refresh before applying it")
		return
	}
	candidate := source.Candidate
	source.ApplyMode = sourceApplyMode(source.ApplyMode)
	if !validSourceApplyMode(source.ApplyMode) {
		fail(w, 400, "source applyMode must be auto or manual")
		return
	}
	inputs := newTemplateInputs(h.s)
	sourceKind := store.TenantKind(owner, "sources")
	inputs.records[sourceKind+"\x00"+id] = store.RecordCompare{Kind: sourceKind, ID: id, Expected: raw}
	applying := strings.HasSuffix(r.URL.Path, "/accept") || strings.HasSuffix(r.URL.Path, "/apply")
	if applying {
		if !source.Enabled {
			fail(w, 409, "source is paused; refresh after enabling it")
			return
		}
		if candidate.Snapshot == nil {
			fail(w, 409, "source update is unavailable; refresh before applying")
			return
		}
		proposed := source
		proposed.Snapshot = candidate.Snapshot
		// Recompute current dependencies rather than requiring the former review's
		// frozen impact list. Source and current dependency reads still commit via
		// one CAS transaction, and no profile or published output is rewritten.
		if _, _, err := h.sourceImpacts(source, proposed, inputs, sourceDiff(source.Snapshot, candidate.Snapshot)); err != nil {
			storeError(w, err)
			return
		}
	}
	revision, err := auth.Token()
	if err != nil {
		storeError(w, err)
		return
	}
	source.Revision = "sr_" + revision
	if applying {
		recordSourceApplication(&source, candidate.Snapshot, candidate.Diagnostics, sourceDiff(source.Snapshot, candidate.Snapshot), time.Now().UTC(), "manual")
		source.LastError = ""
		source.LastErrorCode = ""
	} else {
		source.RefreshStatus = "rejected"
	}
	source.Candidate = nil
	compares, sets := inputs.compares(), inputs.sets
	if err = h.s.CompareSetsAndPutRecords(compares, sets, []store.RecordWrite{{Kind: store.TenantKind(owner, "sources"), ID: id, Value: source}}); err != nil {
		if err == store.ErrConflict {
			fail(w, 409, "source or affected selections changed while applying; refresh and try again")
		} else {
			storeError(w, err)
		}
		return
	}
	writeJSON(w, 200, sourceView(source, false))
}
