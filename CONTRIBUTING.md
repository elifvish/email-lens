# Contributing to email-lens

Thanks for helping. Bug reports, client-quirk reports and pull requests are all welcome.

## Setup

```bash
git clone https://github.com/elifvish/email-lens && cd email-lens
npm install
npm run browsers   # WebKit, Chromium and Firefox for Real engines
npm start          # http://localhost:4600
npm test
```

Node 22 or later. There is no build step for the app: `public/` is served as-is, and the engine
in `src/` runs in Node and, bundled by `scripts/build-site.mjs`, in the browser demo.

## Where things live

| Path | What |
|---|---|
| `src/compat.mjs` | Maps HTML and CSS in an email to caniemail features and scores clients. No I/O, so it also runs in the browser. |
| `src/lint.mjs` | Static checks on the HTML |
| `public/probe.js` | Layout checks on a rendered page (iframe previews and Playwright) |
| `public/variants.js` | Preview modes: dark, forced dark, no style, images off |
| `src/live.mjs`, `src/render.mjs` | Real-engine sessions and CLI screenshots |
| `src/sources.mjs` | Mailpit, MailHog, Mailtrap and `.eml` parsing |
| `public/app.js`, `public/app.css` | The UI |

## Good first contributions

- **A missed feature.** If caniemail has data for something the matcher doesn't detect, add it in
  `src/compat.mjs` with a test in `test/compat.test.mjs`.
- **A connector.** MailHog and Mailtrap were built to their APIs but haven't been tested against
  real instances; reports and fixes are very welcome.
- **A check.** New layout or lint checks belong in `public/probe.js` or `src/lint.mjs`. Keep
  messages specific: say what is wrong, where, and how to fix it.

## Pull requests

- Keep changes focused, and add or update tests for engine changes.
- Run `npm test` and try the change in the app (both samples, a couple of modes).
- For UI changes, include a screenshot.

## Reporting a client quirk

If an email renders differently in a real client than email-lens predicts, open an issue with the
HTML (or a minimal snippet), the client and version, and a screenshot. Those reports are how the
checks get better.
