# Usage-Limit bei `claude -p` erkennen

Recherche zu Issue #11. Stand: 2026-11-24, lokal installiertes CLI `2.1.331 (Claude Code)`. Baut auf [`claude-code-headless.md`](https://github.com/lucas-devries/groundhog/blob/research/claude-code-headless/docs/research/claude-code-headless.md) (Issue #3) auf und wiederholt dessen Grundlagen (Ergebnisobjekt, Events, Exit-Codes) nicht.

Quellen: offizielle Doku unter `code.claude.com/docs/en/...` und der Changelog im Repo `anthropics/claude-code` (beide abgerufen am 2026-11-24), GitHub-Issues von `anthropics/claude-code`, eigene Experimente. Das echte Abo-Limit habe ich nicht provoziert. Stattdessen lief `claude -p` gegen einen lokalen Mock von `/v1/messages`, der mit einem 429 und den Rate-Limit-Headern antwortet, die in den Issues [#103820](https://github.com/anthropics/claude-code/issues/103820) und [#104690](https://github.com/anthropics/claude-code/issues/104690) aus echten Antworten zitiert sind (isoliertes `HOME`/`CLAUDE_CONFIG_DIR`, Dummy-OAuth-Token, `ANTHROPIC_BASE_URL` auf den Mock). Markierungen: **[beobachtet]** = gegen das echte Konto gesehen, **[Mock]** = gegen den Mock gesehen, **[undokumentiert]** = beobachtet, aber in keiner Doku beschrieben, **[nicht verifiziert]** = weder belegt noch beobachtet.

## Was für die Engine zählt

1. **Exit-Code und `is_error` reichen nicht.** Ein Limit-Abbruch endet mit Exit 1, `is_error: true`, `subtype: "success"`, `terminal_reason: "api_error"`, `api_error_status: 429` **[Mock]**. Genauso endet ein gewöhnlicher Server-Throttle (429 ohne Abo-Bezug) **[Mock]**. Unterscheiden lässt sich beides nur an weiteren Feldern.
2. **Das verlässlichste Merkmal ist `api_error: "usage_limit_reached"`** auf dem `result` und auf der synthetischen `assistant`-Nachricht **[Mock, undokumentiert]**. Beim Server-Throttle ist es `null` **[Mock]**.
3. **Die Reset-Zeit steht als `resetsAt` (Unix-Epoch-Sekunden)** im `rate_limit_event` mit `status: "rejected"` und, identisch, in `api_error_params.rate_limit_info` der `assistant`-Nachricht. Das Feld `resetsAt` ist dokumentiert ([TypeScript-Referenz](https://code.claude.com/docs/en/agent-sdk/typescript.md#sdkratelimitevent)), seine Einheit aber nur indirekt über die Statusline-Doku (`resets_at` in Epoch-Sekunden, [statusline](https://code.claude.com/docs/en/statusline.md)). Der Wert entsprach im Mock exakt dem Header `anthropic-ratelimit-unified-reset` **[Mock]**.
4. **Deshalb `--output-format stream-json`.** Mit `--output-format json` kommt nur das `result`: Es trägt `api_error`, aber kein `resetsAt`, nur den lokalisierten Text `"You've hit your limit · resets 7:59pm (Europe/Berlin)"` **[Mock]**.
5. **Nie den Text parsen.** Der Wortlaut weicht schon heute von der Doku ab und hängt von Header-Details ab (siehe unten). Die Uhrzeit ist lokalisiert und ohne Datum, wenn der Reset am selben Tag liegt.
6. **Die Engine wartet selbst, nicht der Watchdog.** `CLAUDE_CODE_RETRY_WATCHDOG=1` wartet zwar bis zum Reset, aber dann hängt ein Run stundenlang in sich, kollidiert mit dem Wall-Clock-Timeout der Engine und hat einen offenen Bug, bei dem er gar nicht wartet ([#104690](https://github.com/anthropics/claude-code/issues/104690), in 2.1.331 reproduziert **[Mock]**). Ohne Watchdog endet der Run am Limit sofort (60 ms im Mock) **[Mock]**.
7. **Fallbacks einplanen.** Ein offener Bug lässt `claude -p` in langen Sessions mit Exit 1 enden, ohne irgendein Limit-Event auf stdout ([#103820](https://github.com/anthropics/claude-code/issues/103820)). Dann helfen das Transkript (`quotaLimits.resetsAt`) oder eine Abfrage mit `claude -p "/usage"`, die kein Modell aufruft und nichts kostet **[beobachtet]**.

## Was die Doku sagt

- **Fehlertexte.** Abo-Limits erscheinen als `You've hit your session limit · resets 3:45pm`, `You've hit your weekly limit · resets Mon 12:00am`, `You've hit your Opus limit · resets 3:45pm`, `You've hit your Sonnet limit · resets 3:45pm`. Claude Code blockiert bis zur genannten Zeit. Session- und Weekly-Limit gelten für alle Modelle, Opus- und Sonnet-Limit nur für die jeweilige Modellfamilie ([errors](https://code.claude.com/docs/en/errors.md#youve-hit-your-session-limit)).
- **Automatisches Warten nur interaktiv.** „In an interactive session signed in with a claude.ai subscription, Claude Code can also wait in the open session and continue“ ([errors](https://code.claude.com/docs/en/errors.md#youve-hit-your-session-limit); [interactive-mode](https://code.claude.com/docs/en/interactive-mode.md#wait-for-a-usage-limit-to-reset)). Für `-p` beschreibt die Doku das nicht; im Mock endete `-p` sofort **[Mock]**.
- **`rate_limit_event`** ([TypeScript-Referenz](https://code.claude.com/docs/en/agent-sdk/typescript.md#sdkratelimitevent)): `rate_limit_info.status` ∈ `allowed`, `allowed_warning`, `rejected`, optional `resetsAt`, `utilization`, `overageEnabled`. Bei `errorCode: "credits_required"` ist das Inklusiv-Kontingent eines claude.ai-Abos erschöpft und die Session kann erst nach Kauf von Usage-Credits weiter (ab v2.1.181). Die Einheit von `resetsAt` nennt die Referenz nicht.
- **`assistant.error`** (`SDKAssistantMessageError`): „A 429 against your quota is `'rate_limit'`“; ein 529 ist `'overloaded'` bzw. `'server_error'` ([TypeScript-Referenz](https://code.claude.com/docs/en/agent-sdk/typescript.md#sdkassistantmessage)). Derselbe Wert steht als `error` in `system/api_retry` ([headless](https://code.claude.com/docs/en/headless.md#handle-api-retries)). `'rate_limit'` deckt aber auch den Server-Throttle ab (siehe Experimente), unterscheidet also nicht.
- **`result`**: `api_error_status` ist der HTTP-Status des API-Fehlers, der die Konversation beendete; `terminal_reason: "api_error"` ([TypeScript-Referenz](https://code.claude.com/docs/en/agent-sdk/typescript.md#sdkresultmessage)). Ein Feld, das Abo-Limit und anderen 429 trennt, ist dort nicht dokumentiert.
- **Server-Throttle vs. Abo-Limit.** `API Error: Server is temporarily limiting requests (not your usage limit)`; Claude Code unterscheidet beides „by the absence of the unified quota headers a real limit response carries“ und wiederholt den Throttle automatisch ([errors](https://code.claude.com/docs/en/errors.md#server-is-temporarily-limiting-requests)).
- **Spend-Limit.** `You've hit your monthly spend limit · …` heißt, dass Usage-Credits ihr Limit erreicht haben; wenn eigentlich ein Abo-Fenster abgelaufen ist, hängt die Meldung `· your session limit resets 3:45pm` an ([errors](https://code.claude.com/docs/en/errors.md#youve-hit-your-monthly-spend-limit)).
- **Watchdog** ([env-vars](https://code.claude.com/docs/en/env-vars.md); [errors](https://code.claude.com/docs/en/errors.md#tune-retry-behavior)): `CLAUDE_CODE_RETRY_WATCHDOG=1` wiederholt 429/529 unbegrenzt und wartet bis zum Reset, „so a session that hits a usage limit waits out the remaining window“. Ein 429, der ein Spend-Limit oder erschöpfte Usage-Credits meldet, scheitert sofort. Begrenzen lässt sich das mit `CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS` (pro Request, ab v2.1.295) und `CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS` (liegt der Reset weiter weg, scheitert der Request sofort, ab v2.1.301). `CLAUDE_CODE_RETRY_WATCHDOG_USAGE_LIMIT_RECHECK_MS` prüft während des Wartens, ob das Limit früher aufgehoben wurde (ab v2.1.305).
- **`/usage` headless.** Als Prompt an `-p` übergeben, kommt die Ausgabe als `assistant`-Nachricht mit `usage_report.rate_limits.limits[]`: je Zeile `kind` (`session`, `weekly_all`, `weekly_scoped` …), `percent` (0–100), `resets_at` (ISO 8601), `severity`, `is_active`. Der Typ ist ausdrücklich experimentell ([TypeScript-Referenz](https://code.claude.com/docs/en/agent-sdk/typescript.md#sdkusagereport)). `rate_limits` ist `null`, wenn der OAuth-Token keinen `user:profile`-Scope hat.
- **Exit-Code.** Nur „ungleich 0, wenn der Run scheitert“ ([headless](https://code.claude.com/docs/en/headless.md#basic-usage)). Einen eigenen Exit-Code für Limits gibt es laut Doku nicht.

Die Doku schweigt zu: `api_error`, `api_error_params`, `rateLimitType`, `overageStatus`, `overageDisabledReason`, `unifiedWindows`, der genauen Ereignisfolge am Limit in `-p` und dazu, welches Fenster `resetsAt` meint, wenn mehrere erschöpft sind.

## Experimente gegen einen Mock

Aufbau: Node-Server auf `127.0.0.1` antwortet auf `POST /v1/messages` mit 429, Body `{"type":"error","error":{"type":"rate_limit_error",…}}` und den Headern `anthropic-ratelimit-unified-status: rejected`, `anthropic-ratelimit-unified-reset: <epoch>`, `anthropic-ratelimit-unified-representative-claim: <fenster>`, `anthropic-ratelimit-unified-overage-status: rejected`, optional `anthropic-ratelimit-unified-overage-disabled-reason`, plus `retry-after`. Aufruf `claude -p "say hi" --output-format stream-json --verbose --model opus < /dev/null` mit leerer Umgebung (`env -i`) und isoliertem Konfigurationsverzeichnis. Header-Namen und -Werte stammen aus den Issues, nicht aus eigener Beobachtung einer echten Limit-Antwort.

### Ohne Watchdog: Abo-Limit (`five_hour`)

Exit 1, stderr leer, Laufzeit 61 ms **[Mock]**. Auf stdout nach `system/init` genau drei Zeilen (gekürzt):

```json
{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1795546773,"rateLimitType":"five_hour","overageStatus":"rejected","isUsingOverage":false}}
{"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text","text":"You've hit your limit · resets 7:59pm (Europe/Berlin)"}],…},"error":"rate_limit","is_api_error_message":true,"api_error_status":429,"api_error":"usage_limit_reached","api_error_params":{"rate_limit_info":{"status":"rejected","resetsAt":1795546773,"rateLimitType":"five_hour",…}},"api_error_type":"rate_limit_error",…}
{"type":"result","subtype":"success","is_error":true,"terminal_reason":"api_error","api_error_status":429,"api_error_type":"rate_limit_error","api_error":"usage_limit_reached","result":"You've hit your limit · resets 7:59pm (Europe/Berlin)","num_turns":1,"total_cost_usd":0,…}
```

`resetsAt` war genau der Header-Wert (jetzt + 7200 s), die Uhrzeit im Text die lokale Darstellung davon **[Mock]**. Das deckt sich mit der Ausgabe, die [#103820](https://github.com/anthropics/claude-code/issues/103820) für 2.1.304 zeigt.

### Weitere Fälle

| Fall | Exit | `api_error` | `rate_limit_event` | Text in `result` |
| - | - | - | - | - |
| `five_hour`, `--output-format json` | 1 | `usage_limit_reached` | – (nur `result` auf stdout) | `You've hit your limit · resets 7:59pm (Europe/Berlin)` |
| `five_hour`, `--output-format text` | 1 | – | – | nur der Text auf stdout |
| `seven_day` | 1 | `usage_limit_reached` | `rejected`, `rateLimitType: "seven_day"`, `resetsAt` | `You've hit your limit · resets Nov 27 at 1:33am (Europe/Berlin)` |
| `seven_day_opus` | 1 | `usage_limit_reached` | `rejected`, `rateLimitType: "seven_day_opus"`, `resetsAt` | `You've hit your limit · resets Nov 25 at 6:59pm (Europe/Berlin)` |
| 429 ohne Quota-Header (Server-Throttle), `CLAUDE_CODE_MAX_RETRIES=1` | 1 | `null` | `rejected`, **ohne** `resetsAt` und `rateLimitType`; davor ein `api_retry` mit `error: "rate_limit"` | `API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited` |

Alle Fälle **[Mock]**. Wichtig ist die letzte Zeile: `rate_limit_event` mit `status: "rejected"` allein ist kein Abo-Limit, und `error: "rate_limit"` auch nicht.

Der Text lautet in 2.1.331 „You've hit your limit“, nicht wie in der Doku „session limit“ oder „weekly limit“ **[Mock]**. Laut Changelog 2.1.312 heißt das 5-Stunden-Fenster inzwischen „5-hour limit“. Mit gesetztem `overage-disabled-reason` (siehe unten) lautete der Text tatsächlich `You've hit your 5-hour limit · resets 6:02pm (Europe/Berlin)` **[Mock]**. Der Wortlaut hängt also von Details der Antwort ab.

### Mit Watchdog (`CLAUDE_CODE_RETRY_WATCHDOG=1`)

| Fall | Verhalten |
| - | - |
| `five_hour`, Reset in 25 s, `…_MAX_WAIT_MS=60000` | `rate_limit_event` rejected, dann `api_retry` mit `max_retries: 300`, `retry_delay_ms` ≈ Zeit bis zum Reset (24128). Weil der Mock auch nach dem Reset weiter 429 lieferte, endete der Run nach 60 s mit demselben Ergebnis wie ohne Watchdog. |
| `five_hour`, Reset in 2 h, `…_MAX_USAGE_LIMIT_WAIT_MS=10000` | sofortiges Ende (1 s), gleiches Ergebnis wie ohne Watchdog. |
| `five_hour` mit `overage-disabled-reason: org_level_disabled` | wartet wie erwartet (`api_retry` mit `retry_delay_ms` ≈ 20 s). |
| `five_hour` mit `overage-disabled-reason: org_level_disabled_until` | **wartet nicht**, Ende nach unter 1 s mit `You've hit your org's monthly spend limit · ask your admin to raise it at https://claude.ai/admin-settings/usage · your 5-hour limit resets 8pm (Europe/Berlin)`, `api_error` trotzdem `usage_limit_reached`. Das ist der offene Bug [#104690](https://github.com/anthropics/claude-code/issues/104690), in 2.1.331 noch vorhanden. |

Alle Fälle **[Mock]**. Das echte Konto dieser Maschine (Max, keine Usage-Credits) meldet bei jeder Antwort `overageDisabledReason: "org_level_disabled"` **[beobachtet]**, wäre also aktuell nicht betroffen. Laut #104690 senden andere Konten ohne Usage-Credits `org_level_disabled_until`.

## Woher die Reset-Zeit kommt

In Reihenfolge der Verlässlichkeit:

1. **`rate_limit_event` mit `status: "rejected"`** in `stream-json`: `rate_limit_info.resetsAt` (Epoch-Sekunden), dazu `rateLimitType` **[Mock, `rateLimitType` undokumentiert]**. Gleicher Inhalt in `assistant.api_error_params.rate_limit_info` **[Mock, undokumentiert]**.
2. **Transkript** `~/.claude/projects/<projekt>/<session-id>.jsonl`: Die letzte Zeile mit `isApiErrorMessage: true` trägt `apiError: "usage_limit_reached"` und `quotaLimits` mit `status`, `resetsAt`, `rateLimitType` **[Mock, undokumentiert]**. Das ist der Ausweg bei [#103820](https://github.com/anthropics/claude-code/issues/103820), wo stdout leer bleibt; [#97975](https://github.com/anthropics/claude-code/issues/97975) zeigt `quotaLimits` ebenso aus echten Transkripten. Die Session-ID kann die Engine mit `--session-id <uuid>` selbst vergeben (siehe Headless-Recherche).
3. **`claude -p "/usage" --output-format stream-json --verbose`**: Ruft kein Modell auf (`num_turns: 0`, `total_cost_usd: 0`, `local_command: "usage"`), Exit 0, liefert `usage_report.rate_limits.limits[]` mit `percent` und `resets_at` je Fenster **[beobachtet]**. Gegen das echte Konto z. B. `{"kind":"session","percent":21,"resets_at":"2026-11-24T20:59:59.914116+00:00","is_active":true}` plus `weekly_all` und `weekly_scoped` (Fable). Geeignet, um nach dem Aufwachen zu prüfen, ob das Limit wirklich weg ist, oder als Fallback, wenn ein Run ohne Limit-Event abbrach. Ob `percent` bei erschöpftem Fenster genau 100 ist, habe ich nicht gesehen **[nicht verifiziert]**.
4. **Vorab, bei jedem erfolgreichen Request**: Auch `rate_limit_event` mit `status: "allowed"` trägt `resetsAt`, `utilization` und (undokumentiert) `unifiedWindows` mit `five_hour`/`seven_day` je `utilization`, `resetsAt`, `status` **[beobachtet]**. Der `resetsAt` des echten Kontos (1795554000 = 20:59:59 UTC, gerundet) stimmte mit `/usage` überein **[beobachtet]**.

Nicht geeignet: der Text in `result` (lokalisierte Uhrzeit, Datum nur bei anderem Tag, Wortlaut ändert sich), `retry-after` (nur im Debug-Log sichtbar), `ANTHROPIC_LOG=debug` (schreibt Request-Dumps auf stdout und zerstört das NDJSON, [#103820](https://github.com/anthropics/claude-code/issues/103820)).

## Bekannte Fallstricke

- **Fehlende Events in langen Sessions** ([#103820](https://github.com/anthropics/claude-code/issues/103820), offen, 2.1.303): Exit 1 ohne `rate_limit_event`, ohne `assistant`-Fehler, ohne `result`; die Meldung stand nur im Transkript. Mit dem Mock nicht reproduzierbar, nur nach langer Session mit Auto-Compaction.
- **Falsche Klassifikation als Spend-Limit** ([#104690](https://github.com/anthropics/claude-code/issues/104690), offen; [#75730](https://github.com/anthropics/claude-code/issues/75730), offen): Ein abgelaufenes 5-Stunden-Fenster erscheint als „monthly spend limit“. `api_error`, `rateLimitType` und `resetsAt` stimmen trotzdem **[Mock]**, Textabgleich würde hier falsch entscheiden.
- **`rate_limit_event` mitten in einer Zeile** ([#49640](https://github.com/anthropics/claude-code/issues/49640), 2.1.74, als „not planned“ geschlossen): Das Event wurde in eine andere NDJSON-Zeile geschrieben. Ob das noch auftritt, ist offen **[nicht verifiziert]**. Der Parser der Engine sollte unparsebare Zeilen protokollieren, nicht abstürzen.
- **Vererbte Umgebung**: Changelog 2.1.327 nennt einen Fall, in dem ein von einer Session gestartetes `claude -p` deren Retry-Einstellung erbte und Limits abwartete. Die Engine setzt die Umgebung des Kind-Prozesses daher explizit und entfernt `CLAUDE_CODE_RETRY_WATCHDOG*`.
- **Subagents**: Trifft ein Subagent das Limit, endet er mit „Agent terminated early due to an API error“ ([errors](https://code.claude.com/docs/en/errors.md#agent-terminated-early-due-to-an-api-error)), und der Hauptagent arbeitet weiter. Bei Session- und Weekly-Limit scheitert dann auch der nächste Request des Hauptagenten. Bei einem modellspezifischen Limit (`seven_day_opus`/`_sonnet`), das nur das Modell des Subagents betrifft, kann der Run ohne Limit-Ergebnis enden **[nicht verifiziert]**; das fangen nur die Checks der Engine.
- **`credits_required`**: Mit `errorCode: "credits_required"` geht es erst nach Kauf von Usage-Credits weiter ([TypeScript-Referenz](https://code.claude.com/docs/en/agent-sdk/typescript.md#sdkratelimitevent)). Ob dabei ein `resetsAt` mitkommt, ist offen **[nicht verifiziert]**.

## Empfehlung für die Engine

1. Runs immer mit `--output-format stream-json --verbose` starten, ohne `CLAUDE_CODE_RETRY_WATCHDOG` (aktiv aus der Umgebung entfernen) und ohne `ANTHROPIC_LOG`. Damit endet ein Run am Limit sofort, und das Warten liegt deterministisch in der Engine.
2. **Limit-Abbruch** liegt vor, wenn der Prozess mit Exit ≠ 0 endet und eines davon zutrifft (ein Treffer genügt):
   - `result.api_error == "usage_limit_reached"`,
   - eine `assistant`-Nachricht mit `api_error == "usage_limit_reached"`,
   - ein `rate_limit_event` mit `status == "rejected"` **und** gesetztem `resetsAt`,
   - im Transkript der Session die letzte `isApiErrorMessage`-Zeile mit `apiError == "usage_limit_reached"` oder `quotaLimits.status == "rejected"`.
   Ein `rejected`-Event ohne `resetsAt`, `error: "rate_limit"` allein oder `api_error_status: 429` allein ist **kein** Limit-Abbruch, sondern ein gewöhnlicher Fehler.
3. **Reset-Zeit** = `resetsAt` aus derselben Quelle, als Epoch-Sekunden, plus kleiner Puffer (z. B. 60 s, weil der Wert auf ganze Sekunden gerundet ist und die Server-Uhr abweichen kann). Liegt `resetsAt` in der Vergangenheit oder fehlt er bei einem erkannten Limit, `claude -p "/usage"` abfragen und das späteste `resets_at` der Zeilen mit `percent >= 100` nehmen; findet sich keine, nach kurzem festen Intervall erneut prüfen.
4. Nach dem Warten optional `/usage` abfragen (kostenlos) und nur starten, wenn kein Fenster erschöpft ist. Trifft der neue Run wieder das Limit, beginnt das Warten erneut; der Versuch zählt weiterhin nicht.
5. Wird ein Limit erkannt, das sich nicht von selbst zurücksetzt (`errorCode: "credits_required"` ohne `resetsAt`), hält die Engine den Lauf an und meldet das, statt zu warten.
6. Optional vorausschauend: `rate_limit_event` mit `allowed_warning` und hoher `utilization` protokollieren. Einen Run deswegen nicht zu starten, wäre eine eigene Entscheidung; nötig ist es nicht.
7. Felder, auf die sich das stützt (`api_error`, `rateLimitType`, `quotaLimits`), sind undokumentiert. Die Engine sollte bei jedem Start `claude_code_version` aus `system/init` protokollieren und einen Test mit genau diesem Mock behalten, der nach einem CLI-Update zeigt, ob die Erkennung noch greift.

## Offene Punkte

- Keine echte Limit-Antwort beobachtet. Die Header des Mocks stammen aus zwei Issue-Berichten; ob der echte Server weitere Header oder einen anderen Body sendet, ist offen.
- `api_error`, `api_error_params`, `rateLimitType`, `quotaLimits` und `unifiedWindows` sind undokumentiert und können sich ändern.
- Welches Fenster `resetsAt` bezeichnet, wenn mehrere gleichzeitig erschöpft sind (vermutlich die „representative claim“ des Servers), ist nicht belegt. Schritt 4 der Empfehlung fängt einen zu frühen Reset ab.
- Exit-Code: beobachtet immer 1; dass es so bleibt, sagt die Doku nicht.
- Ob [#103820](https://github.com/anthropics/claude-code/issues/103820) (fehlende Events) in 2.1.331 noch auftritt, ließ sich mit dem Mock nicht prüfen.
- Verhalten bei `credits_required` und bei Usage-Credits, die aktiv sind (`isUsingOverage: true`), nicht untersucht; auf diesem Konto sind sie aus.
