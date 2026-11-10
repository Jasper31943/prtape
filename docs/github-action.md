# GitHub Action

Not in v0.1. This file is a stub so the repo does not grow a workflow by accident.

PRtape reads Claude Code sessions from the developer's machine (`~/.claude/projects`). Claude Code only for now. A GitHub-hosted runner cannot see those files. A cloud workflow would only be useful if a developer uploaded an already-redacted summary, which v0.1 does not do.

Run it locally instead:

```bash
npx prtape-cli pr --dry-run
npx prtape-cli pr
```

`--dry-run` does not call `gh`. A real `prtape pr` comments on the pull request for the current branch when `gh` is installed and authenticated.
