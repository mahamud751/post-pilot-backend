import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {SocialPlatform} from '@prisma/client';
import {Type} from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {BRAND_LANGUAGES} from '../brand/brand.dto';

export class CaptionRequestDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  topic: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  product?: string;

  @ApiProperty({enum: SocialPlatform})
  @IsEnum(SocialPlatform)
  platform: SocialPlatform;

  @ApiPropertyOptional({enum: BRAND_LANGUAGES})
  @IsOptional()
  @IsIn(BRAND_LANGUAGES)
  language?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  tone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  goal?: string;

  @ApiPropertyOptional({default: 3})
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  count?: number;
}

export class RegenerateDto {
  @IsString()
  generationId: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  optionIndex: number;

  @IsIn(['headline', 'caption', 'hashtags', 'cta'])
  section: 'headline' | 'caption' | 'hashtags' | 'cta';

  @IsOptional()
  @IsString()
  @MaxLength(300)
  instruction?: string;
}

export class ContentPlanRequestDto {
  @ApiProperty({enum: [7, 15, 30]})
  @Type(() => Number)
  @IsIn([7, 15, 30])
  days: 7 | 15 | 30;

  @ApiProperty({enum: SocialPlatform, isArray: true})
  @IsArray()
  @ArrayMinSize(1)
  @IsEnum(SocialPlatform, {each: true})
  platforms: SocialPlatform[];

  @ApiPropertyOptional({description: 'YYYY-MM-DD in the workspace timezone; defaults to tomorrow'})
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  startDate?: string;

  @ApiPropertyOptional({description: 'HH:mm local time for each draft; defaults to 10:00'})
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  postTime?: string;

  @ApiPropertyOptional({default: 4})
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(14)
  postsPerWeek?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  goal?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  themes?: string;

  @ApiPropertyOptional({enum: BRAND_LANGUAGES})
  @IsOptional()
  @IsIn(BRAND_LANGUAGES)
  language?: string;
}

export class FeedbackDto {
  @IsIn([1, -1])
  value: 1 | -1;
}
