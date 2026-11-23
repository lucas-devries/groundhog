# Form der Tickets in beiden Trackern

Research zu Ticket #4. Stand: 2026-11-23, Plugin `mattpocock-skills` 1.3.2, `gh` 2.104.0.

## Antwort

**GitHub Issues.** Eine Spec ist ein einzelnes Issue mit dem Label `ready-for-agent`. Jedes Ticket ist ein eigenes Issue, ebenfalls mit `ready-for-agent`. Die Verknüpfung Spec zu Ticket ist eine native **Sub-Issue**-Beziehung, aber nur, wenn `/to-tickets` von einem bestehenden Issue aus gestartet wurde. Blocker sind native **Issue Dependencies** (`blocked by`). Ein Ticket gilt als erledigt, wenn das Issue geschlossen ist; ein Ticket ist frei, wenn alle seine Blocker geschlossen sind. Alles davon liefert GitHub maschinenlesbar: `gh issue view --json subIssues,blockedBy,parent,state`, REST (`/sub_issues`, `/dependencies/blocked_by`, `issue_dependencies_summary`) und GraphQL (`subIssues`, `blockedBy`, `issueDependenciesSummary`). Die Frontier einer Spec lässt sich mit einer GraphQL-Abfrage oder mit der Suche `parent-issue:<owner>/<repo>#<n> -is:blocked` berechnen.

**Lokales Markdown.** Eine Spec ist `.scratch/<feature-slug>/spec.md`, jedes Ticket eine Datei `.scratch/<feature-slug>/issues/<NN>-<slug>.md`. Die Verknüpfung Spec zu Ticket ist allein das Verzeichnis. Blocker stehen als freier Text in einer Zeile `**Blocked by:**`, der Status als Zeile `**Status:** ready-for-agent`. Wie ein lokales Implementierungs-Ticket als erledigt markiert wird, definieren die Skills **nicht**. Hier gibt es kein maschinenprüfbares Format, nur Prosa-Konventionen.

**HITL vs. AFK.** Für Implementierungs-Tickets gibt es keine eigene HITL/AFK-Klassifikation. Die einzige Unterscheidung ist die Triage-Rolle: `ready-for-agent` (AFK) gegenüber `ready-for-human`. `/to-tickets` setzt immer `ready-for-agent`, außer der Mensch sagt etwas anderes. HITL/AFK als Begriff existiert nur für `/wayfinder`-Tickets (Labels `wayfinder:<type>`), nicht für Tickets aus `/to-tickets`.

