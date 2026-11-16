-- SaaS core (PRD R1): brand kit, encrypted social accounts, per-channel targets and publish
-- attempts, approvals, AI metering, content plans, subscriptions and billing events.
-- Additive only; the data backfill for existing rows is at the end.

-- CreateEnum
CREATE TYPE "SocialPlatform" AS ENUM ('FACEBOOK', 'INSTAGRAM', 'YOUTUBE', 'LINKEDIN', 'TIKTOK');

-- CreateEnum
CREATE TYPE "SocialAccountStatus" AS ENUM ('CONNECTED', 'EXPIRED', 'REVOKED', 'ERROR');

-- CreateEnum
CREATE TYPE "TargetStatus" AS ENUM ('PENDING', 'SCHEDULED', 'PROCESSING', 'PUBLISHED', 'FAILED', 'CANCELLED', 'NEEDS_ACTION');

-- CreateEnum
CREATE TYPE "PlanCode" AS ENUM ('TRIAL', 'STARTER', 'GROWTH', 'AGENCY');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED');

-- AlterTable
ALTER TABLE "Media" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "durationSec" DOUBLE PRECISION,
ADD COLUMN     "folder" TEXT,
ADD COLUMN     "height" INTEGER,
ADD COLUMN     "sha256" TEXT,
ADD COLUMN     "storageKey" TEXT,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "width" INTEGER;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "dedupeKey" TEXT,
ADD COLUMN     "workspaceId" TEXT;

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "aiGenerationId" TEXT,
ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" TEXT,
ADD COLUMN     "approvedVersion" INTEGER,
ADD COLUMN     "complianceFlags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "contentPlanId" TEXT,
ADD COLUMN     "contentVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "mediaIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "title" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailNotifications" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "googleId" TEXT,
ADD COLUMN     "isSuperAdmin" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tosAcceptedAt" TIMESTAMP(3),
ALTER COLUMN "passwordHash" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "onboardingStep" TEXT NOT NULL DEFAULT 'brand';

