import {EngagementKind, SocialAccount} from '@prisma/client';
import {graphRequest} from '../social/meta-graph';
import type {AccountMeta} from '../social/social-accounts.service';

/** Meta permissions each inbox feature needs. Missing ones are reported, never guessed around. */
export const INBOX_SCOPES = {
  FACEBOOK: {COMMENT: ['pages_read_user_content', 'pages_manage_engagement'], DM: ['pages_messaging']},
  INSTAGRAM: {COMMENT: ['instagram_manage_comments'], DM: ['instagram_manage_messages']},
} as const;

/** Meta lets a business answer a DM only within 24 hours of the person's last message. */
export const DM_WINDOW_MS = 24 * 60 * 60_000;
/** Safety margin so a reply is never sent seconds before the window closes. */
export const DM_SAFE_WINDOW_MS = 23 * 60 * 60_000;

export type InboxMessage = {
  kind: EngagementKind;
  externalId: string;
  threadId: string;
  authorId: string | null;
  authorName: string | null;
  text: string;
  permalink: string | null;
  receivedAt: Date;
};

type Paged<T> = {data?: T[]};
type FbComment = {
  id: string;
  message?: string;
  created_time: string;
  permalink_url?: string;
  from?: {id: string; name?: string};
  comments?: Paged<{from?: {id: string}}>;
};
type IgComment = {
  id: string;
  text?: string;
  timestamp: string;
  username?: string;
  from?: {id: string; username?: string};
  replies?: Paged<{username?: string; from?: {id: string}}>;
};
type ConvMessage = {id: string; message?: string; created_time: string; from?: {id: string; name?: string; username?: string}};

export function pageIdOf(account: SocialAccount) {
  if (account.platform === 'FACEBOOK') return account.platformAccountId;
  return ((account.meta || {}) as AccountMeta).pageId || null;
}

export function missingScopes(account: SocialAccount, kind: EngagementKind): string[] {
  if (account.platform !== 'FACEBOOK' && account.platform !== 'INSTAGRAM') return ['unsupported platform'];
  return INBOX_SCOPES[account.platform][kind].filter(scope => !account.scopes.includes(scope));
}

const enc = encodeURIComponent;
const cleanHandle = (h?: string | null) => (h || '').replace(/^@/, '').toLowerCase();

/** Newest top-level comments on recent posts that the account itself has not answered yet. */
export async function fetchComments(account: SocialAccount, token: string, since: Date): Promise<InboxMessage[]> {
  const out: InboxMessage[] = [];
  if (account.platform === 'FACEBOOK') {
    const page = account.platformAccountId;
    const feed = await graphRequest<Paged<{id: string; comments?: Paged<FbComment>}>>('GET', `/${enc(page)}/feed`, token, {
      fields: 'id,comments.limit(25).order(reverse_chronological){id,message,created_time,permalink_url,from,comments.limit(10){from}}',
      limit: '10',
    });
    for (const post of feed.data || []) {
      for (const c of post.comments?.data || []) {
        const at = new Date(c.created_time);
        if (at < since || !c.message?.trim() || c.from?.id === page) continue;
        if ((c.comments?.data || []).some(reply => reply.from?.id === page)) continue;
        out.push({
          kind: 'COMMENT',
          externalId: c.id,
          threadId: post.id,
          authorId: c.from?.id ?? null,
          authorName: c.from?.name ?? null,
          text: c.message,
          permalink: c.permalink_url ?? null,
          receivedAt: at,
        });
      }
    }
    return out;
  }

  const ig = account.platformAccountId;
  const own = cleanHandle(account.handle);
  const media = await graphRequest<Paged<{id: string; permalink?: string; comments?: Paged<IgComment>}>>(
    'GET',
    `/${enc(ig)}/media`,
    token,
    {fields: 'id,permalink,comments.limit(25){id,text,timestamp,username,from,replies.limit(10){username,from}}', limit: '10'},
  );
  const isOwn = (u?: string, id?: string) => id === ig || (own !== '' && cleanHandle(u) === own);
  for (const item of media.data || []) {
    for (const c of item.comments?.data || []) {
      const at = new Date(c.timestamp);
      if (at < since || !c.text?.trim() || isOwn(c.username, c.from?.id)) continue;
      if ((c.replies?.data || []).some(reply => isOwn(reply.username, reply.from?.id))) continue;
      out.push({
        kind: 'COMMENT',
        externalId: c.id,
        threadId: item.id,
        authorId: c.from?.id ?? null,
        authorName: c.username ?? c.from?.username ?? null,
        text: c.text,
        permalink: item.permalink ?? null,
        receivedAt: at,
      });
    }
  }
  return out;
}

/** The latest unanswered message in each recent conversation, still inside Meta's reply window. */
export async function fetchDms(account: SocialAccount, token: string, since: Date): Promise<InboxMessage[]> {
  const page = pageIdOf(account);
  if (!page) return [];
  const self = account.platform === 'FACEBOOK' ? page : account.platformAccountId;
  const convs = await graphRequest<Paged<{id: string; messages?: Paged<ConvMessage>}>>('GET', `/${enc(page)}/conversations`, token, {
    platform: account.platform === 'FACEBOOK' ? 'messenger' : 'instagram',
    fields: 'id,updated_time,messages.limit(5){id,message,created_time,from}',
    limit: '25',
  });
  const out: InboxMessage[] = [];
  const windowStart = Date.now() - DM_WINDOW_MS;
  for (const conv of convs.data || []) {
    const latest = conv.messages?.data?.[0];
    if (!latest || !latest.from || latest.from.id === self) continue;
    const at = new Date(latest.created_time);
    if (at < since || at.getTime() < windowStart || !latest.message?.trim()) continue;
    out.push({
      kind: 'DM',
      externalId: latest.id,
      threadId: conv.id,
      authorId: latest.from.id,
      authorName: latest.from.name ?? latest.from.username ?? null,
      text: latest.message,
      permalink: null,
      receivedAt: at,
    });
  }
  return out;
}

export async function sendCommentReply(account: SocialAccount, token: string, commentId: string, text: string) {
  const path = account.platform === 'FACEBOOK' ? `/${enc(commentId)}/comments` : `/${enc(commentId)}/replies`;
  const res = await graphRequest<{id?: string}>('POST', path, token, {message: text});
  return res.id ?? null;
}

export async function sendDm(account: SocialAccount, token: string, recipientId: string, text: string) {
  const page = pageIdOf(account);
  if (!page) throw new Error('This Instagram account has no linked Facebook Page to send messages through.');
  const res = await graphRequest<{message_id?: string}>('POST', `/${enc(page)}/messages`, token, {
    recipient: JSON.stringify({id: recipientId}),
    message: JSON.stringify({text}),
    messaging_type: 'RESPONSE',
  });
  return res.message_id ?? null;
}
