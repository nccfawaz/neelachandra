import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "hono/jsx/jsx-runtime";
import { Hono } from 'hono';
import { currentUser, currentSession } from '../../types.js';
import { AppShell } from '../../dashboard/layouts/AppShell.js';
import { Alert, DataTable, DefinitionList, FormField, Pager, Panel, StatusBadge, Tabs, } from '../../dashboard/components/index.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { PERMISSIONS, PERMISSION_MODULES } from '../../lib/permissions.js';
import { readBody } from '../../middleware/csrf.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../lib/errors.js';
import { changeEmailSchema, changeNameSchema, adminPasswordSchema, employeeCodeSchema, } from './schemas.js';
import { parseJsonColumn } from '../../lib/json.js';
import { formatDate, formatDateTime } from '../../lib/dates.js';
import { formatPaiseAsRupees } from '../../lib/money.js';
import { allSettings } from '../../lib/settings.js';
import * as q from './queries.js';
import * as svc from './service.js';
import { auditFilterSchema, createStaffSchema, createUserSchema, enquiryStatusSchema, firstError, overrideSchema, rolePermissionsSchema, rolesSchema, statusSchema, } from './schemas.js';
const admin = new Hono();
const ADMIN_TABS = [
    { label: 'Users', href: '/app/admin/users' },
    { label: 'Roles', href: '/app/admin/roles' },
    { label: 'Approval limits', href: '/app/admin/approval-limits' },
    { label: 'Reference data', href: '/app/admin/reference' },
    { label: 'Settings', href: '/app/admin/settings' },
    { label: 'Audit log', href: '/app/admin/audit' },
    { label: 'Enquiries', href: '/app/admin/enquiries' },
];
function actorOf(c) {
    return { userId: currentUser(c).id, ip: c.get('clientIp') };
}
/** Reads ?ok= and ?error= so a redirect can carry a result without a session flash. */
function banner(c) {
    const url = new URL(c.req.url);
    const ok = url.searchParams.get('ok');
    const error = url.searchParams.get('error');
    if (error)
        return _jsx(Alert, { tone: "error", children: error });
    if (ok)
        return _jsx(Alert, { tone: "ok", children: ok });
    return null;
}
/* Users ------------------------------------------------------------------- */
admin.get('/app/admin/users', requirePermission(PERMISSIONS.USERS_MANAGE), async (c) => {
    const db = c.get('db');
    const [users, roles] = await Promise.all([q.listUsers(db), q.allRoles(db)]);
    const columns = [
        {
            header: 'Name',
            cell: (row) => (_jsxs(_Fragment, { children: [_jsx("a", { href: `/app/admin/users/${row.id}`, children: _jsx("strong", { children: row.full_name }) }), _jsx("div", { class: "ncc-muted", children: row.email }), _jsx("a", { class: "ncc-muted", href: `/app/admin/users/${row.id}/edit`, children: "Edit account" })] })),
        },
        { header: 'Roles', cell: (row) => row.roles ?? _jsx("span", { class: "ncc-muted", children: "None" }) },
        {
            header: 'Status',
            cell: (row) => (_jsxs(_Fragment, { children: [_jsx(StatusBadge, { status: row.status }), row.locked_until && row.locked_until > new Date().toISOString().slice(0, 19).replace('T', ' ') ? (_jsxs("div", { class: "ncc-muted", children: ["Locked until ", formatDateTime(row.locked_until)] })) : null] })),
        },
        {
            header: 'Two factor',
            cell: (row) => (row.totp_confirmed_at ? 'Enrolled' : _jsx("span", { class: "ncc-muted", children: "Not enrolled" })),
        },
        {
            header: 'Last sign in',
            cell: (row) => (row.last_login_at ? formatDateTime(row.last_login_at) : _jsx("span", { class: "ncc-muted", children: "Never" })),
        },
    ];
    const user = currentUser(c);
    const session = currentSession(c);
    return c.html(_jsxs(AppShell, { title: "Users", user: user, perms: c.get('perms'), csrfToken: session.csrfToken, path: "/app/admin/users", subtitle: "Staff accounts. There is no self sign up; every account starts here as an invitation.", children: [_jsx(Tabs, { tabs: ADMIN_TABS, active: "/app/admin/users" }), banner(c), _jsx(Panel, { title: `${users.length} ${users.length === 1 ? 'account' : 'accounts'}`, children: _jsx(DataTable, { columns: columns, rows: users, empty: "No accounts yet." }) }), _jsx(Panel, { title: "Invite a new user", children: _jsxs("form", { method: "post", action: "/app/admin/users", class: "ncc-stack", children: [_jsx("input", { type: "hidden", name: "nc_csrf", value: session.csrfToken }), _jsxs("div", { class: "ncc-grid ncc-grid--2", children: [_jsx(FormField, { label: "Full name", name: "fullName", required: true }), _jsx(FormField, { label: "Email", name: "email", type: "email", required: true }), _jsx(FormField, { label: "Phone", name: "phone", hint: "Optional." })] }), _jsxs("fieldset", { class: "ncc-fieldset", children: [_jsx("legend", { children: "Roles" }), _jsx("p", { class: "ncc-hint", children: "Permissions come from roles. A user with no role can sign in but sees an empty dashboard." }), _jsx("div", { class: "ncc-grid ncc-grid--2", children: roles.map((role) => (_jsxs("label", { class: "ncc-check", children: [_jsx("input", { type: "checkbox", name: "roleIds", value: String(role.id) }), _jsxs("span", { children: [_jsx("strong", { children: role.label }), Number(role.require_2fa) === 1 ? _jsx("span", { class: "ncc-muted", children: " requires two factor" }) : null, role.description ? _jsx("div", { class: "ncc-muted", children: role.description }) : null] })] }))) })] }), _jsx("p", { class: "ncc-hint", children: "The person receives a link to set their own password. No administrator ever sets or sees it." }), _jsx("button", { class: "ncc-btn ncc-btn--primary", type: "submit", children: "Create account and send invite" })] }) }), _jsx(Panel, { title: "Onboard a staff member (account and employee record together)", children: _jsxs("form", { method: "post", action: "/app/admin/users/staff", class: "ncc-stack", children: [_jsx("input", { type: "hidden", name: "nc_csrf", value: session.csrfToken }), _jsxs("div", { class: "ncc-grid ncc-grid--2", children: [_jsx(FormField, { label: "Full name", name: "fullName", required: true }), _jsx(FormField, { label: "Email", name: "email", type: "email", required: true }), _jsx(FormField, { label: "Phone", name: "phone", hint: "Optional." }), _jsx(FormField, { label: "Employee code", name: "employeeCode", required: true, hint: "Assigned by the office, e.g. NCC-015. Must be unique \u2014 a duplicate is refused." })] }), _jsxs("fieldset", { class: "ncc-fieldset", children: [_jsx("legend", { children: "Role" }), _jsx("div", { class: "ncc-grid ncc-grid--2", children: roles.map((role) => (_jsxs("label", { class: "ncc-check", children: [_jsx("input", { type: "checkbox", name: "roleId", value: String(role.id) }), _jsxs("span", { children: [_jsx("strong", { children: role.label }), Number(role.require_2fa) === 1 ? _jsx("span", { class: "ncc-muted", children: " requires two factor" }) : null] })] }))) })] }), _jsx("p", { class: "ncc-hint", children: "Creates the account and the employee record in one transaction; both exist or neither does. The person receives the usual invite link to choose their own password." }), _jsx("button", { class: "ncc-btn ncc-btn--primary", type: "submit", children: "Create account and employee record" })] }) })] }));
});
admin.post('/app/admin/users', requirePermission(PERMISSIONS.USERS_MANAGE), async (c) => {
    const body = await readBody(c);
    const parsed = createUserSchema.safeParse(body);
    if (!parsed.success) {
        return c.redirect(`/app/admin/users?error=${encodeURIComponent(firstError(parsed.error))}`, 303);
    }
    const result = await svc.createUser(c.get('db'), actorOf(c), {
        email: parsed.data.email,
        fullName: parsed.data.fullName,
        phone: parsed.data.phone,
        roleIds: parsed.data.roleIds,
        employeeId: parsed.data.employeeId,
    });
    // The link is shown to the administrator as well as emailed. SMTP on a
    // fresh Hostinger account is frequently not configured yet, and an invite
    // that exists only in a failed email means the account cannot be used.
    const message = `Account created. Invite link, valid 24 hours: ${result.inviteLink}`;
    return c.redirect(`/app/admin/users/${result.userId}?ok=${encodeURIComponent(message)}`, 303);
});
/** One-submit staff onboarding (29.76): users + employees rows in one
 * transaction, employee code required, duplicate refused with a readable
 * error. Same USERS_MANAGE gate as the invite path. */