-- CreateTable
CREATE TABLE "EmailToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Brand" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "audience" TEXT,
    "products" JSONB NOT NULL DEFAULT '[]',
    "approvedOffers" JSONB NOT NULL DEFAULT '[]',
    "doNotSay" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tone" TEXT NOT NULL DEFAULT 'friendly',
    "languages" TEXT[] DEFAULT ARRAY['en']::TEXT[],
    "website" TEXT,
    "ctas" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mediaGuidelines" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Brand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialAccount" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "platformAccountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "handle" TEXT,
    "pictureUrl" TEXT,
    "accessTokenEnc" TEXT NOT NULL,
    "refreshTokenEnc" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expiresAt" TIMESTAMP(3),
    "status" "SocialAccountStatus" NOT NULL DEFAULT 'CONNECTED',
    "statusReason" TEXT,
    "meta" JSONB,
    "connectedById" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthState" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "nonceHash" TEXT NOT NULL,
    "codeVerifier" TEXT,
    "candidatesEnc" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostTarget" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "socialAccountId" TEXT,
    "platform" "SocialPlatform" NOT NULL,
    "channelText" TEXT,
    "scheduledAt" TIMESTAMP(3),
    "status" "TargetStatus" NOT NULL DEFAULT 'PENDING',
    "jobToken" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "remotePostId" TEXT,
    "remoteUrl" TEXT,
    "lastError" TEXT,
    "publishedAt" TIMESTAMP(3),
    "reach" INTEGER,
    "impressions" INTEGER,
    "engagements" INTEGER,
    "clicks" INTEGER,
    "metricsFetchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PostTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublishAttempt" (
    "id" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "outcome" TEXT,
    "providerCode" TEXT,
    "sanitizedError" TEXT,
    "remotePostId" TEXT,
    "containerId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "PublishAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostReview" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "comment" TEXT,
    "version" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiGeneration" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "credits" INTEGER NOT NULL DEFAULT 1,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "estimatedCost" DECIMAL(10,6),
    "request" JSONB NOT NULL,
    "output" JSONB,
    "feedback" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiGeneration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentPlan" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "periodDays" INTEGER NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "prompt" JSONB NOT NULL,
    "items" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "plan" "PlanCode" NOT NULL DEFAULT 'TRIAL',
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
    "billingCycle" TEXT NOT NULL DEFAULT 'monthly',
    "trialEndsAt" TIMESTAMP(3),
    "currentPeriodStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "graceEndsAt" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "provider" TEXT,
    "providerRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "plan" "PlanCode" NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BDT',
    "status" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "provider" TEXT NOT NULL,
    "providerRef" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "workspaceId" TEXT,
    "payload" JSONB NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailToken_tokenHash_key" ON "EmailToken"("tokenHash");

-- CreateIndex
CREATE INDEX "EmailToken_userId_purpose_idx" ON "EmailToken"("userId", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "Brand_workspaceId_key" ON "Brand"("workspaceId");

-- CreateIndex
CREATE INDEX "SocialAccount_workspaceId_status_idx" ON "SocialAccount"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SocialAccount_platform_platformAccountId_workspaceId_key" ON "SocialAccount"("platform", "platformAccountId", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthState_nonceHash_key" ON "OAuthState"("nonceHash");

-- CreateIndex
CREATE UNIQUE INDEX "PostTarget_idempotencyKey_key" ON "PostTarget"("idempotencyKey");

-- CreateIndex
CREATE INDEX "PostTarget_socialAccountId_scheduledAt_idx" ON "PostTarget"("socialAccountId", "scheduledAt");

-- CreateIndex
CREATE INDEX "PostTarget_status_scheduledAt_idx" ON "PostTarget"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "PostTarget_postId_idx" ON "PostTarget"("postId");

-- CreateIndex
CREATE INDEX "PublishAttempt_targetId_attempt_idx" ON "PublishAttempt"("targetId", "attempt");

-- CreateIndex
CREATE INDEX "PostReview_postId_createdAt_idx" ON "PostReview"("postId", "createdAt");

-- CreateIndex
CREATE INDEX "AiGeneration_workspaceId_createdAt_idx" ON "AiGeneration"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "ContentPlan_workspaceId_createdAt_idx" ON "ContentPlan"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_workspaceId_key" ON "Subscription"("workspaceId");

-- CreateIndex
CREATE INDEX "Invoice_workspaceId_issuedAt_idx" ON "Invoice"("workspaceId", "issuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BillingEvent_provider_eventId_key" ON "BillingEvent"("provider", "eventId");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_userId_dedupeKey_key" ON "Notification"("userId", "dedupeKey");

-- CreateIndex
CREATE INDEX "Post_workspaceId_scheduledAt_idx" ON "Post"("workspaceId", "scheduledAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");

-- AddForeignKey
ALTER TABLE "EmailToken" ADD CONSTRAINT "EmailToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Brand" ADD CONSTRAINT "Brand_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialAccount" ADD CONSTRAINT "SocialAccount_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthState" ADD CONSTRAINT "OAuthState_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_contentPlanId_fkey" FOREIGN KEY ("contentPlanId") REFERENCES "ContentPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostTarget" ADD CONSTRAINT "PostTarget_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostTarget" ADD CONSTRAINT "PostTarget_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishAttempt" ADD CONSTRAINT "PublishAttempt_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "PostTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostReview" ADD CONSTRAINT "PostReview_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiGeneration" ADD CONSTRAINT "AiGeneration_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentPlan" ADD CONSTRAINT "ContentPlan_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------- Backfill existing data ----------

-- Existing accounts signed up before verification existed; treat their email as verified.
UPDATE "User" SET "emailVerifiedAt" = "createdAt" WHERE "emailVerifiedAt" IS NULL;

-- Existing workspaces already passed onboarding.
UPDATE "Workspace" SET "onboardingStep" = 'done';

-- One brand profile per workspace, named after it.
INSERT INTO "Brand" ("id", "workspaceId", "name", "updatedAt")
SELECT gen_random_uuid()::text, w."id", w."name", CURRENT_TIMESTAMP
FROM "Workspace" w
WHERE NOT EXISTS (SELECT 1 FROM "Brand" b WHERE b."workspaceId" = w."id");

-- Every existing workspace starts a 14-day trial.
INSERT INTO "Subscription" ("id", "workspaceId", "plan", "status", "trialEndsAt", "currentPeriodEnd", "updatedAt")
SELECT gen_random_uuid()::text, w."id", 'TRIAL', 'TRIALING',
       CURRENT_TIMESTAMP + INTERVAL '14 days', CURRENT_TIMESTAMP + INTERVAL '14 days', CURRENT_TIMESTAMP
FROM "Workspace" w
WHERE NOT EXISTS (SELECT 1 FROM "Subscription" s WHERE s."workspaceId" = w."id");

-- One target per legacy platform entry. The social account is linked on boot, once legacy
-- tokens have been encrypted into SocialAccount rows.
INSERT INTO "PostTarget" (
  "id", "postId", "platform", "scheduledAt", "status", "idempotencyKey",
  "remotePostId", "publishedAt", "reach", "impressions", "engagements", "clicks", "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  p."id",
  UPPER(pl.platform)::"SocialPlatform",
  p."scheduledAt",
  (CASE p."status"
    WHEN 'published' THEN 'PUBLISHED'
    WHEN 'scheduled' THEN 'SCHEDULED'
    WHEN 'failed' THEN 'FAILED'
    ELSE 'PENDING'
  END)::"TargetStatus",
  gen_random_uuid()::text,
  CASE WHEN pl.platform = 'facebook' THEN p."facebookPostId" END,
  CASE WHEN p."status" = 'published' THEN p."updatedAt" END,
  CASE WHEN pl.platform = 'facebook' AND p."facebookPostId" IS NOT NULL THEN p."reach" END,
  CASE WHEN pl.platform = 'facebook' AND p."facebookPostId" IS NOT NULL THEN p."impressions" END,
  CASE WHEN pl.platform = 'facebook' AND p."facebookPostId" IS NOT NULL THEN p."engagements" END,
  CASE WHEN pl.platform = 'facebook' AND p."facebookPostId" IS NOT NULL THEN p."clicks" END,
  CURRENT_TIMESTAMP
FROM "Post" p
CROSS JOIN LATERAL unnest(p."platforms") AS pl(platform)
WHERE pl.platform IN ('facebook', 'instagram', 'youtube', 'linkedin', 'tiktok');

-- Legacy uploads live at the upload root.
UPDATE "Media" SET "storageKey" = "filename" WHERE "storageKey" IS NULL;
