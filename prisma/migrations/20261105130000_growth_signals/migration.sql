-- Trends, named competitors, recorded sales, Instagram insight fields, and creative flags.

ALTER TABLE "AutopilotConfig" ADD COLUMN "researchEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "AutopilotConfig" ADD COLUMN "creativesEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AutopilotConfig" ADD COLUMN "conversionKeyHash" TEXT;

CREATE UNIQUE INDEX "AutopilotConfig_conversionKeyHash_key" ON "AutopilotConfig"("conversionKeyHash");

ALTER TABLE "PostTarget" ADD COLUMN "saves" INTEGER;
ALTER TABLE "PostTarget" ADD COLUMN "shares" INTEGER;
ALTER TABLE "PostTarget" ADD COLUMN "videoViews" INTEGER;

ALTER TABLE "PerformanceMemory" ADD COLUMN "saves" INTEGER;
ALTER TABLE "PerformanceMemory" ADD COLUMN "shares" INTEGER;
ALTER TABLE "PerformanceMemory" ADD COLUMN "videoViews" INTEGER;
ALTER TABLE "PerformanceMemory" ADD COLUMN "salesAmount" INTEGER;
ALTER TABLE "PerformanceMemory" ADD COLUMN "salesCount" INTEGER;

CREATE TABLE "TrendSignal" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT,
    "topic" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrendSignal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CompetitorAccount" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "audienceCount" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "statusReason" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CompetitorAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CompetitorSignal" (
    "id" TEXT NOT NULL,
    "competitorId" TEXT NOT NULL,
    "externalPostId" TEXT,
    "text" TEXT,
    "permalink" TEXT,
    "mediaType" TEXT,
    "postedAt" TIMESTAMP(3),
    "likes" INTEGER,
    "comments" INTEGER,
    "shares" INTEGER,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CompetitorSignal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Sale" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "postId" TEXT,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BDT',
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "source" TEXT NOT NULL,
    "externalRef" TEXT,
    "note" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Sale_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TrendSignal_workspaceId_fetchedAt_idx" ON "TrendSignal"("workspaceId", "fetchedAt");
CREATE UNIQUE INDEX "CompetitorAccount_workspaceId_platform_externalId_key" ON "CompetitorAccount"("workspaceId", "platform", "externalId");
CREATE INDEX "CompetitorAccount_workspaceId_idx" ON "CompetitorAccount"("workspaceId");
CREATE INDEX "CompetitorSignal_competitorId_fetchedAt_idx" ON "CompetitorSignal"("competitorId", "fetchedAt");
CREATE UNIQUE INDEX "Sale_workspaceId_externalRef_key" ON "Sale"("workspaceId", "externalRef");
CREATE INDEX "Sale_workspaceId_occurredAt_idx" ON "Sale"("workspaceId", "occurredAt");

ALTER TABLE "TrendSignal" ADD CONSTRAINT "TrendSignal_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CompetitorAccount" ADD CONSTRAINT "CompetitorAccount_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CompetitorSignal" ADD CONSTRAINT "CompetitorSignal_competitorId_fkey" FOREIGN KEY ("competitorId") REFERENCES "CompetitorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE SET NULL ON UPDATE CASCADE;
