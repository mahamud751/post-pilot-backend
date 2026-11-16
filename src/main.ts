import {NestFactory} from '@nestjs/core';
import {ConfigService} from '@nestjs/config';
import {DocumentBuilder, SwaggerModule} from '@nestjs/swagger';
import {AppModule} from './app.module';
import {configureApp} from './configure-app';

async function bootstrap() {
  // rawBody lets the billing webhook verify signatures over the exact bytes received.
  const app = await NestFactory.create(AppModule, {rawBody: true});
  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 4000);
  const nodeEnv = configService.get<string>('NODE_ENV', 'development');
  const jwtSecret = configService.get<string>('JWT_SECRET', 'postpilot-dev-secret');
  const corsOrigins = String(configService.get<string>('CORS_ORIGINS', '') || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);

  app.enableShutdownHooks();

  if (nodeEnv === 'production' && jwtSecret === 'postpilot-dev-secret') {
    throw new Error('JWT_SECRET must be configured in production.');
  }

  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : true,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-workspace-id'],
  });
  configureApp(app);

  const swaggerConfig = new DocumentBuilder()
    .setTitle('PostPilot API')
    .setDescription('PostPilot backend documentation')
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document);

  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`PostPilot backend running at http://localhost:${port}/v1`);
}

bootstrap();
