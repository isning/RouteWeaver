package notifications

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/smtp"
	"routeweaver/internal/domain"
	"routeweaver/internal/resources"
	"strconv"
	"strings"
	"time"
)

// SecureTransport uses verified TLS only, no environment proxy, and public
// DNS-pinned network connections. A successful send means server acceptance,
// not inbox delivery or receiver processing.
type SecureTransport struct {
	client *http.Client
	dial   func(context.Context, string, string) (net.Conn, error)
	roots  *x509.CertPool
}

func NewSecureTransport() *SecureTransport {
	return &SecureTransport{client: resources.OutboundClient(15 * time.Second), dial: resources.PublicDialer()}
}
func (t *SecureTransport) Send(ctx context.Context, channel string, event Event, settings Settings, secrets Secrets) error {
	if !domain.ValidID(event.EventID) || !validText(event.Title, 160) || !validText(event.Body, 8000) {
		return fmt.Errorf("invalid notification payload")
	}
	if err := validateSettings(settings, secrets); err != nil {
		return fmt.Errorf("invalid channel settings")
	}
	switch channel {
	case "email":
		if !settings.Email.Enabled {
			return fmt.Errorf("email disabled")
		}
		return t.email(ctx, event, settings.Email, secrets.SMTPPassword)
	case "webhook":
		if !settings.Webhook.Enabled {
			return fmt.Errorf("webhook disabled")
		}
		return t.webhook(ctx, event, settings.Webhook, secrets.WebhookSecret)
	default:
		return fmt.Errorf("unsupported external channel")
	}
}
func (t *SecureTransport) webhook(ctx context.Context, event Event, settings WebhookSettings, secret string) error {
	if err := resources.ValidateHTTPSURL(settings.URL); err != nil {
		return fmt.Errorf("webhook destination is not allowed")
	}
	body, err := json.Marshal(event)
	if err != nil || len(body) > 32<<10 {
		return fmt.Errorf("invalid webhook payload")
	}
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	h := hmac.New(sha256.New, []byte(secret))
	h.Write([]byte(timestamp + "."))
	h.Write(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, settings.URL, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("invalid webhook request")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "RouteWeaver/1")
	req.Header.Set("X-RouteWeaver-Event-ID", event.EventID)
	req.Header.Set("X-RouteWeaver-Timestamp", timestamp)
	req.Header.Set("X-RouteWeaver-Signature", "sha256="+hex.EncodeToString(h.Sum(nil)))
	response, err := t.client.Do(req)
	if err != nil {
		return fmt.Errorf("webhook transport failed")
	}
	defer response.Body.Close()
	io.Copy(io.Discard, io.LimitReader(response.Body, 8<<10))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("webhook rejected request (HTTP %d)", response.StatusCode)
	}
	return nil
}
func (t *SecureTransport) email(ctx context.Context, event Event, settings EmailSettings, password string) error {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	conn, err := t.dial(ctx, "tcp", net.JoinHostPort(settings.Host, strconv.Itoa(settings.Port)))
	if err != nil {
		return fmt.Errorf("SMTP connection failed")
	}
	defer conn.Close()
	rawConn := conn
	stopCancel := context.AfterFunc(ctx, func() { rawConn.Close() })
	defer stopCancel()
	if deadline, ok := ctx.Deadline(); ok {
		conn.SetDeadline(deadline)
	}
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12, ServerName: settings.Host, RootCAs: t.roots}
	if settings.TLSMode == "tls" {
		secure := tls.Client(conn, tlsConfig)
		if err = secure.HandshakeContext(ctx); err != nil {
			return fmt.Errorf("SMTP TLS verification failed")
		}
		conn = secure
	}
	client, err := smtp.NewClient(conn, settings.Host)
	if err != nil {
		return fmt.Errorf("SMTP greeting failed")
	}
	defer client.Close()
	if settings.TLSMode == "starttls" {
		if ok, _ := client.Extension("STARTTLS"); !ok {
			return fmt.Errorf("SMTP server does not offer required STARTTLS")
		}
		if err = client.StartTLS(tlsConfig); err != nil {
			return fmt.Errorf("SMTP STARTTLS verification failed")
		}
	}
	state, ok := client.TLSConnectionState()
	if !ok || !state.HandshakeComplete {
		return fmt.Errorf("SMTP requires verified TLS")
	}
	if settings.Username != "" {
		if err = client.Auth(smtp.PlainAuth("", settings.Username, password, settings.Host)); err != nil {
			return fmt.Errorf("SMTP authentication failed")
		}
	}
	if err = client.Mail(settings.From); err != nil {
		return fmt.Errorf("SMTP sender rejected")
	}
	for _, to := range settings.To {
		if err = client.Rcpt(to); err != nil {
			return fmt.Errorf("SMTP recipient rejected")
		}
	}
	writer, err := client.Data()
	if err != nil {
		return fmt.Errorf("SMTP data rejected")
	}
	subject := strings.NewReplacer("\r", " ", "\n", " ").Replace(event.Title)
	// Stable Message-ID allows receivers to identify an at-least-once retry.
	message := "From: " + settings.From + "\r\nTo: " + strings.Join(settings.To, ", ") + "\r\nSubject: " + mime.QEncoding.Encode("UTF-8", subject) + "\r\nDate: " + event.CreatedAt.Format(time.RFC1123Z) + "\r\nMessage-ID: <" + key(event.EventID) + "@routeweaver.notification>\r\nX-RouteWeaver-Event-ID: " + event.EventID + "\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n" + strings.ReplaceAll(strings.ReplaceAll(event.Body, "\r\n", "\n"), "\n", "\r\n") + "\r\n"
	if _, err = io.WriteString(writer, message); err != nil {
		return fmt.Errorf("SMTP write failed")
	}
	if err = writer.Close(); err != nil {
		return fmt.Errorf("SMTP message was not accepted")
	}
	// Once DATA is accepted, QUIT failure cannot undo it. Retrying solely because
	// QUIT failed would create an avoidable duplicate.
	_ = client.Quit()
	return nil
}
