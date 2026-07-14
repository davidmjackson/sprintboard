# Rulesets

`main.json` is a copy of the live GitHub-side state of the `main` branch
ruleset (id `18912697`), fetched via the GitHub API. It is not applied
automatically — GitHub reads its own stored ruleset, not this file, so
editing `main.json` has no effect on enforcement by itself.

It is committed so that a silent deletion or weakening of the ruleset shows
up as a diff in this repo instead of vanishing invisibly on GitHub's side.

To restore the live ruleset from this file:

```bash
gh api -X PUT repos/davidmjackson/sprintboard/rulesets/18912697 --input .github/rulesets/main.json
```

Key properties: requires a pull request, requires the `verify` status check,
blocks force-push and deletion of `main`, and has zero bypass actors.
