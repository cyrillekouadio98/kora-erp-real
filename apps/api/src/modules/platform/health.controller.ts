import { Controller, Get } from '@nestjs/common';
import { sql } from 'kysely';
import { Public } from '../../common/decorators';
import { DatabaseService } from '../../db/database.service';

@Controller('health')
export class HealthController {
  constructor(private readonly db: DatabaseService) {}

  @Public()
  @Get()
  async health() {
    await sql`select 1`.execute(this.db.app);
    return { status: 'ok' };
  }
}
