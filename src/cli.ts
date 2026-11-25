#!/usr/bin/env node
import * as p from '@clack/prompts'
import { abbruchWaechter } from './abbruch.ts'
import { anzeige } from './anzeige.ts'
import { claudeAgent } from './claude.ts'
import { type Ereignis, fahreLauf } from './engine.ts'
import { herdr } from './herdr.ts'
import { init } from './init.ts'
import { oeffneProtokoll } from './protokoll.ts'
import { durchreiche } from './sandbox.ts'
import { starte } from './start.ts'
import { zeigeTafel } from './tafel.ts'
import { systemUhr } from './uhr.ts'
import { aktualisiere, installiere, neuereVersion, VERSION } from './update.ts'

const HILFE = `groundhog ${VERSION}: arbeitet die Tickets einer Spec ab, ohne Menschen.

Befehle:
  groundhog <spec>     Lauf über die Tickets der Spec mit dieser Issue-Nummer
  groundhog init       Projekt-Konfiguration groundhog.json anlegen oder ändern
  groundhog update     neueste Version installieren
  groundhog --version  Version zeigen
  groundhog --help     diese Hilfe

Exit-Codes eines Laufs:
  0    regulär beendet, kein Ticket gescheitert
  1    Start abgebrochen, Lauf mit Fehler abgebrochen oder ohne Guthaben angehalten
  2    regulär beendet, mindestens ein Ticket endgültig gescheitert (ready-for-human)
  130  mit Strg+C abgebrochen`

const args = process.argv.slice(2)
const [befehl] = args
if (args.length === 1 && befehl === 'init') {
  p.intro('groundhog init')
  const { exitCode, meldung } = await init({
    verzeichnis: process.cwd(),
    dialog: { ...p, info: p.log.info },
    istTerminal: process.stdin.isTTY === true,
  })
  if (exitCode === 0) p.outro(meldung)
  else p.cancel(meldung)
  process.exitCode = exitCode
} else if (args.length === 1 && befehl === 'update') {
  const { exitCode, meldung } = aktualisiere()
  if (exitCode === 0) console.log(meldung)
  else console.error(`groundhog: ${meldung}`)
  process.exitCode = exitCode
} else if (args.length === 1 && befehl === '--version') {
  console.log(VERSION)
} else if (args.length === 1 && befehl === '--help') {
  console.log(HILFE)
} else if (args.length === 1 && befehl && /^[1-9]\d*$/.test(befehl)) {
  process.exitCode = await lauf(Number(befehl))
} else {
  console.error(`groundhog: unbekannter Aufruf. Siehe groundhog --help.`)
  process.exitCode = 1
}

async function lauf(spec: number): Promise<number> {
  p.intro(`groundhog ${VERSION}`)
  const start = await starte({
    verzeichnis: process.cwd(),
    spec,
    dialog: { ...p, warn: p.log.warn },
    istTerminal: process.stdin.isTTY === true,
    update: { neuereVersion, installiere },
  })
  if (!start.ok) {
    if (start.exitCode === 0) p.outro(start.meldung)
    else p.cancel(start.meldung)
    return start.exitCode
  }
  /** Verlässt die Tafel, damit eine Fehlermeldung im normalen Bildschirm stehen bleibt. */
  let schliesse = () => {}
  const signale = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
  let empfange = (_: NodeJS.Signals) => {}
  try {
    const { verzeichnis, konfiguration, token } = start
    let zeige: (e: Ereignis) => void = () => {}
    const herdrMeldung = herdr(process.env, process.stdout.isTTY === true)
    const protokoll = oeffneProtokoll({
      verzeichnis,
      spec,
      start: systemUhr.jetzt(),
      weiter: (e) => {
        zeige(e)
        process.stdout.write(herdrMeldung(e) ?? '')
      },
    })
    if (process.stdout.isTTY) {
      ;({ melde: zeige, schliesse } = zeigeTafel(process.stdout, protokoll.pfad))
    } else {
      const zeilen = anzeige({ protokoll: protokoll.pfad })
      zeige = (e) => {
        for (const zeile of zeilen(e)) process.stdout.write(`${zeile}\n`)
      }
    }
    const waechter = abbruchWaechter({
      uhr: systemUhr,
      hinweis: (text) => protokoll.melde({ art: 'warnung', text, zeit: systemUhr.jetzt() }),
      // Signal während des Aufräumens: sofort raus; die Tafel räumt im 'exit'-Handler auf.
      hart: () => {
        start.freigeben()
        process.exit(130)
      },
    })
    empfange = waechter.empfange
    for (const s of signale) process.on(s, empfange)
    const ergebnis = await fahreLauf({
      spec,
      auswahl: start.auswahl,
      verzeichnis,
      checks: konfiguration.checks,
      versuche: konfiguration.versuche,
      token,
      versionen: { groundhog: VERSION, ...start.versionen },
      protokoll: protokoll.pfad,
      tracker: start.tracker,
      // Dieselbe Sandbox um Runs und Checks; ohne sie kein Bypass (sandbox.aus).
      agent: claudeAgent({ repoUrl: start.repoUrl, token, sandbox: start.sandbox }),
      sandbox: start.sandbox ?? durchreiche,
      uhr: systemUhr,
      melde: protokoll.melde,
      abbruch: waechter.signal,
    })
    if (ergebnis.angehalten === 'abgebrochen') return 130
    if (ergebnis.angehalten) return 1
    return ergebnis.tickets.some((t) => t.ergebnis === 'gescheitert') ? 2 : 0
  } catch (fehler) {
    schliesse()
    console.error(`groundhog: Lauf abgebrochen: ${(fehler as Error).message}`)
    return 1
  } finally {
    for (const s of signale) process.off(s, empfange)
    start.freigeben()
  }
}
