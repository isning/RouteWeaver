package httpapi

import (
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"time"

	"routeweaver/internal/domain"
	"routeweaver/internal/store"
)

const serverCertificateKind = "server-tls-certificates"

type serverCertificateSummary struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	DNSNames  []string  `json:"dnsNames,omitempty"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type serverCertificateMaterial struct {
	CertificatePEM string `json:"certificatePem"`
	PrivateKeyPEM  string `json:"privateKeyPem"`
}

func (m serverCertificateMaterial) summary() (serverCertificateSummary, bool) {
	if len(m.CertificatePEM) > 1<<20 || len(m.PrivateKeyPEM) > 1<<20 {
		return serverCertificateSummary{}, false
	}
	pair, err := tls.X509KeyPair([]byte(m.CertificatePEM), []byte(m.PrivateKeyPEM))
	if err != nil {
		return serverCertificateSummary{}, false
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return serverCertificateSummary{}, false
	}
	name := leaf.Subject.CommonName
	if len(leaf.DNSNames) > 0 {
		name = leaf.DNSNames[0]
	} else if len(leaf.IPAddresses) > 0 {
		name = leaf.IPAddresses[0].String()
	}
	digest := sha256.Sum256([]byte(m.CertificatePEM))
	if name == "" {
		name = "TLS " + hex.EncodeToString(digest[:4])
	}
	return serverCertificateSummary{ID: "cert_" + base64.RawURLEncoding.EncodeToString(digest[:]), Name: name, DNSNames: leaf.DNSNames, ExpiresAt: leaf.NotAfter}, true
}

func eachDeploymentCertificate(records []json.RawMessage, visit func(serverCertificateMaterial)) error {
	for _, raw := range records {
		var deployment ServerDeployment
		if err := json.Unmarshal(raw, &deployment); err != nil {
			return err
		}
		for _, program := range deployment.IR.Programs {
			if p := program.TLS; p != nil && p.CertificatePEM != "" && p.PrivateKeyPEM != "" && p.Reality == nil {
				visit(serverCertificateMaterial{p.CertificatePEM, p.PrivateKeyPEM})
			}
		}
	}
	return nil
}

func (h *server) uploadServerCertificate(w http.ResponseWriter, r *http.Request) {
	var material serverCertificateMaterial
	if !decode(w, r, &material) {
		return
	}
	summary, ok := material.summary()
	if !ok {
		fail(w, http.StatusUnprocessableEntity, "请上传有效且配对的证书和私钥")
		return
	}
	if err := h.s.Put(serverCertificateKind, summary.ID, material); err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, summary)
}

// Resolve endpoint-owned security material before saving a deployment snapshot.
func (h *server) useEndpointSecurity(ir *domain.ServerDeploymentIR, ids map[string]string) (bool, error) {
	for i := range ir.Programs {
		program := &ir.Programs[i]
		endpoint := program.Listener
		if endpoint.Reality != nil {
			program.TLS = &domain.ServerTLSOptions{Reality: endpoint.Reality}
		}
		if endpoint.CertificateID == "" {
			continue
		}
		if requested, ok := ids[endpoint.ID]; ok && requested != endpoint.CertificateID {
			return false, nil
		}
		if ids == nil {
			ids = make(map[string]string)
		}
		ids[endpoint.ID] = endpoint.CertificateID
	}
	return h.selectServerCertificates(ir, ids)
}

func (h *server) listServerCertificates(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	records, err := h.s.List(serverCertificateKind)
	if err != nil {
		storeError(w, err)
		return
	}
	summaries := map[string]serverCertificateSummary{}
	add := func(m serverCertificateMaterial) {
		if summary, ok := m.summary(); ok {
			summaries[summary.ID] = summary
		}
	}
	for _, raw := range records {
		var material serverCertificateMaterial
		if err := json.Unmarshal(raw, &material); err != nil {
			storeError(w, err)
			return
		}
		add(material)
	}
	legacy, err := h.s.List("server-deployments")
	if err == nil {
		err = eachDeploymentCertificate(legacy, add)
	}
	if err != nil {
		storeError(w, err)
		return
	}
	out := make([]serverCertificateSummary, 0, len(summaries))
	for _, summary := range summaries {
		out = append(out, summary)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		if !out[i].ExpiresAt.Equal(out[j].ExpiresAt) {
			return out[i].ExpiresAt.After(out[j].ExpiresAt)
		}
		return out[i].ID < out[j].ID
	})
	writeJSON(w, http.StatusOK, out)
}

func (h *server) selectServerCertificates(ir *domain.ServerDeploymentIR, ids map[string]string) (bool, error) {
	if len(ids) == 0 {
		return true, nil
	}
	var legacy []json.RawMessage
	for i := range ir.Programs {
		program := &ir.Programs[i]
		id, selected := ids[program.Listener.ID]
		if !selected {
			continue
		}
		connectionTLS := program.Listener.Connection.TLS
		if connectionTLS == nil || !connectionTLS.Enabled || connectionTLS.Reality != nil || !domain.ValidID(id) {
			return false, nil
		}
		var material serverCertificateMaterial
		switch err := h.s.Get(serverCertificateKind, id, &material); err {
		case nil:
		case store.ErrNotFound:
			if legacy == nil {
				legacy, err = h.s.List("server-deployments")
				if err != nil {
					return false, err
				}
			}
			if err := eachDeploymentCertificate(legacy, func(candidate serverCertificateMaterial) {
				if summary, ok := candidate.summary(); ok && summary.ID == id {
					material = candidate
				}
			}); err != nil {
				return false, err
			}
		default:
			return false, err
		}
		if summary, ok := material.summary(); !ok || summary.ID != id {
			return false, nil
		}
		program.TLS = &domain.ServerTLSOptions{
			CertificatePath: "tls/certificate.pem", KeyPath: "tls/key.pem",
			CertificatePEM: material.CertificatePEM, PrivateKeyPEM: material.PrivateKeyPEM,
		}
		delete(ids, program.Listener.ID)
	}
	return len(ids) == 0, nil
}

func serverCertificateWrites(ir domain.ServerDeploymentIR) []store.RecordWrite {
	var writes []store.RecordWrite
	seen := map[string]bool{}
	for _, p := range ir.Programs {
		if p.TLS == nil || p.TLS.CertificatePEM == "" || p.TLS.PrivateKeyPEM == "" || p.TLS.Reality != nil {
			continue
		}
		material := serverCertificateMaterial{p.TLS.CertificatePEM, p.TLS.PrivateKeyPEM}
		if summary, ok := material.summary(); ok && !seen[summary.ID] {
			seen[summary.ID] = true
			writes = append(writes, store.RecordWrite{Kind: serverCertificateKind, ID: summary.ID, Value: material})
		}
	}
	return writes
}

func serverTLSPlatformDiagnostic(ir domain.ServerDeploymentIR) error {
	for i, p := range ir.Programs {
		if c := p.Listener.Connection.TLS; c != nil && c.Enabled && c.Reality == nil {
			if p.TLS == nil || p.TLS.CertificatePEM == "" || p.TLS.PrivateKeyPEM == "" {
				return fmt.Errorf("第 %d 段需要选择或上传平台证书", i+1)
			}
		}
	}
	return nil
}
