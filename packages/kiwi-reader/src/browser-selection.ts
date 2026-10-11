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
    .max(100),
  complete: z.boolean(),
});

export type BrowserSelection = z.infer<typeof BrowserSelectionSchema>;
