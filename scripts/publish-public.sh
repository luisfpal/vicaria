#!/usr/bin/env bash
# Builds the public branch from the tracked files of a ref, with no history of the source branch.
#   First run:  the branch "public" is created as an orphan, one commit.
#   Later runs: one new commit on top of "public" (its tree is the new release), so the public history is only
#               the sequence of published releases and never contains anything from the working history.
# The tree is scanned for secrets and private strings first; on any finding the script stops and changes nothing.
# It never pushes: it prints the push command.
#
# usage: scripts/publish-public.sh [-m "message"] [ref]        (ref defaults to HEAD)
# env:   GITLEAKS=/path/to/gitleaks   PUBLIC_BRANCH=public   REMOTE_URL=https://github.com/<owner>/<repo>.git
set -euo pipefail

BRANCH=${PUBLIC_BRANCH:-public}
MSG=""
[ "${1:-}" = "-m" ] && { MSG=$2; shift 2; }
REF=${1:-HEAD}
cd "$(git rev-parse --show-toplevel)"

die() { echo "REFUSED: $*" >&2; exit 1; }

GL=${GITLEAKS:-$(command -v gitleaks || true)}
[ -n "$GL" ] && [ -x "$GL" ] || die "gitleaks not found. Download a release binary from https://github.com/gitleaks/gitleaks/releases, check its checksum, and set GITLEAKS=/path/to/gitleaks"

[ -z "$(git status --porcelain --untracked-files=no)" ] || die "tracked files have uncommitted changes; commit them first"
git rev-parse --verify -q "$REF^{commit}" >/dev/null || die "unknown ref $REF"
NAME=$(git config user.name || true); MAIL=$(git config user.email || true)
[ -n "$NAME" ] && [ -n "$MAIL" ] || die "set git user.name and user.email (use a noreply address)"
case "$MAIL" in *@users.noreply.github.com) ;; *) die "git user.email is $MAIL; use your GitHub noreply address on public commits" ;; esac

WORK=$(mktemp -d); trap 'rm -r "$WORK"' EXIT
mkdir "$WORK/tree"
git archive "$REF" | tar -x -C "$WORK/tree"   # tracked files only: ignored files can never get in

# 1. Files that must never be public, by name.
BAD=$(cd "$WORK/tree" && find . -type f \( -path './.meta/*' -o -name 'CLAUDE.local.md' -o -name 'AGENTS.local.md' \
  -o -name '.env' -o -name '.env.*' -o -name '*.jks' -o -name '*.keystore' -o -name '*.p12' -o -name '*.pem' \
  -o -name '*.key' -o -name '*.mobileprovision' -o -name 'key.properties' -o -name '.aider*' -o -name '.DS_Store' \) \
  ! -name '.env.example' | head -20)
[ -z "$BAD" ] || die "private files in the tree:
$BAD"

# 2. Private strings. The patterns are split so this file does not match itself; .gitignore names the folders on purpose.
H='/Users/'; P1="${H}l11"; P2='ssh l'"11"; P3='tail''scale'; P4='ORF''EO'; P5='Documents/api''_keys'; P6='release''keys'; P7='dev''keys'
P8='gmail''\.com'; P9='\.ts''\.net'; P10='Grok B''ot'; P11='ds-''aider'; P12='/work''space/'; P13='PLAN_1''\.0'; P14='HAND''OFF'
HITS=$(cd "$WORK/tree" && grep -rInE "$P1|$P2|$P3|$P4|$P5|$P6|$P7|$P8|$P9|$P10|$P11|$P12|$P13|$P14|[Cc]o-[Aa]uthored-[Bb]y" . \
  --exclude='.gitignore' --exclude-dir=node_modules --exclude='package-lock.json' --exclude='p2p.js' | cut -c1-160 | head -20 || true)
[ -z "$HITS" ] || die "private strings in the tree:
$HITS"

# 3. Secret scan of the tree.
"$GL" dir "$WORK/tree" --redact --no-banner --exit-code 1 >"$WORK/gl.txt" 2>&1 || { cat "$WORK/gl.txt" >&2; die "gitleaks found secrets in the tree"; }

# 4. Commit the tree on top of the previous public tip (or as a root commit), without touching the working tree or index.
export GIT_INDEX_FILE="$WORK/index"
git --work-tree="$WORK/tree" add -A
TREE=$(git write-tree)
unset GIT_INDEX_FILE
PARENT=$(git rev-parse -q --verify "refs/heads/$BRANCH" || true)
[ -n "$MSG" ] || MSG="Vicaria $(git show "$REF:app/package.json" | sed -n 's/.*"version": "\(.*\)".*/\1/p' | head -1)"
if [ -n "$PARENT" ] && [ "$(git rev-parse "$PARENT^{tree}")" = "$TREE" ]; then die "nothing new: $BRANCH already holds this tree"; fi
COMMIT=$(GIT_AUTHOR_NAME=$NAME GIT_AUTHOR_EMAIL=$MAIL GIT_COMMITTER_NAME=$NAME GIT_COMMITTER_EMAIL=$MAIL \
  git commit-tree "$TREE" ${PARENT:+-p "$PARENT"} -m "$MSG")

# 5. Scan the new history as git will publish it, then move the branch. A failure leaves the old branch in place.
if [ -n "$PARENT" ]; then RANGE="$PARENT..$COMMIT"; else RANGE="$COMMIT"; fi
"$GL" git . --log-opts="$RANGE" --redact --no-banner --exit-code 1 >"$WORK/gl2.txt" 2>&1 || { cat "$WORK/gl2.txt" >&2; die "gitleaks found secrets in the new commit; $BRANCH not changed"; }
OTHER=$(git log --format='%an <%ae>%n%cn <%ce>' "$RANGE" | sort -u | grep -v 'users.noreply.github.com' || true)
[ -z "$OTHER" ] || die "commit identities that are not noreply addresses: $OTHER"
git update-ref "refs/heads/$BRANCH" "$COMMIT" ${PARENT:+"$PARENT"}

N=$(git rev-list --count "$BRANCH")
echo "ok: $BRANCH is $(git rev-parse --short "$BRANCH") ($N commit$([ "$N" = 1 ] || echo s), $(git ls-tree -r --name-only "$BRANCH" | wc -l | tr -d ' ') files); secret scan clean"
echo
URL=${REMOTE_URL:-https://github.com/<owner>/<repo>.git}
if [ -z "$PARENT" ]; then
  echo "Not pushed. First publication, into an EMPTY repository:"
  echo "  git push $URL $BRANCH:main"
  echo "Into a repository that already has other history (replaces it; check first with: git ls-remote $URL):"
  echo "  git push --force-with-lease $URL $BRANCH:main"
else
  echo "Not pushed. A later release (a fast-forward of the published branch):"
  echo "  git push $URL $BRANCH:main"
fi
