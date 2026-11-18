package httpapi

import (
	"bytes"
	"encoding/base64"
	"encoding/xml"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"routeweaver/internal/store"
	"strings"
	"unicode/utf8"
)

func (h *server) branding(w http.ResponseWriter, r *http.Request) {
	settings := Settings{Name: "RouteWeaver", Timezone: "UTC+8", Registration: "invite"}
	if err := h.s.Get("settings", "platform", &settings); err != nil && err != store.ErrNotFound {
		fail(w, 503, "platform branding unavailable")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, map[string]string{"name": settings.Name, "logo": settings.Logo, "timezone": settings.Timezone, "registration": settings.Registration})
}
func validBranding(name, logo string) bool {
	if strings.TrimSpace(name) == "" || utf8.RuneCountInString(name) > 80 {
		return false
	}
	if logo == "" {
		return true
	}
	if len(logo) > 180000 {
		return false
	}
	prefix, encoded, ok := strings.Cut(logo, ",")
	if !ok {
		return false
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(data) > 128*1024 {
		return false
	}
	switch prefix {
	case "data:image/svg+xml;base64":
		return validLogoSVG(data)
	case "data:image/png;base64", "data:image/jpeg;base64":
		config, format, err := image.DecodeConfig(bytes.NewReader(data))
		return err == nil && "data:image/"+format+";base64" == prefix && config.Width > 0 && config.Height > 0 && config.Width <= 2048 && config.Height <= 2048
	}
	return false
}
func validLogoSVG(data []byte) bool {
	allowed := map[string]bool{}
	for _, name := range strings.Fields("svg g path rect circle ellipse line polyline polygon defs linearGradient radialGradient stop clipPath mask use title desc") {
		allowed[name] = true
	}
	attributes := map[string]bool{}
	for _, name := range strings.Fields("xmlns width height viewBox preserveAspectRatio id d x y x1 y1 x2 y2 cx cy r rx ry points fill fill-rule fill-opacity stroke stroke-width stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset stroke-opacity opacity transform offset stop-color stop-opacity gradientUnits gradientTransform spreadMethod fx fy fr clip-path clip-rule mask maskUnits maskContentUnits href version role aria-label aria-hidden") {
		attributes[name] = true
	}
	decoder := xml.NewDecoder(bytes.NewReader(data))
	depth, roots := 0, 0
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			return depth == 0 && roots == 1
		}
		if err != nil {
			return false
		}
		switch value := token.(type) {
		case xml.StartElement:
			if !allowed[value.Name.Local] || value.Name.Space != "" && value.Name.Space != "http://www.w3.org/2000/svg" {
				return false
			}
			if depth == 0 {
				roots++
				if roots != 1 || value.Name.Local != "svg" {
					return false
				}
			}
			depth++
			for _, attr := range value.Attr {
				if attr.Name.Space == "xmlns" {
					if attr.Value != "http://www.w3.org/2000/svg" && attr.Value != "http://www.w3.org/1999/xlink" {
						return false
					}
					continue
				}
				if attr.Name.Space != "" && !(attr.Name.Space == "http://www.w3.org/1999/xlink" && attr.Name.Local == "href") {
					return false
				}
				if !attributes[attr.Name.Local] {
					return false
				}
				if attr.Name.Local == "xmlns" && attr.Value != "http://www.w3.org/2000/svg" {
					return false
				}
				text := strings.TrimSpace(attr.Value)
				if attr.Name.Local == "href" && (!strings.HasPrefix(text, "#") || len(text) < 2) {
					return false
				}
				if strings.Contains(strings.ToLower(text), "url(") && !(strings.HasPrefix(text, "url(#") && strings.HasSuffix(text, ")") && strings.Count(text, "url(") == 1) {
					return false
				}
			}
		case xml.EndElement:
			depth--
		case xml.Directive:
			return false
		case xml.ProcInst:
			if value.Target != "xml" {
				return false
			}
		case xml.CharData:
			if depth == 0 && strings.TrimSpace(string(value)) != "" {
				return false
			}
		}
	}
}
