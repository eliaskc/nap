// The Nap launcher's backend on the reMarkable: the native half of the app. AppLoad starts it
// when the launcher opens and passes a SOCK_SEQPACKET socket; the QML frontend sends it JSON
// requests and gets replies and events back.
//
// It holds what QML should not or cannot: the Nap token (QML's WebSocket cannot send an
// Authorization header), HTTP with timeouts, WebSockets, the handwriting network (QML's
// JavaScript is far too slow for it), files, and self-updates.
//
// Messages, both ways: a header packet {int32 type, int32 length} and a body packet.
//
//	frontend → backend  type 1  {"id": 7, "op": "http", ...}
//	backend → frontend  type 2  {"id": 7, "ok": true, "result": ...} or {"id": 7, "ok": false, "error": "..."}
//	                    type 3  {"event": "ws", ...}  (events)
//	                    type 4  "<message id>:<part>:<parts>:" + part of a type 2 or 3 body that is too
//	                            big for one packet; the frontend joins the parts and handles the whole.
//
// For the Mac preview, `entry --dev <path>` listens on a stream socket instead and frames each
// message as 4-byte type, 4-byte length, body (macOS has no SOCK_SEQPACKET for Unix sockets).
package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
)

const (
	typeRequest = 1
	typeReply   = 2
	typeEvent   = 3
	typeChunk   = 4
	// The largest body sent in one packet. Bigger ones go in type 4 parts.
	maxPacket = 32 * 1024
)

type transport interface {
	read() (int32, []byte, error)
	write(kind int32, body []byte) error
}

// AppLoad: header and body are separate packets.
type seqpacket struct {
	conn *net.UnixConn
	mu   sync.Mutex
	buf  []byte
}

func (s *seqpacket) read() (int32, []byte, error) {
	n, err := s.conn.Read(s.buf)
	if err != nil {
		return 0, nil, err
	}
	if n < 8 {
		return 0, nil, fmt.Errorf("short header (%d bytes)", n)
	}
	kind := int32(binary.LittleEndian.Uint32(s.buf[0:4]))
	length := int(int32(binary.LittleEndian.Uint32(s.buf[4:8])))
	if length <= 0 {
		return kind, nil, nil
	}
	n, err = s.conn.Read(s.buf)
	if err != nil {
		return 0, nil, err
	}
	return kind, append([]byte(nil), s.buf[:n]...), nil
}

func (s *seqpacket) write(kind int32, body []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	header := make([]byte, 8)
	binary.LittleEndian.PutUint32(header[0:4], uint32(kind))
	binary.LittleEndian.PutUint32(header[4:8], uint32(len(body)))
	if _, err := s.conn.Write(header); err != nil {
		return err
	}
	if len(body) == 0 {
		return nil
	}
	_, err := s.conn.Write(body)
	return err
}

// The Mac preview: one stream, each message framed with its type and length.
type stream struct {
	r  *bufio.Reader
	w  io.Writer
	mu sync.Mutex
}

func (s *stream) read() (int32, []byte, error) {
	header := make([]byte, 8)
	if _, err := io.ReadFull(s.r, header); err != nil {
		return 0, nil, err
	}
	kind := int32(binary.LittleEndian.Uint32(header[0:4]))
	body := make([]byte, binary.LittleEndian.Uint32(header[4:8]))
	if _, err := io.ReadFull(s.r, body); err != nil {
		return 0, nil, err
	}
	return kind, body, nil
}

func (s *stream) write(kind int32, body []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	header := make([]byte, 8)
	binary.LittleEndian.PutUint32(header[0:4], uint32(kind))
	binary.LittleEndian.PutUint32(header[4:8], uint32(len(body)))
	if _, err := s.w.Write(header); err != nil {
		return err
	}
	_, err := s.w.Write(body)
	return err
}

// App is the backend's state.
type App struct {
	t       transport
	dir     string // the AppLoad app folder (manifest.json, resources.rcc, backend/)
	data    string // the launcher's own files: token, kv, logs
	build   BuildInfo
	chunkID atomic.Int64
	auth    *Auth
	sockets *Sockets
}

// BuildInfo is build.json, written by scripts/build.
type BuildInfo struct {
	App     string `json:"app"`
	Origin  string `json:"origin"`
	Commit  string `json:"commit"`
	BuiltAt string `json:"builtAt"`
}

type request struct {
	ID int64  `json:"id"`
	Op string `json:"op"`
}

// ReplyError carries an HTTP status and Nap's error code to the frontend.
type ReplyError struct {
	Message string
	Status  int
	Code    string
}

func (e *ReplyError) Error() string { return e.Message }

func (a *App) send(kind int32, value any) {
	body, err := json.Marshal(value)
	if err != nil {
		log.Printf("marshal: %v", err)
		return
	}
	if len(body) <= maxPacket {
		if err := a.t.write(kind, body); err != nil {
			log.Printf("write: %v", err)
		}
		return
	}
	// Too big for one packet: send it in parts. The last part carries the type to handle it as.
	id := a.chunkID.Add(1)
	parts := (len(body) + maxPacket - 1) / maxPacket
	for i := 0; i < parts; i++ {
		end := min(len(body), (i+1)*maxPacket)
		prefix := fmt.Sprintf("%d:%d:%d:%d:", id, i, parts, kind)
		if err := a.t.write(typeChunk, append([]byte(prefix), body[i*maxPacket:end]...)); err != nil {
			log.Printf("write chunk: %v", err)
			return
		}
	}
}

