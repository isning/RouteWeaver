package httpapi

import (
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"github.com/go-chi/chi/v5"
)

const templateMarker = "routeweavertokenplaceholder"

func canonicalSubscriptionTemplate(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil
	}
	invalid := errors.New("subscription link template must be an HTTP or HTTPS URL containing exactly one {token} in its path or query")
	if strings.Contains(raw, templateMarker) || strings.ContainsAny(raw, " \t\r\n") || len(raw) > 2048 || strings.Count(raw, "{token}") != 1 {
		return "", invalid
	}
	replaced := strings.ReplaceAll(raw, "{token}", templateMarker)
	if strings.ContainsAny(replaced, "{}") {
		return "", invalid
	}
	u, err := url.Parse(replaced)
	if err != nil || u.User != nil || u.Fragment != "" || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") || strings.Contains(u.Host, templateMarker) {
		return "", invalid
	}
	if _, err = canonicalSubscriptionOrigin(u.Scheme + "://" + u.Host); err != nil {
		return "", invalid
	}
	// Application and challenge routes retain their existing authorization and behavior.
	if strings.HasPrefix(u.Path, "/feed/") && u.Path != "/feed/"+templateMarker && !strings.HasPrefix(u.Path, "/feed/"+templateMarker+"/") {
		return "", invalid
	}
	if u.Path == "" || u.Path == "/" || u.Path == "/api" || strings.HasPrefix(u.Path, "/api/") || u.Path == "/healthz" || u.Path == "/readyz" || strings.HasPrefix(u.Path, "/feed/verify/") {
		return "", invalid
	}
	query, err := url.ParseQuery(u.RawQuery)
	if err != nil {
		return "", invalid
	}
	for key := range query {
		if strings.Contains(key, templateMarker) {
			return "", invalid
		}
	}
	for _, segment := range strings.Split(u.Path, "/") {
		if segment == "." || segment == ".." {
			return "", invalid
		}
	}
	return raw, nil
}

func subscriptionTemplateURL(template, origin, token string, bundle bool) string {
	if template != "" && !bundle {
		return strings.ReplaceAll(template, "{token}", token)
	}
	if template == "" {
		suffix := ""
		if bundle {
			suffix = "/bundle"
		}
		return origin + "/feed/" + token + suffix
	}
	u, _ := url.Parse(strings.ReplaceAll(template, "{token}", templateMarker))
	if bundle {
		// /feed/bundle would match the legacy /feed/{token} route.
		if u.Path == "/feed" {
			u.Path = "/feed/bundle/download"
		} else {
			u.Path = strings.TrimSuffix(u.Path, "/") + "/bundle"
		}
		u.RawPath = ""
	}
	return strings.ReplaceAll(u.String(), templateMarker, token)
}

// Custom links reuse the existing feed handlers, token lookup, revocation and accounting.
func (h *server) customSubscriptionFeed(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	record, _, err := h.readSubscriptionOrigin()
	if err != nil {
		fail(w, 500, "cannot read subscription link template")
		return
	}
	if record.LinkTemplate == "" {
		http.NotFound(w, r)
		return
	}
	if _, err = canonicalSubscriptionTemplate(record.LinkTemplate); err != nil {
		fail(w, 500, "invalid subscription link template")
		return
	}
	for _, bundle := range []bool{false, true} {
		u, _ := url.Parse(subscriptionTemplateURL(record.LinkTemplate, "", templateMarker, bundle))
		pattern := u.EscapedPath()
		if u.RawQuery != "" {
			pattern += "?" + u.Query().Encode()
		}
		actual := r.URL.EscapedPath()
		if r.URL.RawQuery != "" {
			actual += "?" + r.URL.Query().Encode()
		}
		expression := "^" + strings.Replace(regexp.QuoteMeta(pattern), templateMarker, "([A-Za-z0-9_-]{43})", 1) + "$"
		match := regexp.MustCompile(expression).FindStringSubmatch(actual)
		if len(match) != 2 {
			continue
		}
		chi.RouteContext(r.Context()).URLParams.Add("token", match[1])
		if bundle {
			h.feedBundle(w, r)
		} else {
			h.feed(w, r)
		}
		return
	}
	http.NotFound(w, r)
}
