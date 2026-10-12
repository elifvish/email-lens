<div align="center">

# email-lens

**See your email on every screen.** An open-source, local alternative to Litmus and Email on Acid.

[![npm](https://img.shields.io/npm/v/email-lens?color=a99bff&label=npm)](https://www.npmjs.com/package/email-lens)
[![CI](https://github.com/elifvish/email-lens/actions/workflows/ci.yml/badge.svg)](https://github.com/elifvish/email-lens/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-a99bff)](LICENSE)

**[Try the live demo](https://elifvish.github.io/email-lens/)** · **[Watch the videos](https://elifvish.github.io/email-lens/videos.html)** · `npx email-lens`

</div>

![email-lens: an email on phone, tablet and laptop, switching modes](docs/media/preview-1-stage.gif)

Paste an email, drop an `.eml`, or connect your mail catcher, and email-lens shows you:

- **Client support:** every HTML and CSS feature the email uses, checked against
  [caniemail.com](https://www.caniemail.com) data for 48 clients (Gmail, Outlook, Apple Mail,
  Yahoo, Samsung Email, Thunderbird, AOL, ProtonMail and more), each scored, with the notes
  explaining *how* support is partial.
- **Device previews:** iPhone SE (320px) to desktop, in five modes: light, dark
  (`prefers-color-scheme`), forced dark (the colour inversion the Gmail and Outlook apps apply),
  no `<style>` (Gmail with non-Google accounts) and images off.
- **Real engines:** the email running in real WebKit (Apple Mail / iOS Mail), Chromium (webmail,
  Android) and Gecko (Thunderbird) pages, streamed into the device frames so you can scroll, hover
  and click. Scripts are off, as in every email client.
- **Checks:** content overflowing phone screens (and which element causes it), Gmail's 102 KB
  clipping, low contrast in light and dark, text iOS will resize, small buttons, missing alt text,
  broken or local images and links, missing plain-text part, and more.

Nothing is uploaded anywhere: it runs on your machine, and the only network requests are the
email's own images.

## How it compares

| | email-lens | Litmus | Email on Acid | Testi@ |
|---|---|---|---|---|
| Price | Free, MIT | Paid subscription | Paid subscription | Free tier, paid plans |
| Runs locally, nothing uploaded | ✅ | ❌ | ❌ | ❌ |
| Client support scores (caniemail) | ✅ 48 clients | ✅ | ✅ | ✅ |
| Rendering | Real WebKit, Chromium, Gecko: live, scroll and click | Screenshots from real clients | Screenshots from real clients | Screenshots from real clients |
| Outlook for Windows (Word engine) renders | ❌ ([why](#what-it-can-and-cant-tell-you)) | ✅ | ✅ | ✅ |
| Gmail / Outlook dark-mode and CSS-stripping simulation | ✅ | ✅ | ✅ | partial |
| Free CLI and GitHub Action for CI | ✅ | — | — | — |
| Mailpit / MailHog / Mailtrap inbox | ✅ | ❌ | ❌ | ❌ |

Check each site for current plans. The paid tools render on real devices, including Outlook for
Windows, so they remain worth it for a final check before a big send.

## Quick start

```bash
npx email-lens                      # opens the app at http://localhost:4600
npx email-lens install-browsers     # once, for Real engines (about 300 MB; optional)
```

Needs Node 22 or later. Without the browsers everything works except **Real engines**.

**Docker**, with all three engines included:

```bash
docker run --rm -p 4600:4600 ghcr.io/elifvish/email-lens
```

Inside Docker, reach a Mailpit running on your machine at `http://host.docker.internal:8025`.

**In CI**, as a GitHub Action that fails the build on broken emails and posts a report to the
job summary:

```yaml
- uses: elifvish/email-lens@v0
  with:
    files: emails/**/*.html
    min-score: 70          # optional: fail if a major client supports less than 70%
    render: false          # true: also render in real engines and upload screenshots
```

**From source:**

```bash
git clone https://github.com/elifvish/email-lens && cd email-lens
npm install && npm run browsers && npm start
```

### Nothing is stored

Real-engine screens are pages held open in memory on the local server; frames go straight to your
browser and are never written to disk. *Snapshot* opens a full-length image in a new tab without
saving it. A tile's engine page closes when you close the tile, switch modes or emails, leave the
page, stop the server, or after 60 seconds with nobody watching. Only the CLI's `--render <dir>`
writes files, to the folder you name.

## Walkthrough

Open http://localhost:4600 and paste an email, drop an `.html`/`.eml` file anywhere, or connect
an inbox. Two samples are built in: **Ember Roasters**, a polished autumn-launch email built the
robust way, and **Broken report**, which makes the classic mistakes.

![Start screen](<docs/media/shot-start.png>)

### 1. Your email on every screen

The email sits on a stage in phone, tablet and laptop frames, all at their true viewport sizes
and scaled together so you can compare them. The chip at the top right is the average client
support score and the issue count. The dock at the bottom switches renderer, mode and devices.

![Ember Roasters on iPhone, iPad and desktop](<docs/media/shot-stage.png>)

Video: [stage and devices](docs/media/clip-1-stage.mp4)

### 2. Switch modes to see what clients do to it

*Dark* applies the email's own dark-mode CSS, as Apple Mail does. *Forced dark* simulates the
colour inversion of the Gmail and Outlook apps. *No `<style>`* removes embedded CSS, as Gmail does
for non-Google accounts. *Images off* blocks images, the default in many work inboxes. Keys
`1`–`5` switch modes.

![Switching between light, dark, forced dark, no style and images off](<docs/media/preview-2-modes.gif>)

| Dark (Ember's own dark styles) | Forced dark (Gmail / Outlook apps) |
|---|---|
| ![Ember Roasters in dark mode](<docs/media/shot-dark.png>) | ![Broken report under forced dark](<docs/media/shot-forced-dark.png>) |

Video: [modes](docs/media/clip-2-modes.mp4)

### 3. Inspect: score, clients, features

**Inspect** (or `I`) opens the inspector. *Overview* gives the verdict and the clients with the
least support. *Clients* scores all 48 clients from [caniemail.com](https://www.caniemail.com)
data; click one to see what it drops and why. *Features* lists every HTML/CSS feature the email
uses, where, and which clients fall short.

![Opening the inspector: overview, a client's gaps, a feature, the code](<docs/media/preview-3-inspector.gif>)

| Overview | Clients | Features |
|---|---|---|
| ![Inspector overview](<docs/media/shot-overview.png>) | ![Gmail Android expanded](<docs/media/shot-clients.png>) | ![A feature with code and per-family notes](<docs/media/shot-features.png>) |

Video: [inspector](docs/media/clip-3-inspector.mp4)

### 4. Fix the issues

Each screen gets an OK or error badge from layout checks run on the rendered email: overflow
(and the element causing it), shrink-to-fit, contrast, text size, tap targets. *Issues* collects
those plus checks on the HTML itself: Gmail's 102 KB clipping, viewport, alt text, links.

![The broken sample: error badges, then the issues list](<docs/media/preview-4-issues.gif>)

![Broken report with its issues](<docs/media/shot-issues.png>)

Video: [issues](docs/media/clip-4-issues.mp4)

### 5. Scroll and click it in real engines

**Real engines** swaps each screen for a real WebKit, Chromium or Firefox page running on your
machine, streamed in. Scroll, hover and click inside a screen; clicked links are shown instead of
followed. Nothing is saved to disk.

![Scrolling the phone in WebKit and clicking a link in Chromium](<docs/media/preview-5-real-engines.gif>)

![Ember Roasters live in WebKit and Chromium](<docs/media/shot-real-engines.png>)

Video: [real engines](docs/media/clip-5-real-engines.mp4)

### 6. Open from anywhere

**Open email** takes pasted HTML or `.eml`, a file, or an inbox: browse Mailpit, MailHog or
Mailtrap to check what your app actually sends.

![The open sheet: paste, upload and an inbox connection](<docs/media/preview-6-open.gif>)

![Inbox connection](<docs/media/shot-inbox.png>)

Video: [opening emails](docs/media/clip-6-open.mp4)

The slider button at the bottom right holds display tweaks: realistic or minimal frames, the
stage backdrop, and fit-to-screen or 100% size.

## Command line / CI

```bash
npx email-lens check emails/                       # every .html/.htm/.eml under a folder
npx email-lens check "emails/**/*.html" --format markdown > report.md
npx email-lens check email.html
npx email-lens check message.eml --clients "gmail.*,outlook.*,apple-mail.*" --min-score 80
npx email-lens check email.html --render ./shots     # also writes 30 engine screenshots
npx email-lens check email.html --format json > report.json
npx email-lens update-data                            # refresh caniemail data
```

`check` exits with status 1 when it finds an error (overflow on a phone, Gmail clipping, broken
images, …) or a selected client scores below `--min-score`.

## Connecting a mail catcher

Under **Open email → Inbox**, pick *New Mailpit / MailHog / Mailtrap connection*, fill it in and connect.
Tick *Remember in this browser* to keep it in this browser's localStorage, password included.
To keep credentials out of the browser, define connections on the server instead, in
`~/.config/email-lens/sources.json` (or the file named by `EMAIL_LENS_SOURCES`):

```json
[
  { "name": "Local Mailpit", "type": "mailpit", "url": "http://localhost:8025" },
  { "name": "Staging Mailpit", "type": "mailpit", "url": "https://mail.staging.example.com", "username": "admin", "password": "…" },
  { "name": "Mailtrap sandbox", "type": "mailtrap", "token": "…", "accountId": "123456", "inboxId": "654321" }
]
```

| Type | Needs | Tested against |
|---|---|---|
| `mailpit` | `url` (the Mailpit web root), optional `username`/`password` for basic auth | Mailpit v1.22 |
| `mailhog` | `url`, optional basic auth | not yet; built to the MailHog v1/v2 API |
| `mailtrap` | API `token`, `accountId`, `inboxId` (Email Sandbox) | not yet; built to the Sandbox API |

## What it can and can't tell you

- The compatibility scores come from caniemail's tests of each feature in each client. A feature
  being unsupported is not always visible (an unsupported `box-shadow` just disappears), so read
  the scores together with the previews. Some entries are harmless by design: "HTML5 doctype
  unsupported" means the client drops the doctype.
- Previews and real engines use real browser engines, but they are not the clients themselves. Apple
  Mail and iOS Mail are WebKit with few changes, so those are close. Gmail and Outlook also
  rewrite your HTML; the *no `<style>`* and *forced dark* modes simulate the two rewrites that
  break the most emails.
- **Outlook for Windows** renders with Microsoft Word's engine, which can't be reproduced here.
  Its column in **Clients** and **Features** lists what it will drop; to see it, use a Windows
  machine or a paid service (Litmus, Email on Acid, Testi@) before a major release.

## Architecture

| Path | What |
|---|---|
| `src/compat.mjs` | Parses the HTML (htmlparser2) and every stylesheet and `style=""` (PostCSS, css-what), maps what it finds to caniemail feature slugs, and scores each client on the latest tested version |
| `src/lint.mjs` | Static checks (size, structure, accessibility) |
| `public/probe.js` | Layout checks on a rendered page; the same function runs in the UI's iframes and inside Playwright |
| `public/variants.js` | The preview modes (dark, forced dark, no style, images off) |
| `src/render.mjs` | Playwright engine pages and CLI screenshots |
| `src/live.mjs` | Live engine sessions: frame streaming (long-poll), input forwarding, idle cleanup |
| `src/sources.mjs` | Mailpit, MailHog, Mailtrap and `.eml` parsing |
| `src/server.mjs` | Local HTTP server (127.0.0.1 only) and JSON API |
| `data/caniemail.json` | Bundled caniemail dataset (MIT); refresh with `email-lens update-data` |

The existing npm checkers (`caniemail`, `doiuse-email`) throw on ordinary emails whenever a client
has no data for a feature, so email-lens has its own matcher and reports those as "untested".

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Tests

```bash
npm test
```

## Licence

MIT. Feature support data © caniemail.com contributors, MIT.
