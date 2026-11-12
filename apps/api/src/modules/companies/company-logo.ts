import { z } from 'zod';
import { parseImage } from '../../common/images';
import { parse } from '../../common/validation';
import type { TenantContext, TenantTrx, Trx } from '../../db/database.service';
import type { AuditService } from '../audit/audit.service';

/** Logo envoyé en data URL ; null le retire. */
export const parseLogo = (body: unknown) =>
  parse(z.object({ logo: z.string().max(410_000, { message: 'Image trop lourde' }).nullable() }).strict(), body).logo;

/** Adresse du logo pour l'application (null sans logo) ; la version dans l'adresse renouvelle le cache. */
export async function logoUrl(trx: Trx): Promise<string | null> {
  const l = await trx.selectFrom('company_logo').select('updated_at').executeTakeFirst();
  return l ? `/company/logo?v=${new Date(l.updated_at).getTime()}` : null;
}

/** Logo en data URL, pour une page sans session (document consulté par lien) ou la console éditeur. */
export async function logoDataUrl(trx: Trx): Promise<string | null> {
  const l = await trx.selectFrom('company_logo').select(['mime', 'data']).executeTakeFirst();
  return l ? `data:${l.mime};base64,${Buffer.from(l.data).toString('base64')}` : null;
}

/** Enregistre ou retire le logo de l'entreprise du contexte, et le trace au journal d'audit. */
export async function saveLogo(trx: TenantTrx, audit: AuditService, ctx: TenantContext, logo: string | null) {
  if (logo) {
    const { mime, data } = parseImage(logo);
    await trx.insertInto('company_logo').values({ company_id: ctx.companyId, mime, data })
      .onConflict((oc) => oc.column('company_id').doUpdateSet({ mime, data, updated_at: new Date() })).execute();
  } else {
    await trx.deleteFrom('company_logo').where('company_id', '=', ctx.companyId).execute();
  }
  await audit.tenant(trx, ctx, { action: logo ? 'company.logo_updated' : 'company.logo_removed', entityType: 'company', entityId: ctx.companyId });
}
