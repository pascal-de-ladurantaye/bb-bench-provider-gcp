// Shell the provider runs on the VM over ssh. Each script runs as
// `bash -c <script> <name> <args...>`: every value reaches it as a positional
// argument, quoted once on this side, never interpolated into the script. The
// scripts stick to bash, coreutils and their BSD equivalents so the tests can
// run them on macOS as well as Linux.

/** Where the provider keeps exec records on the VM, under the remote user's home. */
export const STATE_DIR = ".bb-bench-gcp";

export const EXEC_ID_PATTERN = /^gx_[0-9a-f]{20}$/u;

/** POSIX single-quote a string. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

/** The remote command line for one script: ssh hands it to the remote user's shell. */
export function remoteCommand(script: string, name: string, args: readonly string[]): string {
  return ["bash", "-c", shQuote(script), name, ...args.map(shQuote)].join(" ");
}

const LIB = String.raw`
now_ms() { t=$(date +%s%3N 2>/dev/null); case "$t" in ''|*N*) t=$(( $(date +%s) * 1000 ));; esac; printf '%s' "$t"; }
boot_id() { cat /proc/sys/kernel/random/boot_id 2>/dev/null || printf 'none'; }
abspath() { case "$1" in /*) printf '%s' "$1";; *) printf '%s/%s' "$HOME" "$1";; esac; }
sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum -- "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
size_of() { wc -c < "$1" | tr -d ' '; }
`;

/** Where the startup script records its progress ("running", "ok", "failed: …"). Tests move it. */
const SETUP_DIR = `\${BB_BENCH_GCP_SETUP_DIR:-/var/lib/bb-bench-gcp}`;

/** Package names as apt, dnf and yum take them: space- or comma-separated. */
export function parsePackages(setting: string): string[] {
  const names = setting.split(/[\s,]+/u).filter(Boolean);
  for (const n of names) if (!/^[a-z0-9][a-z0-9+.:-]{0,99}$/u.test(n)) throw new Error(`packages: ${JSON.stringify(n)} is not a package name`);
  return names;
}

/**
 * The VM's startup script (metadata \`startup-script\`, run as root at every
 * boot): install \`packages\` once with the distribution's package manager.
 * bb-autoresearch needs git 2.38 or newer, which cloud images often lack.
 */
export function startupScript(packages: readonly string[]): string {
  return `#!/bin/bash
# Written by the bb-bench-provider-gcp plugin: installs what bench hosts need, once.
m="${SETUP_DIR}"
mkdir -p "$m"
[ "$(cat "$m/setup" 2>/dev/null)" = ok ] && exit 0
echo running > "$m/setup"
chmod 755 "$m"; chmod 644 "$m/setup"
pk=${shQuote(packages.join(" "))}
log="$m/setup.log"
ok=0
for attempt in 1 2 3; do
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get -o DPkg::Lock::Timeout=120 update -q >>"$log" 2>&1 && apt-get -o DPkg::Lock::Timeout=120 install -y -q --no-install-recommends $pk >>"$log" 2>&1 && ok=1
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q $pk >>"$log" 2>&1 && ok=1
  elif command -v yum >/dev/null 2>&1; then
    yum install -y -q $pk >>"$log" 2>&1 && ok=1
  else
    echo "no apt-get, dnf or yum on this image" >>"$log"; break
  fi
  [ "$ok" = 1 ] && break
  sleep "\${BB_BENCH_GCP_RETRY_SECONDS:-10}"
done
if [ "$ok" = 1 ]; then echo ok > "$m/setup"; else printf 'failed: %s\\n' "$(tail -c 600 "$log" | tr '\\n' ' ')" > "$m/setup"; fi
`;
}

/** `probe`: SSH works; prints the boot id, the user's home and the startup script's progress. */
export const PROBE = `${LIB}
echo "ok=1"
echo "setup=$(cat "${SETUP_DIR}/setup" 2>/dev/null || echo none)"
echo "boot=$(boot_id)"
echo "home=$HOME"
`;

