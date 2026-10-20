---
status: accepted
date: 2026-03-02
decision-makers: dev-sintetico, colega-a
consulted: colega-b
informed: time
---
# Use SQLite in memory for tests

## Context and Problem Statement

The test suite starts a Postgres container and takes four minutes. Which database should the tests use?

## Decision Drivers

* Test time under one minute
* Same SQL dialect as production for the queries we use

## Considered Options

* SQLite in memory
* Postgres in Docker
* Mocked repository layer

## Decision Outcome

Chosen option: "SQLite in memory", because it is the only option under one minute.

### Consequences

* Good, because the suite runs in 40 s.
* Bad, because JSON operators differ and need a shim.

### Confirmation

The CI job fails if the suite takes more than 60 s.

## More Information

Supersedes [Use Postgres in Docker for tests](0002-use-postgres-in-docker-for-tests.md).
