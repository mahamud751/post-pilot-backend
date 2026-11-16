import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {PrismaService} from '../prisma/prisma.service';
import {CampaignService} from './campaign.service';

@Injectable()
export class CampaignWorkerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(CampaignWorkerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopping = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly campaigns: CampaignService,
  ) {}

  onApplicationBootstrap() {
    if (
      this.config.get('PUBLISH_WORKER') === 'off' ||
      this.config.get('CAMPAIGN_WORKER') === 'off'
    )
      return;
    this.tick();
    this.timer = setInterval(() => this.tick(), 5000);
  }

  private tick() {
    if (this.running || this.stopping) return;
    this.running = this.sweep()
      .catch((error) =>
        this.logger.error(
          `Campaign worker: ${error instanceof Error ? error.message : 'failed'}`,
        ),
      )
      .finally(() => {
        this.running = null;
      });
  }

  async sweep() {
    const due = await this.prisma.campaign.findMany({
      where: {
        status: {in: ['QUEUED', 'GENERATING']},
        workspace: {state: 'active'},
        OR: [{leaseUntil: null}, {leaseUntil: {lt: new Date()}}],
      },
      select: {id: true},
      orderBy: {createdAt: 'asc'},
      take: 2,
    });
    await Promise.all(
      due.map((campaign) =>
        this.campaigns.process(campaign.id, () => this.stopping),
      ),
    );
  }

  async onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
