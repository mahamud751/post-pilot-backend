import {Injectable, Logger} from '@nestjs/common';
import {Prisma} from '@prisma/client';
import {PrismaService} from '../prisma/prisma.service';

type AuditInput = {
  workspaceId: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
};

const SECRET_KEY = /token|secret|password/i;

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Appends an audit entry. Never throws: auditing must not block the action it records. */
  async record(input: AuditInput, tx: Prisma.TransactionClient = this.prisma) {
    try {
      await tx.auditLog.create({
        data: {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          action: input.action,
          entityType: input.entityType,
          entityId: input.entityId ?? null,
          metadata: input.metadata ? (redact(input.metadata) as Prisma.InputJsonValue) : undefined,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Audit write failed for ${input.action}: ${message}`);
    }
  }

  list(workspaceId: string, take = 50) {
    return this.prisma.auditLog.findMany({
      where: {workspaceId},
      orderBy: {createdAt: 'desc'},
      take: Math.min(Math.max(take, 1), 200),
    });
  }
}

function redact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, SECRET_KEY.test(key) ? '[redacted]' : entry]),
  );
}
