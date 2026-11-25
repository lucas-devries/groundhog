import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Versuche pro Ticket, wenn die Projekt-Konfiguration nichts anderes sagt. */
export const VERSUCHE_STANDARD = 3

/** Die Projekt-Konfiguration, `groundhog.json` im Repo-Root. */
export interface Konfiguration {
  checks: string[]
  attempts: number
  targetBranches: string[]
  sandbox: { hosts: string[]; off: boolean }
}

export type Gelesen =
  | { ok: true; konfiguration: Konfiguration }
  | { ok: false; fehlt: boolean; fehler: string[] }

export const DATEI = 'groundhog.json'

/** Liest und prüft die Projekt-Konfiguration; bei einer ungültigen Datei alle Fehler auf einmal. */
export function leseKonfiguration(verzeichnis: string): Gelesen {
  const pfad = join(verzeichnis, DATEI)
  if (!existsSync(pfad)) {
    return {
      ok: false,
      fehlt: true,
      fehler: [`${DATEI} fehlt. Lege sie mit \`groundhog init\` an.`],
    }
  }
  let roh: unknown
  try {
    roh = JSON.parse(readFileSync(pfad, 'utf8'))
  } catch (e) {
    return {
      ok: false,
      fehlt: false,
      fehler: [`${DATEI} ist kein gültiges JSON: ${(e as Error).message}`],
    }
  }
  if (!istObjekt(roh)) {
    return { ok: false, fehlt: false, fehler: [`${DATEI} muss ein JSON-Objekt sein`] }
  }

  const fehler: string[] = []
  const liste = (name: string, wert: unknown, pflicht: boolean): string[] => {
    if (wert === undefined) {
      if (pflicht) fehler.push(`${name} fehlt`)
      return []
    }
    if (!Array.isArray(wert) || !wert.every((s) => typeof s === 'string')) {
      fehler.push(`${name}: Liste von Strings erwartet`)
      return []
    }
    if (pflicht && wert.length === 0) fehler.push(`${name}: mindestens ein Eintrag nötig`)
    return wert
  }

  const checks = liste('checks', roh.checks, true)
  const attempts = roh.attempts ?? VERSUCHE_STANDARD
  if (!Number.isInteger(attempts) || (attempts as number) < 1 || (attempts as number) > 10) {
    fehler.push('attempts: ganze Zahl von 1 bis 10 erwartet')
  }
  const targetBranches = liste('targetBranches', roh.targetBranches, true)
  let sandbox: Record<string, unknown> = {}
  if (roh.sandbox !== undefined) {
    if (istObjekt(roh.sandbox)) sandbox = roh.sandbox
    else fehler.push('sandbox: Objekt erwartet')
  }
  const hosts = liste('sandbox.hosts', sandbox.hosts, false)
  const off = sandbox.off ?? false
  if (typeof off !== 'boolean') fehler.push('sandbox.off: true oder false erwartet')

  for (const k of unbekannt(roh, ['checks', 'attempts', 'targetBranches', 'sandbox'])) {
    fehler.push(`unbekannter Schlüssel: ${k}`)
  }
  for (const k of unbekannt(sandbox, ['hosts', 'off'])) {
    fehler.push(`unbekannter Schlüssel: sandbox.${k}`)
  }

  if (fehler.length > 0) return { ok: false, fehlt: false, fehler }
  return {
    ok: true,
    konfiguration: {
      checks,
      attempts: attempts as number,
      targetBranches,
      sandbox: { hosts, off: off as boolean },
    },
  }
}

function istObjekt(wert: unknown): wert is Record<string, unknown> {
  return typeof wert === 'object' && wert !== null && !Array.isArray(wert)
}

function unbekannt(objekt: Record<string, unknown>, bekannt: string[]): string[] {
  return Object.keys(objekt).filter((k) => !bekannt.includes(k))
}
