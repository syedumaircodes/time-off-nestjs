const express = require('express');
const app = express();
app.use(express.json());

// In-memory "Source of Truth"
let hcmBalances = {
  emp123_loc1: { balance: 15 },
  emp456_loc1: { balance: 5 },
};

let config = { forceErrorCode: null, delay: 0 };

const getKey = (id, loc) => `${id}_${loc}`;

app.get('/balances/:empId/:locId', (req, res) => {
  if (config.forceErrorCode)
    return res.status(config.forceErrorCode).json({ error: 'HCM Error' });

  const key = `${req.params.empId}_${req.params.locId}`;
  // If we have a seeded balance, use it. Otherwise, default to 10 for tests.
  const data = hcmBalances[key] || { balance: 10 };

  const timeout = config.forceDelay || config.delay || 0;
  setTimeout(() => res.json(data), timeout);
});

app.post('/time-off', (req, res) => {
  // TRD 7.3: Handle simulated HCM errors
  if (config.forceErrorCode) {
    return res
      .status(config.forceErrorCode)
      .json({ error: 'HCM System Error' });
  }

  const { employeeId, locationId, days } = req.body;
  const key = getKey(employeeId, locationId);

  // Auto-initialize balance if not present (defensive for tests)
  if (!hcmBalances[key]) {
    hcmBalances[key] = { balance: 10 };
  }

  if (hcmBalances[key].balance < days) {
    return res.status(400).json({ error: 'Insufficient HCM balance' });
  }

  hcmBalances[key].balance -= days;
  console.log(
    `[HCM] Deducted ${days} from ${key}. New Balance: ${hcmBalances[key].balance}`,
  );

  res.json({ success: true, newBalance: hcmBalances[key].balance });
});

// Admin endpoint for your test suite to manipulate HCM behavior
app.post('/__admin/configure', (req, res) => {
  // Allow tests to seed balances directly in the mock
  if (req.body.balances) {
    req.body.balances.forEach((b) => {
      hcmBalances[getKey(b.employeeId, b.locationId)] = { balance: b.balance };
    });
  }

  config = {
    forceErrorCode:
      req.body.forceErrorCode !== undefined ? req.body.forceErrorCode : null,
    delay: req.body.delay || 0,
  };

  console.log(`[HCM Mock] Reconfigured:`, config);
  res.json({ message: 'Mock configured', config, hcmBalances });
});

app.listen(3001, () => console.log('HCM Mock Server running on port 3001'));
