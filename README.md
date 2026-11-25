# Keyboard accessibility fuzzer

A small Playwright tool that probes a local web page with real `Tab`,
`Shift+Tab`, and an `Escape` recovery check. It records the focused element and
Chromium's accessibility role/name, then reports empty accessible names,
controls not observed in the keyboard sample, and suspected focus traps.

This goes beyond a static DOM scan: findings include actual browser focus traces
and accessibility-tree evidence. It is a bounded explorer, not a conformance
checker. **It does not run NVDA, VoiceOver, JAWS, or a real screen reader.** Derived
role/name announcements are simulations and do not establish what assistive
technology will actually speak.

## Install and run

Node 22+:

```sh
npm ci
npx playwright install chromium
node src/cli.js --fixture accessible
node src/cli.js --fixture broken --output broken-report.json
node src/cli.js --url http://localhost:3000 --steps 60 --output report.json
```

The deliberately broken fixture exits 1 because findings were observed. Exit 0
means no findings in this sample, 1 means findings, 2 means a configuration/runtime
error. Default 30 steps per direction; valid range 1–200. The CLI limits the audit
phase to 60 seconds, with separate navigation/browser-launch timeouts. `--help`
lists options. To use an installed Chrome instead of downloading Chromium:

```sh
CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm test
```

The CLI supports only explicit local HTTP(S) targets on localhost, 127.0.0.1 or
[::1]. It uses a fresh browser context, blocks service workers, and aborts HTTP
requests to other origins. This is not an isolation boundary for hostile pages.
Use an app you own and can safely exercise. Focus, Escape and page reloads can
trigger application handlers; the tool does not click, type, submit, or activate
controls deliberately. It never uses your normal browser profile or account.

Reports include page URLs, element identities and accessible names, which may
contain application data. Review reports before publishing them. Committed
fixtures and example reports use synthetic data only.

## What a report establishes

| Finding | Evidence and interpretation |
| --- | --- |
| `unlabeled-control` | An interactive Chromium AX node has an empty accessible name. Unavailable AX data stays unknown. |
| `unreached-control` | A visible potentially interactive DOM candidate was not observed in either sampled direction. This can reflect the step budget or an intentional composite widget; it does not prove universal unreachability. |
| `suspected-focus-trap` | A strict subset of tab-eligible controls repeated at least three times while others existed, and Escape followed by Tab did not reach outside that subset. Review intended widget behavior. |

Each direction begins with an independent page reload and body focus reset.
Element identity uses structural DOM paths; browser AX data supplies role/name
instead of an invented accessible-name algorithm. Ordinary document wrapping
does not produce a trap finding. A recoverable modal is probed with Escape
before classifying a repeated subset. Reports retain both traces, recovery
evidence, candidate coverage and warnings.
Native modal background controls that the browser intentionally makes inert do
not produce unreached findings; their count remains visible in coverage.

Only top-level light-DOM controls are in scope. Frames, shadow-root internals,
browser chrome, arrow-key navigation, activation flows, new app states, timing
variations and actual assistive technology remain outside this checkpoint.
Radio groups and other composite widgets can require manual review. Dynamic DOM
changes between reloads can make structural-path comparisons ambiguous. Candidate
coverage is capped at 1,000 per direction and DOM-to-AX mapping at 50,000 examined
nodes; these are traversal limits, not a hard process-memory sandbox.

## Verify

```sh
npm run check
npm test
```

Real Chromium tests use accessible, deliberately broken, and Escape-recoverable
modal fixtures. They verify actual focus/name evidence, detect a repeating trap,
detect unnamed and click-only controls, avoid labeling normal document wrap or
an Escape-recoverable modal as a trap, and preserve bounded-coverage uncertainty.
CLI checks validate local-target scope and option limits. CI installs pinned
Playwright Chromium and runs the same tests.

`src/audit.js` exports `audit(page, {steps, settleMs})` for a selected Chromium
Playwright page. `src/cli.js` provides the local-target wrapper and JSON output.
No axe dependency is used. The explorer adds behavioral evidence; it does not
replace static accessibility checks, manual keyboard testing or real AT testing.

The committed [broken-fixture report](examples/broken-report.json) contains the
actual synthetic browser trace. Local evaluation found zero findings for the
accessible and Escape-recoverable modal fixtures. The broken fixture exposed
two empty accessible names, a click-only target, and a repeating focus trap.

Primary references: [Playwright keyboard API](https://playwright.dev/docs/api/class-keyboard),
[Chromium accessibility protocol](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/),
[Playwright browser contexts](https://playwright.dev/docs/api/class-browser#browser-new-context).

## Next checkpoints

Add controlled state activation, arrow-key/composite-widget scenarios, frame and
shadow-root traversal, and broader fixture evaluation. Actual screen-reader
integration is separate work and is not claimed by these reports.
