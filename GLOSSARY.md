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
Die offenen Tickets einer Spec, deren Blocker alle geschlossen sind.
_Avoid_: Queue, Ready-Liste

**Lauf**:
Eine Ausführung der Engine über eine Spec, vom Start bis kein Ticket mehr umsetzbar ist.
_Avoid_: Session, Job

**Run**:
Ein einzelner Agent-Aufruf an genau einem Ticket innerhalb eines Laufs.
_Avoid_: Session, Versuch, Iteration

**Ticket-Ablauf**:
Die feste Folge von Schritten, die jedes Ticket durchläuft. Für jedes Ticket identisch.
_Avoid_: Workflow, Pipeline

**Check**:
Eine deterministische Prüfung (Typen, Lint, Tests), die ein Ticket bestehen muss, bevor es als erledigt gilt.
_Avoid_: Gate, Validierung

**Integration-Branch**:
Der Branch, auf dem die Arbeit aller Tickets einer Spec zusammenläuft.
_Avoid_: Feature-Branch

**Ziel-Branch**:
Der Branch, in den die Engine den Integration-Branch am Ende eines Laufs mergen darf.
_Avoid_: Base-Branch
