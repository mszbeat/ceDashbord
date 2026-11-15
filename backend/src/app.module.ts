import { Module } from '@nestjs/common';
import { DbModule } from './db/db.module';
import { SummaryModule } from './summary/summary.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { EvaluatorModule } from './evaluator/evaluator.module';
import { PartAuthenticationModule } from './part-authentication/part-authentication.module';

@Module({
  imports: [DbModule, EvaluatorModule, IngestionModule, SummaryModule, PartAuthenticationModule],
})
export class AppModule {}
