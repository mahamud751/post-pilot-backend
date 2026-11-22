import {SocialPlatform} from '@prisma/client';

export type PlatformCapabilities = {
  platform: SocialPlatform;
  label: string;
  /** Whether this release can connect and publish to the platform at all. */
  available: boolean;
  unavailableReason?: string;
  /** Connected through another platform's login (Instagram uses Facebook Login). */
  connectVia?: SocialPlatform;
  text: boolean;
  photo: boolean;
  video: boolean;
  carousel: boolean;
  reel: boolean;
  metrics: boolean;
  requiresMedia: boolean;
  maxTextLength: number;
  imageMimeTypes: string[];
  videoMimeTypes: string[];
  maxImageBytes: number;
  /** Width/height bounds, if the platform enforces them. */
  aspectRatio?: {min: number; max: number};
};

const R2 = 'Planned for a later release; needs platform app approval first.';

/**
 * Capability matrix (PRD section 8). Only what the adapters really implement is marked true,
 * so the UI never offers an unsupported publish option. Recheck against Meta docs quarterly.
 */
export const PLATFORMS: Record<SocialPlatform, PlatformCapabilities> = {
  FACEBOOK: {
    platform: 'FACEBOOK',
    label: 'Facebook Page',
    available: true,
    text: true,
    photo: true,
    video: true,
    carousel: true,
    reel: false,
    metrics: true,
    requiresMedia: false,
    maxTextLength: 63206,
    imageMimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
    videoMimeTypes: ['video/mp4', 'video/quicktime'],
    maxImageBytes: 4 * 1024 * 1024,
  },
  INSTAGRAM: {
    platform: 'INSTAGRAM',
    label: 'Instagram Professional',
    available: true,
    connectVia: 'FACEBOOK',
    text: false,
    photo: true,
    video: true,
    carousel: true,
    reel: true,
    metrics: true,
    requiresMedia: true,
    maxTextLength: 2200,
    imageMimeTypes: ['image/jpeg'],
    videoMimeTypes: ['video/mp4', 'video/quicktime'],
    maxImageBytes: 8 * 1024 * 1024,
    aspectRatio: {min: 4 / 5, max: 1.91},
  },
  YOUTUBE: unavailable('YOUTUBE', 'YouTube'),
  LINKEDIN: unavailable('LINKEDIN', 'LinkedIn'),
  TIKTOK: unavailable('TIKTOK', 'TikTok'),
};

function unavailable(platform: SocialPlatform, label: string): PlatformCapabilities {
  return {
    platform,
    label,
    available: false,
    unavailableReason: R2,
    text: false,
    photo: false,
    video: false,
    carousel: false,
    reel: false,
    metrics: false,
    requiresMedia: false,
    maxTextLength: 0,
    imageMimeTypes: [],
    videoMimeTypes: [],
    maxImageBytes: 0,
  };
}

export type MediaFacts = {mimeType: string; size: number; width: number | null; height: number | null};

/** Returns human-readable reasons this content can't be published to `platform` (FR-06). */
export function validateForPlatform(
  platform: SocialPlatform,
  text: string,
  media: MediaFacts[],
): string[] {
  const caps = PLATFORMS[platform];
  const label = caps.label;
  if (!caps.available) {
    return [`${label} publishing is not available yet.`];
  }
  const problems: string[] = [];
  if (text.length > caps.maxTextLength) {
    problems.push(`${label} text is ${text.length} characters; the limit is ${caps.maxTextLength}.`);
  }
  if (!text.trim() && media.length === 0) {
    problems.push(`${label} posts need text or media.`);
  }
  if (caps.requiresMedia && media.length === 0) {
    problems.push(`${label} requires an image or video.`);
  }
  if (media.length > 10) {
    problems.push(`${label} accepts at most 10 images in a carousel.`);
  }
  if (media.length > 1 && !caps.carousel) {
    problems.push(`${label} supports one media item per post in this release.`);
  }
  if (media.length > 1 && media.some(item => item.mimeType.startsWith('video/'))) {
    problems.push(`${label} supports up to 10 images together, or one video on its own.`);
  }
  for (const item of media) {
    const isImage = item.mimeType.startsWith('image/');
    const isVideo = item.mimeType.startsWith('video/');
    if (!isImage && !isVideo) problems.push(`${label} requires image or video files.`);
    if (isImage && !caps.imageMimeTypes.includes(item.mimeType)) {
      problems.push(`${label} does not accept ${item.mimeType} images${caps.imageMimeTypes.length ? ` (use ${caps.imageMimeTypes.join(', ')})` : ''}.`);
    } else if (isVideo && !caps.videoMimeTypes.includes(item.mimeType)) {
      problems.push(`${label} video posts are not supported in this release.`);
    } else if (isImage && item.size > caps.maxImageBytes) {
      problems.push(`${label} images must be under ${Math.round(caps.maxImageBytes / 1048576)} MB.`);
    }
    if (isImage && caps.aspectRatio && item.width && item.height) {
      const ratio = item.width / item.height;
      if (ratio < caps.aspectRatio.min - 0.005 || ratio > caps.aspectRatio.max + 0.005) {
        problems.push(`${label} images must have an aspect ratio between 4:5 and 1.91:1 (this one is ${item.width}×${item.height}).`);
      }
    }
  }
  return problems;
}
