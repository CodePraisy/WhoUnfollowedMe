# WhoUnfollowedMe

[![Latest release](https://img.shields.io/github/v/release/CodePraisy/WhoUnfollowedMe?label=release)](https://github.com/CodePraisy/WhoUnfollowedMe/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/CodePraisy/WhoUnfollowedMe/total)](https://github.com/CodePraisy/WhoUnfollowedMe/releases)
![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

See who doesn't follow you back on Instagram, who unfollowed you, and clean up your following list, all from a desktop app on Windows or Mac.

## Download

Links always point to the newest release. Older versions: [all releases](https://github.com/CodePraisy/WhoUnfollowedMe/releases).

| File | Platform | Requirements |
|---|---|---|
| [`WhoUnfollowedMe-Setup.exe`](https://github.com/CodePraisy/WhoUnfollowedMe/releases/latest/download/WhoUnfollowedMe-Setup.exe) | (Windows installer) | Windows 10/11, x64 |
| [`WhoUnfollowedMe-Portable.exe`](https://github.com/CodePraisy/WhoUnfollowedMe/releases/latest/download/WhoUnfollowedMe-Portable.exe) | (Windows portable, no install) | Windows 10/11, x64 |
| [`WhoUnfollowedMe-mac-arm64.dmg`](https://github.com/CodePraisy/WhoUnfollowedMe/releases/latest/download/WhoUnfollowedMe-mac-arm64.dmg) | (Mac, Apple Silicon: M1 and newer) | macOS 11+ |
| [`WhoUnfollowedMe-mac-x64.dmg`](https://github.com/CodePraisy/WhoUnfollowedMe/releases/latest/download/WhoUnfollowedMe-mac-x64.dmg) | (Mac, Intel) | macOS 11+ |

To check which Mac you have: Apple menu → **About This Mac**. "Chip: Apple M…" means Apple Silicon.

### Installing

**Windows:** open the installer. If Windows shows "Windows protected your PC", click **More info → Run anyway**. (The builds aren't code-signed, so SmartScreen doesn't recognize the publisher yet.)

**Mac:** open the .dmg and drag WhoUnfollowedMe into Applications. The app is ad-hoc signed but not notarized, so Gatekeeper blocks the first launch; go to **System Settings → Privacy & Security**, scroll down and click **Open Anyway**. You only do this once.

## How to use it

1. Click **Log in with Instagram** and sign in on Instagram's own page. Your password goes to Instagram, never to the app.
2. Click **Scan now**. It reads your followers and who you follow (about a minute per thousand accounts).
3. Look through the results:
   - **Don't follow back**: people you follow who don't follow you
   - **Unfollowed you**: who left since your last scan (from your second scan on)
   - **New followers**, **Mutuals**, and people **you** don't follow back
4. Unfollow or follow back one at a time, or tick several and do them all at once.

Scan every few days to catch new unfollowers. Everything is saved on your computer only.

## Features

- Diagram of followers vs. following; click a section to see those accounts
- Unfollower history and a follower trend chart across scans
- Mass unfollow / follow back with a progress bar and Stop button
- Star accounts (celebrities, brands) to hide them from "Don't follow back"
- Safety limits with green / yellow / red usage rings, plus an **Override** setting (with a warning)
- Search, filters, sorting and spreadsheet (CSV) export
- Light, dark or match-system theme
- Back up your scans and restore them on another computer
- Works without logging in using Instagram's own data download

## Staying safe

Instagram limits how much an account can scan, follow and unfollow, and doesn't say what the limits are. The app keeps you under cautious defaults: 8 scans a day, 150 follow changes a day (40 an hour), at least 5 seconds apart. You can change them in **Settings**. Going past them with **Override** risks Instagram restricting or banning your account.

Using automated tools is against Instagram's terms. Use this on your own account, at a normal pace, at your own risk.

## Privacy

- Nothing is sent anywhere except instagram.com.
- Your scans, settings and login stay on your computer:
  - Windows: `%APPDATA%\WhoUnfollowedMe\`
  - Mac: `~/Library/Application Support/WhoUnfollowedMe/`
- Backups don't include your login.

## Without logging in

In Instagram go to **Accounts Center → Your information and permissions → Download your information**, choose **Followers and following** in **JSON** format, unzip the download, and in the app choose **Settings → Import**. Accounts from a download show initials instead of photos.

---

## For developers

### Run from source

Requires Node.js 22+.

```
npm install
npm start
```

On Windows you can also double-click `start.bat`.

### Build

- `npm run dist` builds for the current OS into `dist/` (Windows: installer + portable exe; Mac: .dmg for arm64 and x64).
- Releases are built by GitHub Actions: bump `"version"` in `package.json` and push to `main`. The workflow builds Windows and macOS in parallel and publishes one release. File names have no version number, so the download links above always point to the newest release.

### How it works

Instagram has no public API for follower lists. The app opens instagram.com's login page in its own window, then calls the same internal web endpoints instagram.com uses, from a hidden same-origin page so the session cookies apply:

- Lists: `friendships/{id}/followers|following` (GraphQL query fallback), paged with 1–2.5 s pauses and a longer pause every 12 pages; 429s back off and retry.
- Unfollow / follow: Instagram's current GraphQL mutations with the page's session tokens, falling back to pressing the real button on the profile page; every change is confirmed with `friendships/show` before it's reported.
- Profile pictures load through a custom `igimg://` protocol and are cached on disk.

### Data files

In the data folder: `accounts/` (scans, one file per account ID), `avatars/` (picture cache), `Partitions/instagram/` (login session), `settings.json`, `usage.json` (last 24 h of scans and follow changes, for the limits), `debug.log` (request status codes only, no follower data).

### Stack

Electron 45, plain HTML/CSS/JS (no framework), electron-builder. Only dependency: Electron (`npm install` reports 0 vulnerabilities).

## License

MIT © 2026 Praise Onuoha
