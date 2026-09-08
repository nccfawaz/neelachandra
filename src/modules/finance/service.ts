import { randomUUID } from 'node:crypto'
import type { Db, Trx } from '../../db/kysely.js'
import { writeAudit } from '../../lib/audit.js'
import { nextNumber } from '../../lib/numbering.js'
import { ConflictError, ForbiddenError, NotFoundError, UnprocessableError } from '../../lib/errors.js'
import { resolveApprovalLimit } from '../../lib/permissions.js'
import { formatPaise } from '../../lib/money.js'
import { nowSqlDateTime, today } from '../../lib/dates.js'
import { costHeadStates, periodForDate } from './queries.js'
import type { ExpenseCreateInput } from './schemas.js'

/**
 * Finance service, slice 1 (spec 6.8 rules 1, 3, 4, 7).
 *
 * Rule 1: this file is the only writer of manual expenses. Rows with
 * source_type other than 'manual' are written by the module that owns the
 * upstream document, and the unique key uq_exp_source (source_table,
 * source_id) makes double posting impossible at the database level.
 *
 * Rule 3: approval is threshold-based with mandatory dual approval above the
 * limit, and self-approval is impossible — for every role including owner.
 *
 * Rule 4: approval that pushes committed + actual past the head's budget is
 * refused with the exact overrun figure. Committed and actual are read from
 * the 020 views and never recomputed here.
 *
 * Rule 7: expenses.period_id is stamped on approval, so the period-lock
 * triggers (migration 021) see the row's date on insert and the period on
 * update. The stamp is best-effort: a date outside every recorded period
 * leaves the column NULL, which the schema allows.
 */

export interface Actor {
  userId: number
  ip: string | null
}

export interface CreateExpenseResult {
  expenseId: number
  expenseNo: string
  status: 'draft'
}

/**
 * Creates a manual draft expense with its lines.
 *
 * The expense_no is allocated inside the transaction with nextNumber (the
 * same FOR UPDATE discipline as the PO flow), then the row is inserted with a
 * throwaway unique code and updated — the same shape as createEmployee,
 * because expense_no is NOT NULL UNIQUE and the id does not exist until the
 * insert returns.
 *
 * total_paise and net_payable_paise are the sum of the lines. GST and TDS
 * fields stay at their zero defaults in slice 1: a manual expense with
 * source_type 'manual' carries tax only when its vendor's bill says so, and
 * the vendor-bill path is a later slice.
 */
export async function createExpense(
  db: Db,
  actor: Actor,
  input: ExpenseCreateInput
): Promise<CreateExpenseResult> {
  return db.transaction().execute(async (trx) => {
    if (input.projectId !== null) {
      const project = await trx
        .selectFrom('projects')
        .select('id')
        .where('id', '=', input.projectId)
        .executeTakeFirst()
      if (!project) throw new UnprocessableError('That project no longer exists.')
    }

    const costHeadIds = input.lines.map((l) => l.costHeadId)
    const heads = await trx
      .selectFrom('cost_heads')
      .select('id')
      .where('id', 'in', costHeadIds)
      .execute()
    if (heads.length !== new Set(costHeadIds).size) {
      throw new UnprocessableError('One of the cost heads no longer exists.')
    }

    const totalPaise = input.lines.reduce((sum, l) => sum + l.amountPaise, 0)

    const inserted = await trx
      .insertInto('expenses')
      .values({
        expense_no: `TMP-${randomUUID().slice(0, 12)}`,
        expense_date: input.expenseDate,
        project_id: input.projectId,
        expense_type: input.expenseType,
        payee_type: input.payeeType,
        payee_name: input.payeeName,
        source_type: 'manual',
        narration: input.narration,
        total_paise: totalPaise,
        net_payable_paise: totalPaise,
        status: 'draft',
        created_by: actor.userId,
      })
      .executeTakeFirst()
    const expenseId = Number(inserted.insertId ?? 0)

    const expenseNo = await nextNumber(trx, 'expense', input.expenseDate)
    await trx.updateTable('expenses').set({ expense_no: expenseNo }).where('id', '=', expenseId).execute()

    await trx.insertInto('expense_lines').values(
      input.lines.map((l) => ({
        expense_id: expenseId,
        cost_head_id: l.costHeadId,
        description: l.description,
        amount_paise: l.amountPaise,
      }))
    ).execute()

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'finance.expense_create',
      entityType: 'expense',
      entityId: expenseId,
      after: {
        expense_no: expenseNo,
        expense_date: input.expenseDate,
        project_id: input.projectId,
        expense_type: input.expenseType,
        payee_type: input.payeeType,
        total_paise: totalPaise,
        lines: input.lines.map((l) => ({ cost_head_id: l.costHeadId, amount_paise: l.amountPaise })),
      },
      ip: actor.ip,
    })

    return { expenseId, expenseNo, status: 'draft' as const }
  })
}

