# Changelog

## 0.1.4

- Quoted password values treat a doubled quote as an escape (`''` and `""`) and redact through the real closing quote. Fixes [#3](https://github.com/Jasper31943/PRtape/issues/3).

## 0.1.3

- Emails are redacted by default; `--no-redact-emails` leaves them visible, and `--redact-emails` still turns them on.
- With `--no-redact-emails`, the title keeps emails too. Previously the title always stripped them.
- Database URLs with credentials and password values are redacted, including `*_PASSWORD=`, `PGPASSWORD=`, `export`, `--password`, JSON, YAML, TOML, and single-quoted keys. A quoted value is removed through its closing quote. The word password in prose is left alone.
- `--redact-domain` and `PRTAPE_REDACT_DOMAINS` redact a chosen domain and its subdomains. Older `AGENTTAPE_*` variables still work as fallbacks.

## 0.1.2

- Public repos no longer show the private-repo broken-image warning.

## 0.1.1

- Help keeps one tagline and shows `npx prtape-cli pr`.
- The README lists the fixed formats v0.1 redacts, and the kinds of secrets it does not catch.
