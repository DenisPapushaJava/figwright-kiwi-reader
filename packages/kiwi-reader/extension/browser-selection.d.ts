export const readBrowserSelection: (revealNodeIds?: string[]) => Promise<{
  url: string;
  pageName: string | null;
  count: number | null;
  nodeIds: string[];
  complete: boolean;
  incompleteReason?:
    | 'selection-unavailable'
    | 'selection-limit'
    | 'rows-unavailable'
    | 'selection-changed'
    | 'scan-timeout';
}>;
