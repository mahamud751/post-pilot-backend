-- Hands-free autopilot: background runs on a fixed cadence and periodic metric syncs.

ALTER TABLE "AutopilotConfig" ADD COLUMN "scheduleEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AutopilotConfig" ADD COLUMN "runEveryDays" INTEGER NOT NULL DEFAULT 7;
ALTER TABLE "AutopilotConfig" ADD COLUMN "nextAutoRunAt" TIMESTAMP(3);
ALTER TABLE "AutopilotConfig" ADD COLUMN "lastAutoRunAt" TIMESTAMP(3);
ALTER TABLE "AutopilotConfig" ADD COLUMN "lastAutoRunError" TEXT;
ALTER TABLE "AutopilotConfig" ADD COLUMN "lastSyncAt" TIMESTAMP(3);

CREATE INDEX "AutopilotConfig_scheduleEnabled_nextAutoRunAt_idx" ON "AutopilotConfig"("scheduleEnabled", "nextAutoRunAt");
