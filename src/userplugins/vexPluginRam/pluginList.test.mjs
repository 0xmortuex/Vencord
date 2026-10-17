/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Run: node --experimental-strip-types src/userplugins/vexPluginRam/pluginList.test.mjs
import assert from "node:assert/strict";

import { buildList, checkToggle } from "./pluginList.ts";

const plugins = {
    Core: { name: "Core", required: true, requiresRestart: true },
    Api: { name: "Api", hidden: true, requiresRestart: false },
    Logger: { name: "Logger", requiresRestart: true, dependencies: ["Api"] },
    Viewer: { name: "Viewer", requiresRestart: false, dependencies: ["Logger", "Api"] },
    Idle: { name: "Idle", requiresRestart: false },
    VexPluginRam: { name: "VexPluginRam", requiresRestart: false },
    VexBridge: { name: "VexBridge", requiresRestart: false }
};
const on = new Set(["Core", "Api", "Logger", "Viewer", "VexPluginRam"]);
const rows = buildList(plugins, n => on.has(n));
const by = n => rows.find(r => r.name === n);

assert.deepEqual(rows.map(r => r.name), ["Api", "Core", "Idle", "Logger", "VexBridge", "VexPluginRam", "Viewer"], "sorted by name");
assert.equal(by("Core").canDisable, false);
assert.match(by("Core").reason, /Vencord needs it/);
assert.equal(by("Api").canDisable, false);
assert.deepEqual(by("Api").neededBy, ["Logger", "Viewer"], "only ENABLED dependents count");
assert.equal(by("Logger").canDisable, false);
assert.match(by("Logger").reason, /Viewer/);
assert.equal(by("Viewer").canDisable, true);
assert.equal(by("Viewer").requiresRestart, false);
assert.equal(by("Idle").enabled, false);
assert.equal(by("Idle").canDisable, true);
assert.equal(by("VexPluginRam").canDisable, false);
assert.equal(by("VexBridge").canDisable, false);
assert.deepEqual(by("Viewer").dependsOn, ["Logger", "Api"]);

// a plugin needed only by one that is OFF can be turned off
const on2 = new Set(["Logger", "Api"]);
const rows2 = buildList(plugins, n => on2.has(n));
assert.equal(rows2.find(r => r.name === "Logger").canDisable, true);

assert.equal(checkToggle(rows, "Viewer", false).name, "Viewer");
assert.throws(() => checkToggle(rows, "Logger", false), /cannot be turned off: these plugins need it: Viewer/);
assert.throws(() => checkToggle(rows, "Nope", false), /no Vencord plugin called "Nope"/);
assert.throws(() => checkToggle(rows, "Viewer", "no"), /true or false/);
assert.equal(checkToggle(rows, "Logger", true).name, "Logger", "switching on is always allowed (putting back)");
assert.equal(checkToggle(rows, "Core", true).name, "Core");

console.log("pluginList: ok");
