package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"rsc.io/qr"
)

// Auth is the sign-in: Nap's device flow, as agents and the iOS apps use it. The tablet shows a
// code and a QR code; the person approves it at /connect on their phone (behind Cloudflare
// Access); the backend polls for the token and keeps it in the data folder, one per Nap.
type Auth struct {
	app     *App
	mu      sync.Mutex
	pending *pendingSignIn
}

type pendingSignIn struct {
	deviceCode string
	cancel     chan struct{}
}

// Me is the signed-in person, from /_nap/api/me.
type Me struct {
	Email string `json:"email"`
	Name  string `json:"name"`
	Shape string `json:"shape,omitempty"`
	Color string `json:"color,omitempty"`
}

func newAuth(app *App) *Auth { return &Auth{app: app} }

// The Nap this launcher talks to: NAP_ORIGIN, then <data>/origin (set for development), then the
// one the build was made for.
func (a *Auth) origin() string {
	if o := os.Getenv("NAP_ORIGIN"); o != "" {
		return strings.TrimRight(o, "/")
	}
	if raw, err := os.ReadFile(filepath.Join(a.app.data, "origin")); err == nil {
		if o := strings.TrimSpace(string(raw)); o != "" {
			return strings.TrimRight(o, "/")
		}
	}
	return strings.TrimRight(a.app.build.Origin, "/")
}

func (a *Auth) accountDir() string {
	u, err := url.Parse(a.origin())
	host := "nap"
	if err == nil && u.Host != "" {
		host = strings.ReplaceAll(u.Host, ":", "_")
	}
	return filepath.Join(a.app.data, "accounts", host)
}

