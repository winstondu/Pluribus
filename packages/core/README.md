# @pluribus/core

The deterministic core: event log, reducers, projections, context assembly, placement, scheduling and the coordinator. No I/O; every dependency comes in through `src/ports` (`CoreDependencies`). The contracts are `packages/protocol` and `docs/build/PLAN.md`.

| Path | Owner | Contents |
|---|---|---|
| `src/ports/` | architect | The port interfaces (`@pluribus/core/ports`) |
| `test/` | By source area | Test suites, including acceptance and projection rebuild tests |
| `testing/` | By source area | Shared scenarios, port fakes, and routing evaluation helpers. Other packages can use the fakes and evaluation helpers from `@pluribus/core/testing`. |
