import QtQuick
import "nap"
import "nap/polyfills.js" as Polyfills
import "apps.js" as Registry

// The Nap launcher on the reMarkable (AppLoad). It signs the tablet in to Nap, lists the
// apps built into it (apps/<slug>/), opens them, and updates itself from Nap.
//
// An app's Main.qml gets `host` (see `host` below) and `u` (one pixel of the 1404 × 1872
// screen, so layouts scale in the Mac preview).
Rectangle {
    id: root
    anchors.fill: parent
    color: "white"

    signal close
    function unloading() {
        if (loader.item && loader.item.leave) loader.item.leave()
        backend.terminate()
    }

    readonly property real u: width / 1404
    property var hello: null
    property var me: null
    property bool signedIn: false
    property string opened: ""
    property var update: null
    property string updateState: ""   // "", "installing", "installed", or an error
    /** Preview hook: an app to open at start. */
    property string startApp: ""

    readonly property var napBackend: backend
    Backend {
        id: backend
        onEvent: (data) => {
            if (data.event === "auth") {
                root.signedIn = !!data.signedIn
                if (data.me) root.me = data.me
                if (!data.signedIn) { root.closeApp(); backend.closeAll() }
                else root.checkUpdate()
            }
        }
    }

    /** What apps get from the launcher. */
    readonly property var host: ({
        backend: backend,
        /** The Nap client for a site's data and channels (see nap/napclient.js). */
        nap: function (site) { return backend.nap(site) },
        me: function () { return root.me },
        kvGet: function (key) { return backend.kvGet(key) },
        kvSet: function (key, value) { return backend.kvSet(key, value) },
        setTimeout: function (fn, ms) { return backend.setTimeout(fn, ms) },
        clearTimeout: function (id) { backend.clearTimeout(id) },
        log: function (text) { backend.log(text) },
        close: function () { root.closeApp() },
        origin: function () { return root.hello ? root.hello.origin : "" }
    })

    Component.onCompleted: {
        backend.call("hello", {}).then(function (h) {
            root.hello = h
            root.signedIn = h.signedIn
            root.me = h.me
            if (h.signedIn) {
                backend.call("auth.me", {}).then(function (m) { if (m) root.me = m }, function () {})
                root.checkUpdate()
                if (root.startApp) root.openApp(root.startApp)
            }
        }, function (e) { console.warn("hello failed", e) })
    }

    function checkUpdate() {
        backend.call("update.check", {}).then(function (r) { root.update = r }, function () { root.update = null })
    }
    function installUpdate() {
        updateState = "installing"
        backend.call("update.install", {}).then(function () {
            updateState = "installed"
        }, function (e) { updateState = e.message })
    }

    function openApp(slug) {
        var entry = Registry.list.find(function (p) { return p.slug === slug })
        if (!entry) return
        opened = slug
        loader.setSource(Qt.resolvedUrl("../../apps/" + slug + "/Main.qml"), { host: root.host, u: root.u })
    }
    function closeApp() {
        if (loader.item && loader.item.leave) loader.item.leave()
        loader.source = ""
        opened = ""
    }

    // The tablet sleeps with the app open: when the clock jumps, sockets are dead. Reconnect.
    Timer {
        property real last: Date.now()
        interval: 5000; repeat: true; running: true
        onTriggered: {
            var now = Date.now()
            if (now - last > 20000) { backend.log("woke up after " + Math.round((now - last) / 1000) + " s"); backend.resumeAll() }
            last = now
        }
    }

    // ---- Signed out

    Loader {
        anchors.fill: parent
        active: root.hello !== null && !root.signedIn
        sourceComponent: SignIn { backend: root.napBackend; u: root.u; origin: root.hello ? root.hello.origin : "" }
    }

    // ---- Home: the apps

    Item {
        anchors.fill: parent
        visible: root.signedIn && root.opened === ""

        Item {
            id: header
            width: parent.width; height: 200 * u
            Text {
                x: 80 * u; anchors.verticalCenter: parent.verticalCenter
                text: "Nap"
                font.pixelSize: 96 * u
                font.bold: true
            }
            Row {
                anchors.right: parent.right; anchors.rightMargin: 80 * u
                anchors.verticalCenter: parent.verticalCenter
                spacing: 24 * u
                Text {
                    anchors.verticalCenter: parent.verticalCenter
                    text: root.me ? root.me.name || root.me.email : ""
                    font.pixelSize: 34 * u
                }
                Avatar {
                    anchors.verticalCenter: parent.verticalCenter
                    size: 88 * u
                    name: root.me ? root.me.name || root.me.email : ""
                    shape: root.me && root.me.shape || "circle"
                    color: root.me && root.me.color || "blue"
                    MouseArea { anchors.fill: parent; anchors.margins: -20 * u; onClicked: account.visible = !account.visible }
                }
            }
            Rectangle { anchors.bottom: parent.bottom; x: 80 * u; width: parent.width - 160 * u; height: 3 * u; color: "black" }
        }

        // An update from Nap.
        Rectangle {
            id: banner
            visible: root.update && root.update.available
            y: header.height + 40 * u; x: 80 * u
            width: parent.width - 160 * u; height: visible ? 150 * u : 0
            radius: 20 * u; border.width: 4 * u
            Column {
                anchors.left: parent.left; anchors.leftMargin: 40 * u
                anchors.verticalCenter: parent.verticalCenter
                width: parent.width - updateButton.width - 120 * u
                Text {
                    text: root.updateState === "installed" ? "Update installed" : "Update available"
                        + (root.update && root.update.live ? ": build " + root.update.live.buildNumber : "")
                    font.pixelSize: 36 * u; font.bold: true
                }
                Text {
                    width: parent.width; elide: Text.ElideRight
                    font.pixelSize: 28 * u
                    text: root.updateState === "installed" ? "Restart Nap to use it."
                        : root.updateState && root.updateState !== "installing" ? root.updateState
                        : root.update && root.update.live ? root.update.live.notes || "" : ""
                }
            }
            Button {
                id: updateButton
                u: root.u
                anchors.right: parent.right; anchors.rightMargin: 30 * u
                anchors.verticalCenter: parent.verticalCenter
                text: root.updateState === "installed" ? "Restart" : root.updateState === "installing" ? "Installing…" : "Install"
                enabled: root.updateState !== "installing"
                onClicked: root.updateState === "installed" ? backend.call("update.restart", {}) : root.installUpdate()
            }
        }

        Column {
            y: header.height + banner.height + 60 * u
            x: 80 * u
            width: parent.width - 160 * u
            spacing: 28 * u
            Repeater {
                model: Registry.list
                Rectangle {
                    width: parent.width; height: 200 * u
                    radius: 24 * u; border.width: 4 * u
                    color: tap.pressed ? "#e6e6e6" : "white"
                    Column {
                        anchors.left: parent.left; anchors.leftMargin: 48 * u
                        anchors.verticalCenter: parent.verticalCenter
                        width: parent.width - 96 * u
                        spacing: 8 * u
                        Text { text: modelData.title; font.pixelSize: 52 * u; font.bold: true }
                        Text { text: modelData.summary || ""; font.pixelSize: 30 * u; width: parent.width; elide: Text.ElideRight }
                    }
                    MouseArea { id: tap; anchors.fill: parent; onClicked: root.openApp(modelData.slug) }
                }
            }
        }

        Text {
            anchors.bottom: parent.bottom; anchors.bottomMargin: 40 * u
            anchors.horizontalCenter: parent.horizontalCenter
            font.pixelSize: 24 * u; color: "#666666"
            text: root.hello ? root.hello.origin.replace(/^https?:\/\//, "")
                + (root.hello.build && root.hello.build.commit ? " · " + root.hello.build.commit.slice(0, 7) : "") : ""
        }

        // Account: sign out, check for updates.
        Rectangle {
            id: account
            visible: false
            anchors.right: parent.right; anchors.rightMargin: 80 * u
            y: header.height - 10 * u
            width: 560 * u; height: accountColumn.height + 60 * u
            radius: 20 * u; border.width: 4 * u
            Column {
                id: accountColumn
                anchors.centerIn: parent
                spacing: 24 * u
                width: parent.width - 60 * u
                Text { text: root.me ? root.me.email : ""; font.pixelSize: 30 * u; width: parent.width; elide: Text.ElideRight }
                Button { u: root.u; width: parent.width; text: "Check for updates"; onClicked: { account.visible = false; root.updateState = ""; root.checkUpdate() } }
                Button { u: root.u; width: parent.width; text: "Sign out"; onClicked: { account.visible = false; backend.call("auth.signout", {}) } }
            }
        }
    }

    // ---- An app

    Loader {
        id: loader
        anchors.fill: parent
        visible: root.opened !== ""
        onStatusChanged: if (status === Loader.Error) { console.warn("app failed to load"); root.opened = "" }
    }
    Connections {
        target: loader.item
        ignoreUnknownSignals: true
        function onClose() { root.closeApp() }
    }
}
