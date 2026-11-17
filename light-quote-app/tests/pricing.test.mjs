import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildQuote, cleanItems, cleanWebhookUrl, computeEstimate, DEFAULT_SETTINGS, estimateBreakdown, nextYearPrice, normalizeSelections, normalizeSettings, suggestedItems,
} from "../netlify/lib/pricing.mts";
import { cleanMeasurement } from "../netlify/lib/leads.mts";
import { sniffImage } from "../netlify/lib/files.mts";

test("roofline estimate uses size, scope and storey multiplier", () => {
  const s = normalizeSelections({ service: "roofline", homeSize: "medium", stories: 2, scope: "front" });
  const e = computeEstimate(s, DEFAULT_SETTINGS);
  assert.equal(e.feet, 110);
  // 110 ft x ($3 lights + ($6 install + $1.50 takedown) x 1.2) = $1,320, spread 15%, rounded to $25
  assert.deepEqual([e.low, e.high], [1125, 1525]);
});

test("full house adds trees and shrubs; trees-only ignores the roofline", () => {
  const full = normalizeSelections({ service: "full", homeSize: "small", trees: { small: 2, large: 1 }, shrubs: 3 });
  assert.deepEqual(suggestedItems(full, DEFAULT_SETTINGS).map((i) => i.label), [
    "Roofline lights, supplied", "Roofline installation", "Roofline takedown",
    "Small tree wrap, lights included", "Large tree wrap, lights included",
    "Shrub lighting, lights included",
  ]);
  const trees = normalizeSelections({ service: "trees", homeSize: "xl", trees: { medium: 1 } });
  assert.equal(computeEstimate(trees, DEFAULT_SETTINGS).feet, 0);
  assert.deepEqual(suggestedItems(trees, DEFAULT_SETTINGS).map((i) => i.label), ["Medium tree wrap, lights included"]);
});

test("minimum job is a floor on the estimate", () => {
  const s = normalizeSelections({ service: "trees", shrubs: 1 });
  const e = computeEstimate(s, DEFAULT_SETTINGS);
  assert.equal(e.low, 350);
  assert.equal(e.high, 350);
});

