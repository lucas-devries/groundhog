# `/implement` per `claude -p` starten

Recherche zu Issue #12. Stand: 2026-11-24, lokal installiertes CLI `2.1.331 (Claude Code)`, Matt-Pocock-Skills als Plugin `mattpocock-skills@mattpocock` in Version 1.3.2 (User-Scope).

Baut auf [`claude-code-headless.md`](claude-code-headless.md) (Issue #3) auf; was dort steht, wird hier nicht wiederholt.

Quellen: offizielle Doku unter `code.claude.com/docs/en/...` (abgerufen am 2026-11-24), Claude-Code-Changelog, die lokalen Skill-Dateien unter `~/.claude/plugins/cache/mattpocock/mattpocock-skills/1.3.2/`, Issues im Upstream-Repo `mattpocock/skills` und kleine eigene Headless-Aufrufe in einem Wegwerf-Verzeichnis. Eigene Beobachtungen sind als **[beobachtet]** markiert, Dinge, die ich nicht belegen konnte, als **[nicht verifiziert]**.

## Was für die Engine zählt

1. **Ja, der Aufruf startet den Skill.** `disable-model-invocation: true` sperrt nur den Aufruf durch das Modell, nicht den durch den Prompt. Ein `/name` am Anfang des `-p`-Prompts expandiert Claude Code vor dem Run ([skills](https://code.claude.com/docs/en/skills.md#control-who-invokes-a-skill); [headless](https://code.claude.com/docs/en/headless.md)). `claude -p "/implement …"` lud headless genau `skills/engineering/implement/SKILL.md` aus dem Plugin **[beobachtet]**.
2. **`/implement` ohne Präfix genügt, solange kein anderer Befehl `implement` heißt.** Plugin-Skills heißen `/mattpocock-skills:implement`; der kurze Name funktioniert zusätzlich, „unless another command already uses that name“ ([skills](https://code.claude.com/docs/en/skills.md#how-a-skill-gets-its-command-name)). Die Engine sollte trotzdem den vollen Namen `/mattpocock-skills:implement` schicken: Er ist eindeutig, und ein unbekannter Name scheitert sonst still (Exit 0, siehe Issue #3).
3. **`tdd` wird aufgerufen, `code-review` womöglich das falsche.** `implement` ruft beide über das Skill-Tool mit dem kurzen Namen auf. `tdd` landet beim Plugin-Skill. Der kurze Name `code-review` gehört aber dem in Claude Code eingebauten Bug-Review, nicht Matts Standards-und-Spec-Review **[beobachtet]**; Upstream ist das ein offenes Problem ([mattpocock/skills#1215](https://github.com/mattpocock/skills/issues/1215)). Ob das Modell selbst auf `mattpocock-skills:code-review` ausweicht, ist nicht deterministisch.
4. **Ohne AFK-Hinweis bleibt der Run an Rückfragen hängen, und zwar still.** `tdd` verlangt, die Seams vor dem ersten Test mit dem Nutzer abzustimmen; `implement` und `code-review` fragen bei mehrdeutiger Referenz bzw. fehlendem Fixpunkt nach. Headless endet der Run dann mit einer Frage im `result`, Exit 0, `is_error: false` **[beobachtet]**. Mit einem AFK-Hinweis per `--append-system-prompt` entschied das Modell selbst und machte weiter **[beobachtet]**.
5. **`code-review` sieht in `implement` nichts.** `implement` ruft das Review vor dem Commit auf, `code-review` vergleicht aber nur `git diff <fixpunkt>...HEAD`, also Commits. Upstream offen ([#1408](https://github.com/mattpocock/skills/issues/1408), [#1277](https://github.com/mattpocock/skills/issues/1277)). Der Review-Schritt im Skill ist für die Engine daher kein verlässlicher Teil des Ticket-Ablaufs.
6. **Im Ziel-Repo:** die Skills (Plugin auf der Maschine oder Kopie in `.claude/skills/`), die Konfiguration aus `/setup-matt-pocock-skills` (`## Agent skills` in `CLAUDE.md` plus `docs/agents/*.md`), ein eingeloggtes `gh` und ein Repo mit Tests und Typecheck. Details unten.

## Startet der Skill trotz `disable-model-invocation: true`?

Ja.

- Frontmatter von `implement` (Plugin 1.3.2): `name: implement`, `description: "Implement a piece of work based on a spec or set of tickets."`, `disable-model-invocation: true`. Keine `context: fork`, kein `allowed-tools`.
- Die Doku-Tabelle: Mit `disable-model-invocation: true` gilt „You can invoke: Yes“, „Claude can invoke: Not on its own“; die Beschreibung steht dann nicht im Kontext ([skills](https://code.claude.com/docs/en/skills.md#control-who-invokes-a-skill)). Ein Name am Anfang der Nachricht wird direkt ausgeführt; derselbe Name mitten im Text gilt als Erlaubnis für das Modell, den Skill für diese Nachricht aufzurufen ([skills](https://code.claude.com/docs/en/skills.md#where-you-write-the-skills-name)).
- Headless: „User-invoked skills and custom commands work. Include `/skill-name` in the prompt string and Claude Code expands it before running“ ([headless](https://code.claude.com/docs/en/headless.md)). Über `-p` wird nur der erste Skill einer Zeile geladen, der Rest der Zeile sind seine Argumente ([skills](https://code.claude.com/docs/en/skills.md#stack-several-skills-in-one-message)). `/implement owner/repo#42` übergibt also `owner/repo#42`; da `implement` keinen `$ARGUMENTS`-Platzhalter hat, hängt Claude Code `ARGUMENTS: <eingabe>` an den Skill-Text an ([skills](https://code.claude.com/docs/en/skills.md#pass-arguments-to-skills)).
- Upstream gab es Berichte, dass Skills mit `disable-model-invocation: true` im Desktop/Web-Client unsichtbar waren ([#1055](https://github.com/mattpocock/skills/issues/1055), Duplikat von #740, verweist auf anthropics/claude-code#92769). Im CLI 2.1.331 headless trifft das nicht zu: `mattpocock-skills:implement` steht in `skills` und `slash_commands` des `init`-Events **[beobachtet]**.
- Changelog: 2.1.110 „Fixed skills with `disable-model-invocation: true` failing when invoked via `/<skill>` mid-message“; 2.1.222 „Improved the refusal when Claude tries to invoke a skill with `disable-model-invocation`: Claude is now told to ask you to run the skill instead of replicating its workflow“; 2.1.287 „Improved `/skill` names typed mid-message: Claude is now told they are skills, including `disable-model-invocation` ones“.

Folge: Ein anderer Skill oder ein Subagent kann `implement` nicht aufrufen ([implement-Doku](https://github.com/mattpocock/skills/blob/main/docs/engineering/implement.md): „no other skill can call it either“). Die Engine muss `/…implement` an den Anfang des Prompts setzen.

## Unter welchem Namen?

- Plugin-Skills: „Frontmatter `name` or the directory name, namespaced by plugin“ → `/mattpocock-skills:implement`. „The bare `/fancy` also invokes the skill unless another command already uses that name“ ([skills](https://code.claude.com/docs/en/skills.md#how-a-skill-gets-its-command-name)).
- Changelog 2.1.265: „a plugin skill is now found by its bare name“; 2.1.269: „Improved the Skill tool's "Unknown skill" error to name the plugin skill's full name when a bare name matches exactly one plugin skill“.
- Das `init`-Event listet Plugin-Skills nur unter dem vollen Namen (`mattpocock-skills:implement`, `mattpocock-skills:tdd`, `mattpocock-skills:code-review`), daneben den eingebauten `code-review` **[beobachtet]**. Die Engine prüft also auf `mattpocock-skills:implement`, nicht auf `implement`.
- Kurze Namen bei Kollisionen: Eine Kopie in `~/.claude/skills/` oder `.claude/skills/` und ein Plugin-Skill laden beide, „because plugin skills are namespaced“ ([skills](https://code.claude.com/docs/en/skills.md#resolve-skills-that-share-a-name)). Dann gehört der kurze Name der Kopie.

## Ruft `implement` headless `tdd` und `code-review` auf?

Der Skill-Text (1.3.2) sagt: „Call the Skill tool with "tdd" where possible, at pre-agreed seams.“ und „Once done, call the Skill tool with "code-review" to review the work.“ Beide Ziele haben kein `disable-model-invocation`, das Modell darf sie also aufrufen. Das Skill-Tool lief in meinen Runs im Modus `default` ohne Freigabe und ohne `permission_denials` **[beobachtet]**.

### Namensauflösung im Skill-Tool

| Aufruf aus einem Plugin-Skill | Ergebnis | Beleg |
| - | - | - |
| kurzer Name eines Plugin-Skills ohne Kollision (`sub`) | Plugin-Skill `tp:sub` läuft | E3 **[beobachtet]** |
| kurzer Name `code-review` bei einem Plugin-Skill gleichen Namens | eingebauter `/code-review` läuft (geforkt, Bug-Review), nicht `tp:code-review` | E3 **[beobachtet]** |
| dieselbe Anweisung ohne Zwang zum wörtlichen Namen | Modell rief von sich aus `tp:sub` und `tp:code-review` auf | E2 **[beobachtet]** |

Für `implement` heißt das:

- **`tdd`**: Es gibt keinen eingebauten Befehl `tdd`; der kurze Name löst auf `mattpocock-skills:tdd` auf. Ob das Modell `tdd` tatsächlich aufruft, steht im Skill nur als „where possible“; die implement-Doku nennt als Erfolgszeichen ausdrücklich „an actual `tdd` Skill tool call in the trace, not just tests appearing in the diff“ ([implement-Doku](https://github.com/mattpocock/skills/blob/main/docs/engineering/implement.md#its-working-if)). Die Engine kann das im `stream-json` an einem `tool_use` mit `name: "Skill"` und `input.skill` ∈ {`tdd`, `mattpocock-skills:tdd`} prüfen.
- **`code-review`**: Der eingebaute `/code-review` ist ein gebündelter Skill ([commands](https://code.claude.com/docs/en/commands.md)). Mehrere Upstream-Berichte: „`/implement` can end with the built-in review instead of your Standards + Spec review“ ([#1215](https://github.com/mattpocock/skills/issues/1215), offen, auf 2.1.292 mit Plugin 1.3.1); [#483](https://github.com/mattpocock/skills/issues/483) und [#1234](https://github.com/mattpocock/skills/issues/1234) wurden geschlossen mit dem Rat, im Plugin `/mattpocock-skills:code-review` zu verwenden. Matt benennt den Skill bewusst nicht um ([.out-of-scope/harness-name-collisions.md](https://github.com/mattpocock/skills/blob/main/.out-of-scope/harness-name-collisions.md), verlinkt in #1234).
- Bei einer Kopie in `.claude/skills/` ist es umgekehrt: „Your skill replaces the bundled command, but not its aliases. A project `code-review` skill replaces `/code-review`“ ([skills](https://code.claude.com/docs/en/skills.md#resolve-skills-that-share-a-name)). Dann läuft Matts Review, der eingebaute bleibt über `/review` erreichbar.

### Was die verschachtelten Skills headless tun

- **`tdd`** verlangt: „Before writing any test, write down the seams under test and confirm them with the user. No test is written at an unconfirmed seam.“ In `-p` im Modus `default` wird `AskUserQuestion` verweigert, mit `--permission-prompts none` ist das Tool ganz entfernt ([headless](https://code.claude.com/docs/en/headless.md#turn-off-permission-prompts-in-unattended-runs)). Das Modell fragt dann im Text und beendet den Run (E5a).
- **`code-review`** fragt nach dem Fixpunkt, wenn keiner genannt ist („If they didn't specify one, ask for it.“), sucht die Spec über Issue-Referenzen in den Commits und fragt, wenn keine gefunden wird. Es braucht den Tracker aus der Setup-Konfiguration („If not, tell the user to run `/setup-matt-pocock-skills`“) und startet zwei Subagents (Agent-Tool). Es prüft `git diff <fixpunkt>...HEAD` und bricht bei leerem Diff ab; vor dem Commit ist dieser Diff leer ([#1408](https://github.com/mattpocock/skills/issues/1408)).
- **`implement`** selbst: „If the reference is ambiguous, ask.“ Die implement-Doku empfiehlt deshalb die Issue-URL oder `owner/repo#N` statt `#N`. `implement` schließt das Ticket nicht und hakt keine Akzeptanzkriterien ab; es endet mit einem Commit auf dem aktuellen Branch ([implement-Doku](https://github.com/mattpocock/skills/blob/main/docs/engineering/implement.md#common-questions)).

### Rückfragen ohne Mensch (E5)

Ein Test-Skill mit derselben Anforderung wie `tdd` („confirm it with the user before going further“):

- ohne Hinweis: Das Modell schlug einen Seam vor und endete mit „**Bestätigen: `parser` ok, oder lieber `printer`?**“, Exit 0, `subtype: "success"`, `is_error: false`, `terminal_reason: "completed"`, keine `permission_denials` **[beobachtet]**. Für die Engine sieht das wie ein erfolgreicher Run aus.
- mit `--append-system-prompt "You run AFK: no human is available … Where a skill says to confirm or ask the user, decide yourself, record the decision and its reason, and continue."`: Das Modell entschied selbst, vermerkte „AFK, niemand erreichbar → selbst entschieden“ und lieferte die geforderte Zeile `SEAM-CHOSEN parser` **[beobachtet]**.

Ein einzelner Lauf je Variante; dass der Hinweis bei echtem `tdd` in einem längeren Run immer greift, ist **[nicht verifiziert]**.

## Was im Ziel-Repo und auf der Maschine vorhanden sein muss

1. **Die Skills**, auf eine der Arten aus dem nächsten Abschnitt.
2. **Setup-Konfiguration** aus `/setup-matt-pocock-skills`: ein `## Agent skills`-Block in `CLAUDE.md` (oder `AGENTS.md`) mit Verweisen auf `docs/agents/issue-tracker.md` und `docs/agents/domain.md`. `code-review` und `implement-spec` erwarten, dass der Tracker „provided“ ist; `implement` holt die Ticket-Referenz „from the issue tracker“. Das Setup ist interaktiv („confirm with the user, then write“), gehört also einmalig vor den ersten Lauf, nicht in die Engine.
3. **`gh`** installiert und eingeloggt (bei GitHub-Tracker), weil der Agent das Ticket selbst holt.
4. **Typecheck und Tests**, die der Agent finden kann: `implement` verlangt „Run typechecking regularly, single test files regularly, and the full test suite once at the end“. Wie er sie findet, sagt der Skill nicht; ein Hinweis in `CLAUDE.md` dürfte helfen **[nicht verifiziert]**.
5. **Optional `GLOSSARY.md` und `docs/adr/`**: `tdd` liest `GLOSSARY.md`, „if it exists“.
6. **Der richtige Branch ist ausgecheckt**: `implement` committet auf den aktuellen Branch und legt keinen an.
7. Die Rechte für Edit, Bash (Tests, git, gh) und Agent (für `code-review`) müssen im gewählten Permission-Modus durchgehen; siehe Issue #3.

## Plugin oder Kopie per `npx skills`

| | Plugin (`claude plugin install mattpocock-skills@…`) | Kopie per `npx skills add mattpocock/skills -a claude-code` |
| - | - | - |
| Ort | `~/.claude/plugins/cache/<marketplace>/mattpocock-skills/<version>/`, aktiviert pro Scope (User, Projekt über `enabledPlugins` in `.claude/settings.json`, …) ([plugins](https://code.claude.com/docs/en/plugins.md)) | kanonisch in `.agents/skills/<name>/`, per Symlink (oder `--copy`) nach `.claude/skills/`; mit `-g` nach `~/.claude/skills/`; Stand in `skills-lock.json` ([vercel-labs/skills](https://github.com/vercel-labs/skills/blob/main/docs/commands.md)) |
| Namen | `/mattpocock-skills:implement`; kurzer Name nur ohne Kollision | `/implement`, `/tdd`, `/code-review` |
| `code-review` aus `implement` | kurzer Name → eingebauter Review (Kollision) | Matts Review ersetzt den eingebauten |
| Updates | „A plugin updates itself“ ([README](https://github.com/mattpocock/skills#installation-30-second-setup)) | manuell `npx skills@latest update`; Dateien sind editierbar und gehören dem Repo |
| Reproduzierbarkeit | Version kann sich zwischen Läufen ändern; per `--plugin-dir <checkout>` pinnbar (Issue #3) | Version im Repo eingecheckt |
| Ziel-Repo ohne Vorbereitung | genügt, wenn das Plugin auf der Maschine installiert ist | Dateien müssen im Repo liegen (oder global) |

Das README warnt: „Pick one per agent, because installing both gives you every skill twice.“ Projekt-Skills laufen in `-p` auch in nie vertrauten Ordnern, inklusive ihres `allowed-tools` ([skills](https://code.claude.com/docs/en/skills.md#pre-approve-tools-for-a-skill)).

Bei der Kopie entfällt das Namensproblem von `code-review`; dafür muss jedes Ziel-Repo die Dateien tragen. Upstream wird für Kopien empfohlen, Verzeichnis und `name:` umzubenennen, falls man den eingebauten Review behalten will; `npx skills update` macht eine reine Umbenennung wieder rückgängig, solange der Eintrag in `skills-lock.json` steht ([#483](https://github.com/mattpocock/skills/issues/483), Kommentar von gttnr).

## Experimente

Wegwerf-Verzeichnis im Temp-Bereich, kein Git-Repo, Projekt-Skills in `proj/.claude/skills/`, Test-Plugin `tp` per `--plugin-dir`. Alle Aufrufe mit `--output-format stream-json --verbose --max-budget-usd 1 < /dev/null` (statt `json`, um die Tool-Aufrufe zu sehen), ohne Bypass. Es luden auch die User-Konfiguration dieser Maschine (Plugins, `~/.claude/CLAUDE.md`), darum sind die Antworten teils auf Deutsch und knapp.

| | Aufruf | Skill-Setup | Ergebnis |
| - | - | - | - |
| E1 | `claude -p "/ghimpl ticket-42" --permission-mode default` | Projekt-Skill `ghimpl` (`disable-model-invocation: true`) ruft per Skill-Tool `ghsub` auf | `Skill {"skill": "ghsub", "args": "ticket-42"}` → `Launching skill: ghsub`; Ergebnis `OUTER-OK INNER-PROJ-7731`, Exit 0, `is_error: false`, 3 Turns, 0,39 $ |
| E2 | `claude -p "/impl" --permission-mode default --plugin-dir ./tp` | Plugin-Skill `tp:impl` (`disable-model-invocation: true`), kurz aufgerufen; ruft `sub` und `code-review` auf, `tp` hat einen eigenen `code-review` | `/impl` lief; Modell rief `tp:sub` und `tp:code-review` (vollqualifiziert, aus eigenem Antrieb) auf und begründete: „bare `code-review` → Built-in statt Plugin-Skill“; Exit 0, 0,42 $ |
| E3 | `claude -p "/tp:implbare" --permission-mode default --plugin-dir ./tp --disallowedTools Agent` | wie E2, aber Anweisung, die Namen wörtlich zu übergeben | `Skill {"skill": "sub"}` → `Launching skill: sub` (Base-Dir `tp/skills/sub`); `Skill {"skill": "code-review"}` → eingebauter Review: Text „high effort → 4 inline angles …“, Tool-Ergebnis „Skill "code-review" completed (forked execution).“, kein Marker aus `tp:code-review`; Exit 0, 0,62 $ |
| E4 | `claude -p "/implement HARNESS-TEST, no real ticket: do not implement anything. Only quote …" --permission-mode default --tools "" --max-turns 1` | echtes Plugin, ohne Tools, kein Ticket | Modell zitierte „Implement the work described by the user in the spec or tickets.“ und „Base directory for this skill: /Users/…/mattpocock-skills/1.3.2/skills/engin…“; Exit 1, `error_max_budget_usd` (1,17 $ für einen Turn mit der vollen User-Konfiguration) |
| E5a | `claude -p "/tp:asky" --permission-mode default --permission-prompts none --plugin-dir ./tp` | Skill verlangt Bestätigung des Seams durch den Nutzer | Run endet mit Frage, Exit 0, `success`, `is_error: false`, 0,36 $ |
| E5b | wie E5a plus `--append-system-prompt "You run AFK: …"` | dito | Modell entscheidet selbst, liefert `SEAM-CHOSEN parser`, Exit 0, 0,42 $ |

## Empfehlung für die Engine

- Prompt `"/mattpocock-skills:implement <Issue-URL>"` (bei einer Kopie im Repo: `"/implement <Issue-URL>"`), nicht `#N`. Vor dem Run im `init`-Event prüfen, dass `mattpocock-skills:implement` in `skills` steht, und `plugin_errors` auswerten.
- AFK-Hinweis per `--append-system-prompt`, der mindestens sagt: kein Mensch erreichbar; Rückfragen aus Skills (Seams, Fixpunkt, Mehrdeutigkeit) selbst entscheiden und begründen; für das Review den Skill `mattpocock-skills:code-review` verwenden, nicht den eingebauten; Fixpunkt für das Review ist der Commit `<SHA vor dem Run>`; vor dem Review committen. Zusätzlich `--permission-prompts none`, damit `AskUserQuestion` gar nicht erst verfügbar ist.
- Ein Run, der mit einer Frage endet, ist kein Erfolg. Die Engine erkennt ihn nicht am `result`-Objekt, sondern nur an den eigenen Checks (neuer Commit vorhanden, Checks grün). Ein `--json-schema` mit Status „fertig / blockiert“ wäre eine zusätzliche Absicherung (Issue #3).
- Das Review entweder im Hinweis erzwingen wie oben, oder aus `implement` herausnehmen und als eigenen Run nach dem Commit starten: `claude -p "/mattpocock-skills:code-review <SHA>"`. Der eigene Run ist deterministischer, weil die Engine dann Namen, Fixpunkt und Reihenfolge festlegt, und vermeidet die Selbstbewertung im selben Kontext, die die implement-Doku selbst als Schwäche nennt. Das weicht aber von der Entscheidung ab, Review „aus dem Skill“ zu beziehen.
- Plugin pinnen: entweder `--plugin-dir` auf einen festen Checkout von `mattpocock/skills` (dann aber das User-Plugin nicht zusätzlich laden, sonst doppelte Skills **[nicht verifiziert, wie sich gleichnamige Plugins verhalten]**), oder eine Kopie per `npx skills` im Ziel-Repo, die das `code-review`-Problem gleich mit löst.

## Offene Punkte

- `/implement` wurde nicht gegen ein echtes Ticket ausgeführt (bewusst). Ob ein vollständiger Run mit AFK-Hinweis tatsächlich `tdd` aufruft, die Seams selbst festlegt, das richtige `code-review` trifft und committet, ist **[nicht verifiziert]**; ein Probelauf an einem Spielzeug-Ticket wäre der nächste Schritt.
- Ob das Modell im echten `implement` von sich aus auf `mattpocock-skills:code-review` ausweicht (wie in E2) oder den eingebauten nimmt (wie in #1215 berichtet), ist nicht deterministisch; je ein Lauf pro Variante.
- Verhalten, wenn dasselbe Plugin installiert ist und zusätzlich per `--plugin-dir` geladen wird, nicht geprüft.
- Wie der eingebaute `/code-review` im `-p`-Modus genau läuft (geforkt, Vordergrund oder Hintergrund), nur am Rande in E3 gesehen: „completed (forked execution)“.
- Kosten: Schon ein Turn mit dieser User-Konfiguration kostete über 1 $ (E4). Für die Engine spricht das dafür, die geladene Konfiguration zu beschränken (`--setting-sources`, nur benötigte Plugins); nicht weiter untersucht.
