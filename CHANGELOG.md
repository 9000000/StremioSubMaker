# Changelog

All notable changes to this project will be documented in this file.

## 1.0.1 - Progressive translation updates

- Progressive subtitle updates during AI translation:
  - Save partial translated SRT after each chunk
  - Serve partial SRT while translation is in progress (with end-of-file warning)
- Optional token-level streaming for Gemini (enable via `advancedSettings.enableStreaming`)
- Maintains SRT integrity: reindexed entries and tail message starts after last translated timestamp
- UI and API improvements:
  - Version badge added to configuration and translation selector pages
  - `/api/session-stats` now includes `version`