/**
 * `put <remotePath> <octalMode|"">`, file on stdin: write it next to the
 * target, apply the mode, rename into place (so a reader never sees half a
 * file), print what landed. Parent directories are created as the remote user.
 */
export const PUT = `set -eu
${LIB}
p=$(abspath "$1")
mkdir -p -- "$(dirname -- "$p")"
tmp="$p.incoming.$$"
trap 'rm -f -- "$tmp"' EXIT
cat > "$tmp"
if [ -n "$2" ]; then chmod "$2" "$tmp"; fi
mv -f -- "$tmp" "$p"
trap - EXIT
echo "bytes=$(size_of "$p")"
echo "sha256=$(sha256_of "$p")"
`;

/**
 * \`get <remotePath> <maxBytes>\`: one header line, then the file.
 *   "missing" | "notfile" | "toobig <size>" | "ok <size> <sha256>" + exactly <size> bytes.
 */
export const GET = `set -eu
${LIB}
p=$(abspath "$1")
if [ ! -e "$p" ]; then echo missing; exit 0; fi
if [ ! -f "$p" ]; then echo notfile; exit 0; fi
n=$(size_of "$p")
if [ "$n" -gt "$2" ]; then echo "toobig $n"; exit 0; fi
echo "ok $n $(sha256_of "$p")"
head -c "$n" -- "$p"
`;

/**
 * The detached wrapper around one exec. It is a session leader of its own
 * (setsid), starts the command in a process group of its own (job control),
 * enforces the timeout with a watchdog, and writes \`exit\` atomically when the
 * command ends. Files in the exec's directory:
 *
 *   pid     the wrapper's pid          boot    boot id when it started
 *   pgid    the command's group        start   start time (ms)
 *   stdout  stderr                     killed  TIMEOUT | CANCELLED
 *   exit    "<code> <SIGNAME|-> <end ms>"
 */
const WRAPPER = `${LIB}
dir=$1; timeout=$2; cwd=$3; nenv=$4; shift 4
echo $$ > "$dir/pid"
boot_id > "$dir/boot"
: > "$dir/stdout"; : > "$dir/stderr"
i=0
while [ "$i" -lt "$nenv" ]; do export "$1"; shift; i=$((i + 1)); done
finish() { printf '%s %s %s\\n' "$1" "$2" "$(now_ms)" > "$dir/exit.tmp"; mv -f "$dir/exit.tmp" "$dir/exit"; }
cd "$HOME" 2>/dev/null || true
if ! cd -- "$cwd" 2>>"$dir/stderr"; then now_ms > "$dir/start"; finish 127 -; exit 0; fi
set -m
"$@" >>"$dir/stdout" 2>>"$dir/stderr" </dev/null &
child=$!
echo "$child" > "$dir/pgid"
now_ms > "$dir/start"
( sleep "$timeout"
  if [ ! -e "$dir/killed" ]; then
    echo TIMEOUT > "$dir/killed"
    kill -TERM -- "-$child" 2>/dev/null
    sleep 5
    kill -KILL -- "-$child" 2>/dev/null
  fi ) </dev/null >/dev/null 2>&1 &
watchdog=$!
wait "$child"; code=$?
kill -KILL -- "-$watchdog" 2>/dev/null || kill -KILL "$watchdog" 2>/dev/null || true
if [ -e "$dir/killed" ]; then kill -KILL -- "-$child" 2>/dev/null; fi
sig=-
if [ "$code" -gt 128 ]; then n=$(kill -l $((code - 128)) 2>/dev/null) && [ -n "$n" ] && sig="SIG\${n#SIG}"; fi
finish "$code" "$sig"
`;

/**
 * `launch <execId> <timeoutSeconds> <cwd> <nEnv> <NAME=value>... <argv...>`:
 * check the cwd, start the wrapper detached (setsid + nohup, so it outlives
 * this ssh session), and return once it has started.
 */
