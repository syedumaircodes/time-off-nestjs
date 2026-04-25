import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
// Using require for supertest to avoid "not callable" TS errors
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
    // 1. Reset HCM Mock
    try {
      await axios.post(`${HCM_MOCK_URL}/__admin/configure`, {
        forceErrorCode: null,
      });
    } catch (e) {
      console.warn(
        'HCM Mock not reachable. Ensure node hcm-mock.js is running.',
      );
    }

    // 2. CLEAR DATABASE (Isolates every test)
    const entities = dataSource.entityMetadatas;
    for (const entity of entities) {
      const repository = dataSource.getRepository(entity.name);
      await repository.query(`DELETE FROM ${entity.tableName};`);
    }
  });

  describe('1. Balance & Request Lifecycle (TRD 7.3)', () => {
    const empId = 'lifecycle_user';
    const locId = 'loc1';

    it('should handle the full happy path: Sync -> Submit -> Approve', async () => {
      // Sync
      await request(app.getHttpServer())
        .post('/webhooks/hcm/balances')
        .send({
          balances: [{ employeeId: empId, locationId: locId, balance: 10 }],
        })
        .expect(201);

      // Submit
      const sub = await request(app.getHttpServer())
        .post(`/employees/${empId}/requests`)
        .send({ locationId: locId, days: 4 });

      if (sub.status !== 201) console.error(sub.body);
      expect(sub.status).toBe(201);
      const requestId = sub.body.id;

      // Approve
      await request(app.getHttpServer())
        .patch(`/requests/${requestId}/approve`)
        .expect(200);

      // Verify Final Balance (10 - 4 = 6)
      const balance = await request(app.getHttpServer())
        .get(`/employees/${empId}/balances`)
        .expect(200);

      expect(balance.body[0].availableDays).toBe(6);
      expect(balance.body[0].reservedDays).toBe(0);
    }); // <-- Fixed missing closing brace

    it('should reject submission if local effective balance is insufficient (Layer 1)', async () => {
      // Setup 10 days
      await request(app.getHttpServer())
        .post('/webhooks/hcm/balances')
        .send({
          balances: [{ employeeId: empId, locationId: locId, balance: 10 }],
        });

      await request(app.getHttpServer())
        .post(`/employees/${empId}/requests`)
        .send({ locationId: locId, days: 50 })
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
      // One succeeds (201), one fails (400) because balance drops to 4
      expect(statuses).toContain(201);
      expect(statuses).toContain(400);
    });
  });

  describe('3. Defensive HCM Sync Edge Cases (TRD 4.5 & 7.3)', () => {
    it('should auto-fail PENDING requests if Batch Sync reduces balance below reserved amount', async () => {
      const empId = 'defensive_sync_user';
      await request(app.getHttpServer())
        .post('/webhooks/hcm/balances')
        .send({
          balances: [{ employeeId: empId, locationId: 'loc1', balance: 10 }],
        });

      const sub = await request(app.getHttpServer())
        .post(`/employees/${empId}/requests`)
        .send({ locationId: 'loc1', days: 8 });

      // Sync drops to 5. Since 8 > 5, request must fail.
      await request(app.getHttpServer())
        .post('/webhooks/hcm/balances')
        .send({
          balances: [{ employeeId: empId, locationId: 'loc1', balance: 5 }],
        });

      const requests = await request(app.getHttpServer()).get(
        `/employees/${empId}/requests`,
      );
      const target = requests.body.find((r: any) => r.id === sub.body.id);
      expect(target.status).toBe(RequestStatus.FAILED);

      const balance = await request(app.getHttpServer()).get(
        `/employees/${empId}/balances`,
      );
      expect(balance.body[0].reservedDays).toBe(0);
    });

    it('should maintain idempotency for identical batch payloads', async () => {
      const payload = {
        balances: [
          { employeeId: 'idem_user', locationId: 'loc1', balance: 20 },
        ],
      };

      await request(app.getHttpServer())
        .post('/webhooks/hcm/balances')
        .send(payload);
      const b1 = await request(app.getHttpServer()).get(
        '/employees/idem_user/balances',
      );

      await request(app.getHttpServer())
        .post('/webhooks/hcm/balances')
        .send(payload);
      const b2 = await request(app.getHttpServer()).get(
        '/employees/idem_user/balances',
      );

      expect(b1.body[0].version).toBe(b2.body[0].version);
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

      // Recovery
      await axios.post(`${HCM_MOCK_URL}/__admin/configure`, {
        forceErrorCode: null,
      });
      await service.retryUnfiledDeductions();

      const final = await request(app.getHttpServer()).get(
        `/employees/${empId}/requests`,
      );
      expect(final.body.find((r: any) => r.id === sub.body.id).hcmFiled).toBe(
        true,
      );
    });

    it('should block approval if HCM returns 400 (Data/User Error)', async () => {
      const empId = 'error_400_user';
      await request(app.getHttpServer())
        .post('/webhooks/hcm/balances')
        .send({
          balances: [{ employeeId: empId, locationId: 'loc1', balance: 10 }],
        });

      const sub = await request(app.getHttpServer())
        .post(`/employees/${empId}/requests`)
        .send({ locationId: 'loc1', days: 2 });

      await axios.post(`${HCM_MOCK_URL}/__admin/configure`, {
        forceErrorCode: 400,
      });

      await request(app.getHttpServer())
        .patch(`/requests/${sub.body.id}/approve`)
        .expect(502);

      const req = await request(app.getHttpServer()).get(
        `/employees/${empId}/requests`,
      );
      expect(req.body[0].status).toBe(RequestStatus.PENDING);
    });
  });

  afterAll(async () => {
    await app.close();
  });
});
