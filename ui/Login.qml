// SPDX-License-Identifier: MPL-2.0
import QtQuick
import QtQuick.Layouts
import Spool

// Signing in to a Jellyfin server: pick a server found on the network or type
// its address, then sign in with a password or a Quick Connect code.
FocusScope {
    id: root

    property var provider
    property string step: "server"
    property var servers: []
    property bool searching: false
    property bool busy: false
    property string error: ""
    property var server: ({})
    property string quickCode: ""
    property string quickSecret: ""

    readonly property var messages: ({
            "http_401": "That username and password didn't work",
            "invalid_credentials": "That username and password didn't work",
            "not_jellyfin": "That address isn't a Jellyfin server",
            "origin_denied": "That doesn't look like a server address",
            "network_error": "Couldn't reach that server",
            "operation_timeout": "The server took too long to answer"
        })

    function fail(code) {
        busy = false
        error = messages[code] || "Couldn't reach that server"
    }

    function discover() {
        searching = true
        provider.request("discover").then(result => {
            searching = false
            servers = result.servers || []
        }, () => searching = false)
    }

    // Same rule as normalizeServer() in logic/provider.mjs, so the origin
    // allowed here is the one requests go to.
    function normalized(input) {
        let text = String(input || "").trim().replace(/\/+$/, "")
        if (!/^https?:\/\//i.test(text))
            text = "http://" + text
        if (/^http:\/\/[^/:]+$/i.test(text))
            text += ":8096"
        return text
    }

    function connect(input) {
        if (String(input).trim().length === 0)
            return
        const address = normalized(input)
        busy = true
        error = ""
        provider.allowOrigin(address).then(() => provider.request("probe", { "server": address })).then(result => {
            busy = false
            server = result
            step = "account"
            Qt.callLater(() => (server.users || []).length > 0 ? InputKeys.focus(users) : usernameField.focusRow())
        }, fail)
    }

    function signIn(name, password) {
        busy = true
        error = ""
        provider.request("authenticate", { "server": server.server, "username": name, "password": password })
            .then(account => provider.complete(account), fail)
    }

    function startQuickConnect() {
        busy = true
        error = ""
        provider.request("quickConnectStart", { "server": server.server }).then(result => {
            busy = false
            quickCode = result.code
            quickSecret = result.secret
            step = "quick"
            poll.start()
        }, () => fail("quick_connect_off"))
    }

    function back() {
        if (step === "server")
            return false
        poll.stop()
        error = ""
        step = step === "quick" ? "account" : "server"
        return true
    }

    // Select on a row or button does what a click would.
    function activate() {
        const item = Window.activeFocusItem
        if (item && typeof item.activate === "function")
            item.activate()
        else if (item && typeof item.clicked === "function")
            item.clicked()
        else if (item && typeof item.accepted === "function")
            item.accepted()
    }

    Component.onCompleted: {
        messages["quick_connect_off"] = "Quick Connect is turned off on this server"
        discover()
        address.focusRow()
    }

    Timer {
        id: poll
        interval: 5000
        repeat: true
        onTriggered: root.provider.request("quickConnectPoll", { "server": root.server.server, "secret": root.quickSecret })
                     .then(result => {
                         if (result.authenticated) {
                             poll.stop()
                             root.provider.complete(result.account)
                         }
                     }, () => {})
    }

    Flickable {
        anchors.fill: parent
        contentHeight: column.implicitHeight + Metrics.pageMarginPx * 2
        boundsBehavior: Flickable.StopAtBounds
        clip: true

        ColumnLayout {
            id: column
            x: Math.max(Metrics.pageMarginPx, (parent.width - width) / 2)
            y: Metrics.pageMarginPx
            width: Math.min(root.width - Metrics.pageMarginPx * 2, Metrics.scaled(560))
            spacing: Metrics.scaled(12)

            AppText {
                Layout.fillWidth: true
                Layout.bottomMargin: Metrics.scaled(8)
                text: root.step === "server" ? "Choose your server" : root.step === "quick" ? "Quick Connect"
                                                                                           : root.server.name || "Sign in"
                font.pixelSize: Metrics.titleSizePx
                font.weight: Font.DemiBold
                elide: Text.ElideRight
            }

            // Server step
            Repeater {
                model: root.step === "server" ? root.servers : []
                delegate: ServerCard {
                    required property var modelData
                    Layout.fillWidth: true
                    title: modelData.name
                    serverAddress: modelData.address
                    status: "Connect"
                    onAccepted: root.connect(modelData.address)
                }
            }

            RowLayout {
                visible: root.step === "server" && root.searching && root.servers.length === 0
                spacing: Metrics.scaled(10)
                BusySpinner {
                    Layout.preferredWidth: Metrics.scaled(20)
                    Layout.preferredHeight: Metrics.scaled(20)
                    running: parent.visible
                }
                SecondaryText {
                    text: "Looking on your network…"
                    color: Theme.textMuted
                }
            }

            TextFieldRow {
                id: address
                Layout.fillWidth: true
                Layout.topMargin: Metrics.scaled(8)
                visible: root.step === "server"
                label: "Server address"
                placeholderText: "192.168.1.20 or jellyfin.example.com"
                inputMethodHints: Qt.ImhUrlCharactersOnly | Qt.ImhNoAutoUppercase | Qt.ImhNoPredictiveText
                onAccepted: root.connect(text)
            }

            ActionButton {
                Layout.alignment: Qt.AlignRight
                visible: root.step === "server"
                kind: "primary"
                text: root.busy ? "Connecting…" : "Connect"
                enabled: !root.busy && address.text.trim().length > 0
                onClicked: root.connect(address.text)
            }

            // Account step
            Flow {
                id: users
                Layout.fillWidth: true
                visible: root.step === "account" && (root.server.users || []).length > 0
                spacing: Metrics.scaled(16)
                Repeater {
                    model: users.visible ? root.server.users : []
                    delegate: ProfileTile {
                        required property var modelData
                        tileSize: Metrics.scaled(96)
                        username: modelData.name
                        onAccepted: {
                            usernameField.text = modelData.name
                            if (modelData.hasPassword)
                                passwordField.focusRow()
                            else
                                root.signIn(modelData.name, "")
                        }
                    }
                }
            }

            TextFieldRow {
                id: usernameField
                Layout.fillWidth: true
                visible: root.step === "account"
                label: "Username"
                inputMethodHints: Qt.ImhNoAutoUppercase | Qt.ImhNoPredictiveText
                onAccepted: passwordField.focusRow()
            }

            TextFieldRow {
                id: passwordField
                Layout.fillWidth: true
                visible: root.step === "account"
                label: "Password"
                echoMode: TextInput.Password
                onAccepted: root.signIn(usernameField.text, text)
            }

            RowLayout {
                Layout.fillWidth: true
                visible: root.step === "account"
                spacing: Metrics.scaled(10)
                ActionButton {
                    text: "Quick Connect"
                    kind: "flat"
                    iconName: "devices"
                    onClicked: root.startQuickConnect()
                }
                Item {
                    Layout.fillWidth: true
                }
                ActionButton {
                    kind: "primary"
                    text: root.busy ? "Signing in…" : "Sign in"
                    enabled: !root.busy && usernameField.text.trim().length > 0
                    onClicked: root.signIn(usernameField.text, passwordField.text)
                }
            }

            // Quick Connect step
            AppText {
                Layout.alignment: Qt.AlignHCenter
                Layout.topMargin: Metrics.scaled(12)
                visible: root.step === "quick"
                text: root.quickCode
                font.pixelSize: Metrics.scaled(56)
                font.weight: Font.DemiBold
                font.letterSpacing: Metrics.scaled(8)
            }

            SecondaryText {
                Layout.fillWidth: true
                visible: root.step === "quick"
                text: "Enter this code under Quick Connect in Jellyfin on a signed-in device."
                color: Theme.textMuted
                horizontalAlignment: Text.AlignHCenter
                wrapMode: Text.Wrap
            }

            SecondaryText {
                Layout.fillWidth: true
                visible: root.error.length > 0
                text: root.error
                color: Theme.errorText
                wrapMode: Text.Wrap
            }
        }
    }
}
