import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {IsBoolean, IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength} from 'class-validator';

export class TokenDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  token: string;
}

export class EmailDto {
  @ApiProperty()
  @IsEmail()
  email: string;
}

export class ResetPasswordDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  token: string;

  @ApiProperty()
  @MinLength(8)
  @MaxLength(128)
  password: string;
}

export class ChangePasswordDto {
  @ApiPropertyOptional({description: 'Required when the account already has a password'})
  @IsOptional()
  @IsString()
  currentPassword?: string;

  @ApiProperty()
  @MinLength(8)
  @MaxLength(128)
  newPassword: string;
}

export class GoogleLoginDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  code: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  state: string;

  /** New accounts created through Google must accept the terms too. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  acceptTerms?: boolean;
}
