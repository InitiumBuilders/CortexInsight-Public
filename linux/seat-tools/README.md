# Seat tools

Instruments the August seat built for itself on the server, kept here so a
rebuilt machine does not lose them. The relay does not need any of them to run.

- `gate.sh` runs a gates file: each gate is a command that exits zero or it
  does not count. `gates.seekdepth` is the one written for SEEKDEPTH.
- `soul-bundle.sh` prints the whole prompt stack a seat receives, verbatim,
  so what the seat reads can be checked rather than assumed.
- `motus.sh` answers "is anything running on this box, and what is it
  costing?" and restarts the relay only when nothing is mid-turn.
- `SEEKDEPTH.md` explains the fourth gear, which answers on OpenRouter.

They were written for a server whose fleet tree is `/root/cortex`; change
`ROOT` at the top of each if yours lives elsewhere.