admin.post('/app/admin/users/staff', requirePermission(PERMISSIONS.USERS_MANAGE), async (c) => {
    const body = await readBody(c);
    const parsed = createStaffSchema.safeParse(body);
    if (!parsed.success) {
        return c.redirect(`/app/admin/users?error=${encodeURIComponent(firstError(parsed.error))}`, 303);
    }
    try {
        const result = await svc.createStaff(c.get('db'), actorOf(c), {
            email: parsed.data.email,
            fullName: parsed.data.fullName,
            phone: parsed.data.phone,
            roleIds: parsed.data.roleIds,
            employeeCode: parsed.data.employeeCode,
        });
        const message = `Account and employee record created (code ${parsed.data.employeeCode}). Invite link, valid 24 hours: ${result.inviteLink}`;
        return c.redirect(`/app/admin/users/${result.userId}?ok=${encodeURIComponent(message)}`, 303);
    }
    catch (err) {
        if (err instanceof ConflictError || err instanceof BadRequestError) {
            return c.redirect(`/app/admin/users?error=${encodeURIComponent(err.message)}`, 303);
        }
        throw err;
    }
});
admin.get('/app/admin/users/:id', requirePermission(PERMISSIONS.USERS_MANAGE), async (c) => {
    const db = c.get('db');
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0)
        throw new NotFoundError('No such user.');
    const target = await q.findUser(db, id);
    if (!target)
        throw new NotFoundError('No such user.');
    const [roles, roleIds, overrides, permissions] = await Promise.all([
        q.allRoles(db),
        q.roleIdsFor(db, id),
        q.overridesFor(db, id),
        q.allPermissions(db),
    ]);
    const user = currentUser(c);
    const session = currentSession(c);
    const perms = c.get('perms');
    const canManageRoles = perms.has(PERMISSIONS.ROLES_MANAGE);
    return c.html(_jsxs(AppShell, { title: target.full_name, user: user, perms: perms, csrfToken: session.csrfToken, path: "/app/admin/users", subtitle: target.email, actions: _jsx("a", { class: "ncc-btn", href: "/app/admin/users", children: "Back to users" }), children: [banner(c), _jsxs("div", { class: "ncc-grid ncc-grid--2", children: [_jsxs(Panel, { title: "Account", children: [_jsx(DefinitionList, { rows: [
                                    ['Status', _jsx(StatusBadge, { status: target.status })],
                                    ['Two factor', target.totp_confirmed_at ? `Enrolled ${formatDate(target.totp_confirmed_at)}` : 'Not enrolled'],
                                    ['Must change password', Number(target.must_change_password) === 1 ? 'Yes' : 'No'],
                                    ['Last sign in', target.last_login_at ? formatDateTime(target.last_login_at) : 'Never'],
                                    ['Created', formatDateTime(target.created_at)],
                                ] }), _jsxs("form", { method: "post", action: `/app/admin/users/${id}/status`, class: "ncc-toolbar", children: [_jsx("input", { type: "hidden", name: "nc_csrf", value: session.csrfToken }), _jsxs("select", { name: "status", class: "ncc-input", "aria-label": "Account status", children: [_jsx("option", { value: "active", selected: target.status === 'active', children: "Active" }), _jsx("option", { value: "suspended", selected: target.status === 'suspended', children: "Suspended" }), _jsx("option", { value: "inactive", selected: target.status === 'inactive', children: "Inactive" })] }), _jsx("button", { class: "ncc-btn", type: "submit", children: "Update status" })] }), _jsx("p", { class: "ncc-hint", children: "Suspending signs the person out everywhere immediately. It does not delete anything they created." }), target.totp_confirmed_at ? (_jsxs("form", { method: "post", action: `/app/admin/users/${id}/totp-reset`, class: "ncc-toolbar", children: [_jsx("input", { type: "hidden", name: "nc_csrf", value: session.csrfToken }), _jsx("button", { class: "ncc-btn", type: "submit", children: "Reset two factor" })] })) : (_jsx("p", { class: "ncc-hint", children: "Two factor is not enrolled on this account." }))] }), _jsx(Panel, { title: "Roles", children: canManageRoles ? (_jsxs("form", { method: "post", action: `/app/admin/users/${id}/roles`, class: "ncc-stack", children: [_jsx("input", { type: "hidden", name: "nc_csrf", value: session.csrfToken }), roles.map((role) => (_jsxs("label", { class: "ncc-check", children: [_jsx("input", { type: "checkbox", name: "roleIds", value: String(role.id), checked: roleIds.includes(Number(role.id)) }), _jsxs("span", { children: [_jsx("strong", { children: role.label }), Number(role.scope_to_assigned_projects) === 1 ? (_jsx("div", { class: "ncc-muted", children: "Sees only assigned projects" })) : null] })] }))), _jsx("button", { class: "ncc-btn ncc-btn--primary", type: "submit", children: "Save roles" })] })) : (_jsxs(_Fragment, { children: [_jsx("ul", { children: roles
                                        .filter((r) => roleIds.includes(Number(r.id)))
                                        .map((r) => (_jsx("li", { children: r.label }))) }), _jsx("p", { class: "ncc-hint", children: "Changing roles needs the roles.manage permission." })] })) })] }), canManageRoles ? (_jsxs(Panel, { title: "Permission overrides", children: [_jsx("p", { class: "ncc-hint", children: "An override changes this one person without changing anyone else with the same role. Effective permissions are the union of their roles, minus denies, plus grants." }), overrides.length > 0 ? (_jsx(DataTable, { columns: [
                            { header: 'Permission', cell: (row) => _jsx("code", { children: row.key }) },
                            { header: 'Effect', cell: (row) => _jsx(StatusBadge, { status: row.effect }) },
                            { header: 'Reason', cell: (row) => row.note },
                            { header: 'Added', cell: (row) => formatDateTime(row.granted_at) },
                            {
                                header: '',
                                cell: (row) => (_jsxs("form", { method: "post", action: `/app/admin/overrides/${row.id}/remove`, children: [_jsx("input", { type: "hidden", name: "nc_csrf", value: session.csrfToken }), _jsx("button", { class: "ncc-btn ncc-btn--small", type: "submit", children: "Remove" })] })),
                            },
                        ], rows: overrides, empty: "No overrides." })) : (_jsx("p", { class: "ncc-muted", children: "No overrides. This user's permissions come entirely from their roles." })), _jsxs("form", { method: "post", action: `/app/admin/users/${id}/overrides`, class: "ncc-stack", children: [_jsx("input", { type: "hidden", name: "nc_csrf", value: session.csrfToken }), _jsxs("div", { class: "ncc-grid ncc-grid--2", children: [_jsx(FormField, { label: "Permission", name: "permissionKey", required: true, options: permissions.map((p) => ({ value: p.key, label: `${p.key} (${p.label})` })) }), _jsx(FormField, { label: "Effect", name: "effect", required: true, options: [
                                            { value: 'grant', label: 'Grant' },
                                            { value: 'deny', label: 'Deny' },
                                        ] })] }), _jsx(FormField, { label: "Reason", name: "note", rows: 3, required: true, hint: "Recorded in the audit log. At least 10 characters." }), _jsx("button", { class: "ncc-btn", type: "submit", children: "Add override" })] })] })) : null] }));
});
/**
 * Admin two-factor reset (DECISIONS 29.65). Gated to users.manage (the admin
 * account permission), CSRF-protected by the global form guard, audited with
 * actor and target, and the target's sessions all die. See resetTotp.
 */
