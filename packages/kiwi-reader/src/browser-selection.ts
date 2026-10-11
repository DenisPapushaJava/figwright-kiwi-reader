import { z } from 'zod';

export const BrowserSelectionSchema = z.object({
  url: z.string().max(16_384),
  pageName: z.string().min(1).max(2_000).nullable().optional(),
  count: z.number().int().min(0).max(1_000_000).nullable(),
  nodeIds: z
    .array(
      z
        .string()
        .max(2_000)
        .regex(/^(?:I)?\d+:\d+(?:;\d+:\d+)*$/),
    )
    .max(10_000)
    .refine(ids => ids.reduce((sum, id) => sum + id.length, 0) <= 200_000),
  complete: z.boolean(),
  incompleteReason: z
    .enum([
      'selection-unavailable',
      'selection-limit',
      'rows-unavailable',
      'selection-changed',
      'scan-timeout',
    ])
    .optional(),
});

export type BrowserSelection = z.infer<typeof BrowserSelectionSchema>;
