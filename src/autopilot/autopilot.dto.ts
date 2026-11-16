import {ApiPropertyOptional} from '@nestjs/swagger';
import {AutopilotMode, GrowthGoal, ReplyMode} from '@prisma/client';
import {Type} from 'class-transformer';
import {IsBoolean, IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min} from 'class-validator';

export class UpdateAutopilotDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({enum: AutopilotMode})
  @IsOptional()
  @IsEnum(AutopilotMode)
  mode?: AutopilotMode;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  autopublishEnabled?: boolean;

  @ApiPropertyOptional({enum: GrowthGoal})
  @IsOptional()
  @IsEnum(GrowthGoal)
  goal?: GrowthGoal;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(14)
  postsPerWeek?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  dailyPostLimit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  analyzeEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  generateEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  optimizeSchedule?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  researchEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  creativesEnabled?: boolean;

  @ApiPropertyOptional({description: 'Run autopilot automatically on a fixed cadence.'})
  @IsOptional()
  @IsBoolean()
  scheduleEnabled?: boolean;

  @ApiPropertyOptional({description: 'Days between automatic runs.'})
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(30)
  runEveryDays?: number;

  @ApiPropertyOptional({enum: ReplyMode, description: 'OFF, DRAFT (suggest replies) or AUTO (send safe replies).'})
  @IsOptional()
  @IsEnum(ReplyMode)
  replyMode?: ReplyMode;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  replyComments?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  replyDms?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  replyInstructions?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  replyHourlyLimit?: number;
}
