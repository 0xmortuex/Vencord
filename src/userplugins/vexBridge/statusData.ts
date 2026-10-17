/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * VexBridge: the pure part of the Discord status setter (Vex's opt-in "Discord status" feature, T3-062).
 * No Vencord or Discord imports, so it is tested on its own (statusData.test.mjs).
 *
 * Contract (schema `vex-status/1`, the file `vex-status.json` that Vex writes into the bridge folder):
 *   {
 *     "schema": "vex-status/1",
 *     "seq": 7,                     // strictly increasing; a command with seq <= the last one handled is ignored
 *     "issuedAt": 1760000000000,    // ms; a command older than 10 minutes is ignored (a leftover file is not replayed)
 *     "action": "set" | "clear",
 *     "text": "Playing Hades",      // set only: at most 128 characters, one line
 *     "emojiName": "<one emoji>",   // set only, optional: ONE unicode emoji (custom emoji are not supported)
 *     "expiresAt": 1760003600000    // set only, optional: ms, must be in the future and within 7 days
 *   }
 * Only the status text, the emoji and the expiry travel. No token, no account data.
 */

export const STATUS_SCHEMA = "vex-status/1";
export const STATUS_FILE = "vex-status.json";
export const STATUS_LIMITS = { text: 128, emoji: 32, bytes: 4096, maxAgeMs: 10 * 60 * 1000, maxExpiryMs: 7 * 24 * 60 * 60 * 1000 } as const;

export interface StatusSet {
    action: "set";
    seq: number;
    issuedAt: number;
    text: string;
    emojiName: string;
    expiresAt: number;
}

export interface StatusClear {
    action: "clear";
    seq: number;
    issuedAt: number;
}

export type StatusCommand = StatusSet | StatusClear;

/** The shape Discord keeps in the proto settings (`status.customStatus`); fixed64 fields are decimal strings. */
export interface CustomStatusProto {
    text: string;
    emojiId: string;
    emojiName: string;
    expiresAtMs: string;
    createdAtMs: string;
}


const CONTROL = /[\u0000-\u001f\u007f]/;
const EMOJI = /^\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*$/u;

/** Parses and validates one command. Throws an Error that says what is wrong; never returns a partial command. */
export function parseStatusCommand(raw: string, now: number): StatusCommand {
    if (typeof raw !== "string" || raw.length > STATUS_LIMITS.bytes) throw new Error("VexBridge status: the command file is missing or too big");
    let o: any;
    try {
        o = JSON.parse(raw);
    } catch (e) {
        throw new Error("VexBridge status: the command file is not valid JSON");
    }
    if (!o || typeof o !== "object" || o.schema !== STATUS_SCHEMA) throw new Error(`VexBridge status: the schema must be ${STATUS_SCHEMA}`);
    if (!Number.isSafeInteger(o.seq) || o.seq < 1) throw new Error("VexBridge status: seq must be a positive integer");
    if (!Number.isFinite(o.issuedAt)) throw new Error("VexBridge status: issuedAt must be a number");
    if (now - o.issuedAt > STATUS_LIMITS.maxAgeMs) throw new Error("VexBridge status: the command is too old to be applied");

    if (o.action === "clear") return { action: "clear", seq: o.seq, issuedAt: o.issuedAt };
    if (o.action !== "set") throw new Error('VexBridge status: action must be "set" or "clear"');

    const text = typeof o.text === "string" ? o.text.trim() : "";
    if (CONTROL.test(text)) throw new Error("VexBridge status: the text must be one line without control characters");
    if ([...text].length > STATUS_LIMITS.text) throw new Error(`VexBridge status: the text is longer than ${STATUS_LIMITS.text} characters`);

    let emojiName = "";
    if (o.emojiName != null && o.emojiName !== "") {
        if (typeof o.emojiName !== "string" || o.emojiName.length > STATUS_LIMITS.emoji || !EMOJI.test(o.emojiName)) {
            throw new Error("VexBridge status: emojiName must be a single unicode emoji");
        }
        emojiName = o.emojiName;
    }
    if (!text && !emojiName) throw new Error("VexBridge status: a status needs a text or an emoji");

    let expiresAt = 0;
    if (o.expiresAt != null && o.expiresAt !== 0) {
        if (!Number.isFinite(o.expiresAt) || o.expiresAt <= now) throw new Error("VexBridge status: expiresAt must be in the future");
        if (o.expiresAt - now > STATUS_LIMITS.maxExpiryMs) throw new Error("VexBridge status: expiresAt is more than 7 days away");
        expiresAt = Math.floor(o.expiresAt);
    }
    return { action: "set", seq: o.seq, issuedAt: o.issuedAt, text, emojiName, expiresAt };
}

export function toProto(cmd: StatusSet, now: number): CustomStatusProto {
    return {
        text: cmd.text,
        emojiId: "0",
        emojiName: cmd.emojiName,
        expiresAtMs: String(cmd.expiresAt || 0),
        createdAtMs: String(now)
    };
}

/**
 * What to remember of the person's own status before Vex changes it, as plain data (no proto object is kept).
 * `null` means "there was no custom status".
 */
export function snapshot(cs: Partial<CustomStatusProto> | null | undefined): CustomStatusProto | null {
    if (!cs) return null;
    const text = String(cs.text ?? "");
    const emojiName = String(cs.emojiName ?? "");
    const emojiId = String(cs.emojiId ?? "0");
    if (!text && !emojiName && emojiId === "0") return null;
    return { text, emojiId, emojiName, expiresAtMs: String(cs.expiresAtMs ?? "0"), createdAtMs: String(cs.createdAtMs ?? "0") };
}

/** Is `current` still the status Vex applied? (Only then is it restored; a status the person changed by hand is left alone.) */
export function sameStatus(current: Partial<CustomStatusProto> | null | undefined, applied: CustomStatusProto): boolean {
    return !!current && String(current.text ?? "") === applied.text && String(current.emojiName ?? "") === applied.emojiName
        && String(current.emojiId ?? "0") === applied.emojiId;
}

/**
 * Is the status on screen still the one Vex put there? Also true when it was cleared by Discord itself because
 * the expiry passed (then there is nothing left, which is still Vex's doing).
 */
export function stillOurs(current: Partial<CustomStatusProto> | null | undefined, applied: CustomStatusProto, now: number): boolean {
    if (sameStatus(current, applied)) return true;
    const exp = Number(applied.expiresAtMs);
    return exp > 0 && now >= exp && snapshot(current) === null;
}

/**
 * A previous status that already ran out while Vex's status was on must not be brought back.
 * Returns the proto to restore, or null for "clear the custom status".
 */
export function restoreTarget(previous: CustomStatusProto | null, now: number): CustomStatusProto | null {
    if (!previous) return null;
    const exp = Number(previous.expiresAtMs);
    if (exp > 0 && exp <= now) return null;
    return previous;
}
