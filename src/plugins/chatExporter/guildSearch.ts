/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { RestAPI } from "@webpack/common";

// Shared paging for Discord's guild message search (`/guilds/{id}/messages/search`),
// used by UserExporter and ServerMemberExporter.
//
// Search pages are addressed by offset, not by cursor, so once the first page has
// reported `total_results` every remaining page is known up front and can be
// requested concurrently. How many may be in flight at once is governed per
// guild by Discord's own bucket headers (x-ratelimit-remaining / -reset-after):
// a generous bucket is used fully, a tight one is never overrun, and real 429s
// step the bucket down a backoff ladder.

export const SEARCH_PAGE_SIZE = 25;
export const MAX_SEARCH_OFFSET = 2000; // Discord rejects deeper offsets

const MAX_RETRIES = 5;
const NO_HEADER_DELAY = 1200; // sequential gap while a bucket exposes no rate-limit headers
const GLOBAL_MAX_IN_FLIGHT = 6; // across every guild, in case search shares a hidden per-user limit
const RETRY_DELAYS = [2000, 5000, 10000, 20000, 40000];

// Each distinct 429 event drops the bucket one rung: fewer requests in flight and
// a minimum gap between sends. The last rung matches the old fixed 3.5 s pacing.
const PENALTY_LADDER: Array<{ inFlight: number; gap: number; }> = [
    { inFlight: 4, gap: 0 },
    { inFlight: 2, gap: 350 },
    { inFlight: 1, gap: 1200 },
    { inFlight: 1, gap: 3500 },
];

// Discord's REST responses may surface headers as a Headers object (.get) or a
// plain lowercased map, depending on the path. Read both shapes defensively.
function readHeader(headers: any, name: string): string | undefined {
    if (!headers) return undefined;
    if (typeof headers.get === "function") return headers.get(name) ?? undefined;
    return headers[name] ?? headers[name.toLowerCase()] ?? undefined;
}

// Abort-aware sleep: resolves immediately when the export is cancelled so a
// pending backoff never keeps a dead job running for seconds.
function pause(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
        if (signal.aborted) return resolve();
        const timer = setTimeout(finish, ms);
        function finish() {
            signal.removeEventListener("abort", finish);
            clearTimeout(timer);
            resolve();
        }
        signal.addEventListener("abort", finish);
    });
}

function isRateLimitError(e: any): boolean {
    if (e?.status === 429) return true;
    const msg = String(e?.message ?? e ?? "").toLowerCase();
    return msg.includes("429") || msg.includes("rate limit");
}

function retryAfterMs(e: any): number {
    const body = Number(e?.body?.retry_after);
    if (Number.isFinite(body) && body > 0) return body * 1000;
    const header = Number(readHeader(e?.headers, "retry-after"));
    if (Number.isFinite(header) && header > 0) return header * 1000;
    return 0;
}

let globalInFlight = 0;

class SearchBucket {
    private limit: number | null = null;
    private remaining = 0;
    private resetAt = 0;
    private resetKnown = false;
    private headersSeen = false;
    private noHeaders = false;
    private inFlight = 0;
    private blockedUntil = 0;
    private lastSentAt = 0;
    private penalty = 0;
    private waiters: Array<() => void> = [];

    constructor(private readonly guildId: string) { }

    private wake() {
        const w = this.waiters;
        this.waiters = [];
        for (const fn of w) fn();
    }

    // Sleep up to `ms`, but wake early whenever the bucket state changes.
    private waitForChange(ms: number, signal: AbortSignal): Promise<void> {
        return new Promise(resolve => {
            if (signal.aborted) return resolve();
            const timer = setTimeout(finish, ms);
            const bucket = this;
            function finish() {
                signal.removeEventListener("abort", finish);
                clearTimeout(timer);
                const i = bucket.waiters.indexOf(finish);
                if (i !== -1) bucket.waiters.splice(i, 1);
                resolve();
            }
            signal.addEventListener("abort", finish);
            this.waiters.push(finish);
        });
    }

