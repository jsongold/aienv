#!/usr/bin/env zsh
# aienv test suite. Plain zsh, no framework, no network, no real agent CLI.
# Everything happens under a temp HOME / AIENV_HOME with fake agent binaries.

emulate -L zsh
setopt no_unset pipe_fail
unset ZDOTDIR

ROOT=${0:A:h:h}
typeset -g PASSN=0 FAILN=0

# The suite trims PATH below; pin node for install.sh and the launcher it writes.
export AIENV_NODE=${AIENV_NODE:-$(command -v node)}

ok()  { print -r -- "PASS $1"; (( PASSN++ )); return 0 }
ng()  { print -r -- "FAIL $1 -- ${2-}"; (( FAILN++ )); return 0 }
chk() { if (( $2 )); then ok "$1"; else ng "$1" "${3-}"; fi }
aeq() { if [[ "$2" == "$3" ]]; then ok "$1"; else ng "$1" "want=[$2] got=[$3]"; fi }
has() { if [[ "$2" == *"$3"* ]]; then ok "$1"; else ng "$1" "missing [$3] in [$2]"; fi }
hasnt() { if [[ "$2" != *"$3"* ]]; then ok "$1"; else ng "$1" "unexpected [$3]"; fi }
rx() { if [[ "$2" =~ $3 ]]; then ok "$1"; else ng "$1" "no match for /$3/ in [$2]"; fi }
stores() { local -a s=( "$AIENV_HOME"/.store/*(N/) ); print -r -- ${#s} }
# shimcfg <dir> [app]: the store the shim hands the agent in dir ('unset' when unbound)
shimcfg() {
  local o; o=$( cd "$1"; ${2:-claude} probe 2>/dev/null )
  o=${${(f)o}[1]}
  print -r -- ${o#*=}
}
# idof <app> <org> <email>: the store id of that account ('' when absent)
idof() {
  local d
  for d in "$AIENV_HOME"/.store/*(N/); do
    [[ -f $d/.aienv-meta && $(< "$d/.aienv-meta") == "app=$1"$'\n'"org=$2"$'\n'"email=$3" ]] || continue
    print -r -- ${d:t}; return 0
  done
  return 1
}

TMPROOT=$(mktemp -d /tmp/aienv-tests.XXXXXX)
TMPROOT=${TMPROOT:A}
trap 'rm -rf -- "$TMPROOT"' EXIT INT TERM

export HOME="$TMPROOT/home dir"
export AIENV_HOME="$HOME/.aienv"
FAKEBIN="$TMPROOT/fake bin"
mkdir -p -- "$HOME/.claude/rules" "$FAKEBIN"
print -r -- 'shared memory file' > "$HOME/.claude/CLAUDE.md"
print -r -- '{}' > "$HOME/.claude/keybindings.json"
print -r -- 'x' > "$HOME/.claude/.credentials.json"

cat > "$FAKEBIN/claude" <<'FAKE'
#!/bin/zsh -f
emulate -L zsh
if [[ ${1-} == auth ]]; then
  case ${2-} in
    login)
      [[ -n ${CLAUDE_CONFIG_DIR-} ]] || exit 1
      [[ ${FAKE_LOGIN_FAIL-0} == 1 ]] && exit 3
      mkdir -p -- "$CLAUDE_CONFIG_DIR"
      print -r -- 'fake session marker' > "$CLAUDE_CONFIG_DIR/fake-session"
      [[ -n ${FAKE_LOGIN_SLEEP-} ]] && sleep "$FAKE_LOGIN_SLEEP"
      exit 0 ;;
    logout) exit 0 ;;
    status)
      printf '{"loggedIn":true,"email":"%s","orgName":"%s","orgId":"o1","subscriptionType":"max","authMethod":"claudeai","configDirectory":"%s"}\n' \
        "${FAKE_EMAIL:-user@example.com}" "${FAKE_ORG:-Acme Org}" "${CLAUDE_CONFIG_DIR-}"
      exit 0 ;;
  esac
fi
if [[ ${1-} == envdump ]]; then
  env | grep -E '^(CLAUDE|ANTHROPIC|OPENAI|CODEX|XDG_DATA_HOME|AIENV)' | sort
  exit 0
fi
if [[ ${1-} == nest ]]; then
  cd -- "$2" || exit 1
  shift 2
  claude "$@"
  exit $?
fi
print -r -- "CFG=${CLAUDE_CONFIG_DIR-unset}"
print -r -- "AKEY=${ANTHROPIC_API_KEY-unset}"
print -r -- "ATOK=${ANTHROPIC_AUTH_TOKEN-unset}"
print -r -- "OAUTH=${CLAUDE_CODE_OAUTH_TOKEN-unset}"
for a in "$@"; do print -r -- "ARG=$a"; done
for a in "$@"; do [[ $a == exitcode=* ]] && exit ${a#exitcode=}; done
exit 0
FAKE

cat > "$FAKEBIN/codex" <<'FAKE'
#!/bin/zsh -f
emulate -L zsh
if [[ ${1-} == login && ${2-} == status ]]; then
  print -r -- 'Logged in using ChatGPT'; exit 0
fi
if [[ ${1-} == login ]]; then
  [[ -n ${CODEX_HOME-} ]] || exit 1
  mkdir -p -- "$CODEX_HOME"; exit 0
fi
if [[ ${1-} == logout ]]; then exit 0; fi
if [[ ${1-} == app-server && -n ${FAKE_CODEX_EMAIL-} ]]; then
  while read -r line; do
    if [[ $line == *'"account/read"'* ]]; then
      print -r -- "{\"id\":2,\"result\":{\"account\":{\"type\":\"chatgpt\",\"email\":\"$FAKE_CODEX_EMAIL\",\"planType\":\"plus\"},\"requiresOpenaiAuth\":false}}"
    fi
  done
  exit 0
fi
print -r -- "CODEX_HOME=${CODEX_HOME-unset}"
print -r -- "OKEY=${OPENAI_API_KEY-unset}"
print -r -- "OTOK=${CODEX_ACCESS_TOKEN-unset}"
for a in "$@"; do print -r -- "ARG=$a"; done
exit 0
FAKE

cat > "$FAKEBIN/opencode" <<'FAKE'
#!/bin/zsh -f
emulate -L zsh
if [[ ${1-} == auth ]]; then
  case ${2-} in
    login)
      [[ -n ${XDG_DATA_HOME-} ]] || exit 1
      mkdir -p -- "$XDG_DATA_HOME/opencode"; exit 0 ;;
    logout|list) exit 0 ;;
  esac
fi
print -r -- "XDG=${XDG_DATA_HOME-unset}"
print -r -- "OC_AKEY=${ANTHROPIC_API_KEY-unset}"
print -r -- "OC_OKEY=${OPENAI_API_KEY-unset}"
for a in "$@"; do print -r -- "ARG=$a"; done
exit 0
FAKE

chmod 0755 "$FAKEBIN/claude" "$FAKEBIN/codex" "$FAKEBIN/opencode"

zsh "$ROOT/install.sh" >/dev/null || { print -r -- 'FAIL install'; print -r -- 'RESULT: FAIL'; exit 1 }
zsh "$ROOT/install.sh" >/dev/null || { print -r -- 'FAIL install-idempotent'; print -r -- 'RESULT: FAIL'; exit 1 }

export PATH="$AIENV_HOME/bin:$FAKEBIN:/usr/bin:/bin:/usr/sbin:/sbin"
AIENV="$AIENV_HOME/bin/aienv"

chk install-shims "$([[ -x $AIENV && -x $AIENV_HOME/bin/claude && -x $AIENV_HOME/bin/codex && -x $AIENV_HOME/bin/opencode ]] && print 1 || print 0)"

# --- add ----------------------------------------------------------------------

FAKE_ORG='Acme Org' FAKE_EMAIL='a@example.com' "$AIENV" add claude >/dev/null 2>&1
FAKE_ORG='Acme Org' FAKE_EMAIL='b@example.com' "$AIENV" add claude >/dev/null 2>&1
FAKE_ORG='Acme Org' FAKE_EMAIL='a@x.com'       "$AIENV" add claude >/dev/null 2>&1
FAKE_ORG='Acme Org' FAKE_EMAIL='aa@x.com'      "$AIENV" add claude >/dev/null 2>&1
print -r -- 'c@example.com'  | "$AIENV" add codex    >/dev/null 2>&1
print -r -- 'oc@example.com' | "$AIENV" add opencode >/dev/null 2>&1

ID_A=$(idof claude 'Acme Org' a@example.com)
ID_B=$(idof claude 'Acme Org' b@example.com)
ID_C=$(idof codex - c@example.com)
ID_O=$(idof opencode - oc@example.com)
ID_AX=$(idof claude 'Acme Org' a@x.com)
ID_AAX=$(idof claude 'Acme Org' aa@x.com)
chk add-stores-created "$([[ -n $ID_A && -n $ID_B && -n $ID_C && -n $ID_O && -n $ID_AX && -n $ID_AAX ]] && print 1 || print 0)"
ST_A="$AIENV_HOME/.store/$ID_A"
ST_B="$AIENV_HOME/.store/$ID_B"
ST_C="$AIENV_HOME/.store/$ID_C"
ST_O="$AIENV_HOME/.store/$ID_O"

META_A=$(< "$ST_A/.aienv-meta")
has add-meta "$META_A" 'email=a@example.com'
has add-meta-org "$META_A" 'org=Acme Org'
chk add-claude-shared-link "$([[ -L $ST_A/CLAUDE.md && -L $ST_A/rules && -L $ST_A/keybindings.json ]] && print 1 || print 0)"
PRJ_A="$ST_A/projects"
aeq add-claude-shares-projects "${HOME:A}/.claude/projects" "$([[ -L $PRJ_A ]] && print -r -- "${PRJ_A:A}")"
chk add-no-credential-copy "$([[ ! -e $ST_A/.claude.json && ! -e $ST_A/.credentials.json ]] && print 1 || print 0)"

out=$("$AIENV" add cursor-agent 2>&1); rc=$?
chk add-cursor-agent-unsupported "$(( rc != 0 ))" "rc=$rc"
has add-cursor-agent-message "$out" 'unsupported'

n0=$(stores)
FAKE_ORG='Acme Org' FAKE_EMAIL='a@example.com' "$AIENV" add claude >/dev/null 2>&1; rc=$?
chk add-duplicate-rejected "$(( rc != 0 ))" "rc=$rc"
aeq add-duplicate-store-cleaned "$n0" "$(stores)"

FAKE_LOGIN_FAIL=1 FAKE_EMAIL='fail@example.com' "$AIENV" add claude >/dev/null 2>&1; rc=$?
chk add-login-failure-exit "$(( rc != 0 ))" "rc=$rc"
aeq add-login-failure-cleaned "$n0" "$(stores)"

FAKE_LOGIN_SLEEP=1 FAKE_ORG='Int Org' FAKE_EMAIL='int@example.com' "$AIENV" add claude >/dev/null 2>&1 &
apid=$!
sleep 0.3
kill -INT $apid 2>/dev/null || true
wait $apid 2>/dev/null || true
aeq add-interrupted-cleaned "$n0" "$(stores)"

# --- match precedence ---------------------------------------------------------

W1="$TMPROOT/plain dir"
mkdir -p -- "$W1"
( cd "$W1"; "$AIENV" switch claude 'a@x.com' >/dev/null ); rc=$?
got=$(shimcfg "$W1")
chk match-exact-email-beats-substring "$([[ $rc == 0 && $got == $AIENV_HOME/.store/$ID_AX ]] && print 1 || print 0)" "rc=$rc got=$got"
( cd "$W1"; "$AIENV" switch claude "$ID_AAX" >/dev/null )
got=$(shimcfg "$W1")
aeq match-by-id "$AIENV_HOME/.store/$ID_AAX" "$got"
( cd "$W1"; "$AIENV" switch claude 'Acme Org/a@example.com' >/dev/null )
got=$(shimcfg "$W1")
aeq match-exact-org-email "$ST_A" "$got"
( cd "$W1"; "$AIENV" switch claude --none >/dev/null )

# --- shim with no bindings ----------------------------------------------------

out=$( cd "$W1"; ANTHROPIC_API_KEY=sk-unbound claude hello )
has shim-unbound-passthrough-cfg "$out" 'CFG=unset'
has shim-unbound-keeps-api-key "$out" 'AKEY=sk-unbound'

a=$( cd "$W1"; ANTHROPIC_API_KEY=sk-u claude envdump )
b=$( cd "$W1"; ANTHROPIC_API_KEY=sk-u "$FAKEBIN/claude" envdump )
aeq shim-unbound-env-identical "$b" "$a"
hasnt shim-no-marker-leak "$a" 'AIENV_SHIM_ACTIVE'

# --- switch -------------------------------------------------------------------

WORK="$TMPROOT/work"
mkdir -p -- "$WORK/proj a/sub"
( cd "$WORK";        "$AIENV" switch claude 'a@example.com' >/dev/null )
( cd "$WORK/proj a"; "$AIENV" switch claude 'b@example.com' >/dev/null )

got=$(shimcfg "$WORK/proj a/sub")
aeq resolve-nearest-ancestor "$ST_B" "$got"
got=$(shimcfg "$WORK")
aeq resolve-own-dir "$ST_A" "$got"

( cd "$WORK"; "$AIENV" switch claude 'b@example.com' >/dev/null )
got=$(shimcfg "$WORK")
n=$(grep -c -F -- "$WORK	" "$AIENV_HOME/bindings" || true)
chk switch-replaces-line "$([[ $got == $ST_B && $n == 1 ]] && print 1 || print 0)" "got=$got lines=$n"
( cd "$WORK"; "$AIENV" switch claude 'a@example.com' >/dev/null )

out=$( cd "$WORK"; "$AIENV" switch claude 'example.com' 2>&1 ); rc=$?
chk switch-ambiguous-match-fails "$(( rc != 0 ))" "rc=$rc"
has switch-ambiguous-lists-candidates "$out" 'a@example.com'
out=$( cd "$WORK"; "$AIENV" switch claude 'nobody@nowhere' 2>&1 ); rc=$?
chk switch-no-match-fails "$(( rc != 0 ))" "rc=$rc"

mkdir -p -- "$TMPROOT/sym target"
ln -s "$TMPROOT/sym target" "$TMPROOT/sym link"
( cd "$TMPROOT/sym link"; "$AIENV" switch claude 'b@example.com' >/dev/null )
got=$(shimcfg "$TMPROOT/sym target")
aeq switch-symlink-dir-stored-physical "$ST_B" "$got"
got=$(shimcfg "$TMPROOT/sym link")
aeq shim-through-symlink-dir-store "$ST_B" "$got"
out=$( cd "$TMPROOT/sym link"; claude go )
has shim-through-symlink-dir "$out" "CFG=$ST_B"

# --- shim when bound ----------------------------------------------------------

out=$( cd "$WORK"; ANTHROPIC_API_KEY=sk-x ANTHROPIC_AUTH_TOKEN=tok-y CLAUDE_CODE_OAUTH_TOKEN=oa-z claude run )
has shim-bound-sets-config-dir "$out" "CFG=$ST_A"
has shim-bound-unsets-api-key "$out" 'AKEY=unset'
has shim-bound-unsets-auth-token "$out" 'ATOK=unset'
has shim-bound-unsets-oauth-token "$out" 'OAUTH=unset'

( cd "$WORK"; "$AIENV" switch codex 'c@example.com' >/dev/null )
out=$( cd "$WORK"; OPENAI_API_KEY=o CODEX_ACCESS_TOKEN=t codex run )
has shim-codex-sets-home "$out" "CODEX_HOME=$ST_C"
has shim-codex-unsets-keys "$out" 'OKEY=unset'

( cd "$WORK"; "$AIENV" switch opencode 'oc@example.com' >/dev/null )
out=$( cd "$WORK"; ANTHROPIC_API_KEY=a OPENAI_API_KEY=o opencode run )
has shim-opencode-sets-xdg "$out" "XDG=$ST_O"
has shim-opencode-unsets-anthropic "$out" 'OC_AKEY=unset'
has shim-opencode-unsets-openai "$out" 'OC_OKEY=unset'

out=$( cd "$WORK"; claude 'one two' three 'exitcode=7' ); rc=$?
chk shim-preserves-exit-code "$(( rc == 7 ))" "rc=$rc"
has shim-preserves-spaced-arg "$out" $'ARG=one two\n'
n=$(print -r -- "$out" | grep -c '^ARG=' || true)
aeq shim-arg-count 3 "$n"

# --- nested agent calls -------------------------------------------------------

out=$( cd "$WORK"; claude nest "$WORK/proj a" inner )
has nested-child-dir-account "$out" "CFG=$ST_B"
out=$( cd "$W1"; ANTHROPIC_API_KEY=sk-parent claude nest "$WORK" inner )
has nested-unbound-parent-binds-child "$out" "CFG=$ST_A"
has nested-unbound-parent-unsets-key "$out" 'AKEY=unset'

# --- recursion guard ----------------------------------------------------------

out=$( export PATH="$AIENV_HOME/bin:$AIENV_HOME/bin:$PATH"; cd "$WORK"; claude ping )
has shim-no-recursion-duplicate-path "$out" 'ARG=ping'
ln -s "$AIENV_HOME/bin" "$TMPROOT/binlink"
out=$( export PATH="$TMPROOT/binlink:$PATH"; cd "$WORK"; claude ping )
has shim-no-recursion-symlinked-path "$out" 'ARG=ping'
out=$( cd "$AIENV_HOME"; export PATH="bin:$FAKEBIN:/usr/bin:/bin"; claude ping )
has shim-no-recursion-relative-path "$out" 'ARG=ping'
out=$( export PATH="$AIENV_HOME/bin/:$PATH"; cd "$WORK"; claude ping )
has shim-no-recursion-trailing-slash "$out" "CFG=$ST_A"

# --- malformed bindings file --------------------------------------------------

BSAVE=$(< "$AIENV_HOME/bindings")
printf 'claude\t%s\t%s' "$W1" "$ID_B" > "$AIENV_HOME/bindings"
got=$(shimcfg "$W1")
aeq bindings-no-final-newline "$ST_B" "$got"

printf 'claude\t%s\t%s\r\n\n\t\t\nbogusline\n' "$W1" "$ID_B" > "$AIENV_HOME/bindings"
got=$(shimcfg "$W1")
aeq bindings-crlf-and-junk "$ST_B" "$got"

printf 'claude\t%s\t%s\nclaude\t%s\t%s\n' "$W1" "$ID_A" "$W1" "$ID_B" > "$AIENV_HOME/bindings"
got=$(shimcfg "$W1")
aeq bindings-duplicate-first-wins "$ST_A" "$got"

printf 'claude\t/\t%s\n' "$ID_A" > "$AIENV_HOME/bindings"
got=$(shimcfg "$WORK/proj a/sub")
aeq bindings-root-matches-everything "$ST_A" "$got"

printf 'claude\t%s\tdeadbeef00\n' "$W1" > "$AIENV_HOME/bindings"
out=$( cd "$W1"; claude ping 2>&1 ); rc=$?
chk shim-dangling-fails-closed "$(( rc == 1 ))" "rc=$rc"
has shim-dangling-message "$out" 'points at missing account deadbeef00'
out=$( cd "$W1"; "$AIENV" show --no-status 2>&1 )
has show-marks-dangling "$out" 'DANGLING deadbeef00'

printf 'claude\t%s\t%s\ncodex\t%s\t%s' "$WORK" "$ID_A" "$WORK" "$ID_C" > "$AIENV_HOME/bindings"
( cd "$W1"; "$AIENV" switch claude 'b@example.com' >/dev/null )
got=$(shimcfg "$WORK" codex)
aeq bindings-rewrite-keeps-unterminated-line "$ST_C" "$got"
print -r -- "$BSAVE" > "$AIENV_HOME/bindings"

# --- global fallback ----------------------------------------------------------

( cd "$W1"; "$AIENV" switch claude 'b@example.com' --global >/dev/null )
got=$(shimcfg "$W1")
aeq resolve-global-fallback "$ST_B" "$got"
got=$(shimcfg "$WORK")
aeq resolve-dir-beats-global "$ST_A" "$got"
out=$( cd "$W1"; claude hello )
has shim-global-fallback "$out" "CFG=$ST_B"

# --- AIENV_HOME unset, custom install location --------------------------------

ALT="$TMPROOT/alt home"
AIENV_HOME="$ALT" zsh "$ROOT/install.sh" >/dev/null
AIENV_HOME="$ALT" FAKE_ORG='Alt Org' FAKE_EMAIL='z@example.com' "$ALT/bin/aienv" add claude >/dev/null 2>&1
ID_Z=$(AIENV_HOME="$ALT" idof claude 'Alt Org' z@example.com)
( cd "$W1"; AIENV_HOME="$ALT" "$ALT/bin/aienv" switch claude 'z@example.com' >/dev/null )
out=$( cd "$W1"; unset AIENV_HOME; "$ALT/bin/aienv" help )
has althome-aienv-derives-home "$out" "home: $ALT"
out=$( cd "$W1"; unset AIENV_HOME; export PATH="$ALT/bin:$FAKEBIN:/usr/bin:/bin"; claude go )
has althome-shim-derives-home "$out" "CFG=$ALT/.store/$ID_Z"

# --- show ---------------------------------------------------------------------

FAKE_ORG="p@example.com's Organization" FAKE_EMAIL='p@example.com' "$AIENV" add claude >/dev/null 2>&1
ID_P=$(idof claude "p@example.com's Organization" p@example.com)
out=$( cd "$WORK"; "$AIENV" show --no-status 2>&1 ); rc=$?
chk show-runs "$(( rc == 0 ))" "rc=$rc"
has show-marks-active "$out" "* Acme Org"
rx show-prints-email-and-id "$out" "Acme Org +a@example.com +\\($ID_A\\)"
hasnt show-no-status-prints-nothing "$out" "($ID_A) "
hasnt show-hides-email-in-label "$out" "Acme Org/a@example.com"
rx show-personal-org-shows-domain "$out" "example.com +p@example.com +\\($ID_P\\)"
hasnt show-hides-personal-org "$out" "'s Organization"
rx show-no-org-shows-domain "$out" "example.com +c@example.com +\\($ID_C\\)"
has show-binding-source "$out" "dir: $WORK"
out=$( cd "$WORK"; ANTHROPIC_API_KEY=sk-secret-value CLAUDE_CODE_OAUTH_TOKEN=oauth-secret "$AIENV" show --no-status 2>&1 )
has show-warns-api-key "$out" 'ANTHROPIC_API_KEY is set'
has show-warns-oauth-token "$out" 'CLAUDE_CODE_OAUTH_TOKEN is set'
hasnt show-hides-api-key-value "$out" 'sk-secret-value'

# --- remove -------------------------------------------------------------------

print -r -- 'y' | "$AIENV" remove codex 'c@example.com' >/dev/null 2>&1
chk remove-store-gone "$([[ ! -e $ST_C ]] && print 1 || print 0)"
n=$(grep -c -F -- "$ID_C" "$AIENV_HOME/bindings" || true)
aeq remove-bindings-gone 0 "$n"

print -r -- 'n' | "$AIENV" remove claude 'a@example.com' >/dev/null 2>&1
chk remove-declined-keeps-store "$([[ -d $ST_A ]] && print 1 || print 0)"

print -r -- 'y' | "$AIENV" remove claude 'a@example.com' >/dev/null 2>&1
n=$(grep -c -F -- "$ID_A" "$AIENV_HOME/bindings" || true)
chk remove-all-bindings-for-id "$([[ ! -d $ST_A && $n == 0 ]] && print 1 || print 0)" "lines=$n"
chk remove-keeps-other-store "$([[ -d $ST_B ]] && print 1 || print 0)"

# --- misc ---------------------------------------------------------------------

"$AIENV" bogus >/dev/null 2>&1; rc=$?
chk unknown-command-exit2 "$(( rc == 2 ))" "rc=$rc"
# --- codex identity via app-server ---------------------------------------------

FAKE_CODEX_EMAIL='auto@example.com' "$AIENV" add codex </dev/null >/dev/null 2>&1
chk codex-add-detects-email "$([[ -n $(idof codex - auto@example.com) ]] && print 1 || print 0)"
print -r -- '' | "$AIENV" add codex >/dev/null 2>&1
ID_U=$(idof codex - unknown)
chk codex-add-blank-is-unknown "$([[ -n $ID_U ]] && print 1 || print 0)"
out=$(FAKE_CODEX_EMAIL='other@example.com' "$AIENV" show 2>&1)
has codex-show-mismatch "$out" 'logged-in MISMATCH'
has codex-show-unknown-row "$out" "(${ID_U})"
hasnt codex-show-hides-logged-in "$out" "(${ID_U}) "

print -r -- ""
print -r -- "passed: $PASSN  failed: $FAILN"
if (( FAILN > 0 )); then
  print -r -- 'RESULT: FAIL'
  exit 1
fi
print -r -- 'RESULT: PASS'
