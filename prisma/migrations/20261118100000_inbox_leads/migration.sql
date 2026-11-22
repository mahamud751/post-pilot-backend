CREATE TYPE "LeadStage" AS ENUM ('NEW', 'INTERESTED', 'ORDERED', 'RESOLVED', 'LOST');
ALTER TABLE "EngagementItem" ADD COLUMN "leadStage" "LeadStage" NOT NULL DEFAULT 'NEW',
  ADD COLUMN "assignedMemberId" TEXT, ADD COLUMN "internalNote" TEXT;
CREATE INDEX "EngagementItem_workspaceId_leadStage_receivedAt_idx" ON "EngagementItem"("workspaceId", "leadStage", "receivedAt");
CREATE INDEX "EngagementItem_assignedMemberId_idx" ON "EngagementItem"("assignedMemberId");
ALTER TABLE "EngagementItem" ADD CONSTRAINT "EngagementItem_assignedMemberId_fkey" FOREIGN KEY ("assignedMemberId") REFERENCES "WorkspaceMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;
