package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Sockets are WebSockets to the Nap (/_nap/api/naps/<id>/live and /channel/<name>), opened for
// the frontend with the token. The frontend's client reconnects and resyncs, as Nap's web client
// does; this only carries text messages.
type Sockets struct {
	app  *App
	mu   sync.Mutex
	open map[string]*socket
}

type socket struct {
	conn   *websocket.Conn
	cancel context.CancelFunc
	send   chan string
}

func newSockets(app *App) *Sockets {
	return &Sockets{app: app, open: map[string]*socket{}}
}

func (s *Sockets) handle(op string, body []byte) (any, error) {
	var args struct {
		Sid  string `json:"sid"`
		Path string `json:"path"`
		Data string `json:"data"`
	}
	if err := json.Unmarshal(body, &args); err != nil {
		return nil, err
	}
	switch op {
	case "ws.open":
		if !strings.HasPrefix(args.Path, "/") {
			return nil, fmt.Errorf("WebSockets only go to the Nap")
		}
		s.openSocket(args.Sid, args.Path)
		return true, nil
	case "ws.send":
		s.mu.Lock()
		sock := s.open[args.Sid]
		s.mu.Unlock()
		if sock == nil {
			return false, nil
		}
		select {
		case sock.send <- args.Data:
			return true, nil
		default:
			return false, nil // the socket is stuck; the client's ping will notice
		}
	case "ws.close":
		s.closeSocket(args.Sid)
		return true, nil
	}
	return nil, fmt.Errorf("unknown op %q", op)
}

func (s *Sockets) openSocket(sid, path string) {
	s.closeSocket(sid)
	ctx, cancel := context.WithCancel(context.Background())
	sock := &socket{cancel: cancel, send: make(chan string, 64)}
	s.mu.Lock()
	s.open[sid] = sock
	s.mu.Unlock()

	go func() {
		defer cancel()
		closed := func(code int, reason string) {
			s.mu.Lock()
			if s.open[sid] == sock {
				delete(s.open, sid)
			}
			s.mu.Unlock()
			s.app.Event("ws", map[string]any{"sid": sid, "kind": "close", "code": code, "reason": reason})
		}
		origin := s.app.auth.origin()
		target := "ws" + strings.TrimPrefix(origin, "http") + path
		header := http.Header{}
		if token := s.app.auth.token(); token != "" {
			header.Set("authorization", "Bearer "+token)
		}
		dialCtx, dialCancel := context.WithTimeout(ctx, 15*time.Second)
		conn, res, err := websocket.Dial(dialCtx, target, &websocket.DialOptions{HTTPHeader: header, HTTPClient: httpClient})
		dialCancel()
		if err != nil {
			status := 0
			if res != nil {
				status = res.StatusCode
			}
			log.Printf("ws %s %s: %v", sid, path, err)
			if status == 401 {
				closed(4401, "unauthorized")
			} else {
				closed(1006, networkMessage(err))
			}
			return
		}
		conn.SetReadLimit(4 << 20)
		sock.conn = conn
		s.app.Event("ws", map[string]any{"sid": sid, "kind": "open"})

		go func() {
			for {
				select {
				case <-ctx.Done():
					return
				case text := <-sock.send:
					wctx, wcancel := context.WithTimeout(ctx, 10*time.Second)
					err := conn.Write(wctx, websocket.MessageText, []byte(text))
					wcancel()
					if err != nil {
						conn.Close(websocket.StatusGoingAway, "write failed")
						return
					}
				}
			}
		}()
		for {
			kind, data, err := conn.Read(ctx)
			if err != nil {
				code := int(websocket.CloseStatus(err))
				if code < 0 {
					code = 1006
				}
				closed(code, err.Error())
				return
			}
			if kind == websocket.MessageText {
				s.app.Event("ws", map[string]any{"sid": sid, "kind": "message", "data": string(data)})
			}
		}
	}()
}

func (s *Sockets) closeSocket(sid string) {
	s.mu.Lock()
	sock := s.open[sid]
	delete(s.open, sid)
	s.mu.Unlock()
	if sock == nil {
		return
	}
	if sock.conn != nil {
		sock.conn.Close(websocket.StatusNormalClosure, "closed")
	}
	sock.cancel()
}

func (s *Sockets) closeAll() {
	s.mu.Lock()
	ids := make([]string, 0, len(s.open))
	for id := range s.open {
		ids = append(ids, id)
	}
	s.mu.Unlock()
	for _, id := range ids {
		s.closeSocket(id)
	}
}
