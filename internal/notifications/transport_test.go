package notifications

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func certificate(t *testing.T, host string) (tls.Certificate, *x509.CertPool) {
	t.Helper()
	key, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	template := x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: host}, DNSNames: []string{host}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, BasicConstraintsValid: true}
	der, e := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if e != nil {
		t.Fatal(e)
	}
	kb, e := x509.MarshalECPrivateKey(key)
	if e != nil {
		t.Fatal(e)
	}
	cp := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	kp := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kb})
	cert, e := tls.X509KeyPair(cp, kp)
	if e != nil {
		t.Fatal(e)
	}
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(cp)
	return cert, pool
}
func TestWebhookSignedHTTPSStableEventIDAndRejectedResponse(t *testing.T) {
	secret := "synthetic-webhook-signing-secret-12345678"
	cert, roots := certificate(t, "webhook.example.com")
	var mu sync.Mutex
	received := []string{}
	reject := false
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(io.LimitReader(r.Body, 32<<10))
		timestamp := r.Header.Get("X-RouteWeaver-Timestamp")
		mac := hmac.New(sha256.New, []byte(secret))
		mac.Write([]byte(timestamp + "."))
		mac.Write(b)
		if r.TLS == nil || r.Method != "POST" || r.Header.Get("X-RouteWeaver-Signature") != "sha256="+hex.EncodeToString(mac.Sum(nil)) {
			t.Error("missing authenticated HTTPS payload")
		}
		var event Event
		if json.Unmarshal(b, &event) != nil || event.EventID != r.Header.Get("X-RouteWeaver-Event-ID") {
			t.Error("event identity mismatch")
		}
		mu.Lock()
		received = append(received, event.EventID)
		bad := reject
		mu.Unlock()
		if bad {
			w.WriteHeader(503)
			return
		}
		w.WriteHeader(202)
	}))
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{cert}}
	srv.StartTLS()
	defer srv.Close()
	adapter := NewSecureTransport()
	adapter.client = &http.Client{Transport: &http.Transport{Proxy: nil, TLSClientConfig: &tls.Config{RootCAs: roots, ServerName: "webhook.example.com", MinVersion: tls.VersionTLS12}, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, srv.Listener.Addr().String())
	}}}
	settings := DefaultState().Settings
	settings.Webhook = WebhookSettings{Enabled: true, URL: "https://webhook.example.com/events"}
	event := Event{EventID: "stable-test-event", Kind: "test", Title: "Test", Body: "Synthetic fixture", CreatedAt: time.Now().UTC()}
	for i := 0; i < 2; i++ {
		if e := adapter.Send(context.Background(), "webhook", event, settings, Secrets{WebhookSecret: secret}); e != nil {
			t.Fatal(e)
		}
	}
	mu.Lock()
	if len(received) != 2 || received[0] != "stable-test-event" || received[1] != "stable-test-event" {
		t.Errorf("retry identity not stable: %v", received)
	}
	reject = true
	mu.Unlock()
	if e := adapter.Send(context.Background(), "webhook", event, settings, Secrets{WebhookSecret: secret}); e == nil {
		t.Fatal("rejected webhook marked accepted")
	}
	settings.Webhook.URL = "https://127.0.0.1/private"
	if e := adapter.Send(context.Background(), "webhook", event, settings, Secrets{WebhookSecret: secret}); e == nil {
		t.Fatal("SSRF target accepted")
	}
}
func TestSMTPVerifiedTLSAcceptanceStableMessageIDAndNoPlaintextFallback(t *testing.T) {
	cert, roots := certificate(t, "smtp.example.com")
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer listener.Close()
	tlsListener := tls.NewListener(listener, &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12})
	messages := make(chan string, 3)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			conn, e := tlsListener.Accept()
			if e != nil {
				return
			}
			func() {
				defer conn.Close()
				conn.SetDeadline(time.Now().Add(5 * time.Second))
				reader := bufio.NewReader(conn)
				fmt.Fprint(conn, "220 synthetic ESMTP\r\n")
				for {
					line, e := reader.ReadString('\n')
					if e != nil {
						return
					}
					switch {
					case strings.HasPrefix(line, "EHLO"):
						fmt.Fprint(conn, "250-synthetic\r\n250 AUTH PLAIN\r\n")
					case strings.HasPrefix(line, "AUTH PLAIN"):
						fmt.Fprint(conn, "235 authenticated\r\n")
					case strings.HasPrefix(line, "MAIL FROM:"), strings.HasPrefix(line, "RCPT TO:"):
						fmt.Fprint(conn, "250 ok\r\n")
					case strings.TrimSpace(line) == "DATA":
						fmt.Fprint(conn, "354 continue\r\n")
						var b strings.Builder
						for {
							l, e := reader.ReadString('\n')
							if e != nil {
								return
							}
							if l == ".\r\n" {
								break
							}
							b.WriteString(l)
						}
						messages <- b.String()
						fmt.Fprint(conn, "250 accepted\r\n")
					case strings.TrimSpace(line) == "QUIT":
						fmt.Fprint(conn, "221 bye\r\n")
						return
					default:
						fmt.Fprint(conn, "500 unsupported\r\n")
					}
				}
			}()
		}
	}()
	adapter := NewSecureTransport()
	adapter.roots = roots
	adapter.dial = func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, listener.Addr().String())
	}
	settings := DefaultState().Settings
	settings.Email = EmailSettings{Enabled: true, Host: "smtp.example.com", Port: 465, TLSMode: "tls", Username: "synthetic", From: "sender@example.com", To: []string{"recipient@example.com"}}
	event := Event{EventID: "stable-email-event", Kind: "test", Title: "Synthetic subject\r\nBcc: attacker@example.com", Body: "Synthetic body", CreatedAt: time.Now().UTC()}
	for i := 0; i < 2; i++ {
		if e := adapter.Send(context.Background(), "email", event, settings, Secrets{SMTPPassword: "synthetic-password"}); e != nil {
			t.Fatal(e)
		}
	}
	first, second := <-messages, <-messages
	if first != second || !strings.Contains(first, "X-RouteWeaver-Event-ID: stable-email-event\r\n") || strings.Contains(first, "\r\nBcc:") {
		t.Fatalf("unstable or injected message: %q %q", first, second)
	}
	// Same dial target with a wrong original hostname must fail verification.
	settings.Email.Host = "wrong.example.com"
	if e = adapter.Send(context.Background(), "email", event, settings, Secrets{SMTPPassword: "synthetic-password"}); e == nil {
		t.Fatal("TLS hostname verification bypassed")
	}
	listener.Close()
	<-done
	plain, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer plain.Close()
	plainDone := make(chan struct{})
	go func() {
		defer close(plainDone)
		conn, e := plain.Accept()
		if e != nil {
			return
		}
		defer conn.Close()
		conn.SetDeadline(time.Now().Add(3 * time.Second))
		fmt.Fprint(conn, "220 synthetic ESMTP\r\n")
		buf := bufio.NewReader(conn)
		buf.ReadString('\n')
		fmt.Fprint(conn, "250 synthetic without TLS\r\n")
	}()
	adapter.dial = func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, plain.Addr().String())
	}
	settings.Email.Host = "smtp.example.com"
	settings.Email.TLSMode = "starttls"
	if e = adapter.Send(context.Background(), "email", event, settings, Secrets{SMTPPassword: "synthetic-password"}); e == nil {
		t.Fatal("plaintext SMTP fallback allowed")
	}
	<-plainDone
}

