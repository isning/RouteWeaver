package httpapi

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"net/netip"
	"strings"
	"time"

	"routeweaver/internal/domain"
)

// Validate exactly the packaged material at publication, not draft-save time.
// This verifies time, supplied chain consistency, and intended server names. It
// deliberately does not claim that an arbitrary client trusts this issuer.
func (h *server) verifyServerTLSArtifacts(ir domain.ServerDeploymentIR, artifacts []domain.Artifact) error {
	return h.verifyServerTLSArtifactsWithProof(ir, artifacts, &preparedFleet{})
}
func (h *server) verifyServerTLSArtifactsWithProof(ir domain.ServerDeploymentIR, artifacts []domain.Artifact, proof *preparedFleet) error {
	files := map[string]string{}
	for _, artifact := range artifacts {
		files[artifact.Path] = artifact.Content
	}
	rawRoutes, err := h.fleetList(proof, "published-routes")
	if err != nil {
		return err
	}
	routes := []domain.PublishedRoute{}
	for _, raw := range rawRoutes {
		var route domain.PublishedRoute
		if err := json.Unmarshal(raw, &route); err != nil {
			return err
		}
		if route.DeploymentID == ir.ID {
			routes = append(routes, route)
		}
	}
	now := time.Now().UTC()
	for _, program := range ir.Programs {
		connection := program.Listener.Connection
		if connection.TLS == nil || !connection.TLS.Enabled || connection.TLS.Reality != nil {
			continue
		}
		if program.TLS == nil || program.TLS.Reality != nil {
			return publicationDomainError("TLS certificate and private key PEM are required; add server TLS material and review again.", "TLS deployment requires packaged certificate and private key PEM for instance %s", program.Instance.ID)
		}
		certPEM, certOK := files[program.Instance.ID+"/"+program.TLS.CertificatePath]
		keyPEM, keyOK := files[program.Instance.ID+"/"+program.TLS.KeyPath]
		if !certOK || !keyOK {
			return publicationDomainError("TLS certificate and private key PEM are required; add server TLS material and review again.", "TLS deployment requires packaged certificate and private key PEM for instance %s", program.Instance.ID)
		}
		pair, err := tls.X509KeyPair([]byte(certPEM), []byte(keyPEM))
		if err != nil {
			return publicationDomainError("TLS certificate and private key package is invalid; correct server TLS material and review again.", "TLS certificate/private key package is invalid for instance %s", program.Instance.ID)
		}
		certs := make([]*x509.Certificate, 0, len(pair.Certificate))
		for i, der := range pair.Certificate {
			cert, err := x509.ParseCertificate(der)
			if err != nil {
				return publicationDomainError("TLS certificate chain is invalid; replace server TLS material and review again.", "TLS certificate chain item %d is invalid for instance %s", i, program.Instance.ID)
			}
			if now.Before(cert.NotBefore) {
				return publicationDomainError("TLS certificate chain is not yet valid; correct server TLS material and review again.", "TLS certificate chain item %d for instance %s is not yet valid until %s", i, program.Instance.ID, cert.NotBefore.UTC().Format(time.RFC3339))
			}
			if now.After(cert.NotAfter) {
				return publicationDomainError("TLS certificate chain has expired; replace server TLS material and review again.", "TLS certificate chain item %d for instance %s expired at %s", i, program.Instance.ID, cert.NotAfter.UTC().Format(time.RFC3339))
			}
			certs = append(certs, cert)
		}
		for i := 1; i < len(certs); i++ {
			if err := certs[i-1].CheckSignatureFrom(certs[i]); err != nil {
				return publicationDomainError("TLS certificate chain is invalid; replace server TLS material and review again.", "TLS certificate chain for instance %s has an invalid issuer at item %d", program.Instance.ID, i)
			}
		}
		// Trust only the supplied last certificate for this structural check.
		// A one-certificate private/self-signed deployment remains supported.
		roots, intermediates := x509.NewCertPool(), x509.NewCertPool()
		roots.AddCert(certs[len(certs)-1])
		for i := 1; i < len(certs)-1; i++ {
			intermediates.AddCert(certs[i])
		}
		if _, err := certs[0].Verify(x509.VerifyOptions{Roots: roots, Intermediates: intermediates, CurrentTime: now, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}); err != nil {
			return publicationDomainError("TLS certificate chain is invalid; replace server TLS material and review again.", "TLS certificate chain for instance %s is not valid for server authentication: %v", program.Instance.ID, err)
		}
		names, err := h.serverTLSNamesWithProof(ir, program, routes, proof)
		if err != nil {
			return err
		}
		for name := range names {
			if err := certs[0].VerifyHostname(name); err != nil {
				return publicationDomainError("TLS certificate does not cover an intended server name; correct the certificate or endpoint and review again.", "TLS certificate for instance %s does not cover server name %q: %v", program.Instance.ID, name, err)
			}
		}
	}
	return nil
}

func (h *server) serverTLSNames(ir domain.ServerDeploymentIR, program domain.ServerProgram, routes []domain.PublishedRoute) (map[string]bool, error) {
	return h.serverTLSNamesWithProof(ir, program, routes, &preparedFleet{})
}
func (h *server) serverTLSNamesWithProof(ir domain.ServerDeploymentIR, program domain.ServerProgram, routes []domain.PublishedRoute, proof *preparedFleet) (map[string]bool, error) {
	listener := program.Listener.Connection
	names := map[string]bool{}
	if listener.TLS.ServerName != "" {
		names[listener.TLS.ServerName] = true
	}
	for _, route := range routes {
		if route.Path.Entry == program.Listener.ID && listener.TLS.ServerName == "" {
			names[route.PublicHost] = true
		}
	}
	dialHost := listener.Host
	if dialHost == "0.0.0.0" || dialHost == "::" {
		var host domain.Host
		if err := h.fleetRead(proof, "hosts", program.Instance.HostID, &host, false); err != nil {
			return nil, err
		}
		dialHost = host.Address
	}
	for _, source := range ir.Programs {
		connections := append([]domain.Connection(nil), source.Egress...)
		for _, connector := range source.Connectors {
			connections = append(connections, connector.Connection)
		}
		for _, connection := range connections {
			if connection.TLS == nil || !connection.TLS.Enabled || connection.TLS.Reality != nil || connection.Protocol != listener.Protocol || connection.Port != listener.Port || !sameTLSHost(connection.Host, dialHost) {
				continue
			}
			name := connection.TLS.ServerName
			if name == "" {
				name = connection.Host
			}
			names[name] = true
		}
	}
	return names, nil
}
func sameTLSHost(a, b string) bool {
	left, le := netip.ParseAddr(a)
	right, re := netip.ParseAddr(b)
	if le == nil && re == nil {
		return left.Unmap() == right.Unmap()
	}
	return strings.EqualFold(strings.TrimSuffix(a, "."), strings.TrimSuffix(b, "."))
}
