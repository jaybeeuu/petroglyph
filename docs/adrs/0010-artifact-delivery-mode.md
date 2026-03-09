# 0010. Artifact Delivery Mode

- **Status:** Accepted
- **Date:** 2026-03-09

## Context

The notes API exposes metadata and change records, but clients also need access to generated artifacts such as markdown, images, PDFs, and metadata files. The platform must choose how artifacts are delivered while keeping S3 hidden from clients and preserving the application as the visible access boundary.

## Decision Drivers

- low operational complexity for V1
- efficient delivery of potentially larger files
- preservation of API authorization as the security boundary
- minimal coupling between client contract and raw storage layout
- compatibility with S3 as the system of record for artifacts

## Considered Options

### Option 1: API streaming for all artifacts

API handlers stream artifacts directly to clients after authorization.

### Option 2: Authorized API returns short-lived signed URLs for artifact retrieval

The API validates the client, then returns short-lived signed URLs for the requested artifacts.

### Option 3: Authorized API returns application-owned artifact URLs that proxy or front the S3-backed artifact store

The API validates the client, then returns short-lived application URLs that remain under the application domain while resolving internally to S3-backed delivery.

### Option 4: Expose stable raw S3 paths directly to clients

Clients use raw S3 paths as part of the public contract.

## Decision Outcome

Chosen option: **Authorized API returns application-owned artifact URLs that proxy or front the S3-backed artifact store**.

This means:

- the notes API remains the authorization boundary
- clients request artifact access through the API
- after authorization, the API may return a short-lived application URL for the artifact
- application-owned artifact URLs are treated as transient delivery tokens, not stable public identifiers
- returned URLs should appear to belong to the application rather than exposing raw S3 hostnames or paths
- the application may satisfy those URLs via proxying, redirecting through an application-controlled edge, or another implementation that keeps S3 hidden from clients
- raw S3 paths remain an internal storage concern rather than a client contract

### V1 operating assumptions

- application-owned artifact URLs should be short-lived
- artifact URLs should grant access only to the intended artifact object
- metadata and change-feed responses may contain artifact references, but clients should resolve actual downloads through authorized API flows

## Consequences

### Positive

- avoids pushing large artifact streaming load through Lambda/API handlers
- preserves S3 as the efficient artifact-serving layer
- keeps authorization centralized at the API boundary
- clients stay decoupled from internal S3 naming as a contractual interface
- keeps S3 hidden from end users and client-visible URLs

### Negative

- clients must handle an extra fetch indirection for artifact download
- artifact URL expiration behavior must be designed and tested carefully
- some artifact access patterns may require re-requesting URLs when they expire
- application-owned delivery URLs may require extra edge or proxy infrastructure compared with exposing raw signed S3 URLs

## Validation

- authorized clients can retrieve artifacts via API-issued application URLs
- unauthorized clients cannot obtain usable artifact access
- application-owned artifact URLs expire and cannot be reused indefinitely
- clients do not require stable raw S3 URLs as part of their core contract
- clients do not see raw S3 hostnames or paths in their normal artifact access flow

## Links

- [RFC 0004](../rfcs/0004-notes-api-and-client-contracts.md)
- [ADR 0003](0003-storage-retention-and-read-model-ownership.md)
- [ADR 0007](0007-auth-boundary-and-first-identity-provider.md)
- [Target Service and Package Architecture](../target-service-and-package-architecture.md)