admin.post('/app/admin/users/:id/totp-reset', requirePermission(PERMISSIONS.USERS_MANAGE), async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id))
        throw new NotFoundError('No such user.');
    await readBody(c);
    const result = await svc.resetTotp(c.get('db'), actorOf(c), id);
    return c.redirect(`/app/admin/users/${id}?ok=${encodeURIComponent(`Two factor reset for ${result.email}. They must enrol again at next sign-in; all their sessions were signed out.`)}`, 303);
});
admin.post('/app/admin/users/:id/status', requirePermission(PERMISSIONS.USERS_MANAGE), async (c) => {
    const id = Number(c.req.param('id'));
    const parsed = statusSchema.safeParse(await readBody(c));
    if (!Number.isInteger(id) || !parsed.success)
        throw new NotFoundError('No such user.');
    await svc.setUserStatus(c.get('db'), actorOf(c), id, parsed.data.status);
    return c.redirect(`/app/admin/users/${id}?ok=${encodeURIComponent('Status updated.')}`, 303);
});
/** Email change (29.71): USERS_MANAGE, audited, sessions invalidated. */
admin.post('/app/admin/users/:id/email', requirePermission(PERMISSIONS.USERS_MANAGE), async (c) => {
    const id = Number(c.req.param('id'));
    const parsed = changeEmailSchema.safeParse(await readBody(c));
    if (!Number.isInteger(id) || !parsed.success) {
        return c.redirect(`/app/admin/users/${id}?error=${encodeURIComponent(parsed.success ? 'No such user.' : parsed.error.issues[0].message)}`, 303);
    }
    const result = await svc.changeUserEmail(c.get('db'), actorOf(c), id, parsed.data.email);
    return c.redirect(`/app/admin/users/${id}?ok=${encodeURIComponent(`Email changed to ${result.email}. They have been signed out everywhere and must sign in again.`)}`, 303);
});
/** Admin password reset (29.71): the temporary value is shown once in the
 * redirect banner and lives nowhere else. */
admin.post('/app/admin/users/:id/password-reset', requirePermission(PERMISSIONS.USERS_MANAGE), async (c) => {
    const id = Number(c.req.param('id'));
    const parsed = adminPasswordSchema.safeParse(await readBody(c));
    if (!Number.isInteger(id) || !parsed.success) {
        return c.redirect(`/app/admin/users/${id}?error=${encodeURIComponent(parsed.success ? 'No such user.' : parsed.error.issues[0].message)}`, 303);
    }
    // The admin-set value from the form is the temporary password (29.71):
    // the operator chooses it and reads it to the person over a call. The
    // schema enforces 12+ chars with mixed case and a digit, and
    // must_change_password forces replacement at first sign-in.
    const temporary = parsed.data.password;
    await svc.adminResetPassword(c.get('db'), actorOf(c), id, temporary);
    return c.redirect(`/app/admin/users/${id}?ok=${encodeURIComponent(`Temporary password, shown once: ${temporary}. The person must change it at next sign-in.`)}`, 303);
});
/**
 * One-screen staff administration (29.72). The page shows current values and
 * posts the fields the actor may change; every mutation still goes through
 * its own service call and writes its own audit row with actor and target.
 * Controls the actor lacks the permission for render disabled with a note
 * rather than failing after submit.
 */
