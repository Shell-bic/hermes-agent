# PB-02 real Gateway Electron acceptance host

This directory contains a test-only, interactive Electron host for PB-02 live
acceptance. It never starts the normal Hermes main process, never uses normal
Hermes `userData` or `HERMES_HOME`, and does not change the production WeCom
login view or the existing synthetic smoke probe.

The launcher is intentionally controlled over newline-delimited stdin. It has
no URL, state, transaction, profile, Bot ID, or Bot Secret command-line or
environment options. The caller sends exactly one start record followed by one
shutdown record:

```json
{"protocolVersion":1,"command":"start","runId":"11111111-1111-4111-8111-111111111111","authorizationUrl":"https://gateway.example.test/wecom/bot-poc/22222222-2222-4222-8222-222222222222?state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","gatewayOrigin":"https://gateway.example.test","profileRoot":"C:\\pb02-evidence\\electron-profile"}
{"protocolVersion":1,"command":"shutdown"}
```

The run ID must be a canonical lowercase GUID. The authorization URL must use
HTTPS, the exact Gateway origin, `/wecom/bot-poc/{transaction-guid}`, and one
43-character base64url `state`. `profileRoot` must be absolute and must not
exist. The launcher creates `profile`, `session-data`, `logs`, `crash-dumps`,
and `cache` below it, then starts only the repository-pinned Electron 40.10.2.
The launcher's child stdin is disabled. On Windows, GUI Electron does not keep
an inherited stdin stream reliable for the later shutdown message, so the
launcher relays the already-validated start and shutdown records over Node's
anonymous parent-child IPC channel. The IPC channel carries no data in argv,
environment variables, temporary files, named pipes, or localhost sockets.
IPC disconnect, duplicate messages, and shutdown timeout all fail closed.

On Windows the launcher first starts a sacrificial Node bootstrap that contains
no run data. Its private monitor protocol starts with
`ATTACH <launcher-pid> <bootstrap-pid>`. A fixed PowerShell process-handle
monitor is compiled in memory and first opens the launcher with query/synchronize
rights only; that launcher handle is a trust anchor and is never part of the
termination set. Two parent snapshots must show both monitor and bootstrap as
direct children of the same still-live launcher, with the same pinned creation
identities alive before and after each snapshot. The monitor also pins its own
query/synchronize handle and requires
`launcher.creation <= monitor.creation <= bootstrap.creation`; this matches the
fixed launch order of monitor-ready before bootstrap spawn and rejects an
ATTACH line that resolves only after launcher/bootstrap PIDs were both reused.
The bootstrap directly spawns
pinned Electron. The monitor opens and fixes the Electron handle and creation
identity before two snapshots confirm its parent is the already-pinned,
still-live bootstrap; the same handle must remain alive after each snapshot.
Only then does the launcher acknowledge the sensitive start IPC. The trusted
Electron main then reports periodic `app.getAppMetrics()` PID snapshots over
the existing anonymous IPC chain. Every snapshot carries its sampling UTC
FILETIME. The monitor accepts only explicitly reported PIDs whose creation time
is between the Electron root creation and snapshot time, and it never discovers
or terminates processes by a bare PID.

During shutdown the shared host first destroys its web contents, then reports
three identical final AppMetrics snapshots. Each snapshot must be pinned and
acknowledged by the monitor before Electron may exit. The monitor stops
accepting new PIDs, waits briefly, terminates only still-live processes through
their already pinned handles, and requires every pinned handle to become
signaled before it exits. The launcher writes the producer marker only after
the three-snapshot handshake, complete handle quiescence, and monitor exit. A
monitor crash, identity mismatch, missing final snapshot, or missing ACK fails
closed with `cleanupStatus=failed` and no marker. No monitor build output is
written to the repository or profile root. Non-Windows runs use an isolated
process group and require that group to disappear before marking.

The window is visible so an operator can click the real Gateway button and
scan with WeCom. The main window can remain only on the initial Gateway path.
One reviewed history-only exception matches the frozen Gateway
`official-entry.js`: after the exact authorization URL has loaded, one
`history.replaceState` may remove the state query while keeping the exact
Gateway origin and transaction path. It cannot happen early or twice, retain
any query, or change origin/path. Real navigation, redirects, and frame
navigation to the query-free URL remain blocked.
Only one popup at `https://work.weixin.qq.com/ai/qc/gen` with the expected
source/state/timestamp shape is accepted. Unknown navigation, redirects,
nested windows, webviews, permissions, downloads, DevTools, renderer crashes,
or premature window closure fail closed. This host does not ignore TLS
certificate errors and does not collect console output, HAR, trace, screenshots,
or renderer payloads.

After the Gateway Pilot observes the expected terminal state, it sends the
shutdown record. The launcher emits exactly one public record prefixed with
`PB02_ELECTRON_LIVE_RESULT=`. Its JSON contains only:

- `protocolVersion`
- `result`
- `failureCode`
- `electronVersion`
- `popupCreated`
- `officialOriginObserved`
- `navigationPolicyPassed`
- `cleanupStatus`
- `producerMarkerStatus`

A PASS requires all policy booleans to be true, Electron `40.10.2`, retained
cleanup, and an `operator_asserted` producer marker. Raw errors, stacks, URLs,
states, transaction IDs, Bot IDs, secrets, and envelopes are never forwarded.
This PASS means only that the isolated Electron host completed its reviewed
window lifecycle and became quiescent after the Pilot requested shutdown. It
does not mean that WeCom authorized the transaction; only the Gateway Pilot's
terminal-status, redeem, scan, and acknowledgement checks can make that claim.

The retained root receives the existing compatible
`.wecom-pb02-producer.json` after the Electron PID has exited. Its producer
remains `electron-auth-probe` because the current Gateway scan manifest freezes
that value. This marker is unsigned and remains **operator-asserted** evidence;
it does not make `fullLiveSecretScanSatisfied` true by itself. Policy-denial
runs that complete the final snapshot handshake retain their isolated root and
may write the quiescent marker so failure artifacts can be scanned. Crashes and
incomplete cleanup never write it.

Run the offline protocol and policy tests without contacting Gateway or WeCom:

```powershell
npm run test:wecom-electron-host-live
```

An explicit Windows integration check starts the pinned Electron but contacts
only the deliberately unreachable loopback endpoint `https://127.0.0.1:1`.
It proves the anonymous IPC relay, fail-closed load handling, single sanitized
result, quiescent marker, and exited producer PID without contacting WeCom:

```powershell
npm run test:wecom-electron-host-live:loopback
```

The pinned-Electron success fixture uses the exact shared host wiring used by
live mode. It exports the existing .NET development certificate temporarily,
serves only local HTTPS, and injects certificate verification directly from the
fixture main process. No certificate override, alternate auth origin, or test
field exists in the live stdin schema. The fixture covers the frozen bundle's
one-time state scrubbing, successful popup plus shutdown, nested-window denial,
redirect denial, a late Electron utility reported by AppMetrics, the three-ACK
shutdown handshake, handle-based quiescence, and monitor-process exit. The
Windows test file contains a `taskkill` fallback only to clean up its own
synthetic target after an assertion failure; the live implementation never
invokes `taskkill`:

```powershell
npm run test:wecom-electron-host-live:success-fixture
```

No certificate trust setup is required before this test, and it never contacts
the real Gateway or WeCom.

The live command is normally spawned by the Gateway Pilot, which keeps stdin
open while it polls the transaction. Starting this script manually without
that orchestrator is not a complete PB-02 acceptance test.
