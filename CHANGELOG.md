# Changelog

All notable changes to **LLM Context Copy** will be documented in this file.

## [1.0.0] — 2025-01-01

### Added
- `Copy for LLM: File + Project Structure` — right-click any file to copy its content alongside a full project tree
- `Copy for LLM: Project Structure Only` — tree without file content
- `Copy for LLM: Active File Only` — single file with language metadata
- `Copy for LLM: All Open Editors + Structure` — all currently open tabs + tree
- Context sub-menu in Explorer and Editor right-click menus
- Keyboard shortcuts: `Ctrl+Alt+C` (file + structure), `Ctrl+Alt+Shift+C` (structure only)
- Three output formats: Markdown, XML, Plain Text
- Smart exclusion of `node_modules`, build dirs, lockfiles, binaries
- `.gitignore`-aware tree filtering
- Git branch name in context header
- Token-count estimate notification after copy
- Fully configurable via VS Code settings