func (a *App) reply(id int64, result any, err error) {
	if err != nil {
		out := map[string]any{"id": id, "ok": false, "error": err.Error()}
		var re *ReplyError
		if errors.As(err, &re) {
			if re.Status != 0 {
				out["status"] = re.Status
			}
			if re.Code != "" {
				out["code"] = re.Code
			}
		}
		a.send(typeReply, out)
		return
	}
	a.send(typeReply, map[string]any{"id": id, "ok": true, "result": result})
}

// Event sends an event to the frontend.
func (a *App) Event(name string, fields map[string]any) {
	if fields == nil {
		fields = map[string]any{}
	}
	fields["event"] = name
	a.send(typeEvent, fields)
}

func (a *App) handle(body []byte) {
	var req request
	if err := json.Unmarshal(body, &req); err != nil {
		log.Printf("bad request: %v", err)
		return
	}
	go func() {
		defer func() {
			if r := recover(); r != nil {
				a.reply(req.ID, nil, fmt.Errorf("backend crashed in %s: %v", req.Op, r))
			}
		}()
		result, err := a.dispatch(req.Op, body)
		a.reply(req.ID, result, err)
	}()
}

func (a *App) dispatch(op string, body []byte) (any, error) {
	switch {
	case op == "hello":
		return a.hello(), nil
	case strings.HasPrefix(op, "auth."):
		return a.auth.handle(op, body)
	case op == "http":
		return a.httpOp(body)
	case strings.HasPrefix(op, "ws."):
		return a.sockets.handle(op, body)
	case op == "hwr":
		return hwrOp(a, body)
	case op == "kv.get" || op == "kv.set":
		return a.kvOp(op, body)
	case strings.HasPrefix(op, "update."):
		return a.updateOp(op, body)
	case op == "log":
		var m struct {
			Text string `json:"text"`
		}
		_ = json.Unmarshal(body, &m)
		log.Printf("frontend: %s", m.Text)
		return true, nil
	}
	return nil, fmt.Errorf("unknown op %q", op)
}

func (a *App) hello() map[string]any {
	me := a.auth.me()
	return map[string]any{
		"origin":   a.auth.origin(),
		"signedIn": a.auth.token() != "",
		"me":       me,
		"build":    a.build,
		"dataDir":  a.data,
	}
}

func main() {
	log.SetFlags(log.Ltime | log.Lmicroseconds)
	if len(os.Args) > 2 && os.Args[1] == "--hwr-test" {
		hwrTest(os.Args[2:])
		return
	}
	exe, _ := os.Executable()
	app := &App{dir: filepath.Dir(filepath.Dir(exe))}
	if dir := os.Getenv("NAP_APP_DIR"); dir != "" {
		app.dir = dir
	}
	app.data = os.Getenv("NAP_DATA")
	if app.data == "" {
		app.data = "/home/root/.local/share/nap"
	}
	_ = os.MkdirAll(app.data, 0o700)
	if f, err := os.OpenFile(filepath.Join(app.data, "backend.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600); err == nil {
		log.SetOutput(io.MultiWriter(os.Stderr, f))
		trimLog(filepath.Join(app.data, "backend.log"))
	}
	if raw, err := os.ReadFile(filepath.Join(app.dir, "build.json")); err == nil {
		_ = json.Unmarshal(raw, &app.build)
	}

	if len(os.Args) > 2 && os.Args[1] == "--dev" {
		// The Mac preview: listen, take one frontend at a time.
		_ = os.Remove(os.Args[2])
		ln, err := net.Listen("unix", os.Args[2])
		if err != nil {
			log.Fatal(err)
		}
		log.Printf("dev backend on %s", os.Args[2])
		for {
			conn, err := ln.Accept()
			if err != nil {
				log.Fatal(err)
			}
			app.t = &stream{r: bufio.NewReader(conn), w: conn}
			app.run()
			conn.Close()
		}
	}
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: entry <socket> | --dev <socket> | --hwr-test <strokes.json>")
		os.Exit(2)
	}
	conn, err := net.DialUnix("unixpacket", nil, &net.UnixAddr{Name: os.Args[1], Net: "unixpacket"})
	if err != nil {
		log.Fatalf("connect %s: %v", os.Args[1], err)
	}
	app.t = &seqpacket{conn: conn, buf: make([]byte, 1<<20)}
	app.run()
}

func (a *App) run() {
	a.auth = newAuth(a)
	a.sockets = newSockets(a)
	log.Printf("backend up: app %q, commit %s, origin %s", a.build.App, short(a.build.Commit), a.auth.origin())
	for {
		kind, body, err := a.t.read()
		if err != nil {
			log.Printf("frontend gone: %v", err)
			a.sockets.closeAll()
			return
		}
		if kind == typeRequest {
			a.handle(body)
		}
	}
}

func short(s string) string {
	if len(s) > 7 {
		return s[:7]
	}
	return s
}

// Keeps backend.log under about 1 MB.
func trimLog(path string) {
	info, err := os.Stat(path)
	if err != nil || info.Size() < 1<<20 {
		return
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return
	}
	_ = os.WriteFile(path, raw[len(raw)/2:], 0o600)
}

func atoi(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}
