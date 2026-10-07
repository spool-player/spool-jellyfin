// SPDX-License-Identifier: MPL-2.0
import Spool

ServerLogin {
    serviceName: "Jellyfin"
    setupContextOperation: "setupContext"
    codeLabel: "Quick Connect"
    codeStartOperation: "quickConnectStart"
    codePollOperation: "quickConnectPoll"
    codeInstructions: "Enter this code in Quick Connect on a signed-in device."
    codeEnabledField: "quickConnectEnabled"
    codeAvailableField: "quickConnectAvailable"
    errorMessages: ({
                        not_jellyfin: "Not a Jellyfin server",
                        account_mismatch: "Sign in as the saved profile on its original server.",
                        quick_connect_off: "Quick Connect is off on this server"
                    })
}
