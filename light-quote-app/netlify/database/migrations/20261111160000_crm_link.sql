-- CRM link: which pipeline an installer's leads sync with, and each lead's contact and opportunity in the CRM.
ALTER TABLE installers ADD COLUMN crm JSONB;
ALTER TABLE leads ADD COLUMN crm JSONB;
CREATE INDEX leads_crm_opportunity_idx ON leads ((crm->>'opportunityId'));

-- Link Bright Home Care to their pipeline. Only stage changes made after this runs are brought in.
UPDATE installers SET crm = jsonb_build_object(
  'provider', 'ghl',
  'pipelineId', 'AtVDioS4brdnXodpBWZh',
  'stages', jsonb_build_object(
    'new', '4844226c-9400-4162-9fd7-86978c63807e',
    'quoted', '25f1743b-32e1-4f29-bd09-cb4a9d1251da',
    'booked', 'c570a91b-f66e-42e2-8ffc-0ba0ce3f3670',
    'completed', 'ad85fbe2-a1b4-4ebb-ae13-ee6420101b5e',
    'lost', '35370ac6-3607-42c0-90be-08a2dc8ea152'
  ),
  'importBooked', true,
  'since', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
)
WHERE id = 'b7c1f0de-5d2a-4c1e-9a53-0b61c2f4a901';
