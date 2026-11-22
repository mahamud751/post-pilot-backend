import {Type} from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  Equals,
  IsArray,
  IsBoolean,
  IsISO8601,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import {BRAND_LANGUAGES} from '../brand/brand.dto';

export class CreateCampaignDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @Type(() => Number)
  @IsIn([7, 30])
  days: 7 | 30;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  startDate: string;

  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  postTime: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({each: true})
  accountIds: string[];

  @IsOptional()
  @IsIn(BRAND_LANGUAGES)
  language?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  goal?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  themes?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ArrayUnique()
  @IsString({each: true})
  creatorIds?: string[];

  @IsIn(['TEXT', 'UPLOAD', 'AI_IMAGE', 'AI_VIDEO', 'AI_MIXED'])
  mediaMode: 'TEXT' | 'UPLOAD' | 'AI_IMAGE' | 'AI_VIDEO' | 'AI_MIXED';

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ArrayUnique()
  @IsString({each: true})
  mediaIds?: string[];

  @IsBoolean()
  autoSchedule: boolean;

  /** Confirms the whole campaign, its destinations and its estimated credit spend. */
  @Equals(true)
  confirm: boolean;

  /** Makes network retries of campaign creation idempotent. */
  @Matches(/^[a-zA-Z0-9-]{16,80}$/)
  requestId: string;
}

export class CampaignActionDto {
  @IsIn(['pause', 'resume', 'retry', 'schedule', 'cancel'])
  action: 'pause' | 'resume' | 'retry' | 'schedule' | 'cancel';
}

export class UpdateCampaignItemDto {
  @IsOptional()
  @IsISO8601({strict: true})
  plannedAt?: string;

  @IsOptional()
  @IsBoolean()
  skip?: boolean;
}
