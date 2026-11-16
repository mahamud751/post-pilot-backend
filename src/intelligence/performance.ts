export type GrowthGoalName = 'AWARENESS' | 'ENGAGEMENT' | 'LEADS' | 'SALES';

export type MemorySample = {
  platform: string;
  contentPillar: string | null;
  format: string;
  localHour: number;
  reach: number | null;
  impressions: number | null;
  engagements: number | null;
  clicks: number | null;
  saves?: number | null;
  shares?: number | null;
  videoViews?: number | null;
  /** Minor currency units. Null means this sample is not the sales attribution row. */
  salesAmount?: number | null;
};

export type HourPick = {hour: number | null; samples: number; reason: string};

const MIN_SAMPLES = 3;

export function goalLabel(goal: GrowthGoalName) {
  if (goal === 'AWARENESS') return 'reach';
  if (goal === 'LEADS') return 'click';
  if (goal === 'SALES') return 'sales';
  return 'engagement';
}

/**
 * Metric used to compare this brand's own posts.
 * Sales use recorded order totals when this workspace logged them, and link clicks otherwise.
 * Engagement is a rate only when reach was actually returned.
 */
export function goalMetric(
  sample: Pick<MemorySample, 'reach' | 'impressions' | 'engagements' | 'clicks' | 'salesAmount'>,
  goal: GrowthGoalName,
): number | null {
  if (goal === 'AWARENESS') return sample.reach;
  if (goal === 'LEADS') return sample.clicks;
  if (goal === 'SALES') return sample.salesAmount != null ? sample.salesAmount : sample.clicks;
  if (sample.engagements == null || sample.reach == null || sample.reach <= 0) return null;
  return sample.engagements / sample.reach;
}

export function pickBestHour(samples: MemorySample[], goal: GrowthGoalName): HourPick {
  const scored = samples
    .map(sample => ({hour: sample.localHour, value: goalMetric(sample, goal)}))
    .filter((row): row is {hour: number; value: number} => row.value != null && row.hour >= 0 && row.hour <= 23);
  if (scored.length < MIN_SAMPLES) {
    return {
      hour: null,
      samples: scored.length,
      reason: `Only ${scored.length} of your posts have a ${goalLabel(goal)} metric. Drafts use 10:00 until at least ${MIN_SAMPLES} do.`,
    };
  }
  const buckets = new Map<number, number[]>();
  for (const row of scored) {
    const list = buckets.get(row.hour) || [];
    list.push(row.value);
    buckets.set(row.hour, list);
  }
  let bestHour = 10;
  let bestAvg = -Infinity;
  let bestCount = 0;
  for (const [hour, values] of buckets) {
    const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
    if (avg > bestAvg || (avg === bestAvg && values.length > bestCount)) {
      bestHour = hour;
      bestAvg = avg;
      bestCount = values.length;
    }
  }
  const hh = String(bestHour).padStart(2, '0');
  return {
    hour: bestHour,
    samples: scored.length,
    reason: `${hh}:00 has the strongest ${goalLabel(goal)} signal across your measured posts (${bestCount} at that hour, ${scored.length} with this metric).`,
  };
}

export function rankGroups(samples: MemorySample[], goal: GrowthGoalName, key: 'format' | 'contentPillar') {
  const buckets = new Map<string, number[]>();
  for (const sample of samples) {
    const name = key === 'format' ? sample.format : sample.contentPillar;
    if (!name) continue;
    const value = goalMetric(sample, goal);
    if (value == null) continue;
    const list = buckets.get(name) || [];
    list.push(value);
    buckets.set(name, list);
  }
  return [...buckets.entries()]
    .map(([name, values]) => ({
      name,
      posts: values.length,
      average: values.reduce((sum, value) => sum + value, 0) / values.length,
    }))
    .sort((a, b) => b.average - a.average || b.posts - a.posts);
}

export function describeSignals(input: {
  measured: number;
  best: HourPick;
  formats: {name: string; posts: number}[];
  goal: GrowthGoalName;
}) {
  if (input.measured === 0) {
    return 'No published posts are in memory yet. Autopilot drafts from the brand kit only, at 10:00, and does not claim that a format is already working.';
  }
  const hour =
    input.best.hour == null
      ? '10:00, because there is not enough of your own data for another hour'
      : `${String(input.best.hour).padStart(2, '0')}:00`;
  const top = input.formats[0];
  const formatBit = top ? ` ${top.name} posts are ahead on ${goalLabel(input.goal)} (${top.posts} measured).` : '';
  return `Prefer ${hour} for the next drafts.${formatBit} Compare the variants before treating one format as the strategy. This is your account's history, not a promise of reach.`;
}

export function hourToTime(hour: number | null) {
  return `${String(hour == null ? 10 : hour).padStart(2, '0')}:00`;
}
