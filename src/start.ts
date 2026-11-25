import { spawnSync } from 'node:child_process'
import { leseStromZeile, type StromZeile } from './claude.ts'
import { type Konfiguration, leseKonfiguration } from './config.ts'
import { ABSCHLUSS, type Auswahl, type Ereignis, integrationBranch } from './engine.ts'
import { git } from './git.ts'
import { GitHubTracker } from './github.ts'
import { nimmSperre } from './lock.ts'
import { oeffneProtokoll, type Protokoll } from './log.ts'
import { type SrtSandbox, sandboxFehlt, srtSandbox } from './sandbox.ts'
import { frontierZustand, type Ticket } from './tracker.ts'

/** Die Antwort von `@clack/prompts` auf Strg+C. */
export type StrgC = symbol

/** Die Teile von `@clack/prompts`, die das Menü braucht; ein Symbol als Antwort heißt Strg+C. */
export interface MenueDialog {
  note(text: string, titel: string): void
  warn(text: string): void
  outro(text: string): void
  select(o: {
    message: string
    options: { value: string; label: string; hint?: string }[]
    initialValue: string
  }): Promise<string | StrgC>
  confirm(o: {
    message: string
    initialValue: boolean
    active: string
    inactive: string
  }): Promise<boolean | StrgC>
}

export interface StartOptionen {
  /** Ein Verzeichnis im Klon. */
  verzeichnis: string
  spec: number
  dialog: MenueDialog
  /** stdin ist ein Terminal. */
  istTerminal: boolean
  /** Was der Sandbox zum Start fehlt; leer heißt startbar. */
  sandboxFehlt?: () => string[]
  /** Update-Frage am Anfang des Menüs; ohne sie wird nicht gefragt. */
  update?: {
    /** Der neuere Tag, sonst `undefined`, auch wenn der Vergleich scheitert. */
    neuereVersion: () => string | undefined
    /** Installiert den Tag; wirft mit Meldung, wenn das scheitert. */
    installiere: (tag: string) => void
  }
  /** Bekommt jedes Ereignis, nachdem das Protokoll es geschrieben hat. */
  weiter?: (ereignis: Ereignis) => void
}

/** Alles, was der Lauf nach dem Menü braucht. */
export interface Bereit {
  ok: true
  /** Repo-Root des Klons. */
  verzeichnis: string
  konfiguration: Konfiguration
  auswahl: Auswahl
  tracker: GitHubTracker
  /** Das `gh`-Token. */
  token: string
  repoUrl: string
  /** Die `srt`-Sandbox; `undefined` nur bei `sandbox.off`. */
  sandbox: SrtSandbox | undefined
  versionen: Record<string, string>
  protokoll: Protokoll
  /** Gibt die Sperre frei; bei jedem Ende aufrufen. */
  freigeben: () => void
}

export type Start = Bereit | { ok: false; exitCode: number; meldung: string }

const NICHTS_VERAENDERT = 'Abgebrochen. Nichts wurde verändert.'

class Abbruch extends Error {
  constructor(
    meldung: string,
    readonly exitCode = 1,
  ) {
    super(meldung)
  }
}

/**
 * Start eines Laufs bis zum Ende des Menüs: Start-Prüfungen, Sperre, Protokoll, Menü. Verändert
 * weder Repo noch Tracker; bei jedem Abbruch ist die Sperre wieder frei.
 */
