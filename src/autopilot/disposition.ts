import type {AutopilotMode} from '@prisma/client';

export type DraftDisposition =
  | {action: 'draft'; reason?: 'compliance' | 'needs_media'}
  | {action: 'review'}
  | {action: 'schedule'};

/** Flags that must stay in draft. A person can still edit and approve them. */
export const BLOCKING_COMPLIANCE = new Set([
  'restricted_term',
  'unverified_price',
  'unverified_offer',
  'possible_testimonial',
]);

/**
 * Workspace approval and a missing autopublish flag always beat AUTO.
 * Channels that require media are never queued from a text-only draft.
 */
export function decideDisposition(input: {
  mode: AutopilotMode;
  autopublishEnabled: boolean;
  approvalRequired: boolean;
  blocking: boolean;
  requiresMedia: boolean;
}): DraftDisposition {
  if (input.blocking) return {action: 'draft', reason: 'compliance'};
  if (input.mode === 'DRAFT') return {action: 'draft'};
  if (input.mode === 'APPROVAL' || input.approvalRequired || !input.autopublishEnabled) {
    return {action: 'review'};
  }
  if (input.requiresMedia) return {action: 'draft', reason: 'needs_media'};
  return {action: 'schedule'};
}
