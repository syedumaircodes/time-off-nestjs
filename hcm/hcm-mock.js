const express = require('express');
const app = express();
app.use(express.json());

// In-memory "Source of Truth"
let hcmBalances = {
  emp123_loc1: { balance: 15 },
  emp456_loc1: { balance: 5 },
};

let config = { forceError: false, delay: 0 };

app.get('/balances/:empId/:locId', (req, res) => {
  const key = `${req.params.empId}_${req.params.locId}`;
  const data = hcmBalances[key] || { balance: 0 };
  setTimeout(() => res.json(data), config.delay);
});

app.post('/time-off', (req, res) => {
  if (config.forceError)
    return res.status(500).json({ error: 'HCM System Down' });

  const { employeeId, locationId, days } = req.body;
  const key = `${employeeId}_${locationId}`;

  if (!hcmBalances[key] || hcmBalances[key].balance < days) {
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
  config = { ...config, ...req.body };
  res.json({ message: 'Mock configured', config });
});

app.listen(3001, () => console.log('HCM Mock Server running on port 3001'));
