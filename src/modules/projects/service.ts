import { sql } from 'kysely'
import type { Db, Trx } from '../../db/kysely.js'
import { writeAudit } from '../../lib/audit.js'
import { nextNumber } from '../../lib/numbering.js'
import { BadRequestError, ConflictError, NotFoundError, UnprocessableError } from '../../lib/errors.js'
import { addYears, nowSqlDateTime, today } from '../../lib/dates.js'

/**
 * Projects policy (spec 6.3).
 *
 * The rules that live here rather than in the routes are the ones that must
 * hold no matter which screen calls them: progress is derived, sequence is
 * physical, a milestone cannot be billed before its concrete has been tested,
 * and a status cannot jump a step. A route can be added later; these cannot
 * be re-implemented per route without drifting.
 */

export interface Actor {
  userId: number
  ip: string | null
}

export type ProjectStatus =
  | 'prospect'
  | 'mobilising'
  | 'in_progress'
  | 'on_hold'
  | 'snagging'
  | 'handed_over'
  | 'defect_liability'
  | 'closed'
  | 'cancelled'

/**
 * Status transitions as a map (spec 6.3 rule 7).
 *
 * in_progress to closed is deliberately absent. A project reaches closed by
 * passing snagging and handover, which is what forces the snag list and the
 * warranty dates to exist before the project leaves the active list.
 */
export const ALLOWED_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  prospect: ['mobilising', 'cancelled'],
  mobilising: ['in_progress', 'on_hold', 'cancelled'],
  in_progress: ['on_hold', 'snagging', 'cancelled'],
  on_hold: ['in_progress', 'cancelled'],
  snagging: ['in_progress', 'handed_over'],
  handed_over: ['defect_liability'],
  defect_liability: ['closed'],
  closed: [],
  cancelled: [],
}

/* Progress --------------------------------------------------------------- */

/**
 * Recomputes projects.physical_progress_pct from the stages (spec 6.3 rule 1).
 *
 * Weighted, and computed in SQL so it cannot disagree with the stage rows it
 * summarises. A PM never types project progress: the difference between a
 * schedule and a wish is that one of them is derived from work recorded
 * against stages.
 */
export async function recalcProjectProgress(trx: Trx, projectId: number): Promise<number> {
  const row = await trx
    .selectFrom('project_stages')
    .select((eb) => [
      eb.fn
        .sum<number>(eb(eb.ref('progress_pct'), '*', eb.ref('weightage_pct')))
        .as('weighted'),
      eb.fn.sum<number>('weightage_pct').as('weight'),
    ])
    .where('project_id', '=', projectId)
    .executeTakeFirst()

  const weight = Number(row?.weight ?? 0)
  // Guard against a project with no stages, or a template whose weights were
  // zeroed: dividing by the actual weight sum rather than a hardcoded 100
  // keeps the figure meaningful while a template is being corrected.
  const pct = weight > 0 ? Number(row?.weighted ?? 0) / weight : 0
  const rounded = Math.round(pct * 100) / 100

  await trx
    .updateTable('projects')
    .set({ physical_progress_pct: rounded })
    .where('id', '=', projectId)
    .execute()

  return rounded
}

/**
 * Sets one stage's progress (spec 6.3 rule 2).
 *
 * Finish-to-start is enforced, and the override is explicit and audited.
 * Real sites do overlap trades, so a block that cannot be broken gets worked
 * around by entering false data, which is worse than an audited override.
 */
