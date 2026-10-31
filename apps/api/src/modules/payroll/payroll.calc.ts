/**
 * Calcul d'un bulletin de paie ivoirien (salarié local, mois civil).
 *
 * ⚠️ Les taux et barèmes ci-dessous sont des valeurs par défaut issues de la réglementation connue
 * (réforme de l'ITS de 2024, taux CNPS, CMU). Ils DOIVENT être vérifiés par un expert-comptable
 * avant tout usage réel : chaque entreprise peut les ajuster dans ses paramètres de paie, et chaque
 * bulletin validé conserve les paramètres avec lesquels il a été calculé.
 */
export interface PayrollParams {
  /** Barème mensuel progressif de l'ITS : tranches [plafond de la tranche (null = au-delà), taux en %]. */
  itsBrackets: [number | null, number][];
  /** Réduction mensuelle d'ITS pour charges de famille, par nombre de parts. */
  itsFamilyReduction: Record<string, number>;
  cnpsEmployeeRate: number;      // retraite, part salariale (%)
  cnpsEmployerRate: number;      // retraite, part patronale (%)
  cnpsCeiling: number;           // plafond mensuel de la retraite
  familyBenefitsRate: number;    // prestations familiales (employeur, %)
  workAccidentRate: number;      // accident du travail (employeur, %, selon le risque : 2 à 5)
  smallBenefitsCeiling: number;  // plafond mensuel des prestations familiales et de l'accident du travail
  cmuPerPerson: number;          // CMU par bénéficiaire et par mois
  cmuEmployerShare: number;      // part de la CMU prise en charge par l'employeur pour le salarié
  employerTaxRate: number;       // contribution employeur sur les salaires (%)
  apprenticeshipTaxRate: number; // taxe d'apprentissage (%)
  trainingTaxRate: number;       // taxe additionnelle à la formation professionnelle continue (%)
  transportExemptCap: number;    // indemnité de transport exonérée par mois
  workingDays: number;           // base de proratisation des absences
  leaveDaysPerMonth: number;     // congés payés acquis par mois de service (jours ouvrables)
  smig: number;                  // salaire minimum interprofessionnel garanti (mensuel)
  /** Grille de l'entreprise : salaire catégoriel mensuel par catégorie (0 = non renseigné), selon la convention de sa branche. */
  categories: { code: string; label: string; minSalary: number }[];
}

export const DEFAULT_PAYROLL_PARAMS: PayrollParams = {
  itsBrackets: [[75_000, 0], [240_000, 16], [800_000, 21], [2_400_000, 24], [8_000_000, 28], [null, 32]],
  itsFamilyReduction: { '1': 0, '1.5': 5_500, '2': 11_000, '2.5': 16_500, '3': 22_000, '3.5': 27_500, '4': 33_000, '4.5': 38_500, '5': 44_000 },
  cnpsEmployeeRate: 6.3, cnpsEmployerRate: 7.7, cnpsCeiling: 1_647_315,
  familyBenefitsRate: 5, workAccidentRate: 2, smallBenefitsCeiling: 70_000,
  cmuPerPerson: 1_000, cmuEmployerShare: 500,
  employerTaxRate: 1.2, apprenticeshipTaxRate: 0.4, trainingTaxRate: 1.2,
  transportExemptCap: 30_000, workingDays: 30, leaveDaysPerMonth: 2.2,
  smig: 75_000,
  // Montants à compléter : ils dépendent de la convention collective de la branche (arrêté n° 50/MEPS/CAB de 2023).
  categories: [
    ...[1, 2, 3, 4, 5, 6, 7].map((n) => ({ code: String(n), label: `${n}${n === 1 ? 're' : 'e'} catégorie`, minSalary: 0 })),
    { code: 'AM', label: 'Agent de maîtrise', minSalary: 0 }, { code: 'C', label: 'Cadre', minSalary: 0 },
  ],
};

export type MaritalStatus = 'single' | 'married' | 'divorced' | 'widowed';

/**
 * Nombre de parts : 1 pour une personne seule, 2 pour une personne mariée ou veuve ;
 * une personne seule avec enfant passe à 1,5 ; chaque enfant à charge ajoute 0,5 ; 5 parts au plus.
 */
