# groundhog

Die Sprache der Engine, die die Tickets einer Spec ohne Menschen abarbeitet.

## Language

**Engine**:
Der deterministische Teil von groundhog, der entscheidet, was als Nächstes geschieht. Sie enthält kein LLM.
_Avoid_: Orchestrator, Loop, Agent

**Spec**:
Die Beschreibung eines Vorhabens, zu der ein Satz Tickets gehört. Die Arbeitseinheit eines Laufs.
_Avoid_: PRD, Plan, Feature

**Ticket**:
Eine fertig spezifizierte, vertikale Scheibe einer Spec, die ohne Rückfragen umsetzbar ist.
_Avoid_: Issue, Task, Story

**Task-Graph**:
Die Tickets einer Spec zusammen mit ihren Blocking-Beziehungen.
_Avoid_: Backlog, Ticketliste

**Frontier**:
Die offenen, für den Agent freigegebenen Tickets einer Spec, deren Blocker alle geschlossen sind und die kein anderer beansprucht hat.
_Avoid_: Queue, Ready-Liste

**Tracker**:
Der Ort, an dem eine Spec und ihre Tickets liegen. Er ist die einzige Quelle der Wahrheit für den Task-Graph; die Engine führt kein eigenes Abbild.
_Avoid_: Board, Backlog

**Lauf**:
Eine Ausführung der Engine über eine Spec, vom Start bis kein Ticket mehr umsetzbar ist.
_Avoid_: Session, Job

**Sperre**:
Die Markierung, mit der ein Lauf einen Klon für sich belegt, sodass dort kein zweiter Lauf startet.
_Avoid_: Lock, Lockfile

**Run**:
Ein einzelner Agent-Aufruf an genau einem Ticket innerhalb eines Laufs.
_Avoid_: Session, Iteration

**AFK-Hinweis**:
Der feste Zusatz, den die Engine jedem Run mitgibt, damit er ohne Menschen zu Ende läuft.
_Avoid_: System-Prompt, Zusatz-Prompt

**Mitschrift**:
Die fortlaufende Anzeige dessen, was der Agent in einem Run tut. Ein Mensch kann sie lesen, aber nicht in den Run eingreifen.
_Avoid_: Log, Transcript, Stream

**Protokoll**:
Alles, was ein Lauf dauerhaft auf dem Rechner festhält, sodass ein Mensch ihn nachträglich nachvollziehen kann.
_Avoid_: Log, Logdatei

**Übersicht**:
Die Zusammenfassung am Ende eines Laufs: je Ticket ein Ergebnis.
_Avoid_: Report, Summary

**Sandbox**:
Die Grenze, die groundhog um einen Run und seine Checks legt und die bestimmt, was sie auf dem Rechner und im Netz erreichen. Die Engine liegt außerhalb.
_Avoid_: Container, Abschottung, Isolation

**Block**:
Ein Aufruf des Agents in einem Run, der verweigert und nicht ausgeführt wurde.
_Avoid_: Denial, Verweigerung, Ablehnung

**Versuch**:
Ein Durchgang aus einem Run und den anschließenden Checks an einem Ticket. Die Zahl der Versuche pro Ticket ist begrenzt.
_Avoid_: Retry, Anlauf

**Ticket-Ablauf**:
Die feste Folge von Schritten, die jedes Ticket durchläuft. Für jedes Ticket identisch.
_Avoid_: Workflow, Pipeline

**Check**:
Eine deterministische Prüfung (Typen, Lint, Tests), die ein Ticket bestehen muss, bevor es als erledigt gilt.
_Avoid_: Gate, Validierung

**Projekt-Konfiguration**:
Die Einstellungen, die ein Projekt für alle seine Läufe festlegt.
_Avoid_: Repo-Konfiguration, Config, Settings

**Integration-Branch**:
Der Branch, auf dem die Arbeit aller Tickets einer Spec zusammenläuft.
_Avoid_: Feature-Branch

**Ticket-Branch**:
Der Branch, auf dem die Arbeit an genau einem Ticket entsteht. Er zweigt vom Integration-Branch ab und fließt erst dorthin zurück, wenn das Ticket seine Checks bestanden hat.
_Avoid_: Feature-Branch, Arbeits-Branch

**Ziel-Branch**:
Der Branch, in den die Engine den Integration-Branch am Ende eines Laufs mergen darf.
_Avoid_: Base-Branch

**Abschluss**:
Was am Ende eines Laufs mit dem Integration-Branch geschieht, sobald alle Tickets der Spec geschlossen sind: Merge in den Ziel-Branch, PR oder nichts. Ein Mensch wählt ihn vor dem Lauf.
_Avoid_: Finalisierung, Merge-Modus