**Wo ein deterministischer Parser bricht:** Spec und Tickets tragen dasselbe Label; der Rückfall-Text `Blocked by:` und `Part of #n`; die lokale `Blocked by`-Zeile ("numbers/titles"); das fehlende lokale "erledigt"; die umbenennbaren Label-Strings; die Akzeptanzkriterien als Checkboxen, die niemand abhakt. Details in [Prosa-Konventionen](#prosa-konventionen-die-ein-parser-nicht-sicher-lesen-kann).

## Quellen

Pfade zu Skill-Dateien sind relativ zu `~/.claude/plugins/cache/mattpocock/mattpocock-skills/1.3.2/`. Die Datei-Kopien unter `docs/agents/` in diesem Repo sind identisch mit den Seeds aus `skills/engineering/setup-matt-pocock-skills/`.

- `skills/engineering/to-spec/SKILL.md`
- `skills/engineering/to-tickets/SKILL.md`
- `skills/engineering/implement-spec/SKILL.md`, `skills/engineering/implement/SKILL.md`
- `skills/engineering/triage/SKILL.md`, `AGENT-BRIEF.md`, `OUT-OF-SCOPE.md`
- `skills/engineering/setup-matt-pocock-skills/SKILL.md`, `issue-tracker-github.md`, `issue-tracker-local.md`, `triage-labels.md`
- Erläuternde Doku des Plugins: `docs/engineering/to-spec.md`, `to-tickets.md`, `triage.md`, `implement-spec.md`
- GitHub REST: <https://docs.github.com/en/rest/issues/sub-issues>, <https://docs.github.com/en/rest/issues/issue-dependencies>
- GitHub Doku: <https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues>, <https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies>
- GitHub Changelog: <https://github.blog/changelog/2025-08-21-dependencies-on-issues/>
- GraphQL-Schema: per Introspection gegen `api.github.com` abgefragt (siehe unten), da die Referenzseite nicht maschinell lesbar war.
- `gh issue {create,edit,view,list} --help` (gh 2.104.0)

## 1. Die Spec

`/to-spec` schreibt die Spec nach einer festen Vorlage mit den Abschnitten `## Problem Statement`, `## Solution`, `## User Stories`, `## Implementation Decisions`, `## Testing Decisions`, `## Out of Scope`, `## Further Notes` (`skills/engineering/to-spec/SKILL.md:21-75`) und veröffentlicht sie im Tracker mit dem Triage-Label `ready-for-agent` (`to-spec/SKILL.md:19`). Die Plugin-Doku sagt ausdrücklich: eine Spec wird als **ein einzelnes Issue** veröffentlicht (`docs/engineering/to-spec.md:3`).

- **GitHub:** ein Issue, Label `ready-for-agent`. Kein eigenes Label wie `spec`; `to-spec` setzt nur dieses eine (`to-spec/SKILL.md:19`).
- **Lokal:** `.scratch/<feature-slug>/spec.md` (`skills/engineering/setup-matt-pocock-skills/issue-tracker-local.md:7-8`). Ob `spec.md` eine `Status:`-Zeile bekommt, sagt keine Datei: `to-spec` sagt nur "apply the label", der lokale Tracker sagt nur, dass Issue-Dateien eine `Status:`-Zeile tragen (`issue-tracker-local.md:10`).

Bekanntes Problem, dokumentiert vom Autor selbst: weil die Spec `ready-for-agent` trägt, greifen AFK-Runner, die auf dieses Label pollen, die Spec als Arbeitsauftrag ab. Empfehlung dort: Spec im Prompt ausschließen oder das Label nach `/to-tickets` entfernen (`docs/engineering/to-spec.md:41-42`). Für groundhog heißt das: **das Label allein unterscheidet Spec und Ticket nicht.**

## 2. Die Tickets

### GitHub

`/to-tickets` legt ein Issue pro Ticket an, **in Abhängigkeitsreihenfolge (Blocker zuerst)**, damit Blocker bei der Anlage schon Nummern haben (`to-tickets/SKILL.md:63`). Vorlage (`to-tickets/SKILL.md:84-103`):

```markdown
## Parent
A reference to the parent issue on the tracker (if the source was an existing issue, otherwise omit this section).

## What to build
...

## Acceptance criteria
- [ ] Criterion 1

## Blocked by
- A reference to each blocking ticket, or "None (can start immediately)". Omit this section when blockers were set as native edges.
```

- **Spec zu Ticket:** "If the source was an existing issue, make each ticket its sub-issue" (`to-tickets/SKILL.md:63`). Befehl laut Tracker-Vorlage: `gh issue create --parent <parent>` oder `gh issue edit <parent> --add-sub-issue <child>`; ohne Sub-Issues fällt die Vorlage auf `Part of #<parent>` am Anfang des Bodys zurück (`issue-tracker-github.md:10`). Wurde `/to-tickets` aus der Konversation statt aus einem Issue gestartet, gibt es **keine** Verknüpfung (`to-tickets/SKILL.md:17,63,88`; `docs/engineering/to-tickets.md:14`). Fehlende Sub-Issues waren ein gemeldeter, inzwischen behobener Fehler (`docs/engineering/to-tickets.md:64-65`).
- **Blocker:** "Use the platform's native blocking relationship where it has one; otherwise set each ticket's 'Blocked by'" (`to-tickets/SKILL.md:63`). Für GitHub: native Issue Dependencies, angelegt mit `gh issue create --blocked-by <n>,<n>` oder `gh issue edit <child> --add-blocked-by <blocker>`; Rückfall: Zeile `Blocked by: #<n>, #<n>` am Anfang des Bodys (`issue-tracker-github.md:11`). Text im Body statt nativer Kante war ein gemeldeter Fehler (`docs/engineering/to-tickets.md:67-68`).
- **Label:** `ready-for-agent`, "unless instructed otherwise" (`to-tickets/SKILL.md:63`).
- **Parent bleibt unberührt:** "Do NOT close or modify any parent issue" (`to-tickets/SKILL.md:67`).

### Lokal

Eine Datei pro Ticket unter `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, nummeriert ab `01` in Abhängigkeitsreihenfolge, nie eine Sammeldatei (`to-tickets/SKILL.md:62`; `issue-tracker-local.md:9`). Vorlage (`to-tickets/SKILL.md:69-82`):

```markdown
# <NN>: <Ticket title>

**What to build:** ...

**Blocked by:** the numbers/titles of the tickets that gate this one, or "None (can start immediately)".

**Status:** ready-for-agent

- [ ] Acceptance criterion 1
```

- **Spec zu Ticket:** nur über das gemeinsame Verzeichnis `.scratch/<feature-slug>/`. Kein Verweis im Ticket.
- **Blocker:** freier Text, "numbers/titles" (`to-tickets/SKILL.md:62,75`). Die Wayfinder-Konvention desselben Trackers schreibt dagegen `Blocked by: NN, NN` ohne Fettdruck (`issue-tracker-local.md:27`). Zwei Schreibweisen im selben Tracker.
- **Status:** "Triage state is recorded as a `Status:` line near the top of each issue file" (`issue-tracker-local.md:10`); die Vorlage schreibt sie fett: `**Status:** ready-for-agent` (`to-tickets/SKILL.md:77`).
- **Kommentare:** werden unten unter `## Comments` angehängt (`issue-tracker-local.md:11`).
- Laut Plugin-Doku werden lokale Tickets "Top to bottom, by hand" abgearbeitet; eine Frontier gibt es nur auf echten Trackern (`docs/engineering/to-tickets.md:37-42`). Die `NN` ist eine echte Ticket-ID (`docs/engineering/to-tickets.md:71`).

## 3. Labels und `Status:`-Zeilen (Triage-Rollen)

Fünf Zustandsrollen: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`; dazu zwei Kategorierollen `bug`, `enhancement` (`skills/engineering/triage/SKILL.md:26-37`). Das sind **kanonische Namen**; die echten Label-Strings können pro Repo abweichen und stehen in `docs/agents/triage-labels.md` (`triage/SKILL.md:43`; `setup-matt-pocock-skills/triage-labels.md:5-15`). Für groundhog sind sie aktuell identisch (`docs/agents/triage-labels.md`).

- Auf GitHub ist die Rolle ein Label, lokal die `Status:`-Zeile (`issue-tracker-local.md:10`).
- `/to-tickets`-Tickets bekommen **nur** eine Zustandsrolle, keine Kategorie; "exactly one category role and one state role" gilt nur für triagierte Issues (`triage/SKILL.md:41`). Triage über `/to-tickets`-Tickets ist ausdrücklich nicht vorgesehen (`docs/engineering/to-tickets.md:19`; `docs/engineering/triage.md:71-72`).
- Es gibt keinen Zustand für "blockiert", "zurückgestellt" oder "umgesetzt"; das ist ein offener, oft gemeldeter Mangel (`docs/engineering/triage.md:80-87`). Ohne Endzustand "umgesetzt" kann ein AFK-Runner fertige Tickets erneut einreihen (`docs/engineering/triage.md:85`).
- `setup-matt-pocock-skills` legt die Labels laut SKILL.md an (`setup-matt-pocock-skills/SKILL.md:106`), die Plugin-Doku nennt das Fehlen als offenen Bug #616 (`docs/engineering/triage.md:77-78`). Für groundhog: Label-Existenz nicht voraussetzen.

## 4. Wann ein Ticket als erledigt gilt

- **GitHub:** "A ticket is unblocked when every blocker is closed" (`issue-tracker-github.md:11`). Schließen: erst `gh issue comment`, dann `gh issue close` (`issue-tracker-github.md:15`). Ein geschlossenes Issue zählt als erledigt, **egal mit welchem `stateReason`** (`COMPLETED`, `NOT_PLANNED`, `DUPLICATE`); die Skills unterscheiden das nicht.
- `implement-spec` verlangt, jedes Ticket "the way the issue tracker closes work" aufzulösen und eine Draft-PR zu öffnen, "if the issue tracker closes work through PRs" (`implement-spec/SKILL.md:11,27,40`). Die GitHub-Vorlage definiert **nicht**, ob der Tracker über PRs schließt; sie kennt nur `gh issue close` (`issue-tracker-github.md:15`).
- Der Blocker-Zähler sinkt erst, wenn ein Blocker **geschlossen** wird, nicht wenn er auf dem Integration-Branch gemergt ist. Der Autor empfiehlt deshalb, die Frontier mitten im Lauf selbst aus dem Merge-Stand zu berechnen (`docs/engineering/implement-spec.md:58-60`). Weil groundhog Tickets selbst schließt, sobald die Checks bestehen, betrifft das groundhog nur, wenn es das Schließen auf das Lauf-Ende verschiebt.
- `/implement` schließt Tickets nicht zuverlässig, weder auf GitHub noch lokal (`docs/engineering/to-tickets.md:80`).
- **Lokal:** für Implementierungs-Tickets ist **kein** Erledigt-Zustand definiert. `issue-tracker-local.md` hat keinen Abschnitt "Close". Nur die Wayfinder-Operationen kennen `Status: resolved` und `Status: claimed` (`issue-tracker-local.md:26,29-30`) und "unblocked when every file it lists is `resolved`" (`issue-tracker-local.md:27`). groundhog muss das selbst festlegen; `Status: resolved` wäre die naheliegende Wahl, weil der Tracker sie schon kennt.

## 5. HITL vs. AFK

- `/to-spec`, `/to-tickets`, `/implement-spec`, `/implement` kennen keine HITL/AFK-Markierung pro Ticket (Volltextsuche in allen vier SKILL.md-Dateien).
- Die einzige Unterscheidung ist die Triage-Rolle: `ready-for-agent` = "Fully specified, ready for an AFK agent", `ready-for-human` = "Requires human implementation" (`setup-matt-pocock-skills/triage-labels.md:9-10`; `triage/SKILL.md:35-36`). `/to-tickets` setzt `ready-for-agent` "unless instructed otherwise" (`to-tickets/SKILL.md:63`), ein Mensch kann also beim Quiz einzelne Tickets auf `ready-for-human` setzen lassen.
- HITL/AFK als Ticket-Eigenschaft gibt es nur in `/wayfinder` (`skills/engineering/wayfinder/SKILL.md:75-80`), ausgedrückt über `wayfinder:<type>`-Labels (`issue-tracker-github.md:46`) bzw. eine lokale `Type:`-Zeile (`issue-tracker-local.md:26`). Das betrifft Karten wie #1, nicht Specs.

Folgerung für groundhog: ein Ticket ist für die Engine genau dann bearbeitbar, wenn es offen ist, die Rolle `ready-for-agent` trägt und keine offenen Blocker hat. `ready-for-human` heißt: überspringen, und seine Abhängigen bleiben blockiert.

## 6. Maschinenlesbare Abfragen (GitHub)

### Fakten aus der GitHub-Doku

- Sub-Issues: bis zu 100 pro Parent, bis zu acht Ebenen tief ([adding-sub-issues](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues)). REST: `GET/POST /repos/{owner}/{repo}/issues/{n}/sub_issues`, `DELETE .../sub_issue`, `PATCH .../sub_issues/priority`, `GET .../parent`; `per_page` max 100 ([REST sub-issues](https://docs.github.com/en/rest/issues/sub-issues)).
- Dependencies: bis zu 50 Issues je Beziehungstyp ([Changelog 2025-08-21](https://github.blog/changelog/2025-08-21-dependencies-on-issues/)). REST: `GET/POST .../dependencies/blocked_by`, `DELETE .../dependencies/blocked_by/{issue_id}`, `GET .../dependencies/blocking`; `per_page` max 100 ([REST issue-dependencies](https://docs.github.com/en/rest/issues/issue-dependencies)).
- `issue_id` bzw. `sub_issue_id` im Body ist die **Datenbank-ID** (`.id`), nicht die Nummer und nicht die `node_id` (`issue-tracker-github.md:11`; die REST-Doku sagt nur "the id"). Für groundhog irrelevant, solange es nur liest.
- Such-Qualifier `is:blocked`, `is:blocking`, `blocked-by:`, `blocking:` ([Changelog 2025-08-21](https://github.blog/changelog/2025-08-21-dependencies-on-issues/)). `parent-issue:` steht in keiner der gelesenen Doku-Seiten, funktioniert aber (siehe unten).

### GraphQL-Schema (per Introspection verifiziert)

```console
$ gh api graphql -f query='{ i: __type(name:"Issue"){fields{name description args{name}}} }' --jq '...'
blockedBy(orderBy,after,before,first,last): A list of issues that are blocking this issue.
blocking(orderBy,after,before,first,last): A list of issues that this issue is blocking.
issueDependenciesSummary(): Summary of the state of an issue's dependencies
parent(): The parent entity of the issue.
stateReason(enableDuplicate): Identifies the reason for the issue state.
subIssues(after,before,first,last): A list of sub-issues associated with the Issue.
subIssuesSummary(): Summary of the state of an issue's sub-issues
D blockedBy: Count of issues this issue is blocked by
D totalBlockedBy: Total count of issues this issue is blocked by (open and closed)
S completed: Count of completed sub-issues
S total: Count of total number of sub-issues
```

Mutationen: `addBlockedBy`, `removeBlockedBy`, `addSubIssue`, `removeSubIssue`, `reprioritizeSubIssue`. `IssueStateReason`: `COMPLETED`, `NOT_PLANNED`, `DUPLICATE`, `REOPENED`.

### `gh` 2.104.0

- `gh issue create`: `--parent`, `--blocked-by`, `--blocking`, `--label` (`gh issue create --help`).
- `gh issue edit`: `--add-sub-issue`, `--remove-sub-issue`, `--parent`, `--remove-parent`, `--add-blocked-by`, `--remove-blocked-by`, `--add-blocking`, `--remove-blocking` (`gh issue edit --help`).
- JSON-Felder von `gh issue view` und `gh issue list`: `assignees, author, blockedBy, blocking, body, closed, closedAt, closedByPullRequestsReferences, comments, createdAt, id, isPinned, issueType, labels, milestone, number, parent, projectCards, projectItems, reactionGroups, state, stateReason, subIssues, subIssuesSummary, title, updatedAt, url`. Es gibt **kein** Feld `issueDependenciesSummary` in `gh`; dafür REST oder GraphQL.
- `gh issue view` ohne `--json` druckt Klartextzeilen `parent:`, `sub-issues:`, `sub-issues-completed:`, `blocked-by:`, `blocking:` (siehe `gh issue view 1` und `4` in diesem Repo). Das ist Anzeige, kein stabiles Format.

### Verifizierte Aufrufe gegen dieses Repo

Alle nur lesend, ausgeführt am 2026-11-23 gegen `lucas-devries/groundhog` (Map #1 mit Sub-Issues #2 bis #10).

Sub-Issues einer Spec:

```console
$ gh issue view 1 --json number,subIssues,subIssuesSummary --jq '{n:.number, subs:[.subIssues.nodes[]|{number,state}], sum:.subIssuesSummary}'
{"n":1,"subs":[{"number":2,"state":"OPEN"},{"number":3,"state":"OPEN"}, ... {"number":10,"state":"OPEN"}],"sum":{"completed":0,"percentCompleted":0,"total":9}}

$ gh api repos/lucas-devries/groundhog/issues/1/sub_issues --jq '[.[] | {number,id,state}]'
[{"id":6565741898,"number":2,"state":"open"},{"id":6565743078,"number":3,"state":"open"}, ... {"id":6565750028,"number":10,"state":"open"}]
```

Parent und Blocker eines Tickets:

```console
$ gh issue view 7 --json number,state,parent,blockedBy,blocking --jq '{number,state,parent:.parent.number,blockedBy:[.blockedBy.nodes[]|{number,state}],blocking:[.blocking.nodes[].number]}'
{"blockedBy":[{"number":4,"state":"OPEN"},{"number":2,"state":"OPEN"}],"blocking":[10],"number":7,"parent":1,"state":"OPEN"}

$ gh api repos/lucas-devries/groundhog/issues/7 --jq '{number,id,node_id,state,state_reason,issue_dependencies_summary}'
{"id":6565746780,"issue_dependencies_summary":{"blocked_by":2,"blocking":1,"total_blocked_by":2,"total_blocking":1},"node_id":"I_kwDOV5Do3s8AAAABh1lYXA","number":7,"state":"open","state_reason":null}

$ gh api repos/lucas-devries/groundhog/issues/7/dependencies/blocked_by --jq '[.[] | {number,id,state}]'
[{"id":6565741898,"number":2,"state":"open"},{"id":6565743873,"number":4,"state":"open"}]

$ gh api repos/lucas-devries/groundhog/issues/4/dependencies/blocking --jq '[.[] | {number,state}]'
[{"number":7,"state":"open"},{"number":8,"state":"open"}]
```

Beachte: `blockedBy.nodes` kommt **nicht** nach Nummer sortiert (`[4, 2]`). `gh ... --json blockedBy` enthält auch geschlossene Blocker; filtern mit `select(.state=="OPEN")` (`issue-tracker-github.md:12`).

Frontier in einer GraphQL-Abfrage (Task-Graph einer Spec komplett):

```console
$ gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){subIssues(first:50){nodes{number state assignees(first:5){nodes{login}} labels(first:10){nodes{name}} blockedBy(first:50){nodes{number state}}}}}}}' \
    -F o=lucas-devries -F r=groundhog -F n=1 \
    --jq '.data.repository.issue.subIssues.nodes[] | {number,state,labels:[.labels.nodes[].name],openBlockers:[.blockedBy.nodes[]|select(.state=="OPEN")|.number]}'
{"labels":["wayfinder:research"],"number":2,"openBlockers":[],"state":"OPEN"}
{"labels":["wayfinder:research"],"number":3,"openBlockers":[],"state":"OPEN"}
{"labels":["wayfinder:research"],"number":4,"openBlockers":[],"state":"OPEN"}
{"labels":["wayfinder:grilling"],"number":5,"openBlockers":[3,2],"state":"OPEN"}
{"labels":["wayfinder:grilling"],"number":6,"openBlockers":[2,3],"state":"OPEN"}
{"labels":["wayfinder:grilling"],"number":7,"openBlockers":[4,2],"state":"OPEN"}
{"labels":["wayfinder:grilling"],"number":8,"openBlockers":[4],"state":"OPEN"}
{"labels":["wayfinder:grilling"],"number":9,"openBlockers":[2,3],"state":"OPEN"}
{"labels":["wayfinder:prototype"],"number":10,"openBlockers":[7,5],"state":"OPEN"}
```

Frontier = `state == OPEN` und `openBlockers == []` (für groundhog zusätzlich Label `ready-for-agent`): hier #2, #3, #4. Die Reihenfolge der `subIssues.nodes` ist die Reihenfolge im Parent (änderbar per `reprioritizeSubIssue`).

Frontier über die Suche:

```console
$ gh issue list --search 'parent-issue:lucas-devries/groundhog#1' --json number --jq '[.[].number]'
[10,9,8,7,6,5,4,3,2]
$ gh issue list --search 'parent-issue:lucas-devries/groundhog#1 -is:blocked' --json number --jq '[.[].number]'
[4,3,2]
$ gh issue list --search 'parent-issue:lucas-devries/groundhog#1 is:blocked' --json number --jq '[.[].number]'
[10,9,8,7,6,5]
$ gh issue list --search 'blocked-by:lucas-devries/groundhog#4' --json number --jq '[.[].number]'
[8,7]
$ gh issue list --search 'blocked-by:4' --json number --jq '[.[].number]'
[]
```

`blocked-by:` braucht die volle Referenz `owner/repo#n`; die Kurzform `4` liefert stillschweigend nichts. Die Suche ist ein Index und kann der Wahrheit hinterherhinken (nicht gemessen); für die Engine ist die GraphQL-Abfrage die verlässlichere Quelle.

