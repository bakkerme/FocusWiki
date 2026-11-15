# Helios Bench Inventory & Power Topology

> **Synthetic Lab Notice:** All devices, RFC 5737 documentation IP addresses (`198.51.100.0/24`), serial identifiers, and power ratings in this repository are purely fictional prototype data. No real hosts, credentials, or lab scan records appear here.

Helios Bench is a self-contained optical calibration and FPGA capture rack located in fictional Bay C-04. Every bench instrument depends on ordered PDU rail energization so network storage mounts cleanly before acquisition boards initialize.

## Fictional Rack Inventory

| Asset ID | Hostname | Documentation IP | Upstream Dependency | Nominal Draw | Operational Role |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `HLX-001` | `hlx-ups-bay` | Serial `ttyUSB0` | Facility Mains | `25 W` | Lithium-iron holdover UPS (`620 Wh`) and sequenced PDU |
| `HLX-002` | `hlx-router-01` | `198.51.100.10` | `hlx-ups-bay` | `45 W` | Isolated bench VLAN gateway and NTP reference |
| `HLX-003` | `hlx-nas-rack` | `198.51.100.24` | `hlx-router-01` | `160 W` | Capture ring-buffer ZFS mirror (`12 TB` synthetic pool) |
| `HLX-004` | `hlx-fpga-rig` | `198.51.100.41` | `hlx-nas-rack` | `310 W` | High-speed frame grabber and timing trigger chassis |
| `HLX-005` | `hlx-optics-bench` | `198.51.100.55` | `hlx-ups-bay` | `220 W` | Tunable calibration laser and piezo stage controller |

## Interactive Rail Power & Dependency Simulator

Toggle individual bench rails below to verify boot-order invariants and estimated battery holdover before starting an optical capture run:

```embed
src: embeds/power-sequencer/index.html
title: Helios Rack Power & Boot Sequencer
height: 300
props: {"bay":"C-04"}
```

## Operational Notes

- Maintain at least twenty minutes of UPS holdover margin whenever unattended overnight interferometry sweeps are active.
- Never energize `hlx-fpga-rig` before `hlx-nas-rack` exports `/mnt/bench-ring`; otherwise capture daemons enter read-only fallback mode.
- For full recovery steps after a simulated mains brownout, follow [Cold-Start Recovery Runbook](docs/cold-start-runbook.md).
