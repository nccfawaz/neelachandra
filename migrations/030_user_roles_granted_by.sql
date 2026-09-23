-- 030: user_roles.granted_by (DECISIONS 29.77).
--
-- The 500 on POST /app/admin/users/:id/roles in production exposed a schema
-- defect that has been in the shipped DDL since phase 2: every writer in
-- src/modules/admin/service.ts (createUser :54, createStaff :143,
-- replaceUserRoles :313) inserts granted_by into user_roles, but
-- migrations/002_rbac.sql never created the column — granted_by exists only
-- on user_permission_overrides. TypeScript could not catch it because
-- src/db/types.ts (the generated table interface) declares UserRolesTable
-- without the column, while the kysely .values() payload carries the extra
-- key; kysely does not type-check excess keys against the insert type.
--
-- Nothing caught this in dev because no test ever POSTs to
-- .../users/:id/roles — the route sat on the route-coverage allowlist, and
-- its only coverage was an assertion that a LINK to it renders (the
-- allowlist is exactly what allowed a broken route to ship: the route was
-- "covered" by being listed as uncovered).
--
-- Forward-only: ADD COLUMN with an index. granted_by is NULLable — the
-- 029-era seed scripts and this migration's own backfill write rows without
-- a grantor, and the seed history predates actors. NOT NULL would make the
-- migration fail on the seeded rows it must coexist with.
ALTER TABLE user_roles
  ADD COLUMN granted_by BIGINT UNSIGNED NULL AFTER role_id,
  ADD KEY idx_user_roles_granted_by (granted_by),
  ADD CONSTRAINT fk_ur_grantor FOREIGN KEY (granted_by) REFERENCES users (id) ON DELETE SET NULL;
