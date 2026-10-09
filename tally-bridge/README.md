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

### Upgrade to 0.3.2 (9 October 2026)

This release includes guarded same-customer/same-invoice Receipt New Ref matching for the per-MT CD check (BKP invoice 1418). It does not clear calculations, change rules or create notes automatically.

1. Wait until no calculation, voucher creation or PDF export is running. Exit the existing Meenakshi connector.
2. Run `installer/output/MeenakshiTallyConnectorSetup-0.3.2.exe` on the Tally computer. Upgrade in the existing connector folder (normally `C:\Meenakshi\tally-bridge`); do not select a general-purpose directory. The installer replaces the application-folder contents, including old connector logs. It preserves the default pairing/configuration and captured PDFs in `%APPDATA%\Meenakshi\TallyBridge`, outside that folder. A custom config/PDF directory inside the application folder must be backed up externally first.
3. Launch Meenakshi Tally Connector, open the intended company in Tally and refresh the deployed Meenakshi page. Existing pairing should be retained. Only pair again through the deployed application's connection flow if the connector actually reports unconfigured/disconnected.
4. Deploy the matching backend source change separately. Installing the connector alone does not update the hosted backend, which independently rechecks the result. Do not mark the fix verified before both are updated.
5. After both components are updated, rerun the CD calculation and inspect 1418: expected paid-by-deadline ₹3,04,926, shortfall ₹7,735 and review candidate ₹2,520. Do not issue a Credit Note or delete prior results/accounting records during this check.

The setup filename and Windows product version distinguish this build from the older unversioned installer. Building it does not install it or deploy the backend.

### Upgrade to 0.3.3 (9 October 2026)

Adds guarded recognition of legacy CD Credit Note narration such as Kumaran Steel's `Discount allowed ... B.No.192`, retaining the 0.3.2 New Ref fix. A uniquely matched existing note marks the invoice already credited and suppresses a new candidate. Ambiguous and multi-bill narration is not automatically allocated.

Run `installer/output/MeenakshiTallyConnectorSetup-0.3.3.exe` after all jobs finish and the connector is closed. Use the same existing application directory and configuration backup precautions described above. This is a connector-source fix; no additional backend change is introduced by 0.3.3. After launch, recalculate Cash Discount and check Kumaran invoice 0192: paid-by-deadline ₹14,72,066 remains unchanged; CN14 / ₹11,405 should be recognised and Create should be absent. Do not post another note to test this.

Workflow: when a connector source fix needs a new installer, build the versioned installer automatically and report installation/retest steps. Building is not permission to install it, deploy or change accounting records.

### Upgrade to 0.3.4 (9 October 2026)

Implements Shubham's confirmed CD policy: full payment by the deadline still earns a staff-created discount credit; a deadline shortfall subsequently paid in full receives no new credit. Original deadline categories and existing Credit Notes remain as history. Both the backend and connector evaluator must be updated; the frontend explains the later settlement instead of offering Create.

After all jobs finish, close the connector and run `installer/output/MeenakshiTallyConnectorSetup-0.3.4.exe` in the existing application directory, using the same configuration/PDF backup precautions above. Launch it with the intended Tally company open, refresh the matching updated application, and rerun Calculate BEFORE using any saved Create action. Expected: Amr 0010 still offers ₹5,000; BKP 1418 and 3165 show no new credit after late full settlement; Kumaran 0192 remains already credited. Do not delete old cases or create notes during validation.

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
