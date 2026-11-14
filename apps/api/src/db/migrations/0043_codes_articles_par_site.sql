-- Codes d'articles numérotés par site : ART-S02-00001 pour le site S02, ART-00001 pour un article commun.
-- Les articles d'un site encore codés automatiquement (ART-00012…) sont renumérotés dans leur ordre actuel.
WITH ranked AS (
  SELECT p.company_id, p.id, s.id AS site_id,
         'ART-' || regexp_replace(upper(s.code), '[^A-Z0-9]', '', 'g') AS prefix,
         row_number() OVER (PARTITION BY p.company_id, p.site_id ORDER BY p.code) AS n
  FROM product p JOIN site s ON s.company_id = p.company_id AND s.id = p.site_id
  WHERE p.code ~ '^ART-[0-9]+$'
)
UPDATE product p SET code = r.prefix || '-' || lpad(r.n::text, 5, '0')
FROM ranked r WHERE p.company_id = r.company_id AND p.id = r.id;

-- Séquence de chaque site : après le plus grand numéro attribué.
INSERT INTO numbering_sequence (company_id, doc_type, year, prefix, next_value)
SELECT p.company_id, 'product_site_' || p.site_id, 0, 'ART-' || regexp_replace(upper(s.code), '[^A-Z0-9]', '', 'g'),
       max(substring(p.code FROM '([0-9]+)$')::bigint) + 1
FROM product p JOIN site s ON s.company_id = p.company_id AND s.id = p.site_id
WHERE p.code ~ ('^ART-' || regexp_replace(upper(s.code), '[^A-Z0-9]', '', 'g') || '-[0-9]+$')
GROUP BY p.company_id, p.site_id, s.code
ON CONFLICT (company_id, doc_type, year) DO UPDATE SET next_value = EXCLUDED.next_value;

-- Séquence des articles communs : reprend après le plus grand ART-NNNNN restant (1 s'il n'y en a plus).
UPDATE numbering_sequence q SET next_value = coalesce((
  SELECT max(substring(p.code FROM '^ART-([0-9]+)$')::bigint) + 1 FROM product p WHERE p.company_id = q.company_id AND p.code ~ '^ART-[0-9]+$'), 1)
WHERE q.doc_type = 'product' AND q.year = 0;
