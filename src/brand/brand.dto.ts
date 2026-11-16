import {ApiPropertyOptional} from '@nestjs/swagger';
import {Type} from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export const BRAND_LANGUAGES = ['en', 'bn', 'mixed'] as const;

export class BrandProductDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  /** Free text such as "৳350" so local formats are kept as written. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  price?: string;
}

export class BrandOfferDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  details?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  validUntil?: string;
}

export class UpdateBrandDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  audience?: string;

  @ApiPropertyOptional({type: [BrandProductDto]})
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({each: true})
  @Type(() => BrandProductDto)
  products?: BrandProductDto[];

  @ApiPropertyOptional({type: [BrandOfferDto]})
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({each: true})
  @Type(() => BrandOfferDto)
  approvedOffers?: BrandOfferDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({each: true})
  @MaxLength(80, {each: true})
  doNotSay?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  tone?: string;

  @ApiPropertyOptional({enum: BRAND_LANGUAGES, isArray: true})
  @IsOptional()
  @IsArray()
  @IsIn(BRAND_LANGUAGES, {each: true})
  languages?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({require_protocol: true}, {message: 'website must be a full URL starting with https://'})
  website?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({each: true})
  @MaxLength(120, {each: true})
  ctas?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  mediaGuidelines?: string;
}
