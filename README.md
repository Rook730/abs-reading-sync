# Audiobookshelf Reading Sync

Obsidian plugin that syncs listening progress from a self-hosted [Audiobookshelf](https://www.audiobookshelf.org) server into book notes, and fills missing metadata (ISBN, pages, original publish year, genre) from [Hardcover](https://hardcover.app).

Built for an Obsidian Bases reading tracker: one note per book in `Books/`, frontmatter properties, views for To-Read / Reading / Finished.

## Features

- **ABS sync**: creates notes for new books, sets `status`, `progress`, `started`, `finished`, and fills blank metadata (author, narrator, series, length).
- **Hardcover enrich**: fills blank `isbn`, `pages`, `genre`; replaces ABS edition year with original release year once per note; adds a `hardcover` link for verification.
- **Preview modes** for both: writes a report note, changes nothing.
- **Template backfill**: adds fields missing from existing notes without touching values.
- Works on desktop and mobile. Auto-sync is opt-in per device.

## Never overwritten

`rating`, `media`, `genre` (once set), `owned`, `recommended_by`, `source` (once set), note body. Dates are filled only when blank. Status never moves from Finished or DNF, and is never set to To-Read.

## Network use and accounts

This plugin makes network requests to:

- **Your Audiobookshelf server** (URL you configure), to read your listening progress and book metadata. Requires an Audiobookshelf account and API token.
- **Hardcover** (`api.hardcover.app`), only when you run an enrich command or enable enrich after sync. Sends the book title and author as a search query. Requires a free Hardcover account and API token.

No other data leaves your device. No telemetry.

## Install

### BRAT (recommended, works on mobile)
1. Install the **BRAT** community plugin.
2. BRAT > Add beta plugin > enter this repo's URL.
3. Enable **Audiobookshelf Reading Sync**.

### Manual
Copy `main.js` and `manifest.json` from the latest release into `<vault>/.obsidian/plugins/abs-reading-sync/`, then enable the plugin.

## Setup

1. Settings > Audiobookshelf Reading Sync: server URL, ABS API token, **Test**.
2. Hardcover section: API token from hardcover.app/account/api.
3. Run **Preview sync**, review `ABS Sync Preview.md`, then **Sync now**.
4. Run **Preview Hardcover enrich**, review, then **Enrich book notes from Hardcover**.
5. Turn on **Auto-sync on this device** on one device only.

Tokens are stored in plain text in the plugin's `data.json`, which is excluded from this repo.

## Commands

| Command | Action |
|---|---|
| Sync now | Pull ABS progress into notes |
| Preview sync | Report only |
| Enrich book notes from Hardcover | Fill blank metadata for all book notes |
| Preview Hardcover enrich | Report only |
| Enrich current note from Hardcover | Single note |
| Add missing template fields to all book notes | Backfill template keys |

## Note schema

See `vault-files/Book.md` (template) and `vault-files/Reading.base` (Bases views).

| Property | Type |
|---|---|
| author, series, status, media, narrator, source, recommended_by, isbn, cover, abs_id, hardcover | Text |
| series_index, published, pages, length, rating, progress | Number |
| started, finished | Date |
| genre | List |
| owned | Checkbox |

## Build

```
npm install
npm run build
```

Produces `main.js`. Release: bump `version` in `manifest.json` and `package.json`, add the entry to `versions.json`, then create a GitHub release tagged with the exact version (e.g. `0.3.0`, no `v`) and attach `main.js` and `manifest.json`.

## License

MIT
