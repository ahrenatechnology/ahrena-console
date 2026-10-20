# 3. Use event streaming

Date: 2025-09-03

## Status

Accepted

Supersedes [2. Use a message queue between services](0002-use-a-message-queue.md)

## Context

The queue cannot replay events for new consumers.

## Decision

We will use an event log with retention of 30 days.

## Consequences

Consumers keep their own offsets.
