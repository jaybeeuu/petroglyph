# RFC 0004: Notes API and Client Contracts

- **Status:** Accepted
- **Owner:** @jaybeeuu
- **Created:** 2026-03-09
- **Parent RFC:** [0001](0001-notes-platform-architecture.md)
- **Related RFCs:** [0003](0003-pdf-processing-artifact-contracts-and-cli-sync.md), [0005](0005-cli-sync-mechanisms-and-local-materialization.md)

## 1. Summary

Define the API-owned REST contract as a first-class public application boundary for accessing note state, note changes, metadata, and artifacts without exposing provider-specific or raw storage-specific details.

The Notes API serves user needs directly.
CLI, browser, automation, and future consumers are important, but they are consumers of this application-facing API rather than the reason the API exists.

## 2. Decision Scope

This RFC covers:

- API-owned public resource model
- bootstrap snapshot and incremental change-feed semantics
- artifact access patterns
- pagination, filtering, and token/cursor behavior
- authentication and authorization requirements for callers of the API
- token presentation and validation expectations
- relationship between the API contract and underlying storage layout
- the API's role as a first-class public-facing application boundary

This RFC includes authentication as an in-scope concern for the active implementation plan.
The API must be authenticated, and callers must be able to acquire and present tokens to it.

## 2.1 Implementation prerequisites

Before implementing this API, the following decision must be accepted:

- client sync ADR covering snapshot bootstrap, sequence checkpoint usage, monitored-folder filtering, and downstream application of change-feed updates
- application user-domain ADR covering account ownership, identity linkage, and authorization context

Client and API implementations should follow those accepted ADRs rather than inventing their own sync or authorization behavior.
Consumers should import or generate client contracts from the API boundary rather than redefining them in a separate shared package.

## 3. User and Consumer Use Cases

The API may need to support:

- direct user-facing application experiences such as listing notes, browsing note history, and retrieving artifacts
- CLI synchronization and recovery flows
- future browser-based site experiences
- automation or integrations that operate against stable application contracts
- bootstrap local or in-memory state from the current `/notes` view
- resume synchronization from a stored sequence checkpoint
- fetch changed artifacts and metadata
- detect deletions and reflect them in their own local or rendered state
- list notes and note summaries
- fetch note metadata and current version details
- fetch or reference artifacts for rendering or local materialization
- authenticate the acting principal and present valid tokens to the API

## 4. Resource Model

The API should expose resource-oriented endpoints such as:

- `/notes`
- `/notes/changes`
- `/notes/{noteId}`
- `/notes/{noteId}/metadata`
- `/notes/{noteId}/versions`
- `/notes/{noteId}/versions/{versionId}`
- `/notes/{noteId}/versions/{versionId}/artifacts`

The API owns these client-facing resource shapes even if it reads processing-owned publication models internally.
It should enforce these shapes through a mapping layer which strips inappropriate internal properties and converts internal types so internal concerns do not leak to end users.

## 4.1 API Position in the Application

The Notes API is a first-class part of the public-facing application.

It is not only an implementation detail for the CLI or other consumers.
It defines the authenticated application boundary through which user-facing experiences retrieve note state, artifacts, and change information.

Specific consumers such as the CLI, future browser UI, or automation should be treated as consumers of this application boundary.
The API contract should therefore be designed around stable user-facing capabilities and authorization rules rather than the internal convenience of any one consumer.

## 5. Read Models

### 5.1 Snapshot model

The snapshot model provides the latest known current state for bootstrap and recovery.
For V1, this is exposed through the `/notes` collection rather than a separate snapshot-specific endpoint.

Properties:

- complete enough to reconstruct the client-visible current dataset
- paginated for large collections
- versioned independently from storage internals

### 5.2 Change-feed model

The change-feed model provides a sequential stream of note lifecycle changes.
For V1, this is exposed through `/notes/changes` as a collection of change resources.

Properties:

- ordered by a global monotonically increasing `sequence`
- suitable for incremental sync after a known checkpoint
- includes created, updated, and deleted note/version events

The V1 API should expose `sequence` directly as the baseline checkpoint model.
If opaque cursors are introduced later, they should resolve internally to a durable sequence position.

Clients should call `/notes/changes` with the last successfully processed `sequence` value they have stored.
The response should return the next ordered batch of changes with `sequence` values greater than that input.
Responses should be bounded, with a default maximum batch size of 100 changes unless explicitly overridden within safe limits.
Clients can call the endpoint repeatedly until no further changes remain.
This supports simple recovery after failure: the client stores the last fully applied `sequence` atomically and retries from there.

## 6. Authentication and Authorization Expectations

- The API requires authenticated requests for all private note resources.
- Clients must obtain tokens from the configured identity provider and present them to the API.
- Clients must implement an authentication flow appropriate to their runtime environment and persist auth state securely enough for repeat use where applicable.
- Clients must authenticate the acting principal before calling protected API routes.
- The API must validate presented tokens before returning note metadata, change-feed data, or artifact access.
- The API must resolve the validated identity to an application account before authorizing access to protected resources.
- Token validation must include, at minimum, issuer, audience, expiry, and signature checks.
- Authorization rules may begin with a single-user operating model, but they must still rely on explicit application-account state rather than trusted clients or token claims alone.

## 7. Artifact Access Strategy

Clients should not rely on raw S3 paths as their public contract.

The API may:

- stream artifacts directly after authorization, or
- return short-lived signed URLs/references after authorization

The choice can be implementation-specific as long as the client-facing contract remains stable.

## 8. Filtering, Pagination, and Cursors

- `/notes` should support pagination and act as the current-state bootstrap view.
- `/notes/changes` should accept an `afterSequence` parameter representing the last fully processed change `sequence` known to the client.
- `/notes/changes` should return an ordered batch of later changes, with a default maximum of 100 entries per response.
- The response should include enough information for the client to request the next batch safely.
- If a cursor is expired or no longer valid, the API should return a recoverable error instructing the client to re-bootstrap from snapshot.
- Filtering should support client needs such as monitored folders, note IDs, or other safe high-value selectors.

## 9. Error Model

The API should use a consistent error envelope for:

- authentication failures
- authorization failures
- invalid sequence/cursor errors
- missing resources
- transient backend failures

Errors should be machine-readable and safe to log.

## 10. Security Considerations

- The API is the security boundary for client access to private note data.
- Internal storage layout and provider-specific details are not exposed unless intentionally included in safe metadata fields.
- Signed URLs, if used, must be short-lived and audience-limited where possible.
- Clients must not assume possession of a token is enough; server-side validation is authoritative.

## 11. Acceptance Criteria

- A client can bootstrap using the `/notes` collection alone.
- A client can incrementally sync using `/notes/changes` with a stored sequence checkpoint.
- A client can process `/notes/changes` in repeated bounded batches by storing the last successfully applied `sequence` atomically.
- Client note listing and note-detail flows can be completed without direct storage access.
- A client can authenticate and successfully call protected API endpoints.
- Protected API endpoints reject missing, expired, malformed, or invalid tokens.
- Protected API endpoints reject validated identities that are not linked to an allowed application account.
- Clients do not require knowledge of OneDrive, Microsoft Graph, or raw S3 layout.
- Invalid or expired sequence/cursor state produces a clear recovery path.
- The API contract is usable as a public application boundary, not only as a private integration surface for the CLI.
- API resource shapes are defined around stable user-facing capabilities rather than leaked storage or processing models.

## 12. Open Questions

- Which identity provider and client auth flow should be used first?
- Should artifact download default to API streaming or signed URLs?
- What retention window should be guaranteed for change-feed replay before forced snapshot recovery?
