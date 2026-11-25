export interface Ticket {
  nummer: number
  offen: boolean
  assignees: string[]
}

/** Der Tracker in der Form, die die Engine braucht. Dahinter: GitHub-Adapter (#32), In-Memory-Tracker. */
export interface Tracker {
  taskGraph(spec: number): Promise<Ticket[]>
  beanspruche(ticket: number): Promise<void>
  schliesse(ticket: number): Promise<void>
}

/** Tracker im Speicher für Tests. `nutzer` spielt den angemeldeten `gh`-Nutzer. */
export class InMemoryTracker implements Tracker {
  readonly #tickets: Ticket[]

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

  async taskGraph(): Promise<Ticket[]> {
    return structuredClone(this.#tickets)
  }

  async beanspruche(nummer: number) {
    const ticket = this.#finde(nummer)
    if (!ticket.assignees.includes(this.nutzer)) ticket.assignees.push(this.nutzer)
  }

  async schliesse(nummer: number) {
    this.#finde(nummer).offen = false
  }

  #finde(nummer: number): Ticket {
    const ticket = this.#tickets.find((t) => t.nummer === nummer)
    if (!ticket) throw new Error(`Ticket #${nummer} gibt es nicht`)
    return ticket
  }
}
