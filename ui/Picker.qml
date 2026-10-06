// SPDX-License-Identifier: MPL-2.0
pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Layouts
import Spool

FocusScope {
    id: root
    property var provider
    readonly property string kind: provider ? String(provider.arguments.kind || "") : ""
    Loader {
        anchors.fill: parent
        focus: true
        sourceComponent: root.kind === "downloadVariant" ? variants : actions
    }
    Component {
        id: actions
        ProviderActionPicker {
            provider: root.provider
            remoteControls: Component {
                ProviderRemoteControls {
                    provider: root.provider
                    textCommand: "SendString"
                    messageCommand: "DisplayMessage"
                }
            }
        }
    }
    Component {
        id: variants
        ColumnLayout {
            spacing: Metrics.scaled(12)
            Component.onCompleted: Qt.callLater(() => InputKeys.focus(list))
            AppText {
                Layout.fillWidth: true
                text: "Choose edition to download"
                font.pixelSize: Metrics.titleSizePx
                font.weight: Font.DemiBold
                wrapMode: Text.WordWrap
            }
            ListView {
                id: list
                Layout.fillWidth: true
                Layout.fillHeight: true
                clip: true
                model: root.provider.arguments.variants
                keyNavigationEnabled: true
                delegate: MenuRow {
                    required property var modelData
                    required property int index
                    width: ListView.view.width
                    label: modelData.label
                    detail: modelData.detail || "Unknown format"
                    highlighted: ListView.isCurrentItem && list.activeFocus
                    onHovered: list.currentIndex = index
                    onActivated: root.provider.complete({
                                                            variantId: modelData.id
                                                        })
                }
                function activate() {
                    if (currentItem)
                        currentItem.activated()
                }
            }
            ActionButton {
                Layout.alignment: Qt.AlignRight
                text: "Cancel"
                kind: "flat"
                onClicked: root.provider.close()
            }
        }
    }
}
