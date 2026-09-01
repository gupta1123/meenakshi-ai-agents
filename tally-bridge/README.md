# Meenakshi Tally bridge

This is the Windows-only local agent that talks to the Tally Prime HTTP/XML endpoint. It is independent of the hosted `backend` service and must run on the computer where Tally is reachable.

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
