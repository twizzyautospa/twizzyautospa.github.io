'use strict';
// Demo / testing only: an in-memory stand-in for the GoHighLevel API, filled with a fictional
// business ("Northshore Landscaping") and fictional customers. Turned on by PORTAL_MOCK_GHL=1 in
// scripts/dev.mjs; it replaces https.request for services.leadconnectorhq.com only.
const https = require('https');
const { EventEmitter } = require('events');

const PIPE = 'demo-pipeline';
const STAGES = ['New Lead', 'Contacted', 'Unresponsive', 'Quoted', 'Closed', 'Job Completed', 'Lost']
  .map((name, i) => ({ id: `stage-${i + 1}`, name, position: i }));
const sid = (name) => STAGES.find((s) => s.name === name).id;

const PEOPLE = [
  ['Emily Carter', 'New Lead', 2, 0], ['Marcus Bell', 'New Lead', 5, 0], ['Priya Nair', 'New Lead', 9, 0],
  ['Daniel Kowalski', 'New Lead', 20, 0], ['Sofia Rossi', 'New Lead', 30, 0], ['Liam O\'Brien', 'New Lead', 50, 0],
  ['Hannah Lee', 'Contacted', 28, 0], ['Omar Haddad', 'Contacted', 60, 0], ['Grace Thompson', 'Contacted', 80, 0],
  ['Noah Fischer', 'Contacted', 96, 0], ['Ava Martin', 'Unresponsive', 150, 0], ['Ethan Clarke', 'Unresponsive', 200, 0],
  ['Chloe Dubois', 'Quoted', 70, 6200], ['Lucas Moreau', 'Quoted', 110, 3400], ['Mia Patel', 'Quoted', 130, 8900],
  ['James Wilson', 'Closed', 140, 4800], ['Olivia Brown', 'Closed', 170, 2950], ['Benjamin Wong', 'Closed', 190, 7400],
  ['Isabella Nguyen', 'Job Completed', 260, 5600], ['Jack Robinson', 'Lost', 300, 0],
];
const REFERRALS = new Set(['Noah Fischer', 'Benjamin Wong']);

const now = Date.now();
const contacts = new Map();
const opps = new Map();
const notes = new Map();
PEOPLE.forEach(([name, stage, hoursAgo, value], i) => {
  const cid = `demo-contact-${i + 1}`;
  const first = name.split(' ')[0].toLowerCase().replace(/[^a-z]/g, '');
  contacts.set(cid, {
    id: cid, name, firstName: name.split(' ')[0], phone: `+1416555${String(1100 + i * 7).padStart(4, '0')}`,
    email: `${first}@example.com`, tags: [], customFields: [],
  });
  const created = new Date(now - hoursAgo * 3600e3).toISOString();
  opps.set(`demo-opp-${i + 1}`, {
    id: `demo-opp-${i + 1}`, name: `${name} Opportunity`, pipelineId: PIPE, pipelineStageId: sid(stage),
    status: stage === 'Lost' ? 'lost' : 'open', monetaryValue: value, source: REFERRALS.has(name) ? 'Referral' : 'Form Submission',
    contactId: cid, locationId: process.env.GHL_LOCATION_ID || 'demo-location',
    createdAt: created, updatedAt: created, lastStageChangeAt: created, lastStatusChangeAt: created,
    attributions: REFERRALS.has(name) ? [] : [{ medium: 'Paid Social', utmSource: 'facebook', isFirst: true }],
  });
});
notes.set('demo-contact-7', [{ id: 'n1', body: 'Called, wants a quote for backyard patio + lighting. Prefers weekday mornings.', dateAdded: new Date(now - 20 * 3600e3).toISOString() }]);

const FIELDS = ['Next Job Date', 'Next Job Time', 'Next Job Type', 'Next Job Address', 'Next Job Business']
  .map((name, i) => ({ id: `demo-field-${i + 1}`, name, dataType: i ? 'TEXT' : 'DATE', fieldKey: `contact.${name.toLowerCase().replace(/ /g, '_')}` }));

