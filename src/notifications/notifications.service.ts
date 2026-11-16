import {Injectable, Logger, NotFoundException} from '@nestjs/common';
import {Prisma, WorkspaceRole} from '@prisma/client';
import {MailService} from '../mail/mail.service';
import {PrismaService} from '../prisma/prisma.service';

export type NotifyInput = {
  userId: string;
  workspaceId?: string | null;
  type: string;
  title: string;
  body: string;
  meta?: Record<string, unknown>;
  /** Repeat notifications with the same key for the same user are dropped (PRD FR-11). */
  dedupeKey?: string;
  /** Also email the user, if they have email notifications on. */
  email?: boolean;
};

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  create(
    userId: string,
    input: {type: string; title: string; body: string; meta?: Record<string, unknown>},
  ) {
    return this.notify({userId, ...input});
  }

  /** Non-blocking: failures are logged, never thrown. Returns false when deduplicated. */
  async notify(input: NotifyInput) {
    try {
      await this.prisma.notification.create({
        data: {
          userId: input.userId,
          workspaceId: input.workspaceId ?? null,
          type: input.type,
          title: input.title,
          body: input.body,
          dedupeKey: input.dedupeKey ?? null,
          ...(input.meta && {meta: input.meta as Prisma.InputJsonValue}),
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return false;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Notification ${input.type} for ${input.userId} failed: ${message}`);
      return false;
    }

    if (input.email) {
      const user = await this.prisma.user
        .findUnique({where: {id: input.userId}, select: {email: true, emailNotifications: true}})
        .catch(() => null);
      if (user?.emailNotifications) {
        await this.mail.send(user.email, `PostPilot: ${input.title}`, input.body);
      }
    }
    return true;
  }

  /** Notifies every active member of the workspace holding one of `roles`. */
  async notifyRoles(
    workspaceId: string,
    roles: WorkspaceRole[],
    input: Omit<NotifyInput, 'userId' | 'workspaceId'>,
    alsoUserIds: string[] = [],
  ) {
    const members = await this.prisma.workspaceMember.findMany({
      where: {workspaceId, inviteStatus: 'ACTIVE', role: {in: roles}},
      select: {userId: true},
    });
    const recipients = new Set([...members.map(m => m.userId), ...alsoUserIds]);
    await Promise.all(
      [...recipients].map(userId => this.notify({...input, userId, workspaceId})),
    );
  }

  findAll(userId: string, limit = 30) {
    return this.prisma.notification.findMany({
      where: {userId},
      orderBy: {createdAt: 'desc'},
      take: limit,
    });
  }

  unreadCount(userId: string) {
    return this.prisma.notification.count({
      where: {userId, read: false},
    });
  }

  async markRead(userId: string, id: string) {
    const exists = await this.prisma.notification.findFirst({
      where: {id, userId},
    });
    if (!exists) {
      throw new NotFoundException('Notification not found');
    }
    return this.prisma.notification.update({
      where: {id},
      data: {read: true},
    });
  }

  markAllRead(userId: string) {
    return this.prisma.notification.updateMany({
      where: {userId, read: false},
      data: {read: true},
    });
  }
}
