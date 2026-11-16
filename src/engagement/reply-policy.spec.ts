import {decideReply, HOURLY_LIMIT_REASON} from './reply-policy';

const clean = {intent: 'question', needsHuman: false, reply: 'Yes, we deliver in Dhaka.'};
const base = {mode: 'AUTO' as const, draft: clean, blocking: [], overHourlyLimit: false, dmWindowClosed: false};

describe('decideReply', () => {
  it('sends a clean reply in AUTO mode', () => {
    expect(decideReply(base).status).toBe('SEND');
  });

  it('only drafts in DRAFT mode', () => {
    expect(decideReply({...base, mode: 'DRAFT'}).status).toBe('DRAFTED');
  });

  it('skips spam without replying', () => {
    expect(decideReply({...base, draft: {...clean, intent: 'spam', reply: ''}}).status).toBe('SKIPPED');
  });

  it('sends complaints and flagged messages to a person', () => {
    expect(decideReply({...base, draft: {...clean, intent: 'complaint'}}).status).toBe('NEEDS_HUMAN');
    expect(decideReply({...base, draft: {...clean, needsHuman: true}}).status).toBe('NEEDS_HUMAN');
  });

  it('needs a person when the AI returned nothing', () => {
    expect(decideReply({...base, draft: undefined}).status).toBe('NEEDS_HUMAN');
    expect(decideReply({...base, draft: {...clean, reply: '  '}}).status).toBe('NEEDS_HUMAN');
  });

  it('holds a reply with an unverified claim as a draft', () => {
    const decision = decideReply({...base, blocking: ['Price 500 is not in the brand kit.']});
    expect(decision.status).toBe('DRAFTED');
    expect(decision.reason).toContain('500');
  });

  it('respects the DM window and the hourly cap', () => {
    expect(decideReply({...base, dmWindowClosed: true}).status).toBe('NEEDS_HUMAN');
    expect(decideReply({...base, overHourlyLimit: true})).toEqual({status: 'DRAFTED', reason: HOURLY_LIMIT_REASON});
  });
});
