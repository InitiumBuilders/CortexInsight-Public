# Install

Three ways to put the console on your machine, from the quickest to the most hands-on. All three end in the same place: a folder with `CortexInsight.exe` in it, a vault in your user data, and the gate asking you to set a passphrase.

## What you need

- Windows 10 or 11, 64-bit.
- For building from source: Node 20 or newer with npm, and Git.
- For the fleet features: WSL2 with a fleet tree in a home folder (`logs/interactions` and `agents` inside it) and the loopback relay on `127.0.0.1:8788`. The console opens and runs without these; Pulse tells you what is missing and where to set the path.

## 1. Download a release

Every version tag builds on a Windows runner that none of the authors have touched. The zip on the Releases page is that build.

1. Open https://github.com/InitiumBuilders/Semble-CC/releases and download `CortexInsight-<version>-win-x64.zip`.
2. Unzip it anywhere you like, for example `C:\Apps\CortexInsight`.
3. Run `CortexInsight.exe`.

Windows SmartScreen may warn that the publisher is unknown, because the build is not code-signed. More info → Run anyway. If you would rather not trust a download, build it yourself with the next method; the result is byte-for-byte the same packager output.

Self-update looks for a newer build staged beside the project tree, so a downloaded zip updates by downloading the next zip.

## 2. One command from a clone

```powershell
git clone https://github.com/InitiumBuilders/Semble-CC.git
cd Semble-CC
powershell -ExecutionPolicy Bypass -File .\Build-And-Install.ps1
```

The script says what it does at every step: it checks the toolchain, installs dependencies from the lockfile, packages the app into `release-next\`, then hands the staged build to `scripts\install.ps1`, which closes a running console, swaps the folders with retries, re-reads the installed binary to prove the version, rolls back if the proof fails, deletes staging only after proof, puts a shortcut on the desktop, and launches.

Switches: `-NoLaunch`, `-NoShortcut`, `-SkipInstallDeps`.

The same thing through npm:

```bash
npm run deploy
```

To update later: pull, then run the script again. The previous build stays beside the live one as `release\CortexInsight-win32-x64.prev` until the next install.

## 3. By hand

```bash
npm ci
npm run package                                   # release-next\CortexInsight-win32-x64\
powershell -ExecutionPolicy Bypass -File scripts\install.ps1   # swap, prove, launch
```

Or skip the install step and run `release-next\CortexInsight-win32-x64\CortexInsight.exe` where it is. To run from source without packaging: `npm start`.

## Where things live

| What | Where |
|---|---|
| The app | `release\CortexInsight-win32-x64\` |
| The previous build | `release\CortexInsight-win32-x64.prev\` |
| Your vault, sealed keys, the frozen index, studio images | `%APPDATA%\cortexinsight\` |
| The agent tool, the brief, the queue | `~/.cortexinsight/` in the WSL home the fleet path points at |

## Uninstall

Close the console (tray → Quit), delete the app folder, and delete `%APPDATA%\cortexinsight\` if you want the vault gone too. Nothing is written to the registry. If you installed the bridge, uninstall it from Model first; it removes its one block from the runner and leaves the backup.

## Prove it before you trust it

```bash
npm run gate      # secret shapes, private names, personal defaults
npm run fresh     # a stranger's first hour on this machine; read %TEMP%\ci-fresh-report.txt
npm run smoke     # every view with your own vault copied into a sandbox
```

The continuous build runs the gate and the fresh harness on every push, and uploads the fresh run's report and screenshots as artifacts, so the foreign-machine proof is a link away on the Actions page.
