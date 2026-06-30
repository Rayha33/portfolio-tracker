# Contributing

Thanks for taking a look! This is a small, self-hosted app — contributions that
keep it simple, dependency-light, and build-step-free are very welcome.

## Getting set up

Requires **Node.js 20+** (the `better-sqlite3` native module needs 20 or newer).

```bash
git clone https://github.com/Rayha33/portfolio-tracker.git
cd portfolio-tracker
npm install
npm start          # http://localhost:3000  (auto-seeds a demo DB on first run)
```

The SQLite database (`db/portfolio.db`) and your `.env` are git-ignored, so you
can experiment freely. Run `npm run reseed` to wipe back to the demo data.

## Running the tests

```bash
npm test
```

This boots the real server against a throwaway database (no network, no API
keys) and asserts that both pages and the core APIs serve the seeded demo data,
then exercises the add → close → delete write path. CI runs the same test on
Node 20, 22, and 24.

Please make sure `npm test` passes before opening a pull request.

## Code style

- **No build step, no framework.** Vanilla HTML/CSS/JS on the front end; Express
  + `better-sqlite3` on the back end.
- Keep dependencies minimal — prefer a few lines of plain JS over a new package.
- 2-space indentation, semicolons, single quotes (see `.editorconfig`).
- Match the style of the file you're editing.

## Pull requests

1. Fork and branch from `main`.
2. Keep changes focused; one logical change per PR.
3. Run `npm test`.
4. **Never commit real positions, secrets, or a populated `db/portfolio.db`** —
   only the synthetic demo data belongs in the repo.
5. Open the PR with a short description of what and why.

## Reporting bugs

Open an issue with steps to reproduce, your Node version (`node -v`), the
browser, and any server log or browser-console output.
