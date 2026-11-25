export interface Ticket {
  nummer: number
  offen: boolean
  labels: string[]
  assignees: string[]
  /** Alle Blocker, auch solche außerhalb der Spec, mit ihrem Zustand. */
  blocker: Blocker[]
}

export interface Blocker {
  nummer: number
  offen: boolean
}

/** Der Tracker in der Form, die die Engine braucht. Dahinter: GitHub-Adapter (#32), In-Memory-Tracker. */
export interface Tracker {
  /** Der angemeldete Nutzer, auf den die Engine beansprucht. */
  readonly nutzer: string
  taskGraph(spec: number): Promise<Ticket[]>
  beanspruche(ticket: number): Promise<void>
  /** Schließt ein Ticket oder die Spec. */
  schliesse(issue: number): Promise<void>
  kommentiere(issue: number, text: string): Promise<void>
  /** Legt einen PR an und liefert seine URL. */
  erstellePr(pr: Pr): Promise<string>
}

export interface Pr {
  /** Branch mit der Arbeit. */
  kopf: string
  /** Branch, in den der PR mergt. */
  basis: string
  titel: string
  body: string
}

/** Tracker im Speicher für Tests. `nutzer` spielt den angemeldeten `gh`-Nutzer. */
export class InMemoryTracker implements Tracker {
  readonly #tickets: Ticket[]
  /** Geschlossene Issues außerhalb der Tickets, etwa die Spec. */
  readonly #geschlossen = new Set<number>()
  readonly #kommentare = new Map<number, string[]>()
  /** Angelegte PRs in Reihenfolge. */
  readonly prs: Pr[] = []

  constructor(
    readonly nutzer: string,
    tickets: Ticket[],
  ) {
    this.#tickets = structuredClone(tickets)
  }

  /** Stand eines Tickets, als Kopie. */
  ticket(nummer: number): Ticket {
    return structuredClone(this.#finde(nummer))
  }

  /** Ob ein Ticket oder ein anderes Issue (etwa die Spec) offen ist. */
  offen(nummer: number): boolean {
    return this.#tickets.find((t) => t.nummer === nummer)?.offen ?? !this.#geschlossen.has(nummer)
  }

  kommentare(nummer: number): string[] {
    return [...(this.#kommentare.get(nummer) ?? [])]
  }

  /** Ändert ein Ticket von außen, wie ein Mensch im Tracker während des Laufs. */
  aendere(nummer: number, aenderung: (ticket: Ticket) => void) {
    aenderung(this.#finde(nummer))
  }

  /** Blocker aus der Spec tragen den Zustand ihres Tickets; die übrigen den mitgegebenen. */
  async taskGraph(): Promise<Ticket[]> {
    return structuredClone(this.#tickets).map((t) => ({
      ...t,
      blocker: t.blocker.map((b) => ({
        nummer: b.nummer,
        offen: this.#tickets.find((s) => s.nummer === b.nummer)?.offen ?? b.offen,
      })),
    }))
  }

  async beanspruche(nummer: number) {
    const ticket = this.#finde(nummer)
    if (!ticket.assignees.includes(this.nutzer)) ticket.assignees.push(this.nutzer)
  }

  async schliesse(nummer: number) {
    const ticket = this.#tickets.find((t) => t.nummer === nummer)
    if (ticket) ticket.offen = false
    else this.#geschlossen.add(nummer)
  }

  async kommentiere(nummer: number, text: string) {
    this.#kommentare.set(nummer, [...this.kommentare(nummer), text])
  }

  async erstellePr(pr: Pr) {
    this.prs.push(pr)
    return `https://github.example/pull/${this.prs.length}`
  }

  #finde(nummer: number): Ticket {
    const ticket = this.#tickets.find((t) => t.nummer === nummer)
    if (!ticket) throw new Error(`Ticket #${nummer} gibt es nicht`)
    return ticket
  }
}
