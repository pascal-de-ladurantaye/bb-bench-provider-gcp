## What you get

- **Cloud bench hosts for bb-autoresearch.** A study's `[[oracle.remote_bench]]` entry with `provider = "bench-provider-gcp"` measures on fresh Google Compute Engine VMs instead of your laptop: a quiet machine of the shape you ask for, with its own calibration.
- **Your own gcloud login.** VMs are created in your project with `gcloud compute instances create`, reached with the ssh command `gcloud compute ssh` would use (metadata keys or OS Login, external IP or IAP), and deleted with `gcloud compute instances delete`. No token is stored or copied anywhere; the VMs get no service account.
- **VMs that clean up after themselves.** Every VM is created with a maximum run duration and `--instance-termination-action=DELETE`, so one you forget deletes itself when its lifetime ends. bb-autoresearch destroys the VMs it no longer needs and sweeps orphans by label.
- **Production-like nodes.** Each `[[oracle.remote_bench]]` entry can pick its own machine with `machine = { ... }`: machine type, SMT off (`threadsPerCore = 1`), visible cores, minimum CPU platform, all-core turbo, performance counters, image, boot disk, spot and zone. The provider checks the type's vCPUs against the cores asked for before creating anything, and `info` reports the machine type, CPU platform, threads per core and vCPUs the VM really has.
- **Cheap polling.** One shared SSH connection per VM, so a progress poll is one round trip. Processes run detached on the VM and survive plugin reloads.

## How it works

1. Log in with `gcloud auth login`, pick a project and zone (settings, or gcloud's own config), and make sure port 22 reaches your VMs (or turn on IAP).
2. Add an `[[oracle.remote_bench]]` entry with `provider = "bench-provider-gcp"`, the core count of your production machine and a lifetime.
3. bb-autoresearch asks for VMs; each is created asynchronously, reported ready once SSH answers, seeded, calibrated and used for measurements, then destroyed.

Each VM installs git (bb-autoresearch needs 2.38 or newer) or the `packages` you list before it is reported ready. Core counts map to `<series>-standard-<n>` (series `n2` by default; `c3d`, `c4`, `t2d` and others work) or to your own core-count-to-machine-type table; asking for memory picks a custom machine type. Spot VMs, custom images, networks, IAP and SMT off are settings.

## Requirements

- BB 0.45 or newer and bb-autoresearch 1.0 or newer (contract v1 with machine options; 0.3.x refuses the machineOptions this provider lists in describe).
- The Google Cloud SDK (`gcloud`) and OpenSSH on the BB server's machine, logged in to an account that can create VMs in the project (roles/compute.instanceAdmin.v1, plus roles/iap.tunnelResourceAccessor for IAP).
- VMs cost money while they run: an n2-standard-8 is about $0.39 an hour in us-central1. The lifetime cap (6 hours by default) bounds what a forgotten VM can cost.
- Early release (0.2).
