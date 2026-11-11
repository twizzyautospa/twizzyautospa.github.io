import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildQuote, cleanItems, cleanWebhookUrl, computeEstimate, DEFAULT_SETTINGS, normalizeSelections, normalizeSettings, suggestedItems,
} from "../netlify/lib/pricing.mts";
import { cleanMeasurement } from "../netlify/lib/leads.mts";
import { sniffImage } from "../netlify/lib/files.mts";

test("roofline estimate uses size, scope and storey multiplier", () => {
  const s = normalizeSelections({ service: "roofline", homeSize: "medium", stories: 2, scope: "front" });
  const e = computeEstimate(s, DEFAULT_SETTINGS);
  assert.equal(e.feet, 110);
  // 110 ft x $6 x 1.2 = $792, spread 15%, rounded to $25
  assert.deepEqual([e.low, e.high], [675, 900]);
});

test("full house adds trees and shrubs; trees-only ignores the roofline", () => {
  const full = normalizeSelections({ service: "full", homeSize: "small", trees: { small: 2, large: 1 }, shrubs: 3 });
  assert.deepEqual(suggestedItems(full, DEFAULT_SETTINGS).map((i) => i.label), ["Roofline lighting", "Small tree wrap", "Large tree wrap", "Shrub lighting"]);
  const trees = normalizeSelections({ service: "trees", homeSize: "xl", trees: { medium: 1 } });
  assert.equal(computeEstimate(trees, DEFAULT_SETTINGS).feet, 0);
  assert.deepEqual(suggestedItems(trees, DEFAULT_SETTINGS).map((i) => i.label), ["Medium tree wrap"]);
});

test("minimum job is a floor on the estimate", () => {
  const s = normalizeSelections({ service: "trees", shrubs: 1 });
  const e = computeEstimate(s, DEFAULT_SETTINGS);
  assert.equal(e.low, 350);
  assert.equal(e.high, 350);
});

test("a measured length replaces the quiz estimate", () => {
  const s = normalizeSelections({ service: "roofline", homeSize: "small" });
  assert.equal(suggestedItems(s, DEFAULT_SETTINGS, 143.4)[0].qty, 143);
});

test("selections are clamped and unknown values fall back", () => {
  const s = normalizeSelections({ service: "everything", stories: 99, trees: { small: -4, large: 1e9 }, shrubs: "7", color: "pink" });
  assert.equal(s.service, "roofline");
  assert.equal(s.stories, 3);
  assert.deepEqual(s.trees, { small: 0, medium: 0, large: 50 });
  assert.equal(s.shrubs, 7);
  assert.equal(s.color, "warm");
});

test("settings merge keeps stored values and rejects bad input", () => {
  const stored = normalizeSettings({ pricing: { rooflinePerFt: 8 }, brand: { color: "#112233" } });
  const next = normalizeSettings({ pricing: { rooflinePerFt: "abc", minimumJob: -5 }, brand: { color: "red", logo: "javascript:alert(1)" }, priceMode: "free" }, stored);
  assert.equal(next.pricing.rooflinePerFt, 8);
  assert.equal(next.pricing.minimumJob, 0);
  assert.equal(next.brand.color, "#112233");
  assert.equal(next.brand.logo, "");
  assert.equal(next.priceMode, "range");
});

test("webhook URLs must be public https", () => {
  assert.equal(cleanWebhookUrl("https://hooks.zapier.com/abc"), "https://hooks.zapier.com/abc");
  for (const bad of ["http://example.com/x", "https://localhost/x", "https://127.0.0.1/x", "https://10.0.0.5/x", "https://[::1]/x", "https://intranet/x", "https://user:pw@example.com/", "file:///etc/passwd", "nope"]) {
    assert.equal(cleanWebhookUrl(bad), "", bad);
  }
});

test("quote totals", () => {
  const items = cleanItems([{ label: "Roofline", qty: 120, unit: "ft", unitPrice: 7.2 }, { label: "", qty: 3, unitPrice: 5 }, { label: "Discount", qty: 1, unitPrice: -64 }]);
  assert.equal(items.length, 2);
  const q = buildQuote(items, ["2026-11-27"], "note");
  assert.equal(q.total, 800);
  assert.equal(q.deposit, undefined);
  assert.equal(normalizeSettings({ depositPct: 25 }).depositPct, undefined);
});

test("measurement length is computed on the server", () => {
  // Two points about 30.5 m apart along a meridian: roughly 100 ft.
  const m = cleanMeasurement({ lines: [[[43.65, -79.38], [43.650274, -79.38]], [[1, 2]], "junk"], feet: 99999 });
  assert.equal(m.lines.length, 1);
  assert.ok(Math.abs(m.feet - 100) <= 1, `got ${m.feet}`);
});

test("image type comes from the file's bytes", () => {
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))?.ext, "jpg");
  assert.equal(sniffImage(Buffer.from("<svg onload=alert(1)>")), null);
});

import { cleanCrmConfig } from "../netlify/lib/crm-config.mts";
import { toE164 } from "../netlify/lib/ghl.mts";

test("phone numbers are normalised for the CRM", () => {
  assert.equal(toE164("(416) 555-0123"), "+14165550123");
  assert.equal(toE164("1 416 555 0123"), "+14165550123");
  assert.equal(toE164("+44 20 7946 0958"), "+442079460958");
  assert.equal(toE164("ext."), "");
});

test("a CRM link needs a pipeline and all five stages", () => {
  const stages = { new: "stage-new-1", quoted: "stage-quoted-1", booked: "stage-booked-1", completed: "stage-done-1", lost: "stage-lost-1" };
  const ok = cleanCrmConfig({ provider: "ghl", pipelineId: "pipeline-1", stages, since: "2026-11-11T00:00:00Z" });
  assert.equal(ok.pipelineId, "pipeline-1");
  assert.equal(ok.importBooked, true);
  assert.equal(cleanCrmConfig({ provider: "ghl", pipelineId: "pipeline-1", stages: { ...stages, lost: "" } }), null);
  assert.equal(cleanCrmConfig({ provider: "other", pipelineId: "pipeline-1", stages }), null);
  assert.equal(cleanCrmConfig({ provider: "ghl", pipelineId: "../../etc", stages }), null);
  assert.equal(cleanCrmConfig(null), null);
});
