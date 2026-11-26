# groundhog

The language of the engine that works through the tickets of a spec without humans.

Spec #25 and its tickets are written in German. Each entry names the former German term, so they stay readable.

## Language

**Engine**:
The deterministic part of groundhog that decides what happens next. It contains no LLM.
_Avoid_: Orchestrator, Loop, Agent

**Spec**:
The description of an undertaking that a set of tickets belongs to. The unit of work of a run.
_Avoid_: PRD, Plan, Feature

**Ready spec**:
An open spec with at least one ticket released for the agent, so that a run over it would have something to do.
_Avoid_: Open spec, active spec

**Ticket**:
A fully specified, vertical slice of a spec that can be implemented without asking back.
_Avoid_: Issue, Task, Story

**Task-Graph**:
The tickets of a spec together with their blocking relations.
_Avoid_: Backlog, ticket list

**Frontier**:
The open tickets of a spec that are released for the agent, whose blockers are all closed and that nobody else has claimed.
_Avoid_: Queue, ready list

**Tracker**:
The place where a spec and its tickets live. It is the single source of truth for the task-graph; the engine keeps no copy of its own.
_Avoid_: Project board, Backlog

**Run**:
One execution of the engine over a spec, from the start until no ticket can be implemented any more.
_Avoid_: Job, Lauf (former German term)

**Batch**:
The ordered specs a single start of groundhog works through, one run after another. It stops at the first run that does not end cleanly; the specs after it stay untouched.
_Avoid_: Queue, Chain, Multi-run

**Lock**:
The marker with which a run claims a clone for itself, so that no second run starts there.
_Avoid_: Lockfile, Sperre (former German term)

**Worktree**:
The working directory of a run, separate from the one a human works in. Every session and check on the spec's tickets happens there.
_Avoid_: Workspace, run directory, sandbox directory

**Session**:
A single agent call on exactly one ticket within a run.
_Avoid_: Run (the former German term, now taken by a whole run), Iteration

**AFK note**:
The fixed addition the engine hands every session, so that it runs to the end without humans.
_Avoid_: system prompt, extra prompt, AFK-Hinweis (former German term)

**Transcript**:
The continuous display of what the agent does in a session. A human can read it but cannot intervene in the session.
_Avoid_: Log, Stream, Mitschrift (former German term)

**Board**:
The fixed screen of a run in a terminal: at the top the state of the tickets, at the bottom the transcripts of the run's sessions, which a human can scroll back through.
_Avoid_: Dashboard, TUI, Tafel (former German term)

**Log**:
Everything a run keeps on the machine for good, so that a human can trace it afterwards.
_Avoid_: Logfile, Protokoll (former German term)

**Summary**:
The wrap-up at the end of a run: one result per ticket.
_Avoid_: Report, Übersicht (former German term)

**Sandbox**:
The boundary groundhog puts around a session and its checks, which decides what they can reach on the machine and on the network. The engine lies outside.
_Avoid_: Container, Isolation

**Block**:
A call of the agent in a session that was refused and not executed.
_Avoid_: Denial, Rejection, Verweigerung (former German term)

**Attempt**:
One pass of a session and the checks that follow it on a ticket. The number of attempts per ticket is limited.
_Avoid_: Retry, Versuch (former German term)

**Ticket flow**:
The fixed sequence of steps every ticket goes through. Identical for every ticket.
_Avoid_: Workflow, Pipeline, Ticket-Ablauf (former German term)

**Check**:
A deterministic verification (types, lint, tests) a ticket must pass before it counts as done.
_Avoid_: Gate, Validation

**Verification**:
One of the conditions by which the engine decides after a session whether an attempt is green: session successful, `HEAD` on the ticket branch, a new commit, clean working tree, plus every check.
_Avoid_: Test, Gate, Prüfung (former German term)

**Project config**:
The settings a project fixes for all of its runs.
_Avoid_: repo config, Settings, Projekt-Konfiguration (former German term)

**Integration branch**:
The branch on which the work of all tickets of a spec comes together.
_Avoid_: Feature branch, Integration-Branch (former German spelling)

**Ticket branch**:
The branch on which the work on exactly one ticket happens. It branches off the integration branch and only flows back there once the ticket has passed its checks.
_Avoid_: Feature branch, work branch, Ticket-Branch (former German spelling)

**Target branch**:
The branch into which the engine may merge the integration branch at the end of a run.
_Avoid_: Base branch, Ziel-Branch (former German term)

**Finish**:
What happens to the integration branch at the end of a run once all tickets of the spec are closed: merge into the target branch, PR or nothing (`merge`, `pr`, `none`). A human chooses it before the run.
_Avoid_: Finalization, merge mode, Abschluss (former German term)
