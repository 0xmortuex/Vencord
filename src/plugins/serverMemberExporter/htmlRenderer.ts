/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Embed, MessageAttachment, MessageReaction } from "@vencord/discord-types";

import { ExportedMemberData, ExportedMessage, MemberInfo } from "./exporter";

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function renderMarkdown(text: string): string {
    let html = escapeHtml(text);

    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) =>
        `<div style="background:#2b2d31;border-radius:4px;padding:8px 12px;margin:4px 0;font-family:'Consolas','Courier New',monospace;font-size:0.875rem;white-space:pre-wrap;border:1px solid #1e1f22;">${code}</div>`
    );
    html = html.replace(/`([^`]+)`/g, (_m, code) =>
        `<code style="background:#2b2d31;padding:2px 4px;border-radius:3px;font-family:'Consolas','Courier New',monospace;font-size:0.875rem;">${code}</code>`
    );
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
    html = html.replace(/_(.+?)_/g, "<em>$1</em>");
    html = html.replace(/~~(.+?)~~/g, "<s>$1</s>");
    html = html.replace(/__(.+?)__/g, "<u>$1</u>");
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        "<a href=\"$2\" style=\"color:#00aff4;text-decoration:none;\" target=\"_blank\">$1</a>"
    );
    html = html.replace(/(https?:\/\/[^\s<]+)/g,
        "<a href=\"$1\" style=\"color:#00aff4;text-decoration:none;\" target=\"_blank\">$1</a>"
    );
    html = html.replace(/\n/g, "<br>");

    return html;
}

function formatTimestamp(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleString("en-US", {
        month: "2-digit",
        day: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
    });
}

function renderAttachments(attachments: MessageAttachment[]): string {
    if (!attachments.length) return "";
    return attachments.map(att => {
        const a = att as any;
        const isImage = a.content_type?.startsWith("image/") ||
            /\.(png|jpg|jpeg|gif|webp)$/i.test(a.filename ?? "");
        if (isImage) {
            return `<div style="margin:4px 0;">
                <a href="${escapeHtml(a.url)}" target="_blank">
                    <img src="${escapeHtml(a.url)}" alt="${escapeHtml(a.filename ?? "")}"
                        style="max-width:400px;max-height:300px;border-radius:8px;">
                </a>
            </div>`;
        }
        return `<div style="margin:4px 0;padding:8px 12px;background:#2b2d31;border-radius:8px;border:1px solid #1e1f22;">
            <a href="${escapeHtml(a.url)}" style="color:#00aff4;text-decoration:none;" target="_blank">
                📎 ${escapeHtml(a.filename ?? "attachment")}${a.size ? ` (${(a.size / 1024).toFixed(1)} KB)` : ""}
            </a>
        </div>`;
    }).join("");
}

function renderEmbeds(embeds: Embed[]): string {
    if (!embeds.length) return "";
    return embeds.map(e => {
        const embed = e as any;
        const borderColor = embed.color ? `#${embed.color.toString(16).padStart(6, "0")}` : "#4f545c";
        let html = `<div style="margin:4px 0;padding:8px 16px;background:#2b2d31;border-left:4px solid ${borderColor};border-radius:4px;max-width:520px;">`;

        if (embed.author?.name) {
            html += `<div style="font-size:0.875rem;font-weight:600;margin-bottom:4px;">${escapeHtml(embed.author.name)}</div>`;
        }
        if (embed.title) {
            const title = embed.url
                ? `<a href="${escapeHtml(embed.url)}" style="color:#00aff4;text-decoration:none;font-weight:700;">${escapeHtml(embed.title)}</a>`
                : `<span style="font-weight:700;">${escapeHtml(embed.title)}</span>`;
            html += `<div style="margin-bottom:4px;">${title}</div>`;
        }
        if (embed.description) {
            html += `<div style="font-size:0.875rem;color:#dcddde;margin-bottom:8px;">${renderMarkdown(embed.description)}</div>`;
        }
        if (embed.fields?.length) {
            html += "<div style=\"display:flex;flex-wrap:wrap;gap:8px;\">";
            for (const field of embed.fields) {
                const width = field.inline ? "calc(33% - 8px)" : "100%";
                html += `<div style="min-width:0;flex:0 0 ${width};">
                    <div style="font-size:0.75rem;font-weight:700;color:#b9bbbe;margin-bottom:2px;">${escapeHtml(field.name)}</div>
                    <div style="font-size:0.875rem;color:#dcddde;">${renderMarkdown(field.value)}</div>
                </div>`;
            }
            html += "</div>";
        }
        if (embed.image?.url) {
            html += `<div style="margin-top:8px;"><img src="${escapeHtml(embed.image.url)}" style="max-width:100%;border-radius:4px;"></div>`;
        }
        if (embed.thumbnail?.url) {
            html += `<div style="margin-top:8px;"><img src="${escapeHtml(embed.thumbnail.url)}" style="max-width:80px;border-radius:4px;float:right;"></div>`;
        }
        if (embed.footer?.text) {
            html += `<div style="font-size:0.75rem;color:#72767d;margin-top:8px;">${escapeHtml(embed.footer.text)}</div>`;
        }

        html += "</div>";
        return html;
    }).join("");
}

