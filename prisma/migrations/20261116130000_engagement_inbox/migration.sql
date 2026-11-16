-- Auto-reply inbox for comments and direct messages.

CREATE TYPE "ReplyMode" AS ENUM ('OFF', 'DRAFT', 'AUTO');
CREATE TYPE "EngagementKind" AS ENUM ('COMMENT', 'DM');
CREATE TYPE "EngagementStatus" AS ENUM ('NEW', 'DRAFTED', 'SENDING', 'REPLIED', 'NEEDS_HUMAN', 'SKIPPED', 'FAILED');

ALTER TABLE "AutopilotConfig" ADD COLUMN "replyMode" "ReplyMode" NOT NULL DEFAULT 'OFF';
ALTER TABLE "AutopilotConfig" ADD COLUMN "replyComments" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "AutopilotConfig" ADD COLUMN "replyDms" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "AutopilotConfig" ADD COLUMN "replyInstructions" TEXT;
ALTER TABLE "AutopilotConfig" ADD COLUMN "replyHourlyLimit" INTEGER NOT NULL DEFAULT 20;
ALTER TABLE "AutopilotConfig" ADD COLUMN "repliesSince" TIMESTAMP(3);
ALTER TABLE "AutopilotConfig" ADD COLUMN "lastInboxSyncAt" TIMESTAMP(3);
ALTER TABLE "AutopilotConfig" ADD COLUMN "lastInboxError" TEXT;

CREATE TABLE "EngagementItem" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "socialAccountId" TEXT NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "kind" "EngagementKind" NOT NULL,
    "externalId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "authorId" TEXT,
    "authorName" TEXT,
    "text" TEXT NOT NULL,
    "permalink" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "status" "EngagementStatus" NOT NULL DEFAULT 'NEW',
    "intent" TEXT,
    "replyText" TEXT,
    "replyExternalId" TEXT,
    "reason" TEXT,
    "sentById" TEXT,
    "repliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EngagementItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EngagementItem_socialAccountId_externalId_key" ON "EngagementItem"("socialAccountId", "externalId");
CREATE INDEX "EngagementItem_workspaceId_status_receivedAt_idx" ON "EngagementItem"("workspaceId", "status", "receivedAt");
CREATE INDEX "EngagementItem_workspaceId_repliedAt_idx" ON "EngagementItem"("workspaceId", "repliedAt");

ALTER TABLE "EngagementItem" ADD CONSTRAINT "EngagementItem_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EngagementItem" ADD CONSTRAINT "EngagementItem_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
