import {BadRequestException, ValidationError, ValidationPipe} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import {ConfigService} from '@nestjs/config';
import {DocumentBuilder, SwaggerModule} from '@nestjs/swagger';
import * as cookieParser from 'cookie-parser';
import {AppModule} from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 4000);
  const nodeEnv = configService.get<string>('NODE_ENV', 'development');
  const jwtSecret = configService.get<string>('JWT_SECRET', 'postpilot-dev-secret');
  const corsOrigins = String(configService.get<string>('CORS_ORIGINS', '') || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);

  if (nodeEnv === 'production' && jwtSecret === 'postpilot-dev-secret') {
    throw new Error('JWT_SECRET must be configured in production.');
  }

  app.use(cookieParser());
  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : true,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  app.setGlobalPrefix('v1');

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      exceptionFactory: (errors: ValidationError[]) =>
        new BadRequestException({
          message: 'Validation failed',
          errors: errors.map(error => ({
            property: error.property,
            constraints: error.constraints,
          })),
        }),
    }),
  );

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
