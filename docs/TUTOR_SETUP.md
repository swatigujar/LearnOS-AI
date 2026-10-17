# AI Tutor

The workspace now calls authenticated `/api/tutor/state` (read-only) and
`/api/tutor/action`. The Next.js `/api/tutor` proxy forwards Firebase ID tokens.
No model request occurs on page load, refresh, topic selection, pause/resume,
or module confirmation. Teaching starts only through an explicit action.

## Configuration

Use the existing backend `GEMINI_API_KEY`, configurable `GEMINI_MODEL`, Firebase
Admin credentials, and `FIREBASE_PROJECT_ID`. Set `FIREBASE_STORAGE_BUCKET` to
the existing Firebase Storage bucket. Handwritten pages use the configurable
`GEMINI_NOTES_IMAGE_MODEL` (defaults to `gemini-3.1-flash-image`) and a 2K
portrait JPEG. Image costs are reserved under the existing monthly AI limit by
`GEMINI_NOTES_IMAGE_COST_USD`. The frontend uses its existing Firebase
configuration and optional server-only `BACKEND_API_URL`.

Gemini Live voice teaching is controlled by `GEMINI_LIVE_ENABLED` and uses the
configurable `GEMINI_LIVE_MODEL` (defaults to `gemini-3.8-live`). The backend
issues an authenticated, single-use, short-lived token for the browser session;
the permanent Gemini API key stays on the backend.
`GEMINI_LIVE_SESSION_COST_RESERVE_USD` reserves an estimated amount against the
existing monthly AI budget for each Live session (default `$2.00`). This is a
budget reservation when the short-lived token is issued; LearnOS does not meter
or settle the browser's later audio usage. Google bills Live usage from audio
and the growing conversation context, so actual charges may differ from the
reservation. Review this reserve when changing models or usage limits.

Daily request and monthly estimated-cost cap enforcement is currently commented
out in `backend/app/services/ai_usage.py` at the owner's request. Usage records,
session reservations, token logging, and duplicate-request protection remain
active, but `AI_DAILY_REQUEST_LIMIT` and `AI_MONTHLY_ESTIMATED_COST_LIMIT_USD`
do not block calls. LearnOS will not stop spending at these configured caps.
Gemini billing and provider quotas still apply. Restoring enforcement requires
uncommenting the cap checks and their configuration validation; no usage records
have been deleted or reset. Output-token limits and manual Retry are unchanged.

Restart the backend after updating it. Deploy the updated Firestore rules to
the existing project only when ready; this implementation does not deploy them
or change cloud settings automatically. Tutor writes use Firebase Admin;
client reads are owner-only and client writes are denied.

## Teaching And Storage

The backend retrieves the authenticated user's ready syllabus and selects its
module/topic in syllabus order. It includes the topic description, course
resources, learner name/profile, goal/level/preferences, and recent saved
conversation in the model prompt. This is direct saved-syllabus retrieval,
not vector search or external-resource retrieval. Resource pages are not fetched.

Chat produces a validated concept plan and teaches one short step at a time.
It asks a check question and waits for a learner response before offering the
confirmation control. Only explicit learner confirmation advances the concept
position. The backend records which concept received a learner response and
rejects confirmation without it, including for older conversations that only
have a taught marker. Repeated Start requests do not generate another reply
while the current concept is waiting for an answer. Asking for another
explanation does not count as answering the question.
The tutor shows the latest exchange by default. Earlier saved explanations
remain available under the collapsed Earlier conversation section; they are
not replayed as a new lesson or deleted.
A topic completes after its last concept is confirmed; a module
completes only after all topics complete and the learner confirms the module.
This remains self-reported understanding, not independently assessed mastery.
Later topics remain locked; completed topics can be revisited or repeated
without discarding progress.

Firestore paths:

```text
users/{uid}/courses/{courseId}/tutor/state
users/{uid}/courses/{courseId}/tutorTopics/{topicId}
users/{uid}/courses/{courseId}/tutorHistory/{operationId}-{role}
users/{uid}/courses/{courseId}/notes/{topicId}-v{syllabusVersion}
```

