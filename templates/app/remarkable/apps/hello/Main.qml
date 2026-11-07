import QtQuick
import "../../launcher/ui/nap"
import "../../launcher/ui/nap/pen"

// The template app. `host` is the launcher (see launcher/ui/Main.qml): host.nap(site) is
// the Nap client for a site's data and channels, host.me() the person, host.close() goes back.
Rectangle {
    id: root
    property var host
    property real u: 1
    signal close
    color: "white"

    property var letters: ["", "", "", "", ""]

    Text {
        x: 80 * u; y: 70 * u
        text: "‹ Nap"
        font.pixelSize: 40 * u
        MouseArea { anchors.fill: parent; anchors.margins: -30 * u; onClicked: root.close() }
    }

    Column {
        anchors.horizontalCenter: parent.horizontalCenter
        y: 260 * u
        spacing: 40 * u
        Avatar {
            anchors.horizontalCenter: parent.horizontalCenter
            size: 200 * u
            name: host.me() ? host.me().name : ""
            shape: host.me() && host.me().shape || "circle"
            color: host.me() && host.me().color || "blue"
        }
        Text {
            anchors.horizontalCenter: parent.horizontalCenter
            text: "Hello, " + (host.me() ? host.me().name.split(" ")[0] : "you") + "!"
            font.pixelSize: 72 * u; font.bold: true
        }
        Text {
            anchors.horizontalCenter: parent.horizontalCenter
            text: "Write a letter in each box with the pen."
            font.pixelSize: 36 * u
        }
    }

    Item {
        id: boxes
        width: 5 * 200 * u + 4 * 30 * u; height: 200 * u
        anchors.horizontalCenter: parent.horizontalCenter
        y: 900 * u
        Repeater {
            model: 5
            Rectangle {
                x: index * 230 * u; width: 200 * u; height: 200 * u
                radius: 16 * u; border.width: 4 * u
                Text { anchors.centerIn: parent; text: root.letters[index]; font.pixelSize: 120 * u; font.bold: true }
            }
        }
        PenArea {
            id: pen
            anchors.fill: parent
            backend: host.backend
            u: root.u
            game: "hello"
            cells: function () {
                var list = []
                for (var i = 0; i < 5; i++) list.push({ cell: i, x: i * 230 * root.u, y: 0, w: 200 * root.u, h: 200 * root.u })
                return list
            }
            value: function (cell) { return root.letters[cell] }
            write: function (cell, letter) {
                var next = root.letters.slice()
                next[cell] = letter || ""
                root.letters = next
                return cell
            }
        }
    }

    // The other guesses for the letter last written, to fix it.
    Row {
        anchors.horizontalCenter: parent.horizontalCenter
        y: 1180 * u
        spacing: 24 * u
        Repeater {
            model: pen.fixChoices.slice(0, 4)
            Rectangle {
                width: 110 * u; height: 110 * u; radius: 14 * u; border.width: 4 * u
                Text { anchors.centerIn: parent; text: modelData.letter; font.pixelSize: 56 * u; font.bold: true }
                Text { anchors.bottom: parent.bottom; anchors.horizontalCenter: parent.horizontalCenter; text: Math.round(modelData.p * 100) + "%"; font.pixelSize: 20 * u }
                MouseArea { anchors.fill: parent; onClicked: pen.pick(modelData.letter) }
            }
        }
    }
    Text {
        anchors.horizontalCenter: parent.horizontalCenter
        y: 1340 * u
        font.pixelSize: 28 * u; color: "#555555"
        text: pen.fixInfo ? "Read as " + pen.fixInfo.letter + " (" + Math.round(pen.fixInfo.guesses[0].p * 100) + "%), " + Math.round(pen.fixInfo.totalMs) + " ms after the pen lifted" : "Scribble over a box to clear it."
    }
}
