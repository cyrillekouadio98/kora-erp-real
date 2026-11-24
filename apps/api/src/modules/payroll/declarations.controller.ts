import { Body, Controller, Get, HttpCode, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AllowWhenReadOnly, Permission, Tenant } from '../../common/decorators';
import { badRequest } from '../../common/errors';
import { RequireFeature } from '../../common/features';
import type { TenantInfo } from '../../common/request-context';
import { parse } from '../../common/validation';
import { DatabaseService } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import type { PayslipLine } from './payroll.calc';

const FEATURE = 'social_declarations';
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'Mois attendu : AAAA-MM' });

interface Row {
  employeeId: string; number: string; name: string; cnpsNumber: string | null; contractType: string; months: number; firstPeriod: string; lastPeriod: string;
  gross: number; taxable: number; retirementBase: number; retirementEmployee: number; retirementEmployer: number; smallBase: number; familyBenefits: number; workAccident: number;
  cmuEmployee: number; cmuEmployer: number; itsGross: number; itsReduction: number; its: number; employerTax: number; apprenticeship: number; training: number; net: number;
}
const FIELDS = ['gross', 'taxable', 'retirementBase', 'retirementEmployee', 'retirementEmployer', 'smallBase', 'familyBenefits', 'workAccident', 'cmuEmployee', 'cmuEmployer',
  'itsGross', 'itsReduction', 'its', 'employerTax', 'apprenticeship', 'training', 'net'] as const;

/**
 * États préparatoires des déclarations sociales et fiscales (Côte d'Ivoire), à partir des seuls bulletins validés :
 * CNPS (retraite, prestations familiales, accident du travail, CMU), ITS et taxes patronales, DISA annuelle.
 * Les montants reprennent ceux des bulletins : ils se vérifient avant dépôt sur les portails de la CNPS et de la DGI.
 */
@ApiTags('Paie')
@Controller('company/payroll/declarations')
export class DeclarationsController {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