func TestSMTPSTARTTLSAuthenticatesOnlyAfterVerifiedUpgrade(t *testing.T) {
	cert, roots := certificate(t, "smtp.example.com")
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer listener.Close()
	accepted := make(chan string, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		conn, e := listener.Accept()
		if e != nil {
			return
		}
		defer conn.Close()
		conn.SetDeadline(time.Now().Add(5 * time.Second))
		reader := bufio.NewReader(conn)
		secure := false
		fmt.Fprint(conn, "220 synthetic ESMTP\r\n")
		for {
			line, e := reader.ReadString('\n')
			if e != nil {
				return
			}
			switch {
			case strings.HasPrefix(line, "EHLO"):
				if secure {
					fmt.Fprint(conn, "250-synthetic\r\n250 AUTH PLAIN\r\n")
				} else {
					fmt.Fprint(conn, "250-synthetic\r\n250 STARTTLS\r\n")
				}
			case strings.TrimSpace(line) == "STARTTLS":
				fmt.Fprint(conn, "220 begin TLS\r\n")
				tlsConn := tls.Server(conn, &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12})
				if e := tlsConn.Handshake(); e != nil {
					return
				}
				conn = tlsConn
				reader = bufio.NewReader(conn)
				secure = true
			case strings.HasPrefix(line, "AUTH PLAIN"):
				if !secure {
					t.Error("credentials sent before verified TLS")
					return
				}
				fmt.Fprint(conn, "235 authenticated\r\n")
			case strings.HasPrefix(line, "MAIL FROM:"), strings.HasPrefix(line, "RCPT TO:"):
				fmt.Fprint(conn, "250 ok\r\n")
			case strings.TrimSpace(line) == "DATA":
				if !secure {
					t.Error("message sent before TLS")
					return
				}
				fmt.Fprint(conn, "354 continue\r\n")
				var body strings.Builder
				for {
					l, e := reader.ReadString('\n')
					if e != nil {
						return
					}
					if l == ".\r\n" {
						break
					}
					body.WriteString(l)
				}
				accepted <- body.String()
				fmt.Fprint(conn, "250 accepted\r\n")
			case strings.TrimSpace(line) == "QUIT":
				fmt.Fprint(conn, "221 bye\r\n")
				return
			default:
				fmt.Fprint(conn, "500 unsupported\r\n")
			}
		}
	}()
	adapter := NewSecureTransport()
	adapter.roots = roots
	adapter.dial = func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, listener.Addr().String())
	}
	settings := DefaultState().Settings
	settings.Email = EmailSettings{Enabled: true, Host: "smtp.example.com", Port: 587, TLSMode: "starttls", Username: "synthetic", From: "sender@example.com", To: []string{"recipient@example.com"}}
	event := Event{EventID: "starttls-test-event", Kind: "test", Title: "TLS upgrade", Body: "Synthetic STARTTLS test", CreatedAt: time.Now().UTC()}
	if e = adapter.Send(context.Background(), "email", event, settings, Secrets{SMTPPassword: "synthetic-password"}); e != nil {
		t.Fatal(e)
	}
	if body := <-accepted; !strings.Contains(body, "X-RouteWeaver-Event-ID: starttls-test-event") {
		t.Fatal("upgraded SMTP did not accept stable event identity")
	}
	<-done
}
