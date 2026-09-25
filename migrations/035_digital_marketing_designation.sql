-- 035: the designation row digital_marketing was missing (DECISIONS 35.2).
--
-- 034 minted the ROLE but no employee can be created holding it with a
-- designation that names the job: the designation picker would offer nothing
-- that says digital marketing, and an employee row is what ties a login to a
-- role through the HR side. 029 established the pattern for exactly this
-- gap (QA/QC/QS, Architect, Procurement Executive): a designation row named
-- after the job, filed under its department.
--
-- Code follows 029's convention: prefix = department, hyphen, role noun.
-- Marketing lives in the SALES AND MARKETING department (006_hr.sql), so:
--   MKT-EXEC = 'Digital Marketing Executive', department SALES.
--
-- Idempotent, like 029.
INSERT INTO designations (code, name, department_id)
SELECT v.code, v.name, d.id
FROM (
  SELECT 'MKT-EXEC' AS code, 'Digital Marketing Executive' AS name, 'SALES' AS dept
) AS v
JOIN departments d ON d.code = v.dept
WHERE NOT EXISTS (SELECT 1 FROM designations dn WHERE dn.code = v.code);