func (a *Auth) token() string {
	raw, err := os.ReadFile(filepath.Join(a.accountDir(), "token"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(raw))
}

func (a *Auth) me() *Me {
	raw, err := os.ReadFile(filepath.Join(a.accountDir(), "me.json"))
	if err != nil {
		return nil
	}
	var me Me
	if json.Unmarshal(raw, &me) != nil || me.Email == "" {
		return nil
	}
	return &me
}

func (a *Auth) save(token string, me *Me) error {
	dir := a.accountDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if token != "" {
		if err := os.WriteFile(filepath.Join(dir, "token"), []byte(token), 0o600); err != nil {
			return err
		}
	}
	if me != nil {
		raw, _ := json.Marshal(me)
		return os.WriteFile(filepath.Join(dir, "me.json"), raw, 0o600)
	}
	return nil
}

func (a *Auth) signOut(reason string) {
	dir := a.accountDir()
	_ = os.Remove(filepath.Join(dir, "token"))
	_ = os.Remove(filepath.Join(dir, "me.json"))
	a.app.sockets.closeAll()
	a.app.Event("auth", map[string]any{"signedIn": false, "reason": reason})
}

func (a *Auth) handle(op string, body []byte) (any, error) {
	switch op {
	case "auth.start":
		return a.start()
	case "auth.cancel":
		a.mu.Lock()
		if a.pending != nil {
			close(a.pending.cancel)
			a.pending = nil
		}
		a.mu.Unlock()
		return true, nil
	case "auth.signout":
		a.signOut("signed out")
		return true, nil
	case "auth.me":
		me, err := a.loadMe()
		if err != nil {
			return nil, err
		}
		return me, nil
	}
	return nil, fmt.Errorf("unknown op %q", op)
}

// Starts the device flow and returns what the tablet shows. The result of the sign-in comes as an
// "auth" event.
func (a *Auth) start() (any, error) {
	var start struct {
		DeviceCode              string  `json:"device_code"`
		UserCode                string  `json:"user_code"`
		VerificationURI         string  `json:"verification_uri"`
		VerificationURIComplete string  `json:"verification_uri_complete"`
		Interval                float64 `json:"interval"`
		ExpiresIn               float64 `json:"expires_in"`
	}
	status, raw, err := a.post("/_nap/api/auth/device", map[string]any{"client": "Nap for reMarkable"})
	if err != nil {
		return nil, err
	}
	if status >= 300 || json.Unmarshal(raw, &start) != nil || start.DeviceCode == "" {
		return nil, &ReplyError{Message: napMessage(raw, status), Status: status}
	}
	a.mu.Lock()
	if a.pending != nil {
		close(a.pending.cancel)
	}
	p := &pendingSignIn{deviceCode: start.DeviceCode, cancel: make(chan struct{})}
	a.pending = p
	a.mu.Unlock()

	interval := time.Duration(max(2, start.Interval) * float64(time.Second))
	expires := time.Duration(max(60, start.ExpiresIn) * float64(time.Second))
	go a.poll(p, interval, time.Now().Add(expires))

	link := start.VerificationURIComplete
	if link == "" {
		link = start.VerificationURI + "?code=" + url.QueryEscape(start.UserCode)
	}
	return map[string]any{
		"userCode": start.UserCode,
		"url":      link,
		"shortUrl": strings.TrimPrefix(strings.TrimPrefix(start.VerificationURI, "https://"), "http://"),
		"qr":       qrRows(link),
	}, nil
}

func (a *Auth) poll(p *pendingSignIn, interval time.Duration, deadline time.Time) {
	for time.Now().Before(deadline) {
		select {
		case <-p.cancel:
			return
		case <-time.After(interval):
		}
		status, raw, err := a.post("/_nap/api/auth/token", map[string]any{"device_code": p.deviceCode})
		if err != nil {
			log.Printf("sign-in poll: %v", err)
			continue // the network may be waking up
		}
		var result struct {
			AccessToken string `json:"access_token"`
			Token       string `json:"token"`
			Email       string `json:"email"`
			Error       string `json:"error"`
		}
		_ = json.Unmarshal(raw, &result)
		token := result.AccessToken
		if token == "" {
			token = result.Token
		}
		if token != "" {
			if err := a.save(token, &Me{Email: result.Email, Name: result.Email}); err != nil {
				a.app.Event("auth", map[string]any{"signedIn": false, "error": err.Error()})
				return
			}
			me, _ := a.loadMe()
			a.app.Event("auth", map[string]any{"signedIn": true, "me": me})
			a.clearPending(p)
			return
		}
		switch result.Error {
		case "authorization_pending", "slow_down", "":
			if status >= 500 {
				log.Printf("sign-in poll: %d", status)
			}
			continue
		case "access_denied":
			a.app.Event("auth", map[string]any{"signedIn": false, "error": "Sign-in was denied."})
		default:
			a.app.Event("auth", map[string]any{"signedIn": false, "error": "Sign-in failed (" + result.Error + ")."})
		}
		a.clearPending(p)
		return
	}
	a.app.Event("auth", map[string]any{"signedIn": false, "error": "The code expired. Try again."})
	a.clearPending(p)
}

func (a *Auth) clearPending(p *pendingSignIn) {
	a.mu.Lock()
	if a.pending == p {
		a.pending = nil
	}
	a.mu.Unlock()
}

// The person's name and look, for presence and the people list.
func (a *Auth) loadMe() (*Me, error) {
	res, err := a.app.napRequest("GET", "/_nap/api/me", nil, nil)
	if err != nil {
		return a.me(), err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode >= 300 {
		return a.me(), &ReplyError{Message: napMessage(raw, res.StatusCode), Status: res.StatusCode}
	}
	var me Me
	if err := json.Unmarshal(raw, &me); err != nil || me.Email == "" {
		return a.me(), fmt.Errorf("unexpected /me answer")
	}
	if me.Name == "" {
		me.Name = me.Email
	}
	_ = a.save("", &me)
	return &me, nil
}

func (a *Auth) post(path string, body any) (int, []byte, error) {
	raw, _ := json.Marshal(body)
	req, err := http.NewRequest("POST", a.origin()+path, bytes.NewReader(raw))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("content-type", "application/json")
	res, err := httpClient.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	out, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	return res.StatusCode, out, nil
}

// Nap's error message from a JSON error body, or the status.
func napMessage(raw []byte, status int) string {
	var body struct {
		Error            string `json:"error"`
		ErrorDescription string `json:"error_description"`
		Message          string `json:"message"`
	}
	_ = json.Unmarshal(raw, &body)
	switch {
	case body.ErrorDescription != "":
		return body.ErrorDescription
	case body.Error != "":
		return body.Error
	case body.Message != "":
		return body.Message
	}
	return fmt.Sprintf("Nap answered %d", status)
}

// The QR code of the approval link, as rows of "1" (dark) and "0".
func qrRows(text string) []string {
	code, err := qr.Encode(text, qr.M)
	if err != nil {
		return nil
	}
	rows := make([]string, code.Size)
	for y := 0; y < code.Size; y++ {
		var b strings.Builder
		for x := 0; x < code.Size; x++ {
			if code.Black(x, y) {
				b.WriteByte('1')
			} else {
				b.WriteByte('0')
			}
		}
		rows[y] = b.String()
	}
	return rows
}
