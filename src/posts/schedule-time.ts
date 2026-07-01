const HAS_EXPLICIT_TIMEZONE = /(Z|[+-]\d{2}:\d{2})$/;
const MIN_SCHEDULE_LEAD_MS = 60_000;

export const parseScheduledAt = (scheduledAt?: string | null) => {
  if (!scheduledAt) {
    return null;
  }

  const normalizedInput = HAS_EXPLICIT_TIMEZONE.test(scheduledAt)
    ? scheduledAt
    : `${scheduledAt}+06:00`;

  const parsed = new Date(normalizedInput);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
};

export const isPublishDue = (scheduledAt: Date, now = new Date()) =>
  scheduledAt.getTime() <= now.getTime();

export const assertSchedulableTime = (scheduledAt: Date, now = new Date()) => {
  const delta = scheduledAt.getTime() - now.getTime();

  if (delta < -120_000) {
    throw new Error('Scheduled time is too far in the past.');
  }

  if (delta >= MIN_SCHEDULE_LEAD_MS) {
    return;
  }

  if (delta >= -120_000) {
    // Publish-now window (scheduler picks up within ~60 seconds).
    return;
  }

  throw new Error(
    'Scheduled time must be at least 1 minute in the future (Asia/Dhaka).',
  );
};
