-- Autopilot: brand operating rules, performance memory, and growth experiments.
-- Additive. Existing posts stay manual (source and content pillar remain null).

-- CreateEnum
CREATE TYPE "AutopilotMode" AS ENUM ('DRAFT', 'APPROVAL', 'AUTO');

-- CreateEnum
CREATE TYPE "GrowthGoal" AS ENUM ('AWARENESS', 'ENGAGEMENT', 'LEADS', 'SALES');

-- CreateEnum
CREATE TYPE "ExperimentStatus" AS ENUM ('PROPOSED', 'RUNNING', 'COMPLETED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Post" ADD COLUMN "contentPillar" TEXT,
ADD COLUMN "source" TEXT;

-- CreateTable
CREATE TABLE "AutopilotConfig" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "mode" "AutopilotMode" NOT NULL DEFAULT 'DRAFT',
    "autopublishEnabled" BOOLEAN NOT NULL DEFAULT false,
    "goal" "GrowthGoal" NOT NULL DEFAULT 'ENGAGEMENT',
    "postsPerWeek" INTEGER NOT NULL DEFAULT 3,
    "dailyPostLimit" INTEGER NOT NULL DEFAULT 2,
    "analyzeEnabled" BOOLEAN NOT NULL DEFAULT true,
    "generateEnabled" BOOLEAN NOT NULL DEFAULT true,
    "optimizeSchedule" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutopilotConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceMemory" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "postTargetId" TEXT NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "contentPillar" TEXT,
    "format" TEXT NOT NULL,
    "hook" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "localHour" INTEGER NOT NULL,
    "weekday" INTEGER NOT NULL,
    "reach" INTEGER,
    "impressions" INTEGER,
    "engagements" INTEGER,
    "clicks" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PerformanceMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrowthExperiment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "hypothesis" TEXT NOT NULL,
    "goal" "GrowthGoal" NOT NULL,
    "status" "ExperimentStatus" NOT NULL DEFAULT 'PROPOSED',
    "learning" TEXT,
    "winnerPostId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GrowthExperiment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExperimentVariant" (
    "id" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "hook" TEXT NOT NULL,
    "checkpoint24" JSONB,
    "checkpoint48" JSONB,
    "checkpoint7d" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExperimentVariant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AutopilotConfig_workspaceId_key" ON "AutopilotConfig"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "PerformanceMemory_postTargetId_key" ON "PerformanceMemory"("postTargetId");

-- CreateIndex
CREATE INDEX "PerformanceMemory_workspaceId_publishedAt_idx" ON "PerformanceMemory"("workspaceId", "publishedAt");

-- CreateIndex
CREATE INDEX "GrowthExperiment_workspaceId_createdAt_idx" ON "GrowthExperiment"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExperimentVariant_postId_key" ON "ExperimentVariant"("postId");

-- CreateIndex
CREATE INDEX "ExperimentVariant_experimentId_idx" ON "ExperimentVariant"("experimentId");

-- AddForeignKey
ALTER TABLE "AutopilotConfig" ADD CONSTRAINT "AutopilotConfig_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceMemory" ADD CONSTRAINT "PerformanceMemory_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceMemory" ADD CONSTRAINT "PerformanceMemory_postTargetId_fkey" FOREIGN KEY ("postTargetId") REFERENCES "PostTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrowthExperiment" ADD CONSTRAINT "GrowthExperiment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExperimentVariant" ADD CONSTRAINT "ExperimentVariant_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "GrowthExperiment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExperimentVariant" ADD CONSTRAINT "ExperimentVariant_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
