'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { registerTeamHistory, signWorkerToken, verifyWorkerToken, hashPassword, historyBooking } = require('./team-history');
const wid = '123456789012345678901234';
const bid = 'abcdefabcdefabcdefabcdef';
const secret = 'test-only-secret-not-production';

test('worker tokens reject tampering, admin role and expired sessions', () => {
  const worker = { _id: wid, sessionVersion: 2 };
  const token = signWorkerToken(worker, secret);
  assert.equal(verifyWorkerToken(token, secret).sub, wid);
  assert.equal(verifyWorkerToken(token, secret).version, 2);
  assert.equal(verifyWorkerToken(token + 'bad', secret), null);
  assert.equal(verifyWorkerToken(token, 'wrong-secret'), null);
  for (const payload of [{ role: 'admin', sub: wid, version: 0, exp: Date.now() / 1000 + 100 },
    { role: 'worker', sub: wid, version: 0, exp: 1 }]) {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signed = `${encoded}.${crypto.createHmac('sha256', secret).update(encoded).digest('base64url')}`;
    assert.equal(verifyWorkerToken(signed, secret), null);
  }
});
test('passwords use salted hashes', async () => {
  const a = await hashPassword('test-password-123', 'salt-a');
  assert.equal(a.length, 128);
  assert.equal(a, await hashPassword('test-password-123', 'salt-a'));
  assert.notEqual(a, await hashPassword('test-password-123', 'salt-b'));
});

function fixture({ worker = { _id: wid, name: 'Worker A', active: true, sessionVersion: 0, verificationStatus: 'approved', payoutSummary: 'UPI test' }, bookings = [] } = {}) {
  process.env.ADMIN_SESSION_SECRET = secret;
  const routes = new Map();
  const calls = [];
  const chain = (data) => ({ select() { return this; }, sort() { return this; }, skip() { return this; },
    limit() { return this; }, lean: async () => data, then(resolve, reject) { return Promise.resolve(data).then(resolve, reject); } });
  const Worker = { findOne(filter) {
    calls.push(['worker', filter]);
    return chain(worker && worker.active && worker.sessionVersion === filter.sessionVersion ? worker : null);
  }};
  const Booking = {
    find(filter) { calls.push(['find', filter]); return chain(bookings); },
    async updateMany(filter) { calls.push(['legacy', filter]); },
    async aggregate(pipeline) { calls.push(['aggregate', pipeline]); return []; },
    async findOneAndUpdate(filter, update) { calls.push(['update', filter, update]); return null; },
  };
  const app = {};
  for (const method of ['get', 'post', 'patch', 'delete']) app[method] = (path, ...handlers) => routes.set(`${method} ${path}`, handlers);
  registerTeamHistory({ app, mongoose: { models: { Worker }, Schema: class { static Types = { Mixed: Object, ObjectId: String }; }, model: () => ({}), isValidObjectId: value => /^[a-f0-9]{24}$/.test(value || '') },
    Booking, requireAdminKey: (req, res, next) => req.admin ? next() : res.status(401).json({ message: 'Unauthorized' }),
    requireCustomer: (req, res, next) => req.customer ? next() : res.status(401).json({ message: 'Unauthorized' }),
    customerLocalPhone: phone => phone?.replace('+91', '') });
  async function run(method, path, req = {}) {
    req = { query: {}, params: { id: bid }, body: {}, get: () => '', ...req };
    const handlers = routes.get(`${method} ${path}`);
    assert.ok(handlers, path);
    return new Promise((resolve, reject) => {
      const res = { code: 200, status(code) { this.code = code; return this; },
        json(data) { resolve({ code: this.code, data }); } };
      let index = 0;
      function next() { const handler = handlers[index++]; if (!handler) return reject(new Error('No response')); Promise.resolve(handler(req, res, next)).catch(reject); }
      next();
    });
  }
  const auth = { get: () => `Bearer ${signWorkerToken({ _id: wid, sessionVersion: 0 }, secret)}` };
  return { run, calls, auth };
}

