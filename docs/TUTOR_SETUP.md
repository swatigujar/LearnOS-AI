# AI Tutor

The workspace now calls authenticated `/api/tutor/state` (read-only) and
`/api/tutor/action`. The Next.js `/api/tutor` proxy forwards Firebase ID tokens.
No model request occurs on page load, refresh, topic selection, pause/resume,
or module confirmation. Teaching starts only through an explicit action.

## Configuration

Use the existing backend `GEMINI_API_KEY`, configurable `GEMINI_MODEL`, Firebase
Admin credentials, and `FIREBASE_PROJECT_ID`. The frontend uses its existing
Firebase configuration and optional server-only `BACKEND_API_URL`.
No additional dependency or paid voice service has been added.

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

Gemini produces a validated concept plan and one explanation at a time.
Only explicit understanding confirmations advance the concept position. Every
concept must be taught before it can be confirmed. A topic completes after its
last concept is confirmed; a module completes only after all topics complete
and the learner confirms the module. This is self-reported understanding,
not independently assessed mastery. Later topics remain locked; completed
topics can be revisited or repeated without discarding progress.

Firestore paths:

```text
users/{uid}/courses/{courseId}/tutor/state
users/{uid}/courses/{courseId}/tutorTopics/{topicId}
```

State stores the current topic, paused flag, syllabus version, topic status,
confirmed modules, revision, recent operation IDs, and an in-flight claim.
Each topic document stores its concept position and up to 20 recent messages.
Reply sizes are bounded. These paths do not change the saved syllabus schema.
Transactions protect progress, stale actions and duplicate submissions; Gemini
calls run outside transactions and are never automatically retried.
After a disconnected request, reload state. An abandoned request claim expires
after three minutes; a slow or stale response cannot overwrite a newer claim.

## Voice And Visuals

Voice uses browser SpeechRecognition (where supported) and speechSynthesis.
Speech recognition may send audio to the browser vendor's speech service;
it is not guaranteed offline or available in every browser. HTTPS or localhost
and microphone permission are required. Unsupported browsers retain chat.
Microphone capture puts a transcript in the same input; the learner reviews
it and presses Send. Voice replies use the same persisted tutor messages.
The stop/mute controls interrupt recording or speech. No Gemini Live API,
audio storage, avatar, or paid STT/TTS service is connected.

Validated visual output renders literal code (never executed), tables, ordered
steps, and linear flow diagrams. No HTML rendering, external image generation,
vector database, quizzes, or automatic mastery claims are implemented.

## Manual Verification

1. Sign in and open a course with a saved, ready syllabus.
2. Click Start lesson; check the greeting and first concept.
3. Ask a question or click Explain again; the concept must not advance.
4. Confirm understanding, one concept at a time. Only the final confirmation
   may show the topic checkmark. Confirm the module after all its topics.
5. Pause and refresh; resume and verify the saved topic, messages, and checks.
6. Repeat a previous lesson; saved completions should remain.
7. In a supporting browser, choose Voice, allow the microphone, record a short
   question, stop, review the transcript, and Send. Interrupt spoken output.
8. Test a second signed-in user: the first user's course/progress is inaccessible.

These manual teaching actions incur normal Gemini token charges. Automated
tests use mocked providers and Firestore, not live AI or production writes.
Live Gemini quality, deployed rules, browser microphone permissions, speech
availability, and hosting duration limits still require manual verification.