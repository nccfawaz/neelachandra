# Questions for the owner

Fifteen questions, in four groups. Group A is the approval chain — who signs
what — because that is the set whose absence blocks daily work first. Each
item says: the question, why it blocks work, what the system does today
without an answer, and what changes once it is answered. Each links to the
section of `DECISIONS.md` that records the current behaviour in detail — file
an answer against that section.

**Where old items went (2026-09-17 rewrite, DECISIONS §29.66):** the previous
19-item list is regrouped here. Items 17 (website publishing) and 18 (2FA
reset) now belong to Fawaz (website administrator) and come off this list —
18 is built (admin reset, DECISIONS §29.65); 17 stays open but is Fawaz's to
declare, recorded in §17.3, not assumed. Old 1+12 merged into B8; old 5+6
into B10; old 3+15 into A7; old 7+8 into A4; old 9 folded into B9; old 14
folded into D14.

---

## Group A — the approval chain (A1–A7)

## A1. Who can approve what, and up to how much money? (§8.2)

**Question:** What spending amount can each person approve on their own, and
above what amount does a second signature become required?

**Why it blocks:** The expense-approval gate cannot let anything through until
limits exist. Today approving an expense fails the limit check by default, so
the normal path for getting work paid is blocked.

**Today:** The approval-limits table is empty (and stays empty by design —
DECISIONS §29.63: seeding the fourteen staff grants no money authority). A
missing limit is read as "refuse", which is safe but means nothing can be
approved.

**Once answered:** Limits are loaded, normal approvals start working, and the
second-signature threshold takes effect exactly where you set it.

*Details: DECISIONS.md §27.2.*

## A2. Who approves purchase orders, and at what value does it escalate? (§6.5)

**Question:** Name the approver (or approvers) of a purchase order, and the
value above which a second signature is needed.

**Why it blocks:** The PO route is gated on `inventory.approve_po`, but which
ROLES should hold it — and whether the creator may never approve their own —
is a business chain, not a code decision. Today ops_manager holds it; the
creator-may-not-approve rule is enforced in code but the chain above them is
not declared.

**Today:** A PO is raised by `inventory.po_create`, approved by whoever holds
`inventory.approve_po` (owner, ops_manager), with no value bands.

**Once answered:** The grant set and any value bands are recorded and the
grants tripwire updated.

*Details: DECISIONS.md §29.43 (PO route proofs).*

## A3. Who approves quotations — and who may discount, by how much? (§5.4)

**Question:** Who signs a quotation before it goes to the client, and what
discount can each level give without escalation?

**Why it blocks:** `crm.quote_approve` and `crm.quote_discount_override`
exist and are gated, but which roles should hold them beyond owner and
accounts_manager is undeclared.

**Today:** The raiser escalates their own quote; owner and ops_manager
approve; the discount override is owner-only.

*Details: DECISIONS.md §29.42 (quote route proofs).*

## A4. Contractor bills: who approves, which rate wins, and how is a wrong day fixed? (§6.6)

**Question:** Three answers in one conversation, all about contractor money:
(a) who approves a contractor bill for payment; (b) when more than one rate
applies to the same work, which one wins (spec line 1644); (c) when a clerk
records the wrong KIND of contractor day, what is the correction procedure?

**Why it blocks:** The bills are generated from approved attendance
(`NCC_BUILD_SPEC.md:1743`), so (b) and (c) decide what the bill is built
from, and (a) decides who releases the money.

**Today:** Bills generate from approved attendance only; a day recorded under
the wrong rate type is corrected by re-entry, and where several rates apply
the system does not silently choose — it needs a ruling.

*Details: DECISIONS.md §17.1, §17.2, and the §6.6 contractor sections.*

## A5. Who approves attendance — site level, HR level, or both? (§6.6)

**Question:** Attendance rows are marked by a supervisor and approved by
someone else. Name the approver at each level, and whether the approval is
per month, per week, or per site.

**Why it blocks:** `hr.attendance_approve` is held today by owner, ops_manager
and project_manager without a declared chain, and contractor bills inherit
whatever attendance was approved.

**Today:** The approval action exists and is gated; the business chain is not
declared.

## A6. Leave: confirm owner-only approval — and who approves the owner's leave? (§6.6)

**Question:** Confirm that ALL leave, for everyone, is approved by
Chandrashekar alone (recorded as settled in §17.3). If confirmed, then: who
approves the owner's OWN leave? The sole approver cannot approve himself —
the service refuses self-approval, so the owner's leave request sits pending
forever.

