import {Logger} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import {AppModule} from './app.module';

/** Standalone publishing worker (PRD section 17: isolated API and worker services). */
async function bootstrap() {
  process.env.PUBLISH_WORKER = 'on';
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
  Logger.log('PostPilot publish worker running', 'Worker');
}

bootstrap();
