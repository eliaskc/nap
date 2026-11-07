.pragma library
.import "polyfills.js" as Polyfills

// The Nap client for apps on the reMarkable: the same API as window.nap on the web
// (nap.db.collection, nap.channel, nap.me, nap.people, nap.fetch), for one site's data. It is a
// port of Nap's own client (src/client/db.ts and channel.ts) and keeps its behaviour: writes
// reach this page's subscribers at once, other people's arrive over the live socket, and
// polling the changes feed catches anything missed.
//
// The tablet cannot pass Cloudflare Access, so everything goes to /_nap/api/naps/<site>/...
// with the tablet's Nap token, through the backend (QML's own WebSocket cannot send it).
//
// QML's JavaScript has no async/await and no timers of its own: `env` brings them.
//   env.call(op, args) → Promise   a backend request (see backend/main.go)
//   env.setTimeout(fn, ms) / env.clearTimeout(id)
//   env.onSocket(sid, handler)      ws events for a socket id; returns stop
//   env.newId()                     unique ids

var NapError = function (message, status, document, code) {
    var error = new Error(message)
    error.name = "NapError"
    error.status = status || 0
    if (document !== undefined) error.document = document
    if (code) error.code = code
    return error
}

function backoff(attempt, base, max) {
    return Math.min(max, base * Math.pow(2, attempt)) * (0.5 + Math.random() / 2)
}

function emitTo(listeners, value) {
    listeners.forEach(function (listener) {
        try { listener(value) } catch (error) { console.warn("nap listener:", error, error && error.stack) }
    })
}

function query(params) {
    var parts = []
    for (var key in params) if (params[key] !== undefined && params[key] !== null)
        parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(params[key])))
    return parts.length ? "?" + parts.join("&") : ""
}

/** A WebSocket over the backend, with the browser's shape: onopen, onmessage, onclose, send, close. */
function BridgeSocket(env, path) {
    var self = this
    this.readyState = 0
    this.sid = env.newId("ws")
    this.onopen = null
    this.onmessage = null
    this.onclose = null
    var stop = env.onSocket(this.sid, function (event) {
        if (event.kind === "open") {
            self.readyState = 1
            if (self.onopen) self.onopen()
        } else if (event.kind === "message") {
            if (self.onmessage) self.onmessage({ data: event.data })
        } else if (event.kind === "close") {
            if (self.readyState === 3) return
            self.readyState = 3
            stop()
            if (self.onclose) self.onclose({ code: event.code || 1006, reason: event.reason || "" })
        }
    })
    this.send = function (text) {
        if (self.readyState !== 1) return false
        env.call("ws.send", { sid: self.sid, data: text }).catch(function () {})
        return true
    }
    this.close = function (code, reason) {
        if (self.readyState === 3) return
        var wasOpen = self.readyState
        self.readyState = 3
        stop()
        env.call("ws.close", { sid: self.sid }).catch(function () {})
        if (self.onclose) self.onclose({ code: code || 1000, reason: reason || "" })
    }
    env.call("ws.open", { sid: this.sid, path: path }).catch(function (error) {
        if (self.readyState === 3) return
        self.readyState = 3
        stop()
        if (self.onclose) self.onclose({ code: 1006, reason: String(error && error.message || error) })
    })
}

/** A response with fetch's shape, from the backend's http op. */
function makeResponse(result) {
    var body = result.body !== undefined ? result.body : null
    return {
        status: result.status,
        ok: result.status >= 200 && result.status < 300,
        url: result.url,
        headers: {
            get: function (name) { return result.headers ? result.headers[String(name).toLowerCase()] || null : null }
        },
        bodyBase64: result.bodyBase64 || null,
        text: function () { return Promise.resolve(body !== null ? body : (result.bodyBase64 ? Qt.atob(result.bodyBase64) : "")) },
        json: function () {
            return new Promise(function (resolve, reject) {
                try { resolve(JSON.parse(body !== null ? body : "null")) } catch (e) { reject(e) }
            })
        }
    }
}

