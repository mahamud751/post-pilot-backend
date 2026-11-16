import {PlanCode} from '@prisma/client';

export type PlanLimits = {
  channels: number;
  scheduledPostsPerPeriod: number;
  aiCreditsPerPeriod: number;
  workspaces: number;
  teamApprovals: boolean;
};

export type PlanDefinition = {
  code: PlanCode;
  name: string;
  /** Monthly price in BDT. PRD section 15: validation assumptions, not market-verified. */
  priceBdt: number;
  limits: PlanLimits;
};

export const TRIAL_DAYS = 14;
export const GRACE_DAYS = 7;
/** Annual billing discount (PRD section 15). */
export const ANNUAL_DISCOUNT = 0.2;

export const AI_CREDIT_COST = {captions: 1, content_plan: 5, autopilot: 5, image: 4, video: 4, replies: 1} as const;

export const PLANS: Record<PlanCode, PlanDefinition> = {
  TRIAL: {
    code: 'TRIAL',
    name: 'Trial',
    priceBdt: 0,
    limits: {channels: 2, scheduledPostsPerPeriod: 30, aiCreditsPerPeriod: 30, workspaces: 1, teamApprovals: true},
  },
  STARTER: {
    code: 'STARTER',
    name: 'Starter',
    priceBdt: 499,
    limits: {channels: 2, scheduledPostsPerPeriod: 30, aiCreditsPerPeriod: 30, workspaces: 1, teamApprovals: false},
  },
  GROWTH: {
    code: 'GROWTH',
    name: 'Growth',
    priceBdt: 1499,
    limits: {channels: 5, scheduledPostsPerPeriod: 150, aiCreditsPerPeriod: 150, workspaces: 1, teamApprovals: false},
  },
  AGENCY: {
    code: 'AGENCY',
    name: 'Agency',
    priceBdt: 3999,
    limits: {channels: 15, scheduledPostsPerPeriod: 600, aiCreditsPerPeriod: 500, workspaces: 5, teamApprovals: true},
  },
};

export const PAID_PLANS: PlanCode[] = ['STARTER', 'GROWTH', 'AGENCY'];

export function priceFor(plan: PlanCode, cycle: 'monthly' | 'annual') {
  const monthly = PLANS[plan].priceBdt;
  return cycle === 'annual' ? Math.round(monthly * 12 * (1 - ANNUAL_DISCOUNT)) : monthly;
}