/**
 * Submits a draft expense for approval.
 *
 * Mirrors submitPo: the row must be a draft with at least one line, and the
 * move to pending_approval is what puts it in the approver's queue. Kept
 * separate from createExpense so a half-entered expense never lands in the
 * queue, and separate from approveExpense so the queue's "approve" action
 * cannot be the same button that submits.
 */
export async function submitExpense(db: Db, actor: Actor, expenseId: number): Promise<string> {
  return db.transaction().execute(async (trx) => {
    const expense = await trx
      .selectFrom('expenses')
      .select(['id', 'expense_no', 'status'])
      .where('id', '=', expenseId)
      .forUpdate()
      .executeTakeFirst()
    if (!expense) throw new NotFoundError('That expense does not exist.')
    if (expense.status !== 'draft') {
      throw new ConflictError(`This expense is already ${String(expense.status).replace(/_/g, ' ')}. Only a draft can be submitted.`)
    }

    const lineCount = await trx
      .selectFrom('expense_lines')
      .select(trx.fn.countAll().as('n'))
      .where('expense_id', '=', expenseId)
      .executeTakeFirstOrThrow()
    if (Number(lineCount.n) === 0) {
      throw new UnprocessableError('An expense needs at least one line before it can be submitted.')
    }

    await trx.updateTable('expenses').set({ status: 'pending_approval' }).where('id', '=', expenseId).execute()

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'finance.expense_submit',
      entityType: 'expense',
      entityId: expenseId,
      before: { status: 'draft' },
      after: { status: 'pending_approval' },
      ip: actor.ip,
    })

    return expense.expense_no
  })
}

export interface ApproveExpenseResult {
  expenseNo: string
  status: 'approved' | 'awaiting_second_approval'
  totalPaise: number
}

/**
 * Approves an expense (rules 3 and 4).
 *
 * The refusals, in order:
 *
 *   1. The row is not pending_approval.
 *   2. Self-approval — the creator cannot approve, and the first approver
 *      cannot be the second. Owner included: the roles seed says so in prose
 *      ("Cannot self-approve expenses") and 4.3 gives the owner no exemption.
 *   3. No approval_limits row for the actor's roles — "cannot approve any
 *      amount", never "unlimited" (see resolveApprovalLimit's doc comment).
 *      approval_limits is seeded empty pending open question 8.2, so this is
 *      the live behaviour today and the message says where the row is set.
 *   4. Above the ceiling — escalates, naming the figure and the ceiling.
 *   5. Budget overrun (rule 4) — approving would push committed + actual past
 *      the head's budget line. The figures come from v_project_committed and
 *      v_project_actual, never recomputed. The message names the head, the
 *      overrunning figure and the three options the spec gives: revise the
 *      budget, reallocate between heads, or override with finance.budget_set
 *      and an audited note.
 *
 * Above requires_second_approval_above the first approval is recorded and the
 * row stays pending_approval, mirroring approvePo: an expense that reads
 * "approved" with one of two required signatures is the failure the second
 * signature exists to prevent.
 *
 * The approval stamps period_id from the expense date (rule 7) and writes the
 * audit entry with the budget figures the decision was made against.
 */
