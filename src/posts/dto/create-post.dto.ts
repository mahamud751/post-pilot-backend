import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {IsArray, IsISO8601, IsOptional, IsString} from 'class-validator';

export class CreatePostDto {
  @ApiProperty()
  @IsString()
  caption: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  mediaUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  mediaType?: string;

  @ApiPropertyOptional({type: [String]})
  @IsOptional()
  @IsArray()
  platforms?: string[];

  @ApiPropertyOptional({default: 'draft'})
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  scheduledAt?: string;
}

