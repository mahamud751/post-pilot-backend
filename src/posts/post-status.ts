import {Prisma, TargetStatus} from '@prisma/client';
import type {PostStatus} from './dto/post.dto';

/**
 * Post-level status derived from its targets once any has left PENDING (PRD FR-10).
 * Per-channel statuses stay on the targets, so partial success remains visible (TEST-07).
 */
export function deriveStatus(current: string, targets: {status: TargetStatus}[]): PostStatus {
  const live = targets.filter(t => t.status !== 'CANCELLED');
  if (targets.length > 0 && live.length === 0) {
    return 'cancelled';
  }
  if (live.every(t => t.status === 'PENDING')) {
    return (['draft', 'in_review', 'approved'].includes(current) ? current : 'draft') as PostStatus;
  }
  const has = (s: TargetStatus) => live.some(t => t.status === s);
  if (has('PROCESSING')) return 'processing';
  if (has('NEEDS_ACTION')) return 'needs_action';
  if (has('SCHEDULED')) return 'scheduled';
  if (has('FAILED')) return 'failed';
  if (live.every(t => t.status === 'PUBLISHED')) return 'published';
  return 'scheduled';
}

export async function recomputePostStatus(tx: Prisma.TransactionClient, postId: string) {
  const post = await tx.post.findUnique({
    where: {id: postId},
    select: {status: true, targets: {select: {status: true, scheduledAt: true}}},
  });
  if (!post) {
    return null;
  }
  const status = deriveStatus(post.status, post.targets);
  const upcoming = post.targets
    .filter(t => t.status === 'SCHEDULED' && t.scheduledAt)
    .map(t => t.scheduledAt!.getTime());
  await tx.post.update({
    where: {id: postId},
    data: {
      status,
      ...(upcoming.length ? {scheduledAt: new Date(Math.min(...upcoming))} : {}),
    },
  });
  return status;
}
