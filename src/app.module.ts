import {Module} from '@nestjs/common';
import {ConfigModule} from '@nestjs/config';
import {ServeStaticModule} from '@nestjs/serve-static';
import {join} from 'path';
import {AppController} from './app.controller';
import {AiModule} from './ai/ai.module';
import {AnalyticsModule} from './analytics/analytics.module';
import {AuthModule} from './auth/auth.module';
import {MediaModule} from './media/media.module';
import {PostsModule} from './posts/posts.module';
import {PrismaModule} from './prisma/prisma.module';
import {ScheduleModule} from './schedule/schedule.module';

@Module({
  imports: [
    ConfigModule.forRoot({isGlobal: true}),
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), 'uploads'),
      serveRoot: '/uploads',
    }),
    PrismaModule,
    AuthModule,
    MediaModule,
    PostsModule,
    ScheduleModule,
    AnalyticsModule,
    AiModule,
  ],
  controllers: [AppController],
})
export class AppModule {}

