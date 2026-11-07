import QtQuick

// A button for e-ink: black outline, inverts while pressed, no animation.
Rectangle {
    id: root
    property alias text: label.text
    property real u: 1
    property bool primary: false
    property bool enabled: true
    property real fontSize: 34 * u
    signal clicked

    implicitWidth: Math.max(label.implicitWidth + 64 * u, 120 * u)
    implicitHeight: 96 * u
    radius: 16 * u
    border.width: 4 * u
    border.color: enabled ? "black" : "#9a9a9a"
    color: area.pressed || primary ? (enabled ? "black" : "#9a9a9a") : "white"

    Text {
        id: label
        anchors.centerIn: parent
        font.pixelSize: root.fontSize
        font.bold: true
        color: area.pressed || root.primary ? "white" : (root.enabled ? "black" : "#9a9a9a")
    }
    MouseArea {
        id: area
        anchors.fill: parent
        anchors.margins: -12 * root.u
        enabled: root.enabled
        onClicked: root.clicked()
    }
}
