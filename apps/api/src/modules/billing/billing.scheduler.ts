import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { config } from '../../config';
import { BillingService } from './billing.service';

/** Lance le cycle de facturation à intervalle régulier (un seul processus en production : verrou à prévoir si plusieurs instances). */
@Injectable()
export class BillingScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private readonly logger = new Logger('CycleFacturation');
  constructor(private readonly billing: BillingService) {}

  onApplicationBootstrap() {
    if (!config.jobs.enabled) return;
    this.timer = setInterval(() => {
      this.billing.runCycle().then((s) => this.logger.log(JSON.stringify(s)), (e) => this.logger.error(e));
    }, config.jobs.billingIntervalMs);
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
}