## 7. Lokale Frontier

Kein Werkzeug. Die Engine muss `.scratch/<feature-slug>/issues/*.md` selbst parsen: Nummer aus dem Dateinamen, Status aus der `Status:`-Zeile, Blocker aus der `Blocked by:`-Zeile. Die Wayfinder-Regel ist die einzige definierte Frontier-Regel des lokalen Trackers: "scan ... for files that are open, unblocked, and unclaimed; first by number wins" (`issue-tracker-local.md:28`).

## Prosa-Konventionen, die ein Parser nicht sicher lesen kann

1. **Spec vs. Ticket per Label.** Beide tragen `ready-for-agent` (`to-spec/SKILL.md:19`, `to-tickets/SKILL.md:63`). Unterscheidbar nur strukturell: die Spec ist der Parent (GitHub) bzw. `spec.md` (lokal). groundhog sollte die Spec immer explizit als Argument bekommen.
2. **Fehlende Spec-Verknüpfung auf GitHub.** Sub-Issues nur, wenn `/to-tickets` von einem Issue aus lief (`to-tickets/SKILL.md:63`). Sonst gibt es keine maschinenlesbare Zuordnung Ticket zu Spec.
3. **`## Parent`-Abschnitt** im Ticket-Body: "A reference to the parent issue", Form unbestimmt (`to-tickets/SKILL.md:86-88`).
4. **`Part of #<parent>`** als Rückfall ohne Sub-Issues (`issue-tracker-github.md:10`).
5. **`Blocked by` im GitHub-Body** als Rückfall ohne native Kanten: einmal als `## Blocked by`-Abschnitt mit Liste "a reference to each blocking ticket" (`to-tickets/SKILL.md:99-101`), einmal als Zeile `Blocked by: #<n>, #<n>` (`issue-tracker-github.md:11`). Zwei Formen; dazu der Text "None (can start immediately)".
6. **Lokale `**Blocked by:**`-Zeile** mit "numbers/titles" (`to-tickets/SKILL.md:75`), also Nummern oder Titel, frei formuliert, fett. Die Wayfinder-Form `Blocked by: NN, NN` (`issue-tracker-local.md:27`) ist die einzige halbwegs feste Syntax.
7. **Lokale `Status:`-Zeile**: "near the top", fett in der Vorlage (`**Status:** ready-for-agent`), ohne Fettdruck in der Tracker-Beschreibung (`issue-tracker-local.md:10`; `to-tickets/SKILL.md:77`).
8. **Lokal "erledigt"** ist für Implementierungs-Tickets undefiniert (Abschnitt 4).
9. **Label-Strings sind konfigurierbar** über eine Markdown-Tabelle in `docs/agents/triage-labels.md` (`triage-labels.md:5-15`). Wer andere Namen als die kanonischen benutzt, muss diese Tabelle parsen.
10. **"Closes work through PRs"** ist eine Eigenschaft des Trackers, die nirgends als Schalter steht (`implement-spec/SKILL.md:27`; keine Entsprechung in `issue-tracker-github.md`).
11. **Akzeptanzkriterien** sind `- [ ]`-Checkboxen ohne Prüfbarkeitsgarantie (`docs/engineering/to-tickets.md:76-77`); `/implement` hakt sie nicht ab (`docs/engineering/to-tickets.md:80`). Als Fortschrittssignal unbrauchbar, als Prompt-Inhalt brauchbar.
12. **`stateReason`** wird von den Skills ignoriert: ein als `NOT_PLANNED` geschlossener Blocker gibt seine Abhängigen genauso frei wie ein erledigter.
13. **Die Spec selbst** hat eine feste Abschnittsstruktur, aber nur als Prompt-Vorlage; ihr Inhalt ist für die Engine nicht maschinell relevant.