    // Resolves once a request may be sent (and counts it as in flight); false
    // means the export was cancelled while waiting and nothing was counted.
    // Every successful acquire must be paired with exactly one release*() call.
    async acquire(signal: AbortSignal): Promise<boolean> {
        for (;;) {
            if (signal.aborted) return false;
            const now = Date.now();
            const rung = PENALTY_LADDER[this.penalty];
            const sinceLast = now - this.lastSentAt;

            let waitMs: number; // >0 = sleep that long, 0 = go, -1 = wait for a state change
            if (now < this.blockedUntil) {
                waitMs = this.blockedUntil - now;
            } else if (rung.gap && sinceLast < rung.gap) {
                waitMs = rung.gap - sinceLast;
            } else if (this.inFlight >= rung.inFlight || globalInFlight >= GLOBAL_MAX_IN_FLIGHT) {
                waitMs = -1;
            } else if (!this.headersSeen) {
                // Nothing is known about this bucket yet: go one at a time until the
                // first response reveals its size (or that it exposes no headers).
                if (this.inFlight > 0) waitMs = -1;
                else if (this.noHeaders && sinceLast < NO_HEADER_DELAY) waitMs = NO_HEADER_DELAY - sinceLast;
                else waitMs = 0;
            } else {
                if (this.resetKnown && now >= this.resetAt) {
                    // The window rolled over: full budget again until a response says otherwise.
                    this.remaining = this.limit ?? 1;
                    this.resetKnown = false;
                }
                if (this.remaining - this.inFlight > 0) waitMs = 0;
                else if (this.resetKnown) waitMs = Math.max(1, this.resetAt - now);
                else waitMs = -1;
            }

            if (waitMs === 0) {
                this.inFlight++;
                globalInFlight++;
                this.lastSentAt = now;
                return true;
            }
            await this.waitForChange(waitMs === -1 ? 60_000 : Math.min(waitMs, 60_000), signal);
        }
    }

    private settle() {
        this.inFlight--;
        globalInFlight--;
    }

    // A response came back (any status other than 429): learn the bucket state from it.
    release(res: any) {
        this.settle();
        const remainingRaw = readHeader(res?.headers, "x-ratelimit-remaining");
        if (remainingRaw == null) {
            if (!this.headersSeen) this.noHeaders = true;
        } else {
            const remaining = Number(remainingRaw);
            const limit = Number(readHeader(res?.headers, "x-ratelimit-limit"));
            const resetAfter = Number(readHeader(res?.headers, "x-ratelimit-reset-after"));
            if (!this.headersSeen) {
                console.log(`[Exporter] search bucket for guild ${this.guildId}: limit=${limit} remaining=${remaining} resetAfter=${resetAfter}s`);
            }
            this.headersSeen = true;
            if (Number.isFinite(limit) && limit > 0) this.limit = limit;
            const resetAt = Date.now() + (Number.isFinite(resetAfter) ? resetAfter * 1000 : NO_HEADER_DELAY);
            if (!this.resetKnown || resetAt > this.resetAt + 500) {
                // First data for this window: take it as is.
                this.resetAt = resetAt;
                this.resetKnown = true;
                this.remaining = Number.isFinite(remaining) ? remaining : 0;
            } else {
                // Same window: concurrent responses may arrive out of order, and the
                // lowest remaining is the truthful one.
                this.remaining = Math.min(this.remaining, Number.isFinite(remaining) ? remaining : 0);
            }
        }
        this.wake();
    }

    // The request was rate limited: block every sender until retry_after has
    // passed and step down the ladder (once per event - several in-flight
    // requests bouncing off the same limit count as one).
    release429(waitMs: number) {
        this.settle();
        const now = Date.now();
        if (now >= this.blockedUntil && this.penalty < PENALTY_LADDER.length - 1) {
            this.penalty++;
            console.log(`[Exporter] search bucket for guild ${this.guildId} rate limited, slowing down (level ${this.penalty})`);
        }
        this.blockedUntil = Math.max(this.blockedUntil, now + waitMs);
        this.remaining = 0;
        this.resetAt = this.blockedUntil;
        this.resetKnown = true;
        this.wake();
    }

    // The request failed for another reason (or was aborted): just free the slot.
    releaseFailed() {
        this.settle();
        this.wake();
    }
}

const buckets = new Map<string, SearchBucket>();

function bucketFor(guildId: string): SearchBucket {
    let b = buckets.get(guildId);
    if (!b) {
        b = new SearchBucket(guildId);
        buckets.set(guildId, b);
    }
    return b;
}

export interface AuthorSearchParams {
    guildId: string;
    authorId: string;
    /** Restrict to one channel; omit for the whole guild. */
    channelId?: string;
    /** Snowflake bounds, passed straight through as min_id / max_id. */
    minId?: string;
    maxId?: string;
    /** Stop after this many hits (null = every reachable hit). */
    limit: number | null;
    /** Pages requested concurrently within this search (the bucket may allow fewer). */
    concurrency?: number;
    signal: AbortSignal;
    /** Polled between pages; true stops the search and returns what was collected. */
    shouldStop?: () => boolean;
    /** Called with the running hit count each time a page is folded in (in order). */
    onProgress?: (count: number) => void;
    /** Called with total_results after the first page; return false to stop there. */
    onFirstPage?: (total: number) => boolean;
}