/**
 * The client for one site, by its slug: the same data and channels as the web pages on
 * <slug>.<root domain>.
 */
function createNap(env, site) {
    var base = "/_nap/api/naps/" + encodeURIComponent(site) + "/"

    function http(method, url, headers, body) {
        return env.call("http", { method: method, url: url, headers: headers || {}, body: body === undefined ? null : body })
            .then(makeResponse)
    }

    function request(path, method, headers, data) {
        var body = data === undefined ? undefined : JSON.stringify(data)
        var h = headers || {}
        if (body !== undefined) h["content-type"] = "application/json"
        return http(method || "GET", base + "data/" + path, h, body).then(function (response) {
            if (response.status === 204) return undefined
            return response.json().catch(function () { return {} }).then(function (result) {
                if (!response.ok) {
                    throw NapError((result && (result.error || result.message)) || "Nap request failed (" + response.status + ")",
                                   response.status, result ? result.document : undefined, result && result.code)
                }
                return result
            })
        })
    }

    function conditions(options) {
        var headers = {}
        if (options && options.ifVersion != null) headers["if-match"] = '"' + options.ifVersion + '"'
        if (options && options.ifNew) headers["if-none-match"] = "*"
        return headers
    }

    function byNewest(a, b) {
        if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
    }

    // ---- Collections

    var subscribers = new Map()

    function publish(name, change) {
        var set = subscribers.get(name)
        if (set) set.forEach(function (subscriber) { subscriber.apply([change]) })
    }
    function eachSubscriber(callback) {
        subscribers.forEach(function (set) { set.forEach(callback) })
    }
    function hasSubscribers() {
        var any = false
        subscribers.forEach(function (set) { if (set.size) any = true })
        return any
    }

    var live = { socket: null, open: false, retries: 0, timer: null, ping: null, lastPong: 0 }

    function connectLive() {
        env.clearTimeout(live.timer)
        if (live.socket || !hasSubscribers()) return
        var socket = new BridgeSocket(env, base + "live")
        live.socket = socket
        socket.onopen = function () {
            live.open = true
            live.retries = 0
            live.lastPong = Date.now()
            schedulePing(socket)
            eachSubscriber(function (subscriber) { subscriber.poll() })
        }
        socket.onmessage = function (event) {
            if (event.data === "pong") { live.lastPong = Date.now(); return }
            var message
            try { message = JSON.parse(event.data) } catch (e) { return }
            if (message && message.type === "change") publish(message.collection, message.change)
        }
        socket.onclose = function (event) {
            env.clearTimeout(live.ping)
            var wasOpen = live.open
            if (live.socket === socket) live.socket = null
            live.open = false
            if (wasOpen) eachSubscriber(function (subscriber) { subscriber.poll() })
            if (event.code === 4403 || event.code === 4401 || !hasSubscribers()) return
            live.timer = env.setTimeout(connectLive, backoff(live.retries++, 1000, 30000))
        }
    }

    // The tablet sleeps: a socket that stops answering pings is dead, even if nobody said so.
    function schedulePing(socket) {
        env.clearTimeout(live.ping)
        live.ping = env.setTimeout(function () {
            if (live.socket !== socket) return
            if (Date.now() - live.lastPong > 75000) { socket.close(4000, "No answer"); return }
            socket.send("ping")
            schedulePing(socket)
        }, 30000)
    }

    function disconnectLive() {
        env.clearTimeout(live.timer)
        if (live.socket && !hasSubscribers()) live.socket.close(1000, "Unsubscribed")
    }

    function subscribe(name, changes, callback, options) {
        options = options || {}
        var interval = Math.max(Number(options.interval) || 3000, 1000)
        var documents = new Map()
        var deleted = new Map()
        var since = 0
        var loaded = false
        var stopped = false
        var timer = null
        var running = false

        var subscriber = {
            poll: function () { poll() },
            apply: function (list) {
                var changed = false
                list.forEach(function (change) {
                    var known = documents.get(change.id)
                    var knownVersion = known ? known.version : deleted.get(change.id) || 0
                    var version = change.version == null ? knownVersion + 1 : change.version
                    if (version <= knownVersion) return
                    if (change.deleted) {
                        documents.delete(change.id)
                        deleted.set(change.id, version)
                    } else {
                        documents.set(change.id, change)
                        deleted.delete(change.id)
                    }
                    changed = true
                })
                if (changed && loaded && !stopped) emit()
                return changed
            }
        }

        function emit() {
            try { callback(Array.from(documents.values()).sort(byNewest)) }
            catch (error) { console.warn("nap subscriber:", error, error && error.stack) }
        }

        function step() {
            return changes({ since: since, limit: 1000 }).then(function (page) {
                subscriber.apply(page.changes)
                since = page.since
                if (page.hasMore && !stopped) return step()
            })
        }

        function poll() {
            if (stopped || running) return
            running = true
            env.clearTimeout(timer)
            step().then(function () {
                if (!stopped && !loaded) { loaded = true; emit() }
            }, function (error) {
                if (options.onError) options.onError(error)
                else console.warn("nap poll " + name + ":", error && error.message)
            }).then(function () {
                running = false
                var wait = live.open ? Math.max(interval, 60000) : interval
                if (!stopped) timer = env.setTimeout(poll, wait)
            })
        }

        var set = subscribers.get(name)
        if (!set) subscribers.set(name, (set = new Set()))
        set.add(subscriber)
        poll()
        connectLive()

        return function unsubscribe() {
            stopped = true
            env.clearTimeout(timer)
            set.delete(subscriber)
            disconnectLive()
        }
    }

    function collection(name) {
        if (!/^[a-z][a-z0-9_-]{0,47}$/.test(name)) throw new TypeError("Invalid Nap collection name: " + name)
        var path = encodeURIComponent(name)
        var item = function (id) { return path + "/" + encodeURIComponent(id) }
        var saved = function (promise) {
            return promise.then(function (result) { publish(name, result.document); return result.document })
        }
        function changes(options) {
            options = options || {}
            return request(path + query({ since: options.since || 0, limit: options.limit }))
        }
        return Object.freeze({
            name: name,
            list: function (options) {
                options = options || {}
                return request(path + query({ limit: options.limit, cursor: options.cursor }))
            },
            get: function (id) { return request(item(id)).then(function (r) { return r.document }) },
            create: function (data) { return saved(request(path, "POST", {}, data)) },
            update: function (id, data, options) {
                var headers = options && options.ifVersion != null ? conditions(options) : { "if-match": "*" }
                return saved(request(item(id), "PUT", headers, data))
            },
            put: function (id, data, options) { return saved(request(item(id), "PUT", conditions(options), data)) },
            patch: function (id, data, options) { return saved(request(item(id), "PATCH", conditions(options), data)) },
            delete: function (id, options) {
                return request(item(id), "DELETE", conditions(options)).then(function () { publish(name, { id: id, deleted: true }) })
            },
            changes: changes,
            subscribe: function (callback, options) { return subscribe(name, changes, callback, options) }
        })
    }

    /** One document, or null when it does not exist. */
    function getDoc(name, id) {
        return collection(name).get(id).catch(function (error) {
            if (error.status === 404) return null
            throw error
        })
    }

    /**
     * Applies `change` to the newest version of a document and saves it, retrying when someone
     * else saved first (as dle's mutate on the web). `change` gets a copy of the data or null and
     * returns the next data, or undefined to do nothing.
     */
    function mutate(name, id, current, change) {
        var target = collection(name)
        var attempt = 0
        function tryOnce(doc) {
            var next = change(doc ? clone(doc.data) : null)
            if (next === undefined) return Promise.resolve(doc)
            var write = doc ? target.update(id, next, { ifVersion: doc.version }) : target.put(id, next, { ifNew: true })
            return write.catch(function (error) {
                if (error.status !== 409 || ++attempt >= 6) {
                    if (error.status === 409) throw NapError("Too many people changed this at once. Try again.", 409)
                    throw error
                }
                return tryOnce(error.document || null)
            })
        }
        return tryOnce(current || null)
    }

    /** Creates a document once; someone else creating it first is fine. */
    function ensureDoc(name, id, initial) {
        return collection(name).put(id, initial, { ifNew: true }).then(function () {}, function (error) {
            if (error.status !== 409) throw error
        })
    }

    // ---- Channels

    var channels = new Map()

    function channel(name) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) throw new TypeError("Invalid Nap channel name")
        var existing = channels.get(name)
        if (existing) return existing

        var listeners = { presence: new Set(), join: new Set(), leave: new Set(), message: new Set(), status: new Set(), error: new Set() }
        var peers = new Map()
        var socket = null
        var selfId = null
        var status = "connecting"
        var retries = 0
        var retryTimer = null
        var pingTimer = null
        var lastPong = 0
        var left = false
        var presence = null
        var hasPresence = false
        var presenceTimer = null
        var presenceSentAt = 0

        function emit(event, value) { emitTo(listeners[event], value) }
        function list() {
            return Array.from(peers.values()).sort(function (a, b) {
                return a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
            })
        }
        function peer(raw) { var p = Object.assign({}, raw); p.self = raw.id === selfId; return p }
        function setStatus(next) { if (status === next) return; status = next; emit("status", next) }
        function raw(message) {
            if (!socket || socket.readyState !== 1) return false
            socket.send(JSON.stringify(message))
            return true
        }
        function flushPresence() {
            presenceTimer = null
            presenceSentAt = Date.now()
            raw({ t: "presence", state: presence })
        }
        function ping(current) {
            env.clearTimeout(pingTimer)
            pingTimer = env.setTimeout(function () {
                if (socket !== current) return
                if (Date.now() - lastPong > 75000) { current.close(4000, "No answer"); return }
                current.send("ping")
                ping(current)
            }, 30000)
        }

        function connect() {
            if (left) return
            setStatus("connecting")
            var current = new BridgeSocket(env, base + "channel/" + name)
            socket = current
            current.onopen = function () { lastPong = Date.now(); ping(current) }
            current.onmessage = function (event) {
                if (event.data === "pong") { lastPong = Date.now(); return }
                lastPong = Date.now()
                var message
                try { message = JSON.parse(event.data) } catch (e) { return }
                if (message.t === "welcome") {
                    selfId = message.id
                    retries = 0
                    peers.clear()
                    ;(message.peers || []).forEach(function (p) { peers.set(p.id, peer(p)) })
                    if (hasPresence) {
                        var me = peers.get(message.id)
                        if (me) me.state = presence
                        flushPresence()
                    }
                    setStatus("open")
                    emit("presence", list())
                } else if (message.t === "join") {
                    var joined = peer(message.peer)
                    peers.set(joined.id, joined)
                    emit("join", joined)
                    emit("presence", list())
                } else if (message.t === "leave") {
                    var gone = peers.get(message.id)
                    if (!gone) return
                    peers.delete(message.id)
                    emit("leave", gone)
                    emit("presence", list())
                } else if (message.t === "presence") {
                    var changed = peers.get(message.id)
                    if (!changed) return
                    changed.state = message.state
                    emit("presence", list())
                } else if (message.t === "message") {
                    emit("message", { from: peers.get(message.from.id) || message.from, data: message.data })
                } else if (message.t === "error") {
                    emit("error", NapError(message.error, 400))
                }
            }
            current.onclose = function (event) {
                if (socket !== current) return
                env.clearTimeout(pingTimer)
                socket = null
                selfId = null
                var hadPeers = peers.size > 0
                peers.clear()
                if (hadPeers) emit("presence", [])
                if (left) return setStatus("closed")
                if (event.code === 4403 || event.code === 4401) {
                    setStatus("closed")
                    emit("error", NapError(event.reason || "Disconnected", 403))
                    return
                }
                setStatus("connecting")
                retryTimer = env.setTimeout(connect, backoff(retries++, 500, 15000))
            }
        }

        var api = {
            name: name,
            get id() { return selfId },
            get status() { return status },
            get peers() { return list() },
            get host() { return list()[0] || null },
            get isHost() { var first = list()[0]; return Boolean(first && first.self) },
            on: function (event, listener) {
                var set = listeners[event]
                if (!set) throw new TypeError("Unknown channel event: " + event)
                set.add(listener)
                return function () { set.delete(listener) }
            },
            send: function (data, options) { return raw({ t: "send", data: data, to: options && options.to }) },
            setPresence: function (state) {
                presence = state === undefined ? null : state
                hasPresence = true
                var me = selfId && peers.get(selfId)
                if (me) { me.state = presence; emit("presence", list()) }
                if (presenceTimer) return
                var wait = 50 - (Date.now() - presenceSentAt)
                if (wait <= 0) flushPresence()
                else presenceTimer = env.setTimeout(flushPresence, wait)
            },
            /** After the tablet wakes: drop a socket that may be dead and connect again. */
            reconnect: function () {
                if (left) return
                env.clearTimeout(retryTimer)
                if (socket) socket.close(4000, "Reconnect")
                else connect()
            },
            leave: function () {
                left = true
                env.clearTimeout(retryTimer)
                env.clearTimeout(pingTimer)
                if (presenceTimer) env.clearTimeout(presenceTimer)
                channels.delete(name)
                if (socket) socket.close(1000, "Left")
                else setStatus("closed")
            }
        }
        channels.set(name, api)
        connect()
        return api
    }

    // ---- People and fetch

    var mePromise = null
    function me() {
        if (!mePromise) {
            mePromise = http("GET", "/_nap/api/me").then(function (r) {
                return r.json().then(function (body) {
                    if (!r.ok) throw NapError(body.error || "Not signed in", r.status, undefined, body.code)
                    return body
                })
            })
            mePromise.catch(function () { mePromise = null })
        }
        return mePromise
    }

    function people(emails) {
        return http("GET", "/_nap/api/people" + (emails && emails.length ? query({ emails: emails.join(",") }) : ""))
            .then(function (r) { return r.json() })
            .then(function (body) { return body.people || body })
    }

    /**
     * Any URL, straight from the tablet (no CORS here, so no need for Nap's /_nap/fetch). Returns
     * a Response-like object: status, ok, headers.get, text(), json().
     */
    function fetch(url, options) {
        options = options || {}
        var headers = {}
        if (options.headers) for (var k in options.headers) headers[k] = options.headers[k]
        return env.call("http", {
            method: options.method || "GET",
            url: String(url),
            headers: headers,
            body: options.body === undefined || options.body === null ? null : String(options.body),
            binary: Boolean(options.binary)
        }).then(makeResponse)
    }

    /** After the tablet wakes up: reconnect sockets and catch up. */
    function resume() {
        if (live.socket) live.socket.close(4000, "Resume")
        else if (hasSubscribers()) connectLive()
        eachSubscriber(function (subscriber) { subscriber.poll() })
        channels.forEach(function (c) { c.reconnect() })
    }

    function close() {
        channels.forEach(function (c) { c.leave() })
        subscribers.clear()
        if (live.socket) live.socket.close(1000, "Closed")
        env.clearTimeout(live.timer)
    }

    return {
        site: site,
        db: { collection: collection },
        channel: channel,
        me: me,
        people: people,
        fetch: fetch,
        getDoc: getDoc,
        mutate: mutate,
        ensureDoc: ensureDoc,
        resume: resume,
        close: close,
        NapError: NapError
    }
}

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}