export async function starte({
  verzeichnis: aufruf,
  spec,
  dialog,
  istTerminal,
  sandboxFehlt: fehlt = sandboxFehlt,
  update,
  weiter,
}: StartOptionen): Promise<Start> {
  let freigeben = () => {}
  try {
    const versionen: Record<string, string> = {}
    werkzeug(aufruf, 'git', ['--version'])
    let verzeichnis: string
    try {
      verzeichnis = git(aufruf, 'rev-parse', '--show-toplevel')
    } catch {
      throw new Abbruch('groundhog muss in einem Git-Repo laufen.')
    }
    const ghVersion = werkzeug(verzeichnis, 'gh', ['--version'])
    const [major = 0, minor = 0] = (ghVersion.match(/gh version (\d+)\.(\d+)/) ?? [])
      .slice(1)
      .map(Number)
    if (major < 2 || (major === 2 && minor < 94)) {
      throw new Abbruch(`gh ist zu alt (${ghVersion.split('\n')[0]}); nötig ist 2.94 oder neuer.`)
    }
    const token = werkzeug(verzeichnis, 'gh', ['auth', 'token'], () => {
      throw new Abbruch('gh ist nicht angemeldet. Melde dich mit `gh auth login` an.')
    })
    versionen.claude = werkzeug(verzeichnis, 'claude', ['--version'])
    werkzeug(verzeichnis, 'claude', ['auth', 'status'], () => {
      throw new Abbruch('claude ist nicht angemeldet. Melde dich mit `claude auth login` an.')
    })

    const gelesen = leseKonfiguration(verzeichnis)
    if (!gelesen.ok) throw new Abbruch(gelesen.fehler.join('\n'))
    const konfiguration = gelesen.konfiguration

    const sperre = nimmSperre(verzeichnis, spec, Date.now())
    if (!sperre.ok) throw new Abbruch(sperre.meldung)
    freigeben = sperre.freigeben

    if (git(verzeichnis, 'status', '--porcelain') !== '') {
      // Ausnahme: der Rest eines abgebrochenen Laufs auf ticket/<n>.
      const rest = git(verzeichnis, 'branch', '--show-current').match(/^ticket\/(\d+)$/)?.[1]
      const verwerfen =
        rest !== undefined &&
        istTerminal &&
        (await dialog.confirm({
          message: `Rest von Ticket ${rest} verwerfen?`,
          initialValue: false,
          active: 'Ja',
          inactive: 'Nein',
        }))
      if (typeof verwerfen === 'symbol') throw new Abbruch(NICHTS_VERAENDERT, 130)
      if (!verwerfen) {
        throw new Abbruch(
          'Das Arbeitsverzeichnis ist nicht sauber. Committe oder verwirf die Änderungen.',
        )
      }
      git(verzeichnis, 'reset', '-q', '--hard')
      git(verzeichnis, 'clean', '-q', '-fd')
    }
    git(verzeichnis, 'fetch', '-q', '--prune', 'origin')
    // Genau die Namen spec und ticket; spec/<n> und ticket/<n> früherer Läufe sind kein Hindernis.
    const stoerend = git(
      verzeichnis,
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/heads/',
      'refs/remotes/origin/',
    )
      .split('\n')
      .filter((b) => /^(origin\/)?(spec|ticket)$/.test(b))
    if (stoerend.length > 0) {
      throw new Abbruch(
        `Es gibt einen Branch ${stoerend.join(', ')}. Er stört spec/* und ticket/*; benenne ihn um.`,
      )
    }
    const fehlend = konfiguration.targetBranches.filter(
      (b) => !git(verzeichnis, 'for-each-ref', `refs/remotes/origin/${b}`),
    )
    if (fehlend.length > 0) {
      throw new Abbruch(`Ziel-Branch fehlt auf dem Remote: ${fehlend.join(', ')}`)
    }

    const tracker = await GitHubTracker.verbinde({ verzeichnis })
    const pruefung = await tracker.startPruefung(spec)
    if (pruefung.fehlendeLabels.length > 0) {
      throw new Abbruch(
        `Im Repo fehlt das Label ${pruefung.fehlendeLabels.join(' und ')}. Lege es auf GitHub an.`,
      )
    }
    if (pruefung.subIssues === 0) {
      throw new Abbruch(
        `Spec #${spec} hat keine Sub-Issues. groundhog nimmt als Tickets nur native Sub-Issues; ` +
          '„Part of #n“ im Text zählt nicht. Verknüpfe die Tickets in der Spec auf GitHub unter ' +
          '„Sub-issues“ (Add existing issue).',
      )
    }

    let sandbox: SrtSandbox | undefined
    if (!konfiguration.sandbox.off) {
      const was = fehlt()
      if (was.length > 0) {
        throw new Abbruch(
          `Die Sandbox ist an, startet aber nicht:\n${was.map((w) => `- ${w}`).join('\n')}`,
        )
      }
      sandbox = srtSandbox(konfiguration.sandbox.hosts)
    }

    const fehlendeSkills = skills(verzeichnis, versionen)
    if (fehlendeSkills.length > 0) {
      const befehl = INSTALLATION.map((a) => a.join(' ')).join(' && ')
      const installieren =
        istTerminal &&
        antwort(
          await dialog.confirm({
            message: `Es fehlen die Skills ${fehlendeSkills.join(', ')}. Das Plugin jetzt installieren?`,
            initialValue: true,
            active: 'Ja',
            inactive: 'Nein',
          }),
        )
      if (!installieren) {
        throw new Abbruch(
          `Es fehlen die Skills ${fehlendeSkills.join(', ')}. Installiere das Plugin mit:\n${befehl}`,
        )
      }
      // Die Ausgabe der Installation sieht der Mensch direkt; ob sie gelang, zeigt erst die Prüfung.
      for (const [datei = '', ...args] of INSTALLATION) {
        spawnSync(datei, args, { cwd: verzeichnis, stdio: 'inherit' })
      }
      const weiterFehlend = skills(verzeichnis, versionen)
      if (weiterFehlend.length > 0) {
        throw new Abbruch(
          `Es fehlen auch nach der Installation die Skills ${weiterFehlend.join(', ')}. Installiere das Plugin von Hand mit:\n${befehl}`,
        )
      }
    }

    if (!istTerminal) throw new Abbruch('groundhog braucht ein Terminal an stdin für das Menü.')

    let protokoll: Protokoll
    try {
      protokoll = oeffneProtokoll({ verzeichnis, spec, start: Date.now(), weiter })
    } catch (fehler) {
      throw new Abbruch(
        `Der Ordner des Protokolls lässt sich nicht anlegen: ${(fehler as Error).message}`,
      )
    }

    const tag = update?.neuereVersion()
    if (tag) {
      const ja = await dialog.confirm({
        message: `groundhog ${tag} ist erschienen. Jetzt aktualisieren?`,
        initialValue: false,
        active: 'Ja',
        inactive: 'Nein',
      })
      if (typeof ja === 'symbol') throw new Abbruch(NICHTS_VERAENDERT, 130)
      if (ja) {
        update?.installiere(tag)
        throw new Abbruch(`groundhog ${tag} ist installiert. Starte neu: groundhog ${spec}`, 0)
      }
    }

    const auswahl = await menue(
      dialog,
      spec,
      konfiguration,
      await tracker.taskGraph(spec),
      tracker.nutzer,
    )
    return {
      ok: true,
      verzeichnis,
      konfiguration,
      auswahl,
      tracker,
      token,
      repoUrl: pruefung.url,
      sandbox,
      versionen,
      protokoll,
      freigeben,
    }
  } catch (fehler) {
    freigeben()
    const exitCode = fehler instanceof Abbruch ? fehler.exitCode : 1
    return { ok: false, exitCode, meldung: (fehler as Error).message }
  }
}