const oppOut = (o) => ({ ...o, contact: (({ id, name, phone, email, tags }) => ({ id, name, phone, email, tags, companyName: '' }))(contacts.get(o.contactId)) });

function route(method, path, body) {
  const url = new URL(path, 'https://mock');
  const p = url.pathname;
  let m;
  if (method === 'GET' && p === '/opportunities/pipelines') {
    return [200, { pipelines: [{ id: PIPE, name: 'Northshore Landscaping', stages: STAGES }] }];
  }
  if (method === 'GET' && p === '/opportunities/search') {
    const list = [...opps.values()].filter((o) => o.pipelineId === url.searchParams.get('pipeline_id')).map(oppOut);
    return [200, { opportunities: list, meta: { total: list.length } }];
  }
  if ((m = p.match(/^\/opportunities\/([^/]+)$/))) {
    const o = opps.get(m[1]);
    if (!o) return [404, { message: 'Not found' }];
    if (method === 'GET') return [200, { opportunity: oppOut(o) }];
    if (method === 'PUT') {
      if (body.pipelineStageId && body.pipelineStageId !== o.pipelineStageId) o.lastStageChangeAt = new Date().toISOString();
      Object.assign(o, body, { updatedAt: new Date().toISOString() });
      return [200, { opportunity: oppOut(o) }];
    }
    if (method === 'DELETE') { opps.delete(m[1]); return [200, { succeded: true }]; }
  }
  if ((m = p.match(/^\/contacts\/([^/]+)\/notes$/))) {
    const list = notes.get(m[1]) || [];
    if (method === 'GET') return [200, { notes: list }];
    const n = { id: `note-${Date.now()}`, body: body.body, dateAdded: new Date().toISOString() };
    notes.set(m[1], [n, ...list]);
    return [201, { note: n }];
  }
  if ((m = p.match(/^\/contacts\/([^/]+)\/tags$/))) {
    const c = contacts.get(m[1]);
    if (!c) return [404, { message: 'Not found' }];
    if (method === 'POST') c.tags = [...new Set([...c.tags, ...(body.tags || [])])];
    if (method === 'DELETE') c.tags = c.tags.filter((t) => !(body.tags || []).includes(t));
    return [200, { tags: c.tags }];
  }
  if (method === 'GET' && /^\/locations\/[^/]+\/customFields$/.test(p)) return [200, { customFields: FIELDS }];
  if ((m = p.match(/^\/contacts\/([^/]+)$/)) && method === 'PUT') return [200, { contact: contacts.get(m[1]) || {} }];
  if (method === 'POST' && p === '/contacts/upsert') {
    const id = `demo-contact-x${Date.now()}`;
    contacts.set(id, { id, name: body.name, phone: body.phone, email: body.email, tags: [] });
    return [200, { contact: { id } }];
  }
  if (method === 'POST' && p === '/conversations/messages') return [200, { messageId: `msg-${Date.now()}` }];
  return [404, { message: `mock: no route for ${method} ${p}` }];
}

function install() {
  const real = https.request;
  https.request = (opts, cb) => {
    if (!opts || opts.host !== 'services.leadconnectorhq.com') return real.call(https, opts, cb);
    const req = new EventEmitter();
    let data = '';
    req.write = (chunk) => { data += chunk; };
    req.destroy = () => {};
    req.end = () => {
      setTimeout(() => {
        let body = {};
        try { body = data ? JSON.parse(data) : {}; } catch { /* empty */ }
        const [status, json] = route(opts.method || 'GET', opts.path, body);
        const res = new EventEmitter();
        res.statusCode = status;
        res.setEncoding = () => {};
        cb(res);
        res.emit('data', JSON.stringify(json));
        res.emit('end');
      }, 40);
    };
    return req;
  };
  console.log('Mock GoHighLevel on: demo business "Northshore Landscaping"');
}

module.exports = { install, PIPE };
