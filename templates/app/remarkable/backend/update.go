package main

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Updates: the live build of the app's reMarkable target on Nap
// (/_nap/api/apps/<app>/targets/remarkable). A newer one is
// downloaded, checked against its SHA-256, unpacked next to this app, and swapped in. The app
// opens the new build the next time it starts; "restart" restarts the tablet's interface so it
// does at once.

type liveBuild struct {
	ID           string `json:"id"`
	BuildNumber  int    `json:"buildNumber"`
	SourceCommit string `json:"sourceCommit"`
	Notes        string `json:"notes"`
	Bytes        int64  `json:"bytes"`
	Sha256       string `json:"sha256"`
	By           string `json:"by"`
	CreatedAt    string `json:"createdAt"`
	Download     string `json:"download"`
}

func (a *App) fetchLive() (*liveBuild, error) {
	if a.build.App == "" {
		return nil, fmt.Errorf("this build does not name its app (build.json)")
	}
	res, err := a.napRequest("GET", "/_nap/api/apps/"+url.PathEscape(a.build.App)+"/targets/remarkable", nil, nil)
	if err != nil {
		return nil, &ReplyError{Message: networkMessage(err), Code: "network"}
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode >= 300 {
		var e struct {
			Code string `json:"code"`
		}
		_ = json.Unmarshal(raw, &e)
		return nil, &ReplyError{Message: napMessage(raw, res.StatusCode), Status: res.StatusCode, Code: e.Code}
	}
	var body struct {
		Build liveBuild `json:"build"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, err
	}
	return &body.Build, nil
}

func (a *App) updateOp(op string, body []byte) (any, error) {
	switch op {
	case "update.check":
		live, err := a.fetchLive()
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"current":   a.build,
			"live":      live,
			"available": live.SourceCommit != "" && live.SourceCommit != a.build.Commit,
		}, nil
	case "update.install":
		live, err := a.fetchLive()
		if err != nil {
			return nil, err
		}
		if err := a.install(live); err != nil {
			return nil, err
		}
		return map[string]any{"installed": live}, nil
	case "update.restart":
		// Restarting xochitl reopens the interface with the new build; xovi stays loaded.
		go func() {
			log.Printf("restarting the interface for the update")
			_ = exec.Command("systemctl", "restart", "xochitl").Run()
		}()
		return true, nil
	}
	return nil, fmt.Errorf("unknown op %q", op)
}

func (a *App) install(live *liveBuild) error {
	parent := filepath.Dir(a.dir)
	tmp, err := os.CreateTemp(parent, ".nap-update-*.zip")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	path := live.Download
	if !strings.HasPrefix(path, "/_nap/api/") {
		path = "/_nap/api/apps/" + url.PathEscape(a.build.App) + "/targets/remarkable/builds/" + url.PathEscape(live.ID) + "/download"
	}
	res, err := a.napRequest("GET", path, nil, nil)
	if err != nil {
		return &ReplyError{Message: networkMessage(err), Code: "network"}
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<16))
		return &ReplyError{Message: napMessage(raw, res.StatusCode), Status: res.StatusCode}
	}
	hash := sha256.New()
	if _, err := io.Copy(io.MultiWriter(tmp, hash), res.Body); err != nil {
		return err
	}
	tmp.Close()
	if sum := hex.EncodeToString(hash.Sum(nil)); live.Sha256 != "" && sum != live.Sha256 {
		return fmt.Errorf("the download is damaged (checksum differs); try again")
	}

	staging := a.dir + ".new"
	_ = os.RemoveAll(staging)
	if err := unzip(tmp.Name(), staging); err != nil {
		_ = os.RemoveAll(staging)
		return fmt.Errorf("unpacking the update: %w", err)
	}
	if _, err := os.Stat(filepath.Join(staging, "manifest.json")); err != nil {
		_ = os.RemoveAll(staging)
		return fmt.Errorf("the update has no manifest.json")
	}
	old := a.dir + ".old"
	_ = os.RemoveAll(old)
	if err := os.Rename(a.dir, old); err != nil {
		return err
	}
	if err := os.Rename(staging, a.dir); err != nil {
		_ = os.Rename(old, a.dir)
		return err
	}
	// This process keeps running from the old files until the app closes; Linux allows that.
	go func() { _ = os.RemoveAll(old) }()
	log.Printf("installed build %d (%s)", live.BuildNumber, short(live.SourceCommit))
	return nil
}

func unzip(src, dst string) error {
	r, err := zip.OpenReader(src)
	if err != nil {
		return err
	}
	defer r.Close()
	root, _ := filepath.Abs(dst)
	for _, f := range r.File {
		target := filepath.Join(dst, f.Name)
		abs, _ := filepath.Abs(target)
		if abs != root && !strings.HasPrefix(abs, root+string(os.PathSeparator)) {
			return fmt.Errorf("bad path in zip: %s", f.Name)
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		mode := os.FileMode(0o644)
		if f.Mode()&0o111 != 0 || strings.HasPrefix(f.Name, "backend/") && !strings.Contains(filepath.Base(f.Name), ".") {
			mode = 0o755
		}
		in, err := f.Open()
		if err != nil {
			return err
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
		if err != nil {
			in.Close()
			return err
		}
		_, err = io.Copy(out, in)
		in.Close()
		out.Close()
		if err != nil {
			return err
		}
	}
	return nil
}
