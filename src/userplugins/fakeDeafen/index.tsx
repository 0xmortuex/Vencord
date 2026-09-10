/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy, findComponentByCodeLazy } from "@webpack";
import { Menu } from "@webpack/common";

// Discord's own voice actions module ({ toggleSelfMute, toggleSelfDeaf, ... }).
// Only used to nudge the client into re-sending its voice state.
const VoiceActions = findByPropsLazy("toggleSelfMute", "toggleSelfDeaf");

// The round button Discord uses for mute / deafen in the account panel.
const PanelButton = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");

// Gateway opcode 4 - VOICE_STATE_UPDATE.
const OP_VOICE_STATE_UPDATE = 4;

// Your deafened state is not enforced server-side for display: the client
// announces it in the op 4 payload, and everyone else's client draws the icon
// from that field. Whether YOU hear anything is a separate, purely local
// decision made by Discord's audio engine. Rewriting the outgoing field alone
// makes others see you as deafened while your audio keeps working.
//
// Done by wrapping WebSocket#send rather than with a Vencord patch on Discord's
// sender: measured in Vex's Discord panel, the module holding the op 4 payload
// was not among the factories Vencord had proxied, so a patch there could never
// land. Wrapping the socket does not care when we load.
let originalSend: typeof WebSocket.prototype.send | null = null;

function rewrite(data: string): string {
    let parsed: any;
    try {
        parsed = JSON.parse(data);
    } catch {
        return data; // not JSON - leave it alone
    }

    if (parsed?.op !== OP_VOICE_STATE_UPDATE || parsed.d == null) return data;

    parsed.d.self_deaf = true;
    // Discord always mutes you when you deafen, so deafened-but-unmuted reads as
    // obviously forged. This only changes what others SEE - see the setting.
    if (settings.store.alsoAppearMuted) parsed.d.self_mute = true;

    return JSON.stringify(parsed);
}

function reannounce() {
    // Discord only emits a voice state update when something actually changes,
    // so flipping the setting on its own reaches nobody. Two self-mute toggles
    // land back on the original state and emit the updates that carry the
    // rewritten fields. playSoundEffect: false keeps it silent locally.
    try {
        VoiceActions.toggleSelfMute({ playSoundEffect: false });
        VoiceActions.toggleSelfMute({ playSoundEffect: false });
    } catch (err) {
        // Not in a voice channel, or the module moved: the new state still goes
        // out with the next real voice state change (join, mute, deafen).
        console.warn("[FakeDeafen] could not re-announce voice state:", err);
    }
}

const settings = definePluginSettings({
    fakeDeafen: {
        type: OptionType.BOOLEAN,
        description: "Appear deafened to everyone else while you can still hear the call",
        default: false,
        onChange: reannounce
    },
    alsoAppearMuted: {
        type: OptionType.BOOLEAN,
        description: "Also appear muted, which is what a real deafen looks like. This only changes what others SEE - your microphone still transmits unless you actually mute it.",
        default: true,
        onChange: reannounce
    }
});

const toggle = () => { settings.store.fakeDeafen = !settings.store.fakeDeafen; };

// Headphones, struck through while the spoof is on - the same visual language
// Discord uses for its own deafened state, so the button reads at a glance.
function Icon() {
    const { fakeDeafen } = settings.use(["fakeDeafen"]);

    return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path
                stroke={fakeDeafen ? "var(--status-danger)" : "currentColor"}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4 14v-2a8 8 0 0 1 16 0v2M4 14a2 2 0 0 1 2-2h1v6H6a2 2 0 0 1-2-2v-2Zm16 0a2 2 0 0 0-2-2h-1v6h1a2 2 0 0 0 2-2v-2Z"
            />
            {fakeDeafen && (
                <path stroke="var(--status-danger)" strokeWidth="2" strokeLinecap="round" d="M3 3l18 18" />
            )}
        </svg>
    );
}

function FakeDeafenToggleButton(props: { nameplate?: any; }) {
    const { fakeDeafen } = settings.use(["fakeDeafen"]);

    return (
        <PanelButton
            tooltipText={fakeDeafen ? "Fake deafen is ON - others see you deafened" : "Fake deafen is off"}
            icon={Icon}
            role="switch"
            aria-checked={fakeDeafen}
            redGlow={fakeDeafen}
            plated={props?.nameplate != null}
            onClick={toggle}
        />
    );
}

export default definePlugin({
    name: "FakeDeafen",
    description: "Adds a button next to mute and deafen that makes everyone else see you as deafened while you can still hear them.",
    authors: [{ name: "Fadi", id: 0n }],
    settings,

    // Inject the button into the account panel row that holds mute and deafen.
    // Anchored on handleToggleSelfDeaf (2 occurrences, same module) rather than
    // the DISPLAY_NAME_STYLES_COACHMARK string GameActivityToggle uses - that
    // one no longer appears in Discord's bundle at all, so its patch is dead.
    // If this one ever goes the same way the plugin still works: the toolbox
    // entry below and the setting both toggle the same flag.
    patches: [
        {
            find: "handleToggleSelfDeaf:",
            replacement: {
                match: /children:\[(?=.{0,25}?accountContainerRef)/,
                replace: "children:[$self.FakeDeafenToggleButton(arguments[0]),"
            }
        }
    ],

    toolboxActions() {
        const { fakeDeafen } = settings.use(["fakeDeafen"]);

        return (
            <Menu.MenuCheckboxItem
                id="fake-deafen-toggle-toolbox"
                label="Fake deafen"
                checked={fakeDeafen}
                action={toggle}
            />
        );
    },

    FakeDeafenToggleButton: ErrorBoundary.wrap(FakeDeafenToggleButton, { noop: true }),

    // Exposed so the rewrite can be checked from the console.
    rewriteForTesting: rewrite,

    start() {
        if (originalSend != null) return;
        originalSend = WebSocket.prototype.send;

        const original = originalSend;
        WebSocket.prototype.send = function (this: WebSocket, data: any) {
            if (settings.store.fakeDeafen && typeof data === "string") {
                try {
                    data = rewrite(data);
                } catch (err) {
                    // Never let a rewrite failure break the gateway.
                    console.warn("[FakeDeafen] rewrite failed, sending original:", err);
                }
            }
            return original.call(this, data);
        };
    },

    stop() {
        if (originalSend == null) return;
        WebSocket.prototype.send = originalSend;
        originalSend = null;
        // Everyone last heard a spoofed state - push the real one back out.
        if (settings.store.fakeDeafen) reannounce();
    }
});
