# Changelog

All notable changes to groundhog. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Before 1.0.0, a minor version may change behaviour.

## [0.2.0] - 2026-11-26

### Added

- **Batches.** `groundhog` without an argument offers the ready specs of the repo, all preselected, oldest first. `groundhog 57 58 61` runs the named specs in that order. Every check and question comes before the first run, and one lock covers the whole batch. The batch stops at the first run that does not end with exit code 0. At the end, an overview shows one line per spec.
- **Own worktree per run.** A run works in a git worktree under `~/.cache/groundhog/worktrees/<repo>-<hash>/spec-<n>` and never touches your working directory, so you can keep working in the same clone. A dirty working tree no longer stops the start. The worktree is recovered when it breaks and removed once the spec is done. The start aborts when a branch of the spec is checked out elsewhere (ADR 0001).
- **`setup` in `groundhog.json`.** Commands that run once in a fresh worktree, inside the sandbox, such as `npm ci`. `groundhog init` asks for them.
- **One board for the whole batch.** Every spec of the batch stands under its own heading with its tickets, and every ticket shows its title. The transcripts of every session stay on the board. Scroll them with the mouse wheel or the keyboard. The top of the board takes at most half the window.
- **Subagents in the transcript.** The tool calls of a subagent, such as the code review, carry its name. Its end shows as one line, done or failed, with the first line of its report.
- **Herdr.** groundhog shows up as agent `groundhog` in the Herdr agent list (via the `herdr` CLI) and in hc (via OSC 7501): `blocked` while the start asks its questions, then `working` with the spec and the current ticket, and `done` or `error` at the end.
- **`groundhog init` commits the project config** on Yes, and handles an unchanged file, a failing commit and an abort.
- **Commit gate for this repo.** A checked-in pre-commit hook runs typecheck, lint, tests and `fallow dead-code` before every commit. CI runs `fallow dead-code` too.

### Changed

- The engine runs its own git steps without git hooks. It works outside the sandbox, and a hook in the working tree is the agent's to change. Only the commit `init` makes for you keeps your hooks.
- The attempt count on the board shows only from the second attempt on.
- The `claude --resume` line in the summary and the ticket comment points into the worktree.
- Internals: the worktree, the ticket flow, the run state derived from events, Claude's stream format and the batch runner each live in one module now. The batch runner takes the process as an adapter, so exit codes and aborts between specs are tested. Nothing changes in what groundhog does.

### Fixed

- After Ctrl+C, an aborted start or a hard exit, Herdr kept showing groundhog as `working` or `blocked`. An aborted run now reports `idle`, and so does the end of the process when a report is still open.

## [0.1.0] - 2026-11-26

The first release: a local CLI that works through the tickets of a spec in GitHub Issues without a human at the keyboard.

### Added

- Deterministic engine: the frontier is read fresh from the tracker before every ticket, one Claude Code session runs per attempt, and the engine decides green or red on its own verifications.
- Bounded attempts. A ticket that stays red goes to a human with `ready-for-human` and one explanatory comment, and the run carries on.
- One commit per ticket on the integration branch `spec/<n>`, pushed after every green ticket. The finish merges, opens a PR or does nothing.
- Every session and its checks run in the `srt` sandbox with a fixed list of hosts.
- Board and transcript in the terminal, continuous output in pipes, a summary as a comment on the spec and a log of every run under `.git/groundhog/runs/`.
- Usage limits are waited out without using up an attempt. Ctrl+C twice aborts cleanly, and running the same command again resumes.

[0.2.0]: https://github.com/lucas-devries/groundhog/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/lucas-devries/groundhog/releases/tag/v0.1.0
