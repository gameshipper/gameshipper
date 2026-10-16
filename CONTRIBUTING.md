# Contributing

Thanks for helping. Bug reports, fixes and docs are all welcome.

## Licensing of contributions

Gameshipper is MIT-licensed, and contributions are taken under the same license: by opening a pull request, you agree
that your contribution is licensed under the [MIT License](LICENSE), like the rest of the project. There's no
contributor agreement to sign.

## Reporting a bug

Open an issue with the Gameshipper version (`npx gameshipper --version`), your OS, the command you ran, and its result
with `--json` (it includes the error codes and the path of the run log). Security problems go to
[SECURITY.md](SECURITY.md) instead, never to a public issue.

## Changing the code

```sh
npm ci
npm run typecheck
npm test                  # unit tests
npm run test:integration  # builds Gameshipper, then packages and runs real apps (opens game windows)
```

- Keep every test green, and add a test for what you change.
- Error codes are permanent API: never rename one; add new ones where the others are listed (the help catalog,
  `src/cli/output.ts`, the README and the Claude Code skill).
- `--json` output follows the agent contract described in the README's [For AI agents](README.md#for-ai-agents)
  section: one Result, every error with a code, a message and a fix.
- Never commit the Steamworks SDK, or anything from it: it's licensed to its account holder.

Pull requests run CI on Ubuntu, macOS and Windows. A first-time contributor's run waits for a maintainer's approval.
