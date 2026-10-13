# GCP Compute bench hosts

A [BB](https://bb.dev) plugin (id `bench-provider-gcp`) that lends **Google
Compute Engine VMs** to [bb-autoresearch](https://github.com/pascal-de-ladurantaye/bb-autoresearch)
as remote bench hosts. It implements bb-autoresearch's
[bench provider contract v1](https://github.com/pascal-de-ladurantaye/bb-autoresearch/blob/main/docs/bench-providers.md)
over your own `gcloud` CLI and OpenSSH: it creates and deletes VMs, moves
files, and runs processes. Git, seeding, calibration and scheduling stay in
bb-autoresearch.

```toml
[[oracle.remote_bench]]
provider = "bench-provider-gcp"
hosts = 2
cores = 8                 # vCPUs; see "Machine types"
lifetime_minutes = 120    # capped by the maxLifetimeMinutes setting
machine = { type = "c4d-standard-16", threadsPerCore = 1 }   # optional; see "Production-like nodes"
```

## Setup

1. **Install the tools** on the machine that runs the BB server: the
   [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) and OpenSSH
   (`ssh`, `ssh-keygen`). The plugin finds `gcloud` on the server's PATH, in
   the usual install directories, or through your login shell; set
   `gcloudPath` if it doesn't.
2. **Log in**: `gcloud auth login`. The plugin runs gcloud as you; it never
   reads, stores or forwards a token. To use another account than the active
   one, set `account`.
3. **Pick a project and zone**: set `project` and `zone`, or leave them empty
   to use `gcloud config get-value project` and `compute/zone`. The Compute
   Engine API must be enabled (`gcloud services enable compute.googleapis.com`)
   and your account needs to create VMs there (for example
   `roles/compute.instanceAdmin.v1`).
4. **Let SSH in.** The plugin reaches VMs with the ssh command
   `gcloud compute ssh --dry-run` prints, so whatever `gcloud compute ssh`
   does in your project works:
   - *External IP* (default): port 22 must be open to your machine. A
     project's auto-created `default` network has the `default-allow-ssh`
     rule; on other networks add one, for example
     `gcloud compute firewall-rules create allow-ssh --network=<net> --allow=tcp:22 --source-ranges=<your IP>/32`.
   - *IAP* (`tunnelThroughIap` on, usually with `externalIp` off): allow
     `35.235.240.0/20` to port 22 and grant yourself
     `roles/iap.tunnelResourceAccessor`. VMs without an external IP have no
     internet access unless the network has Cloud NAT; bb-autoresearch doesn't
     need it (it uploads everything), but your `setup` command might.
   - *SSH keys*: the plugin uses gcloud's key, `~/.ssh/google_compute_engine`
     (created like `gcloud compute ssh` does if missing), and puts its public
     half in each VM's `ssh-keys` metadata for the user `sshUser`. When the
     project enforces OS Login, gcloud's dry run imports the key into your OS
     Login profile instead and picks the OS Login user.
5. **Install the plugin**: `bb plugin install https://github.com/pascal-de-ladurantaye/bb-bench-provider-gcp`.
   `bb plugin config bench-provider-gcp set project <id>` (and so on) sets
   options; Settings → Installed plugins shows them all.

## Costs and the self-deleting lifetime

VMs cost money while they exist: roughly $0.10 an hour for an n2-standard-2
and $0.39 for an n2-standard-8 in us-central1, plus the boot disk (spot VMs
are 60–90% cheaper). Check current [pricing](https://cloud.google.com/compute/vm-instance-pricing).

Every VM is created with `--max-run-duration=<lifetime>s` and
`--instance-termination-action=DELETE`: when its lifetime ends, GCP deletes
it (and its boot disk) even if BB is gone. The lifetime is what the study
asks for, capped by `maxLifetimeMinutes` (6 hours by default), so a forgotten
VM costs at most that. bb-autoresearch also destroys VMs it no longer uses,
and on load, pause, archive, unload and every 10 minutes it lists its VMs by
label and destroys orphans. To check by hand:

```sh
gcloud compute instances list --filter="labels.bbbench-managed=true"
```

VMs get **no service account** (`--no-service-account --no-scopes`), so code
on them can't act on your project.

## How each method maps to gcloud

| Method | What it does |
|---|---|
| `describe` | Checks that gcloud and ssh exist, a project and zone are set, an account is logged in, and `gcloud compute zones describe` works (cached for 5 minutes; failures for 30 s). Reports `available: false` with the reason otherwise. Lists the machine options `create` accepts in `machineOptions`. |
| `create` | `gcloud compute instances create <prefix>-<hash of key> --async` with the machine type, image, disk, network, labels, metadata, max run duration and termination action, and the flags of any [machine options](#production-like-nodes) (an unknown option is `[invalid] unknown machine option <key>`). Returns `provisioning` within seconds. The VM name derives from the idempotency key and the machine options, so a repeated key with the same options returns the same VM, even after a lost response or a reinstall ("already exists" is adopted when the VM carries the same key and options); the same key with other options is another VM. |
| `status` | `gcloud compute instances describe`. `PROVISIONING`/`STAGING` → `provisioning`; `RUNNING` → one ssh probe, `ready` once it answers and the startup script has installed `packages` (kept, so later calls are a single describe); `STOPPING`/`TERMINATED`/`SUSPENDED` → `suspended` (or `gone` at the end of the lifetime); `REPAIRING` → `failed`; missing → `gone`, or `failed` with GCP's reason when the create operation failed (`gcloud compute operations describe`), as is a new VM GCP stops before it was ever ready because its create failed (a stockout shows that way). A VM started again since SSH worked is `suspended`: it may be on different hardware. Running without working SSH for `readyTimeoutMinutes` → `failed`. |
| `list` | `gcloud compute instances list --filter="labels.<prefix>-managed=true AND labels.<prefix>_<key>=<value>…"` across all zones of the project, then an exact match on the caller's labels kept verbatim in metadata. Only VMs carrying the provider's label are ever listed. |
| `destroy` | `gcloud compute instances delete`, started detached (a delete takes a minute or two, longer than an RPC may run); `ok: true` at once, and the VM is `gone` from then on. Idempotent. If the VM is still there 3 minutes later, `list` sends the delete again. |
| `info` | One ssh round trip: `uname`, `/etc/os-release`, `/proc/cpuinfo`, `nproc`, `lscpu`, `/proc/meminfo`, cgroup `cpu.max`/`memory.max`, `git --version`; plus, in `extra`, the machine type, CPU platform, minimum CPU platform, threads per core, vCPUs, turbo mode, performance monitoring unit and provisioning model from the VM and `describe`, the machine options it was created with, and `machineNote` when the VM has more vCPUs or less memory than asked for. With no cgroup quota the CPU quota is the VM's vCPUs. |
| `putFile` | The file streams over ssh's stdin into a temporary file next to the target, which is renamed into place; parent directories are created as the remote user, the mode applied, and the VM's sha256 and size must match what was sent. |
| `getFile` | One ssh round trip that sends the size and sha256, then the file; both are checked before the local file is renamed into place. |
| `execStart` | Starts a wrapper with `setsid nohup` over ssh and returns once it runs. The wrapper puts the command (argv, or `bash -lc <script>`) in its own process group with stdout and stderr in files under `~/.bb-bench-gcp/exec/<id>/`, kills the group at `timeoutSeconds` (`signal: "TIMEOUT"`), and writes an exit record. |
| `execPoll` | One ssh round trip returning the state and at most `maxBytes` of each stream from the given byte offsets, never splitting a UTF-8 character. `done` only once the process ended and both offsets reached the end. A process gone without an exit record (or from an earlier boot) is `signal: "LOST"`. |
| `execCancel` | SIGTERM to the process group, SIGKILL after 5 s. |

Execs live on the VM, so they survive plugin reloads and BB restarts. A
reboot inside the VM ends them as `LOST` (their boot id no longer matches); a
VM GCP started again since SSH first worked is reported `suspended`.

**Packages.** Debian's cloud image has no git, and bb-autoresearch needs git
2.38 or newer on the machine. Each VM therefore gets a `startup-script`
(metadata, run as root at boot) that installs the `packages` setting once,
and `status` reports `ready` only after it succeeded (`failed`, with the
package manager's last words, if it didn't). Anything else your study needs
belongs in its `setup` command; the SSH user has passwordless sudo on
Google's images.

**SSH connections.** The provider runs ssh itself with the options and
destination from `gcloud compute ssh --dry-run` (key, known hosts, OS Login
user, IAP `ProxyCommand`), adding `ControlMaster=auto` and
`ControlPersist=300` with sockets in `/tmp/bb-bench-gcp-<uid>/`. The first
call to a VM pays for gcloud and the SSH handshake; polls after that are one
round trip on the shared connection.

**The 75-second RPC limit.** BB times out a plugin RPC after 75 s. Every call
here works within a 55 s budget, and each gcloud or ssh run is killed when it
would exceed what is left (`[transient]`, so bb-autoresearch retries). Long
work never runs inside a call: creates are `--async`, deletes are detached,
and processes are polled. Uploads come from bb-autoresearch in 32 MiB parts.

**Errors.** gcloud's and ssh's failures map to the contract's codes: quota
and stockouts (`ZONE_RESOURCE_POOL_EXHAUSTED`, `Quota '…' exceeded`) are
`[capacity]`; missing logins, expired credentials and missing permissions
are `[auth]`; a missing VM or exec is `[not_found]` (a failed SSH connection
asks GCP whether the VM still exists); rate limits, internal errors and
timeouts are `[transient]`; bad settings (machine type, image, disabled API)
are `[invalid]`.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `project`, `zone` | gcloud's config | Where VMs are created. |
| `account` | gcloud's active account | `--account` for every gcloud call. |
| `machineSeries` | `n2` | Series for `<series>-standard-<n>`. |
| `machineTypes` | none | JSON, core count → machine type, e.g. `{"8": "c3d-standard-8"}`. Wins over the series. |
| `threadsPerCore` | `default` | `1` turns SMT off (`--threads-per-core=1`). The `threadsPerCore` machine option sets it per VM. |
| `imageFamily`, `imageProject` | `debian-12`, `debian-cloud` | Boot image. bb-autoresearch needs bash, tar and git 2.38 or newer; Debian 12's cloud image has no git, so `packages` installs it (2.39). |
| `bootDiskSizeGb`, `bootDiskType` | 20, auto | `pd-balanced`, or `hyperdisk-balanced` for series that boot only from Hyperdisk (n4, c4, …). |
| `network`, `subnet` | default | VPC placement. |
| `externalIp` | on | Off: `--no-address`. |
| `tunnelThroughIap` | off | SSH through IAP. |
| `provisioningModel` | `standard` | `spot`: cheaper; GCP may take the VM back at any time, and it is then deleted (`gone`). |
| `packages` | `git` | Installed by the VM's startup script (apt-get, dnf or yum) before the VM is `ready`; the VM needs internet access for it (an external IP or Cloud NAT). Empty: install nothing, for an image that has what you need. |
| `sshUser`, `sshKeyFile` | `bench`, `~/.ssh/google_compute_engine` | Metadata SSH key user and key. |
| `namePrefix` | `bb-bench` | VM names are `<namePrefix>-<12 hex digits>`. |
| `labelPrefix` | `bbbench` | The provider's labels: `<prefix>-managed=true`, `<prefix>-key`, and each caller label as `<prefix>_<key>`. |
| `extraLabels` | none | `key=value,…` GCP labels put on every VM as they are (an owner or cost-center label, say). |
| `maxHosts` | 4 | Live VMs at once; more is `[capacity]`. |
| `maxCores` | 32 | Largest core count accepted. |
| `maxLifetimeMinutes` | 360 | Lifetime cap. |
| `readyTimeoutMinutes` | 10 | Running without working SSH this long → `failed`. |
| `allowedCaller` | `bb-autoresearch` | The only plugin allowed to call. |
| `gcloudPath` | found | Absolute path of gcloud. |

### Machine types

`cores` are vCPUs. The provider picks, in order: the `machineTypes` entry for
that core count; with `memoryGb`, a custom type `<series>-custom-<vcpus>-<MiB>`
(series n1, n2, n2d, n4, e2; vCPUs rounded up to what the series allows);
otherwise the smallest `<series>-standard-<n>` with at least `cores` vCPUs
(`n2` has 2, 4, 8, 16, 32, …; `c3d` 4, 8, 16, 30, …; `t2d` 1, 2, 4, 8, …).
`info` reports what the VM really has, and bb-autoresearch warns when it
differs from what the study asked for.

On most series a vCPU is a hardware thread, so an n2-standard-8 is 4 physical
cores. For benchmarks, `t2d` (one vCPU per core) or `threadsPerCore = "1"`
avoid sharing cores between threads.

## Production-like nodes

The settings shape every VM the same. To measure on a machine like the one
your code runs on in production, a study can give each
`[[oracle.remote_bench]]` entry its own `machine` options (bench provider
contract v1's `machine` field, bb-autoresearch 1.0 or newer). Each option
overrides the matching setting for that VM only; without `machine`, the
settings decide as before. `describe` lists the options, and `create` refuses
any other key with `[invalid] unknown machine option <key>`.

```toml
# A C4D (AMD Turin) node with SMT off: 16 vCPUs of hardware threads become
# 8 whole cores, all at their all-core turbo, with perf counters.
[[oracle.remote_bench]]
provider = "bench-provider-gcp"
cores = 8
lifetime_minutes = 120
machine = { type = "c4d-standard-16", threadsPerCore = 1, turboMode = "ALL_CORE_MAX", performanceMonitoringUnit = "standard" }

# An Intel Sapphire Rapids node on Ubuntu, in the zone that has the type.
[[oracle.remote_bench]]
provider = "bench-provider-gcp"
cores = 8
lifetime_minutes = 120
machine = { type = "c3-standard-8", zone = "us-central1-b", imageFamily = "ubuntu-2404-lts-amd64", imageProject = "ubuntu-os-cloud", bootDiskGb = 50 }
```

| Option | gcloud flag | Meaning |
|---|---|---|
| `type` | `--machine-type` | Machine type, such as `c4d-standard-16` or `n2-custom-8-16384`. Wins over `machineSeries` and `machineTypes`. |
| `series` | `--machine-type` | A series for this VM: the smallest `<series>-standard-<n>` with at least `cores` vCPUs after `threadsPerCore`. Not with `type`. |
| `threadsPerCore` | `--threads-per-core` | `1` (SMT off: a vCPU is a whole core, and the type has half its usual vCPUs) or `2`. |
| `visibleCoreCount` | `--visible-core-count` | Physical cores the guest sees; its vCPUs are this times the threads per core. |
| `minCpuPlatform` | `--min-cpu-platform` | Oldest CPU platform allowed, such as `"Intel Sapphire Rapids"` or `"AMD Genoa"`; `gcloud compute zones describe <zone> --format="value(availableCpuPlatforms)"` lists a zone's. |
| `turboMode` | `--turbo-mode` | `ALL_CORE_MAX`: every core at its all-core turbo frequency, for steadier timings (c4, c4d and other series that support it). |
| `performanceMonitoringUnit` | `--performance-monitoring-unit` | Hardware performance counters in the guest (for `perf`): `architectural`, `standard` or `enhanced` (c4, c4d, c3, c3d, …). |
| `image` | `--image` | A specific boot image in `imageProject`. Not with `imageFamily`. |
| `imageFamily`, `imageProject` | `--image-family`, `--image-project` | Boot image family and the project that holds it. |
| `bootDiskGb` | `--boot-disk-size` | Boot disk size in GB. |
| `bootDiskType` | `--boot-disk-type` | Such as `pd-ssd` or `hyperdisk-balanced`. Default: `pd-balanced`, or `hyperdisk-balanced` for series that need it. |
| `bootDiskIops`, `bootDiskThroughput` | `--boot-disk-provisioned-iops`, `--boot-disk-provisioned-throughput` | Provisioned IOPS and MB/s of a Hyperdisk (or pd-extreme) boot disk. |
| `spot` | `--provisioning-model` | `true`: a Spot VM; `false`: standard, whatever `provisioningModel` says. |
| `zone` | `--zone` | Zone for this VM, in the provider's project. The host id carries it. |
| `networkTier` | `--network-tier` | `PREMIUM` or `STANDARD`, for the external IP. |

Values may be TOML numbers, booleans or strings (`threadsPerCore = 1` and
`threadsPerCore = "1"` are the same option).

**The vCPU check.** With `type`, `series`, `threadsPerCore` or
`visibleCoreCount`, `create` works out the vCPUs the guest will see (from
`gcloud compute machine-types describe`, cached; a custom type's are in its
name): fewer than `cores` is `[invalid]`, before any VM exists (for example
`c4d-standard-8 with threadsPerCore 1 has 4 vCPUs, fewer than the 8 cores
asked for`); more is allowed and noted in `info`'s `machineNote`, as is less
memory than `memoryGb`. A type the zone doesn't have is `[invalid]` too.

**Idempotency.** The machine options are part of the VM's identity: the name
hashes the idempotency key with the options in canonical form (sorted, typed),
and the VM's metadata keeps them. The same key with the same options returns
the same VM; the same key with other options makes another VM and never
adopts the old one. Without options, names are what they were before.

**What you get.** `info` reports what GCP gave: `extra.machineType`,
`cpuPlatform` (for example `AMD Turin`), `threadsPerCore` (the guest's
`lscpu`), `vcpus`, and the options. bb-autoresearch records it with each
measurement.

### Labels

Caller labels are freer than GCP's (up to 200 characters, any case), so each
is stored twice: as a GCP label `<labelPrefix>_<key>=<value>` lowercased and
rewritten to GCP's rules (a lossy rewrite gets a short hash, so different
values stay different), used to filter `list` on the server; and verbatim in
the instance metadata key `bb-bench-gcp`, which `list` compares exactly and
returns.

## Verified live

Besides the tests, the provider was driven through BB's plugin RPC the way
bb-autoresearch calls it, against real VMs (n2-standard-2, Debian 12, IAP,
no external IP): create in about 2 s, `ready` about 35 s later (about 65 s
with the git install), `info`, a 32 MiB `putFile` and `getFile` in under 3 s
each with matching sha256, 300 KB of output polled in 64 KiB windows, a
timeout (`TIMEOUT`), a cancel of a process group (`SIGTERM`, no survivors), a
reboot (`LOST`), a git bundle fetched and a benchmark run in a worktree, then
`destroy`; polls took about 200 ms, and every VM was gone a minute after its
destroy.

Per-node machine options were checked live the same way: `describe` listed
them, `machine = { type = "c4d-standard-8", threadsPerCore = 1 }` with 8
cores was refused before any VM existed (4 vCPUs), an unknown option was
refused, and with 4 cores (and a `zone` option, after the first zones were
out of C4D capacity, which `status` reported as `failed` with GCP's
`ZONE_RESOURCE_POOL_EXHAUSTED` reason) the VM was `ready` 40 s after its
create; `info` reported `c4d-standard-8`, CPU platform `AMD Turin`
(`AMD EPYC 9B45`), 1 thread per core and 4 vCPUs. Every VM was deleted.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test        # unit tests + the contract against a fake gcloud and ssh
bb plugin build
```

The tests drive the plugin through BB's fake plugin host. `test/fake/` holds a
fake `gcloud` (instances, operations, machine types, `compute ssh --dry-run`) and a fake
`ssh` that runs remote commands with bash in a per-VM directory, so every
remote script runs for real. `src/contract.ts` is a copy of bb-autoresearch's
`src/bench-provider/contract.ts`; a test checks its fingerprint.

## License

MIT
