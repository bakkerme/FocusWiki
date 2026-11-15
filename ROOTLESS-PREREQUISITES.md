# Rootless Docker host prerequisites

The intended deployment account is ubuntu, which already has subordinate user/group IDs and a lingering user session. OpenBot runs as openbot and cannot perform administrator operations on this host.

An administrator can install the missing OS dependencies with:

```sh
sudo apt-get update
sudo apt-get install --yes uidmap rootlesskit slirp4netns
```

These dependencies do not install or start a rootful Docker daemon. The Docker daemon and client still need a per-user rootless installation under ubuntu, followed by a rootless security-mode check. Follow https://docs.docker.com/engine/security/rootless/ and use the packaged /usr/bin/rootlesskit, whose AppArmor user-namespace profile already exists on this host. Do not globally disable AppArmor or its unprivileged user-namespace restrictions. Any additional profile needed for a different binary path must be narrowly configured by an administrator.

Do not claim Docker is installed merely because these prerequisites are installed. Verify the per-user daemon, restart behavior, persistent mounts, and actual application deployment separately.
