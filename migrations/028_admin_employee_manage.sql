-- 028: grant hr.employee_manage to the admin role (DECISIONS 29.73).
--
-- Fawaz (website administrator) maintains staff records including employee
-- codes, but the admin role held hr.employee_view only — he could look at an
-- employee record and not correct it. The employees edit screen gates the
-- code panel on hr.employee_manage (29.71).
--
-- Idempotent: safe to run against any database already seeded.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.`key` = 'hr.employee_manage'
 WHERE r.`key` = 'admin'
   AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp
     WHERE rp.role_id = r.id AND rp.permission_id = p.id);
