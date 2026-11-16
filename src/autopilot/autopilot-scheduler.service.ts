import {Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {EngagementService} from '../engagement/engagement.service';
import {ExperimentsService} from '../intelligence/experiments.service';
import {MemoryService} from '../intelligence/memory.service';
import {NotificationsService} from '../notifications/notifications.service';
import {PrismaService} from '../prisma/prisma.service';
import type {WorkspaceContext} from '../workspaces/workspace.guard';
import {AutopilotService} from './autopilot.service';

const TICK_MS = 5 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
/** Metrics and experiment checkpoints refresh this often for every enabled workspace. */
const SYNC_EVERY_MS = 6 * 60 * 60_000;
/** After a failed run (no account, no credits, model down), try again this much later. */
const RETRY_AFTER_MS = 6 * 60 * 60_000;
const BATCH = 20;

/**
 * Hands-free autopilot. Runs in the worker process (same switch as publishing) and:
 *  1. refreshes metrics + experiment checkpoints every 6 hours for enabled workspaces;
 *  2. reads new comments and DMs every 5 minutes and drafts or sends replies (replyMode);
 *  3. runs a full autopilot cycle (research → plan → drafts → schedule) every `runEveryDays`
 *     for workspaces that turned on `scheduleEnabled`.
 * Every row is claimed with a conditional update, so several workers never double-run.
 * Set AUTOPILOT_SCHEDULER=off to disable it without stopping publishing.
 */
@Injectable()
export class AutopilotSchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AutopilotSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly autopilot: AutopilotService,
    private readonly memory: MemoryService,
    private readonly experiments: ExperimentsService,
    private readonly notifications: NotificationsService,
    private readonly engagement: EngagementService,
  ) {}

  enabled() {
    return this.config.get<string>('PUBLISH_WORKER') !== 'off' && this.config.get<string>('AUTOPILOT_SCHEDULER') !== 'off';
  }

  onApplicationBootstrap() {
    if (!this.enabled()) {
      this.logger.log('Autopilot scheduler disabled');
      return;
    }
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    setTimeout(() => void this.tick(), 30_000).unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.inboxDue();
      await this.syncDue();
      await this.runDue();
    } catch (error) {
      this.logger.error(`Autopilot tick failed: ${messageOf(error)}`);
    } finally {
      this.running = false;
    }
  }

  /** Comments and DMs are checked every tick (5 minutes) for workspaces with replies on. */
  private async inboxDue() {
    const cutoff = new Date(Date.now() - TICK_MS + 30_000);
    const due = await this.prisma.autopilotConfig.findMany({
      where: {
        enabled: true,
        replyMode: {not: 'OFF'},
        workspace: {state: 'active'},
        OR: [{lastInboxSyncAt: null}, {lastInboxSyncAt: {lt: cutoff}}],
      },
      include: {workspace: true},
      take: BATCH,
    });
    for (const row of due) {
      const claimed = await this.prisma.autopilotConfig.updateMany({
        where: {id: row.id, lastInboxSyncAt: row.lastInboxSyncAt},
        data: {lastInboxSyncAt: new Date()},
      });
      if (claimed.count === 0) continue;
      try {
        const result = await this.engagement.poll(row);
        await this.prisma.autopilotConfig.update({
          where: {id: row.id},
          data: {lastInboxError: result.warnings.length ? result.warnings.join(' ').slice(0, 1000) : null},
        });
      } catch (error) {
        const message = messageOf(error);
        this.logger.warn(`Inbox poll failed for workspace ${row.workspaceId}: ${message}`);
        await this.prisma.autopilotConfig.update({where: {id: row.id}, data: {lastInboxError: message}});
      }
    }
  }

  private async syncDue() {
    const cutoff = new Date(Date.now() - SYNC_EVERY_MS);
    const due = await this.prisma.autopilotConfig.findMany({
      where: {
        enabled: true,
        workspace: {state: 'active'},
        OR: [{lastSyncAt: null}, {lastSyncAt: {lt: cutoff}}],
      },
      select: {id: true, workspaceId: true, lastSyncAt: true, workspace: {select: {timezone: true}}},
      take: BATCH,
    });
    for (const row of due) {
      const claimed = await this.prisma.autopilotConfig.updateMany({
        where: {id: row.id, lastSyncAt: row.lastSyncAt},
        data: {lastSyncAt: new Date()},
      });
      if (claimed.count === 0) continue;
      try {
        await this.memory.sync(row.workspaceId, row.workspace.timezone);
        await this.experiments.evaluate(row.workspaceId);
      } catch (error) {
        this.logger.warn(`Metric sync failed for workspace ${row.workspaceId}: ${messageOf(error)}`);
      }
    }
  }

  private async runDue() {
    const now = new Date();
    const due = await this.prisma.autopilotConfig.findMany({
      where: {
        enabled: true,
        scheduleEnabled: true,
        workspace: {state: 'active'},
        OR: [{nextAutoRunAt: null}, {nextAutoRunAt: {lte: now}}],
      },
      include: {workspace: true},
      orderBy: {nextAutoRunAt: 'asc'},
      take: BATCH,
    });

    for (const row of due) {
      const claimed = await this.prisma.autopilotConfig.updateMany({
        where: {id: row.id, nextAutoRunAt: row.nextAutoRunAt, scheduleEnabled: true, enabled: true},
        data: {nextAutoRunAt: new Date(Date.now() + row.runEveryDays * DAY_MS)},
      });
      if (claimed.count === 0) continue;

      const ws = row.workspace;
      const ctx: WorkspaceContext = {
        id: ws.id,
        role: 'OWNER',
        timezone: ws.timezone,
        approvalRequired: ws.approvalRequired,
        ownerId: ws.ownerId,
      };
      try {
        const result = await this.autopilot.run(ctx, ws.ownerId);
        await this.prisma.autopilotConfig.update({
          where: {id: row.id},
          data: {lastAutoRunAt: new Date(), lastAutoRunError: null},
        });
        this.logger.log(
          `Autopilot ran for workspace ${ws.id}: ${result.stopped ?? `${result.created.length} post(s)`}`,
        );
      } catch (error) {
        const message = messageOf(error);
        this.logger.warn(`Autopilot run failed for workspace ${ws.id}: ${message}`);
        await this.prisma.autopilotConfig.update({
          where: {id: row.id},
          data: {lastAutoRunError: message, nextAutoRunAt: new Date(Date.now() + RETRY_AFTER_MS)},
        });
        await this.notifications.notify({
          userId: ws.ownerId,
          workspaceId: ws.id,
          type: 'autopilot_failed',
          title: 'Scheduled autopilot could not run',
          body: `${message} It will try again in 6 hours.`,
          dedupeKey: `autopilot-failed:${ws.id}:${new Date().toISOString().slice(0, 10)}`,
        });
      }
    }
  }
}

function messageOf(error: unknown) {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as {message?: unknown}).message;
    if (typeof message === 'string') return message.slice(0, 300);
  }
  return String(error).slice(0, 300);
}