admin.get('/app/admin/users/:id/edit', requirePermission(PERMISSIONS.USERS_MANAGE), async (c) => {
    const db = c.get('db');
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0)
        throw new NotFoundError('No such user.');
    const target = await q.findUser(db, id);
    if (!target)
        throw new NotFoundError('No such user.');
    const [roles, roleIds, employeeRow] = await Promise.all([
        q.allRoles(db),
        q.roleIdsFor(db, id),
        target.employee_id
            ? db
                .selectFrom('employees')
                .select(['id', 'employee_code'])
                .where('id', '=', Number(target.employee_id))
                .executeTakeFirst()
            : Promise.resolve(undefined),
    ]);
    const perms = c.get('perms');
    const canManageRoles = perms.has(PERMISSIONS.ROLES_MANAGE);
    const canManageHr = perms.has(PERMISSIONS.HR_EMPLOYEE_MANAGE);
    const self = currentUser(c).id === id;
    return c.html(_jsxs(AppShell, { title: `Edit ${target.full_name}`, user: currentUser(c), perms: perms, csrfToken: currentSession(c).csrfToken, path: "/app/admin/users", subtitle: target.email, actions: _jsx("a", { class: "ncc-btn", href: `/app/admin/users/${id}`, children: "Back to account" }), children: [banner(c), _jsx(Panel, { title: "Identity", children: _jsxs("form", { method: "post", action: `/app/admin/users/${id}/edit/name`, class: "ncc-stack", children: [_jsx("input", { type: "hidden", name: "nc_csrf", value: currentSession(c).csrfToken }), _jsxs("div", { class: "ncc-grid ncc-grid--2", children: [_jsx(FormField, { label: "Full name", name: "fullName", value: target.full_name, required: true }), _jsx(FormField, { label: "Email", name: "email", type: "email", value: target.email, disabled: true })] }), _jsx("p", { class: "ncc-hint", children: "Email is changed on its own below \u2014 changing it signs the person out everywhere." }), _jsx("button", { class: "ncc-btn ncc-btn--primary", type: "submit", children: "Save name" })] }) }), _jsx(Panel, { title: "Email", children: _jsxs("form", { method: "post", action: `/app/admin/users/${id}/email`, class: "ncc-stack", children: [_jsx("input", { type: "hidden", name: "nc_csrf", value: currentSession(c).csrfToken }), _jsxs("div", { class: "ncc-grid ncc-grid--2", children: [_jsx(FormField, { label: "New email", name: "email", type: "email", value: target.email, required: true }), _jsx(FormField, { label: "Confirm current email", name: "confirmEmail", value: target.email, disabled: true })] }), _jsx("p", { class: "ncc-hint", children: "The address is their sign-in. Changing it signs them out everywhere immediately." }), _jsx("button", { class: "ncc-btn ncc-btn--primary", type: "submit", children: "Change email" })] }) }), _jsx(Panel, { title: "Employee record", children: employeeRow ? (canManageHr ? (_jsxs("form", { method: "post", action: `/app/admin/users/${id}/employee-code`, class: "ncc-stack", children: [_jsx("input", { type: "hidden", name: "nc_csrf", value: currentSession(c).csrfToken }), _jsx("div", { class: "ncc-grid ncc-grid--2", children: _jsx(FormField, { label: "Employee code", name: "employeeCode", value: employeeRow.employee_code, required: true, hint: "Must be unique across all employees." }) }), _jsx("button", { class: "ncc-btn ncc-btn--primary", type: "submit", children: "Save employee code" })] })) : (_jsxs("p", { class: "ncc-hint", children: ["Employee code ", _jsx("code", { children: employeeRow.employee_code }), ". Editing it needs the hr.employee_manage permission, which your account does not hold."] }))) : (_jsx("p", { class: "ncc-hint", children: "This account is not linked to an employee record, so there is no code to edit." })) }), _jsxs(Panel, { title: "Role and status", children: [canManageRoles ? (_jsxs("form", { method: "post", action: `/app/admin/users/${id}/roles`, class: "ncc-stack", children: [_jsx("input", { type: "hidden", name: "nc_csrf", value: currentSession(c).csrfToken }), _jsx("div", { class: "ncc-grid ncc-grid--2", children: roles.map((role) => (_jsxs("label", { class: "ncc-check", children: [_jsx("input", { type: "checkbox", name: "roleIds", value: String(role.id), checked: roleIds.includes(Number(role.id)) }), _jsxs("span", { children: [_jsx("strong", { children: role.label }), Number(role.require_2fa) === 1 ? _jsx("span", { class: "ncc-muted", children: " requires two factor" }) : null] })] }))) }), _jsx("button", { class: "ncc-btn ncc-btn--primary", type: "submit", children: "Save roles" })] })) : (_jsx("p", { class: "ncc-hint", children: "Changing roles needs the roles.manage permission, which your account does not hold." })), _jsxs("form", { method: "post", action: `/app/admin/users/${id}/status`, class: "ncc-toolbar", children: [_jsx("input", { type: "hidden", name: "nc_csrf", value: currentSession(c).csrfToken }), _jsxs("select", { name: "status", class: "ncc-input", "aria-label": "Account status", children: [_jsx("option", { value: "active", selected: target.status === 'active', children: "Active" }), _jsx("option", { value: "suspended", selected: target.status === 'suspended', children: "Suspended" }), _jsx("option", { value: "inactive", selected: target.status === 'inactive', children: "Inactive" })] }), _jsx("button", { class: "ncc-btn", type: "submit", children: "Update status" })] })] }), _jsx(Panel, { title: "Credentials", children: self ? (_jsx("p", { class: "ncc-hint", children: "You cannot reset your own password or two factor here \u2014 use your own account\u2019s pages, or ask another administrator." })) : (_jsxs(_Fragment, { children: [_jsxs("form", { method: "post", action: `/app/admin/users/${id}/password-reset`, class: "ncc-stack", children: [_jsx("input", { type: "hidden", name: "nc_csrf", value: currentSession(c).csrfToken }), _jsx("p", { class: "ncc-hint", children: "Sets a temporary password you choose. The person must change it at next sign-in and their sessions all die." }), _jsx("div", { class: "ncc-grid ncc-grid--2", children: _jsx(FormField, { label: "Temporary password", name: "password", required: true, hint: "At least 12 characters with upper case, lower case and a digit." }) }), _jsx("button", { class: "ncc-btn", type: "submit", children: "Set temporary password" })] }), target.totp_confirmed_at ? (_jsxs("form", { method: "post", action: `/app/admin/users/${id}/totp-reset`, class: "ncc-toolbar", children: [_jsx("input", { type: "hidden", name: "nc_csrf", value: currentSession(c).csrfToken }), _jsx("button", { class: "ncc-btn", type: "submit", children: "Reset two factor" })] })) : (_jsx("p", { class: "ncc-hint", children: "Two factor is not enrolled on this account." }))] })) })] }));
});
/** Name correction (29.72): audited, no session invalidation. */
admin.post('/app/admin/users/:id/edit/name', requirePermission(PERMISSIONS.USERS_MANAGE), async (c) => {
    const id = Number(c.req.param('id'));
    const parsed = changeNameSchema.safeParse(await readBody(c));
    if (!Number.isInteger(id) || !parsed.success) {
        return c.redirect(`/app/admin/users/${id}/edit?error=${encodeURIComponent(parsed.success ? 'No such user.' : firstError(parsed.error))}`, 303);
    }
    await svc.changeUserName(c.get('db'), actorOf(c), id, parsed.data.fullName);
    return c.redirect(`/app/admin/users/${id}/edit?ok=${encodeURIComponent('Name updated.')}`, 303);
});
/** Employee code assignment (29.71): HR_EMPLOYEE_MANAGE — the code is an
 * HR-record field; see the service note for the gate choice. */
