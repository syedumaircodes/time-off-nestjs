# Time-Off Microservice — ExampleHR

- **Author:** Syed Umair Ali
- **Assignment:** ExampleHR Take-Home Engineering Challenge
- **Architecture:** Defensive Synchronisation & Distributed Consistency

## Executive Summary

This microservice manages the full lifecycle of employee time-off requests while maintaining balance integrity across two systems: ExampleHR's local database and an external Human Capital Management (HCM) system (e.g. Workday, SAP).

The central challenge is distributed consistency — the HCM is the source of truth, but employees need instant feedback and the system must remain available even when HCM is slow or down. The solution is a **3-Layer Validation Strategy** combined with **Manual Optimistic Locking** and an **Approval-Only Deduction Model**.

## Tech Stack

| Layer       | Technology                                        |
| ----------- | ------------------------------------------------- |
| Framework   | NestJS v11 (Node.js)                              |
| Database    | SQLite + TypeORM                                  |
| Concurrency | Manual Optimistic Locking (Atomic Update Pattern) |
| Resilience  | @nestjs/schedule (Cron recovery)                  |
| Testing     | Jest + Supertest                                  |

## Key Architectural Decisions

### 1. Approval-Only HCM Deduction (TRD Section 4.4)

HCM is never debited at submission — only at approval. A pending request is an intent, not confirmed leave. This avoids needing a refund/reversal API on HCM for every rejection or cancellation, and keeps HCM free of unconfirmed state.

- **Submission:** local Layer 1 pre-check only. `reservedDays` is incremented locally. No HCM call.
- **Approval:** real-time HCM balance re-fetch (Layer 2) → deduction filed to HCM (Layer 3).
- **Rejection / Cancellation:** `reservedDays` restored locally. No HCM call required.

### 2. Reserved Days Pattern — Local Escrow (TRD Section 4.2)

All balance validation runs against `availableDays − reservedDays`, not `availableDays` alone. This prevents an employee from submitting multiple requests that collectively exceed their balance while each is individually awaiting manager approval.

### 3. Manual Optimistic Locking (TRD Section 4.3)

Concurrency is handled via atomic `UPDATE ... WHERE version = :captured` statements. If a concurrent write invalidates the captured version, the operation retries up to 3 times with exponential backoff. On exhaustion it returns `409 Conflict` — deliberately distinct from `400 Bad Request` (validation failure), so callers can distinguish the two failure modes.

### 4. Graceful Degradation (TRD Section 4.6)

Submission is fully decoupled from HCM availability — no HCM call is made at that stage, so employees always get instant feedback regardless of HCM status.

At approval, if the HCM deduction call fails after retries (500 / timeout), the request is saved as `APPROVED` with `hcmFiled = false`. A background cron job retries unfiled deductions every 60 seconds until HCM recovers. A hard `400` from HCM (data error) blocks the approval entirely to prevent data corruption.

### 5. Idempotency & Audit Trail (TRD Section 8)

- Submitting the same request UUID multiple times returns the existing record rather than creating a duplicate.
- Every batch sync event is recorded in a `sync_log` table for a full audit trail.

## Getting Started

### 1. Install Dependencies

```bash
npm install
```

### 2. Start the HCM Mock Server

The microservice requires the mock HCM server to be running to simulate real-time synchronisation and failure scenarios.

```bash
node hcm-mock.js
```

### 3. Start the Microservice

```bash
npm run start
```

The service will be available at `http://localhost:3000`.

## Test Suite

The test suite is structured in four layers as specified in the TRD. Every layer tests a distinct boundary — from pure business logic through to real HTTP calls against the mock HCM server.

| #   | Describe Block                         | Test Name                                                                                                        | TRD Reference |
| --- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------- |
| 1   | Balance & Request Lifecycle            | Full happy path: Sync → Submit → Approve, final balance correct                                                  | 7.3           |
| 2   | Balance & Request Lifecycle            | Submission rejected when effective balance insufficient (Layer 1)                                                | 7.3           |
| 3   | Concurrency Control                    | Simultaneous over-budget requests — one 201, one 400 (Optimistic Locking)                                        | 3.1 & 4.3     |
| 4   | Defensive HCM Sync Edge Cases          | Batch sync reduces balance — pending request auto-failed                                                         | 4.5 & 7.3     |
| 5   | Resilience & Unavailability            | HCM 500 on deduction — optimistic approval, `hcmFiled = false`                                                   | 4.6           |
| 6   | Unit — Balance Calculation Logic       | `availableDays` unchanged, `reservedDays` incremented at submission; second request blocked by effective balance | 7.2           |
| 7   | Cancellation & Rejection               | Cancelling PENDING request restores `reservedDays` to zero                                                       | 7.3           |
| 8   | Layer 2 — Approval Blocked by Re-fetch | Approval returns 400 when HCM live balance is lower than days requested                                          | 4.4           |
| 9   | Selective Fail on Batch Sync           | 3-day request survives balance drop to 4; 6-day request fails                                                    | 7.3           |
| 10  | HCM Mock — Additional Errors           | HCM timeout treated same as 500 — request approved, `hcmFiled` pending                                           | 7.3           |
| 11  | Concurrency — Lock Exhaustion          | 15 simultaneous requests — all responses are 201 or 409, never 500                                               | 3.1 & 4.3     |

### Run the Test Suite

```bash
npm run test:e2e
```

---

## Agentic Development Reflection

This project was built using an agentic workflow:

1. **Design first.** A comprehensive Technical Requirements Document (TRD) was authored before a single line of code was written. The TRD defines system boundaries, data model, API contracts, failure modes, and alternative approaches considered.
2. **AI orchestration.** The TRD was used as the master prompt to generate the NestJS architecture, entity definitions, service logic, and mock HCM server.
3. **Iterative refinement.** Every generated output was reviewed against the TRD for correctness. Key issues caught during review — including a critical contradiction in when the HCM deduction should occur — were resolved at the design level first, then the code was regenerated to match. The test suite was used to verify behaviour, not just to achieve a pass rate.

The agentic approach worked best when the TRD was precise. Vague prompts produced generic code; precise specifications with explicit failure modes produced robust, correct implementations.
