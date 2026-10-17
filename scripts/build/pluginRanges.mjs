/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// @ts-check

/*
 * Which plugin owns which part of the web/extension bundle (dist/Vencord.js in the unpacked extension).
 *
 * The Vex browser measures the memory its Discord panel allocates with Chromium's own sampling heap profiler. A
 * sample says "this much was allocated by the function at line L, column C of the Vencord bundle"; the bundle is
 * minified, so a line number alone means nothing. This module turns the build's own source map into a small file,
 * dist/vencord-plugin-ranges.json, that answers "who owns line L, column C":
 *
 *   {
 *     "schema": "vex-plugin-ranges/1",
 *     "bundle": "dist/Vencord.js",       the file in the unpacked extension the numbers refer to
 *     "bundleBytes": 654847,             size and sha256 of that file: a manifest for another build is refused
 *     "bundleSha256": "...",
 *     "owners": ["", "MessageLogger", ...],   owner 0 is "" = Vencord core and libraries (not a plugin)
 *     "runs": [line, col, owner, line, col, owner, ...]   0-based, sorted; each run lasts until the next one starts
 *   }
 *
 * It reads source paths only (no source text, no settings, no token) and writes numbers and plugin names.
 */

import { createHash } from "crypto";
import { readdir } from "fs/promises";

import { exists, resolvePluginName } from "./common.mjs";

export const RANGES_SCHEMA = "vex-plugin-ranges/1";
/** The directories globPlugins() reads, in the same order (the _api and _core folders are plugin folders of their own). */
export const PLUGIN_DIRS = ["plugins/_api", "plugins/_core", "plugins", "userplugins"];

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_VALUE = new Map([...B64].map((c, i) => [c, i]));

/**
 * Decodes the "mappings" string of a source map into [generatedLine, generatedColumn, sourceIndex | -1] triples, one per
 * segment, in file order. Only the generated position and the source index matter here.
 * @param {string} mappings
 * @returns {number[][]}
 */
export function decodeSegments(mappings) {
    /** @type {number[][]} */
    const out = [];
    let line = 0;
    let genCol = 0;
    let source = 0;
    let pos = 0;
    let shift = 0;
    let acc = 0;
    /** @type {number[]} */
    let seg = [];
    const flush = () => {
        if (seg.length) {
            genCol += seg[0];
            if (seg.length >= 4) {
                source += seg[1];
                out.push([line, genCol, source]);
            } else {
                out.push([line, genCol, -1]);
            }
        }
        seg = [];
    };
    for (; pos < mappings.length; pos++) {
        const ch = mappings[pos];
        if (ch === ";") {
            flush();
            line++;
            genCol = 0;
            continue;
        }
        if (ch === ",") {
            flush();
            continue;
        }
        const v = B64_VALUE.get(ch);
        if (v === undefined) throw new Error(`Invalid character in the source map mappings: ${JSON.stringify(ch)}`);
        acc += (v & 31) << shift;
        if (v & 32) {
            shift += 5;
            continue;
        }
        const negative = acc & 1;
        const value = acc >> 1;
        seg.push(negative ? -value : value);
        acc = 0;
        shift = 0;
    }
    flush();
    return out;
}

/**
 * @param {string} source a path from the map's "sources", e.g. "../src/plugins/foo/index.tsx"
 * @param {Map<string, string>} nameByEntry "plugins/foo" -> "Foo" (see readPluginEntries)
 * @returns {string} the plugin's name, or "" for anything that is not a plugin's own file
 */
export function ownerOfSource(source, nameByEntry) {
    const clean = source.replace(/\\/g, "/").replace(/^(\.\.\/)+/, "");
    const m = /^src\/(plugins\/_api|plugins\/_core|plugins|userplugins)\/([^/]+)(?:\/|$)/.exec(clean);
    if (!m) return "";
    return nameByEntry.get(`${m[1]}/${m[2]}`) ?? "";
}

/**
 * Collapses the segments into runs: a new run starts only where the owner changes. A segment with no source
 * (generated code with no origin) continues the previous owner.
 * @param {{ sources: string[], mappings: string }} map
 * @param {Map<string, string>} nameByEntry
 */
export function buildRuns(map, nameByEntry) {
    /** @type {string[]} */
    const owners = [""];
    const ownerIndex = new Map([["", 0]]);
    const bySource = map.sources.map(s => {
        const name = ownerOfSource(s, nameByEntry);
        let idx = ownerIndex.get(name);
        if (idx === undefined) {
            idx = owners.length;
            owners.push(name);
            ownerIndex.set(name, idx);
        }
        return idx;
    });
    /** @type {number[]} */
    const runs = [];
    let current = -1;
    for (const [line, col, source] of decodeSegments(map.mappings)) {
        const owner = source < 0 ? (current < 0 ? 0 : current) : bySource[source];
        if (owner === undefined) throw new Error(`The source map points at source ${source}, which it does not list`);
        if (owner !== current) {
            runs.push(line, col, owner);
            current = owner;
        }
    }
    return { owners, runs };
}

/**
 * "plugins/foo" (a folder) or "plugins/foo.ts" (a file) -> the plugin's name, for the same folders globPlugins() reads.
 * @param {string} srcRoot the folder that holds plugins/ and userplugins/ (normally ./src)
 * @returns {Promise<Map<string, string>>}
 */
export async function readPluginEntries(srcRoot = "./src") {
    const nameByEntry = new Map();
    for (const dir of PLUGIN_DIRS) {
        const fullDir = `${srcRoot}/${dir}`;
        if (!await exists(fullDir)) continue;
        for (const dirent of await readdir(fullDir, { withFileTypes: true })) {
            const n = dirent.name;
            if (n.startsWith("_") || n.startsWith(".") || n === "index.ts") continue;
            const name = await resolvePluginName(fullDir, dirent);
            nameByEntry.set(`${dir}/${n}`, name);
        }
    }
    return nameByEntry;
}

/**
 * @param {{ bundle: string, bundleText: Buffer, mapText: string, nameByEntry: Map<string, string> }} input
 */
export function buildManifest({ bundle, bundleText, mapText, nameByEntry }) {
    const map = JSON.parse(mapText);
    if (!Array.isArray(map.sources) || typeof map.mappings !== "string") throw new Error("The source map has no sources or mappings");
    const { owners, runs } = buildRuns(map, nameByEntry);
    return {
        schema: RANGES_SCHEMA,
        bundle,
        bundleBytes: bundleText.length,
        bundleSha256: createHash("sha256").update(bundleText).digest("hex"),
        owners,
        runs
    };
}

/**
 * The owner of a position, for tests and for anything that wants to look one up the same way Vex does.
 * @param {{ owners: string[], runs: number[] }} manifest
 * @param {number} line 0-based
 * @param {number} column 0-based
 * @returns {string | null} the plugin's name, "" for core, null before the first run
 */
export function lookupOwner(manifest, line, column) {
    const { runs, owners } = manifest;
    let lo = 0;
    let hi = runs.length / 3 - 1;
    let found = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const l = runs[mid * 3];
        const c = runs[mid * 3 + 1];
        if (l < line || (l === line && c <= column)) {
            found = mid;
            lo = mid + 1;
        } else hi = mid - 1;
    }
    return found < 0 ? null : owners[runs[found * 3 + 2]];
}
