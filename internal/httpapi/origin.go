package httpapi

import (
	"errors"
	"golang.org/x/net/idna"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// CanonicalPublicOrigin is explicit operator configuration, never a forwarded
// request header. It allows HTTPS termination at a proxy preserving Host without
// trusting arbitrary X-Forwarded-Proto/Forwarded values.
func CanonicalPublicOrigin(raw string) (string, error) {
	if raw == "" {
		return "", nil
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || strings.HasSuffix(u.Host, ":") || u.User != nil || u.Opaque != "" || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.ContainsAny(u.Host, ", \t\r\n\\") {
		return "", errors.New("public origin must be an HTTPS origin without credentials, path, query or fragment")
	}
	if port := u.Port(); port != "" {
		p, e := strconv.Atoi(port)
		if e != nil || p < 1 || p > 65535 {
			return "", errors.New("public origin port is invalid")
		}
	}
	host := u.Hostname()
	if ip := net.ParseIP(host); ip != nil {
		host = ip.String()
		if strings.Contains(host, ":") {
			host = "[" + host + "]"
		}
	} else {
		host, err = idna.Lookup.ToASCII(host)
		if err != nil || strings.ContainsAny(host, "*%") {
			return "", errors.New("public origin hostname is invalid")
		}
		host = strings.ToLower(host)
	}
	if port := u.Port(); port != "" && port != "443" {
		host += ":" + port
	}
	return "https://" + host, nil
}

func validMutationOrigin(r *http.Request, configured string) bool {
	values := r.Header.Values("Origin")
	if len(values) == 0 {
		return true
	}
	if len(values) != 1 || values[0] == "" {
		return false
	}
	raw := values[0]
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || strings.HasSuffix(u.Host, ":") || u.User != nil || u.Path != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" || strings.Contains(raw, ",") {
		return false
	}
	if configured != "" {
		origin, originErr := CanonicalPublicOrigin(raw)
		authority, hostErr := CanonicalPublicOrigin("https://" + r.Host)
		return originErr == nil && hostErr == nil && origin == configured && authority == configured
	}
	if !strings.EqualFold(u.Host, r.Host) {
		return false
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return u.Scheme == scheme
}
