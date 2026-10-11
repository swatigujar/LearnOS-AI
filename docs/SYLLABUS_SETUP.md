# Syllabus Generation (Gemini)

## Configuration

Keep these values in `backend/.env` only:

```dotenv
GEMINI_API_KEY=<your Gemini key>
GEMINI_MODEL=gemini-3.8-flash
FIREBASE_PROJECT_ID=<existing Firebase project ID>
GOOGLE_APPLICATION_CREDENTIALS=<absolute path to Firebase Admin credentials JSON>
```

For local development, either provide the service-account file above or sign in
with Google Application Default Credentials using `gcloud auth application-default login`.
Firebase Admin token verification needs credentials for the configured project.

Do not commit credentials or put Gemini credentials in the frontend environment.
Firebase Admin also supports existing Application Default Credentials or an
attached service account when deployed. Syllabus generation has a 120-second
Gemini budget, a 150-second proxy deadline, and a 155-second new-goal request
deadline. Each generation makes one Gemini attempt with no automatic retries,
including HTTP 503/504 failures, to avoid repeat-call costs. Research keeps its 50-second
timeout. Deployment platform or gateway limits may still be lower.
It uses `models.generate_content` with plain JSON requested in the prompt and
no structured-output configuration. Pydantic still validates the complete response,
IDs, hour totals, timeline, and study budget before anything is saved.

Deploy the checked-in Firestore rules to your existing project before using
the dashboard's syllabus reader:

```powershell
firebase deploy --only firestore:rules --project <existing-project-id>
```

This deploys rules, not collections, and does not enable billing. The new rules
allow only the owner to read course/syllabus documents; client writes are denied.
The existing authentication and learning-goal rules are unchanged.

## Run Locally

From `backend`:

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

From `frontend`:

```powershell
npm run dev -- --port 3000
```

Saving a learning goal immediately requests its syllabus. The same-origin
`/api/syllabus/generate` endpoint bypasses research and research summarization.
Next.js endpoint forwards the existing Firebase ID token to FastAPI. Set
server-only `BACKEND_API_URL` in the frontend environment if the backend runs
somewhere other than `http://127.0.0.1:8000`.

## API And Storage

```http
POST /api/syllabus/generate
Authorization: Bearer <Firebase ID token>
Content-Type: application/json

{"courseId":"<existing-course-id>"}
```

The backend reads the saved course details from Firestore, including the goal,
skill level, timeline, daily study time, learning preferences, and additional
requirements. Existing UI goals are created under `learningGoals`; the backend
copies the authenticated user's goal into `courses` on first generation. The
legacy document is not changed. Invalid output is never persisted.

Writes automatically create:

```text
users/{authenticatedUid}/courses/{courseId}
  syllabusStatus: generating | ready | failed
  syllabusVersion: 0 before success, 1 after first success
  createdAt, updatedAt
  course_name, learning_goal, skill_level, timeline_days, study_hours_per_day
  learning_style, additional_requirements
  syllabus/v1
    overview, objective, duration_days, total_study_hours, prerequisites
    modules, resources, generatedAt, provider, model
```

The successful response includes `courseId`, `syllabusId`, `status`,
`syllabusVersion`, and `syllabus`. Repeated requests return the existing valid
version without generating or overwriting it. Transactions prevent concurrent
generation and save the syllabus and ready status atomically. Failed attempts
can be retried; abandoned generating attempts can be reclaimed after 10 minutes.

After saving, the learner is taken to the course workspace. It reads status and
syllabus from Firestore, including updates from requests made elsewhere. A
failed attempt displays the error and can be retried without creating a
duplicate learning goal. Opening the dashboard does not regenerate a syllabus.

## Verification

From `backend`:

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

Endpoint tests exercise Gemini dispatch, persistence, and failure states using
mocks and a transactional Firestore test double. A live Gemini test requires a
valid backend key; a live Firestore/dashboard test additionally requires
configured Admin credentials, deployed rules, and a signed-in browser.
Unit tests do not call live AI services. For a manual check, restart the backend,
save a learning goal, open its course workspace, and refresh. Confirm that
`syllabusStatus` is `ready`, `syllabusVersion` is `1`, and `syllabus/v1` exists.
Reopening the course must display the saved version without another AI call.
Resources are requested as known canonical URLs, not live-researched references;
URL syntax is validated, but resource existence still needs manual verification.

No AI tutor, diagnostic, practice, progress, or learning-session features are included.