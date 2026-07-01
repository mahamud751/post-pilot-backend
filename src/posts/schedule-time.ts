const HAS_OFFSET_TIMEZONE = /[+-]\d{2}:\d{2}$/;
const MIN_SCHEDULE_LEAD_MS = 60_000;

export const parseScheduledAt = (scheduledAt?: string | null) => {
  if (!scheduledAt) {
    return null;
  }

  const trimmed = scheduledAt.trim();
  let normalizedInput: string;

  if (trimmed.endsWith('Z')) {
    // Mobile clients (okhttp) often send Bangladesh wall-clock with a literal Z suffix.
    normalizedInput = `${trimmed.slice(0, -1)}+06:00`;
  } else if (HAS_OFFSET_TIMEZONE.test(trimmed)) {
    normalizedInput = trimmed;
  } else {
    normalizedInput = `${trimmed}+06:00`;
  }

  const parsed = new Date(normalizedInput);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
};

export const formatScheduledAtBd = (date: Date) =>
  date.toLocaleString('en-BD', {timeZone: 'Asia/Dhaka'});

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
    // Publish-now window (scheduler picks up within ~15 seconds).
    return;
  }

  throw new Error(
    'Scheduled time must be at least 1 minute in the future (Asia/Dhaka).',
  );
};
