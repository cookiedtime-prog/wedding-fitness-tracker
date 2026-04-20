export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, GOOGLE_SHEET_ID } = process.env;

  // ── Get OAuth2 access token via refresh token ──
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  const tokenData = await tokenRes.json();
  const access_token = tokenData.access_token;
  if (!access_token) {
    console.error('Token error:', tokenData);
    return res.status(500).json({ error: 'Auth failed', detail: tokenData.error_description });
  }

  const base = `https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}`;
  const auth = `Bearer ${access_token}`;
  const HEADERS = ['Date','Profile','Weight','Steps','Water','Breakfast','Lunch','Snack','Dinner','Dessert','Workout','WorkoutType','Supps','UpdatedAt','Extras'];

  // ── Auto-initialize sheet headers if first run ──
  const hRes = await fetch(`${base}/values/Sheet1!A1:O1`, { headers: { Authorization: auth } });
  const hData = await hRes.json();
  if (hData.values?.[0]?.[0] !== 'Date') {
    await fetch(`${base}/values/${encodeURIComponent('Sheet1!A1:O1')}?valueInputOption=RAW`, {
      method: 'PUT',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [HEADERS] })
    });
  }

  // ── GET: return all logs as structured JSON ──
  if (req.method === 'GET') {
    const dataRes = await fetch(`${base}/values/Sheet1!A:O`, { headers: { Authorization: auth } });
    const { values = [] } = await dataRes.json();

    const result = { mayowa: { logs: {} }, vanessa: { logs: {} } };
    values.slice(1).forEach(row => {
      const [date, profile, weight, steps, water, breakfast, lunch, snack, dinner, dessert, workout, workoutType, supps, updatedAt, extrasStr] = row;
      if (!date || !profile) return;
      const p = profile.toLowerCase();
      if (!result[p]) return;
      result[p].logs[date] = {
        weight:      weight      ? parseFloat(weight) : null,
        steps:       steps       ? parseInt(steps)    : null,
        water:       water       ? parseFloat(water)  : null,
        meals: {
          breakfast: breakfast === 'true',
          lunch:     lunch      === 'true',
          snack:     snack      === 'true',
          dinner:    dinner === 'true' ? true : dinner === 'false' ? false : dinner,
          dessert:   dessert    === 'true'
        },
        workout:     workout === 'true' ? true : workout === 'false' ? false : null,
        workoutType: workoutType || '',
        supps:       supps === 'true',
        extras:      extrasStr ? JSON.parse(extrasStr) : []
      };
    });
    return res.status(200).json(result);
  }

  // ── POST: upsert a log entry for a given date + profile ──
  if (req.method === 'POST') {
    const { date, profile, log } = req.body;
    if (!date || !profile || !log) return res.status(400).json({ error: 'Missing date, profile, or log' });

    // Find existing row (if any) so we can update in place
    const existRes = await fetch(`${base}/values/Sheet1!A:B`, { headers: { Authorization: auth } });
    const { values: existing = [] } = await existRes.json();
    let rowIndex = -1;
    existing.forEach((row, i) => {
      if (row[0] === date && row[1]?.toLowerCase() === profile.toLowerCase()) {
        rowIndex = i + 1; // Sheets is 1-indexed
      }
    });

    const rowData = [[
      date,
      profile,
      log.weight  ?? '',
      log.steps   ?? '',
      log.water   ?? '',
      log.meals?.breakfast ? 'true' : 'false',
      log.meals?.lunch     ? 'true' : 'false',
      log.meals?.snack     ? 'true' : 'false',
      log.meals?.dinner === true ? 'true' : log.meals?.dinner ? log.meals.dinner.toString() : 'false',
      log.meals?.dessert   ? 'true' : 'false',
      log.workout === true ? 'true' : log.workout === false ? 'false' : '',
      log.workoutType || '',
      log.supps ? 'true' : 'false',
      new Date().toISOString(),
      JSON.stringify(log.extras || [])
    ]];

    if (rowIndex > 0) {
      // Update existing row
      const range = encodeURIComponent(`Sheet1!A${rowIndex}:O${rowIndex}`);
      const sheetRes = await fetch(`${base}/values/${range}?valueInputOption=RAW`, {
        method: 'PUT',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: rowData })
      });
      if (!sheetRes.ok) {
        const errorText = await sheetRes.text();
        return res.status(500).json({ error: 'Failed to update sheet', detail: errorText });
      }
    } else {
      // Append new row
      const range = encodeURIComponent('Sheet1!A:O');
      const sheetRes = await fetch(`${base}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: rowData })
      });
      if (!sheetRes.ok) {
        const errorText = await sheetRes.text();
        return res.status(500).json({ error: 'Failed to append to sheet', detail: errorText });
      }
    }

    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
