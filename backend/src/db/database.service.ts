import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { config } from '../config';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private pool: Pool;

  constructor() {
    this.pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
    this.pool.on('error', (error) => console.error('PostgreSQL pool error:', error.message));
  }

  query<T = any>(text: string, params?: any[]): Promise<{ rows: T[]; rowCount: number }> {
    return this.pool.query(text, params as any[]) as any;
  }

  async getClient(): Promise<PoolClient> {
    return this.pool.connect();
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
