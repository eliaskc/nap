import QtQuick
import net.asivery.AppLoad 1.0
import "napclient.js" as NapClient

// The launcher's line to its native backend (backend/, started by AppLoad): requests with
// replies as Promises, events, timers for JavaScript, and one Nap client per site.
Item {
    id: root
    property string appId: "nap"
    property bool ready: false
    signal event(var data)

    AppLoad {
        id: endpoint
        applicationID: root.appId
        onMessageReceived: (type, contents) => root.receive(type, contents)
    }

    property var pending: ({})
    property int nextId: 1
    property var parts: ({})
    property var socketListeners: ({})

    function receive(type, contents) {
        if (type === 4) {   // part of a big message: "<id>:<part>:<parts>:<type>:<data>"
            var at = 0, fields = []
            for (var i = 0; i < 4; i++) { var next = contents.indexOf(":", at); fields.push(contents.slice(at, next)); at = next + 1 }
            var key = fields[0], list = parts[key] || (parts[key] = [])
            list[+fields[1]] = contents.slice(at)
            var count = 0
            for (var j = 0; j < list.length; j++) if (list[j] !== undefined) count++
            if (count < +fields[2]) return
            delete parts[key]
            receive(+fields[3], list.join(""))
            return
        }
        var message
        try { message = JSON.parse(contents) } catch (e) { console.warn("backend: bad message", e); return }
        if (type === 2) {
            var waiter = pending[message.id]
            if (!waiter) return
            delete pending[message.id]
            if (message.ok) waiter.resolve(message.result)
            else {
                var error = new Error(message.error || "Backend error")
                error.status = message.status || 0
                error.code = message.code || ""
                waiter.reject(error)
            }
        } else if (type === 3) {
            if (message.event === "ws") {
                var listener = socketListeners[message.sid]
                if (listener) listener(message)
                return
            }
            root.event(message)
        }
    }

    /** A backend request (see backend/main.go). Resolves with its result. */
    function call(op, args) {
        return new Promise(function (resolve, reject) {
            var id = nextId++
            var body = Object.assign({}, args || {})
            body.id = id
            body.op = op
            pending[id] = { resolve: resolve, reject: reject }
            endpoint.sendMessage(1, JSON.stringify(body))
        })
    }

    function log(text) { call("log", { text: String(text) }).catch(function () {}) }

    // ---- Timers for JavaScript: QML's engine has no setTimeout.
    Component { id: timerComponent; Timer { repeat: false; property var fn } }
    property var timers: ({})
    property int timerSeq: 1
    function setTimeout(fn, ms) {
        var id = timerSeq++
        var t = timerComponent.createObject(root, { interval: Math.max(0, ms || 0) })
        t.fn = fn
        t.triggered.connect(function () {
            delete timers[id]
            var f = t.fn
            t.destroy()
            try { f() } catch (e) { console.warn("timer:", e, e && e.stack) }
        })
        timers[id] = t
        t.start()
        return id
    }
    function clearTimeout(id) {
        var t = id && timers[id]
        if (!t) return
        delete timers[id]
        t.stop()
        t.destroy()
    }

    property int idSeq: 1
    function newId(prefix) { return (prefix || "id") + "-" + Date.now().toString(36) + "-" + (idSeq++) }

    readonly property var env: ({
        call: function (op, args) { return root.call(op, args) },
        setTimeout: function (fn, ms) { return root.setTimeout(fn, ms) },
        clearTimeout: function (id) { root.clearTimeout(id) },
        onSocket: function (sid, fn) { root.socketListeners[sid] = fn; return function () { delete root.socketListeners[sid] } },
        newId: function (prefix) { return root.newId(prefix) }
    })

    // ---- One Nap client per site, shared by everything that opens it.
    property var clients: ({})
    function nap(site) {
        if (!clients[site]) clients[site] = NapClient.createNap(env, site)
        return clients[site]
    }
    function resumeAll() { for (var s in clients) clients[s].resume() }
    function closeAll() { for (var s in clients) clients[s].close(); clients = {} }

    function kvGet(key) { return call("kv.get", { key: key }) }
    function kvSet(key, value) { return call("kv.set", { key: key, value: value === undefined ? null : value }) }

    function terminate() { closeAll(); endpoint.terminate() }
}
