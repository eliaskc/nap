package main

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// The `file.get` op: a URL as a file on the tablet, for pictures. QML here cannot load https
// itself (the interface's Qt has no TLS for it), so the backend downloads the file once into
// <data>/cache and answers with its path; an Image shows it as "file://" + path. A URL that
// starts with "/" is on the Nap and gets the token. Files not used for a month are removed.
func (a *App) fileOp(body []byte) (any, error) {
	var args struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(body, &args); err != nil {
		return nil, err
	}
	if args.URL == "" {
		return nil, fmt.Errorf("url is required")
	}
	dir := filepath.Join(a.data, "cache")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	sum := sha1.Sum([]byte(args.URL))
	name := hex.EncodeToString(sum[:])
	if found, _ := filepath.Glob(filepath.Join(dir, name+".*")); len(found) > 0 {
		now := time.Now()
		_ = os.Chtimes(found[0], now, now)
		return map[string]any{"path": found[0], "cached": true}, nil
	}
	go sweepCache(dir)

	nap := strings.HasPrefix(args.URL, "/")
	target := args.URL
	if nap {
		target = a.auth.origin() + args.URL
	}
	req, err := http.NewRequest("GET", target, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("user-agent", "Mozilla/5.0 (X11; Linux armv7l) NapRemarkable/1")
	if nap {
		if token := a.auth.token(); token != "" {
			req.Header.Set("authorization", "Bearer "+token)
		}
	}
	res, err := httpClient.Do(req)
	if err != nil {
		return nil, &ReplyError{Message: networkMessage(err), Code: "network"}
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, &ReplyError{Message: fmt.Sprintf("The file did not load (%d).", res.StatusCode), Status: res.StatusCode}
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, maxResponse))
	if err != nil {
		return nil, &ReplyError{Message: networkMessage(err), Code: "network"}
	}
	path := filepath.Join(dir, name+extensionOf(res.Header.Get("content-type"), raw))
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return nil, err
	}
	if err := os.Rename(tmp, path); err != nil {
		return nil, err
	}
	return map[string]any{"path": path, "cached": false}, nil
}

// Qt picks an image's reader by the file's ending.
func extensionOf(contentType string, raw []byte) string {
	media, _, _ := mime.ParseMediaType(contentType)
	if !strings.HasPrefix(media, "image/") {
		media = http.DetectContentType(raw)
	}
	switch media {
	case "image/png":
		return ".png"
	case "image/jpeg":
		return ".jpg"
	case "image/gif":
		return ".gif"
	case "image/webp":
		return ".webp"
	case "image/svg+xml":
		return ".svg"
	}
	return ".bin"
}

func sweepCache(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	old := time.Now().Add(-30 * 24 * time.Hour)
	for _, e := range entries {
		if info, err := e.Info(); err == nil && info.ModTime().Before(old) {
			_ = os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}