  @Permission('payroll.read') @RequireFeature(FEATURE) @AllowWhenReadOnly()
  @Get()
  get(@Tenant() t: TenantInfo, @Query() query: unknown) {
    const { from, to } = parse(z.object({ from: month, to: month }), query);
    if (to < from) throw badRequest('La fin de la période précède son début.', undefined, 'bad_period');
    const span = (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5)) - Number(from.slice(5)) + 1;
    if (span > 12) throw badRequest('Une déclaration couvre au plus 12 mois.', undefined, 'period_too_long');
    return this.db.tenant(t.ctx, async (trx) => {
      const company = await trx.selectFrom('company').select(['name', 'tax_id', 'rccm', 'address', 'city', 'cnps_employer_number']).where('id', '=', t.companyId).executeTakeFirstOrThrow();
      const runs = await trx.selectFrom('payroll_run').select(['id', 'period', 'status']).where('period', '>=', from).where('period', '<=', to).orderBy('period').execute();
      const validated = runs.filter((r) => r.status === 'validated');
      const slips = validated.length ? await trx.selectFrom('payslip').select(['run_id', 'employee_id', 'employee', 'lines', 'totals', 'gross', 'taxable', 'net']).where('run_id', 'in', validated.map((r) => r.id)).execute() : [];
      const periodOf = new Map(validated.map((r) => [r.id, r.period]));
      const rows = new Map<string, Row>();
      for (const s of slips) {
        const e = s.employee as any, tt = s.totals as any, lines = s.lines as PayslipLine[];
        const period = periodOf.get(s.run_id)!;
        const cur = rows.get(s.employee_id) ?? { employeeId: s.employee_id, number: e.number, name: e.name, cnpsNumber: e.cnpsNumber ?? null, contractType: e.contractType, months: 0, firstPeriod: period, lastPeriod: period,
          ...Object.fromEntries(FIELDS.map((f) => [f, 0])) } as Row;
        // Fiche la plus récente : numéro CNPS renseigné après coup, changement de nom.
        if (period >= cur.lastPeriod) { cur.name = e.name; cur.cnpsNumber = e.cnpsNumber ?? cur.cnpsNumber; cur.lastPeriod = period; }
        if (period < cur.firstPeriod) cur.firstPeriod = period;
        cur.months++;
        const add: Partial<Record<(typeof FIELDS)[number], number>> = {
          gross: Number(s.gross), taxable: Number(s.taxable), net: Number(s.net),
          retirementBase: lines.find((l) => l.code === 'CNPS')?.base ?? 0, smallBase: lines.find((l) => l.code === 'PF')?.base ?? 0,
          retirementEmployee: tt.cnpsEmployee ?? 0, retirementEmployer: tt.cnpsEmployer ?? 0, familyBenefits: tt.familyBenefits ?? 0, workAccident: tt.workAccident ?? 0,
          cmuEmployee: tt.cmuEmployee ?? 0, cmuEmployer: tt.cmuEmployer ?? 0, itsGross: tt.itsGross ?? 0, itsReduction: tt.itsReduction ?? 0, its: tt.its ?? 0,
          employerTax: tt.employerTax ?? 0, apprenticeship: tt.apprenticeship ?? 0, training: tt.training ?? 0,
        };
        for (const f of FIELDS) (cur as any)[f] += add[f] ?? 0;
        rows.set(s.employee_id, cur);
      }
      const all = [...rows.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
      // Stagiaires et occasionnels : ni cotisations ni ITS, hors déclarations (repris pour mémoire dans la DISA).
      const declared = all.filter((r) => r.retirementBase > 0 || r.its > 0 || r.cmuEmployee + r.cmuEmployer > 0);
      const sum = (rs: Row[], f: (typeof FIELDS)[number]) => rs.reduce((s, r) => s + r[f], 0);
      const totals = Object.fromEntries(FIELDS.map((f) => [f, sum(declared, f)])) as Record<(typeof FIELDS)[number], number>;
      const cnpsTotal = totals.retirementEmployee + totals.retirementEmployer + totals.familyBenefits + totals.workAccident + totals.cmuEmployee + totals.cmuEmployer;
      return {
        company: { name: company.name, taxId: company.tax_id, rccm: company.rccm, address: [company.address, company.city].filter(Boolean).join(', ') || null, cnpsEmployerNumber: company.cnps_employer_number ?? null },
        period: { from, to, months: span },
        runs: runs.map((r) => ({ period: r.period, status: r.status })),
        employees: declared, excluded: all.filter((r) => !declared.includes(r)).map((r) => ({ name: r.name, contractType: r.contractType, gross: r.gross })),
        cnps: { ...totals, retirement: totals.retirementEmployee + totals.retirementEmployer, cmu: totals.cmuEmployee + totals.cmuEmployer, total: cnpsTotal },
        tax: { its: totals.its, employerTax: totals.employerTax, apprenticeship: totals.apprenticeship, training: totals.training, total: totals.its + totals.employerTax + totals.apprenticeship + totals.training },
        warnings: [
          ...(!company.cnps_employer_number ? ["Le numéro d'employeur CNPS de l'entreprise n'est pas renseigné."] : []),
          ...(!company.tax_id ? ["Le numéro de compte contribuable (NCC) de l'entreprise n'est pas renseigné (fiche Entreprise)."] : []),
          ...declared.filter((r) => !r.cnpsNumber).map((r) => `${r.name} n'a pas de numéro CNPS sur sa fiche.`),
          ...runs.filter((r) => r.status !== 'validated').map((r) => `La paie de ${r.period} n'est pas validée : elle n'est pas comptée.`),
          ...Array.from({ length: span }, (_, i) => { const d = new Date(Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5)) - 1 + i, 1)); return d.toISOString().slice(0, 7); })
            .filter((p) => !runs.some((r) => r.period === p)).map((p) => `Aucune paie pour ${p}.`),
        ],
      };
    });
  }

  /** Numéro d'employeur CNPS de l'entreprise (en-tête des déclarations). */
  @Permission('payroll.admin') @RequireFeature(FEATURE) @HttpCode(200)
  @Put('employer')
  employer(@Tenant() t: TenantInfo, @Body() body: unknown) {
    const { cnpsEmployerNumber } = parse(z.object({ cnpsEmployerNumber: z.string().trim().max(30).transform((v) => v || null).nullable() }).strict(), body);
    return this.db.tenant(t.ctx, async (trx) => {
      await trx.updateTable('company').set({ cnps_employer_number: cnpsEmployerNumber }).where('id', '=', t.companyId).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'company.cnps_employer_number_updated', entityType: 'company', entityId: t.companyId, data: { cnpsEmployerNumber } });
      return { ok: true };
    });
  }
}
