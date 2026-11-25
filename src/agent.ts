import type { Ticket } from './tracker.ts'

export interface RunAuftrag {
  ticket: Ticket
  /** Repo-Root, auf dem Ticket-Branch ausgecheckt. */
  verzeichnis: string
  /** SHA am Abzweig des Ticket-Branch. */
  fixpunkt: string
  /** Ab dem zweiten Versuch: warum der letzte rot war, mit der Check-Ausgabe. */
  rueckmeldung?: string
  /** Nimmt jede Zeile der rohen Ausgabe des Runs entgegen (bei Claude: `stream-json`). */
  ausgabe: (zeile: string) => void
}

export interface RunErgebnis {
  erfolg: boolean
  /** Tokens des Runs, wie `claude` sie meldet (`usage`). */
  tokens?: Record<string, number>
  kostenUsd?: number
  /** Für `claude --resume` in Übersicht und Kommentar. */
  sessionId?: string
  blocks?: Block[]
}

/** Ein Aufruf des Agents, der verweigert und nicht ausgeführt wurde. */
export interface Block {
  tool: string
  befehl: string
}

/** Der Agent: startet einen Run an einem Ticket. Dahinter: Claude-Adapter (#33), Fake-Agent. */
export interface Agent {
  run(auftrag: RunAuftrag): Promise<RunErgebnis>
}

/** Ein Schritt im Skript des Fake-Agents: was ein Run tut und wie er endet. */
export type AgentSkript = (auftrag: RunAuftrag) => RunErgebnis | Promise<RunErgebnis>

/** Geskripteter Fake-Agent: jeder Run spielt den nächsten Schritt des Skripts ab. */
export function fakeAgent(skript: AgentSkript[]): Agent {
  let runs = 0
  return {
    async run(auftrag) {
      const schritt = skript[runs++]
      if (!schritt) throw new Error(`Fake-Agent: kein Skript für Run ${runs}`)
      return schritt(auftrag)
    },
  }
}
