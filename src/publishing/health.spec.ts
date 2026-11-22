import {HealthService, bounded} from './health.service';

describe('Operational readiness', () => {
  it('returns promptly when a dependency never responds', async () => {
    await expect(bounded(new Promise(() => undefined), 5)).rejects.toThrow('timed out');
  });
  it('does not report healthy when Redis or the worker is unavailable', async () => {
    const health = new HealthService({$queryRaw: jest.fn().mockResolvedValue([1])} as never,
      {queue: {client: Promise.resolve({ping: jest.fn().mockRejectedValue(new Error('offline'))}), getWorkers: jest.fn().mockResolvedValue([])}} as never);
    expect(await health.readiness()).toMatchObject({ok: false, checks: {database: true, redis: false, worker: false}});
  });
});
