CREATE TABLE "Campaign" (
  "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "authorId" TEXT NOT NULL, "requestId" TEXT NOT NULL,
  "name" TEXT NOT NULL, "days" INTEGER NOT NULL, "startDate" TEXT NOT NULL,
  "postTime" TEXT NOT NULL, "timezone" TEXT NOT NULL, "accountIds" TEXT[],
  "language" TEXT, "goal" TEXT, "themes" TEXT, "mediaMode" TEXT NOT NULL,
  "mediaIds" TEXT[] DEFAULT ARRAY[]::TEXT[], "autoSchedule" BOOLEAN NOT NULL DEFAULT false,
  "status" TEXT NOT NULL DEFAULT 'QUEUED', "error" TEXT, "leaseToken" TEXT,
  "leaseUntil" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "CampaignItem" (
  "id" TEXT NOT NULL, "campaignId" TEXT NOT NULL, "dayIndex" INTEGER NOT NULL,
  "plannedAt" TIMESTAMP(3) NOT NULL, "status" TEXT NOT NULL DEFAULT 'PENDING',
  "generatedContent" JSONB, "mediaIds" TEXT[] DEFAULT ARRAY[]::TEXT[], "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CampaignItem_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "Post" ADD COLUMN "campaignItemId" TEXT;
CREATE UNIQUE INDEX "Post_campaignItemId_key" ON "Post"("campaignItemId");
CREATE UNIQUE INDEX "CampaignItem_campaignId_dayIndex_key" ON "CampaignItem"("campaignId", "dayIndex");
CREATE UNIQUE INDEX "Campaign_workspaceId_requestId_key" ON "Campaign"("workspaceId", "requestId");
CREATE INDEX "Campaign_workspaceId_createdAt_idx" ON "Campaign"("workspaceId", "createdAt");
CREATE INDEX "Campaign_status_leaseUntil_idx" ON "Campaign"("status", "leaseUntil");
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CampaignItem" ADD CONSTRAINT "CampaignItem_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Post" ADD CONSTRAINT "Post_campaignItemId_fkey" FOREIGN KEY ("campaignItemId") REFERENCES "CampaignItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
