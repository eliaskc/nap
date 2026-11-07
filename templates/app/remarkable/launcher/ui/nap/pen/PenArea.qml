import QtQuick
import net.asivery.ApploadUtils
import "pencore.js" as PenCore

// Writing letters into cells with the pen, as the web games do with Apple Pencil (dle's
// src/components/crossword/pen.tsx, ported): ink while the pen is down; the letter belongs to
// the cell the pen first touched; it is read when the pen rests (pauseMs) or goes down in
// another cell. A scratch-out (back and forth) clears every cell it crosses. A pen tap picks a
// cell, and on the cursor's cell flips direction. With `rapid` (Wordle's pad), letters may go on
// top of each other or side by side as a word.
//
// The network runs in the backend (the same weights as the web); the geometry is the web's own
// code (pencore.js, from scripts/sync-pen). Every letter goes to the site's `pen-log` collection,
// with the same fields as the web's, so the handwriting data set grows from the tablet too.
//
// Put it over the cells. The page describes them with `cells()`:
//   [{ cell: <index>, x, y, w, h }] in this item's coordinates.
// Fingers are not the pen: a finger tap comes out as fingerTap(cell, x, y).
Item {
    id: root
    property var backend
    property real u: 1
    property bool enabled: true
    property bool paused: false
    property string game: ""
    property string board: ""
    /** The fixes are for this cell; -1 (Wordle, no cursor): the last cell written or tapped. */
    property int cursorCell: -1
    property bool rapid: false
    /** The site's pen-log collection, or null not to log. */
    property var log: null
    property bool debug: false

    property var cells: function () { return [] }
    property var writable: function (cell) { return true }
    property var answer: function (cell) { return "" }
    property var value: function (cell) { return "" }
    /** null clears. May return the cell the letter really went to, or -1 when there is no room. */
    property var write: function (cell, letter) { return cell }

    signal begin(int cell)
    signal flip(int cell)
    signal fingerTap(int cell, real x, real y)
    /** The pen came down: pages put their on-screen keys away. */
    signal penUsed()

    readonly property int pauseMs: 450
    readonly property real reach: 0.12
    readonly property real tapReach: 0.12
    readonly property int tapMs: 300
    readonly property int rapidSure: 300
    readonly property int rapidMin: 150
    readonly property real rapidP: 0.9
    readonly property string startsOthers: "CDFILNPVX"

    // ---- State
    property var current: null      // the letter being written: { id, cell, strokes, startedAt, lastUp, wasCursor }
    property var pending: []        // letters being recognized: their ink stays, lighter
    property var boxes: []
    property var written: ({})      // cell → { event, id, saved, writtenAt, to }
    property var fixable: ({})      // cell → { letter, guesses, totalMs }
    property int focusCell: -1
    property bool drawing: false
    property int fixVersion: 0
    property var guessCache: null   // { strokes: n, best } recognition of `current` so far

    readonly property int fixCell: cursorCell >= 0 ? cursorCell : focusCell
    /** The other guesses for the letter in fixCell, best first, without the one it shows. */
    readonly property var fixChoices: {
        fixVersion
        var info = fixable[fixCell]
        var shown = fixCell >= 0 ? value(fixCell) : ""
        if (!info || !shown || drawing || paused || !enabled) return []
        return info.guesses.filter(function (g) { return g.letter !== shown })
    }
    readonly property var fixInfo: { fixVersion; return fixable[fixCell] || null }

    function now() { return Date.now() }

    // ---- Geometry
    function measure() { boxes = cells() || []; return boxes }
    function cellSize() { return boxes.length ? boxes[0].w : 60 * u }
    function inside(p, b, pad) { return p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad }
    function cellAt(p) {
        var best = -1, bestDistance = Infinity
        for (var i = 0; i < boxes.length; i++) {
            var b = boxes[i]
            if (inside(p, b, 0)) return b.cell
            var dx = Math.max(b.x - p.x, 0, p.x - b.x - b.w), dy = Math.max(b.y - p.y, 0, p.y - b.y - b.h)
            var d = Math.hypot(dx, dy)
            if (d < bestDistance) { best = b.cell; bestDistance = d }
        }
        return bestDistance <= cellSize() * 0.15 ? best : -1
    }
    function boxOf(cell) { for (var i = 0; i < boxes.length; i++) if (boxes[i].cell === cell) return boxes[i]; return null }
    function nearCell(p, cell) { var b = boxOf(cell); return !!b && inside(p, b, b.w * reach) }
    function rightOf(p, letter) {
        var xs = [], ys = []
        letter.strokes.forEach(function (s) { s.forEach(function (q) { xs.push(q.x); ys.push(q.y) }) })
        var height = Math.max.apply(null, ys) - Math.min.apply(null, ys)
        return p.x > Math.max.apply(null, xs) + height * 0.05
    }
    function isTap(stroke) {
        var first = stroke[0], r = cellSize() * tapReach
        return stroke[stroke.length - 1].t - first.t < tapMs && stroke.every(function (p) { return Math.hypot(p.x - first.x, p.y - first.y) <= r })
    }
    function crossed(strokes, first) {
        var counts = {}, points = [].concat.apply([], strokes)
        points.forEach(function (p) { var c = cellAt(p); if (c >= 0) counts[c] = (counts[c] || 0) + 1 })
        var cellsHit = {}
        cellsHit[first] = true
        for (var c in counts) if (counts[c] >= Math.max(3, points.length * 0.08)) cellsHit[c] = true
        // Last first: in Wordle, clearing a letter moves the ones after it.
        return Object.keys(cellsHit).map(Number).sort(function (a, b) { return b - a })
    }

    // ---- Recognition (the backend runs the network)
    function aspect(strokes) {
        var xs = [], ys = []
        strokes.forEach(function (s) { s.forEach(function (p) { xs.push(p.x); ys.push(p.y) }) })
        var h = Math.max.apply(null, ys) - Math.min.apply(null, ys)
        return h ? (Math.max.apply(null, xs) - Math.min.apply(null, xs)) / h : 1
    }
    function recognize(strokes) {
        var started = now()
        return backend.call("hwr", { strokes: strokes.map(function (s) { return s.map(function (p) { return [p.x, p.y] }) }) })
            .then(function (r) {
                var probs = r.probs.slice()
                // A line that thin is an I (a capital L has its foot), as on the web.
                if (aspect(strokes) < 0.3) { probs[8] += probs[11]; probs[11] = 0 }
                return { guesses: PenCore.Core.ranked(probs), image: r.image, inferMs: r.inferMs, roundMs: now() - started }
            })
    }

    // ---- The log
    function newEventId() {
        var s = ""
        for (var i = 0; i < 12; i++) s += Math.floor(Math.random() * 36).toString(36)
        return "pen-" + Date.now().toString(36) + "-" + s
    }
    function save(entry, corrected) {
        if (!log) return
        var w = entry.saved
            ? log.patch(entry.id, { corrected: corrected || null })
            : log.put(entry.id, corrected ? Object.assign({}, entry.event, { corrected: corrected }) : entry.event)
        entry.saved = true
        w.catch(function (e) { console.warn("pen log:", e.message) })
    }
    /** The letter the pen wrote in `cell` became `to` some other way (a key, a chip, the pen again). */
    function correct(cell, to, how) {
        var entry = written[cell]
        if (!entry) return
        var shown = entry.to !== undefined ? entry.to : entry.event.letter
        var nowValue = value(cell)
        if (nowValue !== shown && !(how === "typed" && nowValue === "")) return
        if (to === shown) return
        entry.to = to === entry.event.letter ? undefined : to
        save(entry, entry.to === undefined ? null : { to: to, how: how, at: new Date().toISOString(), afterMs: Math.round(now() - entry.writtenAt) })
    }
    function compact(strokes, origin, cellPx, startedAt) {
        return strokes.map(function (s) { return s.map(function (p) {
            return [Math.round((p.x - origin.x) / cellPx * 100), Math.round((p.y - origin.y) / cellPx * 100), Math.round(p.t - startedAt)]
        }) })
    }

    function commit(letter, trigger) {
        if (current !== letter) return
        current = null
        guessCache = null
        commitTimer.stop()
        pending = pending.concat([letter])
        var waitMs = now() - letter.lastUp
        var strokes = letter.strokes.filter(function (s) { return s.length })
        var done = function () {
            pending = pending.filter(function (l) { return l !== letter })
            ink.redraw()
        }
        if (!strokes.length) { done(); return }
        var groups = rapid ? PenCore.Core.splitWord(strokes) : [strokes]
        if (groups.length > 1) {
            var chain = Promise.resolve()
            groups.forEach(function (group, i) {
                chain = chain.then(function () { return land(letter, group, i ? newEventId() : letter.id, "word", waitMs) })
            })
            chain.then(done, function (e) { console.warn("pen:", e.message); done() })
            return
        }
        var scratch = PenCore.Core.isScratch(strokes)
        recognize(strokes).then(function (result) {
            var hit = scratch ? crossed(strokes, letter.cell) : []
            if (scratch && (hit.length > 1 || result.guesses[0].p < 0.9)) {
                hit.forEach(function (cell) {
                    if (!writable(cell) || !value(cell)) return
                    correct(cell, "", "scratch")
                    write(cell, null)
                })
                return
            }
            return land(letter, strokes, letter.id, trigger, waitMs, result)
        }).then(done, function (e) { console.warn("pen:", e && e.message); done() })
    }

    function land(letter, strokes, id, trigger, waitMs, known) {
        var go = function (result) {
            var best = result.guesses[0].letter
            var before = value(letter.cell)
            var previous = written[letter.cell]
            if (previous && before === (previous.to !== undefined ? previous.to : previous.event.letter)) correct(letter.cell, best, "pen")
            var at = write(letter.cell, best)
            if (at === undefined || at === null) at = letter.cell
            if (at < 0) return
            var totalMs = now() - letter.lastUp
            var b = boxOf(letter.cell)
            var cellPx = b ? b.w : cellSize()
            var event = {
                v: 1,
                at: new Date().toISOString(),
                game: game,
                board: board,
                cell: at,
                answer: answer(at),
                letter: best,
                top: result.guesses.slice(0, 5).map(function (g) { return [g.letter, Math.round(g.p * 1000) / 1000] }),
                ms: { wait: Math.round(waitMs), infer: Math.round(result.inferMs * 10) / 10, total: Math.round(totalMs), writing: Math.round(letter.lastUp - letter.startedAt) },
                trigger: trigger,
                strokes: compact(strokes, { x: b ? b.x : 0, y: b ? b.y : 0 }, cellPx, letter.startedAt),
                cellPx: Math.round(cellPx * 10) / 10,
                image: result.image,
                device: "reMarkable",
                debug: debug
            }
            var entry = { event: event, id: id, saved: false, writtenAt: now() }
            written[at] = entry
            save(entry)
            fixable[at] = { letter: best, guesses: result.guesses, totalMs: totalMs }
            fixVersion++
            focusCell = at
        }
        return known ? Promise.resolve(go(known)) : recognize(strokes).then(go)
    }

    /** A fix from the choices (or the full list): writes it and logs it. */
    function pick(letter, how) {
        if (fixCell < 0) return
        correct(fixCell, letter, how || "chip")
        write(fixCell, letter)
        fixVersion++
    }
    /** Call before a key types `letter` into `cell`, so fixes by key are logged too. */
    function noteTyped(cell, letter) { correct(cell, letter, "typed") }
    /** `cell` became `letter` through another pen (Wordle's pad and board). */
    function note(cell, letter, how) { correct(cell, letter, how) }
    /** Forget the letters written so far (a new board). */
    function reset() { current = null; pending = []; written = {}; fixable = {}; focusCell = -1; fixVersion++; ink.redraw() }

    // ---- Input: the pen is a real mouse on the tablet; fingers are synthesized from touch.
    Timer { id: commitTimer; interval: root.pauseMs; property var letter: null; onTriggered: root.commit(letter, "pause") }

    function penDown(p) {
        measure()
        penUsed()
        var cell = cellAt(p)
        if (current && !(cell === current.cell || nearCell(p, current.cell))) commit(current, "next")
        else if (current && rapid && !rightOf(p, current)) {
            var gap = p.t - current.lastUp
            var next = gap >= rapidSure
            if (!next && gap >= rapidMin && guessCache && guessCache.strokes === current.strokes.length) {
                var best = guessCache.best
                next = best.p >= rapidP && startsOthers.indexOf(best.letter) < 0
            }
            if (next) commit(current, "gap")
        }
        if (!current) {
            if (cell < 0 || !writable(cell)) return false
            current = { id: newEventId(), cell: cell, strokes: [], startedAt: p.t, lastUp: p.t, wasCursor: cursorCell === cell }
            begin(cell)
        }
        commitTimer.stop()
        drawing = true
        current.strokes.push([p])
        ink.dot(p)
        return true
    }
    function penMove(p) {
        if (!current) return
        var stroke = current.strokes[current.strokes.length - 1]
        var last = stroke[stroke.length - 1]
        if (Math.abs(p.x - last.x) + Math.abs(p.y - last.y) < 1.5 * u) return
        stroke.push(p)
        ink.segment(last, p)
    }
    function penUp() {
        drawing = false
        var letter = current
        if (!letter) return
        letter.lastUp = now()
        if (letter.strokes.length === 1 && isTap(letter.strokes[0])) {
            current = null
            ink.redraw()
            if (letter.wasCursor) flip(letter.cell)
            focusCell = letter.cell
            return
        }
        // Read what is there so far, so a quick next stroke can tell whether it starts a new letter.
        if (rapid) {
            var n = letter.strokes.length
            recognize(letter.strokes).then(function (r) { if (current === letter && letter.strokes.length === n) guessCache = { strokes: n, best: r.guesses[0] } }, function () {})
        }
        commitTimer.letter = letter
        commitTimer.restart()
    }

    // Turning the pen off drops a letter in progress.
    onEnabledChanged: if (!enabled) { commitTimer.stop(); current = null; ink.redraw() }

    Canvas {
        id: ink
        anchors.fill: parent
        renderStrategy: Canvas.Immediate
        property var segs: []
        property bool full: true
        function segment(a, b) { segs.push([a, b]); requestPaint() }
        function dot(p) { segs.push([p, { x: p.x + 0.1, y: p.y }]); requestPaint() }
        function redraw() { full = true; segs = []; requestPaint() }
        onPaint: {
            var c = getContext("2d")
            c.lineCap = "round"; c.lineJoin = "round"
            c.lineWidth = Math.min(9 * root.u * 2, Math.max(5 * root.u, root.cellSize() * 0.06))
            if (full) {
                full = false
                c.clearRect(0, 0, width, height)
                var letters = root.pending.concat(root.current ? [root.current] : [])
                letters.forEach(function (letter) {
                    c.strokeStyle = letter === root.current ? "black" : "#8c8c8c"
                    letter.strokes.forEach(function (s) {
                        c.beginPath()
                        s.forEach(function (p, i) { if (i) c.lineTo(p.x, p.y); else c.moveTo(p.x, p.y) })
                        if (s.length === 1) c.lineTo(s[0].x + 0.1, s[0].y)
                        c.stroke()
                    })
                })
                return
            }
            c.strokeStyle = "black"
            c.beginPath()
            segs.forEach(function (s) { c.moveTo(s[0].x, s[0].y); c.lineTo(s[1].x, s[1].y) })
            c.stroke()
            segs = []
        }
        // AppLoad's fast e-ink mode for the ink, so it keeps up with the pen.
        DisplayMethodArea { anchors.fill: parent; displayMethod: DisplayMethodArea.Fast }
    }
    Connections { target: root; function onPendingChanged() { ink.redraw() } }

    MouseArea {
        anchors.fill: parent
        enabled: root.enabled && !root.paused
        // AppLoad's window gestures would take the pen; this keeps it here.
        preventStealing: true
        property bool finger: false
        property bool active: false
        onPressed: (m) => {
            finger = m.source !== Qt.MouseEventNotSynthesized
            if (finger) return
            active = root.penDown({ x: m.x, y: m.y, t: root.now() })
        }
        onPositionChanged: (m) => { if (!finger && active) root.penMove({ x: m.x, y: m.y, t: root.now() }) }
        onReleased: (m) => {
            if (finger) { root.measure(); root.fingerTap(root.cellAt({ x: m.x, y: m.y }), m.x, m.y); return }
            if (active) root.penUp()
            active = false
        }
        onCanceled: { if (!finger && active) root.penUp(); active = false }
    }
}
