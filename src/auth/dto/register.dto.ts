import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {
  Equals,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  Validate,
} from 'class-validator';
import {IsIanaTimezone} from '../../workspaces/dto/workspace.dto';

export class RegisterDto {
  @ApiProperty()
  @IsNotEmpty()
  name: string;

  @ApiProperty()
  @IsEmail()
  email: string;

  @ApiProperty()
  @MinLength(8)
  @MaxLength(128)
  password: string;

  @ApiProperty({description: 'Must be true: the user accepts the Terms and Privacy Policy'})
  @Equals(true, {message: 'You must accept the Terms and Privacy Policy'})
  acceptTerms: boolean;

  @ApiPropertyOptional({description: "Brand or business name; defaults to \"<name>'s workspace\""})
  @IsOptional()
  @IsString()
  @MaxLength(80)
  workspaceName?: string;

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
