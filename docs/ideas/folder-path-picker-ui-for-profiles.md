# Idea: Folder path picker UI for profiles

## Status
Backlog idea (not implementation-ready)

## Why it might be useful
Currently profile source (OneDrive) and destination (vault) paths are entered as raw text fields. This is error-prone and requires the user to know exact paths. A folder browser/picker would make profile setup drastically easier and reduce mistakes.

## How we might do it
- Keep the text input (for power users who want to type/paste)
- Add a "Browse…" button next to each path field that opens a folder navigation UI
  - For **source path** (OneDrive): could use Microsoft Graph API to list OneDrive folder hierarchy
  - For **destination path** (vault): Obsidian's built-in folder suggest or a custom vault folder picker
- The picker could be a modal with a tree view of folders, letting users navigate and select
- Could start with just the destination vault path picker (simpler, no API dependency) and add OneDrive browsing later

## When to think about it
After the basic sync flow is verified and stable — this is a UX polish improvement on top of working functionality.

## Priority
Medium (P3). Core sync needs to work first, but this directly affects daily usability.

## Notes
Ask: does Obsidian's API expose any folder-picking primitives we could reuse?
