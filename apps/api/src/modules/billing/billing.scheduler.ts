import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { config } from '../../config';
import { BillingService } from './billing.service';

/**
 * Lance le cycle de facturation à intervalle régulier. Plusieurs instances de l'API peuvent tourner :
 * un verrou PostgreSQL (cf. BillingService.runCycle) garantit qu'un seul cycle s'exécute à la fois.
 */
@Injectable()
export class BillingScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private readonly logger = new Logger('CycleFacturation');
  constructor(private readonly billing: BillingService) {}

  onApplicationBootstrap() {
    if (!config.jobs.enabled) return;
    this.timer = setInterval(() => {
      this.billing.runCycle().then(
        (s) => (s.skipped ? this.logger.debug('Cycle déjà en cours sur une autre instance : sauté.') : this.logger.log(JSON.stringify(s))),
        (e) => this.logger.error(e),
      );
    }, config.jobs.billingIntervalMs);
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
}
