#!/usr/bin/env node
// PROTOTYP, Wegwerf-Code. Beantwortet die Frage aus dem Ticket „CLI-Oberfläche“ (#10):
// Wie sieht die Bedienung von groundhog aus? Drei Varianten der Anzeige eines Laufs,
// umschaltbar per Argument: node demo.mjs a|b|c [--schnell] [--gruen] [--ohne-menue]
// Nichts hier ist echt außer der Mitschrift: sie spielt run.jsonl ab, einen
// aufgezeichneten `claude -p --output-format stream-json`-Run. Tracker, Git und Checks sind gespielt.
import * as p from '@clack/prompts'
import { common, createEmphasize } from 'emphasize'
import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const args = process.argv.slice(2)
const variante = (args.find((a) => /^[abc]$/i.test(a)) ?? 'a').toLowerCase()
const flag = (f) => args.includes(f)
const warte = (ms) => sleep(flag('--schnell') ? 0 : ms)
const out = (s = '') => process.stdout.write(s + '\n')
const farbe = (n) => (s) => `\x1b[${n}m${s}\x1b[0m`
const [fett, matt, rot, gruen, gelb, cyan] = [1, 2, 31, 32, 33, 36].map(farbe)
const breite = () => process.stdout.columns || 100
const kurz = (s, n = breite() - 10) => {
  s = String(s).replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

const DIFF_MAX = 12
const hell = createEmphasize(common)
const sprache = { mjs: 'javascript', js: 'javascript', ts: 'typescript', tsx: 'typescript', json: 'json', md: 'markdown', py: 'python', css: 'css', sh: 'bash', yml: 'yaml' }
// Diff wie im Claude-Code-Fenster: Zeilennummer, +/- Marke, Syntaxfarben.
// shortcut: jede Zeile wird einzeln eingefärbt, mehrzeilige Strings und Kommentare stimmen dann nicht; für echt die ganze Datei einfärben.
function diffZeilen(e, n) {
  const lang = sprache[e.datei.split('.').pop()]
  const bunt = (c) => (lang ? hell.highlight(lang, c).value : c)
  const alle = e.hunks.flatMap((h) => h.lines)
  const zahl = (z) => alle.filter((l) => l[0] === z).length
  const aus = []
  for (const h of e.hunks) {
    let alt = h.oldStart
    let jetzt = h.newStart
    for (const l of h.lines) {
      const code = l.slice(1).slice(0, n - 8)
      const nr = (x) => String(x).padStart(4)
      if (l[0] === '+') aus.push(`${gruen(nr(jetzt++) + ' +')} ${bunt(code)}`)
      else if (l[0] === '-') aus.push(`${rot(nr(alt++) + ' -')} ${matt(code)}`)
      else aus.push(`${matt(nr(jetzt++) + '  ')} ${bunt(code)}`) && alt++
    }
  }
  return [
    matt(`⎿ ${zahl('+')} Zeile${zahl('+') === 1 ? '' : 'n'} hinzugefügt, ${zahl('-')} entfernt`),
    ...aus.slice(0, DIFF_MAX),
    ...(aus.length > DIFF_MAX ? [matt(`     … ${aus.length - DIFF_MAX} weitere Zeilen`)] : []),
  ]
}

// ---------- gespielte Daten ----------
const VERSION = '0.1.0'
const spec = { nr: 42, titel: 'Export als CSV' }
const integration = `groundhog/spec-${spec.nr}` // Name ist Platzhalter, nicht entschieden
const MAX = 3
let tickets = [
  { nr: 43, titel: 'CSV-Spalten festlegen', versuche: ['gruen'] },
  { nr: 44, titel: 'Export-Endpunkt', versuche: ['checks', 'gruen'] },
  { nr: 45, titel: 'Download-Knopf', versuche: ['checks', 'kein-commit', 'checks'] },
  { nr: 46, titel: 'Fortschrittsanzeige', blockiertVon: 45, versuche: ['gruen'] },
  { nr: 47, titel: 'Doku ergänzen', limit: true, versuche: ['gruen'] },
  { nr: 48, titel: 'Rechtekonzept', mensch: true },
]
if (flag('--gruen')) tickets = tickets.filter((t) => !t.mensch).map((t) => ({ ...t, versuche: ['gruen'], limit: false }))

// ---------- echte Mitschrift aus stream-json ----------
function mitschrift() {
  const ereignisse = []
  let ende = { dauer: '?', kosten: '?', session: '?' }
  for (const zeile of readFileSync(new URL('./run.jsonl', import.meta.url), 'utf8').split('\n')) {
    if (!zeile.trim()) continue
    const j = JSON.parse(zeile)
    if (j.type === 'assistant')
      for (const c of j.message.content) {
        if (c.type === 'text' && c.text.trim()) ereignisse.push({ art: 'text', s: c.text })
        if (c.type === 'tool_use') {
          const i = c.input ?? {}
          ereignisse.push({ art: 'tool', name: c.name, s: i.command ?? i.file_path?.split('/').pop() ?? i.pattern ?? i.description ?? '' })
        }
      }
    if (j.type === 'user' && Array.isArray(j.message?.content))
      for (const c of j.message.content)
        if (c.type === 'tool_result') {
          const s = typeof c.content === 'string' ? c.content : (c.content ?? []).map((x) => x.text ?? '').join(' ')
          // Diff wie im Claude-Code-Fenster: Edit liefert structuredPatch, Write (neue Datei) nur content
          const r = j.tool_use_result ?? {}
          let hunks = r.structuredPatch ?? []
          if (!hunks.length && r.type === 'create') hunks = [{ oldStart: 1, newStart: 1, lines: r.content.trimEnd().split('\n').map((l) => '+' + l) }]
          if (hunks.length) ereignisse.push({ art: 'diff', datei: r.filePath, hunks })
          else ereignisse.push({ art: 'ergebnis', s, fehler: !!c.is_error })
        }
    if (j.type === 'result')
      ende = { dauer: `${Math.round(j.duration_ms / 1000)}s`, kosten: `$${(j.total_cost_usd ?? 0).toFixed(2)}`, session: j.session_id }
  }
  return { ereignisse, ende }
}
const echt = mitschrift()

// ---------- Start: für alle Varianten gleich (Terminal-Menü, entschieden in „Herdr als Basis der Runs“) ----------
async function start() {
  const abbruch = (v) => {
    if (p.isCancel(v)) {
      p.cancel('Abgebrochen. Nichts wurde verändert.')
      process.exit(0)
    }
    return v
  }
  const offen = tickets.filter((t) => !t.mensch).length
  if (flag('--ohne-menue') || !process.stdin.isTTY) return { ziel: 'main', abschluss: 'pr' }

  p.intro(fett(`groundhog ${VERSION}`))
  if (abbruch(await p.confirm({ message: `Version 0.2.0 ist verfügbar (installiert: ${VERSION}). Jetzt aktualisieren?`, initialValue: false })))
    p.log.info('(Prototyp: hier würde aktualisiert und neu gestartet.)')
  p.log.info(`Herdr erkannt: jeder Run bekommt ein eigenes Herdr-Terminal mit seiner Mitschrift.`)
  p.note(
    [
      `Spec #${spec.nr} „${spec.titel}“`,
      `${tickets.length} Tickets, davon ${offen} für den Agent freigegeben`,
      ...tickets.filter((t) => t.mensch).map((t) => `#${t.nr} ${t.titel}: ready-for-human, wird nicht angefasst`),
      `Checks: npm run typecheck && npm test`,
      `Sandbox: an (srt) · höchstens ${MAX} Versuche pro Ticket`,
    ].join('\n'),
    'Dieser Lauf',
  )
  const ziel = abbruch(
    await p.select({
      message: 'Ziel-Branch: Wohin darf die Arbeit am Ende fließen?',
      options: [
        { value: 'main', label: 'main', hint: 'Standard' },
        { value: 'develop', label: 'develop' },
        { value: 'release/2.x', label: 'release/2.x' },
      ],
    }),
  )
  const abschluss = abbruch(
    await p.select({
      message: `Abschluss: Was geschieht mit ${integration}, sobald alle Tickets geschlossen sind?`,
      initialValue: ziel === 'main' ? 'pr' : 'mergen',
      options: [
        { value: 'mergen', label: 'Mergen', hint: `groundhog mergt nach ${ziel}, pusht und schließt die Spec` },
        { value: 'pr', label: 'PR', hint: `groundhog öffnet einen PR nach ${ziel}, du mergst selbst` },
        { value: 'nichts', label: 'Nichts', hint: `${integration} bleibt stehen` },
      ],
    }),
  )
  if (ziel === 'main' && abschluss === 'mergen') {
    p.log.warn(
      `Sind am Ende alle ${offen} Tickets geschlossen, mergt groundhog ${integration} nach main und pusht.\nDanach fragt niemand mehr nach, auch nicht mitten in der Nacht.`,
    )
    if (!abbruch(await p.confirm({ message: 'Ohne weitere Rückfrage nach main mergen?', initialValue: false }))) {
      p.cancel('Abgebrochen. Nichts wurde verändert.')
      process.exit(0)
    }
  }
  p.outro(`Lauf startet. Ab hier ist keine Eingabe mehr nötig. Strg+C bricht ab.`)
  return { ziel, abschluss }
}

// ---------- Engine (gespielt): treibt einen Renderer mit Ereignissen ----------
async function lauf(r, wahl) {
  const stand = new Map()
  await r.beginn?.(wahl)
  for (const t of tickets) {
    if (t.mensch) {
      stand.set(t.nr, { art: 'mensch-vorher' })
      continue
    }
    if (t.blockiertVon && stand.get(t.blockiertVon)?.art !== 'erledigt') {
      stand.set(t.nr, { art: 'blockiert' })
      await r.blockiert(t)
      continue
    }
    let erledigt = false
    let grund = ''
    for (let n = 1; n <= t.versuche.length && !erledigt; n++) {
      const ausgang = t.versuche[n - 1]
      await r.versuch(t, n)
      if (t.limit) {
        for (const e of echt.ereignisse.slice(0, 4)) await r.ereignis(t, e)
        await r.limit(t, '03:10')
        await warte(2500)
        await r.versuch(t, n) // ein Abbruch am Usage-Limit verbraucht keinen Versuch
      }
      const teil = ausgang === 'gruen' ? echt.ereignisse : echt.ereignisse.slice(0, Math.ceil(echt.ereignisse.length * 0.6))
      for (const e of teil) await r.ereignis(t, e)
      const pruefungen = [
        ['Run beendet', true, `${echt.ende.dauer} · ${echt.ende.kosten}`],
        ['Commit vorhanden', ausgang !== 'kein-commit', ausgang === 'kein-commit' ? 'kein neuer Commit auf dem Ticket-Branch' : ''],
        ['Arbeitsverzeichnis sauber', true, ''],
        ['Checks', ausgang !== 'checks', ausgang === 'checks' ? 'npm test: Exit 1, 2 Tests rot' : 'npm run typecheck && npm test'],
      ]
      erledigt = ausgang === 'gruen'
      grund = pruefungen.find((x) => !x[1])?.slice(0, 3).filter((x) => typeof x === 'string').join(': ') ?? ''
      await r.geprueft(t, n, pruefungen, erledigt)
    }
    stand.set(t.nr, erledigt ? { art: 'erledigt', versuche: t.versuche.length, limit: t.limit } : { art: 'gescheitert', grund })
    await r.ticketEnde(t, erledigt, grund)
  }
  await r.schluss?.()
  return stand
}

// ---------- Variante A „Strom“: alles fortlaufend, nichts wird überschrieben ----------
const A = {
  name: 'Strom',
  beginn: (w) => out(matt(`groundhog ${VERSION} · Spec #${spec.nr} „${spec.titel}“ · Ziel ${w.ziel} · Abschluss ${w.abschluss}`)),
  blockiert: (t) => out(`\n${matt(`○ #${t.nr} ${t.titel} · blockiert von #${t.blockiertVon}, bleibt offen`)}`),
  versuch: (t, n) => out(`\n${fett(`━━ #${t.nr} ${t.titel}`)} ${matt(`· Versuch ${n}/${MAX} · Ticket-Branch ${integration}-${t.nr}`)}`),
  async ereignis(t, e) {
    await warte(e.art === 'text' ? 350 : 150)
    if (e.art === 'text') out(`  │ ${kurz(e.s)}`)
    if (e.art === 'tool') out(`  │ ${cyan('⏺')} ${fett(e.name)} ${matt(kurz(e.s, breite() - 20))}`)
    if (e.art === 'ergebnis') out(`  │   ${(e.fehler ? rot : matt)('⎿ ' + kurz(e.s, breite() - 14))}`)
    if (e.art === 'diff') for (const l of diffZeilen(e, breite() - 12)) out(`  │   ${l}`)
  },
  limit: (t, bis) => out(`  ${gelb('⏸')} Usage-Limit erreicht. Der Lauf wartet bis ${bis} und setzt Versuch dann neu an (zählt nicht).`),
  async geprueft(t, n, pruefungen, ok) {
    for (const [name, gut, detail] of pruefungen) {
      await warte(200)
      out(`  ${gut ? gruen('✔') : rot('✘')} ${name} ${matt(detail)}`)
    }
    if (!ok) out(`  ${matt(`Ticket-Branch gelöscht.${n < MAX ? ' Neuer Versuch mit frischem Run.' : ''}`)}`)
  },
  ticketEnde(t, ok) {
    if (ok) out(`${gruen('✔')} ${fett(`#${t.nr} erledigt`)} ${matt(`→ ${integration} (fast-forward), gepusht, Ticket geschlossen`)}`)
    else out(`${rot('✘')} ${fett(`#${t.nr} endgültig gescheitert`)} ${matt(`→ ready-for-human · einsteigen: claude --resume ${echt.ende.session}`)}`)
  },
}

// ---------- Variante B „Tafel“: fester Bildschirm, oben der Task-Graph, unten die Mitschrift des laufenden Runs ----------
const B = {
  name: 'Tafel',
  z: new Map(), // Zustand pro Ticket
  puffer: [],
  kopf: '',
  fuss: '',
  beginn(w) {
    process.stdout.write('\x1b[?1049h\x1b[?25l')
    this.kopf = `groundhog ${VERSION} · Spec #${spec.nr} „${spec.titel}“ · Ziel ${w.ziel} · Abschluss ${w.abschluss}`
    for (const t of tickets) this.z.set(t.nr, t.mensch ? matt('– ready-for-human, nicht angefasst') : matt('· wartet'))
    this.zeichne()
  },
  zeichne() {
    const hoehe = (process.stdout.rows || 30) - tickets.length - 7
    const zeilen = [fett(this.kopf), '']
    for (const t of tickets) zeilen.push(`  #${t.nr} ${t.titel.padEnd(24)} ${this.z.get(t.nr)}`)
    zeilen.push('', matt('─'.repeat(breite() - 1)), ...this.puffer.slice(-hoehe))
    while (zeilen.length < (process.stdout.rows || 30) - 2) zeilen.push('')
    zeilen.push(matt('─'.repeat(breite() - 1)), this.fuss)
    process.stdout.write('\x1b[H\x1b[J' + zeilen.join('\n'))
  },
  blockiert(t) {
    this.z.set(t.nr, matt(`○ blockiert von #${t.blockiertVon}`))
    this.zeichne()
  },
  versuch(t, n) {
    this.z.set(t.nr, cyan(`▶ läuft · Versuch ${n}/${MAX}`))
    this.puffer = []
    this.fuss = `Mitschrift #${t.nr} · Versuch ${n}/${MAX} · Strg+C bricht den Lauf ab`
    this.zeichne()
  },
  async ereignis(t, e) {
    await warte(e.art === 'text' ? 350 : 150)
    if (e.art === 'text') this.puffer.push(kurz(e.s, breite() - 2))
    if (e.art === 'tool') this.puffer.push(`${cyan('⏺')} ${fett(e.name)} ${matt(kurz(e.s, breite() - 20))}`)
    if (e.art === 'ergebnis') this.puffer.push(`  ${(e.fehler ? rot : matt)('⎿ ' + kurz(e.s, breite() - 8))}`)
    if (e.art === 'diff') this.puffer.push(...diffZeilen(e, breite() - 8).map((l) => '  ' + l))
    this.zeichne()
  },
  limit(t, bis) {
    this.z.set(t.nr, gelb(`⏸ Usage-Limit, weiter um ${bis}`))
    this.fuss = gelb(`Der Lauf wartet bis ${bis}. Der Versuch zählt nicht.`)
    this.zeichne()
  },
  async geprueft(t, n, pruefungen, ok) {
    for (const [name, gut, detail] of pruefungen) {
      await warte(200)
      this.puffer.push(`${gut ? gruen('✔') : rot('✘')} ${name} ${matt(detail)}`)
      this.zeichne()
    }
    if (!ok) this.z.set(t.nr, gelb(`↻ Versuch ${n}/${MAX} gescheitert`))
    await warte(600)
    this.zeichne()
  },
  ticketEnde(t, ok, grund) {
    this.z.set(t.nr, ok ? gruen(`✔ erledigt${t.versuche.length > 1 ? ` (${t.versuche.length} Versuche)` : ''}`) : rot(`✘ ready-for-human · ${grund}`))
    this.zeichne()
  },
  schluss: () => process.stdout.write('\x1b[?25h\x1b[?1049l'),
}

// ---------- Variante C „Still“: eine Zeile pro Ticket, die Mitschrift bleibt in der Datei (oder im Herdr-Terminal) ----------
const C = {
  name: 'Still',
  rad: 0,
  kopf: '',
  zeile(s) {
    process.stdout.write(`\r\x1b[K${kurz(s, breite() - 1)}`)
  },
  beginn(w) {
    out(matt(`groundhog ${VERSION} · Spec #${spec.nr} „${spec.titel}“ · Ziel ${w.ziel} · Abschluss ${w.abschluss}`))
    out(matt(`Mitschriften: .groundhog/laeufe/2026-11-24T2210/ (mitlesen: tail -f) `))
    out()
  },
  blockiert: (t) => out(matt(`○ #${t.nr} ${t.titel} · blockiert von #${t.blockiertVon}`)),
  versuch(t, n) {
    this.kopf = `#${t.nr} ${t.titel} · Versuch ${n}/${MAX}`
    this.zeile(`${cyan('⠋')} ${this.kopf}`)
  },
  async ereignis(t, e) {
    await warte(e.art === 'text' ? 350 : 150)
    if (e.art !== 'tool') return
    this.zeile(`${cyan('⠋⠙⠹⠸⠼⠴⠦⠧'[this.rad++ % 8])} ${this.kopf} · ${e.name} ${e.s}`)
  },
  limit(t, bis) {
    this.zeile(`${gelb('⏸')} ${this.kopf} · Usage-Limit, weiter um ${bis}`)
  },
  async geprueft(t, n, pruefungen, ok) {
    this.zeile(`${cyan('⠿')} ${this.kopf} · Checks laufen`)
    await warte(800)
    if (ok || n === MAX) return
    const [name, , detail] = pruefungen.find((x) => !x[1])
    this.zeile(`${gelb('↻')} #${t.nr} ${t.titel} · Versuch ${n}/${MAX} gescheitert: ${name} (${detail})`)
    out()
  },
  ticketEnde(t, ok, grund) {
    if (ok) this.zeile(`${gruen('✔')} #${t.nr} ${t.titel} · ${echt.ende.dauer}`)
    else this.zeile(`${rot('✘')} #${t.nr} ${t.titel} · ready-for-human · ${grund}`)
    out()
    if (!ok) out(matt(`    einsteigen: claude --resume ${echt.ende.session}`))
  },
}

// ---------- Ende: für alle Varianten gleich ----------
function ende(stand, wahl) {
  const offen = [...stand.values()].filter((s) => s.art !== 'erledigt').length
  out()
  out(fett(`Lauf beendet · Spec #${spec.nr} „${spec.titel}“ · 1h 12m`))
  out()
  for (const t of tickets) {
    const s = stand.get(t.nr)
    const kopf = `#${t.nr} ${t.titel.padEnd(24)}`
    if (s.art === 'erledigt')
      out(`  ${gruen('✔')} ${kopf} ${matt(`${s.versuche} Versuch${s.versuche > 1 ? 'e' : ''}${s.limit ? ', 1 Pause am Usage-Limit' : ''}`)}`)
    if (s.art === 'gescheitert') {
      out(`  ${rot('✘')} ${kopf} ${rot(`${MAX} Versuche, jetzt ready-for-human`)}`)
      out(matt(`      letzter Grund: ${s.grund}`))
      out(`      einsteigen:    claude --resume ${echt.ende.session}`)
    }
    if (s.art === 'blockiert') out(`  ${matt('○')} ${kopf} ${matt(`offen, blockiert von #${t.blockiertVon}`)}`)
    if (s.art === 'mensch-vorher') out(`  ${matt('–')} ${kopf} ${matt('ready-for-human, nicht angefasst')}`)
  }
  out()
  out(`Integration-Branch ${integration}: ${tickets.length - offen} Tickets übernommen, gepusht.`)
  const text = { mergen: `Mergen nach ${wahl.ziel}`, pr: `PR nach ${wahl.ziel}`, nichts: 'Nichts' }[wahl.abschluss]
  if (offen) out(gelb(`Abschluss „${text}“ entfällt: ${offen} Tickets sind noch offen. Danach erneut: groundhog ${spec.nr}`))
  else if (wahl.abschluss === 'mergen') out(gruen(`Abschluss: ${integration} nach ${wahl.ziel} gemergt und gepusht. Spec #${spec.nr} geschlossen.`))
  else if (wahl.abschluss === 'pr') out(gruen(`Abschluss: PR #49 ${integration} → ${wahl.ziel} geöffnet. Spec #${spec.nr} bleibt offen, bis du mergst.`))
  else out(`Abschluss „Nichts“: ${integration} bleibt stehen. Spec #${spec.nr} bleibt offen.`)
}

const hilfe = `groundhog ${VERSION}: arbeitet die Tickets einer Spec ohne Menschen ab.

  groundhog <spec>     Lauf über die Spec mit dieser Issue-Nummer starten
  groundhog init       Dieses Projekt einrichten (Checks, Ziel-Branches, Sandbox)
  groundhog --version
  groundhog --help

Ein Lauf hat keine weiteren Parameter. Ziel-Branch und Abschluss fragt groundhog
beim Start. Ein Ticket aussparen: im Tracker auf ready-for-human setzen.`

if (args.includes('hilfe')) out(hilfe)
else {
  const r = { a: A, b: B, c: C }[variante]
  const wahl = await start()
  out(matt(`[Prototyp · Variante ${variante.toUpperCase()} „${r.name}“]`))
  const stand = await lauf(r, wahl)
  ende(stand, wahl)
}
