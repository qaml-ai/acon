# acon

This repository is the standalone `acon` desktop app.

## File Transfer

- User-uploaded files are mounted into the guest container at `/mnt/user-uploads`.
- Read user-provided input files from `/mnt/user-uploads` when the prompt references them.
- User-deliverable artifacts such as spreadsheets, reports, exports, and generated documents should be written to `/mnt/user-outputs`.
- When you create a deliverable in `/mnt/user-outputs`, mention the full output path in your response so the desktop app can surface it for download.

## Repo Notes

- Prefer `desktop-container/` for runtime and extension-host changes.
- Prefer `desktop/renderer/` and `src/` for desktop UI changes.
- Keep chat as a builtin trusted plugin surface rendered inside the workbench host tree, not as a webview.
- When running a web server inside the guest container, bind it to `0.0.0.0` instead of `localhost`.
