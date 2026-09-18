---
name: figma-browser-reader
description: Read the current Figma browser selection or a node from a Figma design URL through the local read-only Figwright Kiwi Reader. Use when the user mentions @fk, asks to read or inspect a selected Figma frame, requests design context from a Figma URL, or wants browser Figma data for implementation. Do not use this skill to edit Figma.
---

# Figma browser reader

Use the `fk` MCP tools to read design data captured by the local Chrome extension. This route is
strictly read-only and does not use Figma REST API tokens, OAuth, or the Figma Plugin API.

1. Call `browser_status` before reading. If the extension is not connected or no file has been
   decoded, report the exact status and ask the user to start capture from the FK extension.
2. Use `get_selection` for the current selection and `get_design_context` for implementation or a
   Figma URL. Use `list_files` and `use_file` when several decoded tabs make the target ambiguous.
3. Keep reads bounded. Follow `sectionPlan` and truncation metadata by requesting smaller subtrees.
4. Preserve node IDs and report unavailable assets, variables, fonts or component metadata.

Never request Figma cookies, authentication tokens, a personal access token or edit permission.
Never substitute another Figma integration silently when the local reader is unavailable.
