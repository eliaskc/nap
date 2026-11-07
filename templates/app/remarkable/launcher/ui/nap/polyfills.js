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
define(Object, "hasOwn", function (o, k) { return Object.prototype.hasOwnProperty.call(o, k) })

function ready() { return true }
