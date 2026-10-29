import { createHmac } from 'node:crypto';
import { config } from '../../config';
import { safeEqual } from '../../common/crypto';

/** Paiement confirmé, tel que décrit par un prestataire après vérification. */
export interface VerifiedPayment {
  eventId: string;
  invoiceId: string;
  providerRef: string;
  amount: number;
  currency: string;
  status: 'succeeded' | 'failed';
}

/**
 * Contrat commun aux prestataires (agrégateurs mobile money, carte, virement).
 * Aucune donnée de carte ni secret de paiement n'est stocké par Kora : seulement la référence du prestataire.
 */
export interface PaymentProvider {
  readonly code: string;
  createCheckout(invoice: { id: string; number: string; amount: number; currency: string; companyId: string }): Promise<{ checkoutUrl: string; reference: string }>;
  /** Authentifie la notification (signature) puis la confirme auprès du prestataire. Lève une erreur si invalide. */
  verifyNotification(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<VerifiedPayment>;
}

/** Prestataire de test : signature HMAC-SHA256 du corps brut avec PAYMENT_SANDBOX_SECRET. */
export class SandboxProvider implements PaymentProvider {
  readonly code = 'sandbox';

  static sign(raw: string | Buffer) {
    return createHmac('sha256', config.payments.sandboxSecret).update(raw).digest('hex');
  }

  async createCheckout(invoice: { id: string; number: string; amount: number; currency: string }) {
    const reference = `sbx_${invoice.id.replace(/-/g, '').slice(0, 16)}_${Date.now()}`;
    return { reference, checkoutUrl: `${config.webUrl}/paiement-test?invoice=${invoice.id}&ref=${reference}` };
  }

  async verifyNotification(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<VerifiedPayment> {
    const sig = String(headers['x-kora-signature'] ?? '');
    if (!sig || !safeEqual(sig, SandboxProvider.sign(rawBody))) throw new Error('signature invalide');
    const p = JSON.parse(rawBody.toString('utf8'));
    if (!p.event_id || !p.invoice_id || !p.reference) throw new Error('notification incomplète');
    return { eventId: String(p.event_id), invoiceId: String(p.invoice_id), providerRef: String(p.reference), amount: Number(p.amount), currency: String(p.currency), status: p.status === 'failed' ? 'failed' : 'succeeded' };
  }
}

// Les connecteurs réels (agrégateur mobile money local, carte internationale) implémenteront PaymentProvider
// et seront ajoutés ici après choix du prestataire (décision en attente, cf. dossier de conception).
export const PAYMENT_PROVIDERS: Record<string, PaymentProvider> = { sandbox: new SandboxProvider() };