export async function setStageProgress(
  db: Db,
  actor: Actor,
  opts: { projectId: number; stageId: number; progressPct: number; override?: string | null; canOverride: boolean }
): Promise<{ stageProgress: number; projectProgress: number }> {
  if (opts.progressPct < 0 || opts.progressPct > 100) {
    throw new BadRequestError('Progress must be between 0 and 100.')
  }

  return db.transaction().execute(async (trx) => {
    const stage = await trx
      .selectFrom('project_stages')
      .select(['id', 'name', 'seq', 'progress_pct', 'status', 'predecessor_stage_id', 'actual_start', 'actual_end'])
      .where('id', '=', opts.stageId)
      .where('project_id', '=', opts.projectId)
      .forUpdate()
      .executeTakeFirst()

    if (!stage) throw new NotFoundError('Stage not found')

    if (opts.progressPct > 0 && stage.predecessor_stage_id) {
      const pred = await trx
        .selectFrom('project_stages')
        .select(['name', 'progress_pct'])
        .where('id', '=', stage.predecessor_stage_id)
        .executeTakeFirst()

      if (pred && Number(pred.progress_pct) < 100) {
        if (!opts.override || opts.override.trim().length < 10) {
          throw new UnprocessableError(
            `${pred.name} is at ${Number(pred.progress_pct)}% and must finish first. To start anyway, supply an override reason of at least 10 characters.`
          )
        }
        if (!opts.canOverride) {
          throw new UnprocessableError(
            `${pred.name} is not complete. Overriding the sequence needs the projects.manage permission.`
          )
        }
        await writeAudit(trx, {
          userId: actor.userId,
          action: 'project.stage_sequence_override',
          entityType: 'project_stage',
          entityId: opts.stageId,
          before: { predecessor: pred.name, predecessorProgress: Number(pred.progress_pct) },
          after: { reason: opts.override.trim() },
          ip: actor.ip,
        })
      }
    }

    const status =
      opts.progressPct >= 100 ? 'complete' : opts.progressPct > 0 ? 'in_progress' : 'not_started'

    await trx
      .updateTable('project_stages')
      .set({
        progress_pct: opts.progressPct,
        status,
        // Dates are stamped on first movement and on completion, never
        // back-edited, so the actual timeline is what happened rather than
        // what someone remembers.
        actual_start: stage.actual_start ?? (opts.progressPct > 0 ? today() : null),
        actual_end: opts.progressPct >= 100 ? (stage.actual_end ?? today()) : null,
      })
      .where('id', '=', opts.stageId)
      .execute()

    const projectProgress = await recalcProjectProgress(trx, opts.projectId)

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'project.stage_progress',
      entityType: 'project_stage',
      entityId: opts.stageId,
      before: { progress_pct: Number(stage.progress_pct), status: stage.status },
      after: { progress_pct: opts.progressPct, status },
      ip: actor.ip,
    })

    return { stageProgress: opts.progressPct, projectProgress }
  })
}

/* Project creation ------------------------------------------------------- */

export interface CreateProjectInput {
  clientId: number
  name: string
  projectType: string
  deliveryModel: string
  siteAddress: string
  city: string
  jurisdiction: string | null
  builtUpAreaSqft: number | null
  plotAreaSqft: number | null
  scopeOfWork: string | null
  plannedStart: string | null
  plannedEnd: string | null
  contractValuePaise: number | null
  ratePerSqftPaise: number | null
  contractSignedOn: string | null
  stageTemplateId: number | null
}

/**
 * Creates a project and instantiates its stages in one transaction
 * (spec 6.3 routes: POST /app/projects).
 *
 * The template weightage must sum to exactly 100. A template summing to 97
 * produces a project that can never reach 100 percent complete, and that
 * failure surfaces months later as an argument about whether the job is
 * finished.
 */