export const LAUNCH = `set -u
${LIB}
WRAPPER=${shQuote(WRAPPER)}
id=$1; cwd=$3
case "$cwd" in /*) ;; *) cwd="$HOME/$cwd";; esac
if [ ! -d "$cwd" ]; then echo "nocwd"; exit 0; fi
root="$HOME/${STATE_DIR}/exec"
dir="$root/$id"
mkdir -p -- "$root"
if ! mkdir -- "$dir" 2>/dev/null; then echo exists; exit 0; fi
shift
if command -v setsid >/dev/null 2>&1; then
  setsid nohup bash -c "$WRAPPER" wrapper "$dir" "$@" </dev/null >/dev/null 2>&1 &
else
  nohup perl -e 'use POSIX qw(setsid); setsid(); exec @ARGV or die' bash -c "$WRAPPER" wrapper "$dir" "$@" </dev/null >/dev/null 2>&1 &
fi
i=0
while [ ! -s "$dir/start" ] && [ "$i" -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
if [ ! -s "$dir/start" ]; then echo "the exec wrapper did not start" >&2; exit 70; fi
echo started
`;

/**
 * `poll <execId> <stdoutOffset> <stderrOffset> <maxBytes>`: key=value lines,
 * a "--" line, then <outLen> bytes of stdout and <errLen> bytes of stderr.
 * Liveness is read first, then the exit record, then the sizes, so a finished
 * command is never mistaken for a lost one and its sizes are final.
 */
export const POLL = `${LIB}
dir="$HOME/${STATE_DIR}/exec/$1"
if [ ! -d "$dir" ]; then echo missing; exit 0; fi
alive=0
pid=$(cat "$dir/pid" 2>/dev/null || true)
if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && [ "$(boot_id)" = "$(cat "$dir/boot" 2>/dev/null || true)" ]; then alive=1; fi
ex=$(cat "$dir/exit" 2>/dev/null || true)
os=$(size_of "$dir/stdout" 2>/dev/null || echo 0)
es=$(size_of "$dir/stderr" 2>/dev/null || echo 0)
no=$(( os > $2 ? os - $2 : 0 )); if [ "$no" -gt "$4" ]; then no=$4; fi
ne=$(( es > $3 ? es - $3 : 0 )); if [ "$ne" -gt "$4" ]; then ne=$4; fi
echo "alive=$alive"
echo "exit=$ex"
echo "killed=$(cat "$dir/killed" 2>/dev/null || true)"
echo "start=$(cat "$dir/start" 2>/dev/null || true)"
echo "now=$(now_ms)"
echo "outSize=$os"
echo "errSize=$es"
echo "outLen=$no"
echo "errLen=$ne"
echo "--"
if [ "$no" -gt 0 ]; then tail -c +$(( $2 + 1 )) "$dir/stdout" | head -c "$no"; fi
if [ "$ne" -gt 0 ]; then tail -c +$(( $3 + 1 )) "$dir/stderr" | head -c "$ne"; fi
exit 0
`;

/** `cancel <execId>`: SIGTERM the command's group, SIGKILL what is left after 5 s, wait for the exit record. */
export const CANCEL = `dir="$HOME/${STATE_DIR}/exec/$1"
if [ ! -d "$dir" ]; then echo missing; exit 0; fi
if [ -e "$dir/exit" ]; then echo done; exit 0; fi
pg=$(cat "$dir/pgid" 2>/dev/null || true)
if [ -z "$pg" ]; then echo done; exit 0; fi
[ -e "$dir/killed" ] || echo CANCELLED > "$dir/killed"
kill -TERM -- "-$pg" 2>/dev/null
i=0; while [ "$i" -lt 50 ] && kill -0 -- "-$pg" 2>/dev/null; do sleep 0.1; i=$((i + 1)); done
kill -KILL -- "-$pg" 2>/dev/null
i=0; while [ "$i" -lt 30 ] && [ ! -e "$dir/exit" ]; do sleep 0.1; i=$((i + 1)); done
echo cancelled
`;

