import { Module } from '@nestjs/common';
import { DbModule } from './db/db.module';
import { SummaryModule } from './summary/summary.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { EvaluatorModule } from './evaluator/evaluator.module';
import { AdminModule } from './admin/admin.module';

@Module({
  imports: [DbModule, EvaluatorModule, IngestionModule, SummaryModule, AdminModule],
})
export class AppModule {}