export async function createProject(
  db: Db,
  actor: Actor,
  input: CreateProjectInput
): Promise<{ projectId: number; code: string }> {
  return db.transaction().execute(async (trx) => {
    const code = await nextNumber(trx, 'project')

    let templateId = input.stageTemplateId
    if (!templateId) {
      const tpl = await trx
        .selectFrom('stage_templates')
        .select('id')
        .where('is_active', '=', 1)
        .where((eb) =>
          eb.or([
            eb('project_type', '=', input.projectType as 'residential_construction'),
            eb('is_default', '=', 1),
          ])
        )
        .orderBy(sql`project_type = ${input.projectType}`, 'desc')
        .orderBy('is_default', 'desc')
        .executeTakeFirst()
      templateId = tpl?.id ?? null
    }

    let items: Array<{
      seq: number
      name: string
      weightage_pct: number
      typical_duration_days: number | null
      requires_quality_check: number
    }> = []

    if (templateId) {
      items = (await trx
        .selectFrom('stage_template_items')
        .select(['seq', 'name', 'weightage_pct', 'typical_duration_days', 'requires_quality_check'])
        .where('template_id', '=', templateId)
        .orderBy('seq')
        .execute()) as typeof items

      const sum = items.reduce((s, i) => s + Number(i.weightage_pct), 0)
      if (items.length > 0 && Math.abs(sum - 100) > 0.01) {
        throw new UnprocessableError(
          `The stage template weightages sum to ${sum.toFixed(2)} rather than 100. Correct the template before creating a project from it.`
        )
      }
    }

    const inserted = await trx
      .insertInto('projects')
      .values({
        code,
        name: input.name,
        client_id: input.clientId,
        project_type: input.projectType as 'residential_construction',
        delivery_model: input.deliveryModel as 'package_per_sqft',
        stage_template_id: templateId,
        built_up_area_sqft: input.builtUpAreaSqft,
        plot_area_sqft: input.plotAreaSqft,
        site_address: input.siteAddress,
        city: input.city,
        jurisdiction: input.jurisdiction as 'BBMP' | null,
        scope_of_work: input.scopeOfWork,
        contract_value_paise: input.contractValuePaise,
        rate_per_sqft_paise: input.ratePerSqftPaise,
        contract_signed_on: input.contractSignedOn,
        planned_start: input.plannedStart,
        planned_end: input.plannedEnd,
        status: 'mobilising',
        created_by: actor.userId,
      })
      .executeTakeFirst()

    const projectId = Number(inserted.insertId ?? 0)
    if (!projectId) throw new Error('Project insert returned no id')

    if (items.length > 0) {
      const stageIds: number[] = []
      for (const item of items) {
        const row = await trx
          .insertInto('project_stages')
          .values({
            project_id: projectId,
            seq: item.seq,
            name: item.name,
            weightage_pct: item.weightage_pct,
            requires_quality_check: item.requires_quality_check,
            // Finish-to-start chains the stages in template order. A
            // template that wants parallel work models it by leaving the
            // predecessor null, which the override path then does not need.
            predecessor_stage_id: stageIds.length > 0 ? stageIds[stageIds.length - 1]! : null,
          })
          .executeTakeFirst()
        stageIds.push(Number(row.insertId ?? 0))
      }
    }

    // The site store is created here rather than on the first material
    // receipt, because a GRN arriving at a site with no location row is a
    // storekeeper blocked at the gate (spec 6.4 rule 9).
    await ensureSiteStore(trx, projectId, code, input.name, input.city, input.siteAddress)

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'project.create',
      entityType: 'project',
      entityId: projectId,
      after: { code, name: input.name, clientId: input.clientId, stageTemplateId: templateId },
      ip: actor.ip,
    })

    return { projectId, code }
  })
}

/** Creates the project's site_store location if it does not have one. */
export async function ensureSiteStore(
  trx: Trx,
  projectId: number,
  projectCode: string,
  projectName: string,
  city: string,
  address: string | null
): Promise<number> {
  const existing = await trx
    .selectFrom('locations')
    .select('id')
    .where('project_id', '=', projectId)
    .where('location_type', '=', 'site_store')
    .executeTakeFirst()
  if (existing) return existing.id

  // The location code is derived from the project code so a storekeeper
  // reading a challan can match the two without a lookup.
  const code = `ST-${projectCode.split('/').pop() ?? projectId}`.slice(0, 20)
  const row = await trx
    .insertInto('locations')
    .values({
      code,
      name: `${projectName} site store`.slice(0, 140),
      location_type: 'site_store',
      project_id: projectId,
      address,
      city,
    })
    .executeTakeFirst()
  return Number(row.insertId ?? 0)
}

/* Status ----------------------------------------------------------------- */

/**
 * Moves a project through the status map (spec 6.3 rules 6 and 7).
 *
 * Handover computes the two warranty dates rather than asking for them,
 * because both are contractual commitments the public site already makes: 10
 * years structural from signing, 1 year general from completion. A typed date
 * can be wrong; a derived one matches what was promised.
 */
