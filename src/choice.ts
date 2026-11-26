/** What a human chooses before a run, and the branch names of a run. */
export interface Choice {
  targetBranch: string
  finish: 'merge' | 'pr' | 'none'
}

/** The name of each finish, as menu and display show it. */
export const FINISH: Record<Choice['finish'], string> = {
  merge: 'Merge',
  pr: 'PR',
  none: 'None',
}

/** The integration branch of a spec. */
export function integrationBranch(spec: number): string {
  return `spec/${spec}`
}

/** The branch the work on a ticket happens on. */
export function ticketBranchOf(ticket: number): string {
  return `ticket/${ticket}`
}
