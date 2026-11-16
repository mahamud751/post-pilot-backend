import {Injectable, NotFoundException} from '@nestjs/common';
import {Prisma} from '@prisma/client';
import {AuditService} from '../audit/audit.service';
import {NotificationsService} from '../notifications/notifications.service';
import {PrismaService} from '../prisma/prisma.service';
import {goalMetric, type GrowthGoalName} from './performance';

type Checkpoint = {
  capturedAt: string;
  hoursAfterPublish: number;
  reach: number | null;
  impressions: number | null;
  engagements: number | null;
  clicks: number | null;
  score: number | null;
};

const sum = (values: (number | null | undefined)[]) => {
  const present = values.filter((value): value is number => value != null);
  return present.length ? present.reduce((total, value) => total + value, 0) : null;
};

@Injectable()
export class ExperimentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Fills 24h, 48h and 7-day checkpoints from metrics already stored on published targets.
   * An experiment completes only after every variant has been live for 7 days.
   */
  async evaluate(workspaceId: string) {
    const open = await this.prisma.growthExperiment.findMany({
      where: {workspaceId, status: {in: ['PROPOSED', 'RUNNING']}},
      include: {
        variants: {
          include: {
            post: {
              include: {
                targets: {
                  select: {status: true, publishedAt: true, reach: true, impressions: true, engagements: true, clicks: true},
                },
              },
            },
          },
        },
      },
    });
    let completed = 0;
    for (const experiment of open) {
      const goal = experiment.goal as GrowthGoalName;
      const experimentAgeHours = (Date.now() - experiment.createdAt.getTime()) / 3_600_000;
      let anyPublished = false;
      let allMature = experiment.variants.length > 0;
      for (const variant of experiment.variants) {
        const published = variant.post.targets.filter(target => target.status === 'PUBLISHED' && target.publishedAt);
        if (published.length === 0) {
          // A draft that never goes live (for example an Instagram caption still waiting for an image)
          // must not block the comparison forever. Give it 7 days from the experiment's creation.
          if (experimentAgeHours < 24 * 7) allMature = false;
          continue;
        }
        anyPublished = true;
        const publishedAt = published.reduce(
          (earliest, target) => (target.publishedAt! < earliest ? target.publishedAt! : earliest),
          published[0].publishedAt!,
        );
        const hours = (Date.now() - publishedAt.getTime()) / 3_600_000;
        if (hours < 24 * 7) allMature = false;
        const metrics = {
          reach: sum(published.map(target => target.reach)),
          impressions: sum(published.map(target => target.impressions)),
          engagements: sum(published.map(target => target.engagements)),
          clicks: sum(published.map(target => target.clicks)),
        };
        const checkpoint = (): Checkpoint => ({
          capturedAt: new Date().toISOString(),
          hoursAfterPublish: Math.round(hours),
          ...metrics,
          score: goalMetric(metrics, goal),
        });
        const data: Prisma.ExperimentVariantUpdateInput = {};
        if (hours >= 24 && !variant.checkpoint24) data.checkpoint24 = checkpoint() as unknown as Prisma.InputJsonValue;
        if (hours >= 48 && !variant.checkpoint48) data.checkpoint48 = checkpoint() as unknown as Prisma.InputJsonValue;
        if (hours >= 24 * 7 && !variant.checkpoint7d) data.checkpoint7d = checkpoint() as unknown as Prisma.InputJsonValue;
        if (Object.keys(data).length) {
          await this.prisma.experimentVariant.update({where: {id: variant.id}, data});
        }
      }
      if (!anyPublished) continue;
      if (!allMature) {
        if (experiment.status !== 'RUNNING') {
          await this.prisma.growthExperiment.update({where: {id: experiment.id}, data: {status: 'RUNNING'}});
        }
        continue;
      }
      const fresh = await this.prisma.experimentVariant.findMany({where: {experimentId: experiment.id}});
      const ranked = fresh
        .map(variant => ({
          variant,
          score: (variant.checkpoint7d as Checkpoint | null)?.score ?? null,
        }))
        .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
      const winner = ranked.find(row => row.score != null);
      const unpublished = fresh.filter(variant => !variant.checkpoint7d).length;
      const learning = winner
        ? `Compared ${fresh.length - unpublished} published variant${fresh.length - unpublished === 1 ? '' : 's'} on ${experiment.goal}. Strongest after 7 days: "${winner.variant.hook}" (score ${winner.score}).${unpublished ? ` ${unpublished} variant${unpublished === 1 ? '' : 's'} never went live, so ${unpublished === 1 ? 'it was' : 'they were'} left out.` : ''} This is this account's result, not a guarantee for the next post.`
        : `Compared the published variants on ${experiment.goal}, but 7-day metrics were missing, so no winner was chosen.`;
      await this.prisma.growthExperiment.update({
        where: {id: experiment.id},
        data: {
          status: 'COMPLETED',
          learning,
          winnerPostId: winner?.variant.postId || null,
        },
      });
      completed++;
      await this.audit.record({
        workspaceId,
        actorId: null,
        action: 'experiment.completed',
        entityType: 'growth_experiment',
        entityId: experiment.id,
        metadata: {winnerPostId: winner?.variant.postId || null},
      });
      const workspace = await this.prisma.workspace.findUnique({where: {id: workspaceId}, select: {ownerId: true}});
      if (workspace) {
        await this.notifications.notify({
          userId: workspace.ownerId,
          workspaceId,
          type: 'experiment_completed',
          title: 'A growth experiment finished',
          body: learning.slice(0, 300),
          meta: {experimentId: experiment.id},
          dedupeKey: `experiment:${experiment.id}:done`,
        });
      }
    }
    return {checked: open.length, completed};
  }

  async cancel(workspaceId: string, experimentId: string) {
    const updated = await this.prisma.growthExperiment.updateMany({
      where: {id: experimentId, workspaceId, status: {in: ['PROPOSED', 'RUNNING']}},
      data: {status: 'CANCELLED', learning: 'Cancelled before the 7-day comparison finished.'},
    });
    if (updated.count === 0) {
      throw new NotFoundException('That experiment is not open');
    }
    return {ok: true};
  }

  async list(workspaceId: string) {
    const experiments = await this.prisma.growthExperiment.findMany({
      where: {workspaceId},
      orderBy: {createdAt: 'desc'},
      take: 20,
      include: {
        variants: {
          orderBy: {createdAt: 'asc'},
          include: {
            post: {select: {id: true, status: true, scheduledAt: true}},
          },
        },
      },
    });
    return experiments.map(experiment => ({
      id: experiment.id,
      hypothesis: experiment.hypothesis,
      goal: experiment.goal,
      status: experiment.status,
      learning: experiment.learning,
      winnerPostId: experiment.winnerPostId,
      createdAt: experiment.createdAt,
      variants: experiment.variants.map(variant => ({
        id: variant.id,
        postId: variant.postId,
        label: variant.label,
        hook: variant.hook,
        postStatus: variant.post.status,
        scheduledAt: variant.post.scheduledAt,
        checkpoint24: variant.checkpoint24,
        checkpoint48: variant.checkpoint48,
        checkpoint7d: variant.checkpoint7d,
      })),
    }));
  }
}