export function familyParts(status: MaritalStatus, children: number): number {
  let parts = status === 'married' || status === 'widowed' ? 2 : 1;
  if (parts === 1 && children > 0) parts = 1.5;
  parts += 0.5 * children;
  return Math.min(5, parts);
}

export interface PayslipInput {
  baseSalary: number; extraSalary?: number; housingAllowance: number; otherAllowances: number; transportAllowance: number;
  overtime: number; bonus: number; absenceDays: number; advanceDeduction: number; otherDeduction: number;
  parts: number; cmuBeneficiaries: number;
}

export interface PayslipLine { code: string; label: string; base?: number; rate?: number; employee?: number; employer?: number; gain?: number }

const r = (n: number) => Math.round(n);
const pct = (base: number, rate: number) => r((base * rate) / 100);

export function progressiveTax(taxable: number, brackets: PayrollParams['itsBrackets']) {
  let tax = 0, floor = 0;
  for (const [ceiling, rate] of brackets) {
    const top = ceiling ?? Infinity;
    if (taxable > floor) tax += ((Math.min(taxable, top) - floor) * rate) / 100;
    floor = top;
  }
  return r(tax);
}

export function computePayslip(input: PayslipInput, p: PayrollParams) {
  const lines: PayslipLine[] = [];
  const extra = input.extraSalary ?? 0;
  // Les absences non rémunérées s'imputent sur le salaire de base et le sursalaire.
  const absence = input.absenceDays > 0 ? r(((input.baseSalary + extra) * Math.min(input.absenceDays, p.workingDays)) / p.workingDays) : 0;
  const base = input.baseSalary + extra - absence;
  lines.push({ code: 'BASE', label: 'Salaire de base', gain: input.baseSalary });
  if (extra) lines.push({ code: 'SUR', label: 'Sursalaire', gain: extra });
  if (absence) lines.push({ code: 'ABS', label: `Absences non rémunérées (${input.absenceDays} j)`, gain: -absence });
  if (input.overtime) lines.push({ code: 'HS', label: 'Heures supplémentaires', gain: input.overtime });
  if (input.housingAllowance) lines.push({ code: 'LOG', label: 'Indemnité de logement', gain: input.housingAllowance });
  if (input.otherAllowances) lines.push({ code: 'IND', label: 'Autres indemnités', gain: input.otherAllowances });
  if (input.bonus) lines.push({ code: 'PRI', label: 'Primes', gain: input.bonus });
  const transportExempt = Math.min(input.transportAllowance, p.transportExemptCap);
  const transportTaxable = input.transportAllowance - transportExempt;
  if (transportTaxable) lines.push({ code: 'TRI', label: 'Transport (part imposable)', gain: transportTaxable });

  const taxable = base + input.overtime + input.housingAllowance + input.otherAllowances + input.bonus + transportTaxable;
  const gross = taxable + transportExempt;

  // Cotisations sociales
  const cnpsBase = Math.min(taxable, p.cnpsCeiling);
  const cnpsEmployee = pct(cnpsBase, p.cnpsEmployeeRate);
  const cnpsEmployer = pct(cnpsBase, p.cnpsEmployerRate);
  lines.push({ code: 'CNPS', label: 'CNPS retraite', base: cnpsBase, rate: p.cnpsEmployeeRate, employee: cnpsEmployee, employer: cnpsEmployer });
  const smallBase = Math.min(taxable, p.smallBenefitsCeiling);
  const familyBenefits = pct(smallBase, p.familyBenefitsRate);
  const workAccident = pct(smallBase, p.workAccidentRate);
  lines.push({ code: 'PF', label: 'Prestations familiales', base: smallBase, rate: p.familyBenefitsRate, employer: familyBenefits });
  lines.push({ code: 'AT', label: 'Accident du travail', base: smallBase, rate: p.workAccidentRate, employer: workAccident });
  const cmuTotal = p.cmuPerPerson * Math.max(1, input.cmuBeneficiaries);
  const cmuEmployer = Math.min(p.cmuEmployerShare, cmuTotal);
  const cmuEmployee = cmuTotal - cmuEmployer;
  lines.push({ code: 'CMU', label: `Couverture maladie universelle (${Math.max(1, input.cmuBeneficiaries)} bénéficiaire(s))`, employee: cmuEmployee, employer: cmuEmployer });

  // Impôt sur les traitements et salaires
  const itsGross = progressiveTax(taxable, p.itsBrackets);
  const reduction = p.itsFamilyReduction[String(input.parts)] ?? 0;
  const its = Math.max(0, itsGross - reduction);
  lines.push({ code: 'ITS', label: `Impôt sur les traitements et salaires (${input.parts} part${input.parts > 1 ? 's' : ''}${reduction ? `, réduction ${reduction.toLocaleString('fr-FR')}` : ''})`, base: taxable, employee: its });

  // Taxes patronales sur les salaires
  const employerTax = pct(taxable, p.employerTaxRate);
  const apprenticeship = pct(taxable, p.apprenticeshipTaxRate);
  const training = pct(taxable, p.trainingTaxRate);
  lines.push({ code: 'CE', label: 'Contribution employeur sur salaires', base: taxable, rate: p.employerTaxRate, employer: employerTax });
  lines.push({ code: 'TA', label: "Taxe d'apprentissage", base: taxable, rate: p.apprenticeshipTaxRate, employer: apprenticeship });
  lines.push({ code: 'FPC', label: 'Taxe additionnelle formation continue', base: taxable, rate: p.trainingTaxRate, employer: training });

  if (input.advanceDeduction) lines.push({ code: 'AVA', label: "Remboursement d'avance", employee: input.advanceDeduction });
  if (input.otherDeduction) lines.push({ code: 'RET', label: 'Autres retenues', employee: input.otherDeduction });
  if (transportExempt) lines.push({ code: 'TRA', label: 'Indemnité de transport (non imposable)', gain: transportExempt });

  const socialEmployee = cnpsEmployee + cmuEmployee;
  const deductions = socialEmployee + its + input.advanceDeduction + input.otherDeduction;
  const socialEmployer = cnpsEmployer + familyBenefits + workAccident + cmuEmployer;
  const taxesEmployer = employerTax + apprenticeship + training;
  const net = gross - deductions;
  return {
    lines, gross, taxable, net,
    totals: {
      cnpsEmployee, cnpsEmployer, familyBenefits, workAccident, cmuEmployee, cmuEmployer, its, itsGross, itsReduction: Math.min(reduction, itsGross),
      employerTax, apprenticeship, training, advances: input.advanceDeduction, otherDeductions: input.otherDeduction,
      socialEmployee, socialEmployer, taxesEmployer, deductions, employerCost: gross + socialEmployer + taxesEmployer,
    },
  };
}