test('worker cannot access administrator routes', async () => {
  const f = fixture();
  for (const [method, path] of [['get', '/api/admin/workers'], ['post', '/api/admin/workers'],
    ['patch', '/api/admin/workers/:id'], ['patch', '/api/admin/bookings/:id/assignment']]) {
    assert.equal((await f.run(method, path, f.auth)).code, 401);
  }
});
test('disabled or revoked worker session has no job access', async () => {
  for (const worker of [null, { _id: wid, active: false, sessionVersion: 0 }, { _id: wid, active: true, sessionVersion: 1 }]) {
    const f = fixture({ worker });
    assert.equal((await f.run('get', '/api/worker/bookings', f.auth)).code, 401);
    assert.equal(f.calls.some(c => c[0] === 'find'), false);
  }
});
test('workers only query their own assigned jobs', async () => {
  const f = fixture();
  const response = await f.run('get', '/api/worker/bookings', f.auth);
  assert.equal(response.code, 200);
  assert.deepEqual(f.calls.find(c => c[0] === 'find')[1], { assignedWorkerId: wid, status: { $ne: 'cancelled' } });
});
test('worker job updates require ownership and valid transition', async () => {
  const f = fixture();
  assert.equal((await f.run('patch', '/api/worker/bookings/:id/status', { ...f.auth, body: { status: 'cancelled' } })).code, 400);
  assert.equal((await f.run('patch', '/api/worker/bookings/:id/status', { ...f.auth, body: { status: 'completed' } })).code, 409);
  const update = f.calls.find(c => c[0] === 'update');
  assert.equal(update[1].assignedWorkerId, wid);
  assert.deepEqual(update[1].status, { $in: ['accepted'] });
  assert.ok(update[2].$set.completedAt instanceof Date);
});
test('worker cash request never marks a payment paid', async () => {
  const f = fixture();
  await f.run('post', '/api/worker/bookings/:id/cash-request', { ...f.auth, body: { amountPaise: 49900 } });
  const update = f.calls.find(c => c[0] === 'update');
  assert.equal(update[1].assignedWorkerId, wid);
  assert.equal(update[1].status, 'completed');
  assert.equal(update[1].quotedAmountPaise, 49900);
  assert.equal(update[1].paymentStatus, 'pending_collection');
  assert.equal(update[2].$set.cashCollection.status, 'awaiting_customer');
  assert.equal(update[2].$set.paymentStatus, undefined);
});
test('cash confirmation is customer-owned, exact amount, atomic and audited', async () => {
  const f = fixture();
  assert.equal((await f.run('post', '/api/customer/bookings/:id/cash-confirm', f.auth)).code, 401);
  const response = await f.run('post', '/api/customer/bookings/:id/cash-confirm', {
    customer: { uid: 'customer-a' }, body: { amountPaise: 49900 } });
  assert.equal(response.code, 409);
  const update = f.calls.find(c => c[0] === 'update');
  assert.equal(update[1].customerUid, 'customer-a');
  assert.equal(update[1].quotedAmountPaise, 49900);
  assert.equal(update[1]['cashCollection.amountPaise'], 49900);
  assert.equal(update[1].paymentStatus, 'pending_collection');
  assert.equal(update[2].$set.paymentStatus, 'paid');
  assert.equal(update[2].$set['cashCollection.status'], 'customer_confirmed');
  assert.equal(update[2].$push.paymentHistory.amountPaise, 49900);
});
test('customer history filters data and totals by authenticated customer', async () => {
  const f = fixture({ bookings: [{ _id: bid, service: 'Plumbing', passwordHash: 'never return' }] });
  const response = await f.run('get', '/api/customer/bookings', { customer: { uid: 'customer-a', phoneNumber: '+919999999999' } });
  assert.equal(response.code, 200);
  assert.deepEqual(f.calls.find(c => c[0] === 'find')[1], { customerUid: 'customer-a' });
  assert.deepEqual(f.calls.find(c => c[0] === 'aggregate')[1][0], { $match: { customerUid: 'customer-a' } });
  assert.equal(response.data.bookings[0].passwordHash, undefined);
  assert.equal(response.data.bookings[0].bookingId, bid);
});
test('historical timestamps are not invented', () => {
  const history = historyBooking({ _id: bid, status: 'completed', paymentStatus: 'not_started' });
  assert.equal(history.completedAt, null);
  assert.equal(history.paidAt, null);
  assert.deepEqual(history.paymentHistory, []);
});

test('booking schema validates cash audit and rejects stale payment saves', async () => {
  const fs = require('fs');
  const vm = require('vm');
  const mongoose = require('mongoose');
  const source = fs.readFileSync(require.resolve('./server'), 'utf8');
  const start = source.indexOf('const bookingSchema =');
  const end = source.indexOf("const Booking = mongoose.model('Booking', bookingSchema);");
  const schema = vm.runInNewContext(source.slice(start, end) + '\nbookingSchema;', { mongoose, Date });
  assert.equal(schema.options.optimisticConcurrency, true);
  const connection = mongoose.createConnection();
  const Model = connection.model('HistorySchemaTest', schema);
  const document = new Model({ customerName: 'Test', phone: '9999999999', address: 'Test address',
    service: 'Plumbing', date: '2026-10-30', time: '10 AM', status: 'completed',
    cashCollection: { workerId: wid, workerName: 'Worker A', status: 'customer_confirmed',
      amountPaise: 49900, confirmedAt: new Date() } });
  await document.validate();
  document.cashCollection.status = 'unverified_invalid_status';
  await assert.rejects(document.validate(), /cashCollection.status/);
  // Exercise the actual query middleware without contacting MongoDB.
  const query = Model.findOneAndUpdate({ _id: bid }, { $set: { paymentStatus: 'paid' } });
  await schema.s.hooks.execPre('findOneAndUpdate', query, []);
  assert.equal(query.getUpdate().$inc.__v, 1);
  await connection.close();
});

test('real admin verifier refuses a correctly signed worker token', () => {
  const fs = require('fs');
  const vm = require('vm');
  const source = fs.readFileSync(require.resolve('./server'), 'utf8');
  const start = source.indexOf('function safeEqualStrings(');
  const end = source.indexOf("app.post('/api/admin/login'", start);
  const verifyAdmin = vm.runInNewContext(source.slice(start, end) + '\nverifyAdminToken;', {
    crypto, Buffer, process: { env: { ADMIN_SESSION_SECRET: secret } },
  });
  assert.equal(verifyAdmin(signWorkerToken({ _id: wid, sessionVersion: 0 }, secret)), false);
});
