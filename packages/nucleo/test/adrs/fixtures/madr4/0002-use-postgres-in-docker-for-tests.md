---
status: "superseded by [ADR-0003](0003-use-sqlite-in-tests.md)"
date: 2026-01-10
decision-makers: dev-sintetico
---
# Use Postgres in Docker for tests

## Context and Problem Statement

Tests need a database.

## Considered Options

* Postgres in Docker
* SQLite in memory

## Decision Outcome

Chosen option: "Postgres in Docker", because it matches production.
