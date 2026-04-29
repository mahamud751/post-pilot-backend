import {ApiPropertyOptional} from '@nestjs/swagger';
import {IsOptional, IsString, IsUrl, MaxLength} from 'class-validator';

export class UpdateProfileDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({require_tld: false})
  avatarUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({require_tld: false})
  facebookUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({require_tld: false})
  instagramUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({require_tld: false})
  youtubeUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  facebookName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  instagramName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  youtubeName?: string;
}

