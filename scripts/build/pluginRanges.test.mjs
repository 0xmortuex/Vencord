/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Run: node scripts/build/pluginRanges.test.mjs
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { buildManifest, buildRuns, decodeSegments, lookupOwner, ownerOfSource, readPluginEntries } from "./pluginRanges.mjs";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const vlq = n => {
    let v = n < 0 ? ((-n) << 1) | 1 : n << 1;
    let s = "";
    do {
        let d = v & 31;
        v >>>= 5;
        if (v) d |= 32;
        s += B64[d];
    } while (v);
    return s;
};
/** lines: array of lines, each an array of [genCol, sourceIndex, srcLine, srcCol] (absolute values) */
const encode = lines => {
    let source = 0, srcLine = 0, srcCol = 0;
    return lines.map(segs => {
        let genCol = 0;
        return segs.map(([g, s, l, c]) => {
            const out = vlq(g - genCol) + vlq(s - source) + vlq(l - srcLine) + vlq(c - srcCol);
            genCol = g; source = s; srcLine = l; srcCol = c;
            return out;
        }).join(",");
    }).join(";");
};

// decoder: known values, including negative deltas and a multi-digit number
const mappings = encode([[[0, 0, 0, 0], [40, 1, 3, 9]], [[5, 2, 7, 1], [1000, 0, 2, 200]]]);
assert.deepEqual(decodeSegments(mappings), [[0, 0, 0], [0, 40, 1], [1, 5, 2], [1, 1000, 0]]);
assert.deepEqual(decodeSegments("A"), [[0, 0, -1]]);
assert.throws(() => decodeSegments("A!"), /Invalid character/);

// source -> owner
const nameByEntry = new Map([
    ["plugins/messageLogger", "MessageLogger"],
    ["plugins/_api/badges", "BadgeAPI"],
    ["plugins/oneFile.ts", "OneFile"],
    ["userplugins/vexBridge", "VexBridge"]
]);
assert.equal(ownerOfSource("../src/plugins/messageLogger/index.tsx", nameByEntry), "MessageLogger");
assert.equal(ownerOfSource("../src/plugins/messageLogger/deep/er/file.ts", nameByEntry), "MessageLogger");
assert.equal(ownerOfSource("../src/plugins/_api/badges/index.ts", nameByEntry), "BadgeAPI");
assert.equal(ownerOfSource("../src/plugins/oneFile.ts", nameByEntry), "OneFile");
assert.equal(ownerOfSource("..\\src\\userplugins\\vexBridge\\index.tsx", nameByEntry), "VexBridge");
assert.equal(ownerOfSource("../src/utils/misc.ts", nameByEntry), "");
assert.equal(ownerOfSource("../node_modules/react/index.js", nameByEntry), "");
assert.equal(ownerOfSource("../src/plugins/unknownHelper/x.ts", nameByEntry), "");

// runs and lookups over a known layout:
//   line 0: col 0 core(helper) | col 40 MessageLogger | col 90 unmapped continues | col 120 core
//   line 1: col 0 VexBridge   | col 30 BadgeAPI (a core-owned segment in between would be its own run)
const sources = ["../src/utils/misc.ts", "../src/plugins/messageLogger/index.tsx", "../src/userplugins/vexBridge/index.tsx", "../src/plugins/_api/badges/index.ts"];
const map = {
    sources,
    mappings: encode([[[0, 0, 0, 0], [40, 1, 0, 0], [120, 0, 5, 5]], [[0, 2, 0, 0], [30, 3, 0, 0]]])
};
// an unmapped (one-field) segment at line 0 col 90, inserted by hand: a leading delta of 50 from col 40
const withUnmapped = { sources, mappings: map.mappings.replace(vlq(80), vlq(50) + "," + vlq(30)) };
const built = buildRuns(withUnmapped, nameByEntry);
assert.deepEqual(built.owners, ["", "MessageLogger", "VexBridge", "BadgeAPI"]);
const manifest = { ...built };
assert.equal(lookupOwner(manifest, 0, 0), "");
assert.equal(lookupOwner(manifest, 0, 39), "");
assert.equal(lookupOwner(manifest, 0, 40), "MessageLogger");
assert.equal(lookupOwner(manifest, 0, 100), "MessageLogger");
assert.equal(lookupOwner(manifest, 0, 120), "");
assert.equal(lookupOwner(manifest, 0, 99999), "");
assert.equal(lookupOwner(manifest, 1, 0), "VexBridge");
assert.equal(lookupOwner(manifest, 1, 29), "VexBridge");
assert.equal(lookupOwner(manifest, 1, 30), "BadgeAPI");
assert.equal(lookupOwner(manifest, 50, 0), "BadgeAPI", "after the last run the last owner continues");
// three numbers per run, no run repeated for the same owner
assert.equal(built.runs.length % 3, 0);
for (let i = 3; i < built.runs.length; i += 3) assert.notEqual(built.runs[i + 2], built.runs[i - 1]);
assert.throws(() => buildRuns({ sources: ["a"], mappings: encode([[[0, 4, 0, 0]]]) }, nameByEntry), /does not list/);

// the manifest names the bundle it was made for
const bundle = Buffer.from("console.log(1)");
const m = buildManifest({ bundle: "dist/Vencord.js", bundleText: bundle, mapText: JSON.stringify(withUnmapped), nameByEntry });
assert.equal(m.schema, "vex-plugin-ranges/1");
assert.equal(m.bundle, "dist/Vencord.js");
assert.equal(m.bundleBytes, bundle.length);
assert.match(m.bundleSha256, /^[0-9a-f]{64}$/);
assert.throws(() => buildManifest({ bundle: "x", bundleText: bundle, mapText: "{}", nameByEntry }), /no sources or mappings/);

// the real source tree: every plugin folder resolves to a name, and this plugin is one of them
const real = await readPluginEntries("./src");
assert.ok(real.size > 5, "plugins found: " + real.size);
assert.equal(real.get("userplugins/vexBridge"), "VexBridge");

// the real build output, when there is one: every plugin the manifest names is a plugin the tree has
if (existsSync("dist/extension.js") && existsSync("dist/extension.js.map")) {
    const real2 = buildManifest({ bundle: "dist/Vencord.js", bundleText: readFileSync("dist/extension.js"), mapText: readFileSync("dist/extension.js.map", "utf8"), nameByEntry: real });
    const names = new Set(real.values());
    for (const o of real2.owners) if (o) assert.ok(names.has(o), "unknown owner " + o);
    assert.ok(real2.owners.length > 3 && real2.runs.length > 30, "a real bundle has many runs");
    console.log("real bundle: " + (real2.owners.length - 1) + " plugins, " + real2.runs.length / 3 + " runs");
}

console.log("pluginRanges: ok");
