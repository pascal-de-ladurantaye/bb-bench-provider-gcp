#!/usr/bin/env node
// A fake `ssh` for the tests: `user@<name>.fakevm <command>` runs the command
// with bash in the fake VM's home ($FAKE_GCP_STATE/vms/<name>/home), stdin
// and stdout passed through, like a remote login shell would. Refuses with
// exit 255 while the VM isn't running or its SSH isn't up yet.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const STATE = process.env.FAKE_GCP_STATE;
const argv = process.argv.slice(2);
const WITH_VALUE = new Set("-o -i -p -l -F -E -c -m -b -L -R -D -J -S -O -W -e -Q -w -B -I".split(" "));

let i = 0;
let control = null;
const options = [];
while (i < argv.length && argv[i].startsWith("-")) {
  const a = argv[i];
  if (WITH_VALUE.has(a)) {
    if (a === "-O") control = argv[i + 1];
    options.push(a, argv[i + 1]);
    i += 2;
  } else {
    options.push(a);
    i += 1;
  }
}
const destination = argv[i] ?? "";
const remote = argv.slice(i + 1).join(" ");
appendFileSync(join(STATE, "calls.jsonl"), `${JSON.stringify({ tool: "ssh", options, destination, control, script: remote.slice(0, 200), t: Date.now() })}\n`);

const config = (() => {
  try {
    return JSON.parse(readFileSync(join(STATE, "config.json"), "utf8"));
  } catch {
    return {};
  }
})();

if (control) process.exit(0);
const m = /^([^@]+)@([a-z0-9-]+)\.fakevm$/u.exec(destination);
if (!m) {
  process.stderr.write(`ssh: Could not resolve hostname ${destination}: nodename nor servname provided\n`);
  process.exit(255);
}
const name = m[2];
let vm = null;
try {
  vm = JSON.parse(readFileSync(join(STATE, "vms", `${name}.json`), "utf8"));
} catch {
  vm = null;
}
const now = Date.now();
if (!vm || now < vm._runningAt || now < vm._sshAt || (vm._expiresAt && now >= vm._expiresAt)) {
  process.stderr.write(`ssh: connect to host ${name}.fakevm port 22: Connection refused\n`);
  process.exit(255);
}
if (config.sshDenied) {
  process.stderr.write(`${m[1]}@${name}.fakevm: Permission denied (publickey).\n`);
  process.exit(255);
}
if (config.sshSleepMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, config.sshSleepMs);

const home = join(STATE, "vms", name, "home");
const child = spawn("bash", ["-c", remote], {
  cwd: home,
  env: { HOME: home, PATH: process.env.PATH, LANG: "C.UTF-8", USER: m[1], BB_BENCH_GCP_SETUP_DIR: join(STATE, "vms", name, "setup") },
  stdio: "inherit",
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
