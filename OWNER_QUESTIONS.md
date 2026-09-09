# Questions for the owner

One page, plain language. Each item says: the question, why it blocks work,
what the system does today without an answer, and what changes once it is
answered. Each links to the section of `DECISIONS.md` that records the current
behaviour in detail — file an answer against that section.

---

## 1. Who actually works here, and what can each of them do? (§8.1)

**Question:** Please give us the real organisation chart: the list of roles the
company actually has, who holds each one, and what each role should and should
not be able to do in the system.

**Why it blocks:** Every permission in the system is seeded from an assumed
list. Until the real list arrives, no real staff record can be created and no
login can be issued — the standing rule is that no real staff rows exist while
§8.1 is unanswered.

**Today:** The system runs on 8 provisional roles with 204 permission grants,
checked internally for consistency but never against reality. Everyone in the
fixtures is invented.

**Once answered:** Roles are renamed or added to match the real chart, the two
permissions that need a specific ruling are settled, and the first real staff
accounts can be created.

*Details: DECISIONS.md §2.5 and §9.1.*

## 2. Who can approve what, and up to how much money? (§8.2)

**Question:** What spending amount can each person approve on their own, and
above what amount does a second signature become required?

**Why it blocks:** The expense-approval gate cannot let anything through until
limits exist. Today approving an expense fails the limit check by default, so
the normal path for getting work paid is blocked.

**Today:** The approval-limits table is empty. A missing limit is read as
"refuse", which is the safe direction but means nothing can be approved.

**Once answered:** Limits are loaded, normal approvals start working, and the
second-signature threshold takes effect exactly where you set it.

*Details: DECISIONS.md §27.2.*

## 3. What are the standard build stages and payment milestones? (§8.3)

**Question:** For each package you sell, what are the stages of work and the
payment milestones attached to them? (For example: foundation 20%, structure
40%, finishing 30%, handover 10%.)

**Why it blocks:** Quotations, milestone billing and progress tracking all read
from these templates. The billing flow cannot be used on a real project until
the real templates exist.

**Today:** One example template from the spec is seeded, clearly labelled as
placeholder.

**Once answered:** Real templates replace the example, and new projects can be
set up with correct payment schedules.

*Details: DECISIONS.md §9 table, row §8.3.*

## 4. How many leave days does each type give per year? (§8.6)

**Question:** For each leave type — earned, casual, sick, unpaid,
compensatory, maternity, paternity — how many days per year, and how much can
be carried into the next year? Also: are you registered under EPF and ESI, and
does the leave year run April-to-March or January-to-December?

**Why it blocks:** The leave-checking rule is already written but is dormant:
with no quota numbers, nothing is refused. It switches on the moment numbers
are entered — no code change needed.

**Today:** Leave balances are tracked but never refused, so a request can
exceed any entitlement.

**Once answered:** Over-quota leave starts being refused automatically. Note:
the first tests that used a zero quota will need fixture data, not a looser
rule.

*Details: DECISIONS.md §17.1 and §17.3.*

## 5. What is the Karnataka public holiday list for this year? (§8.6)

**Question:** The dated list of gazetted holidays — general and restricted —
for the current financial year.

**Why it blocks:** Salary and leave calculations count every day except Sunday
as a working day. A wrong or invented holiday list silently mis-costs payroll,
so none has been guessed.

**Today:** Holidays are counted as ordinary working days; the muster roll shows
them as unmarked days; leave taken over a holiday is over-deducted.

**Once answered:** A small holiday table is loaded, one rule branch is switched
on, and working-day counts become correct everywhere they are used.

*Details: DECISIONS.md §17.3, first item.*

## 6. If someone on approved leave turns up and works, what should happen? (§8.6)

**Question:** Is that (a) both a leave day and a worked day, (b) the leave day
cancelled, or (c) an error the clerk must fix before either record exists?

**Why it blocks:** This is a payroll-accuracy question no test can answer
alone. A wrong rule produces no error anywhere — the salary figure just comes
out wrong and nobody can reconstruct why.

**Today:** Both records are allowed to coexist; leave stays approved and
attendance says present.

**Once answered:** The rule is enforced, whichever of the three you choose.

*Details: DECISIONS.md §17.3, "Does attendance override approved leave?".*

## 7. When a contractor has more than one rate that applies, which one wins? (from spec line 1644)

**Question:** Rate cards can overlap — a company-wide rate, a project-specific
rate, a mason rate, a general labourer rate. Which should be used? The system
currently picks in this order: project-specific first, then skill-specific,
then the most recent start date, then the higher row number (that last case is
flagged as ambiguous on screen). Is that right? An alternative some firms use
is simply the highest applicable rate.

**Why it blocks:** The chosen rate is snapshotted onto the day's record and
becomes permanent. A wrong rule pays the wrong amount and nothing in the
system flags it as wrong — the bill reconciles with itself.

**Today:** The four-step order above, stated here so you can confirm or
correct it rather than having to read code.

**Once answered:** The order is confirmed in writing or changed, and
overlapping rate cards either gain a supersession rule or a refusal.

*Details: DECISIONS.md §17.3, "Which rate wins…".*

## 8. A clerk records the wrong kind of contractor day — how do they fix it? (§17.3)

**Question:** May a supervisor withdraw a contractor attendance entry that has
not been approved yet? And what about one that is approved but not yet billed?

**Why it blocks:** There is no correction path in the system. Since a schema
change made day-entries and measured-entries mutually exclusive, a mistake can
no longer be overwritten — the only fix today is someone with direct database
access.

**Today:** Deliberate refusal with no way out. The refusal itself is
considered correct; what is missing is the answer for what the person who hit
it should do.

**Once answered:** A void or reversal route is built to exactly the rule you
give — before approval, after approval, or as a finance adjustment only.

*Details: DECISIONS.md §17.3, "A clerk who mis-enters…".*

## 9. Does an unpaid site advance stop an employee from leaving? (§6.8 rule 6)

**Question:** When someone exits with an open cash advance, is that a blocker
(the exit stops until it is settled) or a finance matter (recovered from the
final payment)?

**Why it blocks:** The spec's cross-reference for this turned out to point at
the wrong rule, so the behaviour is genuinely undecided rather than
implemented.

**Today:** An employee holding an open advance can exit with no warning raised
about it.

**Once answered:** Either an exit blocker is added or the recovery route is
documented as the intended one.

*Details: DECISIONS.md §17.3, "do open site advances also block employee exit?",
and §26.5.*

## 10. Are all your clients inside Karnataka? (§6.8 rule 5)

**Question:** For GST, is every client you invoice registered in Karnataka?
The system stores a place of supply on every invoice and currently always
writes "KA".

**Why it blocks:** Karnataka means the tax is split CGST + SGST; any other
state means IGST. If a client is actually registered elsewhere, every invoice
is split the wrong way.

**Today:** Every invoice is recorded as intra-Karnataka, explicitly, because
someone has to choose — the system refuses to guess it from the project or
client record.

**Once answered:** Either the current behaviour is confirmed as correct, or
invoices for out-of-state clients carry that client's state code and the tax
splits accordingly.

*Details: DECISIONS.md §17.3 (last added item) and §27.4.*
