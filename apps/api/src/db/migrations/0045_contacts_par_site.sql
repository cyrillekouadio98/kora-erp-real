-- Client ou fournisseur rattaché à un site : il n'est proposé que sur ce site. NULL = commun à tous les sites.
ALTER TABLE contact ADD COLUMN site_id uuid;
ALTER TABLE contact ADD CONSTRAINT contact_site_fk FOREIGN KEY (company_id, site_id) REFERENCES site (company_id, id);
CREATE INDEX contact_site_idx ON contact (company_id, site_id);

-- Contacts existants d'une entreprise multi-sites dont toutes les pièces (ventes, achats, bons de stock) sont
-- d'un seul site : rattachés à ce site.
UPDATE contact c SET site_id = x.site_id
FROM (
  SELECT company_id, contact_id, (array_agg(DISTINCT site_id))[1] AS site_id
  FROM (
    SELECT company_id, contact_id, site_id FROM sales_document
    UNION ALL SELECT company_id, contact_id, site_id FROM purchase_document
    UNION ALL SELECT company_id, contact_id, site_id FROM stock_document WHERE contact_id IS NOT NULL
  ) d
  GROUP BY company_id, contact_id HAVING count(DISTINCT site_id) = 1
) x
WHERE c.company_id = x.company_id AND c.id = x.contact_id AND c.name <> 'Client comptoir'
  AND (SELECT count(*) FROM site s WHERE s.company_id = c.company_id) > 1;

-- Codes par site : CLI-S02-00001, FRS-S02-00001, TIE-S02-00001 ; renumérotation des codes automatiques.
WITH ranked AS (
  SELECT c.company_id, c.id, split_part(c.code, '-', 1) || '-' || regexp_replace(upper(s.code), '[^A-Z0-9]', '', 'g') AS prefix,
         row_number() OVER (PARTITION BY c.company_id, c.site_id, split_part(c.code, '-', 1) ORDER BY c.code) AS n
  FROM contact c JOIN site s ON s.company_id = c.company_id AND s.id = c.site_id
  WHERE c.code ~ '^(CLI|FRS|TIE)-[0-9]+$'
)
UPDATE contact c SET code = r.prefix || '-' || lpad(r.n::text, 5, '0') FROM ranked r WHERE c.company_id = r.company_id AND c.id = r.id;

INSERT INTO numbering_sequence (company_id, doc_type, year, prefix, next_value)
SELECT c.company_id, 'contact_' || c.kind || '_site_' || c.site_id, 0, split_part(c.code, '-', 1) || '-' || regexp_replace(upper(s.code), '[^A-Z0-9]', '', 'g'),
       max(substring(c.code FROM '([0-9]+)$')::bigint) + 1
FROM contact c JOIN site s ON s.company_id = c.company_id AND s.id = c.site_id
WHERE c.code ~ ('^(CLI|FRS|TIE)-' || regexp_replace(upper(s.code), '[^A-Z0-9]', '', 'g') || '-[0-9]+$')
GROUP BY c.company_id, c.kind, c.site_id, split_part(c.code, '-', 1), s.code
ON CONFLICT (company_id, doc_type, year) DO UPDATE SET next_value = greatest(numbering_sequence.next_value, EXCLUDED.next_value);

UPDATE numbering_sequence q SET next_value = coalesce((
  SELECT max(substring(c.code FROM '^[A-Z]+-([0-9]+)$')::bigint) + 1 FROM contact c
  WHERE c.company_id = q.company_id AND c.code ~ ('^' || q.prefix || '-[0-9]+$')), 1)
WHERE q.doc_type IN ('contact_customer', 'contact_supplier', 'contact_both') AND q.year = 0;