export async function approveExpense(
  db: Db,
  actor: Actor,
  expenseId: number,
  roleKeys: readonly string[]
): Promise<ApproveExpenseResult> {
  return db.transaction().execute(async (trx) => {
    const expense = await trx
      .selectFrom('expenses')
      .select([
        'id', 'expense_no', 'expense_date', 'project_id', 'status',
        'total_paise', 'created_by', 'approved_by', 'second_approved_by',
      ])
      .where('id', '=', expenseId)
      .forUpdate()
      .executeTakeFirst()
    if (!expense) throw new NotFoundError('That expense does not exist.')
    if (expense.status !== 'pending_approval') {
      throw new ConflictError(
        `This expense is ${String(expense.status).replace(/_/g, ' ')}. Only one awaiting approval can be approved.`
      )
    }
    if (Number(expense.created_by) === actor.userId) {
      throw new ForbiddenError(
        'You entered this expense, so you cannot approve it. Someone else holding the approval permission has to.'
      )
    }
    if (expense.approved_by !== null && Number(expense.approved_by) === actor.userId) {
      throw new ForbiddenError('You have already approved this expense. The second approval has to come from someone else.')
    }

    const total = Number(expense.total_paise)
    const limit = await resolveApprovalLimit(trx, roleKeys, 'expense', today())
    if (limit === null) {
      throw new UnprocessableError(
        'No expense approval limit is set for your role, so no amount can be approved yet. An administrator sets these under Roles and approval limits.'
      )
    }
    if (total > limit.maxValue) {
      throw new UnprocessableError(
        `${formatPaise(total)} is above your approval limit of ${formatPaise(limit.maxValue)}. This needs someone with a higher limit.`
      )
    }

    // Rule 4, read from the views (rule 2). Only a project expense can
    // overrun a project budget; company overhead (project_id NULL) has no
    // project budget to check against.
    const lines = await trx
      .selectFrom('expense_lines')
      .select(['cost_head_id', 'amount_paise'])
      .where('expense_id', '=', expenseId)
      .execute()
    if (expense.project_id !== null) {
      const states = await costHeadStates(trx, Number(expense.project_id))
      const stateByHead = new Map(states.map((s) => [s.costHeadId, s]))
      for (const line of lines) {
        const state = stateByHead.get(Number(line.cost_head_id))
        if (!state || state.budgetPaise === null) continue
        const projected = state.committedPaise + state.actualPaise + Number(line.amount_paise)
        if (projected > state.budgetPaise) {
          const overrun = projected - state.budgetPaise
          throw new UnprocessableError(
            `Approving this expense would push cost head ${line.cost_head_id} past its budget: ` +
              `${formatPaise(state.committedPaise)} committed plus ${formatPaise(state.actualPaise)} actual plus ` +
              `${formatPaise(Number(line.amount_paise))} here is ${formatPaise(projected)} against a budget of ` +
              `${formatPaise(state.budgetPaise)} — over by ${formatPaise(overrun)}. Revise the budget with a new ` +
              `project_budgets version, reallocate between heads, or override with finance.budget_set and a note.`
          )
        }
      }
    }

    const needsSecond =
      limit.requiresSecondApprovalAbove !== null && total > limit.requiresSecondApprovalAbove
    const isFirst = expense.approved_by === null

    if (needsSecond && isFirst) {
      await trx
        .updateTable('expenses')
        .set({ approved_by: actor.userId, approved_at: nowSqlDateTime() })
        .where('id', '=', expenseId)
        .execute()

      await writeAudit(trx, {
        userId: actor.userId,
        action: 'finance.expense_approve_first',
        entityType: 'expense',
        entityId: expenseId,
        before: { status: 'pending_approval', approved_by: null },
        after: {
          status: 'pending_approval',
          approved_by: actor.userId,
          total_paise: total,
          limit_role_key: limit.roleKey,
          requires_second_above: limit.requiresSecondApprovalAbove,
        },
        ip: actor.ip,
      })

      return { expenseNo: expense.expense_no, status: 'awaiting_second_approval' as const, totalPaise: total }
    }

    // Rule 7: the stamp happens on approval, and the trigger on expenses
    // refuses the update itself if the expense_date sits in a closed period.
    const periodId = await periodForDate(trx, String(expense.expense_date))
    await trx
      .updateTable('expenses')
      .set(
        isFirst
          ? {
              status: 'approved',
              approved_by: actor.userId,
              approved_at: nowSqlDateTime(),
              period_id: periodId,
            }
          : {
              status: 'approved',
              second_approved_by: actor.userId,
              second_approved_at: nowSqlDateTime(),
              period_id: periodId,
            }
      )
      .where('id', '=', expenseId)
      .execute()

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'finance.expense_approve',
      entityType: 'expense',
      entityId: expenseId,
      before: { status: 'pending_approval' },
      after: {
        status: 'approved',
        total_paise: total,
        limit_role_key: limit.roleKey,
        limit_max_value: limit.maxValue,
        second_approval: !isFirst,
        period_id: periodId,
      },
      ip: actor.ip,
    })

    return { expenseNo: expense.expense_no, status: 'approved' as const, totalPaise: total }
  })
}