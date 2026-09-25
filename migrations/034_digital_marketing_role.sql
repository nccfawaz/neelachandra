-- 034: the digital_marketing role (DECISIONS 35.1).
--
-- Justification against the 4.3 permission matrix. The marketing roster sits
-- entirely outside money approvals, HR records, procurement and project cost,
-- so the role carries EXACTLY the five marketing permissions and nothing
-- else:
--
--   GRANTED (all five marketing.* keys):
--     marketing.view              -- see the module at all
--     marketing.analytics_view    -- read campaign performance
--     marketing.content_publish   -- publish website content (their core job)
--     marketing.campaign_manage   -- create and edit campaigns
--     marketing.spend_record      -- RECORD spend against a campaign. Deliberate:
--        recording what was spent is a marketing act (an invoice arrives, the
--        number is typed against the campaign); APPROVING or paying it is a
--        finance act and lives in the finance module behind finance
--        permissions this role does not hold. Recording spend never moves
--        money.
--
--   WITHHELD (deliberately, each with the reason):
--     finance.* and any expense/invoice/payment permission -- a marketer must
--       never approve, pay or write off spend; segregation of duties.
--     hr.* -- no attendance authority, no leave approvals, no employee reads.
--     procurement.* / inventory.* -- no vendor, PO or stock authority.
--     projects.cost_view / contract value / margin permissions -- project
--       money is out of scope; marketing spend lives in the marketing module.
--     dashboard admin, roles.manage, users.* -- no account authority.
--
-- require_2fa = 0 and scope_to_assigned_projects = 0: the role sees no
-- project-scoped data and touches nothing that 2FA gates elsewhere. Marked
-- is_system = 1 like its siblings so the role editor cannot delete it while
-- holders exist. Idempotent throughout, matching 029's shape.
INSERT INTO roles (`key`, label, description, require_2fa, scope_to_assigned_projects, is_system)
SELECT
  'digital_marketing' AS `key`,
  'Digital Marketing' AS label,
  'The marketing module only: view, analytics, content publishing, campaign management, spend RECORDING. No money approvals, no HR, no procurement, no project cost.' AS description,
  0 AS require_2fa,
  0 AS scope_to_assigned_projects,
  1 AS is_system
WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.`key` = 'digital_marketing');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.`key` IN (
  'marketing.view',
  'marketing.analytics_view',
  'marketing.content_publish',
  'marketing.campaign_manage',
  'marketing.spend_record'
)
WHERE r.`key` = 'digital_marketing'
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );
