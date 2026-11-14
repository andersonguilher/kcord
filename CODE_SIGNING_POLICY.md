# Code signing policy

Free code signing provided by [SignPath.io](https://signpath.io), certificate
by [SignPath Foundation](https://signpath.org).

- **Signed files:** the KCord Windows installer, `KCord.exe`, and the native
  helper `kcord-app-audio.exe`.
- **Source of builds:** only binaries built from this repository's public
  source by the project's CI are submitted for signing.
- **Roles:** the maintainer (Anderson Guilherme) is author, reviewer, and
  approver of signing requests. All team members with signing access use
  multi-factor authentication.
- **Privacy:** the desktop app loads `https://kafcord.kafly.com.br` and checks
  `https://kafcord.kafly.com.br/downloads/latest.yml` for updates. It sends
  crash and failure reports to that server only; it does not transfer other
  information to third parties without the user's explicit action.

This policy takes effect once the SignPath Foundation approves the project.
