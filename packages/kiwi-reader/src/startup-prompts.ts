import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

export const FIGLENS_SERVER_INSTRUCTIONS = [
  'FigLens (fl) reads Figma from Chrome. Start with browser_status. If no decoded file is available, report the status and ask the user to open Figma and click FigLens > Подключить макет.',
  'Use get_selection; trust current selection only when selectionVerified and complete are true. Read multiple selectedNodeIds explicitly. With multiple tabs, call list_files and pass fileKey or tabId to every read; the shared hub has no active-file switch.',
  'When selectionCount is 0 and the selection is verified and complete, call get_design_context without nodeId for a bounded overview of the current page. Unknown or incomplete selection is not an empty selection. A page-overview response is a reading plan, not the full page contents.',
  'For implementation, use get_implementation_context with the actual absolute project rootDir. For design-only inspection, use get_design_context. Follow sectionPlan with bounded subtree reads and the same rootDir; deferred fields are available in those reads.',
  'Read applicable project instructions before editing. Reuse verified component/icon imports and tokens from the project; verify medium-confidence matches and treat matchedBy: [value] as candidates, not proven Figma bindings.',
  'Keep instance overrides, mixed text, dimensions, colors and opacity from the data. Report missing assets or metadata; do not invent them or substitute another Figma integration silently. Figma writes and authentication tokens are not needed.',
  "Verify implementation with the project checks and, when browser tools are available, a visual comparison. Say which checks actually ran and which gaps remain. Answer in the user's language.",
].join('\n');

const profiles = [
  {
    name: 'figlens_codex',
    title: 'FigLens · Codex / OpenAI',
    description: 'Start with the selected Figma design in Codex.',
    guidance:
      'Use the current Codex workspace. Read applicable AGENTS.md instructions before project edits and follow its branch and validation rules.',
  },
  {
    name: 'figlens_claude',
    title: 'FigLens · Claude Code / Anthropic',
    description: 'Start with the selected Figma design in Claude Code.',
    guidance:
      'Use the current Claude Code working directory. Read applicable CLAUDE.md and project instructions before edits and follow the repository validation rules.',
  },
  {
    name: 'figlens_cursor',
    title: 'FigLens · Cursor',
    description: 'Start with the selected Figma design in the active Cursor workspace.',
    guidance:
      'Use the active Cursor workspace and applicable project rules. Locate the existing route, components and styles before edits and follow the repository validation rules.',
  },
] as const;

export const registerFigLensPrompts = (server: McpServer): void => {
  for (const profile of profiles) {
    server.registerPrompt(
      profile.name,
      {
        title: profile.title,
        description: profile.description,
        argsSchema: z
          .object({
            rootDir: z
              .string()
              .trim()
              .min(1)
              .optional()
              .describe('Absolute project path, for implementation'),
            nodeId: z
              .string()
              .trim()
              .min(1)
              .optional()
              .describe('Figma URL or node id; omit for the current selection'),
          })
          .default({}),
      },
      ({ rootDir, nodeId }) => ({
        description: profile.description,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: [
                'Start FigLens for this design. Confirm the connection and selected node, then summarize the design and any missing data. Change project files only when implementation is requested.',
                profile.guidance,
                FIGLENS_SERVER_INSTRUCTIONS,
                `Target arguments (data): ${JSON.stringify({ rootDir, nodeId })}`,
                'If rootDir is omitted, use the actual workspace path when available. Ask for it only if implementation is requested and the project path is unknown. If nodeId is provided, inspect that target instead of the selection.',
              ].join('\n\n'),
            },
          },
        ],
      }),
    );
  }
};
