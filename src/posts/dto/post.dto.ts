import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {Type} from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export const POST_STATUSES = [
  'draft',
  'in_review',
  'approved',
  'scheduled',
  'processing',
  'published',
  'failed',
  'cancelled',
  'needs_action',
] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

export class TargetInputDto {
  @ApiProperty()
  @IsString()
  socialAccountId: string;

  @ApiPropertyOptional({description: 'Per-channel text; falls back to the master caption'})
  @IsOptional()
  @IsString()
  @MaxLength(63206)
  channelText?: string | null;
}

/** A wall-clock time in the workspace timezone, e.g. {date: "2026-10-25", time: "18:30"}. */
export class LocalTimeDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date: string;

  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  time: string;
}

export class CreatePostDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiProperty()
  @IsString()
  @MaxLength(63206)
  caption: string;

  @ApiPropertyOptional({type: [String]})
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({each: true})
  mediaIds?: string[];

  @ApiPropertyOptional({type: [TargetInputDto]})
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({each: true})
  @Type(() => TargetInputDto)
  targets?: TargetInputDto[];

  @ApiPropertyOptional({description: 'Planned date for a draft (ISO instant)'})
  @IsOptional()
  @IsISO8601({strict: true})
  plannedAt?: string | null;

  /** Legacy clients: platform names resolved to the workspace's connected accounts. */
  @ApiPropertyOptional({type: [String], deprecated: true})
  @IsOptional()
  @IsArray()
  @IsString({each: true})
  platforms?: string[];

  @ApiPropertyOptional({deprecated: true})
  @IsOptional()
  @IsString()
  mediaUrl?: string;

  @ApiPropertyOptional({deprecated: true})
  @IsOptional()
  @IsString()
  mediaType?: string;

  @ApiPropertyOptional({deprecated: true})
  @IsOptional()
  @IsString()
  thumbnailUrl?: string;
}

export class UpdatePostDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(63206)
  caption?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({each: true})
  mediaIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({each: true})
  @Type(() => TargetInputDto)
  targets?: TargetInputDto[];

  @IsOptional()
  @IsISO8601({strict: true})
  plannedAt?: string | null;

  /** Moves a scheduled post (drag-to-reschedule). */
  @IsOptional()
  @IsISO8601({strict: true})
  scheduledAt?: string;
}

export class ScheduleDto {
  @ApiPropertyOptional({description: 'ISO instant; use local or publishNow instead if preferred'})
  @IsOptional()
  @IsISO8601({strict: true})
  scheduledAt?: string;

  @ApiPropertyOptional({type: LocalTimeDto})
  @IsOptional()
  @ValidateNested()
  @Type(() => LocalTimeDto)
  local?: LocalTimeDto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  publishNow?: boolean;

  /** The user explicitly confirmed destinations, preview and time (PRD section 9, step 2). */
  @ApiProperty()
  @IsBoolean()
  confirm: boolean;

  @ApiPropertyOptional({type: [String], description: 'Limit to these targets; default all unscheduled'})
  @IsOptional()
  @IsArray()
  @IsString({each: true})
  targetIds?: string[];
}

export class ReviewDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;
}

export class RejectDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  comment: string;
}

export class ApproveDto {
  /** The contentVersion the approver reviewed; stale approvals are refused. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version: number;

  @IsOptional()
  @IsBoolean()
  acknowledgeFlags?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;
}

export class RetryDto {
  /** Required when the last attempt's outcome was ambiguous. */
  @IsOptional()
  @IsBoolean()
  confirmNotPublished?: boolean;
}

export class ListPostsQuery {
  @IsOptional()
  @IsIn(POST_STATUSES)
  status?: PostStatus;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  take?: number;
}
