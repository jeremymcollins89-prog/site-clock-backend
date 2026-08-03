// test/support/mockDb.js
//
// Swaps out the real Postgres connection in db.js for an in-memory fake, so
// tests can run with no database and no network access at all -- just plain
// Node. This works because db.js exports a plain object ({ query, pool }),
// and every file that uses it does `const db = require("../db"); ...
// db.query(...)` -- a property lookup at call time, not a value captured
// once at require time. Overwriting db.query here is visible to every other
// file that required the same (cached) module, in either order.
const db = require("../../db");

// install() returns a handle for one test: `responses` is a queue of
// { rows } (or an Error to throw) consumed in call order by db.query, and
// `calls` records every { text, params } the code under test actually sent,
// so a test can assert on the real SQL/params instead of just the return
// value. Call handle.restore() in the test's `after`/`finally` so a later
// test file doesn't inherit a used-up queue.
function installMockDb() {
  const original = db.query;
  const calls = [];
  const responses = [];

  db.query = async (text, params) => {
    calls.push({ text, params });
    if (responses.length === 0) {
      return { rows: [], rowCount: 0 };
    }
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return { rows: next, rowCount: next.length };
  };

  return {
    calls,
    queueRows(rows) {
      responses.push(rows);
    },
    queueError(err) {
      responses.push(err);
    },
    restore() {
      db.query = original;
    },
  };
}

module.exports = { installMockDb };