/** Führt ein Werkzeug aus und liefert stdout; fehlt es im `PATH`, bricht der Start ab. */
function werkzeug(
  verzeichnis: string,
  name: string,
  args: string[],
  gescheitert = (stderr: string): never => {
    throw new Abbruch(`${name} ${args.join(' ')} ist gescheitert: ${stderr}`)
  },
): string {
  const lauf = spawnSync(name, args, { cwd: verzeichnis, encoding: 'utf8' })
  if ((lauf.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    throw new Abbruch(`${name} fehlt im PATH. groundhog braucht git, gh und claude.`)
  }
  if (lauf.status !== 0) gescheitert(lauf.stderr.trim())
  return lauf.stdout.trim()
}

/** Strg+C im Menü bricht mit 130 ab. */
function antwort<T>(wert: T | StrgC): T {
  if (typeof wert === 'symbol') throw new Abbruch(NICHTS_VERAENDERT, 130)
  return wert
}

const SKILLS = [
  'mattpocock-skills:implement',
  'mattpocock-skills:tdd',
  'mattpocock-skills:code-review',
]
const INSTALLATION = [
  ['claude', 'plugin', 'marketplace', 'add', 'mattpocock/skills'],
  ['claude', 'plugin', 'install', 'mattpocock-skills@mattpocock'],
]

/**
 * Die fehlenden Skills laut `init`-Event von `claude -p /usage` (kein Modell, keine Kosten); trägt
 * die Version des Skill-Plugins in `versionen` ein.
 */
function skills(verzeichnis: string, versionen: Record<string, string>): string[] {
  const ausgabe = werkzeug(verzeichnis, 'claude', [
    '-p',
    '/usage',
    '--output-format',
    'stream-json',
    '--verbose',
  ])
  let init: StromZeile = {}
  for (const zeile of ausgabe.split('\n')) {
    const z = leseStromZeile(zeile)
    if (z?.type === 'system' && z.subtype === 'init') init = z
  }
  const version = init.plugins?.find((p) => p.name === 'mattpocock-skills')?.version
  if (version) versionen['mattpocock-skills'] = version
  return SKILLS.filter((s) => !init.skills?.includes(s))
}

async function menue(
  dialog: MenueDialog,
  spec: number,
  konfiguration: Konfiguration,
  tickets: Ticket[],
  nutzer: string,
): Promise<Auswahl> {
  const integration = integrationBranch(spec)
  const zustand = (t: Ticket) => frontierZustand(t, nutzer)
  const mensch = tickets.filter((t) => zustand(t) === 'ready-for-human')
  // Freigegeben, auch wenn noch blockiert oder vergeben.
  const freigegeben = tickets.filter((t) =>
    ['bearbeitbar', 'blockiert', 'vergeben'].includes(zustand(t)),
  )
  const { sandbox } = konfiguration
  dialog.note(
    [
      `Spec #${spec}`,
      `${tickets.length} Tickets, davon ${freigegeben.length} für den Agent freigegeben`,
      ...mensch.map((t) => `#${t.nummer}: ready-for-human, wird nicht angefasst`),
      `Checks: ${konfiguration.checks.join(' · ')}`,
      `Sandbox: ${sandbox.off ? 'aus' : 'an (srt)'}`,
      `Versuche pro Ticket: ${konfiguration.attempts}`,
    ].join('\n'),
    'Dieser Lauf',
  )
  if (sandbox.off) {
    dialog.warn(
      'Die Sandbox ist aus: Runs laufen im Auto-Mode ohne Grenzen auf diesem Rechner, mit deinem gh-Token.',
    )
  }
  const zielBranch = antwort(
    await dialog.select({
      message: 'Ziel-Branch: Wohin fließt die Arbeit am Ende?',
      options: konfiguration.targetBranches.map((b) => ({ value: b, label: b })),
      initialValue: konfiguration.targetBranches[0] ?? '',
    }),
  )
  const abschluss = antwort(
    await dialog.select({
      message: `Abschluss: Was geschieht mit ${integration}, sobald alle Tickets geschlossen sind?`,
      options: [
        {
          value: 'mergen',
          label: ABSCHLUSS.mergen,
          hint: `groundhog mergt nach ${zielBranch} und pusht`,
        },
        { value: 'pr', label: ABSCHLUSS.pr, hint: `groundhog öffnet einen PR nach ${zielBranch}` },
        { value: 'nichts', label: ABSCHLUSS.nichts, hint: `${integration} bleibt stehen` },
      ],
      initialValue: zielBranch === 'main' ? 'pr' : 'mergen',
    }),
  ) as Auswahl['abschluss']
  if (zielBranch === 'main' && abschluss === 'mergen') {
    dialog.warn(
      `Sind am Ende alle Tickets geschlossen, mergt groundhog ${integration} nach main und pusht, ohne nachzufragen.`,
    )
    const ja = antwort(
      await dialog.confirm({
        message: 'Ohne weitere Rückfrage nach main mergen?',
        initialValue: false,
        active: 'Ja',
        inactive: 'Nein',
      }),
    )
    if (!ja) throw new Abbruch(NICHTS_VERAENDERT)
  }
  dialog.outro('Ab hier ist keine Eingabe mehr nötig.')
  return { zielBranch, abschluss }
}
