# 2. Use a message queue between services

Date: 2025-05-12

## Status

Superseded by [3. Use event streaming](0003-use-event-streaming.md)

## Context

Services call each other synchronously and time out under load.

## Decision

We will put a message queue between the order and billing services.

## Consequences

Billing becomes eventually consistent.
