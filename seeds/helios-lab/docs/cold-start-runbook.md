# Cold-Start Recovery Runbook

> **Synthetic Lab Notice:** Fictional operational checklist for the synthetic *Helios Bench* prototype repository.

Use this runbook after planned PDU maintenance or simulated mains loss in Bay C-04.

## Sequenced Bring-Up Steps

1. Confirm `hlx-ups-bay` front panel reports `ONLINE` and pack charge above `60%`.
2. Energize Rail 1 (`hlx-router-01` at `198.51.100.10`) and wait until local NTP stratum locks.
3. Energize Rail 2 (`hlx-nas-rack` at `198.51.100.24`) and verify `/mnt/bench-ring` export health.
4. Energize Rail 3 (`hlx-fpga-rig`) and Rail 4 (`hlx-optics-bench`) only when an operator is present.

## Post-Boot Verification Checklist

- [x] Verify VLAN isolation (no external gateway route present)
- [x] Confirm ZFS scrub schedule is paused during active frame capture
- [ ] Record synthetic baseline thermal reading after 15 minutes
