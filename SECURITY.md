# Security Policy

## Reporting a Vulnerability

Please report security vulnerabilities privately — do not open a public
GitHub issue for a suspected vulnerability.

Email **rafi@premisesaas.com** with:

- A description of the issue and its impact
- Steps to reproduce (a minimal repro is ideal)
- The affected version (`lore --version` or the `version` field in
  `package.json`)

We aim to acknowledge reports within 5 business days and to agree on a
disclosure timeline with the reporter before any public write-up.

## Supported Versions

Only the latest published release is supported. Lore moves fast; please
upgrade before filing a report if you're more than a few versions behind.

## Dependency Vulnerabilities

Known `npm audit` findings against third-party dependencies (not Lore's own
code) are tracked in [docs/SECURITY_ADVISORIES.md](docs/SECURITY_ADVISORIES.md).
