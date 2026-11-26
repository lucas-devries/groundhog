/** What a human chooses before a run, and the names that follow from it. */
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
