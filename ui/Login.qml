// SPDX-License-Identifier: MPL-2.0
import QtQuick
import QtQuick.Layouts
import Spool

// Signing in to a Jellyfin server: one found on the network or typed, then a
// user and password or a Quick Connect code.
FocusScope {
    id: root

    property var provider
    property bool validAddress: false
    property int validationGeneration: 0
    function validateAddress(input) {
        const generation = ++validationGeneration
        validAddress = false
        if (!String(input).trim() || !provider || provider.closed)
            return
        provider.request("serverCandidates", {
                             server: input
                         }).then(result => {
                             if (generation === validationGeneration)
                                 validAddress = result.servers && result.servers.length > 0
                         }, () => {})
    }
    property string step: "server"
    property var servers: []
    property bool busy: false
    property string error: ""
    property var server: ({})
    property string quickCode: ""
    property string quickSecret: ""
    property int connectionGeneration: 0
    property bool lanAvailable: false
    property bool lanSearching: false
    property int lanGeneration: 0
    property string lanStatus: ""

    function mergeServers(found) {
        const merged = servers.slice()
        const ids = new Set(merged.map(entry => entry.id))
        for (const entry of found) {
            if (!ids.has(entry.id)) {
                ids.add(entry.id)
                merged.push(entry)
            }
        }
        servers = merged
    }

    function cancelLocalSearch() {
        if (!lanSearching)
            return
        ++lanGeneration
        lanSearching = false
        lanStatus = "Search cancelled"
        if (provider && !provider.closed)
            provider.cancelLanDiscovery()
    }

    function searchLocalNetwork() {
        if (lanSearching || busy || step !== "server")
            return
        const generation = ++lanGeneration
        lanSearching = true
        lanStatus = "Searching local network…"
        error = ""
        let pages = 0
        const cursors = new Set()
        function next(cursor) {
            if (generation !== lanGeneration || provider.closed)
                return Promise.resolve()
            lanStatus = "Searching local network…"
            return provider.request("discoverMore", cursor ? {
                                                                 "cursor": cursor
                                                             } : {}).then(result => {
                                                                 if (generation !== lanGeneration || provider.closed)
                                                                     return
                                                                 ++pages
                                                                 mergeServers(result.servers || [])
                                                                 lanStatus = servers.length + " servers found"
                                                                 if (result.exhausted === true) {
                                                                     lanSearching = false
                                                                     return
                                                                 }
                                                                 if (typeof result.cursor !== "string" ||
                                                                         !result.cursor || cursors.has(result.cursor)
                                                                         || pages >= 512)
                                                                     throw "invalid_pagination"
                                                                 cursors.add(result.cursor)
                                                                 return next(result.cursor)
                                                             })
        }
        provider.request("discover").then(result => {
            if (generation === lanGeneration && !provider.closed)
                mergeServers(result.servers || [])
        }, () => {}).then(() => {
            if (generation !== lanGeneration || provider.closed)
                return
            if (!lanAvailable) {
                lanSearching = false
                lanStatus = servers.length + " servers found"
                return
            }
            lanStatus = "Waiting for local network permission"
            return provider.allowLanDiscovery().then(() => next(null))
        }).catch(code => {
            if (generation !== lanGeneration || provider.closed)
                return
            cancelLocalSearch()
            lanStatus = code === "cancelled" || code === "discovery_denied"
                    ? "Local search was not allowed. Use a discovered server or enter an address." :
                      "Local search failed. You can retry or enter a server address."
        })
    }

    readonly property var messages: ({
                                         "http_401": "Wrong username or password",
                                         "invalid_credentials": "Wrong username or password",
                                         "not_jellyfin": "Not a Jellyfin server",
                                         "invalid_server": "Not a server address",
                                         "origin_denied": "Not a server address",
                                         "quick_connect_off": "Quick Connect is off on this server"
                                     })

    function fail(code) {
        busy = false
        error = messages[code] || "Couldn't reach the server"
    }

    function connect(input) {
        if (String(input).trim().length === 0 || busy)
            return
        cancelLocalSearch()
        const generation = ++connectionGeneration
        busy = true
        error = ""
        // Validate in provider JS once. Grant each exact candidate only as it is
        // tried; explicit HTTPS addresses never produce an HTTP candidate.
        function attempt(candidates, index) {
            if (generation !== connectionGeneration)
                return Promise.resolve(null)
            const candidate = candidates[index]
            return provider.allowOrigin(candidate).then(() => {
                if (generation !== connectionGeneration)
                    return null
                return provider.request("probe", {
                                            "server": candidate
                                        }).then(result => result, code => {
                                            if (generation !== connectionGeneration)
                                                return null
                                            if (index + 1 < candidates.length)
                                                return attempt(candidates, index + 1)
                                            throw code
                                        })
            })
        }
        provider.request("serverCandidates", {
                             "server": input
                         }).then(result => attempt(result.servers, 0)).then(result => {
                             if (generation !== connectionGeneration || !result)
                                 return
                             busy = false
                             server = result
                             step = "account"
                             Qt.callLater(() => (server.users || []).length > 0 ? InputKeys.focus(users) : usernameField.focusRow(
                                                                                      ))
                         }, code => {
                             if (generation === connectionGeneration)
                                 fail(code)
                         })
    }

    function retryAvailability() {
        if (busy)
            return
        const generation = connectionGeneration
        busy = true
        error = ""
        provider.request("probe", {
                             "server": server.server
                         }).then(result => {
                             if (generation !== connectionGeneration)
                                 return
                             busy = false
                             server = result
                         }, code => {
                             if (generation === connectionGeneration)
                                 fail(code)
                         })
    }

    function signIn(name, password) {
        busy = true
        error = ""
        provider.request("authenticate", {
                             "server": server.server,
                             "username": name,
                             "password": password
                         }).then(account => provider.complete(account), fail)
    }

    function startQuickConnect() {
        if (busy || server.quickConnectEnabled !== true)
            return
        poll.stop()
        quickCode = ""
        busy = true
        error = ""
        const generation = connectionGeneration
        provider.request("quickConnectStart", {
                             "server": server.server
                         }).then(result => {
                             if (generation !== connectionGeneration || provider.closed)
                                 return
                             busy = false
                             quickCode = result.code
                             quickSecret = result.secret
                             Qt.callLater(() => quickSection.visible && quickSection.forceActiveFocus())
                             poll.start()
                         }, () => {
                             if (generation === connectionGeneration && !provider.closed)
                                 fail("quick_connect_off")
                         })
    }

    function back() {
        if (lanSearching) {
            cancelLocalSearch()
            return true
        }
        if (step === "server")
            return false
        poll.stop();
        ++connectionGeneration
        busy = false
        error = ""
        quickCode = ""
        quickSecret = ""
        step = "server"
        return true
    }

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
        provider.request("discover").then(result => {
            if (!provider.closed)
                mergeServers(result.servers || [])
        }, () => {})
        provider.request("extensionStatus").then(result => {
            lanAvailable = !provider.closed && result.enabled && result.enabled["spool.lan-probe"] === 1
        }, () => {})
        Qt.callLater(address.focusRow)
    }

    Component.onDestruction: cancelLocalSearch()

    Connections {
        target: root.provider
        function onClosedChanged() {
            if (root.provider.closed) {
                root.cancelLocalSearch()
                root.lanAvailable = false
            }
        }
    }

    Timer {
        id: poll
        interval: 5000
        repeat: true
        onTriggered: root.provider.request("quickConnectPoll", {
                                               "server": root.server.server,
                                               "secret": root.quickSecret
                                           }).then(result => {
                                               if (result.authenticated) {
                                                   poll.stop()
                                                   root.provider.complete(result.account)
                                               }
                                           }, () => {})
    }

    Timer {
        id: addressValidation
        interval: 150
        onTriggered: root.validateAddress(address.text)
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

            SecondaryText {
                Layout.fillWidth: true
                text: "Independent Spool integration for Jellyfin"
                wrapMode: Text.Wrap
            }

            CompatibilityNotice {
                Layout.fillWidth: true
                provider: root.provider
            }

            AppText {
                Layout.fillWidth: true
                Layout.bottomMargin: Metrics.scaled(8)
                visible: root.step === "account"
                text: root.server.name || ""
                font.pixelSize: Metrics.titleSizePx
                font.weight: Font.DemiBold
                elide: Text.ElideRight
            }

            Repeater {
                model: root.step === "server" ? root.servers : []
                delegate: ServerCard {
                    required property var modelData
                    Layout.fillWidth: true
                    title: modelData.name
                    serverAddress: modelData.address
                    onAccepted: root.connect(modelData.address)
                }
            }

            ActionButton {
                Layout.alignment: Qt.AlignLeft
                visible: root.step === "server"
                enabled: !root.busy
                text: root.lanSearching ? "Cancel local search" : "Search local network"
                kind: "flat"
                onClicked: root.lanSearching ? root.cancelLocalSearch() : root.searchLocalNetwork()
            }

            SecondaryText {
                Layout.fillWidth: true
                visible: root.step === "server" && root.lanStatus.length > 0
                text: root.lanStatus
                wrapMode: Text.Wrap
            }

            TextFieldRow {
                id: address
                onTextChanged: {
                    root.validAddress = false
                    addressValidation.restart()
                }
                Layout.fillWidth: true
                visible: root.step === "server"
                label: "Server"
                placeholderText: "192.168.1.20"
                inputMethodHints: Qt.ImhUrlCharactersOnly | Qt.ImhNoAutoUppercase | Qt.ImhNoPredictiveText
                onAccepted: root.connect(text)
            }

            ActionButton {
                Layout.alignment: Qt.AlignRight
                visible: root.step === "server"
                kind: "primary"
                text: "Connect"
                enabled: !root.busy && root.validAddress
                onClicked: root.connect(address.text)
            }

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
                Item {
                    Layout.fillWidth: true
                }
                ActionButton {
                    kind: "primary"
                    text: "Sign in"
                    enabled: !root.busy && usernameField.text.trim().length > 0
                    onClicked: root.signIn(usernameField.text, passwordField.text)
                }
            }

            ActionButton {
                Layout.alignment: Qt.AlignLeft
                visible: root.step === "account" && root.server.quickConnectAvailable === false
                enabled: !root.busy
                text: "Retry Quick Connect availability"
                kind: "flat"
                onClicked: root.retryAvailability()
            }

            ActionButton {
                id: quickSection
                Layout.alignment: Qt.AlignLeft
                Layout.topMargin: Metrics.scaled(20)
                visible: root.step === "account" && root.server.quickConnectEnabled === true
                enabled: !root.busy
                text: root.quickCode ? "Get a new Quick Connect code" : "Quick Connect"
                kind: "secondary"
                iconName: "devices"
                onClicked: root.startQuickConnect()
            }

            AppText {
                Layout.alignment: Qt.AlignHCenter
                Layout.topMargin: Metrics.scaled(12)
                visible: root.step === "account" && root.quickCode.length > 0
                text: root.quickCode
                font.pixelSize: Metrics.scaled(56)
                font.weight: Font.DemiBold
                font.letterSpacing: Metrics.scaled(8)
            }

            SecondaryText {
                Layout.fillWidth: true
                visible: root.step === "account" && root.quickCode.length > 0
                text: "Enter this code in Quick Connect on a signed-in device"
                color: Theme.textMuted
                horizontalAlignment: Text.AlignHCenter
                wrapMode: Text.Wrap
            }

            BusySpinner {
                Layout.alignment: Qt.AlignHCenter
                Layout.preferredWidth: Metrics.scaled(24)
                Layout.preferredHeight: Metrics.scaled(24)
                running: root.busy
                visible: running
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
