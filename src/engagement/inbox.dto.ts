import {Type} from 'class-transformer';
import {EngagementStatus, LeadStage, SocialPlatform} from '@prisma/client';
import {IsEnum, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateIf} from 'class-validator';

export class InboxQuery {
  @IsOptional() @IsIn([...Object.values(EngagementStatus), 'ALL', 'ATTENTION']) status?: string;
  @IsOptional() @IsEnum(LeadStage) stage?: LeadStage;
  @IsOptional() @IsEnum(SocialPlatform) platform?: SocialPlatform;
  @IsOptional() @IsString() @MaxLength(120) search?: string;
  @IsOptional() @IsString() @MaxLength(100) assignee?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) take = 25;
}

export class UpdateLeadDto {
  @ValidateIf((_object, value) => value !== undefined) @IsEnum(LeadStage) leadStage?: LeadStage;
  @IsOptional() @IsString() @MaxLength(100) assignedMemberId?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) internalNote?: string | null;
}
