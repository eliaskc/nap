package main

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"
)

// Handwritten capital letters, the same network the web games use on iPad: dle's
// src/lib/pen/recognizer.ts, ported line by line (rasterize, then the int8 CNN from
// public/pen/letters.bin). The geometry around it (scratch-outs, words, when a letter ends) runs
// in the frontend from that same file. tests/hwr parity checks the two agree.

const (
	size   = 28
	radius = 1.5
	super  = 4
)

type layer struct {
	out, inSize int
	scale, bias []float32
	w           []int8
}

var shapes = [][2]int{{32, 1 * 9}, {64, 32 * 9}, {128, 64 * 9}, {128, 128 * 3 * 3}, {26, 128}}

var (
	modelOnce sync.Once
	model     []layer
	modelErr  error
)

func loadModel(path string) ([]layer, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(raw) < 4 || string(raw[:4]) != "PEN1" {
		return nil, fmt.Errorf("not a pen model")
	}
	at := 4
	floats := func(n int) ([]float32, error) {
		if at+n*4 > len(raw) {
			return nil, fmt.Errorf("model is truncated")
		}
		out := make([]float32, n)
		for i := range out {
			out[i] = math.Float32frombits(binary.LittleEndian.Uint32(raw[at+i*4:]))
		}
		at += n * 4
		return out, nil
	}
	layers := make([]layer, len(shapes))
	for i, s := range shapes {
		out, in := s[0], s[1]
		scale, err := floats(out)
		if err != nil {
			return nil, err
		}
		bias, err := floats(out)
		if err != nil {
			return nil, err
		}
		if at+out*in > len(raw) {
			return nil, fmt.Errorf("model is truncated")
		}
		w := make([]int8, out*in)
		for j := range w {
			w[j] = int8(raw[at+j])
		}
		at += out * in
		layers[i] = layer{out: out, inSize: in, scale: scale, bias: bias, w: w}
	}
	return layers, nil
}

type point struct{ x, y float64 }

// rasterize draws the strokes into a 28×28 image, 0..1, rows first.
func rasterize(strokes [][]point) []float32 {
	out := make([]float32, size*size)
	minX, minY := math.Inf(1), math.Inf(1)
	maxX, maxY := math.Inf(-1), math.Inf(-1)
	n := 0
	for _, s := range strokes {
		for _, p := range s {
			minX, minY = math.Min(minX, p.x), math.Min(minY, p.y)
			maxX, maxY = math.Max(maxX, p.x), math.Max(maxY, p.y)
			n++
		}
	}
	if n == 0 {
		return out
	}
	extent := math.Max(math.Max(maxX-minX, maxY-minY), 1e-3)
	scale := (24 - 2*radius) / extent
	cx, cy := (minX+maxX)/2, (minY+maxY)/2
	hi := size * super
	r := float64(radius * super)
	buffer := make([]uint8, hi*hi)
	mapP := func(p point) (float64, float64) {
		return (14 + (p.x-cx)*scale) * super, (14 + (p.y-cy)*scale) * super
	}
	for _, stroke := range strokes {
		for i := range stroke {
			ax, ay := mapP(stroke[i])
			bx, by := mapP(stroke[min(i+1, len(stroke)-1)])
			x0 := max(0, int(math.Floor(math.Min(ax, bx)-r)))
			x1 := min(hi-1, int(math.Ceil(math.Max(ax, bx)+r)))
			y0 := max(0, int(math.Floor(math.Min(ay, by)-r)))
			y1 := min(hi-1, int(math.Ceil(math.Max(ay, by)+r)))
			dx, dy := bx-ax, by-ay
			len2 := dx*dx + dy*dy
			for y := y0; y <= y1; y++ {
				for x := x0; x <= x1; x++ {
					px := float64(x) + 0.5 - ax
					py := float64(y) + 0.5 - ay
					u := 0.0
					if len2 != 0 {
						u = math.Max(0, math.Min(1, (px*dx+py*dy)/len2))
					}
					ex, ey := px-u*dx, py-u*dy
					if ex*ex+ey*ey <= r*r {
						buffer[y*hi+x] = 1
					}
				}
			}
		}
	}
	box := make([]float32, size*size)
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			sum := 0
			for j := 0; j < super; j++ {
				for i := 0; i < super; i++ {
					sum += int(buffer[(y*super+j)*hi+x*super+i])
				}
			}
			box[y*size+x] = float32(float64(sum) / (super * super))
		}
	}
	k := [3]float64{0.25, 0.5, 0.25}
	tmp := make([]float32, size*size)
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			s := 0.0
			for i := -1; i <= 1; i++ {
				if xx := x + i; xx >= 0 && xx < size {
					s += k[i+1] * float64(box[y*size+xx])
				}
			}
			tmp[y*size+x] = float32(s)
		}
	}
	var maxV float32
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			s := 0.0
			for j := -1; j <= 1; j++ {
				if yy := y + j; yy >= 0 && yy < size {
					s += k[j+1] * float64(tmp[yy*size+x])
				}
			}
			out[y*size+x] = float32(s)
			if float32(s) > maxV {
				maxV = float32(s)
			}
		}
	}
	if maxV > 0 {
		for i := range out {
			out[i] = float32(math.Min(1, float64(out[i])/(float64(maxV)*0.85)))
		}
	}
	return out
}