export type NetToGrossInput = Omit<PayslipInput, 'baseSalary' | 'extraSalary' | 'overtime' | 'bonus' | 'absenceDays' | 'advanceDeduction' | 'otherDeduction'>;

/**
 * Calcul inverse, du net à payer vers le brut : le salaire de base vaut le salaire catégoriel s'il est
 * renseigné et le sursalaire complète ; sinon tout le complément va au salaire de base. On cherche le
 * plus petit montant qui atteint le net demandé (le net croît avec le brut : l'impôt marginal reste < 100 %).
 */
export function netToGross(targetNet: number, minSalary: number, fixed: NetToGrossInput, p: PayrollParams) {
  const slip = (base: number, extra: number) => computePayslip({ ...fixed, baseSalary: base, extraSalary: extra, overtime: 0, bonus: 0, absenceDays: 0, advanceDeduction: 0, otherDeduction: 0 }, p);
  const withCategory = minSalary > 0;
  const at = (x: number) => (withCategory ? slip(minSalary, x) : slip(x, 0));
  const floor = at(0);
  if (floor.net > targetNet) {
    return { ok: false as const, minNet: floor.net, reason: withCategory ? 'below_category' as const : 'below_allowances' as const };
  }
  let lo = 0, hi = Math.max(1_000, targetNet * 2);
  while (at(hi).net < targetNet) hi *= 2;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (at(mid).net >= targetNet) hi = mid; else lo = mid + 1;
  }
  const baseSalary = withCategory ? minSalary : lo, extraSalary = withCategory ? lo : 0;
  return { ok: true as const, baseSalary, extraSalary, result: slip(baseSalary, extraSalary) };
}
