package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

var httpClient = &http.Client{
	Timeout: 30 * time.Second,
	Transport: &http.Transport{
		Proxy:               http.ProxyFromEnvironment,
		DialContext:         (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout: 10 * time.Second,
		MaxIdleConns:        8,
		IdleConnTimeout:     60 * time.Second,
	},
}

const maxResponse = 16 << 20

// napRequest calls a path on the Nap with the token.
func (a *App) napRequest(method, path string, body io.Reader, headers map[string]string) (*http.Response, error) {
	req, err := http.NewRequest(method, a.auth.origin()+path, body)
	if err != nil {
		return nil, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	if token := a.auth.token(); token != "" {
		req.Header.Set("authorization", "Bearer "+token)
	}
	req.Header.Set("user-agent", "NapRemarkable/1")
	return httpClient.Do(req)
}

type httpArgs struct {
	Method  string            `json:"method"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers"`
	Body    *string           `json:"body"`
	// Base64 request body, for binary uploads.
	BodyBase64 *string `json:"bodyBase64"`
	// Always return the body as base64.
	Binary bool `json:"binary"`
}

// The `http` op. A URL that starts with "/" is on the Nap and gets the token; any other URL is
// fetched as is (the tablet has no CORS, so pages' fetches of public APIs go straight there).
func (a *App) httpOp(body []byte) (any, error) {
	var args httpArgs
	if err := json.Unmarshal(body, &args); err != nil {
		return nil, err
	}
	method := strings.ToUpper(args.Method)
	if method == "" {
		method = "GET"
	}
	var reader io.Reader
	switch {
	case args.BodyBase64 != nil:
		raw, err := base64.StdEncoding.DecodeString(*args.BodyBase64)
		if err != nil {
			return nil, err
		}
		reader = strings.NewReader(string(raw))
	case args.Body != nil:
		reader = strings.NewReader(*args.Body)
	}
	nap := strings.HasPrefix(args.URL, "/")
	target := args.URL
	if nap {
		target = a.auth.origin() + args.URL
	}
	req, err := http.NewRequest(method, target, reader)
	if err != nil {
		return nil, err
	}
	for k, v := range args.Headers {
		req.Header.Set(k, v)
	}
	if req.Header.Get("user-agent") == "" {
		req.Header.Set("user-agent", "Mozilla/5.0 (X11; Linux armv7l) NapRemarkable/1")
	}
	if nap {
		if token := a.auth.token(); token != "" {
			req.Header.Set("authorization", "Bearer "+token)
		}
	}
	started := time.Now()
	res, err := httpClient.Do(req)
	if err != nil {
		return nil, &ReplyError{Message: networkMessage(err), Status: 0, Code: "network"}
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, maxResponse))
	if err != nil {
		return nil, &ReplyError{Message: networkMessage(err), Code: "network"}
	}
	headers := map[string]string{}
	for k, v := range res.Header {
		headers[strings.ToLower(k)] = strings.Join(v, ", ")
	}
	out := map[string]any{
		"status":  res.StatusCode,
		"headers": headers,
		"url":     res.Request.URL.String(),
		"ms":      time.Since(started).Milliseconds(),
	}
	if args.Binary || !texty(res.Header.Get("content-type"), raw) {
		out["bodyBase64"] = base64.StdEncoding.EncodeToString(raw)
	} else {
		out["body"] = string(raw)
	}
	// A token Nap no longer takes: sign out, so the launcher asks to sign in again.
	if nap && res.StatusCode == 401 {
		var e struct {
			Code string `json:"code"`
		}
		_ = json.Unmarshal(raw, &e)
		if e.Code == "invalid_token" {
			go a.auth.signOut("Nap no longer takes this tablet's sign-in")
		}
	}
	return out, nil
}

func texty(contentType string, raw []byte) bool {
	media, _, _ := mime.ParseMediaType(contentType)
	if strings.HasPrefix(media, "text/") || strings.Contains(media, "json") || strings.Contains(media, "xml") || strings.Contains(media, "javascript") {
		return utf8.Valid(raw)
	}
	if media == "" {
		return utf8.Valid(raw)
	}
	return false
}

func networkMessage(err error) string {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "no such host"), strings.Contains(msg, "network is unreachable"):
		return "No internet. Check the tablet's Wi-Fi."
	case strings.Contains(msg, "timeout"), strings.Contains(msg, "deadline"):
		return "The network timed out."
	case strings.Contains(msg, "connection refused"):
		return "Could not reach the server."
	}
	return msg
}

// ---- Key-value files, for what a page keeps on the tablet (settings, solo progress caches).

var keyPattern = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)

func (a *App) kvPath(key string) string {
	return filepath.Join(a.data, "kv", keyPattern.ReplaceAllString(key, "_")+".json")
}

func (a *App) kvOp(op string, body []byte) (any, error) {
	var args struct {
		Key   string          `json:"key"`
		Value json.RawMessage `json:"value"`
	}
	if err := json.Unmarshal(body, &args); err != nil {
		return nil, err
	}
	if args.Key == "" {
		return nil, fmt.Errorf("key is required")
	}
	path := a.kvPath(args.Key)
	if op == "kv.get" {
		raw, err := os.ReadFile(path)
		if err != nil {
			return nil, nil
		}
		return json.RawMessage(raw), nil
	}
	if len(args.Value) == 0 || string(args.Value) == "null" {
		_ = os.Remove(path)
		return true, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, args.Value, 0o600); err != nil {
		return nil, err
	}
	return true, os.Rename(tmp, path)
}