function renderReactions(reactions: MessageReaction[]): string {
    if (!reactions.length) return "";
    const items = reactions.map(r => {
        const emoji = r.emoji.id
            ? `<img src="https://cdn.discordapp.com/emojis/${r.emoji.id}.${r.emoji.animated ? "gif" : "png"}?size=16" style="width:16px;height:16px;vertical-align:middle;">`
            : escapeHtml(r.emoji.name ?? "");
        return `<span style="display:inline-flex;align-items:center;gap:4px;background:#2b2d31;border:1px solid #1e1f22;border-radius:8px;padding:2px 8px;font-size:0.875rem;">${emoji} <span style="color:#b5bac1;">${r.count}</span></span>`;
    }).join(" ");
    return `<div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:4px;">${items}</div>`;
}

function renderMessage(msg: ExportedMessage): string {
    let html = `<div style="padding:8px 16px;margin:8px 0;background:#2b2d31;border-radius:4px;border-left:3px solid #5865f2;">
        <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:4px;">
            <span style="font-size:0.75rem;color:#949ba4;">${formatTimestamp(msg.timestamp)}</span>
            ${msg.edited_timestamp ? "<span style=\"font-size:0.625rem;color:#949ba4;\">(edited)</span>" : ""}
        </div>`;

    if (msg.content) {
        html += `<div style="color:#dbdee1;line-height:1.375;">${renderMarkdown(msg.content)}</div>`;
    }
    html += renderAttachments(msg.attachments);
    html += renderEmbeds(msg.embeds);
    html += renderReactions(msg.reactions);
    html += "</div>";
    return html;
}

function memberDisplayName(m: MemberInfo): string {
    return m.nick || m.globalName || m.username;
}

