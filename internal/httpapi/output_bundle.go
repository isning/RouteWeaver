package httpapi

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"routeweaver/internal/auth"
	"routeweaver/internal/domain"
	"routeweaver/internal/resources"
)

func (h *server) outputBundle(w http.ResponseWriter, r *http.Request) {
	owner := current(r).Account.ID
	var output Output
	if err := h.s.TenantGet(owner, "outputs", chi.URLParam(r, "id"), &output); err != nil {
		storeError(w, err)
		return
	}
	h.deliverOutputBundle(w, r, owner, output)
}
func (h *server) feedBundle(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	if len(token) != 43 {
		fail(w, 404, "subscription unavailable")
		return
	}
	digest := auth.Digest(token)
	ref, err := h.s.LookupToken("feeds", digest)
	parts := strings.SplitN(ref, "/", 2)
	if err != nil || len(parts) != 2 {
		fail(w, 404, "subscription unavailable")
		return
	}
	var output Output
	if h.s.TenantGet(parts[0], "outputs", parts[1], &output) != nil || output.TokenDigest != digest {
		fail(w, 404, "subscription unavailable")
		return
	}
	h.deliverOutputBundle(w, r, parts[0], output)
}
func (h *server) deliverOutputBundle(w http.ResponseWriter, r *http.Request, owner string, output Output) {
	if output.Status != "published" || len(output.Artifacts) != 1 {
		fail(w, 404, "subscription unavailable")
		return
	}
	if _, err := h.authorizeOutputDelivery(owner, output); err != nil {
		fail(w, 403, err.Error())
		return
	}
	for _, file := range output.ResourceFiles {
		if file.Resource.OwnerID != owner {
			fail(w, 422, "bundle resource owner mismatch")
			return
		}
	}
	data, err := buildOutputBundle(output)
	if err != nil {
		fail(w, 422, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="routeweaver-bundle.zip"`)
	w.WriteHeader(200)
	_, _ = w.Write(data)
}

type bundleManifestFile struct {
	Path            string `json:"path"`
	ResourceID      string `json:"resourceId,omitempty"`
	AcceptedVersion string `json:"acceptedVersion,omitempty"`
	SHA256          string `json:"sha256"`
	Bytes           int    `json:"bytes"`
	Format          string `json:"format,omitempty"`
	FormatVersion   int    `json:"formatVersion,omitempty"`
	Inspection      string `json:"inspection,omitempty"`
}

// No user-supplied archive is extracted, and no server filesystem path is read.
// The archive contains exactly one compiled config, accepted files and a manifest.
func buildOutputBundle(output Output) ([]byte, error) {
	if len(output.Artifacts) != 1 || len(output.ResourceFiles) > resources.MaxBundleFiles {
		return nil, fmt.Errorf("invalid bundle artifact count")
	}
	artifact := output.Artifacts[0]
	allowed := map[string]bool{"mihomo.json": true, "sing-box.json": true, "mihomo-nodes.json": true, "sing-box-nodes.json": true}
	if !allowed[artifact.Path] || len(artifact.Content) > 4<<20 {
		return nil, fmt.Errorf("invalid bundle configuration")
	}
	blobs := map[string][]byte{artifact.Path: []byte(artifact.Content)}
	paths := []string{artifact.Path}
	sum := sha256.Sum256([]byte(artifact.Content))
	manifest := struct {
		Version        int                  `json:"version"`
		OutputRevision string               `json:"outputRevision"`
		Files          []bundleManifestFile `json:"files"`
		NativeChecked  bool                 `json:"nativeChecked"`
	}{Version: 1, OutputRevision: output.Revision, Files: []bundleManifestFile{{Path: artifact.Path, SHA256: hex.EncodeToString(sum[:]), Bytes: len(artifact.Content)}}}
	size := 0
	for _, file := range output.ResourceFiles {
		if err := resources.VerifyRuleFile(file); err != nil {
			return nil, err
		}
		res := file.Resource
		size += len(file.Body)
		if size > resources.MaxBundleFileBytes {
			return nil, fmt.Errorf("rule file bundle exceeds accepted size limit")
		}
		if prior, ok := blobs[res.Path]; ok {
			if !bytes.Equal(prior, file.Body) {
				return nil, fmt.Errorf("conflicting bundle file paths")
			}
			continue
		}
		blobs[res.Path] = file.Body
		paths = append(paths, res.Path)
		manifest.Files = append(manifest.Files, bundleManifestFile{Path: res.Path, ResourceID: res.ID, AcceptedVersion: res.AcceptedVersion, SHA256: strings.TrimPrefix(res.Digest, "sha256:"), Bytes: len(file.Body), Format: res.Format, FormatVersion: res.FormatVersion, Inspection: file.Inspection})
	}
	metadata, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return nil, err
	}
	paths = append(paths, "manifest.json")
	blobs["manifest.json"] = metadata
	var buf bytes.Buffer
	z := zip.NewWriter(&buf)
	for _, path := range paths {
		header := &zip.FileHeader{Name: path, Method: zip.Deflate}
		header.SetMode(0600)
		f, err := z.CreateHeader(header)
		if err != nil {
			return nil, err
		}
		if _, err = f.Write(blobs[path]); err != nil {
			return nil, err
		}
	}
	if err = z.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func freezeOutputRuleFiles(owner string, refs []domain.RuleResource, reader tenantRecordReader) ([]resources.RuleFile, error) {
	if len(refs) > resources.MaxBundleFiles {
		return nil, fmt.Errorf("too many rule files; maximum %d", resources.MaxBundleFiles)
	}
	files := []resources.RuleFile{}
	size := 0
	for _, ref := range refs {
		if ref.Location != "local" {
			continue
		}
		file, err := resolveAcceptedRuleFile(owner, ref, reader)
		if err != nil {
			return nil, err
		}
		size += len(file.Body)
		if size > resources.MaxBundleFileBytes {
			return nil, fmt.Errorf("rule file bundle exceeds accepted size limit")
		}
		files = append(files, file)
	}
	return files, nil
}
