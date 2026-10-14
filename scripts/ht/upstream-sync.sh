#!/usr/bin/env bash
# Merge upstream Accounted into a fresh update branch and write a report.
# Never deploys and never touches the database: it only prepares a branch
# for a human to review (see .github/workflows/ht-upstream-sync.yml).
#
#   bash scripts/ht/upstream-sync.sh <base-branch> <report-file>
#
# Exit codes: 0 = merged cleanly (or already up to date), 10 = conflicts
# (merge aborted, report lists the files), anything else = error.
set -euo pipefail

BASE="${1:-staging}"
REPORT="${2:-upstream-sync-report.md}"
UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/erp-mafia/accounted.git}"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Arbetskatalogen har ocommittade ändringar; avbryter." >&2
  exit 2
fi

if git remote get-url upstream >/dev/null 2>&1; then
  git remote set-url upstream "$UPSTREAM_URL"
else
  git remote add upstream "$UPSTREAM_URL"
fi
git remote set-url --push upstream DISABLED
git fetch --quiet upstream main
git fetch --quiet origin "$BASE"

BEHIND=$(git rev-list --count "origin/$BASE..upstream/main")
if [ "$BEHIND" -eq 0 ]; then
  echo "Redan i fas med upstream." > "$REPORT"
  echo "up-to-date"
  exit 0
fi

BRANCH="update/upstream-$(date -u +%Y-%m-%d)"
git switch --quiet -C "$BRANCH" "origin/$BASE"

OLD_BASE=$(git merge-base HEAD upstream/main)
NEW_MIGRATIONS=$(git diff --name-only --diff-filter=A "$OLD_BASE" upstream/main -- supabase/migrations | sed 's#supabase/migrations/##')
# Files upstream changed that carry an HT patch: the places a human must look.
HT_PATCHED=$(git grep -l "HT patch" HEAD -- src docker supabase 2>/dev/null | sed "s/^HEAD://" || true)
TOUCHED=$(git diff --name-only "$OLD_BASE" upstream/main)
RISKY=$(comm -12 <(echo "$HT_PATCHED" | sort) <(echo "$TOUCHED" | sort) || true)

{
  echo "## Uppdatering från upstream (${UPSTREAM_URL#https://github.com/})"
  echo
  echo "- Nya upstream-commits: **$BEHIND** (från \`${OLD_BASE:0:9}\` till \`$(git rev-parse --short upstream/main)\`)"
  echo "- Nya databasmigreringar: **$(echo -n "$NEW_MIGRATIONS" | grep -c . || true)**"
  echo "- Filer med \`HT patch\` som upstream också ändrat: **$(echo -n "$RISKY" | grep -c . || true)**"
  echo
  if [ -n "$RISKY" ]; then
    echo "### Granska särskilt (HT patch + upstream-ändring)"
    echo "$RISKY" | sed 's/^/- `/; s/$/`/'
    echo
  fi
  echo "### Nya funktioner och fixar (upstream)"
  git log --no-merges --format='- %s' "$OLD_BASE..upstream/main" | grep -E '^- (feat|fix)' | head -60
  echo
  if [ -n "$NEW_MIGRATIONS" ]; then
    echo "### Migreringar (körs INTE automatiskt)"
    echo "$NEW_MIGRATIONS" | sed 's/^/- `/; s/$/`/'
    echo
  fi
  echo "### Driftsättning"
  echo "Ingenting är driftsatt. Ordning: backup → provkörning av migreringarna på en kopia → dry-run mot skarp databas → migrera → deploya (för HT: \`docs/ht/upstream-upgrade-plan.md\`)."
} > "$REPORT"

if ! git -c user.name="ht-upstream-sync" -c user.email="ht-upstream-sync@users.noreply.github.com" \
     merge --no-edit --no-ff upstream/main -m "Merge upstream Accounted $(git rev-parse --short upstream/main) into $BASE" >/dev/null 2>&1; then
  CONFLICTS=$(git diff --name-only --diff-filter=U)
  git merge --abort
  {
    echo
    echo "### ⚠️ Konflikter, sammanslagningen avbröts"
    echo "$CONFLICTS" | sed 's/^/- `/; s/$/`/'
  } >> "$REPORT"
  echo "conflicts"
  exit 10
fi

# A version that collides with an existing migration would be silently
# skipped by Supabase (history is keyed by version).
DUP=$(ls supabase/migrations | grep -oE '^[0-9]{14}' | sort | uniq -d || true)
if [ -n "$DUP" ]; then
  { echo; echo "### ⚠️ Migreringsversioner som krockar"; echo "$DUP" | sed 's/^/- `/; s/$/`/'; } >> "$REPORT"
  echo "duplicate-migration-versions"
  exit 11
fi

echo "merged $BRANCH"
