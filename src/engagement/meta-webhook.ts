import {createHmac, timingSafeEqual} from 'crypto';
import type {InboxMessage} from './meta-inbox';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown) => typeof value === 'string' ? value.slice(0, 4000) : '';
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

export function verifyMetaSignature(raw: Buffer | undefined, signature: string | undefined, secret: string | undefined) {
  if (!raw || !secret || !signature || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  const supplied = Buffer.from(signature.slice(7), 'hex');
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

/** Normalizes only incoming text messages and new, top-level comments. */
export function parseMetaWebhook(payload: unknown, now = Date.now()) {
  const root = object(payload);
  if (!['page', 'instagram'].includes(string(root.object))) return [];
  return array(root.entry).flatMap(rawEntry => {
    const entry = object(rawEntry);
    const accountId = string(entry.id);
    const messages: InboxMessage[] = [];
    for (const rawEvent of array(entry.messaging)) {
      const event = object(rawEvent); const message = object(event.message); const sender = object(event.sender);
      const text = string(message.text); const authorId = string(sender.id);
      if (message.is_echo || !text.trim() || !string(message.mid) || !authorId || authorId === accountId) continue;
      messages.push({kind: 'DM', externalId: string(message.mid), authorId, authorName: null, threadId: `dm:${authorId}`, text,
        receivedAt: new Date(Number(event.timestamp)), permalink: null});
    }
    for (const rawChange of array(entry.changes)) {
      const change = object(rawChange); const value = object(change.value); const from = object(value.from);
      const facebook = root.object === 'page';
      if (facebook ? change.field !== 'feed' || value.item !== 'comment' || value.verb !== 'add' : change.field !== 'comments') continue;
      const parentId = string(value.parent_id); const threadId = facebook ? string(value.post_id) : string(object(value.media).id);
      if (parentId && parentId !== threadId) continue;
      const text = string(facebook ? value.message : value.text);
      const externalId = string(facebook ? value.comment_id : value.id);
      const authorId = string(from.id);
      if (!text.trim() || !externalId || !threadId || authorId === accountId || from.self_ig_scoped_id) continue;
      messages.push({kind: 'COMMENT', externalId, threadId, text, authorId: authorId || null, authorName: string(from.name || from.username) || null,
        receivedAt: new Date(Number(value.created_time || entry.time) * 1000), permalink: null});
    }
    return [{accountId, platform: root.object === 'page' ? 'FACEBOOK' as const : 'INSTAGRAM' as const,
      messages: messages.filter(message => Number.isFinite(message.receivedAt.getTime()) && message.receivedAt.getTime() <= now + 300_000 && message.receivedAt.getTime() >= now - 3 * 86_400_000)}];
  });
}
