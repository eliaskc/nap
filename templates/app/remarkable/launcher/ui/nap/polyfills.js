.pragma library

// What QML's JavaScript (Qt 6.10) lacks and the shared web code uses. Installed once, for every
// script in the app.

function define(target, name, value) {
    if (target[name]) return
    try { Object.defineProperty(target, name, { value: value, configurable: true, writable: true }) }
    catch (e) { console.warn("polyfill", name, e) }
}

define(Array.prototype, "at", function (i) {
    i = Math.trunc(i) || 0
    if (i < 0) i += this.length
    return this[i]
})
define(String.prototype, "at", function (i) {
    i = Math.trunc(i) || 0
    if (i < 0) i += this.length
    return this.charAt(i) || undefined
})
define(Array.prototype, "findLast", function (fn) {
    for (var i = this.length - 1; i >= 0; i--) if (fn(this[i], i, this)) return this[i]
    return undefined
})
define(Array.prototype, "findLastIndex", function (fn) {
    for (var i = this.length - 1; i >= 0; i--) if (fn(this[i], i, this)) return i
    return -1
})
define(Array.prototype, "toSorted", function (fn) { return this.slice().sort(fn) })
define(Array.prototype, "flat", function (depth) {
    depth = depth === undefined ? 1 : depth
    var out = []
    this.forEach(function (v) { if (Array.isArray(v) && depth > 0) out.push.apply(out, v.flat(depth - 1)); else out.push(v) })
    return out
})
define(Array.prototype, "flatMap", function (fn, self) { return this.map(fn, self).flat(1) })
// Every match of a global pattern, as a list (the web code only loops over them). The pattern
// itself runs: Qt gives a pattern's `source` with its slashes escaped twice, so a copy made from
// it matches something else.
define(String.prototype, "matchAll", function (pattern) {
    var out = [], m
    if (!pattern.global) { m = pattern.exec(this); return m ? [m] : out }
    var before = pattern.lastIndex
    pattern.lastIndex = 0
    while ((m = pattern.exec(this)) !== null) {
        out.push(m)
        if (m[0] === "") pattern.lastIndex++
    }
    pattern.lastIndex = before
    return out
})
define(String, "fromCodePoint", function () {
    var out = ""
    for (var i = 0; i < arguments.length; i++) {
        var c = arguments[i]
        if (c > 0xffff) { c -= 0x10000; out += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff)) }
        else out += String.fromCharCode(c)
    }
    return out
})
define(Object, "entries", function (o) { return Object.keys(o).map(function (k) { return [k, o[k]] }) })
define(Object, "values", function (o) { return Object.keys(o).map(function (k) { return o[k] }) })
define(Object, "hasOwn", function (o, k) { return Object.prototype.hasOwnProperty.call(o, k) })

function ready() { return true }