function renderMemberSection(data: ExportedMemberData): string {
    const { member, messages } = data;

    // Group this member's messages by server, then by channel, for readability
    // (messages can span multiple servers).
    interface ChannelGroup { name: string; messages: ExportedMessage[]; }
    interface GuildGroup { name: string; channels: Map<string, ChannelGroup>; count: number; }
    const byGuild = new Map<string, GuildGroup>();
    for (const msg of messages) {
        let g = byGuild.get(msg.guildId);
        if (!g) {
            g = { name: msg.guildName, channels: new Map(), count: 0 };
            byGuild.set(msg.guildId, g);
        }
        let ch = g.channels.get(msg.channelId);
        if (!ch) {
            ch = { name: msg.channelName, messages: [] };
            g.channels.set(msg.channelId, ch);
        }
        ch.messages.push(msg);
        g.count++;
    }

    const channelCount = [...byGuild.values()].reduce((sum, g) => sum + g.channels.size, 0);
    const name = memberDisplayName(member);
    let html = `<div style="margin:24px 16px 0;">
        <div style="padding:12px 16px;background:#1e1f22;border-radius:8px 8px 0 0;border-bottom:2px solid #5865f2;display:flex;align-items:center;gap:12px;">
            <img src="${escapeHtml(member.avatarUrl)}" alt="" style="width:40px;height:40px;border-radius:50%;">
            <div>
                <div style="font-size:1.125rem;font-weight:700;color:#f2f3f5;">${escapeHtml(name)}</div>
                <div style="font-size:0.75rem;color:#949ba4;margin-top:2px;">@${escapeHtml(member.username)} &mdash; ${messages.length} message${messages.length !== 1 ? "s" : ""} across ${channelCount} channel${channelCount !== 1 ? "s" : ""} in ${byGuild.size} server${byGuild.size !== 1 ? "s" : ""}</div>
                ${member.topRoleName ? `<div style="font-size:0.75rem;margin-top:2px;color:${member.topRoleColor ? `#${member.topRoleColor.toString(16).padStart(6, "0")}` : "#949ba4"};">${escapeHtml(member.topRoleName)}</div>` : ""}
            </div>
        </div>`;

    for (const guild of byGuild.values()) {
        html += `<div style="padding:6px 16px;background:#232428;border-bottom:1px solid #1e1f22;font-size:0.8125rem;font-weight:700;color:#b5bac1;">
            ${escapeHtml(guild.name)} <span style="font-weight:400;color:#949ba4;">&mdash; ${guild.count} message${guild.count !== 1 ? "s" : ""}</span>
        </div>`;
        for (const ch of guild.channels.values()) {
            html += `<div style="padding:8px 16px;background:#2b2d31;border-bottom:1px solid #1e1f22;">
                <div style="font-size:0.9375rem;font-weight:600;color:#dbdee1;">#${escapeHtml(ch.name)}</div>
                <div style="font-size:0.75rem;color:#949ba4;">${ch.messages.length} message${ch.messages.length !== 1 ? "s" : ""}</div>
            </div>
            <div style="padding:0 16px 8px;background:#313338;">`;
            for (const msg of ch.messages) html += renderMessage(msg);
            html += "</div>";
        }
    }

    html += "</div>";
    return html;
}

export function renderHtml(guildName: string, members: ExportedMemberData[]): string {
    const totalMessages = members.reduce((sum, m) => sum + m.messages.length, 0);
    const bodyHtml = members.map(renderMemberSection).join("");
    const exportDate = new Date().toLocaleString();
    const title = members.length === 1
        ? `Messages by ${memberDisplayName(members[0].member)} in ${guildName}`
        : `Member messages in ${guildName}`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #313338; color: #dbdee1; font-family: 'gg sans', 'Noto Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 1rem; }
a { color: #00aff4; }
::-webkit-scrollbar { width: 8px; }
::-webkit-scrollbar-track { background: #2b2d31; }
::-webkit-scrollbar-thumb { background: #1a1b1e; border-radius: 4px; }
</style>
</head>
<body>
<div style="background:#1e1f22;padding:24px;border-bottom:1px solid #1e1f22;">
    <h1 style="font-size:1.5rem;font-weight:700;color:#f2f3f5;">${escapeHtml(title)}</h1>
    <div style="font-size:0.875rem;color:#949ba4;margin-top:4px;">${totalMessages} messages from ${members.length} member${members.length !== 1 ? "s" : ""}</div>
</div>
${bodyHtml}
<div style="text-align:center;padding:24px;color:#949ba4;font-size:0.75rem;border-top:1px solid #1e1f22;margin-top:16px;">
    Exported ${totalMessages} messages from ${members.length} member${members.length !== 1 ? "s" : ""} &mdash; ${escapeHtml(exportDate)}
</div>
</body>
</html>`;
}
