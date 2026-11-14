-- Article rattaché à un site : il n'est proposé que sur ce site (articles, ventes, caisse, stocks).
-- NULL = article commun à tous les sites.
ALTER TABLE product ADD COLUMN site_id uuid;
ALTER TABLE product ADD CONSTRAINT product_site_fk FOREIGN KEY (company_id, site_id) REFERENCES site (company_id, id);
CREATE INDEX product_site_idx ON product (company_id, site_id);

-- Articles existants d'une entreprise multi-sites dont tout le stock est passé par les entrepôts d'un seul site :
-- rattachés à ce site.
UPDATE product p SET site_id = x.site_id
FROM (
  SELECT m.company_id, m.product_id, (array_agg(DISTINCT w.site_id))[1] AS site_id
  FROM stock_movement m JOIN warehouse w ON w.company_id = m.company_id AND w.id = m.warehouse_id
  GROUP BY m.company_id, m.product_id
  HAVING count(DISTINCT w.site_id) = 1
) x
WHERE p.company_id = x.company_id AND p.id = x.product_id
  AND (SELECT count(*) FROM site s WHERE s.company_id = p.company_id) > 1;
