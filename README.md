# 🚀 Time-Off Microservice (ExampleHR)

- **Author:** Syed Umair Ali
- **Assignment:** ReadyOn Take-Home Engineering Challenge
- **Architecture:** Defensive Synchronization & Distributed Consistency

## 🌟 Executive Summary

This microservice manages employee time-off requests by synchronizing a local state with an external Human Capital Management (HCM) system. Designed for high reliability and consistency, it solves the "Source of Truth" problem using a **3-Layer Validation Strategy** and **Atomic Concurrency Control**.

## 🛠️ The Tech Stack

- **Framework:** NestJS v11 (Node.js)
- **Database:** SQLite + TypeORM
- **Concurrency:** Manual Optimistic Locking (Atomic Update Pattern)
- **Resilience:** @nestjs/schedule (Cron recovery)
- **Testing:** Jest + Supertest

---

## 🏗️ Architectural Key Decisions (Aligned with TRD)

### 1. Defensive "Reserved Days" Pattern (TRD Section 4.2)

To ensure immediate feedback for employees without risking over-deduction, we implement a "Local Escrow" system.

- **Reserved Days:** When a request is PENDING, days are moved to a `reservedDays` column.
- **Effective Balance:** Validation is always performed against `availableDays - reservedDays`.
- This prevents a user from submitting multiple requests that exceed their balance while waiting for manager approval.

### 2. Concurrency Control (TRD Section 4.3)

We utilize **Manual Optimistic Locking**. By performing atomic updates (`UPDATE ... WHERE version = x`), the system remains non-blocking but guarantees that two simultaneous requests cannot both deduct the same balance. The service includes a retry loop with exponential backoff to handle high-contention scenarios.

### 3. Graceful Degradation & Resilience (TRD Section 4.6)

We favor **System Availability**.

- If the HCM is down during approval (500 error), the system "optimistically" approves the request locally but marks it as `hcmFiled = false`.
- A background **Cron Job** retries these unfiled deductions every minute until the HCM returns to life, ensuring eventual consistency.
- If the HCM returns a **400 (Data Error)**, the system blocks the approval to prevent data corruption.

### 4. Idempotency & Audit Trail (TRD Section 8.0)

- **Submission Idempotency:** Submitting the same Request UUID multiple times returns the existing record rather than creating duplicates.
- **Sync Logs:** Every batch sync event is recorded in a `sync_log` table for audit purposes.

---

## 🚀 Getting Started

### 1. Install Dependencies

```bash
npm install
```

````

### 2. Start the HCM Mock Server (Critical)

The microservice requires the mock HCM to be running to simulate real-time synchronization.

```bash
node hcm-mock.js
```

### 3. Start the Microservice

```bash
npm run start
```

The service will be available at `http://localhost:3000`.

---

## 🧪 Rigorous Testing Suite

The value of this implementation lies in the test suite, which rigorously simulates distributed systems failures.

**Total Tests: 7/7 Passing**

| Test Case          | TRD Reference | Description                                                   |
| :----------------- | :------------ | :------------------------------------------------------------ |
| **Happy Path**     | Section 7.3   | Sync -> Submit -> Approve flow.                               |
| **Concurrency**    | Section 3.1   | Fires simultaneous requests to prove no double-spending.      |
| **Defensive Sync** | Section 4.5   | Auto-fails PENDING requests if a Batch Sync reduces balance.  |
| **Resilience**     | Section 4.6   | Verifies background recovery when HCM is offline.             |
| **Idempotency**    | Section 8.0   | Proves identical batch payloads don't cause duplicate writes. |

**Run E2E Tests:**

```bash
npm run test:e2e
```

**Generate Coverage Report:**

```bash
npm run test:cov
```

---

## 🤖 Agentic Development Reflection

This project was developed using an **Agentic Workflow**.

1. **Design First:** A comprehensive TRD was authored to define the system boundaries and failure modes.
2. **AI Orchestration:** The TRD was used as the master prompt to generate the microservice architecture.
3. **Iterative Refinement:** Every line of code was reviewed for SQLite-specific limitations (like concurrent write transactions) and refined until the 7/7 "Rigorous Test Suite" reached a 100% pass rate.

---

_End of Document — Developed for Syed Umair Ali's Engineering Application._

```

### 💡 Final Pro-Tip for Syed:
When you zip the file, if you have a folder for your **Postman Collection**, include it in the root! It's an extra touch that shows you really care about the people who will be testing your work.

**You are ready. Go win that role!** 🚀🔥
```
````
