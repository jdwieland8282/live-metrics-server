// patched server.mjs — Enrichment Lift demo collector WITH cohort/CPM TSV logging
// Base: user's server.patched.mjs; additions marked "CPM-LOG".

import http from 'node:http';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---- configuration ----
const PORT = Number(process.env.PORT || 9090);
const LOG  = process.env.LOG || join(__dirname, 'lift-logs.json');
// CPM-LOG: simple append-only TSV with timestamp, cohort, baseline, treatment, incremental, winner
const CPM_LOG = process.env.CPM_LOG || join(__dirname, 'cohort-cpm.txt');

// ---- in-memory aggregates ----
const agg = {
  totals: { events: 0 },
  byCohort: {
    control:   { auctions: 0, baseline: 0, treatment: 0, incremental: 0 },
    test:      { auctions: 0, baseline: 0, treatment: 0, incremental: 0 }
  }
};

// Cache labels we've seen per auction so later events can reuse them
const labelsByAuction = new Map();

function cors(req, res) {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

function writeLog(line) {
  fs.appendFile(LOG, line + '\n', () => {});
}

// CPM-LOG: helper to append a single TSV line
function writeCpmLine({ cohort, baselineCpm, treatmentCpm, incrementalCpm, winner }) {
  const ts = new Date().toISOString();
  const line = [
    ts,
    (cohort ?? '').toString(),
    Number(baselineCpm ?? 0),
    Number(treatmentCpm ?? 0),
    Number(incrementalCpm ?? 0),
    (winner ?? '').toString()
  ].join('\t');
  fs.appendFile(CPM_LOG, line + '\n', () => {});
}

function parseJsonSafe(buf) {
  try {
    return JSON.parse(buf.toString('utf-8'));
  } catch {
    return null;
  }
}

// Update metrics for custom summary events only (type === 'lift_auction')
function updateAgg(ev) {
  try {
    if (ev && ev.type === 'lift_auction') {
      const cohort = (ev.cohort || 'test').toLowerCase();
      const bucket = agg.byCohort[cohort] || agg.byCohort.test;
      bucket.auctions += 1;
      bucket.baseline += Number(ev.baselineCpm || 0);
      bucket.treatment += Number(ev.treatmentCpm || 0);
      bucket.incremental += Number(ev.incrementalCpm || 0);
    }
  } catch {}
}

function tailFileLines(file, n = 20) {
  try {
    const text = fs.readFileSync(file, 'utf-8');
    const lines = text.split(/\r?\n/).filter(Boolean);
    return lines.slice(-n).map(l => JSON.parse(l));
  } catch {
    return [];
  }
}

// CPM-LOG: tail helper for plain-text files
function tailTextFile(file, n = 50) {
  try {
    const text = fs.readFileSync(file, 'utf-8');
    const lines = text.split(/\r?\n/).filter(Boolean);
    return lines.slice(-n);
  } catch {
    return [];
  }
}

const server = http.createServer((req, res) => {
  cors(req, res);
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ---- Collect endpoint ----
  if (req.method === 'POST' && url.pathname === '/collect') {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const parsed = parseJsonSafe(body);
      if (!parsed) { res.writeHead(400); res.end('invalid json'); return; }

      const items = Array.isArray(parsed) ? parsed : [parsed];

      for (const ev of items) {
        // Hoist labels
        let labels = ev.labels || (ev.args && ev.args.labels) || {};
        const auctionId =
          (ev && ev.args && ev.args.auctionId) ||
          (ev && ev.payload && ev.payload.auctionId) ||
          null;

        // Reuse cached labels for this auction if current is empty
        if ((!labels || !Object.keys(labels).length) && auctionId && labelsByAuction.has(auctionId)) {
          labels = labelsByAuction.get(auctionId);
        }
        ev.labels = labels;

        // Remember labels for this auction
        if (auctionId && labels && Object.keys(labels).length) {
          labelsByAuction.set(auctionId, labels);
        }

        agg.totals.events += 1;
        updateAgg(ev);
        writeLog(JSON.stringify(ev));

        // CPM-LOG: write a TSV line when we see the summary event
        if (ev && ev.type === 'lift_auction') {
          writeCpmLine({
            cohort: (ev.cohort || 'test'),
            baselineCpm: ev.baselineCpm,
            treatmentCpm: ev.treatmentCpm,
            incrementalCpm: ev.incrementalCpm,
            winner: ev.winner
          });
        }

        // Light cleanup after auction ends
        if (ev.eventType === 'auctionEnd' && auctionId) {
          setTimeout(() => labelsByAuction.delete(auctionId), 30_000);
        }
      }

      res.writeHead(204);
      res.end();
    });
    return;
  }

  // ---- Clear logs + counters (dev) ----
  if (req.method === 'POST' && url.pathname === '/clear') {
    fs.writeFile(LOG, '', () => {});
    // CPM-LOG: also clear the TSV log
    fs.writeFile(CPM_LOG, '', () => {});
    agg.totals.events = 0;
    agg.byCohort.control = { auctions: 0, baseline: 0, treatment: 0, incremental: 0 };
    agg.byCohort.test    = { auctions: 0, baseline: 0, treatment: 0, incremental: 0 };
    labelsByAuction.clear();
    res.writeHead(204); res.end(); return;
  }

  // ---- Events tail ----
  if (req.method === 'GET' && url.pathname === '/events') {
    const n = Math.max(1, Math.min(1000, Number(url.searchParams.get('n') || 20)));
    const data = tailFileLines(LOG, n);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data, null, 2));
    return;
  }

  // CPM-LOG: get last N TSV lines
  if (req.method === 'GET' && url.pathname === '/cpm') {
    const n = Math.max(1, Math.min(10000, Number(url.searchParams.get('n') || 100)));
    const lines = tailTextFile(CPM_LOG, n);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(lines.join('\n'));
    return;
  }

  // ---- Metrics (averages + global incremental lift) ----
  if (req.method === 'GET' && url.pathname === '/metrics') {
    const avg = (b) => {
      const auctions = Number(b.auctions || 0);
      return {
        auctions,
        avgBaseline: auctions ? b.baseline / auctions : 0,
        avgTreatment: auctions ? b.treatment / auctions : 0,
        avgIncremental: auctions ? b.incremental / auctions : 0
      };
    };

    const c = agg.byCohort.control, t = agg.byCohort.test;
    const A = avg(c), B = avg(t);
    const totalAuctions = (c?.auctions || 0) + (t?.auctions || 0);

    // Global lift = "how much more we made because SharedID was present"
    const liftAbs = B.avgTreatment - A.avgTreatment;                    // $ per auction
    const liftPct = A.avgTreatment ? (liftAbs / A.avgTreatment) : null; // fraction (e.g., 0.25 = +25%)

    const response = {
      totals: { events: agg.totals.events, auctions: totalAuctions },
      byCohort: { control: A, test: B },
      global: {
        incrementalLiftAbs: liftAbs,
        incrementalLiftPct: liftPct
      }
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response, null, 2));
    return;
  }

  // ---- Health ----
  if (req.method === 'GET' && url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // default 404
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`[lift] analytics server listening on http://localhost:${PORT}`);
  console.log(`[lift] writing JSONL events to ${LOG}`);
  console.log(`[lift] writing CPM TSV to ${CPM_LOG}`); // CPM-LOG
});
