package httpapi

import (
	"encoding/json"
	"fmt"
	"routeweaver/internal/domain"
	"routeweaver/internal/resources"
	"routeweaver/internal/store"
	"strings"
	"testing"
)

type resourceBudgetReader map[string]any

func (r resourceBudgetReader) TenantGet(owner, kind, id string, out any) error {
	v, ok := r[owner+"/"+kind+"/"+id]
	if !ok {
		return store.ErrNotFound
	}
	b, e := json.Marshal(v)
	if e != nil {
		return e
	}
	return json.Unmarshal(b, out)
}
func resourceBudgetFixture(t *testing.T, format string, body []byte) (Profile, resourceBudgetReader, resources.RuleFile) {
	t.Helper()
	f, e := resources.AcceptRuleFile(domain.RuleResource{ID: "rules", OwnerID: "owner", Format: format, Behavior: "domain"}, body)
	if e != nil {
		t.Fatal(e)
	}
	p := Profile{}
	p.IR.Resources = []domain.RuleResource{f.Resource}
	return p, resourceBudgetReader{"owner/resources/rules": ownedRuleResource{RuleResource: f.Resource, RefreshStatus: "accepted"}, "owner/resource-versions/" + f.Resource.AcceptedVersion: f}, f
}
func TestWithinPlatformResourceBudgetAcceptedFormats(t *testing.T) {
	for _, tc := range []struct {
		format string
		body   []byte
	}{{"mihomo-text", []byte("example.com\n")}, {"srs", []byte{'S', 'R', 'S', 1, 0}}, {"mrs", []byte{0x28, 0xb5, 0x2f, 0xfd, 0}}} {
		t.Run(tc.format, func(t *testing.T) {
			p, r, _ := resourceBudgetFixture(t, tc.format, tc.body)
			if !withinPlatformResourceBudget("owner", p, r) {
				t.Fatal("small accepted body rejected")
			}
			if withinPlatformResourceBudget("other", p, r) {
				t.Fatal("other owner")
			}
		})
	}
}
func TestWithinPlatformResourceBudgetRejectsUnsafeInputs(t *testing.T) {
	for _, mode := range []string{"large", "zero", "yaml", "json", "remote", "head-id", "head-owner", "version-key", "file-owner", "file-id", "size", "head-format", "failed", "missing", "many"} {
		t.Run(mode, func(t *testing.T) {
			p, r, f := resourceBudgetFixture(t, "mihomo-text", []byte("example.com\n"))
			h := r["owner/resources/rules"].(ownedRuleResource)
			switch mode {
			case "large":
				f.Body = []byte(strings.Repeat("x", 4097))
				f.Resource.SizeBytes = 4097
			case "zero":
				f.Body = nil
				f.Resource.SizeBytes = 0
			case "yaml":
				f.Resource.Format = "mihomo-yaml"
			case "json":
				f.Resource.Format = "sing-box-source"
			case "remote":
				h.Location = "remote"
			case "head-id":
				h.ID = "other"
			case "head-owner":
				h.OwnerID = "other"
			case "version-key":
				f.Resource.AcceptedVersion = "other"
			case "file-owner":
				f.Resource.OwnerID = "other"
			case "file-id":
				f.Resource.ID = "other"
			case "size":
				f.Resource.SizeBytes++
			case "head-format":
				h.Format = "mihomo-yaml"
				p.IR.Resources[0].UpdatePolicy = "follow"
			case "failed":
				h.RefreshStatus = "failed"
			case "missing":
				delete(r, "owner/resource-versions/"+f.Resource.AcceptedVersion)
				returnCase := withinPlatformResourceBudget("owner", p, r)
				if returnCase {
					t.Fatal("missing accepted")
				}
				return
			case "many":
				for i := 0; i < 4; i++ {
					p.IR.Resources = append(p.IR.Resources, p.IR.Resources[0])
				}
			}
			r["owner/resources/rules"] = h
			r["owner/resource-versions/"+p.IR.Resources[0].AcceptedVersion] = f
			if withinPlatformResourceBudget("owner", p, r) {
				t.Fatal("unsafe admitted", mode)
			}
		})
	}
}
func TestWithinPlatformResourceBudgetPinnedVersusFollow(t *testing.T) {
	p, r, old := resourceBudgetFixture(t, "mihomo-text", []byte("old.example\n"))
	head := old.Resource
	head.Digest = ""
	head.AcceptedVersion = ""
	head.Revision = ""
	head.Path = ""
	head.SizeBytes = 0
	newer, e := resources.AcceptRuleFile(head, []byte("new.example\n"))
	if e != nil {
		t.Fatal(e)
	}
	r["owner/resources/rules"] = ownedRuleResource{RuleResource: newer.Resource, RefreshStatus: "accepted"}
	r["owner/resource-versions/"+newer.Resource.AcceptedVersion] = newer
	if !withinPlatformResourceBudget("owner", p, r) {
		t.Fatal("valid old pinned version rejected")
	}
	p.IR.Resources[0].UpdatePolicy = "follow"
	if !withinPlatformResourceBudget("owner", p, r) {
		t.Fatal("current follow rejected")
	}
	delete(r, "owner/resource-versions/"+old.Resource.AcceptedVersion)
	if !withinPlatformResourceBudget("owner", p, r) {
		t.Fatal("follow wrongly needs old version")
	}
	p.IR.Resources[0].UpdatePolicy = "pinned"
	if withinPlatformResourceBudget("owner", p, r) {
		t.Fatal("missing pin silently followed")
	}
}
func TestWithinPlatformResourceBudgetBoundary(t *testing.T) {
	p, r, f := resourceBudgetFixture(t, "mihomo-text", []byte(strings.Repeat("x", 4096)))
	p.IR.Resources = nil
	for i := 0; i < 4; i++ {
		id := fmt.Sprintf("r%d", i)
		ref := f.Resource
		ref.ID = id
		ref.Digest = ""
		ref.AcceptedVersion = ""
		ref.Revision = ""
		ref.Path = ""
		ref.SizeBytes = 0
		file, e := resources.AcceptRuleFile(ref, f.Body)
		if e != nil {
			t.Fatal(e)
		}
		p.IR.Resources = append(p.IR.Resources, file.Resource)
		r["owner/resources/"+id] = ownedRuleResource{RuleResource: file.Resource}
		r["owner/resource-versions/"+file.Resource.AcceptedVersion] = file
	}
	if !withinPlatformResourceBudget("owner", p, r) {
		t.Fatal("16KiB boundary rejected")
	}
}
