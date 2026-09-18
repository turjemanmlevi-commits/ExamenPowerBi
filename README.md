# ExamenPowerBi

Power BI exam cheat sheet that runs on localhost: cleaning order, Append/Merge, new columns, date table, relationships (which table goes to which), measures, visuals, output checklist, and the two mocks (TechCart, Meridian).

- Every DAX / M snippet copies with one click.
- The **My names** panel rewrites all snippets with your own table and column names.
- The **Messages** section sends your exercise files (PDF, Word, Excel, CSV, screenshots) to Claude and returns a step-by-step solution.

## Run

Requires [Node.js](https://nodejs.org) 18+.

```bash
npm install
```

```bash
node server.js
```

Then open http://localhost:5500 (on Windows you can just double-click `start.bat`).

## Claude API key (only for the Messages section)

Copy `.env.example` to `.env` and paste your key after `ANTHROPIC_API_KEY=`. The key stays on the local server; the browser never sees it. `.env` is git-ignored — never commit it.
