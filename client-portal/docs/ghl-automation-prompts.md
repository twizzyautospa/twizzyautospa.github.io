# Claude in Chrome prompts: GHL automations for the client portal

Run these in order in Claude in Chrome while logged in to GoHighLevel (sub-account **LeadThru**).
Fill in everything in [BRACKETS] first.

How it connects to the portal:

- **Review request**: the client taps **Mark job done** in the portal → the lead moves to **Job Completed** →
  the GHL workflow for that client texts the review request 24 hours later.
- **Day-of confirmation**: every booking in the portal writes the customer's next job onto their GHL contact
  (Next Job Date / Time / Type / Address / Business). Rescheduling updates it, cancelling or finishing the
  job clears it. The GHL workflow fires on the Next Job Date.

---

## Prompt 1: Job Completed stage + "Next Job" fields (run first)

```
I'm in my GoHighLevel sub-account "LeadThru". Please make these setup changes. Do not delete, rename or reorder anything that already exists, and do not touch any workflows.

PART A: Add a "Job Completed" stage
Go to Opportunities → Pipelines. For each of these pipelines, edit the pipeline and add a new stage named exactly:
Job Completed
Place it right after "Closed" and before "Lost". Save. Skip a pipeline if it already has "Job Completed".
- A to Z Pipeline
- Bright Home Care
- Elite Exteriors
- Summer Solutions
- Terra Bella Pipeline
- Koltov Construction Pipeline
- TMD Home Construction Pipeline

PART B: Create 5 contact custom fields
Go to Settings → Custom Fields (object: Contacts). If you can, create a folder named "Portal Jobs" and put them in it. Use these exact names (same capitals and spaces). My client portal finds them by name:
1. Next Job Date (field type: Date Picker)
2. Next Job Time (field type: Single Line)
3. Next Job Type (field type: Single Line)
4. Next Job Address (field type: Single Line)
5. Next Job Business (field type: Single Line)

When you're done, give me a checklist: each pipeline with its stage order, and each new field with its merge key (for example {{contact.next_job_time}}).
```

---

## Prompt 2: Review request 24 hours after Job Completed (one workflow per client)

Fill in: your A2P number and each client's Google review link (in Google Maps: the business → **Reviews** →
**Write a review** → copy the link, or Google Business Profile → **Ask for reviews**).
Check the wording for Bright Home Care and Summer Solutions matches what they actually do.

```
In my GoHighLevel sub-account "LeadThru", build one review-request workflow per client below. Don't edit, turn off or delete any existing workflow.

Build the first one, show it to me, and once I say it's right, clone it for the others (Automation → Workflows → ⋯ menu → Clone). For each clone change only the name, the pipeline filter and the message.

Each workflow:
- Name: "Review Request – <Client name>"
- Trigger: "Pipeline Stage Changed". Filters: In pipeline = <the client's pipeline>, and Pipeline stage = "Job Completed".
- Step 1: Wait 1 day.
- Step 2: Make sure the text only goes out between 10:00 AM and 7:00 PM, Monday to Sunday (use the Wait step's time-window / "resume during" option; if there isn't one, set the workflow's time window in its Settings).
- Step 3: Send SMS. From number: [PASTE YOUR A2P NUMBER]. Message: the client's message below. Insert the first-name merge field with the custom-value picker so it's exactly {{contact.first_name}}.
- Workflow settings: Allow re-entry OFF. Stop on response OFF.

Leave every workflow as a DRAFT. When all are built, list each one with its trigger filters, waits, from-number and message, and ask me before publishing anything.

Clients:

1) A to Z Electrical Services: pipeline "A to Z Pipeline"
Message: Hi {{contact.first_name}}, thanks for choosing A to Z Electrical Services! We hope everything's working perfectly. If you were happy with our work, a quick Google review would mean a lot to our team: [A TO Z REVIEW LINK]

2) Bright Home Care: pipeline "Bright Home Care"
Message: Hi {{contact.first_name}}, thank you for trusting Bright Home Care! We hope you're happy with the service. If you have a moment, a short Google review really helps other families find us: [BRIGHT HOME CARE REVIEW LINK]

3) Elite Exteriors: pipeline "Elite Exteriors"
Message: Hi {{contact.first_name}}, thanks for choosing Elite Exteriors! We hope you're loving how your home looks. If you were happy with the job, a quick Google review would mean a lot to us: [ELITE EXTERIORS REVIEW LINK]

4) Summer Solutions: pipeline "Summer Solutions"
Message: Hi {{contact.first_name}}, thanks for choosing Summer Solutions! We hope you're enjoying the finished work. If we earned it, would you leave us a quick Google review? [SUMMER SOLUTIONS REVIEW LINK]

5) Terra Bella Landscaping: pipeline "Terra Bella Pipeline"
Message: Hi {{contact.first_name}}, thanks for choosing Terra Bella Landscaping! We hope you're enjoying your new outdoor space. If you're happy with how it turned out, a quick Google review would mean the world to us: [TERRA BELLA REVIEW LINK]

6) Koltov Construction: pipeline "Koltov Construction Pipeline"
Message: Hi {{contact.first_name}}, thank you for trusting Koltov Construction with your project! We hope you love the finished result. If you were happy with our work, a quick Google review helps us a lot: [KOLTOV REVIEW LINK]

7) TMD Home Construction: pipeline "TMD Home Construction Pipeline"
Message: Hi {{contact.first_name}}, thanks for choosing TMD Home Construction! We hope you're enjoying your newly finished space. If you were happy with the job, we'd really appreciate a quick Google review: [TMD REVIEW LINK]

If any review link is still in [BRACKETS], skip that client and tell me at the end.
```

