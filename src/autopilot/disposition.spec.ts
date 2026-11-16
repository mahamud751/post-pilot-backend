import {decideDisposition} from './disposition';

const base = {
  mode: 'AUTO' as const,
  autopublishEnabled: true,
  approvalRequired: false,
  blocking: false,
  requiresMedia: false,
};

describe('decideDisposition', () => {
  it('keeps draft mode as drafts', () => {
    expect(decideDisposition({...base, mode: 'DRAFT'}).action).toBe('draft');
  });

  it('sends approval mode to review even when autopublish is on', () => {
    expect(decideDisposition({...base, mode: 'APPROVAL'}).action).toBe('review');
  });

  it('lets a workspace approval rule override full autopilot', () => {
    expect(decideDisposition({...base, approvalRequired: true}).action).toBe('review');
  });

  it('does not queue a text-only post on a channel that requires media', () => {
    expect(decideDisposition({...base, requiresMedia: true})).toEqual({action: 'draft', reason: 'needs_media'});
  });

  it('holds compliance failures as drafts', () => {
    expect(decideDisposition({...base, blocking: true, mode: 'APPROVAL'})).toEqual({
      action: 'draft',
      reason: 'compliance',
    });
  });

  it('schedules only in full autopilot with publish enabled and a clean text post', () => {
    expect(decideDisposition(base).action).toBe('schedule');
  });
});