admin.post('/app/admin/users/:id/employee-code', requirePermission(PERMISSIONS.HR_EMPLOYEE_MANAGE), async (c) => {
    const id = Number(c.req.param('id'));
    const parsed = employeeCodeSchema.safeParse(await readBody(c));
    if (!Number.isInteger(id) || !parsed.success) {
        return c.redirect(`/app/admin/users/${id}?error=${encodeURIComponent(parsed.success ? 'No such user.' : parsed.error.issues[0].message)}`, 303);
    }
    await svc.setEmployeeCode(c.get('db'), actorOf(c), id, parsed.data.employeeCode);
    return c.redirect(`/app/admin/users/${id}?ok=${encodeURIComponent('Employee code updated.')}`, 303);
});
admin.post('/app/admin/users/:id/roles', requirePermission(PERMISSIONS.ROLES_MANAGE), async (c) => {
    const id = Number(c.req.param('id'));
    const parsed = rolesSchema.safeParse(await readBody(c));
    if (!Number.isInteger(id) || !parsed.success)
        throw new NotFoundError('No such user.');
    await svc.replaceUserRoles(c.get('db'), actorOf(c), id, parsed.data.roleIds);
    return c.redirect(`/app/admin/users/${id}?ok=${encodeURIComponent('Roles saved.')}`, 303);
});
admin.post('/app/admin/users/:id/overrides', requirePermission(PERMISSIONS.ROLES_MANAGE), async (c) => {
    const id = Number(c.req.param('id'));
    const parsed = overrideSchema.safeParse(await readBody(c));
    if (!Number.isInteger(id))
        throw new NotFoundError('No such user.');
    if (!parsed.success) {
        return c.redirect(`/app/admin/users/${id}?error=${encodeURIComponent(firstError(parsed.error))}`, 303);
    }
    await svc.addOverride(c.get('db'), actorOf(c), id, parsed.data);
    return c.redirect(`/app/admin/users/${id}?ok=${encodeURIComponent('Override added.')}`, 303);
});
admin.post('/app/admin/overrides/:id/remove', requirePermission(PERMISSIONS.ROLES_MANAGE), async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id))
        throw new NotFoundError('No such override.');
    await readBody(c);
    await svc.removeOverride(c.get('db'), actorOf(c), id);
    return c.redirect(`/app/admin/users?ok=${encodeURIComponent('Override removed.')}`, 303);
});
/* Roles ------------------------------------------------------------------- */
admin.get('/app/admin/roles', requirePermission(PERMISSIONS.ROLES_MANAGE), async (c) => {
    const roles = await q.allRoles(c.get('db'));
    const user = currentUser(c);
    const session = currentSession(c);
    return c.html(_jsxs(AppShell, { title: "Roles", user: user, perms: c.get('perms'), csrfToken: session.csrfToken, path: "/app/admin/roles", subtitle: "A role is a named bundle of permissions. Routes check permissions, never role names.", children: [_jsx(Tabs, { tabs: ADMIN_TABS, active: "/app/admin/roles" }), banner(c), _jsx(Panel, { title: "All roles", children: _jsx(DataTable, { columns: [
                        {
                            header: 'Role',
                            cell: (row) => (_jsxs(_Fragment, { children: [_jsx("a", { href: `/app/admin/roles/${row.id}`, children: _jsx("strong", { children: row.label }) }), _jsx("div", { class: "ncc-muted", children: _jsx("code", { children: row.key }) })] })),
                        },
                        { header: 'Description', cell: (row) => row.description ?? '' },
                        {
                            header: 'Two factor',
                            cell: (row) => (Number(row.require_2fa) === 1 ? 'Required' : _jsx("span", { class: "ncc-muted", children: "Optional" })),
                        },
                        {
                            header: 'Project scope',
                            cell: (row) => Number(row.scope_to_assigned_projects) === 1 ? 'Assigned projects only' : 'All projects',
                        },
                    ], rows: roles, empty: "No roles." }) })] }));
});
admin.get('/app/admin/roles/:id', requirePermission(PERMISSIONS.ROLES_MANAGE), async (c) => {
    const db = c.get('db');
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0)
        throw new NotFoundError('No such role.');
    const roles = await q.allRoles(db);
    const role = roles.find((r) => Number(r.id) === id);
    if (!role)
        throw new NotFoundError('No such role.');
    const [permissions, held] = await Promise.all([q.allPermissions(db), q.permissionIdsForRole(db, id)]);
    const heldSet = new Set(held);
    const isOwner = role.key === 'owner';
    const user = currentUser(c);
    const session = currentSession(c);
    return c.html(_jsxs(AppShell, { title: role.label, user: user, perms: c.get('perms'), csrfToken: session.csrfToken, path: "/app/admin/roles", subtitle: `Role key ${role.key}`, actions: _jsx("a", { class: "ncc-btn", href: "/app/admin/roles", children: "Back to roles" }), children: [banner(c), isOwner ? (_jsx(Alert, { tone: "warn", children: "The owner role always holds every permission and cannot be edited. It is the recovery path if another role is misconfigured." })) : null, _jsxs("form", { method: "post", action: `/app/admin/roles/${id}`, class: "ncc-stack", children: [_jsx("input", { type: "hidden", name: "nc_csrf", value: session.csrfToken }), PERMISSION_MODULES.map((module) => {
                        const inModule = permissions.filter((p) => p.module === module.key);
                        if (inModule.length === 0)
                            return null;
                        return (_jsx(Panel, { title: module.label, children: _jsx("div", { class: "ncc-grid ncc-grid--2", children: inModule.map((p) => (_jsxs("label", { class: "ncc-check", children: [_jsx("input", { type: "checkbox", name: "permissionIds", value: String(p.id), checked: isOwner || heldSet.has(Number(p.id)), disabled: isOwner }), _jsxs("span", { children: [p.label, _jsx("div", { class: "ncc-muted", children: _jsx("code", { children: p.key }) })] })] }))) }) }));
                    }), isOwner ? null : (_jsx("button", { class: "ncc-btn ncc-btn--primary", type: "submit", children: "Save permissions" }))] })] }));
});
admin.post('/app/admin/roles/:id', requirePermission(PERMISSIONS.ROLES_MANAGE), async (c) => {
    const id = Number(c.req.param('id'));
    const parsed = rolePermissionsSchema.safeParse(await readBody(c));
    if (!Number.isInteger(id) || !parsed.success)
        throw new NotFoundError('No such role.');
    await svc.setRolePermissions(c.get('db'), actorOf(c), id, parsed.data.permissionIds);
    return c.redirect(`/app/admin/roles/${id}?ok=${encodeURIComponent('Permissions saved.')}`, 303);
});
/* Approval limits --------------------------------------------------------- */
admin.get('/app/admin/approval-limits', requirePermission(PERMISSIONS.ROLES_MANAGE), async (c) => {
    const limits = await q.approvalLimits(c.get('db'));
    const user = currentUser(c);
    const session = currentSession(c);
    return c.html(_jsxs(AppShell, { title: "Approval limits", user: user, perms: c.get('perms'), csrfToken: session.csrfToken, path: "/app/admin/approval-limits", subtitle: "What each role may approve, and above what value a second approver is required.", children: [_jsx(Tabs, { tabs: ADMIN_TABS, active: "/app/admin/approval-limits" }), banner(c), _jsx(Alert, { tone: "warn", children: "These are seeded placeholders. The real figures are open question 8.2 in the build specification and need the owner's decision before the finance module is relied on." }), _jsx(Panel, { title: "Current limits", children: _jsx(DataTable, { columns: [
                        { header: 'Document', cell: (row) => String(row.document_type).replace(/_/g, ' ') },
                        { header: 'Role', cell: (row) => row.role_label ?? row.role_key },
                        {
                            header: 'Up to',
                            numeric: true,
                            cell: (row) => row.document_type === 'quote_discount_pct'
                                ? `${Number(row.max_value) / 100}%`
                                : formatPaiseAsRupees(Number(row.max_value)),
                        },
                        {
                            header: 'Second approver above',
                            numeric: true,
                            cell: (row) => row.requires_second_approval_above === null ? (_jsx("span", { class: "ncc-muted", children: "Never" })) : (formatPaiseAsRupees(Number(row.requires_second_approval_above))),
                        },
                        { header: 'Effective from', cell: (row) => formatDate(row.effective_from) },
                    ], rows: limits, empty: "No limits configured." }) })] }));
});
/* Settings ---------------------------------------------------------------- */
admin.get('/app/admin/settings', requirePermission(PERMISSIONS.REFERENCE_MANAGE), async (c) => {
    const rows = await allSettings(c.get('db'));
    const user = currentUser(c);
    const session = currentSession(c);
    return c.html(_jsxs(AppShell, { title: "Settings", user: user, perms: c.get('perms'), csrfToken: session.csrfToken, path: "/app/admin/settings", subtitle: "Company configuration. These values were previously hardcoded in the PHP pages.", children: [_jsx(Tabs, { tabs: ADMIN_TABS, active: "/app/admin/settings" }), banner(c), _jsxs("form", { method: "post", action: "/app/admin/settings", class: "ncc-stack", children: [_jsx("input", { type: "hidden", name: "nc_csrf", value: session.csrfToken }), _jsx(Panel, { title: `${rows.length} settings`, children: _jsx("div", { class: "ncc-stack", children: rows.map((row) => {
                                const value = parseJsonColumn(row.value_json);
                                const name = `s_${row.key_name}`;
                                if (row.data_type === 'bool') {
                                    return (_jsxs("label", { class: "ncc-check", children: [_jsx("input", { type: "checkbox", name: name, checked: value === true }), _jsxs("span", { children: [_jsx("strong", { children: row.label }), _jsx("div", { class: "ncc-muted", children: _jsx("code", { children: row.key_name }) })] })] }));
                                }
                                const display = row.data_type === 'money'
                                    ? String(Number(value ?? 0) / 100)
                                    : row.data_type === 'json'
                                        ? JSON.stringify(value)
                                        : String(value ?? '');
                                return (_jsx(FormField, { label: row.label, name: name, value: display, ...(row.data_type === 'json' ? { rows: 3 } : {}), type: row.data_type === 'int' ? 'number' : 'text', hint: `${row.key_name}${row.data_type === 'money' ? ', in rupees' : ''}` }));
                            }) }) }), _jsx("button", { class: "ncc-btn ncc-btn--primary", type: "submit", children: "Save settings" })] })] }));
});
admin.post('/app/admin/settings', requirePermission(PERMISSIONS.REFERENCE_MANAGE), async (c) => {
    const body = await readBody(c);
    const submitted = {};
    for (const [key, value] of Object.entries(body)) {
        if (key.startsWith('s_'))
            submitted[key] = typeof value === 'string' ? value : String(value ?? '');
    }
    const changed = await svc.saveSettings(c.get('db'), actorOf(c), submitted);
    const message = changed === 0 ? 'No changes to save.' : `${changed} ${changed === 1 ? 'setting' : 'settings'} saved.`;
    return c.redirect(`/app/admin/settings?ok=${encodeURIComponent(message)}`, 303);
});
/* Reference data ---------------------------------------------------------- */
admin.get('/app/admin/reference', requirePermission(PERMISSIONS.REFERENCE_MANAGE), async (c) => {
    const db = c.get('db');
    const [costHeads, units, numbering] = await Promise.all([
        q.listCostHeads(db),
        q.listUnits(db),
        q.listNumbering(db),
    ]);
    const user = currentUser(c);
    const session = currentSession(c);
    return c.html(_jsxs(AppShell, { title: "Reference data", user: user, perms: c.get('perms'), csrfToken: session.csrfToken, path: "/app/admin/reference", subtitle: "Cost heads, units and document numbering. Shared by projects, inventory and finance.", children: [_jsx(Tabs, { tabs: ADMIN_TABS, active: "/app/admin/reference" }), banner(c), _jsxs(Panel, { title: `Cost heads (${costHeads.length})`, children: [_jsx("p", { class: "ncc-hint", children: "A cost head that is in use cannot be deleted, only deactivated. Deleting one would orphan every budget line and expense that referenced it." }), _jsx(DataTable, { columns: [
                            { header: 'Code', cell: (row) => _jsx("code", { children: row.code }) },
                            { header: 'Name', cell: (row) => row.name },
                            { header: 'Type', cell: (row) => String(row.head_type).replace(/_/g, ' ') },
                            { header: 'Direct cost', cell: (row) => (Number(row.is_direct_cost) === 1 ? 'Yes' : 'No') },
                            { header: 'Active', cell: (row) => _jsx(StatusBadge, { status: Number(row.is_active) === 1 ? 'active' : 'inactive' }) },
                        ], rows: costHeads, empty: "No cost heads seeded." })] }), _jsxs("div", { class: "ncc-grid ncc-grid--2", children: [_jsx(Panel, { title: `Units (${units.length})`, children: _jsx(DataTable, { columns: [
                                { header: 'Code', cell: (row) => _jsx("code", { children: row.code }) },
                                { header: 'Name', cell: (row) => row.name },
                                { header: 'Decimals', numeric: true, cell: (row) => String(row.decimal_places) },
                            ], rows: units, empty: "No units seeded." }) }), _jsxs(Panel, { title: "Document numbering", children: [_jsx("p", { class: "ncc-hint", children: "Numbers are allocated with a row lock inside the caller's transaction, so two concurrent submits cannot produce the same purchase order number." }), _jsx(DataTable, { columns: [
                                    { header: 'Document', cell: (row) => String(row.doc_type).replace(/_/g, ' ') },
                                    { header: 'Prefix', cell: (row) => _jsx("code", { children: row.prefix }) },
                                    { header: 'Financial year', cell: (row) => row.financial_year },
                                    { header: 'Last used', numeric: true, cell: (row) => String(row.last_number) },
                                ], rows: numbering, empty: "No numbering series yet. They are created on first use." })] })] })] }));
});
/* Audit ------------------------------------------------------------------- */
const AUDIT_PAGE_SIZE = 50;
admin.get('/app/admin/audit', requirePermission(PERMISSIONS.AUDIT_VIEW), async (c) => {
    const db = c.get('db');
    const url = new URL(c.req.url);
    const parsed = auditFilterSchema.parse(Object.fromEntries(url.searchParams));
    const filter = {
        ...(parsed.userId !== undefined ? { userId: parsed.userId } : {}),
        ...(parsed.action ? { action: parsed.action } : {}),
        ...(parsed.entityType ? { entityType: parsed.entityType } : {}),
        ...(parsed.from ? { from: parsed.from } : {}),
        ...(parsed.to ? { to: parsed.to } : {}),
    };
    const [rows, total, actions, users] = await Promise.all([
        q.auditPage(db, { ...filter, limit: AUDIT_PAGE_SIZE, offset: (parsed.page - 1) * AUDIT_PAGE_SIZE }),
        q.auditCount(db, filter),
        q.distinctAuditActions(db),
        q.listUsers(db),
    ]);
    const user = currentUser(c);
    const session = currentSession(c);
    return c.html(_jsxs(AppShell, { title: "Audit log", user: user, perms: c.get('perms'), csrfToken: session.csrfToken, path: "/app/admin/audit", subtitle: `${total} recorded ${total === 1 ? 'event' : 'events'}`, children: [_jsx(Tabs, { tabs: ADMIN_TABS, active: "/app/admin/audit" }), _jsx(Panel, { title: "Filter", children: _jsxs("form", { method: "get", action: "/app/admin/audit", class: "ncc-toolbar", children: [_jsxs("select", { name: "userId", class: "ncc-input", "aria-label": "User", children: [_jsx("option", { value: "", children: "Anyone" }), users.map((u) => (_jsx("option", { value: String(u.id), selected: parsed.userId === u.id, children: u.full_name })))] }), _jsxs("select", { name: "action", class: "ncc-input", "aria-label": "Action", children: [_jsx("option", { value: "", children: "Any action" }), actions.map((a) => (_jsx("option", { value: a, selected: parsed.action === a, children: a })))] }), _jsx("input", { type: "date", name: "from", class: "ncc-input", value: parsed.from ?? '', "aria-label": "From date" }), _jsx("input", { type: "date", name: "to", class: "ncc-input", value: parsed.to ?? '', "aria-label": "To date" }), _jsx("button", { class: "ncc-btn", type: "submit", children: "Apply" }), _jsx("a", { class: "ncc-btn", href: "/app/admin/audit", children: "Clear" })] }) }), _jsxs(Panel, { title: "Events", children: [_jsx(DataTable, { columns: [
                            { header: 'When', cell: (row) => _jsx("span", { class: "ncc-muted", children: formatDateTime(row.created_at) }) },
                            {
                                header: 'Who',
                                cell: (row) => row.user_name ? (_jsxs(_Fragment, { children: [row.user_name, _jsx("div", { class: "ncc-muted", children: row.user_email })] })) : (_jsx("span", { class: "ncc-muted", children: "System" })),
                            },
                            { header: 'Action', cell: (row) => _jsx("code", { children: row.action }) },
                            {
                                header: 'Entity',
                                cell: (row) => row.entity_type ? (_jsxs(_Fragment, { children: [row.entity_type, row.entity_id ? _jsxs("span", { class: "ncc-muted", children: [" #", row.entity_id] }) : null] })) : (''),
                            },
                            {
                                header: 'Change',
                                cell: (row) => _jsx(FieldDiff, { before: row.before_json, after: row.after_json }),
                            },
                        ], rows: rows, empty: "No events match that filter." }), _jsx(Pager, { page: parsed.page, pageSize: AUDIT_PAGE_SIZE, total: total, baseHref: `/app/admin/audit?${new URLSearchParams(Object.fromEntries([...url.searchParams.entries()].filter(([k]) => k !== 'page'))).toString()}` })] })] }));
});
/**
 * Field-level diff of the audit JSON (spec 6.2).
 *
 * Showing two raw JSON blobs makes the reader diff them by eye, which is
 * exactly what nobody does at the moment they need the audit log. Only keys
 * that actually changed are listed.
 *
 * The props are `unknown` because audit_log.before_json and after_json arrive
 * already parsed (src/lib/json.ts). Typing them `string | null` and parsing was
 * the bug: an object is truthy, JSON.parse stringified it to "[object Object]"
 * and threw, and the catch rendered one `value` row holding the entire blob —
 * so the diff this component exists to produce never ran once.
 */