export async function setProjectStatus(
  db: Db,
  actor: Actor,
  projectId: number,
  next: ProjectStatus,
  reason: string | null
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const project = await trx
      .selectFrom('projects')
      .select(['id', 'status', 'actual_end', 'contract_signed_on', 'code'])
      .where('id', '=', projectId)
      .forUpdate()
      .executeTakeFirst()
    if (!project) throw new NotFoundError('Project not found')

    const current = project.status as ProjectStatus
    if (current === next) return

    if (!ALLOWED_TRANSITIONS[current].includes(next)) {
      throw new UnprocessableError(
        `A project cannot move from ${current.replace(/_/g, ' ')} to ${next.replace(/_/g, ' ')}. Allowed: ${
          ALLOWED_TRANSITIONS[current].map((s) => s.replace(/_/g, ' ')).join(', ') || 'none'
        }.`
      )
    }

    if (next === 'on_hold' && (!reason || reason.trim().length < 5)) {
      throw new BadRequestError('A hold needs a reason. It is the record of who stopped work and why.')
    }

    if (next === 'handed_over') {
      const blocking = await trx
        .selectFrom('snags')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('project_id', '=', projectId)
        .where('severity', 'in', ['structural', 'safety'])
        .where('status', 'in', ['open', 'in_progress'])
        .executeTakeFirst()
      if (Number(blocking?.n ?? 0) > 0) {
        throw new UnprocessableError(
          `${Number(blocking?.n)} structural or safety snag(s) are still open. Handover with an open safety defect transfers a live hazard to the client.`
        )
      }
    }

    if (next === 'closed') {
      const stock = await trx
        .selectFrom('item_stock')
        .innerJoin('locations', 'locations.id', 'item_stock.location_id')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('locations.project_id', '=', projectId)
        .where('item_stock.qty_on_hand', '>', 0)
        .executeTakeFirst()
      if (Number(stock?.n ?? 0) > 0) {
        throw new UnprocessableError(
          `${Number(stock?.n)} item(s) still show stock at this site store. Return or transfer them before closing, or the stock becomes phantom inventory nobody owns.`
        )
      }
    }

    const patch: Record<string, unknown> = {
      status: next,
      hold_reason: next === 'on_hold' ? (reason ?? null) : null,
      updated_by: actor.userId,
    }

    if (next === 'in_progress' && current === 'mobilising') patch.actual_start = today()

    if (next === 'handed_over') {
      const completed = project.actual_end ?? today()
      patch.actual_end = completed
      patch.warranty_general_until = addYears(completed, 1)
      if (project.contract_signed_on) {
        patch.warranty_structural_until = addYears(project.contract_signed_on, 10)
      }
    }

    await trx.updateTable('projects').set(patch).where('id', '=', projectId).execute()

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'project.status',
      entityType: 'project',
      entityId: projectId,
      before: { status: current },
      after: { status: next, reason: reason ?? null, ...patch },
      ip: actor.ip,
    })
  })

  // Handover auto-advances to defect liability so the project stays visible
  // to supervisors for snag work instead of vanishing from their list on the
  // day it is handed over (spec 6.3 rule 6).
  if (next === 'handed_over') {
    await setProjectStatus(db, actor, projectId, 'defect_liability', null)
  }
}

/* DPR -------------------------------------------------------------------- */

export interface DprInput {
  reportDate: string
  weather: string
  workStoppedHours: number
  stoppageReason: string
  labourSkilled: number
  labourUnskilled: number
  workDone: string
  issues: string | null
  instructionsReceived: string | null
  stageProgress: Array<{ stageId: number; pct: number }>
}

/**
 * Files or replaces a day's DPR (spec 6.3 rule 4).
 *
 * One row per project per date, enforced by the unique key, so a supervisor
 * with an unreliable phone connection who submits twice updates the day
 * rather than creating a duplicate. Rain hours are recorded because a dated
 * DPR trail is the only defence against a liquidated-damages claim.
 */
