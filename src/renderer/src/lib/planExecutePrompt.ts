/**
 * planExecutePrompt.ts
 *
 * The prompt injected into a CLI agent pane when the user dispatches an
 * approved plan for execution from the plan window. Kept in a shared lib so
 * the main-window dispatch handler and tests reference one source of truth.
 */

/**
 * Build the execution prompt for a plan document.
 * @param planRelPath workspace-relative path of the plan HTML file
 *                    (e.g. `.agent-team/plans/my-plan_a1b2c3.html`)
 */
export function planExecutionPrompt(planRelPath: string): string {
  return (
    `Execute the approved plan document at ${planRelPath} (workspace-relative path). ` +
    `Read the plan first, then implement it by its todos phase by phase. ` +
    `Update the plan-meta todo status (and the matching visible markup) as you complete each phase. ` +
    `Set the plan-meta stage to "done" when all todos are complete.`
  )
}
