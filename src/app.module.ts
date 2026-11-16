import {Module} from '@nestjs/common';
import {ConfigModule} from '@nestjs/config';
import {ServeStaticModule} from '@nestjs/serve-static';
import {ThrottlerModule} from '@nestjs/throttler';
import {join} from 'path';
import {AdminModule} from './admin/admin.module';
import {AiModule} from './ai/ai.module';
import {AnalyticsModule} from './analytics/analytics.module';
import {AppController} from './app.controller';
import {AuditModule} from './audit/audit.module';
import {AuthModule} from './auth/auth.module';
import {AutopilotModule} from './autopilot/autopilot.module';
import {BillingModule} from './billing/billing.module';
import {BrandModule} from './brand/brand.module';
import {CryptoModule} from './crypto/crypto.module';
import {DashboardModule} from './dashboard/dashboard.module';
import {MailModule} from './mail/mail.module';
import {MediaModule} from './media/media.module';
import {NotificationsModule} from './notifications/notifications.module';
import {PostsModule} from './posts/posts.module';
import {PrismaModule} from './prisma/prisma.module';
import {PublishingModule} from './publishing/publishing.module';
import {SocialModule} from './social/social.module';
import {WorkspacesModule} from './workspaces/workspaces.module';

@Module({
  imports: [
    ConfigModule.forRoot({isGlobal: true}),
    // Files uploaded before workspaces existed; newer files are served through signed URLs.
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), 'uploads'),
      serveRoot: '/uploads',
      serveStaticOptions: {index: false},
      exclude: ['/v1/(.*)'],
    }),
    // Only applied where AuthThrottlerGuard is used; see that guard for why it is not global.
    ThrottlerModule.forRoot([{ttl: 15 * 60_000, limit: 10}]),
    PrismaModule,
    CryptoModule,
    MailModule,
    AuditModule,
    NotificationsModule,
    BillingModule,
    AuthModule,
    WorkspacesModule,
    BrandModule,
    SocialModule,
    MediaModule,
    PublishingModule,
    PostsModule,
    AiModule,
    AutopilotModule,
    AnalyticsModule,
    DashboardModule,
    AdminModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