/** Machine facts as key=value lines; cgroup limits for every level from this shell's cgroup up. */
export const INFO = `${LIB}
echo "os=$(uname -s)"
echo "arch=$(uname -m)"
echo "kernel=$(uname -r)"
if [ -r /etc/os-release ]; then echo "distro=$(. /etc/os-release; printf '%s' "\${PRETTY_NAME:-}")"; fi
m=$(grep -m1 '^model name' /proc/cpuinfo 2>/dev/null | sed 's/^[^:]*: *//')
[ -n "$m" ] || m=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || true)
echo "cpuModel=$m"
echo "nproc=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || true)"
echo "threadsPerCore=$(lscpu 2>/dev/null | sed -n 's/^Thread(s) per core: *//p')"
echo "memTotalKb=$(sed -n 's/^MemTotal: *\\([0-9]*\\) kB/\\1/p' /proc/meminfo 2>/dev/null)"
if [ -z "$(sed -n 's/^MemTotal: *\\([0-9]*\\) kB/\\1/p' /proc/meminfo 2>/dev/null)" ]; then echo "memBytes=$(sysctl -n hw.memsize 2>/dev/null || true)"; fi
echo "bootId=$(boot_id)"
echo "user=$(id -un 2>/dev/null || true)"
echo "home=$HOME"
echo "git=$(git --version 2>/dev/null | sed 's/^git version //')"
if [ -r /proc/self/cgroup ]; then
  rel=$(sed -n 's/^0:://p' /proc/self/cgroup)
  d="/sys/fs/cgroup\${rel%/}"
  while [ -n "$rel" ]; do
    [ -r "$d/cpu.max" ] && echo "cgCpuMax=$(cat "$d/cpu.max")"
    [ -r "$d/memory.max" ] && echo "cgMemoryMax=$(cat "$d/memory.max")"
    if [ "$d" = /sys/fs/cgroup ] || [ "$d" = / ]; then break; fi
    d=$(dirname "$d")
  done
fi
true
`;

/** key=value lines → first value per key, and every value per key. */
export function parseKv(text: string): { one: Map<string, string>; all: Map<string, string[]> } {
  const one = new Map<string, string>();
  const all = new Map<string, string[]>();
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (!one.has(key)) one.set(key, value);
    all.set(key, [...(all.get(key) ?? []), value]);
  }
  return { one, all };
}

/** The tightest `cpu.max` ("<quota> <period>"; "max" is no limit) in cores, or null. */
export function cpuQuotaCores(lines: readonly string[]): number | null {
  let best: number | null = null;
  for (const line of lines) {
    const [quota, period] = line.trim().split(/\s+/u);
    const q = Number(quota);
    const p = Number(period);
    if (!Number.isFinite(q) || !Number.isFinite(p) || q <= 0 || p <= 0) continue;
    best = best === null ? q / p : Math.min(best, q / p);
  }
  return best;
}

/** The tightest `memory.max` in bytes, or null ("max" is no limit). */
export function memoryLimitBytes(lines: readonly string[]): number | null {
  let best: number | null = null;
  for (const line of lines) {
    const n = Number(line.trim());
    if (!Number.isFinite(n) || n <= 0 || n >= 2 ** 62) continue;
    best = best === null ? n : Math.min(best, n);
  }
  return best;
}

/**
 * Length of the longest prefix of `buffer` that does not end inside a UTF-8
 * sequence; a chunk cut mid-character leaves the partial bytes for the next poll.
 */
export function utf8SafeLength(buffer: Buffer): number {
  const len = buffer.length;
  let i = len - 1;
  while (i >= 0 && len - i <= 4 && ((buffer[i] ?? 0) & 0xc0) === 0x80) i--;
  if (i < 0 || len - i > 4) return len;
  const lead = buffer[i] ?? 0;
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return len - i < need ? i : len;
}
