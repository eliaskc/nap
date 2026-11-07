import QtQuick

// Signing the tablet in to Nap with the device flow: a code and a QR code to open on a phone,
// where Cloudflare Access already knows the person. The backend polls and keeps the token.
Rectangle {
    id: root
    objectName: "signin"
    property var backend
    property real u: 1
    property string origin: ""
    property var start: null
    property string error: ""
    property bool busy: false
    color: "white"

    function begin() {
        busy = true
        error = ""
        start = null
        backend.call("auth.start", {}).then(function (result) {
            start = result
            busy = false
        }, function (e) {
            error = e.message
            busy = false
        })
    }
    Component.onCompleted: begin()
    Component.onDestruction: backend.call("auth.cancel", {}).catch(function () {})

    Connections {
        target: root.backend
        function onEvent(data) {
            if (data.event === "auth" && !data.signedIn && data.error) {
                root.error = data.error
                root.start = null
            }
        }
    }

    Column {
        anchors.centerIn: parent
        width: parent.width - 200 * u
        spacing: 40 * u

        Text {
            text: "Sign in to Nap"
            font.pixelSize: 72 * u
            font.bold: true
            anchors.horizontalCenter: parent.horizontalCenter
        }
        Text {
            width: parent.width
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.Wrap
            font.pixelSize: 34 * u
            text: root.start
                ? "Scan the code with your phone, or open " + root.start.shortUrl + " and check that it shows this code."
                : root.busy ? "Getting a code from " + root.origin.replace(/^https?:\/\//, "") + "…" : ""
        }

        Item {
            width: parent.width
            height: 620 * u
            visible: !!root.start
            // The QR code, drawn as squares; each row is a string of 1s and 0s.
            Item {
                id: qr
                readonly property var rows: root.start ? root.start.qr || [] : []
                readonly property int n: rows.length
                readonly property real cell: n ? Math.floor(560 * root.u / (n + 8)) : 1
                width: cell * (n + 8); height: width
                anchors.centerIn: parent
                Repeater {
                    model: qr.n * qr.n
                    Rectangle {
                        readonly property int r: Math.floor(index / qr.n)
                        readonly property int c: index % qr.n
                        visible: qr.rows[r].charAt(c) === "1"
                        x: (c + 4) * qr.cell; y: (r + 4) * qr.cell
                        width: qr.cell; height: qr.cell
                        color: "black"
                    }
                }
            }
        }

        Text {
            visible: !!root.start
            text: root.start ? root.start.userCode : ""
            font.pixelSize: 110 * u
            font.family: "Noto Sans Mono"
            font.bold: true
            font.letterSpacing: 8 * u
            anchors.horizontalCenter: parent.horizontalCenter
        }
        Text {
            visible: root.error !== ""
            width: parent.width
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.Wrap
            text: root.error
            font.pixelSize: 34 * u
        }
        Button {
            u: root.u
            visible: root.error !== "" || !!root.start
            text: root.error ? "Try again" : "New code"
            anchors.horizontalCenter: parent.horizontalCenter
            onClicked: root.begin()
        }
    }
}
