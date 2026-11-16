import type {ReplyMode} from '@prisma/client';

export const HOURLY_LIMIT_REASON = 'Hourly auto-reply limit reached.';

export type ReplyDraft = {intent: string; needsHuman: boolean; reply: string};

export type ReplyDecision =
  | {status: 'SEND'; reason?: undefined}
  | {status: 'DRAFTED' | 'NEEDS_HUMAN' | 'SKIPPED'; reason?: string};

/**
 * What happens to one drafted reply. Spam is ignored, anything sensitive goes to a person,
 * and only clean replies inside every limit are sent without a person, and only in AUTO mode.
 */
export function decideReply(input: {
  mode: ReplyMode;
  draft: ReplyDraft | undefined;
  blocking: string[];
  overHourlyLimit: boolean;
  dmWindowClosed: boolean;
}): ReplyDecision {
  const {draft} = input;
  if (!draft) return {status: 'NEEDS_HUMAN', reason: 'The AI did not return a reply for this message.'};
  if (draft.intent === 'spam') return {status: 'SKIPPED', reason: 'Looks like spam'};
  if (draft.needsHuman || draft.intent === 'complaint') {
    return {status: 'NEEDS_HUMAN', reason: 'Sensitive or a complaint: a person should answer.'};
  }
  if (!draft.reply.trim()) return {status: 'NEEDS_HUMAN', reason: 'No reply could be drafted from the brand facts.'};
  if (input.blocking.length) return {status: 'DRAFTED', reason: `Check before sending: ${input.blocking.join(' ')}`};
  if (input.mode !== 'AUTO') return {status: 'DRAFTED'};
  if (input.dmWindowClosed) return {status: 'NEEDS_HUMAN', reason: "Meta's 24-hour reply window has closed."};
  if (input.overHourlyLimit) return {status: 'DRAFTED', reason: HOURLY_LIMIT_REASON};
  return {status: 'SEND'};
}
