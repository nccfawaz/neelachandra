import { z } from 'zod'

/**
 * Site page content schemas (§7 / spec :1497).
 *
 * `content_json` block types are a closed union validated by Zod on save:
 * `hero`, `richtext`, `feature_grid`, `stat_row`, `process_steps`,
 * `package_table`, `showcase_grid`, `faq_accordion`, `cta_band`,
 * `testimonial_row`, `team_grid`, `image`, `table`, `raw_html`. The per-block
 * payload shapes beyond `type` are deliberately loose here — §7's block
 * components (src/public/components/blocks/) do not exist yet, and inventing
 * payload fields now would be a guess about what they need. What the schema
 * enforces is the closed type union, which is what the spec names.
 */

export const CONTENT_BLOCK_TYPES = [
  'hero',
  'richtext',
  'feature_grid',
  'stat_row',
  'process_steps',
  'package_table',
  'showcase_grid',
  'faq_accordion',
  'cta_band',
  'testimonial_row',
  'team_grid',
  'image',
  'table',
  'raw_html',
] as const

const blockSchema = z
  .object({
    type: z.enum(CONTENT_BLOCK_TYPES),
  })
  .passthrough()

export const contentJsonSchema = z.object({
  blocks: z.array(blockSchema),
})

export type ContentJson = z.infer<typeof contentJsonSchema>

export const pageEditSchema = z.object({
  title: z.string().trim().min(1).max(200),
  metaDescription: z.string().trim().max(320).optional(),
  schemaTypes: z.array(z.string().trim().min(1)).min(1, 'A page needs at least one schema type'),
  contentJson: contentJsonSchema,
  changeNote: z.string().trim().max(255).optional(),
})

export type PageEditInput = z.infer<typeof pageEditSchema>