State stores the current topic, paused flag, syllabus version, topic status,
confirmed modules, revision, recent operation IDs, and an in-flight claim.
Each topic document stores its concept position and up to 20 recent messages;
the `tutorHistory` collection retains chat turns and voice transcripts for the
course. Recent relevant course history and progress are supplied to future
tutor sessions. Reply sizes are bounded. These paths do not change the saved
syllabus schema.
Transactions protect progress, stale actions and duplicate submissions; Gemini
calls run outside transactions and are never automatically retried.
After a disconnected request, reload state. An abandoned request claim expires
after three minutes; a slow or stale response cannot overwrite a newer claim.

When the learner confirms the final taught concept in a topic, the same
transaction that marks the topic complete creates one queued Notes record.
The backend reads that exact course, saved syllabus topic, and tutor lesson,
uses Google Search grounding to verify references, validates structured notes,
then asks the image model to render the handwritten JPEG. The private object is
stored under that user's course and topic path in Cloud Storage; Firestore keeps
its status, validated notes, and source metadata. Notes folders read the
existing saved course list, so a deleted course no longer appears there.
Before a dashboard course with generated notes is deleted, its private note
images and metadata are removed from Storage and Firestore. The deletion stays
retryable if Storage cleanup fails.
Generation failure does not undo tutor progress; the folder shows the status
and supports an authenticated retry. A previously completed topic without a
Notes record can also be generated from its saved lesson.
Each course workspace has a Notes tab as well as the dashboard Notes library.
Queued and generating notes show elapsed seconds; generation timing is saved
so it survives refresh. Completed pages have a Download notes button that saves
the authenticated handwritten JPEG without making the storage object public.

Saved tutor replies retain their original text limits for backward compatibility.
Newly generated replies use shorter limits; older lessons are never truncated
or rejected merely because the new teaching format is more concise.

Deploy the updated Firestore rules so the signed-in owner can read Notes
metadata. The client cannot write note records; image bytes are served through
an authenticated backend route rather than a public bucket URL. The backend's
Firebase Admin identity needs permission to write and read objects in the
configured bucket.

## Voice And Visuals

Voice uses Gemini Live for real-time microphone input, native audio replies,
learner interruptions, and typed questions within the same session. The browser
connects directly to Gemini with a one-use token issued after Firebase
authentication; audio is not stored by LearnOS.
Token provisioning uses the REST `bidiGenerateContentSetup` field to lock the
model and teaching configuration, rather than the SDK-only
`liveConnectConstraints` field. The live teaching instructions require waiting
for a learner response and explicit permission, never treating silence as consent.
Live startup loads saved chat and voice messages using the validated conversation
model, including when a learner switches from an existing chat lesson to voice.
Input and output text transcripts are saved alongside course tutor history and are used as relevant
learning context later. HTTPS or localhost, microphone permission, and browser
AudioWorklet support are required; chat remains available if live voice cannot
connect. A Live session is limited by Gemini's session lifetime and can be
restarted with its saved course history.

The tutor uses the saved syllabus and any validated course notes available for
the selected topic. Listed resource URLs remain references; tutor sessions do
not fetch their pages. If the saved material does not answer a question, the
tutor is instructed to say so and point to a listed official resource rather
than fill the gap from outside knowledge.

Validated visual output renders literal code (never executed), tables, ordered
steps, and linear flow diagrams. No HTML rendering, external image generation,
vector database, quizzes, or automatic mastery claims are implemented.

## Manual Verification

1. Sign in and open a course with a saved, ready syllabus.
2. Click Start lesson; check the friendly greeting and first short teaching step.
3. Check that the tutor asks one question, waits for a learner response, and
   keeps the next concept locked until the learner confirms.
4. Switch to Live voice, start a session, speak a doubt, interrupt a reply, and
   check that both sides of the transcript appear in the saved conversation.
5. Confirm understanding one concept at a time. Only the final confirmation
   may show the topic checkmark. Confirm the module after all its topics.
6. Pause and refresh; resume and verify the saved topic, messages, and checks.
7. Repeat a previous lesson; saved completions should remain.
8. Open Notes and confirm the matching course folder shows a queued note and
   then a JPEG for the completed topic. Confirm a second user cannot load it.
9. Test a second signed-in user: the first user's course/progress is inaccessible.

These manual teaching actions and note generation incur Gemini charges,
including Live audio, grounded search, and one image-generation request per
topic. Automated tests use mocked providers and Firestore, not live AI or
production writes. Live Gemini quality, deployed rules, browser microphone
permissions, audio streaming support, and hosting duration limits still require
manual verification.