function FieldDiff(props) {
    const asRecord = (raw) => {
        const value = parseJsonColumn(raw);
        if (value === null || value === undefined || value === '')
            return null;
        // A scalar in the column is not a field map. Wrapping it keeps it visible
        // rather than rendering an empty diff.
        return typeof value === 'object' ? value : { value };
    };
    const before = asRecord(props.before);
    const after = asRecord(props.after);
    if (!before && !after)
        return _jsx("span", { class: "ncc-muted", children: "No detail" });
    const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
    const show = (value) => {
        if (value === undefined)
            return 'not set';
        if (value === null)
            return 'empty';
        return typeof value === 'string' ? value : JSON.stringify(value);
    };
    const changed = keys.filter((key) => show(before?.[key]) !== show(after?.[key]));
    if (changed.length === 0)
        return _jsx("span", { class: "ncc-muted", children: "No field changed" });
    return (_jsx("ul", { class: "ncc-diff", children: changed.map((key) => (_jsxs("li", { children: [_jsx("code", { children: key }), ' ', before === null ? (_jsx("ins", { children: show(after?.[key]) })) : after === null ? (_jsx("del", { children: show(before?.[key]) })) : (_jsxs(_Fragment, { children: [_jsx("del", { children: show(before?.[key]) }), " ", _jsx("ins", { children: show(after?.[key]) })] }))] }))) }));
}
/* Enquiries --------------------------------------------------------------- */
const ENQUIRY_PAGE_SIZE = 25;
admin.get('/app/admin/enquiries', requirePermission(PERMISSIONS.ENQUIRIES_VIEW), async (c) => {
    const db = c.get('db');
    const url = new URL(c.req.url);
    const status = url.searchParams.get('status') ?? '';
    const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
    const [rows, total] = await Promise.all([
        q.enquiryPage(db, {
            ...(status ? { status } : {}),
            limit: ENQUIRY_PAGE_SIZE,
            offset: (page - 1) * ENQUIRY_PAGE_SIZE,
        }),
        q.enquiryCount(db, status || undefined),
    ]);
    const user = currentUser(c);
    const session = currentSession(c);
    const canPromote = c.get('perms').has(PERMISSIONS.CRM_LEAD_MANAGE);
    return c.html(_jsxs(AppShell, { title: "Website enquiries", user: user, perms: c.get('perms'), csrfToken: session.csrfToken, path: "/app/admin/enquiries", subtitle: "Every submission from the public contact forms. Unlike the old site, none of these are lost.", children: [_jsx(Tabs, { tabs: ADMIN_TABS, active: "/app/admin/enquiries" }), banner(c), _jsxs(Panel, { title: `${total} ${total === 1 ? 'enquiry' : 'enquiries'}`, children: [_jsxs("form", { method: "get", action: "/app/admin/enquiries", class: "ncc-toolbar", children: [_jsxs("select", { name: "status", class: "ncc-input", "aria-label": "Status", children: [_jsx("option", { value: "", children: "All" }), ['new', 'contacted', 'promoted', 'spam', 'closed'].map((s) => (_jsx("option", { value: s, selected: status === s, children: s })))] }), _jsx("button", { class: "ncc-btn", type: "submit", children: "Filter" })] }), _jsx(DataTable, { columns: [
                            { header: 'Received', cell: (row) => _jsx("span", { class: "ncc-muted", children: formatDateTime(row.created_at) }) },
                            {
                                header: 'From',
                                cell: (row) => (_jsxs(_Fragment, { children: [_jsx("strong", { children: row.name }), _jsxs("div", { class: "ncc-muted", children: [row.email ? _jsx("a", { href: `mailto:${row.email}`, children: row.email }) : null, row.phone ? _jsxs(_Fragment, { children: [" ", row.phone] }) : null] })] })),
                            },
                            {
                                header: 'Enquiry',
                                cell: (row) => (_jsxs(_Fragment, { children: [row.service_interest ? _jsx("div", { children: row.service_interest }) : null, _jsx("div", { children: row.message }), _jsxs("div", { class: "ncc-muted", children: ["via ", row.source_page] })] })),
                            },
                            {
                                header: 'Status',
                                cell: (row) => (_jsxs(_Fragment, { children: [_jsx(StatusBadge, { status: row.status }), row.handler ? _jsx("div", { class: "ncc-muted", children: row.handler }) : null] })),
                            },
                            {
                                header: '',
                                cell: (row) => (_jsxs("form", { method: "post", action: `/app/admin/enquiries/${row.id}/status`, class: "ncc-stack", children: [_jsx("input", { type: "hidden", name: "nc_csrf", value: session.csrfToken }), _jsx("select", { name: "status", class: "ncc-input", "aria-label": "Set status", children: ['new', 'contacted', 'promoted', 'spam', 'closed'].map((s) => (_jsx("option", { value: s, selected: row.status === s, children: s }))) }), _jsx("button", { class: "ncc-btn ncc-btn--small", type: "submit", children: "Update" }), canPromote && row.status !== 'promoted' ? (_jsx("a", { class: "ncc-btn ncc-btn--small", href: `/app/crm/leads/new?enquiry=${row.id}`, children: "Promote to lead" })) : null] })),
                            },
                        ], rows: rows, empty: "No enquiries yet." }), _jsx(Pager, { page: page, pageSize: ENQUIRY_PAGE_SIZE, total: total, baseHref: `/app/admin/enquiries?status=${encodeURIComponent(status)}` })] })] }));
});
admin.post('/app/admin/enquiries/:id/status', requirePermission(PERMISSIONS.ENQUIRIES_VIEW), async (c) => {
    const id = Number(c.req.param('id'));
    const parsed = enquiryStatusSchema.safeParse(await readBody(c));
    if (!Number.isInteger(id) || !parsed.success)
        throw new NotFoundError('No such enquiry.');
    await svc.setEnquiryStatus(c.get('db'), actorOf(c), id, parsed.data.status);
    return c.redirect(`/app/admin/enquiries?ok=${encodeURIComponent('Enquiry updated.')}`, 303);
});
export default admin;