test("a measured length replaces the quiz estimate", () => {
  const s = normalizeSelections({ service: "roofline", homeSize: "small" });
  assert.deepEqual(suggestedItems(s, DEFAULT_SETTINGS, 143.4).map((i) => i.qty), [143, 143, 143]);
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
  const stored = normalizeSettings({ pricing: { installPerFt: 8 }, brand: { color: "#112233" } });
  const next = normalizeSettings({ pricing: { installPerFt: "abc", minimumJob: -5 }, brand: { color: "red", logo: "javascript:alert(1)" }, priceMode: "free" }, stored);
  assert.equal(next.pricing.installPerFt, 8);
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

test("each plan pays only for its own parts, one line per part", () => {
  const lines = (plan) => suggestedItems(normalizeSelections({ service: "roofline", homeSize: "medium", stories: 2, plan }), DEFAULT_SETTINGS);
  assert.deepEqual(lines("full").map((i) => [i.label, i.qty, i.unitPrice]), [
    ["Roofline lights, supplied", 110, 3],
    ["Roofline installation, 2-storey", 110, 7.2],
    ["Roofline takedown, 2-storey", 110, 1.8],
  ]);
  assert.deepEqual(lines("installTakedown").map((i) => i.label), ["Roofline installation, 2-storey", "Roofline takedown, 2-storey"]);
  assert.deepEqual(lines("install").map((i) => i.label), ["Roofline installation, 2-storey"]);
  // One storey, all three: $3 + $6 + $1.50 = $10.50 a foot.
  const single = suggestedItems(normalizeSelections({ service: "roofline", plan: "full" }), DEFAULT_SETTINGS);
  assert.equal(single.reduce((sum, i) => sum + i.unitPrice, 0), 10.5);
});

test("tree prices drop by the share of the parts the customer does not need", () => {
  const price = (plan) => suggestedItems(normalizeSelections({ service: "trees", trees: { medium: 1 }, plan }), DEFAULT_SETTINGS)[0];
  assert.equal(price("full").unitPrice, 140);
  assert.equal(price("installTakedown").unitPrice, 100); // 140 x 7.5 / 10.5
  assert.equal(price("install").unitPrice, 80); // 140 x 6 / 10.5
  assert.equal(price("install").label, "Medium tree wrap, your lights, install only");
  // Shares that do not divide evenly are rounded to the dollar: 60 x 7.5 / 10.5 = 42.86.
  assert.equal(suggestedItems(normalizeSelections({ service: "trees", trees: { small: 1 }, plan: "installTakedown" }), DEFAULT_SETTINGS)[0].unitPrice, 43);
});

test("a custom request keeps the customer's words; other plans drop them", () => {
  assert.equal(normalizeSelections({ plan: "other", planNote: "  Takedown only  " }).planNote, "Takedown only");
  assert.equal(normalizeSelections({ plan: "install", planNote: "ignored" }).planNote, "");
  assert.equal(normalizeSelections({ plan: "nonsense" }).plan, "full");
  assert.equal(normalizeSelections({}).plan, "full");
});

test("the estimate breakdown is only shown when it adds up to the estimate", () => {
  const s = normalizeSelections({ service: "roofline", homeSize: "medium", stories: 2 });
  const estimate = computeEstimate(s, DEFAULT_SETTINGS);
  assert.equal(estimateBreakdown(s, DEFAULT_SETTINGS, estimate).length, 3);
  // Prices went up after the request came in: the stored estimate no longer matches, so no lines.
  const dearer = normalizeSettings({ pricing: { installPerFt: 12 } });
  assert.deepEqual(estimateBreakdown(s, dearer, estimate), []);
  // A job under the minimum is shown as the minimum, which the lines would not add up to.
  const small = normalizeSelections({ service: "trees", shrubs: 1 });
  assert.deepEqual(estimateBreakdown(small, DEFAULT_SETTINGS, computeEstimate(small, DEFAULT_SETTINGS)), []);
});

test("first-time customers see what next year costs without buying the lights again", () => {
  const s = normalizeSelections({ service: "full", homeSize: "medium", stories: 2, plan: "full", trees: { medium: 1 } });
  const items = suggestedItems(s, DEFAULT_SETTINGS, 94);
  // This year 94 x (3 + 7.2 + 1.8) + 140 = 1,268. Next year 94 x 9 + 100 = 946.
  assert.equal(buildQuote(items, [], "").total, 1268);
  assert.equal(nextYearPrice(items), 946);
  assert.equal(buildQuote(items, [], "").nextYear, 946);
  // The installer lowers the installation rate: next year follows the lines, not a fixed proportion.
  const edited = items.map((i) => (i.label.startsWith("Roofline installation") ? { ...i, unitPrice: 6 } : i));
  assert.equal(nextYearPrice(edited), 833); // 94 x (6 + 1.8) + 100 = 833.20
  // The lights share survives a round trip through the quote builder, and bad values are dropped.
  assert.equal(cleanItems(items)[0].lightsShare, 1);
  assert.equal("lightsShare" in cleanItems([{ label: "Timer", qty: 1, unit: "each", unitPrice: 25, lightsShare: "lots" }])[0], false);
  // Customers who already own lights have no cheaper second year to show.
  const own = suggestedItems({ ...s, plan: "installTakedown" }, DEFAULT_SETTINGS, 94);
  assert.equal(nextYearPrice(own), undefined);
  assert.equal("nextYear" in buildQuote(own, [], ""), false);
  // Next year is still subject to the minimum job, and is hidden when that leaves no saving.
  const tiny = suggestedItems(normalizeSelections({ service: "roofline", plan: "full" }), DEFAULT_SETTINGS, 36);
  assert.equal(buildQuote(tiny, [], "", false, 350).nextYear, 350); // 36 x 10.5 = 378 this year, 270 next
  assert.equal(nextYearPrice(suggestedItems(normalizeSelections({ service: "roofline", plan: "full" }), DEFAULT_SETTINGS, 30), 350), undefined);
});