**Why it blocks:** This is not hypothetical. It is proven:
`tests/integration/leave-routing.test.ts` ("refuses the sole approver
approving his OWN leave") shows the refusal firing and the request staying
pending. Either a second leave approver must be named, or owner leave is
accepted out-of-system.

**Today:** Non-owners are refused with `hr.leave_approve` named (proven,
including for an HR-shaped role holding records and attendance); the owner's
own request has no decision path.

**Once answered:** Either a second grant is added, or the policy "owner leave
is recorded, not approved" is written into the module.

*Details: DECISIONS.md §29.64.*

## A7. Milestones: the stage templates, who certifies, and which month a cost belongs to (§8.3, §6.8 rule 7)

**Question:** Three linked answers: (a) the standard build stages and payment
milestones per package (§8.3) — only one labelled placeholder template is
seeded; (b) who certifies a milestone (`projects.milestone_certify` is held
by owner, accounts_manager and project_manager today — is that the chain?);
(c) when a bill for last month is approved this month, which month does the
cost belong to?

**Why it blocks:** Quotations, milestone billing and progress tracking all
read the templates; the cost-month rule decides what every monthly report
means.

**Today:** One example template, clearly labelled placeholder; cost lands in
the month of approval; a closed period refuses late bills rather than
reopening.

*Details: DECISIONS.md §27.1 (templates), §6.8 rule 7 records.*

---

## Group B — people (B8–B10)

## B8. Confirm the role chart — and who sees the company's profit? (§8.1, §6.8 rule 10)

**Question:** The fourteen real staff are now seeded against eight existing
roles (DECISIONS §29.63). Confirm the mapping — especially Shridhar and
Vinay both under operations, the four site engineers under
`site_supervisor`, and Fawaz as sole administrator — and answer rule 10's
visibility question: should ops_manager keep `projects.view_cost`, and
should anyone beyond owner hold `finance.view_company_pnl`?

**Why it blocks:** The role mapping is the implementer's, made from
designations and the spec's role list, not from a signed chart. The grants
tripwire (rule10-grants.test.ts) holds the current grants frozen until an
answer is filed.

**Today:** Mapping and grants as seeded; the tripwire fails on any grant
change.

**Once answered:** Roles are adjusted (or confirmed), and the tripwire is
re-seeded to the answered state.

*Details: DECISIONS.md §29.63 (the mapping table), §29.12 (rule 10).*

## B9. Leave quotas, statutory registrations, accrual year — and does an unpaid advance block exit? (§8.6, §6.8 rule 6)

**Question:** (a) `annual_quota` for each of EL, CL, SL, LWP, COMP, MAT and
PAT; (b) is the company registered under EPF and ESI — which decides whether
`uan`, `pf_number` and `esi_number` are required or optional; (c) does leave
accrue on the April financial year (assumed, matching `document_numbering`)
or the calendar year; (d) does an unpaid site advance stop an employee from
leaving, the way an unsettled store issue does?

**Why it blocks:** The leave balance screen computes against NULL quotas
today, which reads as "no limit" — generous in the wrong direction — and
payroll fields cannot be made mandatory without (b).

*Details: DECISIONS.md §17.3, §21.1, §6.8 rule 6 records.*

## B10. The Karnataka holiday list — and does work on an approved leave day override it? (§8.6)

**Question:** (a) The dated gazetted Karnataka holiday list for this
financial year (general vs restricted matters; a wrong date silently
mis-costs payroll). (b) If someone on approved leave turns up and works, is
that an attendance row plus a leave day (paid twice), a cancellation of the
leave day, or an error the clerk must resolve first?

**Why it blocks:** Today Sunday is the only non-working day, so holidays are
counted as worked; and the attendance-over-leave case is permitted only
because no refusal was ever written — the failure mode is silent, which is
why it sits on the blocking list (§17.3).

**Today:** `isWorkingDay` treats only Sunday as off; marking attendance over
an approved leave succeeds and both rows stand.

*Details: DECISIONS.md §16.3, §17.3, and the §8.6 records.*

---

## Group C — tax (C11–C12)

## C11. Where does the odd paisa of GST go? (§6.8 rule 5)

**Question:** When a tax amount lands on half a paisa, where should the odd
paisa go — and is tax computed per line or per invoice?

**Today:** Total tax rounds half-up (`roundPaise`), the single odd paisa of
the CGST/SGST split goes to CGST, and tax is computed once per invoice.

**Once answered:** The rounding helper and the split are adjusted to the
ruling, with the GST half-pair tests re-pinned.

*Details: DECISIONS.md §25.2 (rounding), §29 (the half-pair entries).*

## C12. Are all your clients inside Karnataka? (§6.8 rule 5)

**Question:** If every client's place of supply is Karnataka, IGST can never
arise and the invoice form can say so plainly. If an outside client exists,
the IGST path must be exercised and tested against a real case.

**Today:** The IGST column exists and is wired (migration 024); nothing
forces it to zero because the answer is not yet filed.

*Details: DECISIONS.md §29.24 (IGST slice).*

---

## Group D — cost truth (D13–D15)

## D13. Does the money held back (retention) ever differ between milestones? (§6.8 rule 5)

**Question:** Is retention a single percentage for every milestone, or can
the hold-back differ (e.g. 10% on running-account bills, 5% on the final)?

**Today:** One retention rate per milestone, set at certification; no
cross-milestone default.

*Details: DECISIONS.md §6.8 rule 5 records.*

## D14. Does the budget ceiling include labour — and how is a month reopened? (§6.8 rules 4 and 10, rule 1)

**Question:** (a) Does the project budget ceiling that gates new spending
include labour (contractor bills and payroll), or only materials and
subcontract packages? This decides whether the §29.26 labour gap makes the
ceiling figure wrong. (b) If a month is closed by mistake, what is the
sanctioned way to fix it? Today a closed period refuses late postings and
nothing reopens it — safe, but a mistake has no remedy.

*Details: DECISIONS.md §29.26 (the labour gap), §21 (period lock).*

## D15. What is "work in hand" — and who says so? (§6.8)

**Question:** The dashboard KPI tile labelled **Work in hand** uses a
definition made by the implementer, not the owner: the sum of
`project_milestones.amount_paise` over milestones in status `pending` or
`ready_to_certify` on active projects — work done or underway that has not
yet been certified. The tile is labelled with this definition in the UI
until you sign one.

**Alternatives you may actually mean:**

- **Certified-but-uninvoiced only** (strict revenue-recognition WIP);
- **Certified plus uninvoiced** (everything billable now);
- **Contract value − certified invoiced to date** (backlog remaining);
- Something else entirely — the §6.8 rule-10 views track cost, not forward
  revenue.

NCC_BUILD_SPEC.md never defines "work in hand"; the phrase does not appear
in it.

*Details: DECISIONS.md §29.62-era tile records and the widget source
(`src/dashboard/widgets.ts`).*
