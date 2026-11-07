// rminput drives a reMarkable 2 from a script, for testing on the device: finger taps on the
// touchscreen and pen strokes on the digitizer, in screen pixels (1404 × 1872, portrait).
//
//	rminput info
//	rminput tap <x> <y>
//	rminput pen <x,y> <x,y> ... [-ms 8]   one stroke through the points
//	rminput swipe <x1> <y1> <x2> <y2>
package main

import (
	"encoding/binary"
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const (
	evSyn = 0x00
	evKey = 0x01
	evAbs = 0x03

	absX        = 0x00
	absY        = 0x01
	absPressure = 0x18
	absDistance = 0x19
	absMtSlot   = 0x2f
	absMtMajor  = 0x30
	absMtX      = 0x35
	absMtY      = 0x36
	absMtTrack  = 0x39
	absMtPress  = 0x3a
	btnToolPen  = 0x140
	btnTouch    = 0x14a
)

type absInfo struct{ Value, Min, Max, Fuzz, Flat, Res int32 }

func absRange(f *os.File, code int) absInfo {
	var info absInfo
	req := uintptr(uint32(0x80184540) + uint32(code)) // EVIOCGABS(code)
	syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), req, uintptr(unsafe.Pointer(&info)))
	return info
}

func emit(f *os.File, typ, code uint16, value int32) {
	var buf [16]byte
	now := time.Now()
	binary.LittleEndian.PutUint32(buf[0:], uint32(now.Unix()))
	binary.LittleEndian.PutUint32(buf[4:], uint32(now.Nanosecond()/1000))
	binary.LittleEndian.PutUint16(buf[8:], typ)
	binary.LittleEndian.PutUint16(buf[10:], code)
	binary.LittleEndian.PutUint32(buf[12:], uint32(value))
	f.Write(buf[:])
}
func syn(f *os.File) { emit(f, evSyn, 0, 0) }

const W, H = 1404.0, 1872.0

func open(path string) *os.File {
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	return f
}

// The touchscreen (pt_mt): x as on screen, y from the bottom.
func touchXY(f *os.File, x, y float64) (int32, int32) {
	rx, ry := absRange(f, absMtX), absRange(f, absMtY)
	return int32(x / W * float64(rx.Max)), int32(float64(ry.Max) - y/H*float64(ry.Max))
}

// The digitizer (Wacom): rotated, its x runs up the screen and its y across it.
func penXY(f *os.File, x, y float64) (int32, int32) {
	rx, ry := absRange(f, absX), absRange(f, absY)
	px := int32((1 - y/H) * float64(rx.Max))
	py := int32(x / W * float64(ry.Max))
	return px, py
}

var tracking int32 = 1000

func touch(f *os.File, pts [][2]float64, step time.Duration) {
	tracking++
	for i, p := range pts {
		x, y := touchXY(f, p[0], p[1])
		if i == 0 {
			emit(f, evAbs, absMtSlot, 0)
			emit(f, evAbs, absMtTrack, tracking)
		}
		emit(f, evAbs, absMtX, x)
		emit(f, evAbs, absMtY, y)
		emit(f, evAbs, absMtPress, 80)
		emit(f, evAbs, absMtMajor, 10)
		syn(f)
		time.Sleep(step)
	}
	emit(f, evAbs, absMtSlot, 0)
	emit(f, evAbs, absMtTrack, -1)
	syn(f)
}

func pen(f *os.File, pts [][2]float64, step time.Duration) {
	x0, y0 := penXY(f, pts[0][0], pts[0][1])
	emit(f, evKey, btnToolPen, 1)
	emit(f, evAbs, absX, x0)
	emit(f, evAbs, absY, y0)
	emit(f, evAbs, absDistance, 10)
	syn(f)
	time.Sleep(step)
	for i, p := range pts {
		x, y := penXY(f, p[0], p[1])
		emit(f, evAbs, absX, x)
		emit(f, evAbs, absY, y)
		emit(f, evAbs, absPressure, 2500)
		emit(f, evAbs, absDistance, 0)
		if i == 0 {
			emit(f, evKey, btnTouch, 1)
		}
		syn(f)
		time.Sleep(step)
	}
	emit(f, evAbs, absPressure, 0)
	emit(f, evKey, btnTouch, 0)
	syn(f)
	time.Sleep(step)
	emit(f, evKey, btnToolPen, 0)
	syn(f)
}

func num(s string) float64 { v, _ := strconv.ParseFloat(s, 64); return v }

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: rminput info | tap x y | swipe x1 y1 x2 y2 | pen x,y x,y ... [-ms n]")
		os.Exit(2)
	}
	step := 8 * time.Millisecond
	args := []string{}
	for i := 2; i < len(os.Args); i++ {
		if os.Args[i] == "-ms" && i+1 < len(os.Args) {
			step = time.Duration(num(os.Args[i+1])) * time.Millisecond
			i++
			continue
		}
		args = append(args, os.Args[i])
	}
	switch os.Args[1] {
	case "info":
		t, p := open("/dev/input/event2"), open("/dev/input/event1")
		fmt.Printf("touch x %+v y %+v\npen x %+v y %+v\n", absRange(t, absMtX), absRange(t, absMtY), absRange(p, absX), absRange(p, absY))
	case "raw": // raw <device> type code value ... (then SYN)
		f := open(args[0])
		for i := 1; i+2 < len(args); i += 3 {
			emit(f, uint16(num(args[i])), uint16(num(args[i+1])), int32(num(args[i+2])))
		}
		syn(f)
	case "tap":
		f := open("/dev/input/event2")
		x, y := num(args[0]), num(args[1])
		j := float64(time.Now().UnixNano()%3) - 1
		touch(f, [][2]float64{{x + j, y}, {x, y + j}}, 30*time.Millisecond)
	case "swipe":
		f := open("/dev/input/event2")
		pts := [][2]float64{}
		for k := 0; k <= 20; k++ {
			t := float64(k) / 20
			pts = append(pts, [2]float64{num(args[0]) + (num(args[2])-num(args[0]))*t, num(args[1]) + (num(args[3])-num(args[1]))*t})
		}
		touch(f, pts, 15*time.Millisecond)
	case "pen":
		f := open("/dev/input/event1")
		pts := [][2]float64{}
		for _, a := range args {
			xy := strings.Split(a, ",")
			pts = append(pts, [2]float64{num(xy[0]), num(xy[1])})
		}
		pen(f, pts, step)
	}
}
