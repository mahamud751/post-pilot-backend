import {localParts, zonedToUtc} from './timezone';

describe('zonedToUtc (PRD TEST-09)', () => {
  it.each([
    ['2026-10-21', '10:00', 'Asia/Dhaka', '2026-10-21T04:00:00.000Z'],
    ['2026-07-01', '09:00', 'Europe/London', '2026-07-01T08:00:00.000Z'],
    ['2026-12-01', '09:00', 'Europe/London', '2026-12-01T09:00:00.000Z'],
    // US spring-forward: 02:00–02:59 does not exist on 2026-03-08
    ['2026-03-08', '01:30', 'America/New_York', '2026-03-08T06:30:00.000Z'],
    ['2026-03-08', '03:30', 'America/New_York', '2026-03-08T07:30:00.000Z'],
    // US fall-back: 01:30 happens twice on 2026-11-01; the first (EDT) wins
    ['2026-11-01', '01:30', 'America/New_York', '2026-11-01T05:30:00.000Z'],
    ['2026-11-01', '09:00', 'America/New_York', '2026-11-01T14:00:00.000Z'],
  ])('%s %s in %s is %s', (date, time, zone, expected) => {
    expect(zonedToUtc(date, time, zone).toISOString()).toBe(expected);
  });

  it('moves a time inside the spring-forward gap past the gap', () => {
    expect(zonedToUtc('2026-03-08', '02:30', 'America/New_York').toISOString()).toBe(
      '2026-03-08T07:30:00.000Z',
    );
  });
});

describe('localParts', () => {
  it('reads the wall clock back in Asia/Dhaka', () => {
    const parts = localParts(new Date('2026-10-21T04:00:00.000Z'), 'Asia/Dhaka');
    expect(parts).toMatchObject({date: '2026-10-21', hour: 10, minute: 0});
  });
});
