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
  schliesse(ticket: number): Promise<void>
  /** Nimmt den eigenen Assignee wieder vom Ticket. */
  gibFrei(ticket: number): Promise<void>
  /** Öffnet das Ticket wieder; ist es offen, geschieht nichts. */
  oeffneWieder(ticket: number): Promise<void>
  /** Tauscht `ready-for-agent` gegen `ready-for-human`. */
  markiereGescheitert(ticket: number): Promise<void>
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
    this.#finde(nummer).offen = false
  }

  async gibFrei(nummer: number) {
    const ticket = this.#finde(nummer)
    ticket.assignees = ticket.assignees.filter((a) => a !== this.nutzer)
  }

  async oeffneWieder(nummer: number) {
    this.#finde(nummer).offen = true
  }

  async markiereGescheitert(nummer: number) {
    const ticket = this.#finde(nummer)
    ticket.labels = [...ticket.labels.filter((l) => l !== 'ready-for-agent'), 'ready-for-human']
  }

  #finde(nummer: number): Ticket {
    const ticket = this.#tickets.find((t) => t.nummer === nummer)
    if (!ticket) throw new Error(`Ticket #${nummer} gibt es nicht`)
    return ticket
  }
}
