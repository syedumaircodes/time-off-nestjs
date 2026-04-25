import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // This line enables the @IsString, @Min, etc. decorators in DTOs
  app.useGlobalPipes(new ValidationPipe());
  await app.listen(3000);
}
bootstrap();