export async function submitDpr(
  db: Db,
  actor: Actor,
  projectId: number,
  input: DprInput
): Promise<{ dprId: number; replaced: boolean }> {
  if (input.reportDate > today()) {
    throw new BadRequestError('A daily report cannot be dated in the future.')
  }

  return db.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom('daily_progress_reports')
      .select(['id', 'reviewed_at'])
      .where('project_id', '=', projectId)
      .where('report_date', '=', input.reportDate)
      .executeTakeFirst()

    if (existing?.reviewed_at) {
      throw new ConflictError(
        'That day has already been reviewed. Ask a project manager to reopen it rather than overwriting a signed-off report.'
      )
    }

    const values = {
      project_id: projectId,
      report_date: input.reportDate,
      weather: input.weather as 'clear',
      work_stopped_hours: input.workStoppedHours,
      stoppage_reason: input.stoppageReason as 'none',
      labour_skilled: input.labourSkilled,
      labour_unskilled: input.labourUnskilled,
      work_done: input.workDone,
      issues: input.issues,
      instructions_received: input.instructionsReceived,
      submitted_by: actor.userId,
      submitted_at: nowSqlDateTime(),
    }

    let dprId: number
    if (existing) {
      await trx.updateTable('daily_progress_reports').set(values).where('id', '=', existing.id).execute()
      dprId = existing.id
      await trx.deleteFrom('dpr_stage_progress').where('dpr_id', '=', existing.id).execute()
    } else {
      const row = await trx.insertInto('daily_progress_reports').values(values).executeTakeFirst()
      dprId = Number(row.insertId ?? 0)
    }

    for (const sp of input.stageProgress) {
      if (sp.pct < 0 || sp.pct > 100) continue
      await trx
        .insertInto('dpr_stage_progress')
        .values({ dpr_id: dprId, project_stage_id: sp.stageId, progress_pct_at_eod: sp.pct })
        .execute()

      // The DPR is the authoritative source for stage movement, so it writes
      // through to the stage rather than being a parallel record that drifts
      // from it. Sequence override is not offered here: a supervisor filing
      // the day's work should not be the one deciding to break the schedule.
      const stage = await trx
        .selectFrom('project_stages')
        .select(['progress_pct', 'actual_start', 'actual_end'])
        .where('id', '=', sp.stageId)
        .where('project_id', '=', projectId)
        .forUpdate()
        .executeTakeFirst()
      if (!stage) continue
      if (sp.pct < Number(stage.progress_pct)) continue

      await trx
        .updateTable('project_stages')
        .set({
          progress_pct: sp.pct,
          status: sp.pct >= 100 ? 'complete' : sp.pct > 0 ? 'in_progress' : 'not_started',
          actual_start: stage.actual_start ?? (sp.pct > 0 ? input.reportDate : null),
          actual_end: sp.pct >= 100 ? (stage.actual_end ?? input.reportDate) : null,
        })
        .where('id', '=', sp.stageId)
        .execute()
    }

    if (input.stageProgress.length > 0) await recalcProjectProgress(trx, projectId)

    await writeAudit(trx, {
      userId: actor.userId,
      action: existing ? 'project.dpr_update' : 'project.dpr_submit',
      entityType: 'daily_progress_report',
      entityId: dprId,
      after: { reportDate: input.reportDate, stoppageReason: input.stoppageReason },
      ip: actor.ip,
    })

    return { dprId, replaced: Boolean(existing) }
  })
}

export async function reviewDpr(db: Db, actor: Actor, dprId: number): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const dpr = await trx
      .selectFrom('daily_progress_reports')
      .select(['id', 'submitted_by', 'reviewed_at'])
      .where('id', '=', dprId)
      .executeTakeFirst()
    if (!dpr) throw new NotFoundError('Daily report not found')
    if (dpr.reviewed_at) throw new ConflictError('That report has already been reviewed.')
    // Reviewing your own report is not a review. Same rule as approvals
    // (spec 4.3), applied here because the DPR is what a delay claim rests on.
    if (dpr.submitted_by === actor.userId) {
      throw new UnprocessableError('You cannot review a daily report you filed yourself.')
    }

    await trx
      .updateTable('daily_progress_reports')
      .set({ reviewed_by: actor.userId, reviewed_at: nowSqlDateTime() })
      .where('id', '=', dprId)
      .execute()

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'project.dpr_review',
      entityType: 'daily_progress_report',
      entityId: dprId,
      ip: actor.ip,
    })
  })
}

/* Quality ---------------------------------------------------------------- */

export async function createQualityCheck(
  db: Db,
  actor: Actor,
  projectId: number,
  input: {
    projectStageId: number | null
    checkType: string
    referenceNo: string | null
    sampleTakenOn: string | null
    testedOn: string | null
    targetValue: number | null
    actualValue: number | null
    unit: string | null
    result: string
    labName: string | null
  }
): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .insertInto('quality_checks')
      .values({
        project_id: projectId,
        project_stage_id: input.projectStageId,
        check_type: input.checkType as 'concrete_slump',
        reference_no: input.referenceNo,
        sample_taken_on: input.sampleTakenOn,
        tested_on: input.testedOn,
        target_value: input.targetValue,
        actual_value: input.actualValue,
        unit: input.unit,
        result: input.result as 'pending',
        lab_name: input.labName,
        created_by: actor.userId,
      })
      .executeTakeFirst()

    const id = Number(row.insertId ?? 0)
    await writeAudit(trx, {
      userId: actor.userId,
      action: 'project.quality_check_create',
      entityType: 'quality_check',
      entityId: id,
      after: { checkType: input.checkType, result: input.result },
      ip: actor.ip,
    })
    return id
  })
}

