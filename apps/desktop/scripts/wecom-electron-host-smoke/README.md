# PB-02 synthetic Electron host smoke probe

This is a test-only child Electron app. It does not start Hermes, use the normal
Desktop `userData`, contact WeCom, or wire the proof-of-concept flow into the
production main process.

The probe accepts the reviewed Gateway browser bundle explicitly and verifies
its exact byte length and SHA-256 before launching Electron 40.10.2. This avoids
copying the Gateway's source/state gate into Desktop.

The HTTPS server is a `synthetic-electron-probe` implementation of the reviewed
Gateway browser contract. It is not the real Gateway host, does not contact the
official WeCom endpoint, and does not establish that a third-party `source` is
accepted. Real WeCom authorization remains a separate manual gate.

```powershell
$env:PB02_GATEWAY_BUNDLE = 'E:\path\to\gateway\EnterpriseGateway.WeComAuth\BotAuthClient\dist\bot-auth-client.js'
$env:PB02_ELECTRON_HOST_SMOKE_REQUIRED = '1'
npm run test:wecom-electron-host-smoke
```

Without `PB02_GATEWAY_BUNDLE`, the normal single-repository invocation prints a
machine-readable `SKIP`. Required mode fails on a missing Electron binary,
bundle, reviewed hash, or existing exportable HTTPS development certificate.

The child redirects `userData`, `sessionData`, logs, crash dumps, and cache into
one OS-temporary sandbox and removes the whole sandbox after Electron exits. It
never starts the normal Hermes main process or reads `HERMES_HOME`. It never
enables Playwright tracing and does not create HAR, trace, video, or screenshot
artifacts. The eight scenarios cover a valid real popup/WindowProxy, wrong
origin, wrong source, missing state, mismatched state, duplicate terminal
messages, host policy (CSP and new-window denial), and real Electron
`will-navigate`, `will-redirect`, and `will-frame-navigate` events.

For the multi-root secret scan, retain a new sandbox outside the repository and
use the same canonical lowercase run ID as the scan manifest:

```powershell
$env:PB02_ELECTRON_HOST_SMOKE_REQUIRED = '1'
$env:PB02_ELECTRON_HOST_SMOKE_RUN_ID = '11111111-1111-4111-8111-111111111111'
$env:PB02_ELECTRON_HOST_SMOKE_RETAIN_ROOT = 'C:\tmp\pb02-electron-profile'
npm run test:wecom-electron-host-smoke
```

The retained root must not already exist. After the Electron child exits, the
runner writes `.wecom-pb02-producer.json` with category
`electron_auth_profile`, producer `electron-auth-probe`, the exited child PID,
and the configured run ID. The synthetic browser transaction uses that same
run ID, so its profile artifacts and producer marker cannot drift to different
runs. Default mode never retains the sandbox. Retained
mode intentionally leaves it for the scanner and therefore must only be used
as part of the documented scan-and-cleanup flow.
