import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanCrmConfig, suggestStages } from "../netlify/lib/crm-config.mts";

const stage = (id, name) => ({ id, name });

test("stage suggestions match a typical pipeline by name", () => {
  const picked = suggestStages([
    stage("s1", "New Lead"), stage("s2", "Contacted"), stage("s3", "Unresponsive"), stage("s4", "Quoted"),
    stage("s5", "Closed"), stage("s6", "Job Completed"), stage("s7", "Lost"),
  ]);
  assert.deepEqual(picked, { new: "s1", quoted: "s4", booked: "s5", completed: "s6", lost: "s7" });
});

test("a lost stage is never mistaken for the booked one", () => {
  const picked = suggestStages([stage("a", "Incoming"), stage("b", "Estimate Sent"), stage("c", "Closed Won"), stage("d", "Closed Lost")]);
  assert.equal(picked.booked, "c");
  assert.equal(picked.lost, "d");
  assert.equal(picked.quoted, "b");
  assert.equal(picked.completed, "");
});

test("unfamiliar stage names leave blanks instead of guessing", () => {
  const picked = suggestStages([stage("x", "Fresh"), stage("y", "Talking")]);
  assert.deepEqual(picked, { new: "x", quoted: "", booked: "", completed: "", lost: "" });
});

test("a CRM link needs a pipeline and all five stages", () => {
  const stages = { new: "stage_a1", quoted: "stage_b2", booked: "stage_c3", completed: "stage_d4", lost: "stage_e5" };
  assert.equal(cleanCrmConfig({ provider: "ghl", pipelineId: "pipeline_1", stages: { ...stages, lost: "" } }), null);
  const ok = cleanCrmConfig({ provider: "ghl", pipelineId: "pipeline_1", stages });
  assert.equal(ok.pipelineId, "pipeline_1");
  assert.equal(ok.importBooked, true);
  assert.ok(!Number.isNaN(Date.parse(ok.since)));
});

test("quote follow-ups default to two days and can be changed or turned off", () => {
  const stages = { new: "stage_a1", quoted: "stage_b2", booked: "stage_c3", completed: "stage_d4", lost: "stage_e5" };
  const link = (extra) => cleanCrmConfig({ provider: "ghl", pipelineId: "pipeline_1", stages, ...extra });
  assert.equal(link({}).followUpDays, 2);
  assert.equal(link({ followUpDays: 5 }).followUpDays, 5);
  assert.equal(link({ followUpDays: 0 }).followUpDays, 0);
  assert.equal(link({ followUpDays: "3" }).followUpDays, 3);
  assert.equal(link({ followUpDays: 400 }).followUpDays, 30);
  assert.equal(link({ followUpDays: "soon" }).followUpDays, 2);
});
