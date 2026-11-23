# Headless-Schnittstelle von Claude Code

Recherche zu Issue #3. Stand: 2026-11-23, lokal installiertes CLI `2.1.330 (Claude Code)`.

Quellen: offizielle Doku unter `code.claude.com/docs/en/...` (abgerufen am 2026-11-23), `claude --help` und kleine eigene Headless-Aufrufe. Eigene Beobachtungen sind als **[beobachtet]** markiert, Dinge, die ich nicht belegen konnte, als **[nicht verifiziert]**.

## Was für die Engine zählt

1. **Erfolg nicht am Exit-Code allein festmachen.** Exit 0 heißt nur, dass der Run regulär endete. Die Engine liest das abschließende `result`-Objekt (`--output-format json` oder die letzte Zeile von `stream-json`) und wertet `is_error`, `subtype` und `terminal_reason` aus. Ob das Ticket wirklich erledigt ist, entscheiden danach ausschließlich die Checks der Engine, nicht die Aussage des Agents.
2. **`subtype: "success"` ist kein Erfolg.** Ein fehlgeschlagener Login lieferte `subtype: "success"` zusammen mit `is_error: true` und Exit 1 **[beobachtet]**. Erfolg im Sinne der Engine ist also: Exit 0 **und** `is_error == false` **und** `subtype == "success"`, danach die Checks.
3. **Unbekannte Skills scheitern still.** `claude -p "/tp:nope"` endete mit Exit 0, `is_error: false`, und der Agent antwortete nur, der Skill sei nicht installiert **[beobachtet]**. Die Engine muss vorher prüfen, dass der Skill geladen ist: Das `system/init`-Event in `stream-json` listet `skills`, `slash_commands` und `plugins`.
4. **Als root nur mit `IS_SANDBOX=1`.** Bypass-Permissions verweigert den Start als root oder unter `sudo` mit Exit 1, außer in einer „recognized sandbox“ ([permission-modes](https://code.claude.com/docs/en/permission-modes.md)). Was als Sandbox zählt, steht nicht in der Doku. Im Binary 2.1.330 lautet die Bedingung `getuid()===0 && IS_SANDBOX!=="1" && !CLAUDE_CODE_BUBBLEWRAP` **[beobachtet im Binary, undokumentiert]**. Für die Debian-Box als root heißt das: entweder `IS_SANDBOX=1` setzen (undokumentiert, kann sich ändern) oder, wie die Doku empfiehlt, einen Nicht-root-User verwenden.
5. **Dauer begrenzt die Engine selbst.** Es gibt `--max-turns` und `--max-budget-usd`, aber kein Gesamt-Timeout für einen Run. Die Engine braucht einen eigenen Wall-Clock-Timeout und beendet den Prozess per SIGINT (beendet den Turn sauber) oder SIGTERM (Exit 143).
6. **Usage-Limits ohne Mensch:** `CLAUDE_CODE_RETRY_WATCHDOG=1` lässt Claude Code bei 429/529 unbegrenzt wiederholen und bei Abo-Usage-Limits bis zum Reset warten. Ohne die Variable scheitert der Run nach maximal 10 Retries.
7. **Kein `--bare`, wenn das Abo-Login genutzt wird.** `--bare` ist der empfohlene Skript-Modus, liest aber weder OAuth noch Keychain noch `CLAUDE_CODE_OAUTH_TOKEN`, sondern nur `ANTHROPIC_API_KEY` oder `apiKeyHelper`.
8. **Agent SDK oder CLI:** Das TypeScript-SDK startet intern genau dieses CLI als Subprozess und liefert dieselben Nachrichten als Typen. Es ist der bequemere Integrationspunkt, aber laut Doku nicht für claude.ai-Login gedacht (siehe unten). Für groundhog genügt das CLI mit `stream-json`.

## Aufruf

`claude -p "<prompt>"` (`--print`) startet einen nicht-interaktiven Run, druckt das Ergebnis und beendet sich ([headless](https://code.claude.com/docs/en/headless.md)). Nicht jede Option kombiniert mit `-p`; `--bg` wird abgelehnt.

Ohne `--bare` lädt `-p` alles wie eine interaktive Session: Hooks, Skills, Plugins, MCP-Server, CLAUDE.md, Auto-Memory aus dem Arbeitsverzeichnis und `~/.claude`. Es gibt keinen Workspace-Trust-Dialog; Hooks aus `.claude/settings.json` und Server aus `.mcp.json` des Repos laufen auch in nie vertrauten Ordnern ([headless](https://code.claude.com/docs/en/headless.md#start-faster-with-bare-mode); `claude --help` zu `-p`). Settings-Dateien, die die Validierung nicht bestehen, werden in `-p` stillschweigend ignoriert (`claude --help`).

Stdin: Ohne Pipe wartet `-p` drei Sekunden auf stdin und warnt auf stderr (`Warning: no stdin data received in 3s ...`) **[beobachtet]**. Die Engine startet den Prozess daher mit `< /dev/null` bzw. geschlossenem stdin. Gepipter stdin ist auf 10 MB begrenzt ([headless](https://code.claude.com/docs/en/headless.md#pipe-data-through-claude)).

## Ausgabeformate

`--output-format` mit `text` (Standard), `json` (ein Ergebnisobjekt) oder `stream-json` (NDJSON in Echtzeit) ([headless](https://code.claude.com/docs/en/headless.md#get-structured-output)). `stream-json` mit `-p` verlangt `--verbose`, sonst `Error: When using --print, --output-format=stream-json requires --verbose` und Exit 1 **[beobachtet]**.

### Ergebnisobjekt (`json` bzw. letzte Zeile von `stream-json`)

Typ `SDKResultMessage` ([TypeScript-Referenz](https://code.claude.com/docs/en/agent-sdk/typescript.md#sdkresultmessage)), zwei Varianten:

- `subtype: "success"`: mit `result` (Text), `is_error`, `num_turns`, `duration_ms`, `duration_api_ms`, `total_cost_usd`, `usage`, `modelUsage`, `permission_denials`, `stop_reason`, `session_id`, optional `structured_output`, `terminal_reason`, `api_error_status`.
- `subtype` ∈ `error_max_turns`, `error_during_execution`, `error_max_budget_usd`, `error_max_structured_output_retries`: ohne `result`, dafür `errors: string[]`, optional `startup_failure_reason`.

`terminal_reason` nennt, warum die Schleife endete, u. a. `completed`, `max_turns`, `budget_exhausted`, `api_error`, `model_error`, `prompt_too_long`, `hook_stopped`, `aborted_tools`, `turn_setup_failed` (vollständige Liste in der Referenz). `stop_reason` ist der Grund des letzten Modell-Turns (`end_turn`, `max_tokens`, `refusal`, …) ([agent-loop](https://code.claude.com/docs/en/agent-sdk/agent-loop.md#handle-the-result)).

Beobachtete Ergebnisse **[beobachtet]**:

| Fall | Exit | `subtype` | `is_error` | `terminal_reason` |
| - | - | - | - | - |
| normaler Run | 0 | `success` | false | `completed` |
| nicht eingeloggt (`--bare` ohne API-Key) | 1 | `success` | **true** | `api_error`, `result: "Not logged in · Please run /login"` |
| `--max-turns 1`, Aufgabe braucht ein Tool | 1 | `error_max_turns` | true | `max_turns`, `errors: ["Reached maximum number of turns (1)"]` |
| unbekannte Option | 1 | (kein JSON, nur stderr `error: unknown option`) | – | – |
| unbekannter Skill `/tp:nope` | 0 | `success` | false | `completed` |

Das JSON enthält zusätzlich undokumentierte Felder wie `subagent_stats` und `safety_stops` **[beobachtet]**; darauf sollte sich die Engine nicht verlassen.

### Events in `stream-json`

Jede Zeile ist ein JSON-Objekt; Haupttypen sind `system` (Subtypen `init`, `api_retry`, `hook_started`, `hook_response`, `permission_denied`, `plugin_install` …), `assistant`, `user`, `stream_event` (nur mit `--include-partial-messages`), `rate_limit_event` und am Ende `result` ([headless](https://code.claude.com/docs/en/headless.md#stream-responses)). Nach dem `result` können noch einzelne System-Events folgen; man liest den Stream bis zum Ende ([agent-loop](https://code.claude.com/docs/en/agent-sdk/agent-loop.md)).

- `system/init`: Modell, Tools, MCP-Server, `plugins`, `plugin_errors`, `mcp_server_errors`, `skills`, `slash_commands`, `permissionMode`, `claude_code_version`, `capabilities` ([headless](https://code.claude.com/docs/en/headless.md#read-session-metadata); Feldliste **[beobachtet]**). Die Doku empfiehlt ausdrücklich, auf `plugin_errors` und `mcp_server_errors` zu prüfen, weil fehlerhafte Plugins/Server den Run nicht abbrechen.
- `system/api_retry`: vor jedem Retry, mit `attempt`, `max_retries`, `retry_delay_ms`, `error_status` und `error` ∈ `rate_limit`, `overloaded`, `authentication_failed`, `billing_error`, `server_error`, … ([headless](https://code.claude.com/docs/en/headless.md#handle-api-retries)).
- `rate_limit_event`: `rate_limit_info.status` ∈ `allowed`, `allowed_warning`, `rejected`, mit `resetsAt` und `utilization` ([TypeScript-Referenz](https://code.claude.com/docs/en/agent-sdk/typescript.md#sdkratelimitevent)). Beobachtet zusätzlich `rateLimitType: "five_hour"` und `unifiedWindows` mit `five_hour`/`seven_day` **[beobachtet]**.
- Nachrichten von Subagents und geforkten Skills tragen `parent_tool_use_id`; mit `--forward-subagent-text` kommen auch deren Text- und Thinking-Blöcke ([headless](https://code.claude.com/docs/en/headless.md#follow-subagent-messages)).

`--json-schema '<schema>'` erzwingt strukturierte Ausgabe in `structured_output`; fehlt das Feld, gab es keine gültige Ausgabe ([headless](https://code.claude.com/docs/en/headless.md#get-structured-output)). Das wäre ein Weg, den Agent am Ende einen maschinenlesbaren Bericht (z. B. „fertig / blockiert, Grund“) liefern zu lassen.

## Exit-Codes

- 0 bei Erfolg, ungleich 0, wenn der Run scheitert; ungültige Flags meldet das CLI vor dem Start auf stderr; Fehler innerhalb des Runs (z. B. fehlende Authentifizierung) erscheinen als Ergebnis auf stdout ([headless](https://code.claude.com/docs/en/headless.md#basic-usage)).
- SIGTERM ergibt Exit 143; der laufende Turn bleibt unvollendet, ohne Ergebnis. SIGINT beendet stattdessen den Turn. Bei SIGTERM beendet Claude Code den Prozessbaum laufender Bash-Befehle und führt nur noch `SessionEnd`-Hooks aus ([headless](https://code.claude.com/docs/en/headless.md#stop-a-run-with-sigterm)).
- Bekannte Startfehler (z. B. ungültige `~/.claude.json`) erzeugen mit `CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1` ein `error_during_execution`-Ergebnis mit `startup_failure_reason` (u. a. `bypass_root`); ohne die Variable enden viele davon nur mit stderr und Exit ≠ 0 ([TypeScript-Referenz](https://code.claude.com/docs/en/agent-sdk/typescript.md#startup_failure_reason); [env-vars](https://code.claude.com/docs/en/env-vars.md)).
- Weitere Exit-Codes als 0, 1 und 143 sind nicht dokumentiert **[nicht verifiziert]**.

## Erfolg und Scheitern eines Runs erkennen

Vorschlag aus den Fakten oben:

1. Prozess endet mit Exit 143 oder durch den Engine-Timeout → Run abgebrochen.
2. Kein parsebares `result` → Startfehler; stderr protokollieren.
3. `is_error == true` oder `subtype != "success"` → Run gescheitert; `subtype`, `terminal_reason`, `errors`, `api_error_status` protokollieren. Usage-/Rate-Limits erkennt man an `api_retry`-Events mit `error: "rate_limit"` bzw. an `rate_limit_event` mit `status: "rejected"`.
4. Sonst → Run beendet; ob das Ticket erledigt ist, entscheiden die Checks (und ggf. `structured_output`).
5. `permission_denials` nicht leer → Hinweis, dass der Agent an Rechten scheiterte.

Achtung: Ein Subagent-Befehl, der beim Timeout in den Hintergrund wandert, kann dazu führen, dass `-p` mit Exit 0 endet, bevor der Befehl fertig ist ([headless](https://code.claude.com/docs/en/headless.md#give-a-long-subagent-command-more-time)). Auch deshalb gehören die Checks in die Engine.

## Skills und Plugins im Headless-Modus

- Vom Nutzer aufrufbare Skills und Custom Commands funktionieren in `-p`: `/skill-name` in den Prompt schreiben, Claude Code expandiert ihn vor dem Run. Terminal-only-Befehle wie `/login` gibt es nicht ([headless](https://code.claude.com/docs/en/headless.md#create-a-commit)).
- Plugin-Skills heißen `/plugin-name:skill-name` ([skills](https://code.claude.com/docs/en/skills.md)), also z. B. `/mattpocock-skills:tdd`. Im `init`-Event dieser Maschine stand `mattpocock-skills:tdd` in `skills` und `slash_commands` **[beobachtet]**.
- Test mit einem Wegwerf-Plugin über `--plugin-dir` und einem Skill mit `disable-model-invocation: true`: `claude -p "/tp:echo" --plugin-dir ./tp` lieferte genau die im Skill verlangte Antwort, Exit 0 **[beobachtet]**. Ein Skill mit `disable-model-invocation: true` lässt sich also headless explizit aufrufen.
- Plugins lassen sich pro Run mit `--plugin-dir <pfad>` (wiederholbar, auch `.zip`) oder `--plugin-url` laden, ohne sie zu installieren (`claude --help`; [cli-reference](https://code.claude.com/docs/en/cli-reference.md)). Damit kann die Engine die Matt-Pocock-Skills reproduzierbar mitgeben, statt sich auf die Installation in `~/.claude` zu verlassen.
- `--bare` überspringt installierte Plugins und Skills; per `--plugin-dir` übergebene Plugins und Skills aus `--add-dir`-Verzeichnissen laden aber weiter. Hooks laufen in `--bare` nie, auch nicht die von per Flag geladenen Plugins ([headless](https://code.claude.com/docs/en/headless.md#start-faster-with-bare-mode)).
- Geforkte Skills (`context: fork`) liefern ihre Nachrichten mit `parent_tool_use_id` mit Präfix `forked-command-`, wenn sie über den Prompt gestartet werden ([headless](https://code.claude.com/docs/en/headless.md#follow-subagent-messages)).
- `--disable-slash-commands` schaltet alle Skills und Commands ab (`claude --help`).

## Bypass-Permissions

- `--dangerously-skip-permissions` ist gleichbedeutend mit `--permission-mode bypassPermissions` ([cli-reference](https://code.claude.com/docs/en/cli-reference.md)). `permissionMode` im `init`-Event zeigte damit `bypassPermissions` **[beobachtet]**. Im nicht-interaktiven Modus erscheint kein Bestätigungsdialog ([permission-modes](https://code.claude.com/docs/en/permission-modes.md)).
- Ohne gesetzten Modus starten `-p`-Runs ab v2.1.302 in Manual (`default`): Was eine Freigabe bräuchte, wird abgelehnt ([permission-modes](https://code.claude.com/docs/en/permission-modes.md)). Ein `defaultMode` in den User-Settings greift auch headless: Auf dieser Maschine startete `-p` ohne Flag in `auto`, weil `~/.claude/settings.json` `"defaultMode": "auto"` setzt **[beobachtet]**. Die Engine sollte den Modus daher immer explizit übergeben.
- Was Bypass trotzdem nicht durchwinkt: explizite `ask`-Regeln, `AskUserQuestion` und MCP-Tools mit `requiresUserInteraction`, erkannte `rm`/`rmdir` auf kritische Pfade ([permission-modes](https://code.claude.com/docs/en/permission-modes.md)). Mit `--permission-prompts none` werden solche Anfragen sofort abgelehnt statt auf einen Host zu warten, und `AskUserQuestion` wird entfernt ([headless](https://code.claude.com/docs/en/headless.md#turn-off-permission-prompts-in-unattended-runs)). Für die Engine sinnvoll, damit kein Run auf eine Antwort wartet.
- Hooks laufen auch im Bypass-Modus und können blockieren ([agent-sdk/permissions](https://code.claude.com/docs/en/agent-sdk/permissions.md)).
- **root:** „On Linux and macOS, Claude Code refuses to start in `bypassPermissions` mode when running as root or under `sudo`“ mit `--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons`; „The check is skipped automatically inside a recognized sandbox“ ([permission-modes](https://code.claude.com/docs/en/permission-modes.md)). Die Doku empfiehlt den Dev-Container mit Nicht-root-User ([devcontainer](https://code.claude.com/docs/en/devcontainer.md)). Die Sandbox-Erkennung ist nicht dokumentiert; im Binary 2.1.330 prüft der Startpfad `process.getuid()===0 && process.env.IS_SANDBOX!=="1" && !CLAUDE_CODE_BUBBLEWRAP` und beendet sich dann mit Exit 1 **[beobachtet im Binary]**. Einen Lauf als root mit `IS_SANDBOX=1` habe ich nicht ausgeführt **[nicht verifiziert]**.
- Weitere Sperren: `--restricted` und `permissions.disableBypassPermissionsMode: "disable"` in Managed Settings verbieten Bypass ([permission-modes](https://code.claude.com/docs/en/permission-modes.md)).
- Die Doku empfiehlt Bypass nur in isolierten Containern/VMs, idealerweise ohne Internet; auch ein Dev-Container verhindert nicht, dass ein bösartiges Projekt die Claude-Credentials in `~/.claude` abzieht ([devcontainer](https://code.claude.com/docs/en/devcontainer.md)).

## Limits für Dauer und Turns

- `--max-turns <n>`: begrenzt agentische Turns, nur mit `-p`, Standard unbegrenzt ([cli-reference](https://code.claude.com/docs/en/cli-reference.md)). Das Flag fehlt in `claude --help` 2.1.330, funktioniert aber **[beobachtet]**. Beim Erreichen: `error_max_turns`, Exit 1. Jeder Turn mit Tool-Aufrufen zählt, plus einer für die abschließende Antwort ([agent-loop](https://code.claude.com/docs/en/agent-sdk/agent-loop.md)); beobachtet wurde bei `--max-turns 1` `num_turns: 2` **[beobachtet]**.
- `--max-budget-usd <betrag>`: stoppt nach geschätzten Kosten, nur `-p`; der Wert kann um eine Antwort überschritten werden ([cli-reference](https://code.claude.com/docs/en/cli-reference.md); [agent-loop](https://code.claude.com/docs/en/agent-sdk/agent-loop.md#budget-headroom)).
- Kein Gesamt-Timeout für einen Run in Doku oder `--help` gefunden **[nicht verifiziert, dass keiner existiert]**.
- Teil-Timeouts per Env-Var ([env-vars](https://code.claude.com/docs/en/env-vars.md)): `BASH_DEFAULT_TIMEOUT_MS` (Standard 120000), `BASH_MAX_TIMEOUT_MS` (Standard 600000), `API_TIMEOUT_MS` (Standard 600000, nur bis zu den Response-Headern), `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` (Standard 600000: so lange wartet `-p` nach dem letzten Turn auf Hintergrundarbeit, `0` = unbegrenzt).
- Hintergrundarbeit: `-p` bleibt offen, solange vom Hauptgespräch gestartete Hintergrundbefehle laufen; `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` schaltet Hintergrundausführung ab ([headless](https://code.claude.com/docs/en/headless.md#background-tasks-at-exit); [env-vars](https://code.claude.com/docs/en/env-vars.md)).

## Rate-Limits und Usage-Limits

- Claude Code wiederholt transiente Fehler (darunter 429-Throttles und 529 Overloaded) bis zu 10-mal mit exponentiellem Backoff; `CLAUDE_CODE_MAX_RETRIES` ändert das (Deckel 15) ([errors](https://code.claude.com/docs/en/errors.md); [env-vars](https://code.claude.com/docs/en/env-vars.md)).
- `CLAUDE_CODE_RETRY_WATCHDOG=1` ist für unbeaufsichtigte Runs gedacht: unbegrenzte Retries bei 429/529, Backoff bis 5 Minuten oder bis zum gemeldeten Reset, „so a session that hits a usage limit waits out the remaining window“; andere transiente Fehler bis zu 300 Retries (~3 Stunden). Ein 429 wegen Spend-Limit oder aufgebrauchter Usage-Credits scheitert sofort ([env-vars](https://code.claude.com/docs/en/env-vars.md)). `CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS` begrenzt das Warten auf den Reset eines Abo-Limits (ab v2.1.301) ([errors](https://code.claude.com/docs/en/errors.md)).
- Abo-Limits („You've hit your session limit · resets 3:45pm“, Weekly, Opus, Sonnet) blockieren bis zum Reset; das automatische Warten in der Session ist für interaktive Sessions beschrieben ([errors](https://code.claude.com/docs/en/errors.md#youve-hit-your-session-limit)). Wie das `result` eines `-p`-Runs ohne Watchdog genau aussieht, wenn ein Abo-Limit erreicht ist, habe ich nicht beobachtet **[nicht verifiziert]**; erwartbar ist `is_error: true` mit der Meldung im `result`.
- `--fallback-model sonnet,haiku` weicht bei Überlast oder Nichtverfügbarkeit auf andere Modelle aus ([cli-reference](https://code.claude.com/docs/en/cli-reference.md)); bei modellfamilienspezifischen Limits (Opus/Sonnet) hilft ein Modellwechsel, bei Session-/Weekly-Limit nicht ([errors](https://code.claude.com/docs/en/errors.md#youve-hit-your-session-limit)).

Folgerung für die Engine: Mit Watchdog wartet ein Run selbst das Limit ab; der Engine-Timeout muss das berücksichtigen oder die Engine wertet `rate_limit_event`/`api_retry` aus und pausiert selbst.

## Session-Resume

- `--resume <session-id>` setzt eine bestimmte Session fort, `--continue` die jüngste im Verzeichnis; die ID steht in `session_id` des Ergebnisses. `--resume` sucht die ID in allen Projekten der Maschine und akzeptiert auch den Pfad zur `.jsonl`-Transkriptdatei ([headless](https://code.claude.com/docs/en/headless.md#continue-conversations); [cli-reference](https://code.claude.com/docs/en/cli-reference.md)).
- `--session-id <uuid>` legt die ID vorab fest; die Engine kann sie also selbst vergeben und protokollieren ([cli-reference](https://code.claude.com/docs/en/cli-reference.md)).
- `--fork-session` erzeugt beim Fortsetzen eine neue ID. `--no-session-persistence` bzw. `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1` speichern nichts, dann ist kein Resume möglich ([cli-reference](https://code.claude.com/docs/en/cli-reference.md); [env-vars](https://code.claude.com/docs/en/env-vars.md)).
- Nach SIGTERM bleibt der unterbrochene Turn beim Resume liegen; `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` setzt ihn fort ([headless](https://code.claude.com/docs/en/headless.md#stop-a-run-with-sigterm)).
- Kosten in `total_cost_usd` sind nach Resume kumuliert über die ganze Konversation ([headless](https://code.claude.com/docs/en/headless.md#pipe-data-through-claude)).

## Authentifizierung auf einer Box ohne Browser

- `claude setup-token` erzeugt ein einjähriges OAuth-Token für Abo-Nutzer; als `CLAUDE_CODE_OAUTH_TOKEN` setzen ([authentication](https://code.claude.com/docs/en/authentication.md)). `--bare` liest dieses Token nicht.
- `ANTHROPIC_API_KEY` funktioniert immer, auch mit `--bare`.
- Das Ergebnis meldet bei claude.ai-Login `credential_expires_at`, damit die Engine ein bald ablaufendes Login erkennen kann ([TypeScript-Referenz](https://code.claude.com/docs/en/agent-sdk/typescript.md#sdkresultmessage)).

## Weitere relevante Flags und Variablen

| Flag / Variable | Zweck | Quelle |
| - | - | - |
| `--append-system-prompt`, `--system-prompt` | Ticket-Kontext/Regeln mitgeben | [cli-reference](https://code.claude.com/docs/en/cli-reference.md) |
| `--model`, `--effort` | Modell und Effort pro Run | `claude --help` |
| `--allowedTools`, `--disallowedTools`, `--tools` | Tool-Auswahl (auch im Bypass-Modus `--disallowedTools` sinnvoll) | `claude --help` |
| `--settings`, `--setting-sources` | Settings explizit setzen, User-Settings ausblenden | [cli-reference](https://code.claude.com/docs/en/cli-reference.md) |
| `--mcp-config`, `--strict-mcp-config` | nur explizite MCP-Server | `claude --help` |
| `--permission-prompts none` | nie auf Freigaben warten | [headless](https://code.claude.com/docs/en/headless.md) |
| `--debug-file <pfad>` | Debug-Log pro Run | `claude --help` |
| `DISABLE_AUTOUPDATER=1` | kein Update mitten im Lauf | [env-vars](https://code.claude.com/docs/en/env-vars.md) |
| `CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1` | Startfehler als `result` | [env-vars](https://code.claude.com/docs/en/env-vars.md) |

## Agent SDK (TypeScript) statt CLI?

- Das SDK „spawns a separate `claude` CLI process and talks to it over stdio“; es bündelt ein natives Claude-Code-Binary als optionale Abhängigkeit ([hosting](https://code.claude.com/docs/en/agent-sdk/hosting.md); [TypeScript-Referenz](https://code.claude.com/docs/en/agent-sdk/typescript.md)). Funktional ist es dieselbe Schnittstelle: dieselben Nachrichtentypen wie `stream-json`, Optionen `maxTurns`, `maxBudgetUsd`, `permissionMode`, `allowDangerouslySkipPermissions` (Pflicht für Bypass), `settingSources`, `plugins`, `abortController`, `env`, `pathToClaudeCodeExecutable`, `spawnClaudeCodeProcess` (z. B. für Container).
- Vorteile: typisierte Nachrichten, `canUseTool`-Callback, `interrupt()`, Abbruch per `AbortController`, kein eigenes NDJSON-Parsing. Bei Fehler-Ergebnissen wirft `query()` nach dem Ergebnis eine Exception ([agent-loop](https://code.claude.com/docs/en/agent-sdk/agent-loop.md#handle-the-result)).
- Root-Sperre gilt auch dort: „Can't be used when running as root on Unix“ ([agent-loop](https://code.claude.com/docs/en/agent-sdk/agent-loop.md)).
- **Wichtig:** „Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods …“ ([overview](https://code.claude.com/docs/en/agent-sdk/overview.md)). Ob das für ein privates Werkzeug des Abo-Inhabers selbst gilt, sagt die Doku nicht **[nicht verifiziert]**. Das CLI mit eigenem Abo-Login ist dagegen der normale Gebrauch.
- Einschätzung: Für groundhog (ein Run zur Zeit, Engine als eigener Prozess, Abo-Login wahrscheinlich) ist `claude -p --output-format stream-json --verbose` ausreichend und hält die Engine unabhängig von der SDK-Version. Das SDK lohnt sich, wenn die Engine Tool-Freigaben programmatisch entscheiden oder Runs per `interrupt()` steuern soll, oder wenn ohnehin ein API-Key verwendet wird.

## Offene Punkte

- Sandbox-Erkennung für root (`IS_SANDBOX=1`) ist undokumentiert und nur aus dem Binary gelesen; nicht als root ausprobiert.
- Genaue Form des `result` bei erreichtem Abo-Usage-Limit in `-p` nicht beobachtet.
- Ob es Exit-Codes außer 0, 1 und 143 gibt, ist nicht dokumentiert.
- `--max-turns` ist in `claude --help` 2.1.330 nicht gelistet; dokumentiert und funktionsfähig, aber das Fehlen in der Hilfe könnte auf eine künftige Änderung hindeuten.
- Ob die SDK-Einschränkung zum claude.ai-Login ein privates Werkzeug betrifft.
