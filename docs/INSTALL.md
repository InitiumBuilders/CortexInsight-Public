# Install

Three ways to put the console on your machine, from the quickest to the most hands-on, on Windows or on a Mac. All of them end in the same place: an app you can open, a vault in your user data, and the gate asking you to set a passphrase.

## What you need

- Windows 10 or 11 (64-bit), or macOS 12 or newer on Apple silicon or Intel.
- For building from source: Node 20 or newer with npm, and Git.
- For the fleet features: a fleet tree in a home folder (`logs/interactions` and `agents` inside it) and the loopback relay on `127.0.0.1:8788`. On Windows the tree lives in WSL2; on a Mac it is a folder in your home. The console opens and runs without these; Pulse tells you what is missing and where to set the path.

## What works where

| | Windows | macOS |
|---|---|---|
| The console, every view, the harnesses | yes | yes |
| Fleet tree discovery and the bridge | yes, in WSL | yes, in your home |
| The relay, Command, loops, workflows, the board, the reading | yes | yes |
| Motus Max in work mode (files, commands, APIs) | yes | yes |
| Motus Max on the screen (pointer, keyboard, window probe) | yes | not yet; the console says so when asked |
| Self-update from a staged build | yes | not yet; run the install script again |
| Relay restart from the heal panel | yes, through WSL services | no; start the relay by hand |
| Sealed keys | DPAPI | Keychain |
| Voice, the studio, the second stack, the broadcast | yes | yes |

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

## On a Mac

**Download.** Take `CortexInsight-<version>-mac-arm64.zip` on Apple silicon or `-mac-x64.zip` on Intel from the Releases page, unzip, and move `CortexInsight.app` where you like. The build is not signed or notarised, so the first open needs one of two things: right-click the app, Open, Open; or, in a terminal:

```bash
xattr -dr com.apple.quarantine /path/to/CortexInsight.app
```

**One command from a clone.**

```bash
git clone https://github.com/InitiumBuilders/Semble-CC.git
cd Semble-CC
bash build-and-install.sh
```

It checks the toolchain, installs from the lockfile, packages for this Mac's architecture, quits a running console, keeps the previous app as `CortexInsight.app.prev`, copies the new one into `~/Applications`, clears the quarantine flag, proves the version by reading the installed bundle, rolls back on a mismatch, and launches. Options: `--no-launch`, `--skip-deps`, `--dest <folder>`. `npm run deploy:mac` does the same.

**By hand.** `npm ci`, then `npm run package:mac` (Apple silicon) or `npm run package:mac-x64` (Intel); the app is in `release-next/`. `npm start` runs from source.

**Where things live on a Mac.** The app wherever you put it. The vault in `~/Library/Application Support/cortexinsight/`. The agent tool, the brief and the queue in `~/.cortexinsight/`. Uninstall by quitting, deleting the app, and deleting the vault folder if you want it gone.

**The fleet on a Mac.** Claude Code runs natively, so the fleet tree is a folder in your home and the relay listens on localhost. Set the fleet path on Config if discovery did not find it. The bridge installs into the runner the same way.

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
npm run fleet     # a stranger's fleet: a synthetic tree is built, read, briefed, tooled and shown; read %TEMP%\ci-fleet-report.txt
npm run smoke     # every view with your own vault copied into a sandbox
```

The continuous build runs the gate, the fresh harness and the fleet harness on every push, on a Windows runner and a macOS runner, and uploads each run's reports and screenshots as artifacts, so the foreign-machine proof is a link away on the Actions page. The fleet harness is the one that proves the readers, the brief, the agent tool and the inbox against a fleet tree on a machine that has none.