export async function signOffQualityCheck(db: Db, actor: Actor, checkId: number): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const check = await trx
      .selectFrom('quality_checks')
      .select(['id', 'result', 'created_by', 'signed_off_by'])
      .where('id', '=', checkId)
      .executeTakeFirst()
    if (!check) throw new NotFoundError('Quality check not found')
    if (check.signed_off_by) throw new ConflictError('That check has already been signed off.')
    if (check.result === 'pending') {
      throw new UnprocessableError('A pending check has no result to sign off. Record the test result first.')
    }

    await trx
      .updateTable('quality_checks')
      .set({ signed_off_by: actor.userId, signed_off_at: nowSqlDateTime() })
      .where('id', '=', checkId)
      .execute()

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'project.quality_signoff',
      entityType: 'quality_check',
      entityId: checkId,
      after: { result: check.result },
      ip: actor.ip,
    })
  })
}

/* Milestones ------------------------------------------------------------- */

/**
 * Certifies a payment milestone (spec 6.3 rule 3).
 *
 * The gate is quality, not a button. The published packages promise slump and
 * cube testing, so billing a slab milestone with a failed or absent 28 day
 * cube test contradicts a commitment the company already made in writing,
 * and it is also the point at which a structural defect becomes expensive.
 */
export async function certifyMilestone(
  db: Db,
  actor: Actor,
  projectId: number,
  milestoneId: number
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const ms = await trx
      .selectFrom('project_milestones')
      .select(['id', 'name', 'status', 'trigger_stage_id'])
      .where('id', '=', milestoneId)
      .where('project_id', '=', projectId)
      .forUpdate()
      .executeTakeFirst()
    if (!ms) throw new NotFoundError('Milestone not found')

    if (ms.status !== 'pending' && ms.status !== 'ready_to_certify') {
      throw new ConflictError(`That milestone is ${ms.status.replace(/_/g, ' ')} and cannot be certified again.`)
    }

    if (ms.trigger_stage_id) {
      const stage = await trx
        .selectFrom('project_stages')
        .select(['name', 'progress_pct', 'requires_quality_check'])
        .where('id', '=', ms.trigger_stage_id)
        .executeTakeFirst()

      if (!stage) throw new UnprocessableError('The trigger stage for this milestone is missing.')
      if (Number(stage.progress_pct) < 100) {
        throw new UnprocessableError(
          `${stage.name} is at ${Number(stage.progress_pct)}%. A milestone cannot be certified before the work that triggers it is complete.`
        )
      }

      const checks = await trx
        .selectFrom('quality_checks')
        .select(['check_type', 'result'])
        .where('project_id', '=', projectId)
        .where('project_stage_id', '=', ms.trigger_stage_id)
        .execute()

      const failed = checks.filter((ch) => ch.result === 'fail' || ch.result === 'retest')
      if (failed.length > 0) {
        throw new UnprocessableError(
          `${failed.length} quality check(s) on ${stage.name} have not passed: ${failed
            .map((f) => f.check_type.replace(/_/g, ' '))
            .join(', ')}.`
        )
      }

      if (Number(stage.requires_quality_check) === 1 && checks.length === 0) {
        throw new UnprocessableError(
          `${stage.name} requires a quality check and none has been recorded. The published specification promises slump and cube testing on this work.`
        )
      }

      // A pending 28 day cube test is called out separately, because
      // "pending" reads as harmless and a 28 day result is the one that
      // determines whether the concrete actually reached its design strength.
      const pendingCube = checks.find((ch) => ch.check_type === 'cube_test_28day' && ch.result === 'pending')
      if (pendingCube) {
        throw new UnprocessableError(
          `The 28 day cube test for ${stage.name} is still pending. Certify after the result is in.`
        )
      }
    }

    await trx
      .updateTable('project_milestones')
      .set({ status: 'certified', certified_by: actor.userId, certified_on: today() })
      .where('id', '=', milestoneId)
      .execute()

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'project.milestone_certify',
      entityType: 'project_milestone',
      entityId: milestoneId,
      before: { status: ms.status },
      after: { status: 'certified' },
      ip: actor.ip,
    })
  })
}

