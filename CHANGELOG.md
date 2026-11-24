# Changelog

All notable changes to Music Stats are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), with versions in the form
v<major>.<minor> (two-digit minor) to match the Git tags and Docker image tags.

## [Unreleased]

## [1.01] - 2026-11-24

### Changed
- Help now covers Show files in Missing tags (and Show folders for artist pictures), clicking a
  letter in Artists A to Z, and the Track lengths chart.

## [1.00] - 2026-11-24

### Added
- First release: your music collection in numbers, read from the tags of MP3, FLAC, M4A, OGG,
  Opus, WMA, WAV and other audio files, read-only.
- Totals (tracks, albums, artists, genres, playing time, size, years), decades, a timeline of
  years, top genres, genres by decade, top artists by tracks, time, albums or disk space,
  artists A to Z, artist pictures (`artist.jpg` in the artist's folder) with a header for the
  artist picked, album covers (a picture beside the music or inside the files) with a header for
  the album picked, biggest albums, longest and shortest tracks, track lengths, formats and
  bitrates, music added by year, recently added albums, and missing tags (cover art in the file or
  its folder, artists with no picture) with examples.
- Click any decade, year, genre, artist, album, format or letter to narrow every chart to it; search.
- Settings to pick which music folders are read, with a folder browser, Add folder and Remove;
  each folder shown on its own or together; libraries (such as PC and NAS) for the same music in
  two places, with a switch between them. `COLLECTIONS` gives a first list.
- Your music folders are set in `.env` (`MUSIC_FOLDER`, `MUSIC_FOLDER_2`), so `docker-compose.yml` needs no
  changes.
- A cache of tags so rescans only read new and changed files; rescans at start-up, every
  `SCAN_HOURS` and on demand, counting the files first for a progress bar with the time left,
  then reading `SCAN_READERS` (default 16) at once. A first scan saves as it goes. A missing music
  folder keeps its tracks from the last scan.
- Sign-in with one username and password and a lockout after 10 wrong passwords in 15 minutes.
- Light and dark looks, Help, About and `GET /healthz`.
