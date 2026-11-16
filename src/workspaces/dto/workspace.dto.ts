import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {WorkspaceRole} from '@prisma/client';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({name: 'ianaTimezone'})
export class IsIanaTimezone implements ValidatorConstraintInterface {
  validate(value: unknown) {
    if (typeof value !== 'string' || !value) {
      return false;
    }
    try {
      new Intl.DateTimeFormat('en-US', {timeZone: value});
      return true;
    } catch {
      return false;
    }
  }

  defaultMessage() {
    return 'timezone must be an IANA timezone such as Asia/Dhaka';
  }
}

const ASSIGNABLE_ROLES: WorkspaceRole[] = ['ADMIN', 'EDITOR', 'APPROVER', 'VIEWER'];

export class CreateWorkspaceDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name: string;

  @ApiPropertyOptional({default: 'Asia/Dhaka'})
  @IsOptional()
  @Validate(IsIanaTimezone)
  timezone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  businessType?: string;
}

export class UpdateWorkspaceDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Validate(IsIanaTimezone)
  timezone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  businessType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  approvalRequired?: boolean;
}

export class InviteMemberDto {
  @ApiProperty()
  @IsEmail()
  email: string;

  @ApiProperty({enum: ASSIGNABLE_ROLES})
  @IsIn(ASSIGNABLE_ROLES)
  role: WorkspaceRole;
}

export class UpdateMemberDto {
  @ApiProperty({enum: ASSIGNABLE_ROLES})
  @IsIn(ASSIGNABLE_ROLES)
  role: WorkspaceRole;
}
