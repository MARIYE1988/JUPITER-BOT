require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

async function run() {
  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    console.log('Running migration:', file);
    await pool.query(sql);
  }

  console.log('Migrations complete.');
  await pool.end();
}

run().catch(async (e) => {
  console.error('Migration failed:', e);
  await pool.end();
  process.exit(1);
});