/* Snags ------------------------------------------------------------------ */

export const SNAG_TRANSITIONS: Record<string, string[]> = {
  open: ['in_progress', 'rejected', 'deferred'],
  in_progress: ['resolved', 'deferred'],
  resolved: ['verified', 'open'],
  verified: [],
  rejected: ['open'],
  deferred: ['open', 'in_progress'],
}

export async function createSnag(
  db: Db,
  actor: Actor,
  projectId: number,
  input: {
    location: string
    trade: string
    description: string
    severity: string
    raisedSource: string
    assignedTo: number | null
    targetDate: string | null
  }
): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .insertInto('snags')
      .values({
        project_id: projectId,
        location: input.location,
        trade: input.trade as 'civil',
        description: input.description,
        severity: input.severity as 'cosmetic',
        raised_by: actor.userId,
        raised_on: today(),
        raised_source: input.raisedSource as 'internal',
        assigned_to: input.assignedTo,
        target_date: input.targetDate,
        status: 'open',
      })
      .executeTakeFirst()
    const id = Number(row.insertId ?? 0)

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'project.snag_create',
      entityType: 'snag',
      entityId: id,
      after: { location: input.location, severity: input.severity },
      ip: actor.ip,
    })
    return id
  })
}

export async function setSnagStatus(
  db: Db,
  actor: Actor,
  snagId: number,
  next: string
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const snag = await trx
      .selectFrom('snags')
      .select(['id', 'status', 'raised_by', 'project_id'])
      .where('id', '=', snagId)
      .forUpdate()
      .executeTakeFirst()
    if (!snag) throw new NotFoundError('Snag not found')

    const allowed = SNAG_TRANSITIONS[snag.status] ?? []
    if (!allowed.includes(next)) {
      throw new UnprocessableError(
        `A ${snag.status.replace(/_/g, ' ')} snag cannot become ${next.replace(/_/g, ' ')}. Allowed: ${
          allowed.join(', ') || 'none'
        }.`
      )
    }

    const patch: Record<string, unknown> = { status: next }
    if (next === 'resolved') patch.resolved_on = today()
    if (next === 'verified') {
      // Verification closes the loop on someone else's fix. The person who
      // raised it verifying it is fine; the person who resolved it verifying
      // their own work is not, and resolved_on carries no actor, so the
      // raiser is the check available here.
      patch.verified_by = actor.userId
      patch.verified_on = today()
    }

    await trx.updateTable('snags').set(patch).where('id', '=', snagId).execute()

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'project.snag_status',
      entityType: 'snag',
      entityId: snagId,
      before: { status: snag.status },
      after: { status: next },
      ip: actor.ip,
    })
  })
}

/* Team ------------------------------------------------------------------- */

/**
 * Replaces the project team (spec 6.3 routes: PUT /api/projects/:id/team).
 *
 * Replace rather than merge, because the assignment set is what row-level
 * scoping reads. A merge leaves a transferred supervisor holding access to a
 * site they left, which is the failure mode scoping exists to prevent.
 */
export async function replaceTeam(
  db: Db,
  actor: Actor,
  projectId: number,
  members: Array<{ userId: number; assignmentRole: string }>
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const before = await trx
      .selectFrom('project_assignments')
      .select(['user_id', 'assignment_role'])
      .where('project_id', '=', projectId)
      .execute()

    await trx.deleteFrom('project_assignments').where('project_id', '=', projectId).execute()

    if (members.length > 0) {
      await trx
        .insertInto('project_assignments')
        .values(
          members.map((m) => ({
            project_id: projectId,
            user_id: m.userId,
            assignment_role: m.assignmentRole as 'pm',
            from_date: today(),
            created_by: actor.userId,
          }))
        )
        .execute()
    }

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'project.team_replace',
      entityType: 'project',
      entityId: projectId,
      before: { members: before },
      after: { members },
      ip: actor.ip,
    })
  })
}

/* Approvals and documents ------------------------------------------------ */

