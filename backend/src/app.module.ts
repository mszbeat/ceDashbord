import { Module } from '@nestjs/common';
import { DbModule } from './db/db.module';
import { SummaryModule } from './summary/summary.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { EvaluatorModule } from './evaluator/evaluator.module';

@Module({
  imports: [DbModule, EvaluatorModule, IngestionModule, SummaryModule],
})
export class AppModule {}