// Output channels are split between the tablet's two cores.
func convReluPool(input []float32, cin, sz int, l layer) []float32 {
	half := sz / 2
	pooled := make([]float32, l.out*half*half)
	workers := min(2, runtime.NumCPU())
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(first int) {
			defer wg.Done()
			conv := make([]float32, sz*sz)
			for o := first; o < l.out; o += workers {
				convChannel(input, cin, sz, l, o, conv, pooled)
			}
		}(w)
	}
	wg.Wait()
	return pooled
}

func convChannel(input []float32, cin, sz int, l layer, o int, conv, pooled []float32) {
	area := sz * sz
	half := sz / 2
	for i := range conv {
		conv[i] = 0
	}
	wo := o * cin * 9
	for c := 0; c < cin; c++ {
		plane := c * area
		for ky := 0; ky < 3; ky++ {
			for kx := 0; kx < 3; kx++ {
				weight := float32(l.w[wo+c*9+ky*3+kx])
				if weight == 0 {
					continue
				}
				dy, dx := ky-1, kx-1
				y0, y1 := max(0, -dy), min(sz, sz-dy)
				x0, x1 := max(0, -dx), min(sz, sz-dx)
				for y := y0; y < y1; y++ {
					row := y * sz
					src := plane + (y+dy)*sz + dx
					// Slices, so the loop runs without bounds checks.
					out := conv[row+x0 : row+x1]
					in := input[src+x0 : src+x0+len(out)]
					for i := range out {
						out[i] += weight * in[i]
					}
				}
			}
		}
	}
	s, b := l.scale[o], l.bias[o]
	dst := o * half * half
	for y := 0; y < half; y++ {
		for x := 0; x < half; x++ {
			i := 2*y*sz + 2*x
			m := max(conv[i], conv[i+1], conv[i+sz], conv[i+sz+1])
			pooled[dst+y*half+x] = max(0, m*s+b)
		}
	}
}

func dense(input []float32, l layer, relu bool) []float32 {
	result := make([]float32, l.out)
	for o := 0; o < l.out; o++ {
		var sum float64
		row := o * l.inSize
		for i := 0; i < l.inSize; i++ {
			sum += float64(l.w[row+i]) * float64(input[i])
		}
		v := float32(sum*float64(l.scale[o]) + float64(l.bias[o]))
		if relu && v < 0 {
			v = 0
		}
		result[o] = v
	}
	return result
}

func classify(m []layer, image []float32) []float64 {
	x := convReluPool(image, 1, 28, m[0])
	x = convReluPool(x, 32, 14, m[1])
	x = convReluPool(x, 64, 7, m[2])
	x = dense(x, m[3], true)
	logits := dense(x, m[4], false)
	maxL := float32(math.Inf(-1))
	for _, v := range logits {
		maxL = max(maxL, v)
	}
	probs := make([]float64, len(logits))
	total := 0.0
	for i, v := range logits {
		probs[i] = math.Exp(float64(v - maxL))
		total += probs[i]
	}
	for i := range probs {
		probs[i] /= total
	}
	return probs
}

func (a *App) model() ([]layer, error) {
	modelOnce.Do(func() {
		model, modelErr = loadModel(filepath.Join(a.dir, "backend", "letters.bin"))
	})
	return model, modelErr
}

// The `hwr` op: strokes in any coordinates → the 26 probabilities, A to Z, and the image the
// network saw (one byte per pixel, base64, as the pen log keeps it).
func hwrOp(a *App, body []byte) (any, error) {
	var args struct {
		Strokes [][][2]float64 `json:"strokes"`
	}
	if err := json.Unmarshal(body, &args); err != nil {
		return nil, err
	}
	m, err := a.model()
	if err != nil {
		return nil, fmt.Errorf("handwriting model: %w", err)
	}
	started := time.Now()
	strokes := toStrokes(args.Strokes)
	image := rasterize(strokes)
	probs := classify(m, image)
	return map[string]any{
		"probs":   probs,
		"image":   encodeImage(image),
		"inferMs": float64(time.Since(started).Microseconds()) / 1000,
	}, nil
}

func toStrokes(raw [][][2]float64) [][]point {
	out := make([][]point, 0, len(raw))
	for _, s := range raw {
		if len(s) == 0 {
			continue
		}
		stroke := make([]point, len(s))
		for i, p := range s {
			stroke[i] = point{p[0], p[1]}
		}
		out = append(out, stroke)
	}
	return out
}

func encodeImage(image []float32) string {
	b := make([]byte, len(image))
	for i, v := range image {
		b[i] = byte(math.Round(math.Max(0, math.Min(1, float64(v))) * 255))
	}
	return base64.StdEncoding.EncodeToString(b)
}

// `entry --hwr-test <model> <cases.json>`: probabilities for each case, for the parity test.
func hwrTest(args []string) {
	if len(args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: entry --hwr-test <letters.bin> <cases.json>")
		os.Exit(2)
	}
	m, err := loadModel(args[0])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	raw, err := os.ReadFile(args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	var cases [][][][2]float64
	if err := json.Unmarshal(raw, &cases); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	results := make([]map[string]any, len(cases))
	for i, c := range cases {
		started := time.Now()
		image := rasterize(toStrokes(c))
		rasterMs := float64(time.Since(started).Microseconds()) / 1000
		probs := classify(m, image)
		results[i] = map[string]any{"probs": probs, "image": encodeImage(image), "ms": float64(time.Since(started).Microseconds()) / 1000, "rasterMs": rasterMs}
	}
	out, _ := json.Marshal(results)
	os.Stdout.Write(out)
}
