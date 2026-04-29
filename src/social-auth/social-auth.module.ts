import {Module} from '@nestjs/common';
import {PrismaModule} from '../prisma/prisma.module';
import {SocialAuthController} from './social-auth.controller';
import {SocialAuthService} from './social-auth.service';

@Module({
  imports: [PrismaModule],
  controllers: [SocialAuthController],
  providers: [SocialAuthService],
})
export class SocialAuthModule {}

