# Meenakshi Tally bridge

This is the Windows-only local agent that talks to the Tally Prime HTTP/XML endpoint. It is independent of the hosted `backend` service and must run on the computer where Tally is reachable.

## Server pilot (0.5.3)

### Manual Credit Notes (0.5.4)

Version 0.5.4 recognizes existing Cash Discount Credit Notes from their customer and invoice/bill allocations. It accepts manual wording and accounting notes without a party header. A note split across invoices uses each allocated amount once. On-account notes use an unambiguous full invoice reference; unresolved or partial notes require review and cannot create another Credit Note. Other adjustments remain separate from Cash Discount; sales returns require quantity review. CD and TOD share the matching code.

Update the connector on the Tally computer using `MeenakshiTallyConnectorSetup-0.5.4.exe` under the same Windows account. Pairing and PC/server mode are preserved. Restart the connector (and the existing Windows background task if configured), confirm it is connected, then run a fresh CD check. The deployed app keeps older checks readable but blocks Credit Note creation until a check from the updated reader is saved. No database migration is needed for this update.

For an isolated real-Tally check, keep **Solution Nyx** with GUID `6a1e6251-3050-4d46-8ccf-847e223ac92d` open locally and run `node scripts/verify-manual-credit-notes.mjs --seed`. This creates only dedicated test masters and three invoice/receipt/note sets. Running it again without `--seed` is read-only. `--runtime-source <packaged resources/app/src>` verifies the packaged reader against the same entries. The script refuses every other company and uses only `localhost:9000`.

The hosted backend must have the server-job recovery migration before this version is used in server mode. Existing PC connectors can continue using the PC workflow.

Version 0.5.3 adds a server status window with live background-process activity, Windows task state and startup-at-login status. Opening or closing this window does not start, stop or disconnect the background server. Status comes from the existing worker through a local named pipe; no browser API is enabled. Version 0.5.2 fixed Windows startup setup falsely reporting a failed mode change when using the bundled Electron runtime.

1. Install and pair the connector on the Windows machine that keeps the approved Tally company open. Exit its status window before enabling background startup.
2. From the installation directory, run `powershell -ExecutionPolicy Bypass -File .\install-server-task.ps1` as that same Windows user. The package includes its Node runtime and the hidden startup runner; no separate Node installation is needed.
3. An administrator selects **Use the Tally server** in the website. Both the machine configuration and the website must be in server mode. Do this with an empty queue; keep the old PC connector stopped during the pilot.
4. After a Windows reboot, log on as that user and open Tally with the matching company. Disconnecting Remote Desktop keeps the session running; signing out ends it.
5. To remove background startup, run the setup script with `-Remove`, then switch the website back to PC mode after work has finished.

Server calculations use leased job attempts and durable saving through the existing evaluation worker. CD and all TOD periods continue without a page open. A failed save is retried with the same permanent job key; it is not resubmitted by the browser.

`../autodealer-workflow` is reference-only. Do not run its bridge for Meenakshi or copy its business commands into this package.

## Local setup

1. Install Node.js 20 or newer on the Tally machine.
2. Ensure Tally Prime's HTTP/XML server is available, normally at `http://localhost:9000`.
3. Run `npm.cmd run machine-id` and give the resulting fingerprint to the Meenakshi Administrator when registering the connector.
4. The Administrator registers and binds that connector, then provides its installation key and one-time control token.
5. To let the browser open the local bridge automatically, run this once from the `tally-bridge` folder:

```powershell
npm.cmd run install-protocol
```

6. In Meenakshi Collections, choose **Generate and open bridge**. Windows opens the `meenakshi-tally://` link, verifies the open Tally company, pairs the bridge, and starts it in the background.

If the automatic link is unavailable, configure this bridge without putting the token in a shell history where possible:

```powershell
npm.cmd run connect -- --api-base http://localhost:3001 --connector-id <connector-uuid> --installation-key <installation-key> --control-token <one-time-token> --tally-url http://localhost:9000
npm.cmd run start
```

`connect` saves the protected local configuration, checks that Tally can identify the active company, pairs the bridge, and sends its first heartbeat. It is safe to run again after pairing; it will re-check Tally and refresh the heartbeat. `start` must remain running while master or voucher synchronizations are in progress.

Configuration is stored outside this repository in `%APPDATA%\Meenakshi\TallyBridge\config.json`. Treat it as a secret file.

`npm.cmd run start` sends a heartbeat, validates the active Tally company, and processes one command at a time. It handles the master, voucher, and evidence-refresh commands issued by the Meenakshi backend.

## Meenakshi desktop connector

The repository now includes an isolated Electron shell and Windows installer definition under `installer/`. It uses the `meenakshi-tally://` protocol, installs into `C:\Meenakshi\tally-bridge`, and preserves the bridge configuration in `%APPDATA%\Meenakshi\TallyBridge`. It does not read, write, or register the Gajkesari connector.

Validate the installer sources from this folder with:

```powershell
npm.cmd run installer:validate
```

To run the Electron shell during development, install the Electron runtime in `installer/electron-app`, then run:

```powershell
npm.cmd run desktop:dev
```

To build the Windows setup executable, set `MEENAKSHI_CONNECTOR_RUNTIME` to a directory containing an Electron runtime and ensure Inno Setup 6 is installed, then run:

```powershell
npm.cmd run installer:build
```

The build writes only to `installer/payload-clean` and `installer/output` inside this Meenakshi repository.

## Verified Credit Note PDFs

Run this once after the bridge is connected:

```powershell
npm.cmd run configure-pdf-capture
```

This creates the protected local capture folder shown by the command. Tally Prime must export the verified Credit Note through its native **Alt+E > Current > PDF** flow to that folder, using the filename `<verified-tally-guid>.pdf`. The bridge independently re-reads the voucher, validates the PDF signature and checksum, and then uploads the exact native file for the Collections viewer. It never converts XML, prints the browser, or recreates a document.

## Test fixtures

`fixtures/tally/` contains sanitised XML from a controlled test company. It covers group hierarchy, customer/source identities, UOMs, stock items, a sales voucher, an `Agst Ref` receipt allocation, and a cancelled return. Never place production exports or customer data in this folder.

## Commands supported by the server

The bridge supports pairing, heartbeat, and command leases, along with `sync_meenakshi_masters`, `sync_meenakshi_vouchers`, `fetch_meenakshi_evidence`, and the controlled Credit Note commands. The browser never reads raw Tally XML directly.
