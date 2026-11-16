import {describeSignals, goalMetric, pickBestHour, rankGroups, type MemorySample} from './performance';

const sample = (overrides: Partial<MemorySample>): MemorySample => ({
  platform: 'FACEBOOK',
  contentPillar: 'styling',
  format: 'photo',
  localHour: 10,
  reach: 100,
  impressions: 120,
  engagements: 4,
  clicks: 1,
  ...overrides,
});

describe('goalMetric', () => {
  it('uses engagement rate only when reach is present', () => {
    expect(goalMetric(sample({engagements: 10, reach: 200}), 'ENGAGEMENT')).toBe(0.05);
    expect(goalMetric(sample({engagements: 10, reach: null}), 'ENGAGEMENT')).toBeNull();
  });

  it('uses recorded sales for the sales goal and clicks when no order was logged', () => {
    expect(goalMetric(sample({clicks: 7, salesAmount: 15000}), 'SALES')).toBe(15000);
    expect(goalMetric(sample({clicks: 7}), 'SALES')).toBe(7);
    expect(goalMetric(sample({clicks: 7}), 'LEADS')).toBe(7);
    expect(goalMetric(sample({reach: 40}), 'AWARENESS')).toBe(40);
  });
});

describe('pickBestHour', () => {
  it('refuses to invent a best hour from fewer than three measured posts', () => {
    const pick = pickBestHour([sample({localHour: 21})], 'ENGAGEMENT');
    expect(pick.hour).toBeNull();
    expect(pick.samples).toBe(1);
  });

  it('picks the hour with the higher average of the goal metric', () => {
    const rows = [
      sample({localHour: 10, engagements: 1, reach: 100}),
      sample({localHour: 10, engagements: 2, reach: 100}),
      sample({localHour: 19, engagements: 20, reach: 100}),
      sample({localHour: 19, engagements: 10, reach: 100}),
    ];
    expect(pickBestHour(rows, 'ENGAGEMENT').hour).toBe(19);
  });
});

describe('rankGroups', () => {
  it('ranks formats by the goal metric', () => {
    const rows = [
      sample({format: 'photo', clicks: 1}),
      sample({format: 'video', clicks: 9}),
      sample({format: 'video', clicks: 5}),
    ];
    expect(rankGroups(rows, 'LEADS', 'format').map(row => row.name)).toEqual(['video', 'photo']);
  });
});

describe('describeSignals', () => {
  it('does not claim a winning format when nothing has been measured', () => {
    const text = describeSignals({
      measured: 0,
      best: {hour: null, samples: 0, reason: ''},
      formats: [],
      goal: 'ENGAGEMENT',
    });
    expect(text).toMatch(/brand kit/i);
    expect(text).not.toMatch(/viral/i);
  });
});
