import {createHmac} from 'crypto';
import {parseMetaWebhook, verifyMetaSignature} from './meta-webhook';

describe('Meta webhook ingestion', () => {
  const now = 1_790_000_000_000;
  it('authenticates exact bytes and rejects tampering and missing signatures', () => {
    const body = Buffer.from('{"object":"page"}');
    const signature = `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`;
    expect(verifyMetaSignature(body, signature, 'secret')).toBe(true);
    expect(verifyMetaSignature(Buffer.from('changed'), signature, 'secret')).toBe(false);
    expect(verifyMetaSignature(body, undefined, 'secret')).toBe(false);
    expect(verifyMetaSignature(body, signature, undefined)).toBe(false);
    expect(verifyMetaSignature(body, 'sha256=garbage', 'secret')).toBe(false);
  });
  it('keeps incoming DMs, ignoring outgoing echoes, receipts and invalid timestamps', () => {
    const event = {sender: {id: 'customer'}, timestamp: now, message: {mid: 'mid-1', text: 'Price?'}};
    const result = parseMetaWebhook({object: 'page', entry: [{id: 'page', messaging: [event, {...event, message: {...event.message, is_echo: true}}, {delivery: {mids: ['x']}}, {...event, timestamp: 'not-a-date'}]}]}, now);
    expect(result[0].messages).toHaveLength(1);
    expect(result[0].messages[0]).toMatchObject({kind: 'DM', externalId: 'mid-1', authorId: 'customer', text: 'Price?'});
  });
  it('ignores deleted comments and own comments but captures a new customer comment', () => {
    const value = {item: 'comment', verb: 'add', comment_id: 'comment-1', post_id: 'post', parent_id: 'post', message: 'Available?', from: {id: 'customer', name: 'A'}, created_time: now / 1000};
    const result = parseMetaWebhook({object: 'page', entry: [{id: 'page', changes: [{field: 'feed', value}, {field: 'feed', value: {...value, verb: 'remove'}}, {field: 'feed', value: {...value, from: {id: 'page'}}}]}]}, now);
    expect(result[0].messages).toHaveLength(1);
    expect(result[0].messages[0]).toMatchObject({threadId: 'post', authorName: 'A'});
  });
  it('routes Instagram comments by account and media without treating nested replies as new leads', () => {
    const value = {id: 'comment', text: 'Nice!', media: {id: 'media'}, from: {id: 'fan', username: 'fan'}, created_time: now / 1000};
    const result = parseMetaWebhook({object: 'instagram', entry: [{id: 'ig-account', time: now / 1000, changes: [{field: 'comments', value}, {field: 'comments', value: {...value, parent_id: 'other-comment'}}]}]}, now);
    expect(result[0]).toMatchObject({accountId: 'ig-account', platform: 'INSTAGRAM'});
    expect(result[0].messages).toHaveLength(1);
    expect(parseMetaWebhook({object: 'unrelated', entry: []}, now)).toEqual([]);
  });
});
