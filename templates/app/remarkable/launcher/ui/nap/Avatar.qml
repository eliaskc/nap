import QtQuick

// A person's look on Nap (src/lib/looks.ts): their shape, filled in their colour's grey, with
// initials. Each person on a Nap has their own shape and colour pair; on e-ink the colours are
// greys, so the shape does most of the telling apart.
Item {
    id: root
    property string name: ""
    property string shape: "circle"
    property string color: "blue"
    property real size: 64
    property bool outline: false
    width: size; height: size

    readonly property var paths: ({
        circle: ["M50 6A44 44 0 1 1 50 94A44 44 0 1 1 50 6Z", 51, 38],
        triangle: ["M50 8C57 8 61 13 65 20L93 70C99 82 93 92 79 92H21C7 92 1 82 7 70L35 20C39 13 43 8 50 8Z", 66, 30],
        cloud: ["M22 88A21 21 0 0 1 13 47A26 26 0 0 1 61 19A23 23 0 0 1 91 51A19 19 0 0 1 80 88Z", 60, 34],
        pill: ["M30 20H70A30 30 0 0 1 70 80H30A30 30 0 0 1 30 20Z", 51, 36],
        drop: ["M50 4C62 20 88 40 88 60A38 38 0 0 1 12 60C12 40 38 20 50 4Z", 62, 34],
        clover: ["M26.1 26.1A24 24 0 1 1 73.9 26.1A24 24 0 1 1 73.9 73.9A24 24 0 1 1 26.1 73.9A24 24 0 1 1 26.1 26.1Z", 51, 36],
        diamond: ["M50 4Q56 4 61 9L91 39Q96 44 96 50Q96 56 91 61L61 91Q56 96 50 96Q44 96 39 91L9 61Q4 56 4 50Q4 44 9 39L39 9Q44 4 50 4Z", 51, 32]
    })
    // Greys that stay apart on e-ink, darkest to lightest; initials go white on the dark ones.
    readonly property var greys: ({ blue: "#1a1a1a", red: "#3a3a3a", violet: "#555555", green: "#707070", brown: "#8a8a8a", pink: "#a6a6a6", orange: "#c2c2c2" })
    readonly property var look: paths[shape] || paths.circle
    readonly property string fill: greys[color] || "#555555"
    readonly property bool dark: ["blue", "red", "violet", "green"].indexOf(color) >= 0

    function initials(n) {
        var parts = String(n || "?").trim().split(/\s+/)
        return ((parts[0] || "?")[0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase()
    }

    // A Canvas, not a Shape: the tablet's interface renders in software, which has no Shapes.
    Canvas {
        id: canvas
        anchors.fill: parent
        renderStrategy: Canvas.Immediate
        onPaint: {
            var ctx = getContext("2d")
            ctx.reset()
            ctx.scale(width / 100, height / 100)
            ctx.path = root.look[0]
            ctx.fillStyle = root.outline ? "white" : root.fill
            ctx.fill()
            var line = root.outline ? 5 : (root.dark ? 0 : 2.5)
            if (line > 0) {
                ctx.lineWidth = line
                ctx.strokeStyle = "black"
                ctx.stroke()
            }
        }
        Connections {
            target: root
            function onShapeChanged() { canvas.requestPaint() }
            function onColorChanged() { canvas.requestPaint() }
            function onOutlineChanged() { canvas.requestPaint() }
            function onSizeChanged() { canvas.requestPaint() }
        }
    }
    Text {
        text: root.initials(root.name)
        color: root.outline || !root.dark ? "black" : "white"
        font.pixelSize: root.size * root.look[2] / 100
        font.bold: true
        anchors.horizontalCenter: parent.horizontalCenter
        y: root.size * root.look[1] / 100 - height / 2
    }
}