---

## Prompt 3: Day-of job confirmation (one workflow for all clients)

```
In my GoHighLevel sub-account "LeadThru", build a day-of job confirmation workflow. My client portal keeps these contact fields filled in with each customer's next booked job: Next Job Date, Next Job Time, Next Job Type, Next Job Address, Next Job Business. If those fields don't exist, stop and tell me.

- Name: "Job Confirmation – Day Of"
- Trigger: "Custom Date Reminder" (contact triggers), using the field "Next Job Date", firing ON the date (0 days before / 0 days after). If it asks for a time of day, use 7:30 AM (account time zone America/Toronto).
  If there's no "Custom Date Reminder" trigger, stop and tell me which date-based triggers you can see. Don't improvise a different setup.
- Step 1: If/Else. Continue only if "Next Job Time" is not empty. Otherwise end.
- Step 2: Send SMS. From number: [PASTE YOUR A2P NUMBER]. Message:
  Hi {{contact.first_name}}, it's {{contact.next_job_business}}. Confirming your {{contact.next_job_type}} today at {{contact.next_job_time}}. Reply C to confirm, or reply here if anything has changed.
  Insert every merge field with the custom-value picker so the keys are exactly right.
- Workflow settings: Allow re-entry ON (customers can have more than one job).

Leave it as a DRAFT. Show me the trigger settings and the message, and ask me before publishing.
```

Optional add-on (paste after Prompt 3 is done):

```
Clone "Job Confirmation – Day Of" as "Job Reminder – Day Before". Change only: the Custom Date Reminder fires 1 day BEFORE "Next Job Date" at 5:00 PM, and the message:
Hi {{contact.first_name}}, it's {{contact.next_job_business}}. Reminder: we're booked for your {{contact.next_job_type}} tomorrow at {{contact.next_job_time}}. Reply C to confirm, or reply here if you need to change anything.
Leave it as a DRAFT and ask me before publishing.
```

---

## After running them

1. Tell Claude (in the portal session) that Prompt 1 is done, so it can confirm the portal sees the stage and fields.
2. Test on yourself: create a test lead with your own phone in one client pipeline, book it in the portal for
   tomorrow, mark it done the next day, and check both texts arrive from the A2P number.
3. Publish the workflows.

Notes:

- Bookings made before this update don't have their job date on the contact. Opening one and tapping
  *Change time or details* → *Save changes* fills it in.
- People booked with *Book someone who isn't in your leads* have no GHL contact, so they get no texts.
- Replies ("C", questions, reschedules) land in your GHL Conversations inbox for the A2P number.
- The text names the client's business. In the portal, the business name comes from the client's name on
  the Clients page (e.g. rename "A to Z" to "A to Z Electrical" there if you want the full name in texts).
