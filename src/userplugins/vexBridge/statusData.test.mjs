/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Run: node --experimental-strip-types src/userplugins/vexBridge/statusData.test.mjs
import assert from "node:assert/strict";

import { parseStatusCommand, restoreTarget, sameStatus, snapshot, stillOurs, toProto } from "./statusData.ts";

const now = 1_760_000_000_000;
const base = { schema: "vex-status/1", seq: 3, issuedAt: now - 1000 };
const parse = o => parseStatusCommand(JSON.stringify({ ...base, ...o }), now);

// set
const set = parse({ action: "set", text: "  Playing Hades ", emojiName: "🎮", expiresAt: now + 3600_000 });
assert.deepEqual(set, { action: "set", seq: 3, issuedAt: now - 1000, text: "Playing Hades", emojiName: "🎮", expiresAt: now + 3600_000 });
assert.deepEqual(toProto(set, now), { text: "Playing Hades", emojiId: "0", emojiName: "🎮", expiresAtMs: String(now + 3600_000), createdAtMs: String(now) });
assert.equal(parse({ action: "set", text: "x" }).expiresAt, 0);
assert.equal(parse({ action: "set", emojiName: "👨‍💻" }).emojiName, "👨‍💻");
assert.deepEqual(parse({ action: "clear" }), { action: "clear", seq: 3, issuedAt: now - 1000 });

// rejections
const bad = (o, re) => assert.throws(() => parse(o), re);
bad({ action: "set" }, /text or an emoji/);
bad({ action: "set", text: "a\nb" }, /one line/);
bad({ action: "set", text: "x".repeat(129) }, /longer than 128/);
bad({ action: "set", text: "x", emojiName: "abc" }, /single unicode emoji/);
bad({ action: "set", text: "x", emojiName: ":smile:" }, /single unicode emoji/);
bad({ action: "set", text: "x", expiresAt: now - 1 }, /future/);
bad({ action: "set", text: "x", expiresAt: now + 8 * 86400_000 }, /7 days/);
bad({ action: "wipe" }, /set. or .clear/);
bad({ action: "clear", seq: 0 }, /positive integer/);
bad({ action: "clear", schema: "vex-status/2" }, /schema/);
bad({ action: "clear", issuedAt: now - 11 * 60_000 }, /too old/);
assert.throws(() => parseStatusCommand("{nope", now), /not valid JSON/);
assert.throws(() => parseStatusCommand("x".repeat(5000), now), /too big/);

// snapshot / restore
assert.equal(snapshot(null), null);
assert.equal(snapshot({ text: "", emojiName: "", emojiId: "0" }), null);
const prev = snapshot({ text: "Studying", emojiName: "📚", emojiId: "0", expiresAtMs: "0", createdAtMs: "5" });
assert.equal(prev.text, "Studying");
const applied = toProto(set, now);
assert.ok(sameStatus({ text: "Playing Hades", emojiName: "🎮", emojiId: "0" }, applied));
assert.ok(!sameStatus({ text: "changed", emojiName: "🎮", emojiId: "0" }, applied));
assert.ok(!sameStatus(null, applied));
// Discord cleared it itself after the expiry: still Vex's doing
assert.ok(stillOurs(null, applied, now + 3600_001));
assert.ok(!stillOurs(null, applied, now + 10));
assert.ok(!stillOurs({ text: "mine", emojiName: "", emojiId: "0" }, applied, now + 3600_001));
// a previous status that expired meanwhile is not brought back
assert.equal(restoreTarget(null, now), null);
assert.equal(restoreTarget({ ...prev, expiresAtMs: String(now - 1) }, now), null);
assert.equal(restoreTarget({ ...prev, expiresAtMs: String(now + 5) }, now).text, "Studying");
assert.equal(restoreTarget(prev, now).text, "Studying");

console.log("statusData: all checks passed");
