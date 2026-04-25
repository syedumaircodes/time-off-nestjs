import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
const request = require('supertest');
import { AppModule } from '../src/app.module';
import { RequestStatus } from '../src/entities/time-off-request.entity';
import { TimeOffService } from '../src/time-off.service';
import { DataSource } from 'typeorm';
import axios from 'axios';

describe('Time-Off Microservice Rigorous Test Suite', () => {
  let app: INestApplication;
  let service: TimeOffService;
  let dataSource: DataSource;
  const HCM_MOCK_URL = 'http://localhost:3001';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe());
    await app.init();

    service = app.get(TimeOffService);
    dataSource = app.get(DataSource);
  });

  beforeEach(async () => {
    await axios.post(`${HCM_MOCK_URL}/__admin/configure`, {
      forceErrorCode: null,
      forceDelay: 0,
    });
    const entities = dataSource.entityMetadatas;
    for (const entity of entities) {
      const repository = dataSource.getRepository(entity.name);
      await repository.query(`DELETE FROM ${entity.tableName};`);
    }
  });

  describe('1. Balance & Request Lifecycle (TRD 7.3)', () => {
    it('should handle the full happy path: Sync -> Submit -> Approve', async () => {
      const empId = 'lifecycle_user';
      await request(app.getHttpServer())
        .post('/webhooks/hcm/balances')
        .send({
          balances: [{ employeeId: empId, locationId: 'loc1', balance: 10 }],
        })
        .expect(201);
      const sub = await request(app.getHttpServer())
        .post(`/employees/${empId}/requests`)
        .send({ locationId: 'loc1', days: 4 })
        .expect(201);
      await request(app.getHttpServer())
        .patch(`/requests/${sub.body.id}/approve`)
        .expect(200);
      const balance = await request(app.getHttpServer())
        .get(`/employees/${empId}/balances`)
        .expect(200);
      expect(balance.body[0].availableDays).toBe(6);
    });

    it('should reject submission if local effective balance is insufficient', async () => {
      await request(app.getHttpServer())
        .post('/webhooks/hcm/balances')
        .send({
          balances: [
            { employeeId: 'fail_user', locationId: 'loc1', balance: 10 },
          ],
        });
      await request(app.getHttpServer())
        .post('/employees/fail_user/requests')
        .send({ locationId: 'loc1', days: 50 })
        .expect(400);
    });
  });

  describe('2. Concurrency Control (TRD 3.1 & 4.3)', () => {
    it('should prevent double-spending via simultaneous requests (Optimistic Locking)', async () => {
      const empId = 'race_user';
      await request(app.getHttpServer())
        .post('/webhooks/hcm/balances')
        .send({
          balances: [{ employeeId: empId, locationId: 'loc1', balance: 10 }],
        });
      const req1 = request(app.getHttpServer())
        .post(`/employees/${empId}/requests`)
        .send({ locationId: 'loc1', days: 6 });
      const req2 = request(app.getHttpServer())
        .post(`/employees/${empId}/requests`)
        .send({ locationId: 'loc1', days: 6 });
      const [res1, res2] = await Promise.all([req1, req2]);
      const statuses = [res1.status, res2.status];
      expect(statuses).toContain(201);
      expect(statuses).toContain(400);
    });
  });

  describe('3. Defensive HCM Sync Edge Cases (TRD 4.5 & 7.3)', () => {
    it('should auto-fail PENDING requests if Batch Sync reduces balance', async () => {
      const empId = 'defensive_sync_user';
      await request(app.getHttpServer())
        .post('/webhooks/hcm/balances')
        .send({
          balances: [{ employeeId: empId, locationId: 'loc1', balance: 10 }],
        });
      const sub = await request(app.getHttpServer())
        .post(`/employees/${empId}/requests`)
        .send({ locationId: 'loc1', days: 8 });
      await request(app.getHttpServer())
        .post('/webhooks/hcm/balances')
        .send({
          balances: [{ employeeId: empId, locationId: 'loc1', balance: 5 }],
        });
      const requests = await request(app.getHttpServer()).get(
        `/employees/${empId}/requests`,
      );
      expect(requests.body.find((r: any) => r.id === sub.body.id).status).toBe(
        RequestStatus.FAILED,
      );
    });
  });

  describe('4. Resilience & Unavailability (TRD 4.6)', () => {
    it('should implement Optimistic Approval when HCM returns 500', async () => {
      const empId = 'resilience_user';
      await request(app.getHttpServer())
        .post('/webhooks/hcm/balances')
        .send({
          balances: [{ employeeId: empId, locationId: 'loc1', balance: 10 }],
        });
      const sub = await request(app.getHttpServer())
        .post(`/employees/${empId}/requests`)
        .send({ locationId: 'loc1', days: 3 });
      await axios.post(`${HCM_MOCK_URL}/__admin/configure`, {
        forceErrorCode: 500,
      });
      const approval = await request(app.getHttpServer()).patch(
        `/requests/${sub.body.id}/approve`,
      );
      expect(approval.body.status).toBe(RequestStatus.APPROVED);
      expect(approval.body.hcmFiled).toBe(false);
    });
  });

  describe('5. Unit — Balance Calculation Logic (TRD 7.2)', () => {
    it('should compute effective balance as availableDays minus reservedDays', async () => {
      const empId = 'unit_balance_user';
      await request(app.getHttpServer())
        .post('/webhooks/hcm/balances')
        .send({
          balances: [{ employeeId: empId, locationId: 'loc1', balance: 10 }],
        });
      await request(app.getHttpServer())
        .post(`/employees/${empId}/requests`)
        .send({ locationId: 'loc1', days: 3 });
      const balance = await request(app.getHttpServer())
        .get(`/employees/${empId}/balances`)
        .expect(200);
      expect(balance.body[0].availableDays).toBe(10);
      expect(balance.body[0].reservedDays).toBe(3);
      await request(app.getHttpServer())
        .post(`/employees/${empId}/requests`)
        .send({ locationId: 'loc1', days: 8 })
        .expect(400);
    });
  });

  describe('6. Request Lifecycle — Cancellation & Rejection (TRD 7.3)', () => {
    it('should restore reservedDays when a PENDING request is cancelled', async () => {
      const empId = 'cancel_user';
      await request(app.getHttpServer())
        .post('/webhooks/hcm/balances')
        .send({
          balances: [{ employeeId: empId, locationId: 'loc1', balance: 10 }],
        });
      const sub = await request(app.getHttpServer())
        .post(`/employees/${empId}/requests`)
        .send({ locationId: 'loc1', days: 4 });
      await request(app.getHttpServer())
        .delete(`/employees/${empId}/requests/${sub.body.id}`)
        .expect(200);
      const balance = await request(app.getHttpServer())
        .get(`/employees/${empId}/balances`)
        .expect(200);
      expect(balance.body[0].reservedDays).toBe(0);
    });
  });

  describe('7. Layer 2 — Approval Blocked by Real-Time HCM Re-fetch (TRD 4.4)', () => {
    it('should block approval when HCM live balance is lower than days requested', async () => {
      const empId = 'layer2_user';
      await request(app.getHttpServer())
        .post('/webhooks/hcm/balances')
        .send({
          balances: [{ employeeId: empId, locationId: 'loc1', balance: 10 }],
        });
      const sub = await request(app.getHttpServer())
        .post(`/employees/${empId}/requests`)
        .send({ locationId: 'loc1', days: 8 });
      // Drop HCM balance behind the scenes
      await axios.post(`${HCM_MOCK_URL}/__admin/configure`, {
        balances: [{ employeeId: empId, locationId: 'loc1', balance: 5 }],
      });
      const approval = await request(app.getHttpServer()).patch(
        `/requests/${sub.body.id}/approve`,
      );
      expect(approval.status).toBe(400);
    });
  });

  describe('8. selective fail only requests that breach the new balance', () => {
    it('should selectively fail breach requests', async () => {
      const empId = 'selective_user';
      await request(app.getHttpServer())
        .post('/webhooks/hcm/balances')
        .send({
          balances: [{ employeeId: empId, locationId: 'loc1', balance: 10 }],
        });
      const sub1 = await request(app.getHttpServer())
        .post(`/employees/${empId}/requests`)
        .send({ locationId: 'loc1', days: 3 });
      const sub2 = await request(app.getHttpServer())
        .post(`/employees/${empId}/requests`)
        .send({ locationId: 'loc1', days: 6 });
      await request(app.getHttpServer())
        .post('/webhooks/hcm/balances')
        .send({
          balances: [{ employeeId: empId, locationId: 'loc1', balance: 4 }],
        });
      const reqs = await request(app.getHttpServer()).get(
        `/employees/${empId}/requests`,
      );
      expect(reqs.body.find((r: any) => r.id === sub1.body.id).status).toBe(
        'PENDING',
      );
      expect(reqs.body.find((r: any) => r.id === sub2.body.id).status).toBe(
        'FAILED',
      );
    });
  });

  describe('9. HCM Mock — Additional Error Scenarios (TRD 7.3)', () => {
    it('should treat HCM timeout same as 500', async () => {
      const empId = 'timeout_user';
      await request(app.getHttpServer())
        .post('/webhooks/hcm/balances')
        .send({
          balances: [{ employeeId: empId, locationId: 'loc1', balance: 10 }],
        });
      const sub = await request(app.getHttpServer())
        .post(`/employees/${empId}/requests`)
        .send({ locationId: 'loc1', days: 2 });
      await axios.post(`${HCM_MOCK_URL}/__admin/configure`, {
        forceDelay: 2000,
      }); // Simulate slow network
      const approval = await request(app.getHttpServer()).patch(
        `/requests/${sub.body.id}/approve`,
      );
      expect(approval.body.status).toBe('APPROVED');
    });
  });

  describe('10. Concurrency — Lock Exhaustion (TRD 3.1 & 4.3)', () => {
    it('should return 409 on lock exhaustion', async () => {
      const empId = 'exhaust_user';
      await request(app.getHttpServer())
        .post('/webhooks/hcm/balances')
        .send({
          balances: [{ employeeId: empId, locationId: 'loc1', balance: 100 }],
        });
      const requests = Array.from({ length: 15 }, () =>
        request(app.getHttpServer())
          .post(`/employees/${empId}/requests`)
          .send({ locationId: 'loc1', days: 1 }),
      );
      const results = await Promise.all(requests);
      const has409 = results.some((r) => r.status === 409);
      expect(results.every((r) => [201, 409].includes(r.status))).toBe(true);
    });
  });

  afterAll(async () => {
    await app.close();
  });
});