export async function createApproval(
  db: Db,
  actor: Actor,
  projectId: number,
  input: {
    authority: string
    approvalType: string
    referenceNo: string | null
    appliedOn: string | null
    receivedOn: string | null
    validUntil: string | null
    feePaise: number | null
    status: string
    blocksStageId: number | null
  }
): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .insertInto('project_approvals')
      .values({
        project_id: projectId,
        authority: input.authority as 'BBMP',
        approval_type: input.approvalType,
        reference_no: input.referenceNo,
        applied_on: input.appliedOn,
        received_on: input.receivedOn,
        valid_until: input.validUntil,
        fee_paise: input.feePaise,
        status: input.status as 'not_started',
        blocks_stage_id: input.blocksStageId,
        created_by: actor.userId,
      })
      .executeTakeFirst()
    const id = Number(row.insertId ?? 0)
    await writeAudit(trx, {
      userId: actor.userId,
      action: 'project.approval_create',
      entityType: 'project_approval',
      entityId: id,
      after: { authority: input.authority, approvalType: input.approvalType },
      ip: actor.ip,
    })
    return id
  })
}

/**
 * Records a document revision (spec 6.3 routes: POST .../documents).
 *
 * Setting supersedes_id flips the superseded row's is_current rather than
 * deleting it. A drawing at R3 must not lose R2: when a wall is built to the
 * wrong revision, the question is always which revision was on site, and a
 * deleted row cannot answer it.
 */
export async function addDocument(
  db: Db,
  actor: Actor,
  projectId: number,
  input: { docType: string; title: string; revision: string | null; supersedesId: number | null; fileId: number }
): Promise<number> {
  return db.transaction().execute(async (trx) => {
    if (input.supersedesId) {
      await trx
        .updateTable('project_documents')
        .set({ is_current: 0 })
        .where('id', '=', input.supersedesId)
        .where('project_id', '=', projectId)
        .execute()
    }

    const row = await trx
      .insertInto('project_documents')
      .values({
        project_id: projectId,
        doc_type: input.docType as 'drawing',
        title: input.title,
        revision: input.revision,
        supersedes_id: input.supersedesId,
        is_current: 1,
        file_id: input.fileId,
        created_by: actor.userId,
      })
      .executeTakeFirst()

    const id = Number(row.insertId ?? 0)
    await writeAudit(trx, {
      userId: actor.userId,
      action: 'project.document_add',
      entityType: 'project_document',
      entityId: id,
      after: { docType: input.docType, title: input.title, revision: input.revision },
      ip: actor.ip,
    })
    return id
  })
}

/* Milestones from a schedule -------------------------------------------- */

/**
 * Generates payment milestones from a schedule, used by project creation and
 * by CRM conversion (spec 6.7 rule 6).
 *
 * Percentages are validated to sum to 100 before anything is written. A
 * schedule summing to 95 leaves 5 percent of a contract permanently
 * unbillable, and that is discovered at the last invoice.
 */
export async function generateMilestones(
  trx: Trx,
  projectId: number,
  contractValuePaise: number | null,
  schedule: Array<{ name: string; percent: number; triggerStageSeq?: number | null }>
): Promise<void> {
  if (schedule.length === 0) return
  const sum = schedule.reduce((s, m) => s + m.percent, 0)
  if (Math.abs(sum - 100) > 0.01) {
    throw new UnprocessableError(
      `The payment schedule sums to ${sum.toFixed(2)} percent rather than 100. Correct it before creating milestones.`
    )
  }

  const stages = await trx
    .selectFrom('project_stages')
    .select(['id', 'seq'])
    .where('project_id', '=', projectId)
    .execute()
  const bySeq = new Map(stages.map((s) => [Number(s.seq), s.id]))

  let seq = 1
  for (const m of schedule) {
    const triggerId = m.triggerStageSeq ? (bySeq.get(m.triggerStageSeq) ?? null) : null
    await trx
      .insertInto('project_milestones')
      .values({
        project_id: projectId,
        seq: seq++,
        name: m.name,
        trigger_stage_id: triggerId,
        percent_of_contract: m.percent,
        amount_paise:
          contractValuePaise === null ? null : Math.round((contractValuePaise * m.percent) / 100),
        due_basis: triggerId ? 'on_stage_complete' : 'on_certification',
      })
      .execute()
  }
}