export interface AuthorSearchResult {
    /** Raw message objects in search order (newest first). */
    hits: any[];
    /** total_results as reported by Discord (0 when unknown). */
    total: number;
}

interface Page {
    hits: any[];
    total: number;
}

export async function searchAuthorMessages(p: AuthorSearchParams): Promise<AuthorSearchResult> {
    const bucket = bucketFor(p.guildId);
    const url = `/guilds/${p.guildId}/messages/search`;
    const baseQuery: Record<string, any> = { author_id: p.authorId, include_nsfw: true };
    if (p.channelId) baseQuery.channel_id = p.channelId;
    if (p.minId) baseQuery.min_id = p.minId;
    if (p.maxId) baseQuery.max_id = p.maxId;

    const stop = () => p.signal.aborted || p.shouldStop?.() === true;

    // null = give up on this page (no access, retries exhausted, or stopped).
    async function fetchPage(offset: number): Promise<Page | null> {
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            if (stop()) return null;
            if (!await bucket.acquire(p.signal)) return null;

            let res: any;
            try {
                res = await RestAPI.get({ url, query: { ...baseQuery, offset }, retries: 0 });
            } catch (e: any) {
                // 403/404 => not in this guild or no access; nothing more to fetch here.
                if (e?.status === 403 || e?.status === 404) {
                    bucket.releaseFailed();
                    return null;
                }
                const last = attempt === MAX_RETRIES - 1;
                if (isRateLimitError(e)) {
                    // The bucket stays blocked for retry_after, so the next acquire waits it out.
                    bucket.release429(Math.max(retryAfterMs(e), RETRY_DELAYS[attempt]));
                    if (last) console.log(`[Exporter] search in guild ${p.guildId} gave up after ${MAX_RETRIES} rate limits`);
                    continue;
                }
                bucket.releaseFailed();
                if (last) {
                    console.log(`[Exporter] search in guild ${p.guildId} failed after ${MAX_RETRIES} attempts:`, e);
                    return null;
                }
                await pause(RETRY_DELAYS[attempt], p.signal);
                continue;
            }

            bucket.release(res);
            const body = res?.body ?? {};
            const total = typeof body.total_results === "number" ? body.total_results : 0;
            const hits = ((body.messages ?? []) as any[])
                .map(hit => (Array.isArray(hit) ? hit[0] : hit))
                .filter(Boolean);
            return { hits, total };
        }
        return null;
    }

    // The first page on its own: it reports total_results, which fixes the page count.
    const first = await fetchPage(0);
    if (!first) return { hits: [], total: 0 };
    const { total } = first;
    const hits = first.hits.slice(0, p.limit ?? Infinity);
    p.onProgress?.(hits.length);

    if (!first.hits.length || hits.length >= total) return { hits, total };
    if (p.limit && hits.length >= p.limit) return { hits, total };
    if (p.onFirstPage && !p.onFirstPage(total)) return { hits, total };

    const wanted = p.limit ? Math.min(total, p.limit) : total;
    const offsets: number[] = [];
    for (let off = SEARCH_PAGE_SIZE; off < wanted && off <= MAX_SEARCH_OFFSET; off += SEARCH_PAGE_SIZE) {
        offsets.push(off);
    }

    // Fetch the remaining pages concurrently but fold them in offset order, so the
    // output is exactly what a sequential scan would have produced: a contiguous
    // prefix that ends at the first page that failed, came back empty, or hit the limit.
    const pages = new Map<number, Page | null>();
    let nextToFold = 0;
    let nextToFetch = 0;
    let halted = false; // stop folding: the limit was reached or the export was stopped
    let noMore = false; // stop fetching: a page failed or came back empty

    const fold = () => {
        while (!halted && nextToFold < offsets.length && pages.has(offsets[nextToFold])) {
            const page = pages.get(offsets[nextToFold])!;
            nextToFold++;
            if (!page || !page.hits.length) {
                halted = true;
                break;
            }
            for (const hit of page.hits) {
                hits.push(hit);
                if (p.limit && hits.length >= p.limit) {
                    halted = true;
                    break;
                }
            }
            p.onProgress?.(hits.length);
        }
    };

    const worker = async () => {
        while (!halted && !noMore && nextToFetch < offsets.length) {
            if (stop()) {
                halted = true;
                break;
            }
            const offset = offsets[nextToFetch++];
            const page = await fetchPage(offset);
            if (!page || !page.hits.length) noMore = true;
            pages.set(offset, page);
            fold();
        }
    };

    const workers = Math.max(1, Math.min(p.concurrency ?? 1, offsets.length));
    await Promise.all(Array.from({ length: workers }, worker));

    return { hits, total };
}
