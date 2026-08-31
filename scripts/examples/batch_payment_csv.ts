/**
 * scripts/examples/batch_payment_csv.ts
 *
 * Demonstrates a `batch_payment` task sourced from a CSV file — a real-world
 * bulk-payment use case (payroll runs, airdrops, vendor payouts, etc.).
 *
 * CSV format (header row required):
 *   destination,amount,assetCode
 *   GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5,1.5000000,XLM
 *   GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN,10.0000000,USDC
 *
 * `assetCode` is optional per row and defaults to XLM.
 *
 * Usage:
 *   npx ts-node scripts/examples/batch_payment_csv.ts <path-to-csv>
 *   npx ts-node scripts/examples/batch_payment_csv.ts scripts/examples/sample_payments.csv
 *
 * Required .env vars:
 *   AGENT_SECRET_KEY, HORIZON_URL, SOROBAN_RPC_URL, X402_ASSET_ISSUER
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { PayFiAgent } from '../../backend/agent';

interface CsvPayment {
  destination: string;
  amount: string;
  assetCode: string;
}

const REQUIRED_COLUMNS = ['destination', 'amount', 'assetCode'];

async function parseCsv(path: string): Promise<CsvPayment[]> {
  const rl = createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  });

  const payments: CsvPayment[] = [];
  let header: string[] | null = null;
  let lineNumber = 0;

  for await (const rawLine of rl) {
    lineNumber++;
    const line = rawLine.trim();
    if (!line) continue;

    const columns = line.split(',').map((c) => c.trim());

    if (!header) {
      const missing = REQUIRED_COLUMNS.filter((col) => !columns.includes(col));
      if (missing.length > 0) {
        throw new Error(
          `CSV header is missing required column(s): ${missing.join(', ')}. ` +
            `Expected: ${REQUIRED_COLUMNS.join(',')}`
        );
      }
      header = columns;
      continue;
    }

    const row: Record<string, string> = {};
    header.forEach((col, i) => {
      row[col] = columns[i] ?? '';
    });

    if (!row.destination || !row.amount) {
      throw new Error(`Line ${lineNumber}: missing required field(s) (destination, amount)`);
    }

    payments.push({
      destination: row.destination,
      amount: row.amount,
      assetCode: row.assetCode || 'XLM',
    });
  }

  return payments;
}

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error('Usage: npx ts-node scripts/examples/batch_payment_csv.ts <path-to-csv>');
    process.exit(1);
  }

  const payments = await parseCsv(csvPath);
  console.log(`Parsed ${payments.length} payment(s) from ${csvPath}`);

  const agent = new PayFiAgent();

  const result = await agent.run({
    type: 'batch_payment',
    payload: { payments },
  });

  if (result.success) {
    console.log(
      `\n✅ Batch payment succeeded — ${payments.length} payment(s) submitted in one transaction.`
    );
    console.log(JSON.stringify(result.data, null, 2));
  } else {
    console.log(
      `\n❌ Batch payment failed — 0 of ${payments.length} payment(s) succeeded (the batch is atomic).`
    );
    console.log(`Error: ${result.error}`);
  }

  agent.destroy();
  process.exitCode = result.success ? 0 : 1;
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
