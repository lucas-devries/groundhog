# Every run works in its own worktree outside the repo

A run used to check out its branches in the human's own working directory, so nobody could make a quick change in the same clone while a run was going. Now every run works in its own git worktree, always and not configurable, under `~/.cache/groundhog/worktrees/<repo>-<hash>/spec-<n>`. The worktree keeps a fixed path per spec and stays until the spec's finish has run.

## Considered Options

- **A config key asked by `init`.** Rejected: whether you want to work alongside a run depends on the moment, not on the repo, and a switch doubles every cleanup and resume path.
- **Only support worktrees the human creates.** Rejected: you'd have to know in advance that something will come up during the run.
- **Worktree under `.git/groundhog/`.** Rejected: Claude Code also loads CLAUDE.md files from parent directories, so the session would see the human's working copy of CLAUDE.md, half-finished edits included. That breaks the standing rule that nothing may change the skills' workflow.
- **Remove the worktree after every run.** Rejected: Claude Code stores sessions per directory, so `claude --resume <id>` from the summary and the ticket comment would point nowhere.

## Consequences

- A fresh worktree has no ignored files such as `node_modules`, so the project config gets a `setup` command that runs once after the worktree is created.
- Every leftover in the worktree is the agent's work, so a new run discards it without asking.
- The lock stays one per clone: a run still claims the whole clone, only the human gets their working directory back.
