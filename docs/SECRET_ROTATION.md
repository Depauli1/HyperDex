# Secret rotation runbook

A signing key and a keystore password were committed in `be77730` and sat at the
tip of the **public** `main` branch.

- **Account:** `0x757028709e10Af24955d97Aed7CDB0Ad1b4cF10A`
- **Where:** `.env`, `relayer/.env.test`, `relayer/test/.env.test`,
  `relayer/keystore/test-keystore.json`
- **Also leaked:** `KEYSTORE_PASSWORD` in plaintext (`testpassword`)
- **Not a fixture:** this is not one of Hardhat's documented dev accounts, so it
  must be assumed to be a real key that may have held funds.

## 1. Rotate the key first — nothing else is a control

Removing a secret from the working tree does **not** remove it from history, and
removing it from history does not un-leak it. On a public repo the value should
be treated as already harvested.

1. Generate a replacement key. Never reuse the old one, and never derive the new
   one from the old mnemonic.
2. Move any assets out of `0x757028709e10Af24955d97Aed7CDB0Ad1b4cF10A` while you
   still can. Assume you are racing a sweeper bot.
3. Revoke anything the old key could authorise: token allowances, relayer
   registration (`HyperDex.setRelayer`, `BridgeRouter.setRelayer`), factory
   ownership, and any deployment admin role.
4. Deploy from the new key and update the relayer keystore
   (`node relayer/keystore/generate-keystore.js`).
5. Rotate `KEYSTORE_PASSWORD` too — it was committed in the clear.
6. Check the old address for unauthorised activity and record what you find.

Treat the old key as permanently burned regardless of what the history rewrite
achieves.

## 2. Then decide whether to rewrite history

History rewriting is hygiene, not remediation. It is worth doing here because
the repository has only three commits and the secret is in the base commit, so
the rewrite is unusually cheap. But note what it does **not** fix: forks,
existing clones, PR refs, and GitHub's cached views can all retain the old
objects.

Preferred tool is [`git filter-repo`](https://github.com/newren/git-filter-repo)
(`git filter-branch` is deprecated and slow; BFG needs a JVM):

```bash
pip install git-filter-repo

git clone --mirror https://github.com/Depauli1/HyperDex.git
cd HyperDex.git

# Replace the secret values with a marker in every revision.
printf '%s\n' \
  'regex:[0-9a-f]{64}==>REDACTED-PRIVATE-KEY' \
  > replacements.txt
git filter-repo --replace-text replacements.txt --force

git push --force --mirror
```

Then:

- Ask GitHub Support to expire cached views and run garbage collection; until
  then the old commits remain reachable by SHA.
- Every collaborator must **re-clone**. A `git pull` after a force-push will
  reintroduce the old objects.
- Close or rebase any open pull request; their refs keep the old history alive.
- Re-issue any CI/CD credential that was ever committed.

Do not do this on a repository other people are actively working in without
telling them first.

## 3. Prevention

Already in place:

- `scripts/check-secrets.js` scans tracked files for private keys, mnemonics,
  plaintext keystore passwords and committed keystores. Run it with
  `npm run secrets:check`, optionally against a revision
  (`node scripts/check-secrets.js <rev>`).
- CI runs it before compiling, so a secret cannot land on a branch.
- `npm run hooks` installs a `pre-commit` hook that runs the same check.
  `npm install` does this automatically via the `prepare` script.
- `.gitignore` covers `.env`, `.env.*` (except `.sample`/`.example`) and
  `relayer/keystore/*.json`.

Still to do:

- The relayer should read its key from the encrypted keystore or a secrets
  manager, not a raw hex value in `.env`. `relayer/src/index.js` already
  supports a keystore path; make it the only supported path for production.
- Add a scheduled job that re-runs the scan over **all** history, not just HEAD,
  so a secret pushed to an unmerged branch is still caught.
