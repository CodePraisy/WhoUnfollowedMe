# WhoUnfollowedMe

A desktop app for Windows and Mac that shows who doesn't follow you back on Instagram and tracks who unfollows you over time.

## Download

Get the latest build from the [Releases page](https://github.com/CodePraisy/WhoUnfollowedMe/releases).

**Windows 10/11 (64-bit)**
- `WhoUnfollowedMe-Setup-x.y.z.exe` installs it with Start menu and desktop shortcuts.
- `WhoUnfollowedMe-Portable-x.y.z.exe` runs without installing.

The builds aren't code-signed, so Windows SmartScreen may warn the first time: choose **More info → Run anyway**.

**Mac (macOS 11 or newer)**
- Apple Silicon (M1 and later): `WhoUnfollowedMe-x.y.z-mac-arm64.dmg`
- Intel: `WhoUnfollowedMe-x.y.z-mac-x64.dmg`

Open the .dmg and drag WhoUnfollowedMe into Applications. The app isn't notarized by Apple, so the first time macOS will say it can't verify the developer. Open **System Settings → Privacy & Security**, scroll down, and click **Open Anyway** next to WhoUnfollowedMe (you only do this once).

## Run from source

1. Install Node.js 22 or newer from https://nodejs.org.
2. Windows: double-click `start.bat`. Mac or Windows terminal: `npm install`, then `npm start`.

The only dependency is Electron, and `npm install` reports 0 vulnerabilities.

## Build it yourself

- `npm run dist` builds for the computer you're on (Windows: installer + portable exe; Mac: .dmg files). Output lands in `dist/`.
- Or let GitHub build both: bump `"version"` in `package.json` and push to `main`. The workflow builds Windows and Mac and publishes one release with all the files, in about 10 minutes.

## How it works

Instagram has no public API for follower lists, so the app opens instagram.com's real login page in its own window. You log in there (2FA works as normal), and the app then reads your followers and following through that signed-in session, the same requests instagram.com makes when you open those lists. Your password never touches the app.

Scans are paced like a person scrolling: 1–2.5 s between pages and a longer pause every 12 pages. If Instagram says to slow down, the app waits and resumes on its own. Expect about a minute per thousand accounts.

## Features

- **Overview**: a diagram of followers vs. following. Click any region to open that list.
- **Don't follow back**: everyone you follow who doesn't follow you. Star accounts you're fine with (celebrities, brands) to hide them.
- **Unfollowed you**: each scan is saved and compared with the one before, so from the second scan on you see exactly who left and when, plus whether you still follow them.
- **New followers**, **Fans** (you don't follow back), **Mutuals**, full **Followers** / **Following** lists.
- **Scan history** with a follower trend chart.
- Profile pictures for every account, saved on your computer so they keep showing after Instagram's picture links expire.
- Light, dark, or match-Windows theme (switch in the top bar).
- Search (Ctrl+K), filters for verified and private accounts, sorting, and CSV export.
- Unfollow or follow back from inside the app, one at a time, with a 4.5 s gap and a 40-per-hour cap so Instagram doesn't block your account. Every change is confirmed with Instagram before the app shows it as done.
- **Back up / restore**: save every scan, starred account and profile picture to one `.wumbackup` file and restore it on another computer. Restoring merges with what's already there and never duplicates scans. Your Instagram login is not included.
- **Data download mode**: no login needed. In Instagram go to Accounts Center → Your information and permissions → Download your information, pick **JSON** format and "Followers and following", unzip it, then choose that folder in the app.

## Where data lives

Everything stays on your computer, in `%APPDATA%\WhoUnfollowedMe\` on Windows or `~/Library/Application Support/WhoUnfollowedMe/` on Mac (the **Data folder** button opens it):

- `accounts\` – your scans, one file per Instagram account
- `avatars\` – cached profile pictures
- `Partitions\instagram\` – your Instagram login session
- `settings.json` – theme choice
- `debug.log` – request status codes and errors for troubleshooting (no follower data or login details)

Nothing is sent anywhere except instagram.com.

## Notes

- Accounts loaded from a data download show initials instead of photos, because the download doesn't include pictures.
- This uses Instagram's private web endpoints. They can change without notice; if scanning breaks, data download mode still works.
- Automated access is against Instagram's terms. Scanning your own lists at this pace is low-risk, but don't run scans back to back or unfollow hundreds of accounts in a day.
