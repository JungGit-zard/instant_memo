---
name: surprise-dungeon-skill
description: Extend a limited-time in-game dungeon Excel workbook by copying the most recent dungeon-cycle block and appending the next cycle directly beneath it across all 3 tabs. Use when the user attaches or references a dungeon-setting Excel file and asks to apply the surprise dungeon workflow, or when the user says 깜던스킬, 깜짝던전스킬, or surprise_dungeon_skill. Always announce that you are using 깜던스킬 before editing the workbook.
---

# Surprise Dungeon Skill

Always begin with this exact notice in Korean before working:

`깜던스킬을 사용합니다.`

## Core context

- The workbook contains setting data for a limited-time in-game dungeon.
- The first column on the far left is the `code` column.
- A dungeon cycle is identified by the full `code` value.
- Rows with exactly the same `code` belong to the same dungeon cycle.
- The workbook has 3 tabs, and all 3 must be updated.

## Required behavior

1. Read the workbook structure first and identify the last real dungeon cycle in each tab.
2. Find the final contiguous block of rows whose `code` matches the most recent dungeon cycle.
3. Copy that entire block and insert it immediately below the final dungeon row of that tab.
4. Rename the copied block to the next cycle code.
5. Preserve the final sentinel row and the final sentinel column layout exactly as the workbook already uses.
6. Never remove the trailing sentinel row or trailing sentinel column structure.
7. Update all 3 tabs before finishing.

## Next cycle rule

- Derive the next cycle code from the most recent `code`.
- Increase only the last numeric suffix.
- Preserve the original zero-padding width.

Example:

- `code_twisted_260410_20` -> `code_twisted_260410_21`
- `code_twisted_260410_009` -> `code_twisted_260410_010`

## Example operation

If `code_twisted_260410_20` appears in 3 rows in a tab:

1. Copy those 3 rows.
2. Paste them immediately under the last row of `code_twisted_260410_20`.
3. Change the copied rows' `code` to `code_twisted_260410_21`.
4. Keep the final sentinel row/column structure below them.

## Sentinel rule

- The user may describe the final row/column as `_`.
- In practice, preserve whatever sentinel marker the workbook already uses at the end.
- Do not normalize or redesign the workbook ending structure.
- The workbook's existing end-marker pattern is the source of truth.

## Workbook workflow

1. Inspect the workbook and list all sheet names.
2. Confirm there are 3 target tabs.
3. For each tab:
   - locate the last non-sentinel data row
   - read the `code` in column A
   - count the full block belonging to that same `code`
   - duplicate only that block
   - insert the duplicate above the trailing sentinel row
   - update column A in the duplicated block to the next cycle code
4. Save the workbook without breaking the original Excel structure.
5. If editing the original file in place, create a backup first when feasible.

## Validation checklist

Before finishing, verify all of the following:

- Every one of the 3 tabs was updated.
- The new code is exactly one cycle after the previous last code.
- The number of inserted rows matches the previous final cycle block size for that tab.
- The copied rows were inserted directly above the final sentinel row.
- The final sentinel row still exists.
- The final sentinel column structure still exists.

## Output format

Report briefly in Korean:

- that 깜던스킬 was used
- the source workbook path
- the new cycle code that was added
- how many rows were added per tab
- whether a backup file was created

## Execution notes

- Prefer deterministic workbook editing over manual spreadsheet UI operations.
- If Python is unavailable, use another reliable local method that preserves `.xlsx` structure.
- Do not skip any tab even if only one tab seems to need multiple rows.