## Nicht verifiziert

- Ob `is:blocked` nur **offene** Blocker zählt: in der Doku nicht belegt, aber empirisch bestätigt (Nachtrag unten).
- Ob `gh issue view --json subIssues,blockedBy` bei mehr als 100 Einträgen paginiert. Bei den Grenzen (100 Sub-Issues, 50 Blocker) wahrscheinlich unkritisch.
- Wie schnell der Suchindex Änderungen an Dependencies übernimmt.
- Die Standard-Sortierung von `GET .../sub_issues` ist in der REST-Doku nicht angegeben; hier stimmte sie mit der Parent-Reihenfolge überein.
- Ob `subIssuesSummary.completed` als `NOT_PLANNED` geschlossene Sub-Issues mitzählt.
- Cross-Repo-Kanten: Sub-Issues müssen demselben Owner gehören ([REST sub-issues](https://docs.github.com/en/rest/issues/sub-issues)); für Dependencies keine Aussage gefunden.
- Die GraphQL-Referenzseite und die Such-Doku für `parent-issue:` konnten nicht gelesen werden; GraphQL per Introspection ersetzt, `parent-issue:` nur empirisch belegt.

## Nachtrag: Verhalten nach dem Schließen eines Blockers

Nach `gh issue close 4` (#8 war nur durch #4 blockiert), wenige Sekunden später:

```console
$ gh api repos/lucas-devries/groundhog/issues/8 --jq '{number,issue_dependencies_summary}'
{"issue_dependencies_summary":{"blocked_by":0,"blocking":0,"total_blocked_by":1,"total_blocking":0},"number":8}
$ gh issue view 4 --json state,stateReason
{"state":"CLOSED","stateReason":"COMPLETED"}
$ gh issue list --search 'parent-issue:lucas-devries/groundhog#1 -is:blocked' --json number --jq '[.[].number]'
[8,3,2]
$ gh issue view 1 --json subIssuesSummary
{"subIssuesSummary":{"completed":1,"percentCompleted":11,"total":9}}
```

Damit belegt: `issue_dependencies_summary.blocked_by` und `is:blocked` zählen nur **offene** Blocker; `total_blocked_by` zählt alle. Der Suchindex hatte die Änderung hier nach wenigen Sekunden übernommen. `gh issue close` ohne Grund setzt `stateReason: COMPLETED`.
